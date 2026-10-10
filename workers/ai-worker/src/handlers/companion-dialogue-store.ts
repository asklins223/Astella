/**
 * Companion 对话 DB 编排原语（2026-08-24 AI 设计审查 §4.4 拆分）。
 *
 * 自 companion-dialogue.ts 拆出：
 * - ReadContext：read 阶段冻结的上下文结构；
 * - insertStreamEvent / emitCompanionTtsSegments：事件写入（独立事务 + fence）；
 * - markCompanionRunFailed：run failed + error event（fence：仅 active 可写终态）;
 * - readGroundedTutorContext / parsePageContext 的 DB 侧使用、
 *   enqueueCompanionMemoryJobs：终态事务内异步入队记忆任务；
 * - feature flags 与 grounded-tutor prompt 常量。
 */

import { canonicalJsonV1, sha256Hex, sha256Utf8V1 } from "@astella/shared/content-hash";
import type {
  CompanionRunFailureClassV1,
  PetPersonaPresetBoundaries,
  PetProfileActiveness,
} from "@astella/shared";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.ts";
import { withWorkerWorkspaceTransaction, type WorkerTransaction } from "../db.ts";
import { lockJobLease, type JobLeaseContext } from "../lib/job-lease.ts";
import { assertCompanionHandoffSourcesCurrent, assertCompanionContextSourcesCurrent } from "./companion-context-sources.ts";
// 2026-08-25（AI 设计审计修复）：复用 content 模块的同一实现，消除拆分时
// 复制出的双份 parsePageContext（两份漂移会让编排层与 DB 层对同一
// page_context 得出不同判定）。content→store 无依赖边，不构成循环。
import { parsePageContext, renderCompanionUserTurn, textOfCompanionBlocks } from "./companion-dialogue-content.ts";
import type { CompanionContextHandoffSnapshotV1 } from "./companion-dialogue-content.ts";
import type { CompanionMemoryDirectoryEntry } from "./companion-memory-vector.ts";
import type { PlaybookCandidateEntry, PlaybookCatalogEntry } from "./companion-playbooks.ts";
import {
  materializeGroundedTutorEvidence,
  type GroundedTutorEvidenceRow,
} from "./companion-grounded-evidence.ts";

/** 与 turn-service 对齐的硬限额（03 §6.10）。 */
export interface CompanionDialogueHandlerContext {
  id: string;
  payload: Record<string, unknown>;
  workspaceId: string;
  requestedBy: string | null;
  leaseToken: string;
  signal: AbortSignal;
}

export interface ReadContext {
  runId: string;
  conversationId: string;
  userId: string;
  userMessageId: string;
  generation: number;
  runStatus: string;
  /** L11：run 创建时冻结的账号世代（surface_epoch）。 */
  accountEpoch: number;
  /** 本轮开始时这个人是否正在正式作答（`lib/formal-answer-signal.ts`，doc 34 L15）。 */
  formalAnswerInProgress: boolean;
  /**
   * 正在作答的那一题的**身份**（同一份判据带出来的，doc 34 L15 / 39d W2-6）：
   * 终态那一笔暴露账目要按它写 objective_id/objective_revision——**这一题冻结的那一版**，
   * 不是目标当前的那一版。不在正式作答时为 null。
   */
  formalAnswerTarget: import("../lib/formal-answer-signal.ts").FormalAnswerTarget | null;
  /**
   * 本轮开始时用户停在哪一屏（read 阶段那一次 `readLivePageView`，与 `<here_and_now>`
   * 同一个读数）。终态记账要判"是不是在作答页问的"（39d W2-6），而**必须在 read 阶段
   * 判**：她这一轮说完可能已经翻页，用终态那一刻的屏会把一笔没发生的暴露记上。
   */
  livePageView: import("./companion-live-view.ts").LivePageView | null;
  pageContext: unknown;
  contextHandoff?: Omit<
    import("./companion-dialogue-content.ts").CompanionContextHandoffInputV1,
    "memoryRefs" | "memoryDirectory" | "modelMessages" | "actionLedger" | "proposals"
  >;
  actionLedger?: Array<{
    receiptId: string;
    toolCallId: string;
    name: string;
    status: string;
    safeSummary: string | null;
  }>;
  proposals?: CompanionContextHandoffSnapshotV1["proposals"];
  groundedTutorContext: import("./companion-dialogue-content.ts").GroundedTutorContext | null;
  userText: string;
  recentMessages: import("./companion-context-handoff.ts").CompanionRecentHistoryMessage[];
  conversationClock?: import("./companion-conversation-evidence.ts").CompanionConversationClock;
  residentMemories: { kind: string; content: string; epistemicStatus?: string | null }[];
  memoryDirectory: CompanionMemoryDirectoryEntry[];
  /** §4.6.10 手册目录：只有标题与触发条件；正文由 companion_read_playbook 按 id 展开。 */
  playbookCatalog: PlaybookCatalogEntry[];
  /** 方案 50 §16 第 6 步：她自己提炼、还没核对的候选做法，与目录分开一条通道。 */
  playbookCandidates: PlaybookCandidateEntry[];
  /** 上一句朗读的实际交付回执（§10.2）；null = 没有要带的背景。 */
  deliveryObservation: unknown;

  /** §4.5.10/§4.6.9 上一次后台整理返回的那段结论；没有就是 null。 */
  organizationSurface: string | null;
  memoryRefs: Array<{ memoryId: string; kind: string; content: string }>;
  /**
   * 环境快照渲染好的 `<here_and_now>` 数据块（方案 29 §4.1），null = 没有任何有值行。
   * 每轮无条件注入，不经工具、不经模型。
   */
  hereAndNow: string | null;
  /**
   * `<this_turn_facts>` 数据块（39d W2-3）：用户这句话点到的对象是谁、在不在、状态如何。
   * null = 这一轮没有可解析的指称，或解析超预算被整块丢弃。
   */
  thisTurnFacts: string | null;
  /**
   * 这一轮**可以报**的读数目录（39d W2-5）：`values` 用于把 `{{f:key}}` 渲染成真实数值
   * （下发前统一渲染），`block` 是进 prompt 的 `<fact_spans>`。null = 这一轮没有可报的读数。
   */
  factSpans: { values: Record<string, string>; block: string } | null;
  /**
   * `<conversation_summary>` 数据块（方案 29 §11 C1），null = 这个会话还没有摘要。
   * 历史回放带完整的近期消息，更早的对话由摘要与原文补读承接。
   */
  conversationSummary: string | null;
  /** Account persona revision fixed before the first provider call in this run. */
  personaProfileRevision: number;
  personaExamplesRevision: number;
  defaultExpressionVersion: string;
  petProfile: {
    selfDescription?: string | null;
    name: string;
    speakingStyle: string;
    personalityTags: string[];
    examples: { text: string }[];
    /**
     * 活跃度与边界（方案 29 §3.3 / 抱怨 #2）。此前对话链路**根本不查这两列**——
     * 它们只被念头调度器读，所以用户在设置里调的活跃度、勾的边界，对日常对话的
     * 影响是字面意义的零。
     */
    activeness: PetProfileActiveness | null;
    boundaries: PetPersonaPresetBoundaries | null;
  } | null;
  nextMessageSeq: number;
  nextEventSeq: number;
}

export interface ConversationSummaryReadRow extends Record<string, unknown> {
  summary: unknown;
  coverage_from_seq: string | null;
  coverage_through_seq: string | null;
  coverage_source_hash: string | null;
}

/** 摘要接续链的父节点（44 §5.1）。id + revision 是提交前的比较基准。 */
export interface ParentSummaryRow extends Record<string, unknown> {
  id: string;
  revision: number;
  summary: unknown;
  coverage_from_seq: string | null;
  coverage_through_seq: string | null;
}

/** 接续链上的一个节点（44 §5.2）。 */
export interface SummaryChainNode extends Record<string, unknown> {
  id: string;
  revision: number;
  parent_summary_id: string | null;
  summary: unknown;
  coverage_from_seq: string | null;
  coverage_through_seq: string | null;
  coverage_source_hash: string | null;
  /** 1 = 链头（覆盖最靠后），数字越大越早。 */
  depth: number;
}

export interface SummaryChainView {
  /** 覆盖最靠后、且完全早于可见尾部的那一份。 */
  head: SummaryChainNode | null;
  depth: number;
  /**
   * 沿接续链真正覆盖到的最早 seq。
   *
   * 不能拿 `head.coverage_from_seq` 当它——那只描述这一份自己读过的区间。链上任何
   * 一段断掉（比如某次压缩输出不合规被跳过），真实覆盖都比它晚。
   */
  effectiveCoverageFromSeq: string | null;
  effectiveCoverageThroughSeq: string | null;
  /** 链上没盖住的区间；非空表示更早的那段确实读不到。 */
  gaps: { fromSeq: string; throughSeq: string }[];
}

/**
 * 纯函数：把一条接续链（链头在前）折叠成「真正覆盖到哪里、哪里有洞」。
 *
 * 单独抽出来是为了能脱离数据库验收（44 §8.2 的「两个会话的同号 seq/桶不碰撞」、
 * 「撤权后父子摘要同步失效」都要先有这条纯判定）。
 *
 * 洞的判定：子节点的 coverage_from 比父节点的 coverage_through 大 1 以上时，中间
 * 那一段没有任何摘要覆盖。压缩跳过一次就是这种形状。
 */
export function summarizeSummaryChain(nodes: readonly SummaryChainNode[]): SummaryChainView {
  const head = nodes.find((node) => node.depth === 1) ?? null;
  if (!head) {
    return {
      head: null, depth: 0, effectiveCoverageFromSeq: null,
      effectiveCoverageThroughSeq: null, gaps: [],
    };
  }
  const ordered = [...nodes].sort((a, b) => a.depth - b.depth);
  const gaps: { fromSeq: string; throughSeq: string }[] = [];
  let effectiveFrom: string | null = head.coverage_from_seq;
  const effectiveThrough = head.coverage_through_seq;
  for (let index = 1; index < ordered.length; index += 1) {
    const child = ordered[index - 1]!;
    const parent = ordered[index]!;
    if (!child.coverage_from_seq || !parent.coverage_through_seq || !parent.coverage_from_seq) continue;
    // 洞在「父覆盖到的末尾」与「子开始覆盖」之间：子往回跳的那一段没人读过。
    const holeFrom = BigInt(parent.coverage_through_seq) + 1n;
    const holeThrough = BigInt(child.coverage_from_seq) - 1n;
    if (holeFrom <= holeThrough) {
      gaps.push({ fromSeq: holeFrom.toString(), throughSeq: holeThrough.toString() });
    }
    if (effectiveFrom === null || BigInt(parent.coverage_from_seq) < BigInt(effectiveFrom)) {
      effectiveFrom = parent.coverage_from_seq;
    }
  }
  return {
    head,
    depth: ordered.length,
    effectiveCoverageFromSeq: effectiveFrom,
    effectiveCoverageThroughSeq: effectiveThrough,
    gaps,
  };
}

export interface CompanionHistoryRow extends Record<string, unknown> {
  id: string;
  seq: string;
  role: "user" | "assistant";
  blocks: unknown;
  content_sha256: string;
  page_context: unknown;
  created_at: string;
  run_status: string | null;
}

// Preserve user additions, including an interrupted or superseded turn. Their
// timestamps and reply status distinguish continuous additions from old topics.
// Partial/error assistant outputs are records, not completed model replies.
function companionHistoryCondition(conversationId: string, beforeSeq?: string) {
  return sql`
    m.conversation_id = ${conversationId}
    AND m.role IN ('user', 'assistant')
    AND m.kind NOT IN ('cancelled', 'error')
    ${beforeSeq ? sql`AND m.seq < ${beforeSeq}::bigint` : sql``}
  `;
}

/** Dialogue and summarizer use the same rows and the same selection-aware text. */
export async function readCompanionHistoryRows(
  tx: WorkerTransaction,
  conversationId: string,
  options: { beforeSeq?: string; fromSeq?: string; limit: number },
): Promise<CompanionHistoryRow[]> {
  const rows = await tx.execute<CompanionHistoryRow>(sql`
    SELECT m.id, m.seq::text AS seq, m.role, m.blocks, m.content_sha256,
           to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
           (SELECT r.status FROM companion_turn_runs r
            WHERE r.user_message_id = m.id AND m.role = 'user'
            ORDER BY r.created_at DESC LIMIT 1) AS run_status,
           (SELECT jsonb_build_object('selection', coalesce(r.page_context->'selection', r.page_context->'context'->'selection'))
            FROM companion_turn_runs r
            WHERE r.user_message_id = m.id AND m.role = 'user'
            ORDER BY r.created_at DESC LIMIT 1) AS page_context
    FROM companion_messages m
    WHERE ${companionHistoryCondition(conversationId, options.beforeSeq)}
      ${options.fromSeq ? sql`AND m.seq >= ${options.fromSeq}::bigint` : sql``}
    ORDER BY m.seq DESC LIMIT ${options.limit}
  `);
  return Array.from(rows);
}

export async function countCompanionHistoryMessages(
  tx: WorkerTransaction, conversationId: string, beforeSeq: string,
): Promise<bigint> {
  const rows = await tx.execute<{ message_count: string }>(sql`
    SELECT count(*)::text AS message_count FROM companion_messages m
    WHERE ${companionHistoryCondition(conversationId, beforeSeq)}
  `);
  return BigInt(rows[0]?.message_count ?? "0");
}

export function companionHistoryText(row: Pick<CompanionHistoryRow, "role" | "blocks" | "page_context">): string {
  const text = textOfCompanionBlocks(row.blocks);
  return row.role === "user" ? renderCompanionUserTurn(text, row.page_context) : text;
}

/** Persist once per run. Retries read and reuse the committed prompt snapshot. */
export async function persistCompanionContextHandoffSnapshot(args: {
  workspaceId: string;
  userId: string;
  runId: string;
  snapshot: CompanionContextHandoffSnapshotV1;
  sha256: string;
}): Promise<{ snapshot: CompanionContextHandoffSnapshotV1; sha256: string }> {
  if (
    args.snapshot.version !== 1
    || args.snapshot.runId !== args.runId
    || sha256Utf8V1(canonicalJsonV1(args.snapshot)) !== args.sha256
  ) {
    throw new Error("companion context handoff snapshot hash does not match its content");
  }
  return withWorkerWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    async (tx) => {
      const inserted = await tx.execute<{
        snapshot: CompanionContextHandoffSnapshotV1;
        snapshot_sha256: string;
      }>(sql`
        INSERT INTO companion_context_handoff_snapshots
          (run_id, workspace_id, user_id, conversation_id, snapshot, snapshot_sha256, snapshot_version)
        SELECT r.id, r.workspace_id, r.user_id, r.conversation_id,
               ${JSON.stringify(args.snapshot)}::jsonb, ${args.sha256}, 1
        FROM companion_turn_runs r
        WHERE r.id = ${args.runId}
          AND r.workspace_id = ${args.workspaceId}
          AND r.user_id = ${args.userId}
          AND r.status IN ('accepted', 'running', 'waiting_for_confirmation')
        ON CONFLICT (run_id) DO NOTHING
        RETURNING snapshot, snapshot_sha256
      `);
      if (inserted[0]) {
        await assertCompanionHandoffSourcesCurrent(tx, args, inserted[0].snapshot);
        return {
          snapshot: inserted[0].snapshot,
          sha256: inserted[0].snapshot_sha256,
        };
      }

      const existing = await tx.execute<{
        snapshot: CompanionContextHandoffSnapshotV1;
        snapshot_sha256: string;
      }>(sql`
        SELECT snapshot, snapshot_sha256
        FROM companion_context_handoff_snapshots
        WHERE run_id = ${args.runId}
          AND workspace_id = ${args.workspaceId}
          AND user_id = ${args.userId}
          AND snapshot_version = 1
      `);
      const row = existing[0];
      if (!row) throw new Error("companion context handoff snapshot was not committed");
      if (sha256Utf8V1(canonicalJsonV1(row.snapshot)) !== row.snapshot_sha256) {
        throw new Error("committed companion context handoff snapshot failed content verification");
      }
      await assertCompanionHandoffSourcesCurrent(tx, args, row.snapshot);
      return { snapshot: row.snapshot, sha256: row.snapshot_sha256 };
    },
  );
}

/**
 * 读取**接续链**：链头是覆盖最靠后的那一份已校验摘要，再沿 `parent_summary_id` 回溯
 * 更早的节点。
 *
 * 为什么不能只取最新一份（44 §5.2）：压缩是分次发生的，只读最新一份就等于把更早
 * 的覆盖索引丢掉——会话看起来「有摘要」，实际上中间那段没人读过。回溯之后调用方
 * 才知道真实覆盖到哪里、哪里有洞。
 *
 * 链头**不按「必须早于当前可见尾部」取**（44 §5.2「摘要与回放从同一实际保留边界
 * 派生」）。曾经的写法加了这个锚点，于是注入的摘要与回放窗口在 seq 上一定不相交，
 * 折叠永远折不到东西——而折叠恰恰要靠「覆盖伸进回放」才成立。改成以链的实际覆盖
 * 为准：覆盖伸进窗口时，那段照折，由摘要代表；没伸进来时什么都不折，两种都由调用方
 * 按真实边界算。真正要守的是**有效性**（下面的修订号条件）与覆盖边界本身。
 *
 * `MAX_CHAIN_DEPTH` 是硬上限：接续链理论上可以很长，但一次读取最多回溯这么多层，
 * 剩下的更早内容按「需要时再检索」处理，不在每次调用里无限回溯。
 */
export const MAX_SUMMARY_CHAIN_DEPTH = 32;

export async function readConversationSummaryChain(
  tx: WorkerTransaction,
  conversationId: string,
): Promise<SummaryChainView> {
  const rows = await tx.execute<SummaryChainNode>(sql`
    WITH RECURSIVE chain AS (
      (
      SELECT s.id, s.revision, s.parent_summary_id, s.summary,
             s.coverage_from_seq::text AS coverage_from_seq,
             s.coverage_through_seq::text AS coverage_through_seq,
             s.coverage_source_hash,
             1 AS depth
      FROM conversation_summaries s
      JOIN companion_conversations c
        ON c.id = s.conversation_id AND c.workspace_id = s.workspace_id AND c.user_id = s.user_id
      WHERE s.conversation_id = ${conversationId}
        AND s.status IN ('candidate', 'confirmed')
        AND s.coverage_from_seq IS NOT NULL
        AND s.coverage_through_seq IS NOT NULL
        AND s.coverage_source_hash IS NOT NULL
        -- 方案 44 §3.3：读取侧也检查当前有效性。消息被改写或删除后，会话的
        -- context_revision 会前进，而这份摘要记下的是**它被验证时**的取值——对不上
        -- 就说明它盖住的那一段已经变了，不能再用它那句「更早那段对话」把已经不存在的
        -- 内容重新说一遍。没记修订号的旧行按未验证处理，排除。
        --
        -- 但「没记修订号」有两种：一种是**真的没法验证**（会话改过，无从判断摘要写在
        -- 改写之前还是之后），另一种是**能验证而当时没回填**（0384 只加了列，没回填既有
        -- 行；而 context_revision 默认是 1、只在消息被改写/删除时才 +1，所以停在 1 的
        -- 会话等于从未改写过，那些摘要其实可证明仍然有效）。
        -- 后者由迁移 0391 回填掉，所以这里的 NULL 现在只剩前一种。
        AND s.verified_context_revision = c.context_revision
      ORDER BY s.coverage_through_seq DESC, s.updated_at DESC
      LIMIT 1
      )
      UNION ALL
      (
      SELECT p.id, p.revision, p.parent_summary_id, p.summary,
             p.coverage_from_seq::text AS coverage_from_seq,
             p.coverage_through_seq::text AS coverage_through_seq,
             p.coverage_source_hash,
             c.depth + 1
      FROM conversation_summaries p
      JOIN chain c ON p.id = c.parent_summary_id
      JOIN companion_conversations conv
        ON conv.id = p.conversation_id AND conv.workspace_id = p.workspace_id AND conv.user_id = p.user_id
      WHERE c.depth < ${MAX_SUMMARY_CHAIN_DEPTH}
        AND p.status IN ('candidate', 'confirmed')
        -- 传递来源也要有效：不只检查直接父摘要（44 §3.3）。任一祖先失效，整条链就
        -- 不成立——链头那份摘要已经把祖先的内容写进自己了。
          AND p.verified_context_revision = conv.context_revision
      )
    )
    SELECT * FROM chain ORDER BY depth
  `);
  return summarizeSummaryChain(rows);
}

/**
 * 把这一轮的折叠轨迹并进交接快照，推进到下一个版本（方案 44 §5.3）。
 *
 * **带围栏**：run 必须仍在进行中，且版本号正好是读到的那一版——迟到结果不许覆盖，
 * 版本对不上也不动。`modelMessages` 保持折叠前的完整上下文，恢复时多给上下文更安全；
 * 变的只是多出 `compactions`，让审计能回答「实际发出去的是什么」。
 *
 * 返回 false 表示没写进去（run 已结束或已被别人推进），**不是**失败：快照仍可用，
 * 只是这一折没进轨迹。
 */
export async function recordCompanionContextCompactions(args: {
  workspaceId: string;
  userId: string;
  runId: string;
  snapshot: CompanionContextHandoffSnapshotV1;
  sha256: string;
  compactions: readonly NonNullable<CompanionContextHandoffSnapshotV1["compactions"]>[number][];
}): Promise<boolean> {
  if (args.compactions.length === 0) return false;
  const next: CompanionContextHandoffSnapshotV1 = {
    ...args.snapshot,
    compactions: [...(args.snapshot.compactions ?? []), ...args.compactions],
  };
  const nextSha256 = sha256Utf8V1(canonicalJsonV1(next));
  return withWorkerWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    async (tx) => {
      const updated = await tx.execute(sql`
        UPDATE companion_context_handoff_snapshots s
           SET snapshot = ${JSON.stringify(next)}::jsonb,
               snapshot_sha256 = ${nextSha256},
               snapshot_version = s.snapshot_version + 1,
               created_at = now()
         FROM companion_turn_runs r
         WHERE s.run_id = ${args.runId}
           AND s.workspace_id = ${args.workspaceId} AND s.user_id = ${args.userId}
           AND r.id = s.run_id
           AND r.status IN ('accepted', 'running', 'waiting_for_confirmation')
           AND public.astella_assert_handoff_snapshot_fence(${args.runId}, s.snapshot_version)
        RETURNING s.snapshot_sha256
      `);
      if (updated[0]) return true;
      logger.warn({ runId: args.runId, compactions: args.compactions.length },
        "handoff snapshot compaction trace skipped: run ended or snapshot already advanced");
      return false;
    },
  );
}

/** Read only a content-verified summary wholly before the native history tail. */
export async function readConversationSummary(
  tx: WorkerTransaction,
  conversationId: string,
  historyStartSeq: string,
): Promise<ConversationSummaryReadRow | null> {
  const rows = await tx.execute<ConversationSummaryReadRow>(sql`
    SELECT summary, coverage_from_seq::text AS coverage_from_seq,
           coverage_through_seq::text AS coverage_through_seq, coverage_source_hash
    FROM conversation_summaries
    WHERE conversation_id = ${conversationId}
      AND status IN ('candidate', 'confirmed')
      AND coverage_from_seq IS NOT NULL
      AND coverage_through_seq IS NOT NULL
      AND coverage_source_hash IS NOT NULL
      AND coverage_through_seq < ${historyStartSeq}::bigint
    ORDER BY coverage_through_seq DESC NULLS LAST, updated_at DESC
    LIMIT 1
  `);
  return rows[0] ?? null;
}

/**
 * 当前生效的摘要链头（44 §5.1／§5.3）。
 *
 * 返回的是**覆盖最靠后**的那一份，也就是下一次压缩要接在它后面的父节点。它必须
 * 带上 id 与 revision：提交前要拿它做父版本比较，迟到的结果才不能覆盖新指针。
 *
 * 取 coverage_through_seq 最大的一行是对的——接续链上越晚的节点覆盖得越靠后，更早
 * 的节点经 parent_summary_id 仍然可达。但**读取端不能**因此假设「最新一份就代表
 * 全部更早历史」：那正是局部摘要挤掉更早覆盖索引的地方（44 §5.2）。
 */
export interface CommittedSummaryUpsert {
  workspaceId: string;
  userId: string;
  conversationId: string;
  summary: unknown;
  sourceRunId: string | null;
  coverageFromSeq: string;
  coverageThroughSeq: string;
  sourceHash: string;
  parentSummaryId: string | null;
  coverageManifest: unknown;
  policyVersion: string;
  verifiedContextRevision: string;
}

/**
 * 提交一份摘要（44 §3.3／§5.3）。返回写入行 id；返回 null 表示**什么都没提交**。
 *
 * 两条围栏合在这一条语句里：
 *
 *   1. `NOT EXISTS`：同一段区间（同哈希、同策略版本）已经有一份有效的了，就不再提交
 *      ——「相同区间重复触发只能产生同一次提交」。手动「整理近期对话」尤其需要它：
 *      那条路的 sourceRunId 是 NULL，而唯一索引对 NULL 是 NULLS DISTINCT，冲突目标
 *      根本不会触发，连点两次就会插出两份同区间的摘要（链分叉，读到的那支之外的
 *      另一支谁也看不见）。
 *   2. `ON CONFLICT … WHERE`：同一来源键重入时，只有父版本仍是预期的那个才允许推进
 *      revision，迟到的旧结果不许覆盖新指针。
 *
 * 调用方必须按**行数**判成败：返回 null 时指针没动，不能记成功。此前不看返回行数，
 * 「摘要卡住」在数据上长得跟「一切正常」一样。
 */
export async function upsertCommittedSummary(
  tx: WorkerTransaction,
  input: CommittedSummaryUpsert,
): Promise<string | null> {
  const rows = await tx.execute<{ id: string }>(sql`
    INSERT INTO conversation_summaries
      (workspace_id, user_id, conversation_id, summary, source_run_id,
       coverage_from_seq, coverage_through_seq, coverage_source_hash,
       parent_summary_id, revision, coverage_manifest, compaction_policy_version,
       verified_context_revision, status, created_at, updated_at)
    SELECT ${input.workspaceId}::uuid, ${input.userId}::uuid, ${input.conversationId}::uuid,
           ${JSON.stringify(input.summary)}::jsonb, ${input.sourceRunId}::uuid,
           ${input.coverageFromSeq}::bigint, ${input.coverageThroughSeq}::bigint,
           ${input.sourceHash}::text,
           ${input.parentSummaryId}::uuid, 1, ${JSON.stringify(input.coverageManifest)}::jsonb,
           ${input.policyVersion}::text,
           ${input.verifiedContextRevision}::bigint, 'candidate', now(), now()
    WHERE NOT EXISTS (
      SELECT 1 FROM conversation_summaries x
      WHERE x.workspace_id = ${input.workspaceId} AND x.user_id = ${input.userId}
        AND x.conversation_id = ${input.conversationId}
        AND x.status IN ('candidate', 'confirmed')
        AND x.coverage_from_seq = ${input.coverageFromSeq}::bigint
        AND x.coverage_through_seq = ${input.coverageThroughSeq}::bigint
        AND x.coverage_source_hash = ${input.sourceHash}::text
        AND x.compaction_policy_version = ${input.policyVersion}::text
    )
    ON CONFLICT (workspace_id, user_id, conversation_id, source_run_id)
    DO UPDATE SET summary = EXCLUDED.summary,
                  coverage_from_seq = EXCLUDED.coverage_from_seq,
                  coverage_through_seq = EXCLUDED.coverage_through_seq,
                  coverage_source_hash = EXCLUDED.coverage_source_hash,
                  parent_summary_id = EXCLUDED.parent_summary_id,
                  revision = conversation_summaries.revision + 1,
                  coverage_manifest = EXCLUDED.coverage_manifest,
                  compaction_policy_version = EXCLUDED.compaction_policy_version,
                  verified_context_revision = EXCLUDED.verified_context_revision,
                  updated_at = now()
    WHERE conversation_summaries.parent_summary_id IS NOT DISTINCT FROM EXCLUDED.parent_summary_id
    RETURNING id
  `);
  return rows[0]?.id ?? null;
}

export async function readParentSummary(
  tx: WorkerTransaction,
  conversationId: string,
): Promise<ParentSummaryRow | null> {
  const rows = await tx.execute<ParentSummaryRow>(sql`
    SELECT id, revision, summary,
           coverage_from_seq::text AS coverage_from_seq,
           coverage_through_seq::text AS coverage_through_seq
    FROM conversation_summaries
    WHERE conversation_id = ${conversationId}
      AND status IN ('candidate', 'confirmed')
      AND coverage_through_seq IS NOT NULL
    ORDER BY coverage_through_seq DESC, updated_at DESC
    LIMIT 1
  `);
  return rows[0] ?? null;
}

interface InsertStreamEventArgs {
  conversationId: string;
  workspaceId: string;
  userId: string;
  runId: string;
  generation: number;
  accountEpoch: number;
  seq: number;
  type: string;
  payload: unknown;
  expiresAt: string;
}

export async function insertStreamEvent(
  tx: { execute(query: unknown): Promise<unknown> },
  args: InsertStreamEventArgs,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO companion_stream_events
      (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch, type, payload, expires_at)
    VALUES
      (${args.conversationId}, ${args.seq}, ${args.workspaceId}, ${args.userId},
       ${args.runId}, ${args.generation}, ${args.accountEpoch}, ${args.type},
       ${JSON.stringify(args.payload)}, ${args.expiresAt})
  `);
}

/**
 * 补发一条本轮的过程状态（`assistant.status`）。
 *
 * 为什么要有"补发"：这一轮**开不开思考**要等注意力解释跑完才知道（判据在
 * `companion-turn-thinking`），而 provider 调用前那条状态早就发出去了。开着的轮次
 * 在这里补一条 `thinking`，没开的就不补——界面上因此可以只说真话：
 * 看到「她在想」时，模型确实在思考档上。
 *
 * 返回 false = run 已经不是这一代了（被 cancel/supersede），调用方不必管：
 * 少一条状态不影响正文。
 */
export async function emitCompanionAssistantStatus(args: {
  workspaceId: string;
  read: ReadContext;
  expiresAt: string;
  status: "waiting" | "thinking" | "acting";
  safeLabel: string;
}): Promise<boolean> {
  const { workspaceId, read, expiresAt, status, safeLabel } = args;
  try {
    return await withWorkerWorkspaceTransaction({ workspaceId, userId: read.userId }, async (tx) => {
      const alive = await tx.execute<{ id: string }>(sql`
        UPDATE companion_turn_runs
        SET updated_at = now()
        WHERE id = ${read.runId} AND status IN ('accepted', 'running')
          AND generation = ${read.generation}
        RETURNING id
      `);
      if (!alive[0]) return false;
      const counters = await tx.execute<{ next_event_seq: string }>(sql`
        UPDATE companion_conversations
        SET next_event_seq = next_event_seq + 1
        WHERE id = ${read.conversationId}
        RETURNING next_event_seq
      `);
      const seq = Number(counters[0].next_event_seq) - 1;
      await insertStreamEvent(tx, {
        conversationId: read.conversationId,
        workspaceId,
        userId: read.userId,
        runId: read.runId,
        generation: read.generation,
        accountEpoch: read.accountEpoch,
        seq,
        type: "assistant.status",
        payload: { status, safeLabel },
        expiresAt,
      });
      await tx.execute(sql`
        SELECT pg_notify('astella_companion_events_v1',
                         ${JSON.stringify({ conversationId: read.conversationId, maxSeq: seq + 1 })})
      `);
      return true;
    });
  } catch (err) {
    // 状态是"让她别显得卡住"的辅助，不该把正文带崩。
    logger.warn({ runId: read.runId, err, status }, "companion assistant status emit skipped");
    return false;
  }
}

export interface CompanionTtsSegmentEvent {
  version: 2;
  segmentId: string;
  ordinal: number;
  displayText: string;
  displayStart: number;
  displayEnd: number;
  synthesisText: string;
  synthesisTextSha256: string;
  cue: {
    version: 1;
    intent: "think" | "explain" | "encourage" | "celebrate" | "uncertain" | "warn" | "sleep";
    emotion: "neutral" | "happy" | "curious" | "concerned" | "surprised";
    intensity: number;
    durationMs?: number;
  };
}

/**
 * 15b（字幕般流式 TTS）：下发 voice.segment.ready——每事务一批
 * （fence 校验一次 + 连续 seq 分配 + 多行 INSERT + 批尾 NOTIFY）。
 *
 * 段事件在 final 之前按 ordinal 顺序下发，前端按批收到后送 TTS 引擎排队合成。
 * 一段一个事务在 200 段上限下是 200 个事务（每事务 5 条语句），批量后降到 1/4。
 * 返回 false 表示 run 已终态（fence 拒绝），调用方应停止后续段。
 */
export async function emitCompanionTtsSegments(args: {
  job: JobLeaseContext;
  workspaceId: string;
  userId: string;
  runId: string;
  generation: number;
  accountEpoch: number;
  conversationId: string;
  expiresAt: string;
  segments: CompanionTtsSegmentEvent[];
  notifyCompanionEvent: (tx: { execute(q: unknown): Promise<unknown> }, seq: number) => Promise<void>;
}): Promise<boolean> {
  const SEGMENTS_PER_TX = 4;
  for (let i = 0; i < args.segments.length; i += SEGMENTS_PER_TX) {
    const batch = args.segments.slice(i, i + SEGMENTS_PER_TX);
    const written = await withWorkerWorkspaceTransaction(
      { workspaceId: args.workspaceId, userId: args.userId },
      async (tx) => {
        // Voice events are durable user-visible output too; a superseded worker
        // must not publish them after losing the same lease that fenced deltas.
        await lockJobLease(tx, args.job);
        await assertCompanionContextSourcesCurrent(tx, { workspaceId: args.workspaceId, userId: args.userId }, args.runId);
        const alive = await tx.execute<{ id: string }>(sql`
          UPDATE companion_turn_runs
          SET status = 'running', updated_at = now()
          WHERE id = ${args.runId} AND status IN ('accepted', 'running')
            AND generation = ${args.generation}
          RETURNING id
        `);
        if (!alive[0]) return false;
        const counters = await tx.execute<{ next_event_seq: string }>(sql`
          UPDATE companion_conversations
          SET next_event_seq = next_event_seq + ${batch.length}
          WHERE id = ${args.conversationId}
          RETURNING next_event_seq
        `);
        const nextEventSeq = counters[0]?.next_event_seq;
        if (nextEventSeq === undefined) {
          throw new Error("conversation event counter update returned no row");
        }
        const endSeq = Number(nextEventSeq) - 1;
        const startSeq = endSeq - batch.length + 1;
        await tx.execute(sql`
          INSERT INTO companion_stream_events
            (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch, type, payload, expires_at)
          VALUES ${sql.join(batch.map((segment, j) => sql`(
            ${args.conversationId}, ${startSeq + j}, ${args.workspaceId}, ${args.userId},
            ${args.runId}, ${args.generation}, ${args.accountEpoch}, 'voice.segment.ready',
            ${JSON.stringify({
              version: segment.version,
              segmentId: segment.segmentId,
              ordinal: segment.ordinal,
              displayText: segment.displayText,
              displayStart: segment.displayStart,
              displayEnd: segment.displayEnd,
              synthesisText: segment.synthesisText,
              synthesisTextSha256: segment.synthesisTextSha256,
              cue: segment.cue,
            })}, ${args.expiresAt}
          )`), sql`, `)}
        `);
        await args.notifyCompanionEvent(tx, endSeq);
        return true;
      },
    );
    if (!written) return false;
  }
  return true;
}

// V2: read grounded tutor context from learning_objectives_v2 +
// learning_objective_revisions_v2 (claim → objective_statement) +
// evidence_snapshots_v2 + learning_objective_evidence_bindings_v2.
// key_point_id is now an alias for objective_id; card_id validates
// the card exists via learning_cards_v2.
export async function readGroundedTutorContext(
  tx: { execute(query: unknown): Promise<unknown> },
  pageContext: unknown,
  scope: { workspaceId: string; userId: string },
): Promise<import("./companion-dialogue-content.ts").GroundedTutorContext | null> {
  const context = parsePageContextForStore(pageContext);
  if (context?.requestedCapability !== "grounded_tutor") {
    return null;
  }
  if (context.pageKind === "learning_run") {
    return readGroundedTutorContextForLearningRun(tx, context, scope);
  }
  return null;
}

/**
 * 新 LearningRun 只读取 PREPARE 冻结的 target/evidence closure。即使
 * Objective 在 Run 期间更新，也不会把新 claim 或新证据带进已授权的 Tutor。
 */
async function readGroundedTutorContextForLearningRun(
  tx: { execute(query: unknown): Promise<unknown> },
  context: Record<string, unknown>,
  scope: { workspaceId: string; userId: string },
): Promise<import("./companion-dialogue-content.ts").GroundedTutorContext | null> {
  const runId = typeof context.runId === "string" ? context.runId : null;
  const snapshotId = typeof context.snapshotId === "string" ? context.snapshotId : null;
  const taskId = typeof context.taskId === "string" ? context.taskId : null;
  if (!runId || !snapshotId || !taskId) return null;

  const frozenRows = await tx.execute(sql`
    SELECT s.target, s.evidence_bindings
    FROM learning_runs r
    JOIN learning_run_private_contracts c
      ON c.run_id = r.id
      AND c.workspace_id = ${scope.workspaceId}
      AND c.user_id = ${scope.userId}
      AND c.snapshot_id = ${snapshotId}
    JOIN learning_target_snapshots_v2 s
      ON s.run_id = r.id
      AND s.snapshot_id = c.snapshot_id
      AND s.workspace_id = ${scope.workspaceId}
      AND s.user_id = ${scope.userId}
    JOIN learning_tasks t
      ON t.id = r.active_task_id
      AND t.id = ${taskId}
      AND t.run_id = r.id
      AND t.workspace_id = ${scope.workspaceId}
      AND t.user_id = ${scope.userId}
      AND t.status = 'active'
    WHERE r.id = ${runId}
      AND r.workspace_id = ${scope.workspaceId}
      AND r.user_id = ${scope.userId}
      AND r.phase = 'active'
      AND s.published_target_eligibility IN ('eligible', 'practice_only')
    LIMIT 1
  `) as Array<{ target: unknown; evidence_bindings: unknown }>;
  const frozen = frozenRows[0];
  if (!frozen || !frozen.target || typeof frozen.target !== "object" || !Array.isArray(frozen.evidence_bindings)) {
    return null;
  }

  const claimValue = (frozen.target as { objectiveStatement?: unknown }).objectiveStatement;
  const claim = typeof claimValue === "string"
    ? claimValue.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
    : "";
  if (!claim) return null;

  const allExpectedById = new Map<string, string>();
  const expectedById = new Map<string, string>();
  for (const raw of frozen.evidence_bindings) {
    if (!raw || typeof raw !== "object") return null;
    const binding = raw as { evidenceSnapshotId?: unknown; evidenceSnapshotHash?: unknown };
    if (
      typeof binding.evidenceSnapshotId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(binding.evidenceSnapshotId)
      || typeof binding.evidenceSnapshotHash !== "string"
      || !/^[0-9a-f]{64}$/i.test(binding.evidenceSnapshotHash)
    ) {
      return null;
    }
    const previous = allExpectedById.get(binding.evidenceSnapshotId);
    if (previous && previous !== binding.evidenceSnapshotHash) return null;
    allExpectedById.set(binding.evidenceSnapshotId, binding.evidenceSnapshotHash);
    // 模型上下文最多容纳五条 sealed quote。Snapshot 的 binding
    // 顺序本身冻结，故取前五个不同 evidence 仍是确定性、可审计的子闭包。
    if (expectedById.size < 5 || expectedById.has(binding.evidenceSnapshotId)) {
      expectedById.set(binding.evidenceSnapshotId, binding.evidenceSnapshotHash);
    }
  }
  if (expectedById.size === 0) return null;

  // IDs 已按 UUID schema 校验；显式 uuid[] 可避免 postgres-js 对数组 bind 的
  // 参数歧义；只取 usable 的 sealed evidence。
  const idsLiteral = `{${[...expectedById.keys()].join(",")}}`;
  const evidenceRows = await tx.execute(sql`
    SELECT DISTINCT es.evidence_snapshot_id,
           es.evidence_snapshot_hash,
           es.quote_hash,
           es.block_content_hash,
           es.start_offset,
           es.end_offset,
           es.created_at,
           nb.content AS block_content
    FROM evidence_snapshots_v2 es
    JOIN evidence_eligibility_states_v2 ees
      ON ees.workspace_id = es.workspace_id
      AND ees.evidence_snapshot_id = es.evidence_snapshot_id
      AND ees.status = 'usable'
    JOIN note_blocks nb ON nb.id = es.block_id AND nb.workspace_id = es.workspace_id
    WHERE es.workspace_id = ${scope.workspaceId}
      AND es.evidence_snapshot_id = ANY(${idsLiteral}::uuid[])
    ORDER BY es.created_at DESC
    LIMIT 5
  `) as GroundedTutorEvidenceRow[];
  if (evidenceRows.length !== expectedById.size) return null;
  const rowsWithExpected = evidenceRows.map((row) => ({
    ...row,
    expected_evidence_snapshot_hash: expectedById.get(row.evidence_snapshot_id),
  }));
  try {
    const evidence = materializeGroundedTutorEvidence(rowsWithExpected);
    return evidence.length > 0 ? { claim, evidence } : null;
  } catch {
    return null;
  }
}

function parsePageContextForStore(value: unknown): Record<string, unknown> | null {
  return parsePageContext(value);
}

export function isActiveRun(status: string): boolean {
  return status === "accepted" || status === "running";
}

export function isCompanionDialogueEnabled(): boolean {
  return process.env.COMPANION_DIALOGUE_V1_ENABLED === "true";
}

export function isCompanionVoiceDialogueEnabled(): boolean {
  return process.env.COMPANION_VOICE_DIALOGUE_V1_ENABLED === "true";
}

/** 22 方案记忆上下文开关：任一记忆相关 flag 开启即启用新检索/回传链路。 */
export function isCompanionMemoryContextEnabled(): boolean {
  return process.env.COMPANION_MEMORY_VECTOR_V1 === "true"
    || process.env.COMPANION_MEMORY_EXTRACTOR_V1 === "true"
    || process.env.COMPANION_SUMMARIZER_V1 === "true";
}

/** 每 40 条消息一桶：桶号进幂等键，同桶内的后续轮次不再重复摘要。 */
export const SUMMARIZER_MESSAGE_BUCKET = 40;

/**
 * 摘要任务的幂等键。**键里不许出现 runId**——那正是"每轮都排一次、每轮都烧一次
 * 调用"的成因（实测 7.6s / 6 932 token 每轮）。同桶内无论跑多少个 run，
 * 只有第一个能插进 jobs。
 */
export function summarizerJobKey(input: {
  conversationId: string;
  messageSeq: number;
}): string {
  return `summary:${input.conversationId}:bucket:${Math.floor(input.messageSeq / SUMMARIZER_MESSAGE_BUCKET)}`;
}

/**
 * 在终态事务内异步入队记忆提取/摘要任务。
 * 幂等：jobs.idempotency_key 唯一索引兜底。
 */
export async function enqueueCompanionMemoryJobs(
  tx: { execute(query: unknown): Promise<unknown> },
  args: {
    workspaceId: string;
    userId: string;
    runId: string;
    conversationId: string;
    messageSeq: number;
  },
): Promise<void> {
  if (process.env.COMPANION_MEMORY_EXTRACTOR_V1 === "true") {
    await tx.execute(sql`
      INSERT INTO jobs
        (type, workspace_id, requested_by, payload, status, priority, resource_class, idempotency_key)
      VALUES
        ('companion_memory_extract', ${args.workspaceId}, ${args.userId},
         ${JSON.stringify({ runId: args.runId, userId: args.userId })},
         'pending', 10, 'maintenance', ${`memory-extract:${args.runId}`})
      ON CONFLICT (workspace_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
      DO NOTHING
    `);
  }
  // 2026-09-22 实测：这条排队原来是"每个 run 排一次"（连续会话每轮都过 seq≥30），
  // 摘要器修好之后就变成**每轮**稳定烧 7.6 秒 / 6 932 token、并写一行新摘要。
  // 改成按消息数分桶：同一段对话每满 40 条才摘一次，与 §9.61 念头排队的 bucket 同法。
  if (process.env.COMPANION_SUMMARIZER_V1 === "true" && args.messageSeq >= 30) {
    await tx.execute(sql`
      INSERT INTO jobs
        (type, workspace_id, requested_by, payload, status, priority, resource_class, idempotency_key)
      VALUES
        ('companion_summarizer', ${args.workspaceId}, ${args.userId},
         ${JSON.stringify({ conversationId: args.conversationId, userId: args.userId, sourceRunId: args.runId })},
         'pending', 10, 'maintenance',
         ${summarizerJobKey({ conversationId: args.conversationId, messageSeq: args.messageSeq })})
      ON CONFLICT (workspace_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
      DO NOTHING
    `);
  }
}

export interface CompanionFailureSpanScope {
  workspaceId: string;
  userId: string;
  runId: string;
}

/** One row per workspace/user/class bounds retained failure state across restarts. */
export async function recordCompanionRunFailureSpanInTransaction(
  tx: WorkerTransaction,
  scope: CompanionFailureSpanScope,
  failureClass: CompanionRunFailureClassV1,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO companion_run_failure_spans
      (workspace_id, user_id, failure_class, span_started_at, last_failure_at,
       failure_count, first_run_id, last_run_id, recovered_at, recovery_run_id, updated_at)
    VALUES
      (${scope.workspaceId}, ${scope.userId}, ${failureClass}, now(), now(),
       1, ${scope.runId}, ${scope.runId}, NULL, NULL, now())
    ON CONFLICT (workspace_id, user_id, failure_class)
    DO UPDATE SET
      span_started_at = CASE
        WHEN companion_run_failure_spans.recovered_at IS NULL
          THEN companion_run_failure_spans.span_started_at
        ELSE now()
      END,
      last_failure_at = now(),
      failure_count = CASE
        WHEN companion_run_failure_spans.recovered_at IS NULL
          THEN LEAST(companion_run_failure_spans.failure_count + 1, 1000000000)
        ELSE 1
      END,
      first_run_id = CASE
        WHEN companion_run_failure_spans.recovered_at IS NULL
          THEN companion_run_failure_spans.first_run_id
        ELSE EXCLUDED.first_run_id
      END,
      last_run_id = EXCLUDED.last_run_id,
      recovered_at = NULL,
      recovery_run_id = NULL,
      updated_at = now()
  `);
}

export async function recoverCompanionRunFailureSpanInTransaction(
  tx: WorkerTransaction,
  scope: CompanionFailureSpanScope,
  failureClass: CompanionRunFailureClassV1,
): Promise<void> {
  await tx.execute(sql`
    UPDATE companion_run_failure_spans
    SET recovered_at = now(), recovery_run_id = ${scope.runId}, updated_at = now()
    WHERE workspace_id = ${scope.workspaceId}
      AND user_id = ${scope.userId}
      AND failure_class = ${failureClass}
      AND recovered_at IS NULL
  `);
}

/** Optional TTS/tool observations must not make the text turn fail. */
export async function recordCompanionRunFailureSpanBestEffort(
  scope: CompanionFailureSpanScope,
  failureClass: CompanionRunFailureClassV1,
): Promise<void> {
  try {
    await withWorkerWorkspaceTransaction(
      { workspaceId: scope.workspaceId, userId: scope.userId },
      (tx) => recordCompanionRunFailureSpanInTransaction(tx, scope, failureClass),
    );
  } catch (err) {
    logger.error({ runId: scope.runId, failureClass, err }, "companion failure span write failed");
  }
}

export async function recoverCompanionRunFailureSpanBestEffort(
  scope: CompanionFailureSpanScope,
  failureClass: CompanionRunFailureClassV1,
): Promise<void> {
  try {
    await withWorkerWorkspaceTransaction(
      { workspaceId: scope.workspaceId, userId: scope.userId },
      (tx) => recoverCompanionRunFailureSpanInTransaction(tx, scope, failureClass),
    );
  } catch (err) {
    logger.error({ runId: scope.runId, failureClass, err }, "companion failure span recovery write failed");
  }
}

/** run failed + error event（fence：仅 active run 可写终态；cancel/supersede 后零写入）。 */
export async function markCompanionRunFailed(
  read: Pick<ReadContext, "runId" | "conversationId" | "userId" | "generation" | "accountEpoch">,
  workspaceId: string,
  code: string,
  recoverable: boolean,
  reason: string,
  failureClass: CompanionRunFailureClassV1,
): Promise<void> {
  try {
    await withWorkerWorkspaceTransaction(
      { workspaceId, userId: read.userId },
      async (tx) => {
        // fence：只有 run 仍 active 才标记 failed（已被 cancel/supersede → 不写 error event，
        // turn.cancelled 已由 cancel 路径负责）。
        // waiting_proposal_id 一并清空：终态 run 不得残留挂起确认指针。
        const claimed = await tx.execute<{ id: string }>(sql`
          UPDATE companion_turn_runs
          SET status = 'failed', error_code = ${code}, finished_at = now(),
              waiting_proposal_id = NULL
          WHERE id = ${read.runId} AND status IN ('accepted', 'running')
          RETURNING id
        `);
        if (!claimed[0]) return;
        await recordCompanionRunFailureSpanInTransaction(tx, {
          workspaceId,
          userId: read.userId,
          runId: read.runId,
        }, failureClass);
        const counters = await tx.execute<{ next_event_seq: string }>(sql`
          UPDATE companion_conversations
          SET next_event_seq = next_event_seq + 2
          WHERE id = ${read.conversationId}
          RETURNING next_event_seq
        `);
        const next = counters[0];
        if (!next) return;
        const seq = Number(next.next_event_seq) - 2;
        const expiresAt = new Date(Date.now() + 24 * 3_600_000).toISOString();
        await insertStreamEvent(tx, {
          conversationId: read.conversationId,
          workspaceId,
          userId: read.userId,
          runId: read.runId,
          generation: read.generation,
          accountEpoch: read.accountEpoch,
          seq,
          type: "error",
          payload: {
            code,
            message: reason.slice(0, 240),
            recoverable,
            requestId: read.runId,
          },
          expiresAt,
        });
        // §5.2 确定性来源：安全错误 → uncertain/concerned/0.45（与 error 同事务原子下发）。
        await insertStreamEvent(tx, {
          conversationId: read.conversationId,
          workspaceId,
          userId: read.userId,
          runId: read.runId,
          generation: read.generation,
          accountEpoch: read.accountEpoch,
          seq: seq + 1,
          type: "character.cue",
          payload: { cue: ERROR_CUE_PAYLOAD },
          expiresAt,
        });
        await tx.execute(sql`
          UPDATE companion_turn_runs
          SET last_event_seq = ${seq + 1}, updated_at = now()
          WHERE id = ${read.runId}
        `);
        await tx.execute(sql`
          UPDATE companion_stream_events
          SET expires_at = ${expiresAt}
          WHERE conversation_id = ${read.conversationId} AND run_id = ${read.runId}
        `);
        await tx.execute(sql`
          SELECT pg_notify('astella_companion_events_v1',
                           ${JSON.stringify({ conversationId: read.conversationId, maxSeq: seq + 1 })})
        `);
        logger.warn({ runId: read.runId, code, reason }, "companion run marked failed");
      },
    );
  } catch (err) {
    logger.warn({ runId: read.runId, err }, "markCompanionRunFailed failed");
    throw err;
  }
}

import { ERROR_CUE_PAYLOAD_V1 as ERROR_CUE_PAYLOAD } from "./companion-dialogue-content.ts";

/** grounded-tutor 分支的审计元数据（prompt id/hash）。 */
export const GROUNDED_TUTOR_PROMPT_ID = "companion-grounded-tutor-v1";

export function computeGroundedTutorPromptSha256(prompt: string): string {
  return sha256Hex(prompt);
}
