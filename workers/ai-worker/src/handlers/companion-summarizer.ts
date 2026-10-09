/**
 * 会话摘要器（22-real-desktop-pet-memory-context-prd-tdd.md §2.5/§9.5）。
 *
 * 异步处理长对话摘要：
 * - 读取会话最近消息；
 * - LLM 生成结构化摘要 JSON；
 * - 写入 conversation_summaries（唯一约束幂等）；
 * - 生成 episodic 候选记忆（不自动确认）。
 */

import { z } from "zod";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { stableStringify, sha256Utf8V1 } from "@astella/shared/content-hash";
import { logger } from "../lib/logger.ts";
import { readJobPayloadString } from "@astella/shared";
import { createProvider } from "../lib/ai-provider.ts";
import {
  AIConsentRequiredError,
  createGovernedProvider,
  resolveAIGovernanceContext,
  resolveProviderForTask,
} from "../lib/governance.ts";
import { assertJobLease, lockJobLease, withJobTransaction } from "../lib/job-lease.ts";
import { resolveProviderCallTimeout } from "../lib/handler-timeout-config.ts";
import { companionSummaryTotal } from "../lib/metrics.ts";
import { parseMemoryExtractJson } from "./companion-memory-extractor.ts";
import { resolveContextBudget } from "@astella/agent-core";
import {
  contextCoverageManifestV1Schema,
  type ContextCoverageManifestV1,
  type ContextCoverageSpanV1,
} from "@astella/shared/context-budget-contracts";
import {
  boundCompanionRecentHistory,
  REPLAY_WINDOW_MESSAGES,
} from "./companion-dialogue-content.ts";
import type { JobPayload } from "./index.ts";
import { runWorkerAiTask } from "./worker-ai-task.ts";
import {
  companionHistoryText, readCompanionHistoryRows, readParentSummary, upsertCommittedSummary,
  type CompanionHistoryRow,
} from "./companion-dialogue-store.ts";

class SummarizerOutputError extends Error {
  constructor() {
    super("summarizer output did not match its structured contract");
    this.name = "SummarizerOutputError";
  }
}

export const conversationSummaryOutputSchema = z.object({
  title: z.string().min(1).max(200),
  topics: z.array(z.string().min(1).max(200)).max(20).default([]),
  userGoals: z.array(z.string().min(1).max(500)).max(20).default([]),
  keyEvents: z.array(z.string().min(1).max(500)).max(20).default([]),
  userPreferences: z.array(z.string().min(1).max(500)).max(20).default([]),
  followUps: z.array(z.string().min(1).max(500)).max(20).default([]),
  emotionalState: z.string().min(1).max(40).default("neutral"),
});

const SUMMARIZER_PROMPT = [
  "你是桌宠的会话摘要器。把以下对话压缩成结构化摘要。",
  // 2026-09-22：这里原来是一行一条**中文**字段名（"主题 / 用户目标 / …"），而 schema
  // 要的是英文键——模型照着清单回中文键，`schema.parse` 每次都抛，摘要自 0170 建表
  // 以来落库 0 行（同期审计日志里成功调用 283 次）。字段名必须逐字给出来，
  // 而"中文标签 + 英文键"两份清单只会让她照错的那份写。
  "只输出一个 JSON 对象，键名必须逐字用下面这些英文（值用中文）：",
  '{"title": "一句话主题", "topics": ["主题"], "userGoals": ["用户目标"],',
  ' "keyEvents": ["关键事件"], "userPreferences": ["用户偏好"],',
  ' "followUps": ["待跟进事项"], "emotionalState": "neutral"}',
  "title 不能为空；四个列表没有内容就给空数组；emotionalState 只填一个英文词" +
    "（neutral / positive / frustrated / tired 里选）。",
  "只输出 JSON。",
  "按消息发送时间区分早先与较新的话题；时间指交流时间，不证明描述的事件已发生。用户连续补充同一话题时合并理解；回复失败、取消或被后续消息接替不代表用户意图已执行，不把旧请求改写成已完成的事或今天的新活动。",
].join("\n");

export const SUMMARIZER_INPUT_CHARS = 12_000;

/**
 * 压缩策略版本。
 *
 * 摘要的幂等键绑定它（44 §5.3）：策略变了以后，同一个来源区间用旧策略跑出的结论
 * 不能被当成「同一次提交」复用，否则一次「提高保真度」的策略调整会被旧缓存吞掉。
 */
export const COMPACTION_POLICY_VERSION = "companion-summary-v3";

/** 单次压缩计划最多读多少个分段（44 §5.4：分块计划也有总调用上限）。 */
export const MAX_SUMMARIZER_CHUNKS = 4;

/**
 * 本次摘要请求声明的输出上限（44 §4.1 的 O）。
 *
 * 2026-10-06 起含思考预留：思考 token 计入 maxTokens，1000 会在思考上被吃满
 * （实测 completion=998 时 JSON 从句子中间被切断）；关着思考时同一份输入约 375。
 */
export const SUMMARIZER_OUTPUT_TOKENS = 3_000;

export interface SummarizerSnapshotMessage {
  id: string;
  seq: string | number;
  role: string;
  contentSha256: string;
  blocks: unknown;
  pageContext?: unknown;
  createdAt?: string | null;
  replyStatus?: string | null;
}
function transcriptLine(row: Pick<SummarizerSnapshotMessage, "role" | "blocks" | "pageContext" | "createdAt" | "replyStatus">): string {
  const text = Array.isArray(row.blocks)
    ? (row.blocks as Array<{ type?: string; text?: unknown }>)
        .filter((block) => block.type === "text")
        .map((block) => String(block.text ?? ""))
        .join("")
    : "";
  const contextualText = row.role === "user"
    ? companionHistoryText({ role: "user", blocks: row.blocks, page_context: row.pageContext })
    : text;
  const metadata = [row.createdAt ? `发送时间 ${row.createdAt}` : null,
    row.role === "user" && row.replyStatus ? `回复状态 ${row.replyStatus}` : null].filter(Boolean).join("；");
  return `${row.role === "assistant" ? "桌宠" : "用户"}${metadata ? `（${metadata}）` : ""}：${contextualText}`;
}

export interface SummarizerSnapshot {
  transcript: string;
  coverageFromSeq: string | null;
  coverageThroughSeq: string | null;
  sourceHash: string;
  /**
   * 这次**没有**被读进去的区间（44 §5.1）。
   *
   * 单条消息比整个预算还长时，旧实现把它砍掉尾部再宣称覆盖了整条 seq——那正是
   * 44 §5.2 禁止的「静默切片后仍标记整段已覆盖」。现在如实记成未覆盖，读取端
   * 因此知道自己有盲区，而不是把一段没读过的历史当成读过。
   */
  uncovered: ContextCoverageSpanV1[];
}

/** 覆盖清单里的来源键：会话 + 消息。两个会话的同号 seq 不会撞（44 §3.3）。 */
function conversationSourceId(conversationId: string, messageId: string): string {
  return conversationId ? `${conversationId}:${messageId}` : messageId;
}

/**
 * Freeze the exact authored-message range that fits the summarizer budget.
 * Newer rows win; the source hash makes late edits/deletes reject the result.
 *
 * 完整记录优先于凑数：装不下的整条消息进 `uncovered`，而不是被切半后仍算已覆盖。
 */
export function buildSummarizerSnapshot(
  rows: SummarizerSnapshotMessage[],
  maxChars = SUMMARIZER_INPUT_CHARS,
  conversationId = "",
): SummarizerSnapshot {
  const ordered = rows
    .filter((row) => row.role === "user" || row.role === "assistant")
    .slice()
    .sort((a, b) => {
      const left = BigInt(a.seq);
      const right = BigInt(b.seq);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  const selected: Array<{ row: SummarizerSnapshotMessage; line: string }> = [];
  const skipped: SummarizerSnapshotMessage[] = [];
  let used = 0;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const row = ordered[index];
    const line = transcriptLine(row);
    const additional = line.length + (selected.length > 0 ? 1 : 0);
    if (used + additional > maxChars) {
      skipped.push(row);
      continue;
    }
    selected.unshift({ row, line });
    used += additional;
  }
  const transcript = selected.map((item) => item.line).join("\n");
  const first = selected[0]?.row;
  const last = selected.at(-1)?.row;
  const sourceHash = createHash("sha256")
    .update(JSON.stringify(selected.map(({ row, line }) => [
      String(row.seq), row.id, row.role, row.contentSha256, line,
    ])))
    .digest("hex");
  return {
    transcript,
    coverageFromSeq: first ? String(first.seq) : null,
    coverageThroughSeq: last ? String(last.seq) : null,
    sourceHash,
    uncovered: skipped.map((row) => ({
      sourceKind: "companion_message",
      sourceId: conversationSourceId(conversationId, row.id),
      revision: 0,
      fromSeq: Number(row.seq),
      throughSeq: Number(row.seq),
      hash: row.contentSha256,
    })),
  };
}

/**
 * 把这段 transcript 读成一份覆盖清单（44 §3.3／§5.1）。
 *
 * 结构化覆盖只证明**源区间关系**，不证明语义完整——所以 `uncovered` 与取回入口
 * 必须同时在场，否则「摘要短了」和「关键约束还在」会被当成同一件事。
 */
export function buildSummaryCoverageManifest(input: {
  conversationId: string;
  snapshot: SummarizerSnapshot;
  parentCoverageFromSeq: string | null;
}): ContextCoverageManifestV1 {
  const { snapshot } = input;
  const fromSeq = input.parentCoverageFromSeq ?? snapshot.coverageFromSeq;
  return contextCoverageManifestV1Schema.parse({
    version: 1,
    spans: fromSeq && snapshot.coverageThroughSeq
      ? [{
        sourceKind: "companion_conversation",
        sourceId: input.conversationId,
        revision: 0,
        fromSeq: Number(fromSeq),
        throughSeq: Number(snapshot.coverageThroughSeq),
        hash: snapshot.sourceHash,
      }]
      : [],
    uncovered: snapshot.uncovered,
    retrieval: input.conversationId && snapshot.coverageFromSeq
      ? [{ sourceKind: "companion_conversation", sourceId: input.conversationId, locator: `messages:${snapshot.coverageFromSeq}..${snapshot.coverageThroughSeq}` }]
      : [],
  });
}

/** 上一份摘要的形状（读取端只需要它能被重新渲染，不依赖完整字段）。 */
export interface ParentSummaryView {
  id: string;
  revision: number;
  summary: unknown;
  coverageFromSeq: string | null;
  coverageThroughSeq: string | null;
}

/**
 * 摘要请求：本次读到的 transcript + 上一份摘要（可选）。
 *
 * **上一份摘要是递增输入，不是可选装饰**（44 §5.1）。此前摘要器每次只读一段历史，
 * 于是新摘要默认代表「全部更早历史」，而它其实只代表自己读过的那一段——更早的
 * 约束、纠正与材料版本会在下一轮被静默丢掉。把父摘要一并给出，新结论才是真的
 * 接在旧结论上，而不是重新开始。
 */
export function buildSummarizerMessages(input: {
  conversationText: string;
  parent?: ParentSummaryView | null;
  inputTokenBudget?: number;
}): Array<{ role: "system" | "user"; content: string }> {
  const parentText = input.parent ? renderConversationSummary(input.parent.summary) : null;
  // 分块后不再按固定字符静默砍尾：调用方按摘要模型的**真实** token 预算分块，
  // 这里的字符上限只是最后一道地板，不承担「假装覆盖了没读的部分」的角色。
  const maxChars = input.inputTokenBudget
    ? Math.max(2_000, input.inputTokenBudget)
    : SUMMARIZER_INPUT_CHARS;
  const system = [
    SUMMARIZER_PROMPT,
    ...(parentText
      ? [
        "",
        "下面 <previous_summary> 是**上一份摘要**，它已经覆盖了比这段 transcript 更早的对话。",
        "你这次的新摘要要**接在它上面**：保留仍然有效的约束、纠正、材料版本与未决事项；",
        "被这段 transcript 推翻的内容要标成已改，不要原样继承。",
        "只覆盖这段 transcript 会把更早的事实丢掉。",
        "<previous_summary>",
        parentText,
        "</previous_summary>",
      ]
      : []),
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: input.conversationText.slice(-maxChars) },
  ];
}

/**
 * 摘要模型自己的输入预算（44 §5.2）。
 *
 * 主模型能装 100 万 token 不代表摘要模型也能一次读完。预算按摘要模型的**实际**
 * 能力解析，并停在压缩触发线之前，使摘要输入本身不必触发下一轮压缩。
 * 固定字符上限只作为极小窗口模型的地板。
 */
export function resolveSummarizerInputTokens(
  capability: { contextWindowTokens: number; maxOutputTokens: number; reservedOutputTokens?: number } | null | undefined,
): number {
  const fallback = Math.floor(SUMMARIZER_INPUT_CHARS / 2);
  if (!capability || !(capability.contextWindowTokens > 0)) return fallback;
  const budget = resolveContextBudget({
    registeredCapability: {
      contextWindowTokens: capability.contextWindowTokens,
      reservedOutputTokens: capability.reservedOutputTokens ?? capability.maxOutputTokens,
      maxOutputTokens: capability.maxOutputTokens,
    },
    // 摘要输出的上限就是本次请求声明的值。
    requestedOutputTokens: SUMMARIZER_OUTPUT_TOKENS,
    outputLimitEnforced: true,
  });
  return Math.min(SUMMARIZER_INPUT_CHARS, budget.triggerTokens);
}

/**
 * 摘要 → 注入对话上下文的 `<conversation_summary>` 数据块（方案 29 §11 C1）。
 *
 * 为什么要有这一块：历史回放只带实际预算后可见的尾部，
 * 更早的那一段对她本来是完全不可见的——
 * 摘要修好了却没人读，等于没修。
 *
 * 两条约束（都在测试里钉住）：
 * - **数字不作数**：这块不进 `keepRecomputedBlocks` 的白名单。摘要里的数字是
 *   "写它那一刻"的值，让它当出处等于把她几周前说过的统计复活成事实（§9.35）。
 * - 摘要正文是模型生成的，与用户自填字段同级处理：先剥掉能提前闭合边界的标记。
 */
/**
 * 摘要注入块的硬上限（44 §4.4）。
 *
 * 原来固定 600 字符，而且是用 `slice` 把**整块**砍到 600 再补一个省略号——于是
 * 「这段不是这一轮新查的，里面的数字可能已经变了」这条安全声明、甚至是收尾标签，
 * 都可能被砍掉。丢掉那句之后，几周前说过的一个数字会被当成当前事实读回去，
 * 正是 §9.35 要挡的那件事。
 *
 * 现在按**用途**取值：摘要的职责是话题接续（标题 + 几件办过的事 + 未决 + 偏好），
 * 装配槽位本身给到 16,000 字符（composeAgentContext 的 summary 源）。1,600 仍是
 * 硬上限，只是从「一个截断点」变成「一个装配容量」——并且超限时丢的是**可选项**，
 * 安全声明与边界永远保留。
 */
export const CONVERSATION_SUMMARY_MAX_CHARS = 1_600;

const SUMMARY_BOUNDARY_TAGS = /<\/?conversation_summary>/gi;

export interface RenderConversationSummaryOptions {
  /** 覆盖区间是否经过内容校验。 */
  coverageVerified?: boolean;
  /** 本次注入的容量上限；默认 CONVERSATION_SUMMARY_MAX_CHARS。 */
  maxChars?: number;
  /**
   * 接续链上没盖住的区间（44 §5.2／§5.5）。
   *
   * 非空时必须让模型知道**更早的那段它没读到**，否则它会把「有摘要」当成
   * 「这段我全读过」，据此回答关于更早内容的问题。
   */
  coverageGaps?: readonly { fromSeq: string; throughSeq: string }[];
}

export function renderConversationSummary(
  summary: unknown,
  options: RenderConversationSummaryOptions = {},
): string | null {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return null;
  const row = summary as Record<string, unknown>;
  const text = (value: unknown): string =>
    typeof value === "string" ? value.replace(SUMMARY_BOUNDARY_TAGS, "").trim() : "";
  const list = (value: unknown, max: number): string[] =>
    Array.isArray(value)
      ? value.map(text).filter((item) => item.length > 0).slice(0, max)
      : [];

  const title = text(row.title);
  if (title.length === 0) return null;
  const limit = Math.max(200, options.maxChars ?? CONVERSATION_SUMMARY_MAX_CHARS);
  const coverageGaps = options.coverageGaps;

  // 必留行：边界、来源身份、边界可信度、收尾。超预算时丢的是可选项，不是这些。
  const required = [
    "<conversation_summary>",
    `更早那段对话：${title}`,
    options.coverageVerified
      ? "这段摘要有消息边界校验，只用于接续话题；操作是否完成以对应工具回执为准。"
      : "这段摘要的消息边界无法核实，可能与近期对话重叠；只作话题线索，操作是否完成以对应工具回执为准。",
    // 闭合回路（44 §5.5）：只说「有洞」而不给入口，等于把认知边界推给日志。
    // 这里把**怎么取回**一并写出来——模型必须知道它有一条真实可走的路，
    // 否则它要么假装读过，要么干脆不提，而这两样都是用户看不见的损失。
    ...(coverageGaps && coverageGaps.length > 0
      ? [
        `更早还有 ${coverageGaps.length} 段没有任何摘要覆盖（消息 ${coverageGaps[0]!.fromSeq}–${coverageGaps[0]!.throughSeq} 等）：`
        + "要谈那部分就用 companion_read_history 带上对应 fromSeq 取回原文，别把摘要当成读过；"
        + "取不到就照实说没有记录。",
      ]
      : []),
    "（这段不是这一轮新查的；里面的数字可能已经变了，要报数字得重新查。）",
    "</conversation_summary>",
  ];
  // 可选项按重要性排列，逐条放入直到装不下——不再截断整块。
  const sections = [
    { label: "办过的事", items: list(row.keyEvents, 3), counts: [3, 2, 1] },
    { label: "还没了结", items: list(row.followUps, 3), counts: [3, 2, 1] },
    { label: "他偏好的", items: list(row.userPreferences, 2), counts: [2, 1] },
  ];

  const block = (extra: string[]): string =>
    [...required.slice(0, required.length - 2), ...extra, ...required.slice(-2)].join("\n");

  const chosen: string[] = [];
  for (const section of sections) {
    if (section.items.length === 0) continue;
    // 取当前仍装得下的最详细档；一档都放不下就整段略过，而不是砍成半句。
    const fit = section.counts.find((count) =>
      count > 0 && count <= section.items.length
      && block([...chosen, `${section.label}：${section.items.slice(0, count).join("；")}`]).length <= limit);
    if (fit !== undefined) chosen.push(`${section.label}：${section.items.slice(0, fit).join("；")}`);
  }
  const rendered = block(chosen);
  // 连必留行都装不下（上限被调到异常小）：返回 null 而不是产出半截块。
  return rendered.length > limit ? null : rendered;
}

export async function runCompanionSummarizer(job: JobPayload): Promise<void> {
  // 设计 P1-8（2026-09-15 审计）：字段名走共享契约（@astella/shared 的
  // companion-memory-job-payload），改名由编译器兜住。
  const conversationId = readJobPayloadString(job.payload, "conversationId");
  const userId = readJobPayloadString(job.payload, "userId");
  if (!conversationId || !userId) throw new Error("companion_summarizer payload 缺 conversationId/userId");
  await assertJobLease(job);

  const govCtx = await resolveAIGovernanceContext(job.workspaceId, userId);
  if (!govCtx.consentOk) throw new AIConsentRequiredError();
  const textRes = resolveProviderForTask(govCtx, "companion_agent");
  // 2026-10-06 起跟随平台配置开思考（用户决定：质量优先）。思考 token 也计入
  // maxTokens——2026-09-22 实测开着思考时这一步 completion=998 token（= maxTokens 1000），
  // JSON 从句子中间被切断，`parseMemoryExtractJson` 三层兜底全都解不出（那 37 条
  // "invalid output" 的 SyntaxError 就是这个，而不是模型不听话）；关掉思考之后同一份
  // 输入 completion=375、7.6 秒返回（开着是 36 秒）。因此输出预算已提
  // 到 SUMMARIZER_OUTPUT_TOKENS=3000 给思考留出空间，而不是靠关思考绕开。
  const provider = createGovernedProvider(
    createProvider(textRes.providerName, textRes.providerConfig),
    govCtx,
    job.workspaceId,
    // AI P0-8（2026-09-15 审计）：接上 ai_audit_log 的唯一写入口（此前零调用）。
    // ai_audit_log.user_id 是 NOT NULL，故 payload 未带可信 actor 时不写审计行。
    userId
      ? { userId, operation: "companion_summarizer", jobId: job.id }
      : undefined,
  );

  // 摘要模型自己的输入预算（44 §5.2）。主模型能读 100 万 token 不代表摘要模型也行。
  const summarizerCapability = provider.getCapabilities?.() ?? null;
  const summarizerInputTokens = resolveSummarizerInputTokens(summarizerCapability);
  // 分块边界（44 §5.2／§5.4）：按摘要模型的真实预算分块，分块数本身也有上限。
  const chunkChars = Math.max(2_000, Math.min(SUMMARIZER_INPUT_CHARS, summarizerInputTokens));

  const { snapshot, parent, contextRevision } = await withJobTransaction(job, async (tx) => {
    // 先用和对话 prompt 相同的 20 条 + 字符预算规则找到真实裁剪点。
    // 这样，被 24k 字符预算挤出 prompt、但仍在最近 20 条里的旧消息也能进入摘要，
    // 而不是留下“摘要没覆盖、原文也没回放”的空档。
    const tailRows = await readCompanionHistoryRows(tx, conversationId, { limit: REPLAY_WINDOW_MESSAGES });
    const visibleTail = boundCompanionRecentHistory(tailRows.slice().reverse().map((row) => ({
      seq: row.seq,
      role: row.role as "user" | "assistant",
      text: companionHistoryText(row),
    })));
    const tailStartSeq = visibleTail[0]?.seq;

    // 上一份摘要：本次结论要接在它上面，而不是假装从头覆盖（44 §5.1）。
    // 会话内容修订号：这份摘要的覆盖是否仍然有效，判定与提交都在同一事务里做
    // （44 §3.3「读取与提交均检查当前有效性」）。
    const revisionRows = await tx.execute<{ context_revision: string }>(sql`
      SELECT context_revision::text AS context_revision
      FROM companion_conversations
      WHERE id = ${conversationId}
        AND workspace_id = ${job.workspaceId} AND user_id = ${userId}
      FOR SHARE
    `);
    const contextRevision = revisionRows[0]?.context_revision ?? null;

    const head = await readParentSummary(tx, conversationId);
    const parent = head ? {
      id: head.id,
      revision: head.revision,
      summary: head.summary,
      coverageFromSeq: head.coverage_from_seq,
      coverageThroughSeq: head.coverage_through_seq,
    } : null;

    // 100 行只是数据库分页大小，不是会话摘要边界。真实边界由上面的回放选择器确定，
    // 实际输入按摘要模型的 token 预算限定；长会话不再被固定 200 行截断。
    const sourceRows: CompanionHistoryRow[] = [];
    // 用户主动“整理近期对话”也应覆盖仍在回放窗口里的短对话；后台压缩才只取裁剪点之前。
    let beforeSeq = job.payload.includeRecent === true ? undefined : tailStartSeq;
    let chunks = 0;
    while (chunks < MAX_SUMMARIZER_CHUNKS) {
      const rows = await readCompanionHistoryRows(tx, conversationId, { beforeSeq, limit: 100 });
      if (rows.length === 0) break;
      sourceRows.push(...rows);
      chunks += 1;
      const candidate = buildSummarizerSnapshot(sourceRows.map((row) => ({
        id: row.id,
        seq: row.seq,
        role: row.role,
        contentSha256: row.content_sha256,
        blocks: row.blocks,
        pageContext: row.page_context,
        createdAt: row.created_at,
        replyStatus: row.run_status,
      })), chunkChars, conversationId);
      if (candidate.coverageFromSeq) break;
      beforeSeq = rows.at(-1)!.seq;
    }

    return {
      contextRevision,
      snapshot: buildSummarizerSnapshot(sourceRows.map((row) => ({
        id: row.id,
        seq: row.seq,
        role: row.role,
        contentSha256: row.content_sha256,
        blocks: row.blocks,
        pageContext: row.page_context,
        createdAt: row.created_at,
        replyStatus: row.run_status,
      })), chunkChars, conversationId),
      parent,
    };
  });

  if (!snapshot.transcript.trim() || !snapshot.coverageFromSeq || !snapshot.coverageThroughSeq) {
    logger.info({ jobId: job.id, conversationId }, "summarizer skipped: empty conversation");
    return;
  }
  // 边界在这里定下来：下面的提交事务在回调里跑，TS 不会把属性收窄带进去。
  const coverageFromSeq = snapshot.coverageFromSeq;
  const coverageThroughSeq = snapshot.coverageThroughSeq;

  const messages = buildSummarizerMessages({
    conversationText: snapshot.transcript,
    parent,
    inputTokenBudget: summarizerInputTokens,
  });
  const generationParameters = { temperature: 0.2, maxTokens: SUMMARIZER_OUTPUT_TOKENS, responseFormat: "json_object" as const };
  const inputSnapshotHash = sha256Utf8V1(stableStringify({
    taskVersion: 1,
    conversationId,
    sourceHash: snapshot.sourceHash,
    coverageFromSeq: snapshot.coverageFromSeq,
    coverageThroughSeq: snapshot.coverageThroughSeq,
    modelId: provider.modelId,
    promptVersion: provider.promptVersion,
    generationParameters,
    messages,
    parentSummaryId: parent?.id ?? null,
    parentRevision: parent?.revision ?? null,
    compactionPolicyVersion: COMPACTION_POLICY_VERSION,
  }));
  let summary: z.infer<typeof conversationSummaryOutputSchema>;
  try {
    summary = await runWorkerAiTask({
      job,
      userId,
      taskId: "companion_summarizer",
      taskVersion: 1,
      // 幂等键绑定来源哈希**与**压缩策略版本（44 §5.3）：策略改了以后，同一个区间
      // 不能再复用旧策略跑出的结论。
      idempotencyKey: `summary:${COMPACTION_POLICY_VERSION}:${conversationId}:${snapshot.sourceHash}:${parent?.revision ?? 0}`,
      inputSnapshotRef: { kind: "task", id: `${conversationId}:${snapshot.coverageThroughSeq}`, hash: inputSnapshotHash },
      input: messages,
      modelId: provider.modelId,
      promptVersion: `${provider.promptVersion}:companion-summarizer-v1`,
      resourceClass: "maintenance",
      timeoutMs: resolveProviderCallTimeout("companion_summarizer"),
      isOutputShapeError: (error) => error instanceof SummarizerOutputError,
      execute: async (request, signal) => {
        // 2026-08-24（AI 设计审查 §4.2）：responseFormat "text" → "json_object"，
        // 输出本就是结构化 JSON，让 provider 层开启 json 模式降低格式走样率。
        const result = await provider.chatCompletion(request, generationParameters, signal);
        let output: z.infer<typeof conversationSummaryOutputSchema>;
        try {
          output = conversationSummaryOutputSchema.parse(parseMemoryExtractJson(result.content));
        } catch {
          throw new SummarizerOutputError();
        }
        return {
          ok: true,
          output,
          promptTokens: result.usage?.promptTokens ?? undefined,
          completionTokens: result.usage?.completionTokens ?? undefined,
        };
      },
    });
  } catch (err) {
    const invalidOutput = err instanceof SummarizerOutputError;
    logger.warn({ jobId: job.id, conversationId, err }, invalidOutput ? "summarizer invalid output; skipping" : "summarizer provider failed");
    try {
      companionSummaryTotal.labels("failed").inc();
    } catch {
      // metrics 记录失败不阻断错误传播
    }
    if (invalidOutput) return;
    throw err;
  }

  const sourceRunId = job.payload.sourceRunId as string | null ?? null;
  const idempotencyKey = `summary:${conversationId}:${sourceRunId ?? "conversation"}`;

  const committed = await withJobTransaction(job, async (tx) => {
    // 稳定 P1-1（2026-09-15 审计）：提交前重新校验并续租租约（TOCTOU 围栏）。
    // 入口的 assertJobLease 只挡"开始时已失效"，挡不住"LLM 调用期间被 reap"——
    // 过期后另一个 worker 会重领同一 job 并重复写入/重复计费。与 parse-source
    // 的每次提交前 lockJobLease 对齐。
    await lockJobLease(tx, job);
    // 清理连续历史时会先锁 conversation 行，再删除摘要与消息。提交也先锁同一行，
    // 这样并发清理要么先完成、令下面的核对失败，要么等摘要提交后连摘要一起删除。
    //
    // 锁用 FOR UPDATE 而不是 FOR SHARE（44 §5.3）：FOR SHARE 之间**不冲突**，
    // 两个并发提交能同时拿到它、同时读到同一个链头、同时通过下面的父围栏，
    // 于是同一段历史会提交出两份互为兄弟的摘要。父围栏要真的没有竞态，
    // 就必须让「读链头 → 插入」这一段串行化。
    const conversation = await tx.execute<{ id: string }>(sql`
      SELECT id FROM companion_conversations
      WHERE id = ${conversationId} AND workspace_id = ${job.workspaceId} AND user_id = ${userId}
      FOR UPDATE
    `);
    if (!conversation[0]) return false;

    const currentSourceRows = await readCompanionHistoryRows(tx, conversationId, {
      fromSeq: coverageFromSeq,
      beforeSeq: (BigInt(coverageThroughSeq) + 1n).toString(),
      limit: chunkChars,
    });
    const currentSnapshot = buildSummarizerSnapshot(currentSourceRows.map((row) => ({
      id: row.id,
      seq: row.seq,
      role: row.role,
      contentSha256: row.content_sha256,
      blocks: row.blocks,
      pageContext: row.page_context,
      createdAt: row.created_at,
      replyStatus: row.run_status,
    })), chunkChars, conversationId);
    if (
      currentSnapshot.coverageFromSeq !== coverageFromSeq
      || currentSnapshot.coverageThroughSeq !== coverageThroughSeq
      || currentSnapshot.sourceHash !== snapshot.sourceHash
    ) {
      logger.info({ jobId: job.id, conversationId }, "summarizer skipped: source range changed before commit");
      return false;
    }

    // 父摘要围栏（44 §5.3）：摘要模型在事务外跑完，这段时间里可能已经有**更新的**
    // 摘要接上去了。拿当前头节点与我们预期的父版本比较，不一致就整份作废——
    // 迟到的旧结果不许覆盖新指针，也不许抢回当前回复。
    const currentHead = await readParentSummary(tx, conversationId);
    const expectedParentId = parent?.id ?? null;
    const expectedParentRevision = parent?.revision ?? null;
    const headId = currentHead?.id ?? null;
    const headRevision: number | null = currentHead?.revision ?? null;
    if (headId !== expectedParentId || headRevision !== expectedParentRevision) {
      logger.info(
        { jobId: job.id, conversationId, expectedParentId, headId, expectedParentRevision, headRevision },
        "summarizer skipped: parent summary moved while the model call was in flight",
      );
      return false;
    }

    // 提交前重查修订号：读来源到提交之间如果有人改写或删除了消息，这份覆盖已经不成立
    // （44 §3.3）。读侧同样按这个值过滤——两侧共用一个判据，不会只在一头生效。
    const commitRevisionRows = await tx.execute<{ context_revision: string }>(sql`
      SELECT context_revision::text AS context_revision
      FROM companion_conversations
      WHERE id = ${conversationId}
        AND workspace_id = ${job.workspaceId} AND user_id = ${userId}
      FOR SHARE
    `);
    const commitRevision = commitRevisionRows[0]?.context_revision ?? null;
    if (contextRevision === null || commitRevision !== contextRevision) {
      logger.info(
        { jobId: job.id, conversationId, contextRevision, commitRevision },
        "summarizer skipped: conversation content changed while the summary was being produced",
      );
      return false;
    }

    const coverageManifest = buildSummaryCoverageManifest({
      conversationId,
      snapshot,
      parentCoverageFromSeq: parent?.coverageFromSeq ?? null,
    });

    // 提交的围栏（同区间不重复提交、父版本比较）都在这一条语句里，见 store 的注释。
    // 返回 null = 什么都没提交（这一区间已有有效的一份，或链头已经动了）——**不能记成功**。
    const committedSummaryId = await upsertCommittedSummary(tx, {
      workspaceId: job.workspaceId,
      userId,
      conversationId,
      summary,
      sourceRunId,
      coverageFromSeq,
      coverageThroughSeq,
      sourceHash: snapshot.sourceHash,
      parentSummaryId: expectedParentId,
      coverageManifest,
      policyVersion: COMPACTION_POLICY_VERSION,
      verifiedContextRevision: commitRevision,
    });
    if (!committedSummaryId) {
      logger.info(
        { jobId: job.id, conversationId, sourceRunId, expectedParentId },
        "summarizer skipped: this range is already committed, or the chain moved while the model call was in flight",
      );
      return false;
    }

    // 生成 episodic 候选记忆。§9.4：写入端即限制 ≤200 字，确保读取注入时不需截断。
    const episodicContent = (summary.title + "：" + summary.keyEvents.slice(0, 3).join("；")).slice(0, 200);
    await tx.execute(sql`
      INSERT INTO assistant_memory_items
        (workspace_id, user_id, kind, content, source_event_id, user_stated, user_confirmed,
         candidate, importance, confidence, scope, source_type, embedding_status, created_at, updated_at)
      VALUES
        (${job.workspaceId}, ${userId}, 'episodic',
         ${episodicContent},
         ${`summary:${conversationId}:${sourceRunId ?? "conversation"}`},
         false, false, true, 0.4, 0.7, 'workspace', 'summary', 'pending', now(), now())
      ON CONFLICT (workspace_id, user_id, kind, source_event_id)
        WHERE deleted_at IS NULL AND source_event_id IS NOT NULL
      DO NOTHING
    `);
    // 反向引用（方案 44 §3.3）：记下这份摘要派生出哪条记忆。
    // 没有它，用户遗忘那条记忆之后这份摘要仍会每轮注入同样的内容——遗忘被 undo 掉了。
    // 0388 的触发器靠这一列把失效传递回来（把摘要置为 `stale`，读取侧立刻不再注入）。
    //
    // 认的是**刚提交的那一行**（`upsertCommittedSummary` 返回的 id），不是「这个会话里
    // sourceRunId 相同的行」：手动整理的 sourceRunId 是 NULL，按它匹配会把手动路径写过的
    // 每一行都指向同一条记忆。
    await tx.execute(sql`
      UPDATE conversation_summaries
         SET derived_memory_id = (
           SELECT id FROM assistant_memory_items
            WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId}
              AND source_event_id = ${`summary:${conversationId}:${sourceRunId ?? "conversation"}`}
              AND deleted_at IS NULL
            ORDER BY created_at DESC LIMIT 1
         ), updated_at = now()
       WHERE id = ${committedSummaryId}::uuid
         AND workspace_id = ${job.workspaceId} AND user_id = ${userId}
    `);
    return true;
  });

  if (!committed) return;

  logger.info({ jobId: job.id, conversationId, idempotencyKey }, "summarizer completed");
  // §9.9：记录摘要成功指标
  try {
    companionSummaryTotal.labels("success").inc();
  } catch {
    // metrics 记录失败不阻断
  }
}
