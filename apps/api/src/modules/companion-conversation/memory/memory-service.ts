/**
 * 真桌宠记忆服务（22-real-desktop-pet-memory-context-prd-tdd.md）。
 *
 * 在原有分层记忆（文档 16 §10）基础上扩展 V2 字段：
 * importance / confidence / scope / pinned / archived / dismissed /
 * embedding_status / source_type / episodic kind。
 *
 * 写函数接受 executor（事务）参数——调用方传 withWorkspaceTransaction 的
 * 事务，满足 SEC-01 跨 workspace 隔离审计。
 */

import { and, desc, eq, ilike, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { ApiTransaction } from "../../../db/client.ts";
import {
  assistantMemoryItems,
  assistantMemoryItemRevisions,
  assistantMemorySourceSuppressions,
  companionMemoryMutationLockKey,
  MEMORY_CONTENT_SIMILARITY_THRESHOLD,
  MEMORY_SEMANTIC_SIMILARITY_THRESHOLD,
} from "@ailearn/shared/db-schema/assistant-memory";
import type { CompanionMemoryBudgetTier } from "@ailearn/shared/db-schema/assistant-memory";
import {
  accountPreferenceWriteDecision,
  type AccountPreferenceWriteRejection,
} from "@ailearn/shared/companion-memory-scope";
import { closeDeliveriesForMemoryItem } from "../delivery/delivery-service.ts";
import { maskEntriesForSource, unmaskEntriesForSource } from "../discovery/discovery-service.ts";

// 轻微·15（round-4）：LIST 无分页时的防御性上限。
const MEMORY_LIST_LIMIT = 200;

/**
 * 回收区窗口（40 §4.6.4：「普通删除…进入可恢复回收区，沿用 **30 天**窗口」）。
 *
 * 它不是「到期自动消失」——到期之后记忆还在，只是**用户随时可以要求彻底清除，
 * 而不再有版本历史挡路**。这正是合同把「普通删除」与「彻底清除」分成两条路的原因。
 */
export const MEMORY_RECYCLE_BIN_DAYS = 30;

export interface MemoryScope {
  workspaceId: string;
  userId: string;
}

/** Serialize automatic extraction against every user-driven memory deletion path. */
async function lockMemoryMutations(executor: ApiTransaction, userId: string): Promise<void> {
  await executor.execute(sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${companionMemoryMutationLockKey(userId)}, 0))
  `);
}

export class MemorySourceSuppressedError extends Error {
  constructor() {
    super("This automatic memory source was explicitly forgotten.");
    this.name = "MemorySourceSuppressedError";
  }
}

/**
 * 账号级（`scope='global'`）写入被拒（42 阶段 1 E）。
 *
 * 判据原先只长在抽取器里，用户在记忆中心手动把本地材料存成账号级偏好时服务端照写不误，
 * 0371 的受控铺开还会把它复制到别的空间。这里**拒绝**而不降级：本批不实现跨空间降级，
 * 悄悄把 global 改成 workspace 同样是错回执——用户会以为规则跟着账号走。`reason`
 * 是稳定字符串，由路由原样回给前端。
 */
export class MemoryGlobalScopeRejectedError extends Error {
  constructor(readonly reason: AccountPreferenceWriteRejection) {
    super(`Memory cannot be saved as an account-level rule (${reason}).`);
    this.name = "MemoryGlobalScopeRejectedError";
  }
}

/**
 * 账号级写入守卫：这一行的**最终形状**能不能以 `scope='global'` 存在。
 * 传最终值（截断后的正文、沿用库里的条件也算）而不是单个输入字段，否则"这次恰好没传
 * scope"就绕过去了。判据本体与抽取器共用 `@ailearn/shared/companion-memory-scope`。
 */
function assertGlobalPreferenceWritable(row: {
  scope: string;
  kind: string;
  content: string;
  appliesWhen: string | null;
}): void {
  const decision = accountPreferenceWriteDecision(row);
  if (!decision.ok) throw new MemoryGlobalScopeRejectedError(decision.reason);
}

export type MemoryKindV2 =
  | "preference"
  | "goal"
  | "learning_context"
  | "interaction_note"
  | "episodic"
  /** 判断记录（40 §4.5.4–4.5.5）：她对已发生片段的解释，不是关于用户的事实。 */
  | "judgment";

export type MemoryScopeV2 = "global" | "workspace" | "task";
export type MemorySourceTypeV2 =
  | "user_stated"
  | "model_inferred"
  | "confirmed"
  | "summary";
export type MemoryEmbeddingStatusV2 = "none" | "pending" | "ready" | "failed";
/** §4.6.8：user / extractor / companion / maintenance。词表与 0360 的 CHECK 一致。 */
export type MemoryAuthorType = "user" | "extractor" | "companion" | "maintenance";
/** §4.5.4：有据、暂定、争议、已被替代。 */
export type MemoryEpistemicStatus = "supported" | "tentative" | "disputed" | "superseded";
/** 判断记录的说话者是 `companion`，依据是 `companion_interpretation`。 */
export type MemorySourceSpeaker = "user" | "assistant" | "companion";
export type MemorySourceBasis =
  | "direct_statement"
  | "inferred_from_statement"
  | "companion_interpretation";
export type MemoryBudgetTier = CompanionMemoryBudgetTier;

export const COMPANION_MEMORY_RESIDENT_BUDGET_V1 = {
  items: 6,
  tokenEstimate: 320,
  byteCount: 1000,
} as const;

/**
 * 归档保留上限（40 §4.6.6「仍受全量存储/保留预算…不承诺无限增长」/ A74）。
 *
 * 数字与迁移 0346 的 `ailearn_companion_memory_retention_limits()` 同源。
 * 那边是 SQL、这边是类型，两处各写一个数就会漂移——所以这里显式说明关系，
 * 并且由 `0346` 的迁移测试断言两边一致。
 */
export const COMPANION_MEMORY_ARCHIVED_BUDGET_V1 = {
  items: 500,
  byteCount: 400_000,
} as const;

export interface MemoryBudgetUsageV1 {
  items: number;
  tokenEstimate: number;
  byteCount: number;
}

export interface MemoryBudgetStatusV1 {
  version: 1;
  resident: {
    used: MemoryBudgetUsageV1;
    limits: typeof COMPANION_MEMORY_RESIDENT_BUDGET_V1;
    available: MemoryBudgetUsageV1;
  };
  active: MemoryBudgetUsageV1;
  /**
   * A74：归档**也**有上限，所以它和 resident 一样是三段结构。
   * 之前这里是裸 usage，于是"归档受保留上限"这件事在读侧根本看不见。
   */
  archived: {
    used: MemoryBudgetUsageV1;
    limits: typeof COMPANION_MEMORY_ARCHIVED_BUDGET_V1;
    available: MemoryBudgetUsageV1;
  };
}

export type MemoryTierMoveResultV1 =
  | { status: "moved"; memoryId: string; fromTier: MemoryBudgetTier; tier: MemoryBudgetTier; revision: number; residentUsage: MemoryBudgetUsageV1 }
  | { status: "unchanged"; memoryId: string; tier: MemoryBudgetTier; revision: number }
  | { status: "missing" | "not_eligible" }
  | {
    status: "capacity";
    memoryId: string;
    requestedTier: "resident";
    current: MemoryBudgetUsageV1;
    requested: MemoryBudgetUsageV1;
    limits: typeof COMPANION_MEMORY_RESIDENT_BUDGET_V1;
    suggestedDowngrades: { memoryId: string; title: string; revision: number; tokenEstimate: number; byteCount: number }[];
  };

export interface MemoryItemV2 {
  memoryItemId: string;
  kind: MemoryKindV2;
  content: string;
  sourceEventId: string | null;
  sourceSessionId: string | null;
  sourceSpeaker: MemorySourceSpeaker | null;
  sourceBasis: "direct_statement" | "inferred_from_statement" | null;
  appliesWhen: string | null;
  validFrom: string | null;
  validUntil: string | null;
  userStated: boolean;
  userConfirmed: boolean;
  candidate: boolean;
  importance: number;
  confidence: number;
  scope: MemoryScopeV2;
  budgetTier: MemoryBudgetTier;
  pinned: boolean;
  archived: boolean;
  dismissedAt: string | null;
  conflictGroup: string | null;
  embeddingStatus: MemoryEmbeddingStatusV2;
  sourceType: MemorySourceTypeV2;
  revision: number;
  authorType: MemoryAuthorType;
  authorId: string | null;
  epistemicStatus: MemoryEpistemicStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRevisionV1 {
  revision: number;
  kind: MemoryKindV2;
  content: string;
  sourceEventId: string | null;
  sourceSessionId: string | null;
  sourceSpeaker: MemorySourceSpeaker | null;
  sourceBasis: "direct_statement" | "inferred_from_statement" | null;
  appliesWhen: string | null;
  validFrom: string | null;
  validUntil: string | null;
  userStated: boolean;
  userConfirmed: boolean;
  importance: number;
  confidence: number;
  scope: MemoryScopeV2;
  sourceType: MemorySourceTypeV2;
  authorType: MemoryAuthorType;
  authorId: string | null;
  epistemicStatus: MemoryEpistemicStatus;
  supersededAt: string;
}

export class MemoryRevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super("This memory changed after it was loaded.");
    this.name = "MemoryRevisionConflictError";
  }
}

/** 简单冲突检测：与新记忆相似度超过共用判据的活跃记忆归入同一 conflict_group。 */
async function markMemoryConflictIfSimilar(
  executor: ApiTransaction,
  scope: MemoryScope,
  memoryId: string,
  content: string,
): Promise<void> {
  const rows = await executor.execute<{ id: string }>(sql`
    SELECT id FROM assistant_memory_items
    WHERE workspace_id = ${scope.workspaceId}
      AND user_id = ${scope.userId}
      AND deleted_at IS NULL
      AND (valid_from IS NULL OR valid_from <= now())
      AND (valid_until IS NULL OR valid_until > now())
      AND id <> ${memoryId}
      AND similarity(content, ${content}) > ${MEMORY_CONTENT_SIMILARITY_THRESHOLD}
    LIMIT 1
  `);
  const other = (Array.isArray(rows) ? rows : [])[0]?.id;
  if (!other) return;
  const group = randomUUID();
  await executor.update(assistantMemoryItems)
    .set({ conflictGroup: group, updatedAt: new Date() })
    .where(eq(assistantMemoryItems.id, memoryId));
  await executor.update(assistantMemoryItems)
    .set({ conflictGroup: group, updatedAt: new Date() })
    .where(eq(assistantMemoryItems.id, other));
}

function toContract(row: typeof assistantMemoryItems.$inferSelect): MemoryItemV2 {
  return {
    memoryItemId: row.id,
    kind: row.kind as MemoryKindV2,
    content: row.content,
    sourceEventId: row.sourceEventId,
    sourceSessionId: row.sourceSessionId,
    sourceSpeaker: row.sourceSpeaker as MemorySourceSpeaker | null,
    sourceBasis: row.sourceBasis as "direct_statement" | "inferred_from_statement" | null,
    appliesWhen: row.appliesWhen,
    validFrom: row.validFrom?.toISOString() ?? null,
    validUntil: row.validUntil?.toISOString() ?? null,
    userStated: row.userStated,
    userConfirmed: row.userConfirmed,
    candidate: row.candidate,
    importance: row.importance,
    confidence: row.confidence,
    scope: row.scope as MemoryScopeV2,
    budgetTier: row.budgetTier as MemoryBudgetTier,
    pinned: row.pinned,
    archived: row.archivedAt !== null,
    dismissedAt: row.dismissedAt?.toISOString() ?? null,
    conflictGroup: row.conflictGroup ?? null,
    embeddingStatus: row.embeddingStatus as MemoryEmbeddingStatusV2,
    sourceType: row.sourceType as MemorySourceTypeV2,
    revision: row.revision,
    authorType: row.authorType as MemoryAuthorType,
    authorId: row.authorId,
    epistemicStatus: row.epistemicStatus as MemoryEpistemicStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** upsert：同 (kind, sourceEventId) 活跃记忆更新；无来源记忆靠 userStated 区分。 */
export async function upsertMemory(
  executor: ApiTransaction,
  scope: MemoryScope,
  input: {
    kind: MemoryKindV2;
    content: string;
    sourceEventId?: string;
    sourceSessionId?: string;
    sourceSpeaker?: MemorySourceSpeaker | null;
    sourceBasis?: "direct_statement" | "inferred_from_statement" | null;
    appliesWhen?: string | null;
    validFrom?: Date | null;
    validUntil?: Date | null;
    userStated?: boolean;
    candidate?: boolean;
    importance?: number;
    confidence?: number;
    scope?: MemoryScopeV2;
    sourceType?: MemorySourceTypeV2;
    pinned?: boolean;
    /**
     * 继承哪一行的跨空间身份（纠正路径用）。不传时：global 行认领自己的 id，其余 NULL。
     * **必须继承而不是换新 key**——换了 key，其他空间里那几份副本就和这条脱钩，
     * 0268 的同步触发器再也找不到彼此（doc 34 L9）。
     */
    globalKeyFrom?: string | null;
  },
  now: Date = new Date(),
): Promise<MemoryItemV2> {
  // §9.4/§25：写入端统一限制 ≤200 字。upsertMemory 是所有写入路径的统一入口，
  // 在此做防御性截断，确保无论调用方是否已截断，写入数据库的内容都不超过 200 字。
  const content = input.content.slice(0, 200);
  if (input.appliesWhen && input.appliesWhen.length > 200) {
    throw new RangeError("Memory applicability condition exceeds 200 characters.");
  }
  if (input.validFrom && input.validUntil && input.validUntil <= input.validFrom) {
    throw new RangeError("Memory validity must end after it starts.");
  }
  if (input.sourceEventId) {
    await lockMemoryMutations(executor, scope.userId);
    if (input.userStated !== true) {
      const suppression = await executor.execute<{ suppressed: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM assistant_memory_source_suppressions
           WHERE user_id = ${scope.userId}
             AND kind = ${input.kind}
             AND source_event_id = ${input.sourceEventId}
        ) AS suppressed
      `);
      if (suppression[0]?.suppressed === true) throw new MemorySourceSuppressedError();
    }
      const existing = await executor
      .select()
      .from(assistantMemoryItems)
      .where(and(
        eq(assistantMemoryItems.workspaceId, scope.workspaceId),
        eq(assistantMemoryItems.userId, scope.userId),
        eq(assistantMemoryItems.kind, input.kind),
        eq(assistantMemoryItems.sourceEventId, input.sourceEventId),
        isNull(assistantMemoryItems.deletedAt),
      ))
      .limit(1);
      if (existing[0]) {
      // An automatic extraction may add evidence elsewhere, but it cannot rewrite
      // a version the user explicitly authored.
      if (existing[0].authorType === "user" && input.userStated !== true) {
        return toContract(existing[0]);
      }
      // 账号级守卫（42 阶段 1 E）：按最终 shape 判——省略 scope / appliesWhen 是**沿用**
      // 库里那一条，不是免检**。拦在 UPDATE 之前，源行、副本与 revision/history 都不动。
      assertGlobalPreferenceWritable({
        scope: input.scope ?? existing[0].scope,
        kind: input.kind,
        content,
        appliesWhen: input.appliesWhen === undefined ? existing[0].appliesWhen : input.appliesWhen,
      });
      await executor.update(assistantMemoryItems)
        .set({
          content,
          sourceSpeaker: input.sourceSpeaker === undefined ? existing[0].sourceSpeaker : input.sourceSpeaker,
          sourceBasis: input.sourceBasis === undefined ? existing[0].sourceBasis : input.sourceBasis,
          appliesWhen: input.appliesWhen === undefined ? existing[0].appliesWhen : input.appliesWhen,
          validFrom: input.validFrom === undefined
            ? input.validUntil && !existing[0].validFrom ? now : existing[0].validFrom
            : input.validFrom ?? (input.validUntil ? now : null),
          validUntil: input.validUntil === undefined ? existing[0].validUntil : input.validUntil,
          importance: input.importance ?? existing[0].importance,
          confidence: input.confidence ?? existing[0].confidence,
          scope: input.scope ?? existing[0].scope,
          // 改成 global 时这一行必须认领自己的 key：0268 的两支同步触发器按
          // `global_key IS NOT NULL` 挑行，"加入/重新加入空间时补铺"也只挑带 key 的。
          // 留 NULL 就等于这条 global 记忆哪里都不去（doc 34 L9）。
          globalKey: existing[0].globalKey
            ?? ((input.scope ?? existing[0].scope) === "global" ? existing[0].id : null),
          sourceType: input.sourceType ?? existing[0].sourceType,
          // 词表与 0360 的 `assistant_memory_items_author_type_check` 一致
          // （user | extractor | companion | maintenance）。旧词 model/background 已被
          // 0360 迁移成 extractor/maintenance，写旧词会撞 CHECK。
          authorType: input.userStated === true
            ? "user"
            : (input.sourceType ?? existing[0].sourceType) === "summary" ? "maintenance" : "extractor",
          authorId: input.userStated === true ? scope.userId : null,
          epistemicStatus: input.userStated === true ? "supported" : "tentative",
          userStated: input.userStated ?? existing[0].userStated,
          userConfirmed: input.userStated === true ? true : existing[0].userConfirmed,
          pinned: input.pinned ?? existing[0].pinned,
          // 内容变化后需要重新生成 embedding。
          embeddingStatus: existing[0].embeddingStatus === "ready"
            ? "pending"
            : existing[0].embeddingStatus,
          updatedAt: now,
        })
        .where(eq(assistantMemoryItems.id, existing[0].id));
      const updated = await executor
        .select()
        .from(assistantMemoryItems)
        .where(eq(assistantMemoryItems.id, existing[0].id))
        .limit(1);
      await markMemoryConflictIfSimilar(executor, scope, updated[0].id, content);
      await fanoutAgentGlobalPreference(executor, updated[0]);
      return toContract(updated[0]);
    }
  }
  // id 在这里先生成而不是交给 `defaultRandom()`：global 记忆的 `global_key` 约定是
  // "源行认领自己的 id"（与 `ailearn_fanout_global_companion_memory` 同一句话），
  // 拿不到 id 就写不出这个 key——而没有 key 的 global 行，0268 的触发器永远不认。
  const memoryId = randomUUID();
  const memoryScope = input.scope ?? "workspace";
  // 账号级守卫（42 阶段 1 E）：拦在 INSERT 之前。缺省是 workspace，本来就不过判据。
  assertGlobalPreferenceWritable({
    scope: memoryScope,
    kind: input.kind,
    content,
    appliesWhen: input.appliesWhen ?? null,
  });
  // ⚠️ 这一段是**原子 upsert**，不是"先查后插"（2026-09-29，P2-11）。
  //
  // 原写法是 check-then-act：上面已经 SELECT 过、没有行，于是走到这里 INSERT。
  // 两个并发事务（同一个 sourceEventId 的两条伴星消息几乎必然并发）会**都**查不到，
  // 于是都去 INSERT——而 `assistant_memory_items_content_unique_idx`
  // （0132 迁移，partial UNIQUE on (workspace_id,user_id,kind,source_event_id)
  //   WHERE deleted_at IS NULL AND source_event_id IS NOT NULL）会让其中一个
  // 撞 23505。
  //
  // **关键在于这个错误没法"捕获后重试"**：`executor` 是一个已经开着的
  // 事务，Postgres 里任何一条语句失败都会把整个事务置为 aborted 状态，
  // 之后无论再发什么语句都只会得到 25P02。所以唯一的正确形态是**一条语句**
  // 把"不存在就插、存在就改"表达掉。
  //
  // ⚠️ 审计那条"补唯一索引"是多余的——索引 0132 就在那儿，早就有了。
  // 真正缺的是"让写入路径能吃下这个索引"。
  const inserted = await executor.insert(assistantMemoryItems).values({
    id: memoryId,
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    kind: input.kind,
    content,
    sourceEventId: input.sourceEventId ?? null,
    sourceSessionId: input.sourceSessionId ?? null,
    sourceSpeaker: input.sourceSpeaker === undefined ? (input.userStated === true ? "user" : null) : input.sourceSpeaker,
    sourceBasis: input.sourceBasis === undefined ? (input.userStated === true ? "direct_statement" : null) : input.sourceBasis,
    appliesWhen: input.appliesWhen ?? null,
    validFrom: input.validFrom ?? (input.validUntil ? now : null),
    validUntil: input.validUntil ?? null,
    userStated: input.userStated ?? false,
    userConfirmed: input.userStated ?? false,
    candidate: input.candidate ?? true,
    importance: input.importance ?? (input.userStated ? 0.8 : 0.5),
    confidence: input.confidence ?? 0.5,
    scope: memoryScope,
    globalKey: input.globalKeyFrom ?? (memoryScope === "global" ? memoryId : null),
    sourceType: input.sourceType ?? (input.userStated ? "user_stated" : "model_inferred"),
    // 词表与 0360 的 `assistant_memory_items_author_type_check` 一致，见上面 update 分支的说明。
    // 候选走的是 extractor：它没被确认，但作者确实是抽取器，不是"模型"这个旧词。
    authorType: input.userStated === true
      ? "user"
      : (input.sourceType ?? "model_inferred") === "summary" ? "maintenance" : "extractor",
    authorId: input.userStated === true ? scope.userId : null,
    epistemicStatus: input.userStated === true ? "supported" : "tentative",
    pinned: input.pinned ?? false,
    embeddingStatus: input.candidate === false ? "pending" : "none",
    createdAt: now,
    updatedAt: now,
  })
    .onConflictDoUpdate({
      // targetWhere 必须逐字复述 partial index，Postgres 才能推断冲突目标；
      // setWhere 另行保护已由用户手写的当前版本。
      target: [
        assistantMemoryItems.workspaceId,
        assistantMemoryItems.userId,
        assistantMemoryItems.kind,
        assistantMemoryItems.sourceEventId,
      ],
      targetWhere: sql`${assistantMemoryItems.deletedAt} IS NULL
                      AND ${assistantMemoryItems.sourceEventId} IS NOT NULL`,
      setWhere: sql`${assistantMemoryItems.deletedAt} IS NULL
                   AND ${assistantMemoryItems.sourceEventId} IS NOT NULL
                   AND (${assistantMemoryItems.authorType} <> 'user' OR excluded.author_type = 'user')`,
      set: {
        // 语义与上面 update 分支一致：调用方没给的就沿用库里已有的
        content: sql`excluded.content`,
        sourceSpeaker: sql`coalesce(excluded.source_speaker, ${assistantMemoryItems.sourceSpeaker})`,
        sourceBasis: sql`coalesce(excluded.source_basis, ${assistantMemoryItems.sourceBasis})`,
        appliesWhen: sql`coalesce(excluded.applies_when, ${assistantMemoryItems.appliesWhen})`,
        validFrom: sql`coalesce(excluded.valid_from, ${assistantMemoryItems.validFrom})`,
        validUntil: sql`coalesce(excluded.valid_until, ${assistantMemoryItems.validUntil})`,
        importance: sql`coalesce(excluded.importance, ${assistantMemoryItems.importance})`,
        confidence: sql`coalesce(excluded.confidence, ${assistantMemoryItems.confidence})`,
        scope: sql`coalesce(excluded.scope, ${assistantMemoryItems.scope})`,
        // 0268 的两支同步触发器按 `global_key IS NOT NULL` 挑行，
        // 所以改成 global 时必须认领自己的 key（与 update 分支同一句话）。
        globalKey: sql`coalesce(${assistantMemoryItems.globalKey},
          case when coalesce(excluded.scope, ${assistantMemoryItems.scope}) = 'global'
               then ${assistantMemoryItems.id} else null end)`,
        sourceType: sql`coalesce(excluded.source_type, ${assistantMemoryItems.sourceType})`,
        authorType: sql`excluded.author_type`,
        authorId: sql`excluded.author_id`,
        epistemicStatus: sql`excluded.epistemic_status`,
        userStated: sql`excluded.user_stated`,
        userConfirmed: sql`excluded.user_confirmed`,
        pinned: sql`excluded.pinned`,
        // 内容变了就得重新生成 embedding——与 update 分支同一判据
        embeddingStatus: sql`case when ${assistantMemoryItems.embeddingStatus} = 'ready'
                                   then 'pending' else ${assistantMemoryItems.embeddingStatus} end`,
        updatedAt: now,
      },
    })
    .returning();
  const current = inserted[0] ?? (input.sourceEventId
    ? (await executor
      .select()
      .from(assistantMemoryItems)
      .where(and(
        eq(assistantMemoryItems.workspaceId, scope.workspaceId),
        eq(assistantMemoryItems.userId, scope.userId),
        eq(assistantMemoryItems.kind, input.kind),
        eq(assistantMemoryItems.sourceEventId, input.sourceEventId),
        isNull(assistantMemoryItems.deletedAt),
      ))
      .limit(1))[0]
    : undefined);
  if (!current) throw new Error("Memory upsert returned no current row.");
  // 兜底（42 阶段 1 E）：那条原子 upsert 可能更新的正是一行已经是 global 的记忆（本次
  // 输入省略了 scope），而它的最终 applies_when 来自 `coalesce(excluded, 库里旧值)`——
  // 落库前看不到这个形状。抛错让同一事务回滚，源行、副本与 revision/history 保持原样。
  assertGlobalPreferenceWritable(current);
  if (inserted[0]) await markMemoryConflictIfSimilar(executor, scope, current.id, content);
  await fanoutAgentGlobalPreference(executor, current);
  return toContract(current);
}

/** Fanout is part of a global write: failure rolls back the same scoped transaction. */
async function fanoutAgentGlobalPreference(
  executor: ApiTransaction,
  row: { id: string; scope: string; deletedAt: Date | null },
): Promise<void> {
  if (row.scope !== "global" || row.deletedAt !== null) return;
  await executor.execute(sql`
    SELECT public.ailearn_fanout_agent_global_preference(${row.id}::uuid) AS inserted
  `);
}

/** 候选确认（用户确认后参与主动策略；确认后需要生成 embedding）。 */
export async function confirmMemory(
  executor: ApiTransaction,
  scope: MemoryScope,
  memoryItemId: string,
  now: Date = new Date(),
): Promise<MemoryItemV2 | null> {
  const rows = await executor
    .select()
    .from(assistantMemoryItems)
    .where(and(
      eq(assistantMemoryItems.id, memoryItemId),
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
      isNull(assistantMemoryItems.deletedAt),
    ))
    .limit(1);
  if (!rows[0]) return null;
  await executor.update(assistantMemoryItems)
    .set({
      candidate: false,
      userConfirmed: true,
      sourceType: rows[0].sourceType === "model_inferred" ? "confirmed" : rows[0].sourceType,
      embeddingStatus: rows[0].embeddingStatus === "none" ? "pending" : rows[0].embeddingStatus,
      updatedAt: now,
    })
    .where(eq(assistantMemoryItems.id, memoryItemId));
  const updated = await executor
    .select()
    .from(assistantMemoryItems)
    .where(eq(assistantMemoryItems.id, memoryItemId))
    .limit(1);
  // 结账那条候选交付：用户已经对它表过态了（doc 34 L42）。不接这一步，
  // 活动条里那一行会永远停在 displayed，而 acted 这个终态整库 0 行。
  await closeDeliveriesForMemoryItem(executor, scope, { memoryItemId, transition: "acted" }, now);
  return toContract(updated[0]);
}

/** soft delete（审计保留；canonical 学习事实不受影响）。 */
export async function deleteMemory(
  executor: ApiTransaction,
  scope: MemoryScope,
  memoryItemId: string,
  now: Date = new Date(),
): Promise<boolean> {
  await lockMemoryMutations(executor, scope.userId);
  // 进回收区：删除与到期时间在**同一条** UPDATE 里写下（A47 的「可恢复」那一半）。
  //
  // 为什么必须同一条（42 阶段 1 N）：账号级记忆在别的空间有一份副本，副本同步触发器
  // （0268 / 0371 的 ailearn_sync_global_companion_memory_copies）在**这条** UPDATE
  // 之后同步 `deleted_at`。以前到期时间是第二条「只按 id」的 UPDATE 写的，那一条既没有
  // owner/workspace/未删条件，也发生在同步之后——于是别的空间里的副本/源行只有
  // `deleted_at` 而 `purge_after` 恒为 NULL，而到期清理的判据要求 purge_after 非空，
  // 它就永远不会被清理。两列一起写，同一个 `now`，同步时一并带过去。
  const updated = await executor.update(assistantMemoryItems)
    .set({
      deletedAt: now,
      purgeAfter: new Date(now.getTime() + MEMORY_RECYCLE_BIN_DAYS * 24 * 60 * 60 * 1000),
      updatedAt: now,
    })
    .where(and(
      eq(assistantMemoryItems.id, memoryItemId),
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
      isNull(assistantMemoryItems.deletedAt),
    ))
    .returning({
      id: assistantMemoryItems.id,
      kind: assistantMemoryItems.kind,
      sourceEventId: assistantMemoryItems.sourceEventId,
    });
  if (updated.length > 0) {
    /**
     * 40 §7：「撤权或删除后缩略图与引文预览同样处理。」
     *
     * 这条记忆被删掉之后，发现簿里收藏了它的那些行**仍在**，于是用户会在簿子里
     * 看到一段**点不回去**的引文——而 §7 要的是能回到原内容。
     *
     * 所以这里遮蔽（`masked = true`）而不是删行：删了就看不出"这一条曾经被收藏
     * 过"，而 §7 只要求它不再显示来源引文，不要求抹掉这个事实。
     *
     * ⚠️ `maskEntriesForSource` 在此之前**没有任何调用方**——只有它自己的测试引���它，
     * 也就是说 §7 这一半一直没接。现在接上。
     */
    await maskEntriesForSource(executor, scope, { source: "memory", sourceId: memoryItemId });

    if (updated[0].sourceEventId !== null) {
      await executor.insert(assistantMemorySourceSuppressions)
        .values({
          userId: scope.userId,
          kind: updated[0].kind,
          sourceEventId: updated[0].sourceEventId,
        })
        .onConflictDoNothing();
    }
    // 删掉候选也算对它表了态：那条交付不能继续排着（`correctMemory` 走这里，一起结账）。
    await closeDeliveriesForMemoryItem(executor, scope, { memoryItemId, transition: "dismissed" }, now);
  }
  return updated.length > 0;
}

/**
 * 从回收区**恢复**一条记忆（40 §4.6.4 / A47 的「可恢复且留痕」那一半）。
 *
 * 与 `restoreMemory` 的区别必须说清楚，否则调用方一定会挑错：
 * - `restoreMemory` 恢复的是**归档**（`archived_at`），那条记忆一直活着；
 * - 这里恢复的是**删除**（`deleted_at`），也就是把一条她已经不再使用的记忆放回去。
 *
 * 走数据库函数而不是直接 UPDATE：`assistant_memory_items` 的 RLS 不给客户端
 * 改 `deleted_at` 这一列（删除走的是专用路径），撤销删除要走同一条受控通道。
 *
 * 抑制记录**不动**：§4.6.4 的规则是「用户删除后同源自动抽取不能复活」，
 * 用户自己把这条放回来不等于「以后别再从那句话里抽取」——那要由用户另外
 * 表达。想重新记住，直接用保存记忆走正常准入。
 */
export async function restoreDeletedMemory(
  executor: ApiTransaction,
  scope: MemoryScope,
  memoryItemId: string,
): Promise<boolean> {
  await lockMemoryMutations(executor, scope.userId);
  const restored = await executor.execute<{ restored: boolean }>(sql`
    SELECT public.ailearn_restore_companion_memory(
      ${memoryItemId}::uuid, ${scope.workspaceId}::uuid, ${scope.userId}::uuid
    ) AS restored
  `);
  if (restored[0]?.restored === true) {
    /**
     * 恢复记忆 ⇒ 把 `deleteMemory` 遮蔽掉的发现簿行**放回来**。
     *
     * 不做这一步的后果很具体：用户删了又撤回，发现簿里那条就**永远**不再显示——
     * 而他明明已经把它找回来了。遮蔽与恢复必须成对。
     */
    await unmaskEntriesForSource(executor, scope, { source: "memory", sourceId: memoryItemId });
  }
  return restored[0]?.restored === true;
}

/**
 * **彻底清除**一条记忆（A47 的另一半 / §4.5.7）。
 *
 * 与 `deleteMemory` 的分工：删除是**即时抑制 + 进回收区**，随时可恢复；
 * 这里是用户明确说了「彻底删掉」，所以**不等回收区窗口**，也不因为版本历史
 * 而延后（§11：「不以『正式历史不可变』拒绝适用的删除规则」）。
 *
 * 版本快照（`assistant_memory_item_revisions`）一并清掉——留着它等于把
 * 用户要求删除的正文又存了一份在历史表里，那不是删除。
 */
export async function eraseMemory(
  executor: ApiTransaction,
  scope: MemoryScope,
  memoryItemId: string,
  now: Date = new Date(),
): Promise<boolean> {
  await lockMemoryMutations(executor, scope.userId);
  const owned = await executor.select({ id: assistantMemoryItems.id })
    .from(assistantMemoryItems)
    .where(and(
      eq(assistantMemoryItems.id, memoryItemId),
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
    ))
    .limit(1);
  if (owned.length === 0) return false;

  // 先结账交付，免得留下指向一条已经不存在行的排队中气泡。
  await closeDeliveriesForMemoryItem(executor, scope, { memoryItemId, transition: "dismissed" }, now);
  await executor.execute(sql`
    DELETE FROM assistant_memory_item_revisions WHERE memory_id = ${memoryItemId}::uuid
  `);
  await executor.execute(sql`
    DELETE FROM assistant_memory_embeddings WHERE memory_id = ${memoryItemId}::uuid
  `);
  const removed = await executor.delete(assistantMemoryItems)
    .where(and(
      eq(assistantMemoryItems.id, memoryItemId),
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
    ))
    .returning({ id: assistantMemoryItems.id });
  return removed.length > 0;
}

/**
 * 回收区**到期清扫**不在 api 侧。
 *
 * 它由 worker 的 `companion-memory-maintenance` tick 直接调
 * `ailearn_purge_expired_companion_memory()`——每天一次，"有没有到期行"
 * 决定要不要动，落后一天无害。这里原来还有一个同功能的 TS 包装，零调用方：
 * 同一个 DB 函数被两个进程各包一层，读代码的人会以为有两条路径，
 * 而改了一边不会红。AGENTS.md 说没有运行时调用的旧链路直接清理。
 */

/**
 * 列出回收区（40 §4.6.4「进入**可恢复**回收区」/ §4.5.8「删除入口直接可用」）。
 *
 * ## 为什么之前没有这条
 *
 * 回收区的**恢复**接口一直是有的（`POST /companion/memory/:id/restore-deleted`），
 * 但那要求用户已经知道 id。而用户是从记忆列表里点的删除——列表里没有它了，
 * 桌面端也没有任何地方显示"你删掉的东西在这里"。结果是：系统声称条目可恢复，
 * 用户实际上摸不到那个"可恢复"。
 *
 * ## 30 天窗口不是"到期就消失"
 *
 * `purge_after` 到期只表示**用户随时可以要求彻底清除而不被版本历史挡路**；
 * 真正的物理清理由 worker 的每日维护窗口执行（api 侧不重复包一层，见下）。
 * 这一层分开的理由写在 `assistant_memory_items.purge_after` 的注释里。
 */
export async function listRecycledMemories(
  executor: ApiTransaction,
  scope: { workspaceId: string; userId: string },
): Promise<Array<{
  id: string; kind: string; content: string; deletedAt: string; purgeAfter: string; sourceEventId: string | null;
}>> {
  const rows = await executor.execute<{
    id: string; kind: string; content: string; deleted_at: string; purge_after: string; source_event_id: string | null;
  }>(sql`
    SELECT id, kind, content,
           to_char(deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deleted_at,
           to_char(COALESCE(purge_after, deleted_at + interval '30 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS purge_after,
           source_event_id
      FROM assistant_memory_items
     WHERE workspace_id = ${scope.workspaceId}
       AND user_id = ${scope.userId}
       AND deleted_at IS NOT NULL
     ORDER BY deleted_at DESC
     LIMIT 200
  `);
  const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] } | null)?.rows ?? []) as Array<{
    id: string; kind: string; content: string; deleted_at: string; purge_after: string; source_event_id: string | null;
  }>;
  return list.map((row) => ({
    id: String(row.id),
    kind: String(row.kind),
    content: String(row.content ?? "").slice(0, 200),
    deletedAt: row.deleted_at,
    purgeAfter: row.purge_after,
    sourceEventId: row.source_event_id ?? null,
  }));
}


/** 固定：高优先级、不参与衰减。 */
export async function pinMemory(
  executor: ApiTransaction,
  scope: MemoryScope,
  memoryItemId: string,
  now: Date = new Date(),
): Promise<MemoryItemV2 | null> {
  const updated = await executor.update(assistantMemoryItems)
    .set({ pinned: true, updatedAt: now })
    .where(and(
      eq(assistantMemoryItems.id, memoryItemId),
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
      isNull(assistantMemoryItems.deletedAt),
    ))
    .returning();
  return updated[0] ? toContract(updated[0]) : null;
}

/** 取消固定：恢复参与正常衰减与排序（与 pinMemory 对偶；pin 非.toggle）。 */
export async function unpinMemory(
  executor: ApiTransaction,
  scope: MemoryScope,
  memoryItemId: string,
  now: Date = new Date(),
): Promise<MemoryItemV2 | null> {
  const updated = await executor.update(assistantMemoryItems)
    .set({ pinned: false, updatedAt: now })
    .where(and(
      eq(assistantMemoryItems.id, memoryItemId),
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
      isNull(assistantMemoryItems.deletedAt),
    ))
    .returning();
  return updated[0] ? toContract(updated[0]) : null;
}

/** 归档：不参与检索，可恢复。 */
export async function archiveMemory(
  executor: ApiTransaction,
  scope: MemoryScope,
  memoryItemId: string,
  now: Date = new Date(),
): Promise<MemoryItemV2 | null> {
  const updated = await executor.update(assistantMemoryItems)
    .set({ archivedAt: now, updatedAt: now })
    .where(and(
      eq(assistantMemoryItems.id, memoryItemId),
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
      isNull(assistantMemoryItems.deletedAt),
    ))
    .returning();
  return updated[0] ? toContract(updated[0]) : null;
}

/** 恢复归档。 */
export async function restoreMemory(
  executor: ApiTransaction,
  scope: MemoryScope,
  memoryItemId: string,
  now: Date = new Date(),
): Promise<MemoryItemV2 | null> {
  const updated = await executor.update(assistantMemoryItems)
    .set({ archivedAt: null, updatedAt: now })
    .where(and(
      eq(assistantMemoryItems.id, memoryItemId),
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
      isNull(assistantMemoryItems.deletedAt),
    ))
    .returning();
  return updated[0] ? toContract(updated[0]) : null;
}

/** 忽略：写 `dismissed_at`，并把那条候选交付结账成 `dismissed`（doc 34 L42）。
 * 到活动条的下一次拉取就不再含它；`expires_at` 那道 30 天窗口只是兜底，不是这条判据。 */
export async function dismissMemory(
  executor: ApiTransaction,
  scope: MemoryScope,
  memoryItemId: string,
  now: Date = new Date(),
): Promise<MemoryItemV2 | null> {
  const updated = await executor.update(assistantMemoryItems)
    .set({ dismissedAt: now, updatedAt: now })
    .where(and(
      eq(assistantMemoryItems.id, memoryItemId),
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
      isNull(assistantMemoryItems.deletedAt),
    ))
    .returning();
  if (updated[0]) {
    await closeDeliveriesForMemoryItem(executor, scope, { memoryItemId, transition: "dismissed" }, now);
    // 反方向那一半（doc 34 L14）：worker 那条只在"新向量刚落库"时比对，
    // 而"她刚刚忽略的这条"对应的**老**候选可能早就有向量了，永远等不到那次比对。
    // 判据表达式来自共享的 semanticTwinPredicateSql，这里不重写阈值。
    await executor.execute(sql`
      UPDATE assistant_memory_items m
         SET dismissed_at = now(), updated_at = now()
        FROM assistant_memory_embeddings av
       WHERE av.memory_id = ${memoryItemId}
         AND m.workspace_id = ${scope.workspaceId}
         AND m.user_id = ${scope.userId}
         AND m.id <> ${memoryItemId}
         AND m.dismissed_at IS NULL
         AND m.deleted_at IS NULL
         AND m.embedding_status = 'ready'
         AND EXISTS (
           SELECT 1 FROM assistant_memory_embeddings mv
           WHERE mv.memory_id = m.id
             AND 1 - (mv.embedding <=> av.embedding) > ${MEMORY_SEMANTIC_SIMILARITY_THRESHOLD}
         )
    `);
  }
  return updated[0] ? toContract(updated[0]) : null;
}

/**
 * 纠正当前记忆：同一 ID 保留完整来源，触发器把旧版本原子写入只追加历史表。
 * expectedRevision 是 CAS；冲突不覆盖用户或后台刚刚提交的更新。
 */
export async function correctMemory(
  executor: ApiTransaction,
  scope: MemoryScope,
  memoryItemId: string,
  input: {
    content: string;
    expectedRevision: number;
    reason?: string;
    appliesWhen?: string | null;
    validFrom?: Date | null;
    validUntil?: Date | null;
  },
  now: Date = new Date(),
): Promise<MemoryItemV2 | null> {
  await lockMemoryMutations(executor, scope.userId);
  const existing = await getMemory(executor, scope, memoryItemId);
  if (!existing) return null;
  if (existing.revision !== input.expectedRevision) {
    throw new MemoryRevisionConflictError(existing.revision);
  }
  const content = input.content.slice(0, 200);
  const metadataChanged =
    (input.appliesWhen !== undefined && input.appliesWhen !== existing.appliesWhen)
    || (input.validFrom !== undefined && (input.validFrom?.toISOString() ?? null) !== existing.validFrom)
    || (input.validUntil !== undefined && (input.validUntil?.toISOString() ?? null) !== existing.validUntil);
  if (input.appliesWhen && input.appliesWhen.length > 200) {
    throw new RangeError("Memory applicability condition exceeds 200 characters.");
  }
  const validFrom = input.validFrom === undefined
    ? existing.validFrom ? new Date(existing.validFrom) : null
    : input.validFrom;
  const validUntil = input.validUntil === undefined
    ? existing.validUntil ? new Date(existing.validUntil) : null
    : input.validUntil;
  if (validFrom && validUntil && validUntil <= validFrom) {
    throw new RangeError("Memory validity must end after it starts.");
  }
  if (content === existing.content && !metadataChanged) return existing;
  // 账号级修订守卫（42 阶段 1 E）：修订**不动 scope**，所以 global 行改完仍是账号级的。
  // 条件按最终值判：省略即沿用旧条件（照样判），显式 null 即清空（现役语义）。
  assertGlobalPreferenceWritable({
    scope: existing.scope,
    kind: existing.kind,
    content,
    appliesWhen: input.appliesWhen === undefined ? existing.appliesWhen : input.appliesWhen,
  });
  const updated = await executor.update(assistantMemoryItems)
    .set({
      content,
      appliesWhen: input.appliesWhen === undefined ? existing.appliesWhen : input.appliesWhen,
      validFrom,
      validUntil,
      userStated: true,
      userConfirmed: true,
      candidate: false,
      sourceType: "user_stated",
      authorType: "user",
      authorId: scope.userId,
      epistemicStatus: "supported",
      embeddingStatus: "pending",
      updatedAt: now,
    })
    .where(and(
      eq(assistantMemoryItems.id, memoryItemId),
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
      eq(assistantMemoryItems.revision, input.expectedRevision),
      isNull(assistantMemoryItems.deletedAt),
    ))
    .returning();
  if (!updated[0]) {
    const current = await getMemory(executor, scope, memoryItemId);
    if (!current) return null;
    throw new MemoryRevisionConflictError(current.revision);
  }
  await markMemoryConflictIfSimilar(executor, scope, memoryItemId, content);
  await closeDeliveriesForMemoryItem(executor, scope, { memoryItemId, transition: "acted" }, now);
  return toContract(updated[0]);
}

export async function listMemories(
  executor: ApiTransaction,
  scope: MemoryScope,
  input: {
    kind?: MemoryKindV2;
    q?: string;
    focusMemoryId?: string;
    scope?: MemoryScopeV2;
    includeCandidates?: boolean;
    includeArchived?: boolean;
  } = {},
): Promise<MemoryItemV2[]> {
  const rows = await executor
    .select()
    .from(assistantMemoryItems)
    .where(and(
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
      isNull(assistantMemoryItems.deletedAt),
      input.kind ? eq(assistantMemoryItems.kind, input.kind) : undefined,
      input.scope ? eq(assistantMemoryItems.scope, input.scope) : undefined,
      input.includeArchived ? undefined : isNull(assistantMemoryItems.archivedAt),
      input.includeCandidates ? undefined : eq(assistantMemoryItems.candidate, false),
      input.q ? ilike(assistantMemoryItems.content, `%${input.q}%`) : undefined,
    ))
    .orderBy(desc(assistantMemoryItems.pinned), desc(assistantMemoryItems.updatedAt))
    .limit(MEMORY_LIST_LIMIT);
  if (input.focusMemoryId && !rows.some(row => row.id === input.focusMemoryId)) {
    const focused = await executor.select().from(assistantMemoryItems).where(and(
      eq(assistantMemoryItems.id, input.focusMemoryId),
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
      isNull(assistantMemoryItems.deletedAt),
    )).limit(1);
    if (focused[0]) return [toContract(focused[0]), ...rows.slice(0, MEMORY_LIST_LIMIT - 1).map(toContract)];
  }
  return rows.map(toContract);
}

/** Current tier occupancy. This endpoint returns counts only, never memory content. */
export async function getMemoryBudgetStatus(
  executor: ApiTransaction,
  scope: MemoryScope,
): Promise<MemoryBudgetStatusV1> {
  const rows = await executor.execute<{
    budget_tier: string;
    items: number | string;
    token_estimate: number | string;
    byte_count: number | string;
  }>(sql`
    SELECT budget_tier,
           count(*)::integer AS items,
           COALESCE(sum(GREATEST(1, CEIL(octet_length(content) / 3.0)::integer)), 0)::integer AS token_estimate,
           COALESCE(sum(octet_length(content)), 0)::bigint AS byte_count
      FROM assistant_memory_items
     WHERE workspace_id = ${scope.workspaceId}
       AND user_id = ${scope.userId}
       AND deleted_at IS NULL
       AND candidate = false
     GROUP BY budget_tier
  `);
  const usage = new Map<MemoryBudgetTier, MemoryBudgetUsageV1>();
  for (const row of rows) {
    if (row.budget_tier !== "resident" && row.budget_tier !== "active" && row.budget_tier !== "archived") continue;
    usage.set(row.budget_tier, {
      items: Number(row.items),
      tokenEstimate: Number(row.token_estimate),
      byteCount: Number(row.byte_count),
    });
  }
  const empty = (): MemoryBudgetUsageV1 => ({ items: 0, tokenEstimate: 0, byteCount: 0 });
  const resident = usage.get("resident") ?? empty();
  const archived = usage.get("archived") ?? empty();
  return {
    version: 1,
    resident: {
      used: resident,
      limits: COMPANION_MEMORY_RESIDENT_BUDGET_V1,
      available: {
        items: Math.max(0, COMPANION_MEMORY_RESIDENT_BUDGET_V1.items - resident.items),
        tokenEstimate: Math.max(0, COMPANION_MEMORY_RESIDENT_BUDGET_V1.tokenEstimate - resident.tokenEstimate),
        byteCount: Math.max(0, COMPANION_MEMORY_RESIDENT_BUDGET_V1.byteCount - resident.byteCount),
      },
    },
    active: usage.get("active") ?? empty(),
    archived: {
      used: archived,
      limits: COMPANION_MEMORY_ARCHIVED_BUDGET_V1,
      available: {
        items: Math.max(0, COMPANION_MEMORY_ARCHIVED_BUDGET_V1.items - archived.items),
        tokenEstimate: 0,
        byteCount: Math.max(0, COMPANION_MEMORY_ARCHIVED_BUDGET_V1.byteCount - archived.byteCount),
      },
    },
  };
}

/** Atomic, audited tier movement; a full resident tier returns specific downgrade candidates. */
export async function moveMemoryBudgetTier(
  executor: ApiTransaction,
  scope: MemoryScope,
  input: {
    memoryItemId: string;
    tier: MemoryBudgetTier;
    actorType: "user" | "companion" | "maintenance";
    actorId?: string | null;
  },
): Promise<MemoryTierMoveResultV1> {
  const rows = await executor.execute<{ result: MemoryTierMoveResultV1 }>(sql`
    SELECT public.ailearn_move_companion_memory_budget_tier_v1(
      ${scope.workspaceId}::uuid,
      ${scope.userId}::uuid,
      ${input.memoryItemId}::uuid,
      ${input.tier},
      ${input.actorType},
      ${input.actorId ?? null}::uuid
    ) AS result
  `);
  const result = rows[0]?.result;
  if (!result) throw new Error("Memory budget movement returned no result.");
  return result;
}

/** 一键清空：soft delete 当前用户全部记忆（审计保留，不影响学习真相）。 */
export async function clearMemories(
  executor: ApiTransaction,
  scope: MemoryScope,
  now: Date = new Date(),
): Promise<number> {
  await lockMemoryMutations(executor, scope.userId);
  await executor.execute(sql`
    INSERT INTO assistant_memory_source_suppressions (user_id, kind, source_event_id)
    SELECT DISTINCT user_id, kind, source_event_id
      FROM assistant_memory_items
     WHERE workspace_id = ${scope.workspaceId}
       AND user_id = ${scope.userId}
       AND deleted_at IS NULL
       AND source_event_id IS NOT NULL
    ON CONFLICT (user_id, kind, source_event_id) DO NOTHING
  `);
  const updated = await executor.update(assistantMemoryItems)
    .set({ deletedAt: now, updatedAt: now, purgeAfter: new Date(now.getTime() + MEMORY_RECYCLE_BIN_DAYS * 24 * 60 * 60 * 1000) })
    .where(and(
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
      isNull(assistantMemoryItems.deletedAt),
    ))
    .returning({ id: assistantMemoryItems.id });
  return updated.length;
}

/** 冲突列表：返回所有带 conflict_group 的未删除记忆。 */
export async function listMemoryConflicts(
  executor: ApiTransaction,
  scope: MemoryScope,
): Promise<MemoryItemV2[]> {
  const rows = await executor
    .select()
    .from(assistantMemoryItems)
    .where(and(
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
      isNull(assistantMemoryItems.deletedAt),
      sql`${assistantMemoryItems.conflictGroup} IS NOT NULL`,
    ))
    .orderBy(assistantMemoryItems.conflictGroup, assistantMemoryItems.updatedAt)
    .limit(MEMORY_LIST_LIMIT);
  return rows.map(toContract);
}

/** 冲突裁决：保留 keepId，soft delete removeId，并清除该冲突组标记。 */
export async function resolveMemoryConflict(
  executor: ApiTransaction,
  scope: MemoryScope,
  keepId: string,
  removeId: string,
  now: Date = new Date(),
): Promise<boolean> {
  await lockMemoryMutations(executor, scope.userId);
  const kept = await getMemory(executor, scope, keepId);
  const removed = await getMemory(executor, scope, removeId);
  if (!kept || !removed) return false;
  if (keepId === removeId || !kept.conflictGroup || kept.conflictGroup !== removed.conflictGroup) return false;
  await deleteMemory(executor, scope, removeId, now);
  const remaining = await executor.select({ id: assistantMemoryItems.id })
    .from(assistantMemoryItems)
    .where(and(
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
      eq(assistantMemoryItems.conflictGroup, kept.conflictGroup),
      isNull(assistantMemoryItems.deletedAt),
    ));
  if (remaining.length <= 1) await executor.update(assistantMemoryItems)
    .set({ conflictGroup: null, updatedAt: now })
    .where(eq(assistantMemoryItems.id, keepId));
  return true;
}

/** 单条记忆读取（不含已删除；§18 工具网关 revision CAS 用）。 */
export async function getMemory(
  executor: ApiTransaction,
  scope: MemoryScope,
  memoryItemId: string,
): Promise<MemoryItemV2 | null> {
  const rows = await executor
    .select()
    .from(assistantMemoryItems)
    .where(and(
      eq(assistantMemoryItems.id, memoryItemId),
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
      isNull(assistantMemoryItems.deletedAt),
    ))
    .limit(1);
  return rows[0] ? toContract(rows[0]) : null;
}

/** Read prior versions for the current user's memory without returning another member's history. */
export async function listMemoryRevisions(
  executor: ApiTransaction,
  scope: MemoryScope,
  memoryItemId: string,
): Promise<MemoryRevisionV1[] | null> {
  if (!await getMemory(executor, scope, memoryItemId)) return null;
  const rows = await executor
    .select()
    .from(assistantMemoryItemRevisions)
    .where(and(
      eq(assistantMemoryItemRevisions.memoryId, memoryItemId),
      eq(assistantMemoryItemRevisions.workspaceId, scope.workspaceId),
      eq(assistantMemoryItemRevisions.userId, scope.userId),
    ))
    .orderBy(desc(assistantMemoryItemRevisions.revision));
  return rows.map((row) => ({
    revision: row.revision,
    kind: row.kind as MemoryKindV2,
    content: row.content,
    sourceEventId: row.sourceEventId,
    sourceSessionId: row.sourceSessionId,
    sourceSpeaker: row.sourceSpeaker as MemorySourceSpeaker | null,
    sourceBasis: row.sourceBasis as "direct_statement" | "inferred_from_statement" | null,
    appliesWhen: row.appliesWhen,
    validFrom: row.validFrom?.toISOString() ?? null,
    validUntil: row.validUntil?.toISOString() ?? null,
    userStated: row.userStated,
    userConfirmed: row.userConfirmed,
    importance: row.importance,
    confidence: row.confidence,
    scope: row.scope as MemoryScopeV2,
    sourceType: row.sourceType as MemorySourceTypeV2,
    authorType: row.authorType as MemoryAuthorType,
    authorId: row.authorId,
    epistemicStatus: row.epistemicStatus as MemoryEpistemicStatus,
    supersededAt: row.supersededAt.toISOString(),
  }));
}

/**
 * 导出当前用户全部记忆（§13.2）。
 * 包含状态、来源、时间、关联实体；不含 embedding。
 * 含已归档记忆，不含已删除记忆。
 */
export async function exportMemories(
  executor: ApiTransaction,
  scope: MemoryScope,
): Promise<{
  version: 1;
  exportedAt: string;
  items: MemoryItemV2[];
}> {
  const rows = await executor
    .select()
    .from(assistantMemoryItems)
    .where(and(
      eq(assistantMemoryItems.workspaceId, scope.workspaceId),
      eq(assistantMemoryItems.userId, scope.userId),
      isNull(assistantMemoryItems.deletedAt),
    ))
    .orderBy(desc(assistantMemoryItems.pinned), desc(assistantMemoryItems.updatedAt))
    .limit(10000);

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    items: rows.map(toContract),
  };
}
