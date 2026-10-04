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
import { stableStringify, sha256Utf8V1 } from "@ailearn/shared/content-hash";
import { logger } from "../lib/logger.ts";
import { readJobPayloadString } from "@ailearn/shared";
import { createProvider, withThinkingDisabled } from "../lib/ai-provider.ts";
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
import {
  boundCompanionRecentHistory,
  REPLAY_WINDOW_MESSAGES,
} from "./companion-dialogue-content.ts";
import type { JobPayload } from "./index.ts";
import { runWorkerAiTask } from "./worker-ai-task.ts";
import { companionHistoryText, readCompanionHistoryRows, type CompanionHistoryRow } from "./companion-dialogue-store.ts";

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
].join("\n");

export const SUMMARIZER_INPUT_CHARS = 12_000;

export interface SummarizerSnapshotMessage {
  id: string;
  seq: string | number;
  role: string;
  contentSha256: string;
  blocks: unknown;
  pageContext?: unknown;
}

export interface SummarizerSnapshot {
  transcript: string;
  coverageFromSeq: string | null;
  coverageThroughSeq: string | null;
  sourceHash: string;
}

function transcriptLine(row: Pick<SummarizerSnapshotMessage, "role" | "blocks" | "pageContext">): string {
  const text = Array.isArray(row.blocks)
    ? (row.blocks as Array<{ type?: string; text?: unknown }>)
        .filter((block) => block.type === "text")
        .map((block) => String(block.text ?? ""))
        .join("")
    : "";
  const contextualText = row.role === "user"
    ? companionHistoryText({ role: "user", blocks: row.blocks, page_context: row.pageContext })
    : text;
  return `${row.role === "assistant" ? "桌宠" : "用户"}：${contextualText}`;
}

/**
 * Freeze the exact authored-message range that fits the summarizer budget.
 * Newer rows win; the source hash makes late edits/deletes reject the result.
 */
export function buildSummarizerSnapshot(
  rows: SummarizerSnapshotMessage[],
  maxChars = SUMMARIZER_INPUT_CHARS,
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
  let used = 0;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const row = ordered[index];
    const line = transcriptLine(row);
    const additional = line.length + (selected.length > 0 ? 1 : 0);
    if (used + additional > maxChars) {
      if (selected.length === 0 && maxChars > 0) {
        selected.unshift({ row, line: line.slice(-maxChars) });
      }
      break;
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
  };
}

export function buildSummarizerMessages(conversationText: string): Array<{ role: "system" | "user"; content: string }> {
  return [
    { role: "system", content: SUMMARIZER_PROMPT },
    // 超预算时留**结尾**：会话是往上长的，砍尾巴等于把"刚才聊了什么"丢掉。
    { role: "user", content: conversationText.slice(-SUMMARIZER_INPUT_CHARS) },
  ];
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
export const CONVERSATION_SUMMARY_MAX_CHARS = 600;

const SUMMARY_BOUNDARY_TAGS = /<\/?conversation_summary>/gi;

export function renderConversationSummary(
  summary: unknown,
  options: { coverageVerified?: boolean } = {},
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
  const lines = [
    "<conversation_summary>",
    `更早那段对话：${title}`,
    options.coverageVerified
      ? "这段摘要有消息边界校验，只用于接续话题；操作是否完成以对应工具回执为准。"
      : "这段摘要的消息边界无法核实，可能与近期对话重叠；只作话题线索，操作是否完成以对应工具回执为准。",
    ...(() => {
      const events = list(row.keyEvents, 3);
      return events.length > 0 ? [`办过的事：${events.join("；")}`] : [];
    })(),
    ...(() => {
      const followUps = list(row.followUps, 3);
      return followUps.length > 0 ? [`还没了结：${followUps.join("；")}`] : [];
    })(),
    ...(() => {
      const prefs = list(row.userPreferences, 2);
      return prefs.length > 0 ? [`他偏好的：${prefs.join("；")}`] : [];
    })(),
    "（这段不是这一轮新查的；里面的数字可能已经变了，要报数字得重新查。）",
    "</conversation_summary>",
  ];
  const block = lines.join("\n");
  return block.length > CONVERSATION_SUMMARY_MAX_CHARS
    ? `${block.slice(0, CONVERSATION_SUMMARY_MAX_CHARS - 1)}…</conversation_summary>`
    : block;
}

export async function runCompanionSummarizer(job: JobPayload): Promise<void> {
  // 设计 P1-8（2026-09-15 审计）：字段名走共享契约（@ailearn/shared 的
  // companion-memory-job-payload），改名由编译器兜住。
  const conversationId = readJobPayloadString(job.payload, "conversationId");
  const userId = readJobPayloadString(job.payload, "userId");
  if (!conversationId || !userId) throw new Error("companion_summarizer payload 缺 conversationId/userId");
  await assertJobLease(job);

  const govCtx = await resolveAIGovernanceContext(job.workspaceId, userId);
  if (!govCtx.consentOk) throw new AIConsentRequiredError();
  const textRes = resolveProviderForTask(govCtx, "companion_agent");
  // 2026-09-22 实测：开着思考时这一步 completion=998 token（= maxTokens 1000），
  // JSON 从句子中间被切断，`parseMemoryExtractJson` 三层兜底全都解不出——
  // 那 37 条 "invalid output" 的 SyntaxError 就是这个，而不是模型不听话。
  // 关掉思考之后同一份输入 completion=375、7.6 秒返回且解析通过（开着是 36 秒）。
  // 伴星的非流式调用一律关思考，这里此前是唯一漏掉的一处。
  const provider = createGovernedProvider(
    createProvider(textRes.providerName, withThinkingDisabled(textRes.providerConfig)),
    govCtx,
    job.workspaceId,
    // AI P0-8（2026-09-15 审计）：接上 ai_audit_log 的唯一写入口（此前零调用）。
    // ai_audit_log.user_id 是 NOT NULL，故 payload 未带可信 actor 时不写审计行。
    userId
      ? { userId, operation: "companion_summarizer", jobId: job.id }
      : undefined,
  );

  const snapshot = await withJobTransaction(job, async (tx) => {
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

    // 100 行只是数据库分页大小，不是会话摘要边界。真实边界由上面的回放选择器确定，
    // 实际输入则由 SUMMARIZER_INPUT_CHARS 限定；长会话不再被固定 200 行截断。
    const sourceRows: CompanionHistoryRow[] = [];
    let beforeSeq = tailStartSeq;
    while (true) {
      const rows = await readCompanionHistoryRows(tx, conversationId, { beforeSeq, limit: 100 });
      if (rows.length === 0) break;
      sourceRows.push(...rows);
      const candidate = buildSummarizerSnapshot(sourceRows.map((row) => ({
        id: row.id,
        seq: row.seq,
        role: row.role,
        contentSha256: row.content_sha256,
        blocks: row.blocks,
        pageContext: row.page_context,
      })));
      if (candidate.transcript.length >= SUMMARIZER_INPUT_CHARS) break;
      beforeSeq = rows.at(-1)!.seq;
    }

    return buildSummarizerSnapshot(sourceRows.map((row) => ({
      id: row.id,
      seq: row.seq,
      role: row.role,
      contentSha256: row.content_sha256,
      blocks: row.blocks,
      pageContext: row.page_context,
    })));
  });

  if (!snapshot.transcript.trim() || !snapshot.coverageFromSeq || !snapshot.coverageThroughSeq) {
    logger.info({ jobId: job.id, conversationId }, "summarizer skipped: empty conversation");
    return;
  }

  const messages = buildSummarizerMessages(snapshot.transcript);
  const generationParameters = { temperature: 0.2, maxTokens: 1_000, responseFormat: "json_object" as const };
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
  }));
  let summary: z.infer<typeof conversationSummaryOutputSchema>;
  try {
    summary = await runWorkerAiTask({
      job,
      userId,
      taskId: "companion_summarizer",
      taskVersion: 1,
      idempotencyKey: `summary:${conversationId}:${snapshot.sourceHash}`,
      inputSnapshotRef: { kind: "task", id: `${conversationId}:${snapshot.coverageThroughSeq}`, hash: inputSnapshotHash },
      input: messages,
      modelId: provider.modelId,
      promptVersion: `${provider.promptVersion}:companion-summarizer-v1`,
      resourceClass: "maintenance",
      timeoutMs: resolveProviderCallTimeout("companion_agent"),
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
    const conversation = await tx.execute<{ id: string }>(sql`
      SELECT id FROM companion_conversations
      WHERE id = ${conversationId} AND workspace_id = ${job.workspaceId} AND user_id = ${userId}
      FOR SHARE
    `);
    if (!conversation[0]) return false;

    const currentSourceRows = await readCompanionHistoryRows(tx, conversationId, {
      fromSeq: snapshot.coverageFromSeq!,
      beforeSeq: (BigInt(snapshot.coverageThroughSeq!) + 1n).toString(),
      limit: SUMMARIZER_INPUT_CHARS,
    });
    const currentSnapshot = buildSummarizerSnapshot(currentSourceRows.map((row) => ({
      id: row.id,
      seq: row.seq,
      role: row.role,
      contentSha256: row.content_sha256,
      blocks: row.blocks,
      pageContext: row.page_context,
    })));
    if (
      currentSnapshot.coverageFromSeq !== snapshot.coverageFromSeq
      || currentSnapshot.coverageThroughSeq !== snapshot.coverageThroughSeq
      || currentSnapshot.sourceHash !== snapshot.sourceHash
    ) {
      logger.info({ jobId: job.id, conversationId }, "summarizer skipped: source range changed before commit");
      return false;
    }

    // conversation_summaries 幂等写入（唯一约束兜底）。
    await tx.execute(sql`
      INSERT INTO conversation_summaries
        (workspace_id, user_id, conversation_id, summary, source_run_id,
         coverage_from_seq, coverage_through_seq, coverage_source_hash,
         status, created_at, updated_at)
      VALUES
        (${job.workspaceId}, ${userId}, ${conversationId}, ${JSON.stringify(summary)}, ${sourceRunId},
         ${snapshot.coverageFromSeq}::bigint, ${snapshot.coverageThroughSeq}::bigint, ${snapshot.sourceHash},
         'candidate', now(), now())
      ON CONFLICT (workspace_id, user_id, conversation_id, source_run_id)
      DO UPDATE SET summary = EXCLUDED.summary,
                    coverage_from_seq = EXCLUDED.coverage_from_seq,
                    coverage_through_seq = EXCLUDED.coverage_through_seq,
                    coverage_source_hash = EXCLUDED.coverage_source_hash,
                    updated_at = now()
    `);

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
