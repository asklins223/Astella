/**
 * 伴星记忆表（长期体验方案 40 §4.5/§4.6）。
 *
 * 不复制 Learner Model：每条记忆必须有来源（事件/会话引用）、可审计字段、
 * 删除级联；canonical 学习事实保持不变（记忆删除不影响学习真相）。
 */

import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
  real,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity.ts";

/**
 * 「同一件事」的相似度判据（pg_trgm `similarity`）。
 *
 * 两处读它，且必须同一个数：
 * - api 侧写活记忆时的冲突分组（`memory-service.ts` 的 `markMemoryConflictIfSimilar`）；
 * - worker 抽取器上"用户忽略过的候选别再抽出来"那道守卫（`companion-memory-extractor.ts`）。
 * 各写一个 0.85，迟早一处收紧一处放宽，然后同一句话在一边算重复、另一边算新事。
 */
export const MEMORY_CONTENT_SIMILARITY_THRESHOLD = 0.85;

/**
 * 语义（embedding 余弦）相似度阈值——"换了一种说法的同一件事"（doc 34 L14）。
 *
 * 出处只有一次实测（2026-09-23，dev 库）：`assistant_memory_embeddings` 7 行 / 1 个用户，
 * 两两 21 对，内容逐条核看互不相关 —— cosine similarity **min 0.428 / median 0.517 / max 0.663**。
 * 0.80 明显在那条上界之上、留了一截余量。**n=21 就是 n=21**：它证明"不同的事不会靠近 0.8"，
 * 没有证明"同一件事改写后一定 > 0.8"（那要有真实改写对才量得出来）。
 * 方向是有意的：宁可漏挡（她多点一次"不是我的情况"），不可误挡
 * （误挡会把一条真新记忆永久判死，且没有任何地方能翻回来）。
 */
export const MEMORY_SEMANTIC_SIMILARITY_THRESHOLD = 0.8;

export type CompanionMemoryBudgetTier = "resident" | "active" | "archived";

/**
 * 用户级记忆写锁：删除、遗忘和抽取提交共用，避免“删除成功后并发抽取又写回来”。
 * SQL 函数中的 advisory lock key 必须与此格式保持一致。
 */
export function companionMemoryMutationLockKey(userId: string): string {
  return `companion-memory-write:${userId}`;
}

export const assistantMemoryItems = pgTable(
  "assistant_memory_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // preference | goal | learning_context | interaction_note | episodic
    content: text("content").notNull(),
    /** 来源引用（可审计）：事件 id 或会话 id。 */
    sourceEventId: text("source_event_id"),
    sourceSessionId: uuid("source_session_id"),
    /** 已核实来源片段的实际说话者与证据方式；旧记录允许为空。 */
    sourceSpeaker: text("source_speaker"),
    sourceBasis: text("source_basis"),
    /** 适用条件与有效时间窗。validFrom 为空表示沿用来源事件时间。 */
    appliesWhen: text("applies_when"),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    /** 用户显式提供的来源（如目标设定），区别于模型推断。 */
    userStated: boolean("user_stated").notNull().default(false),
    /** 独立来源记忆（无事件/会话来源）由用户明确确认。 */
    userConfirmed: boolean("user_confirmed").notNull().default(false),
    /** 候选记忆（未经确认）不参与主动策略。 */
    candidate: boolean("candidate").notNull().default(false),
    /** 记忆重要性（0-1），影响检索排序。 */
    importance: real("importance").notNull().default(0.5),
    /** 提取置信度（0-1），低于阈值不生成候选。 */
    confidence: real("confidence").notNull().default(0.5),
    /** 可见范围：global | workspace | task。 */
    scope: text("scope").notNull().default("workspace"),
    /**
     * 同一条"弱空间绑定"记忆在各空间的共同身份（0267）。
     *
     * 约定与 `ailearn_fanout_global_companion_memory` 一致：**源行认领自己的 id 作为 key**，
     * 铺出去的副本带同一个 key。0268 的两支同步触发器的条件是
     * `OLD.global_key IS NOT NULL OR NEW.global_key IS NOT NULL`，而"加入/重新加入空间时补铺"
     * 也只挑 `global_key IS NOT NULL` 的行——所以这一位为 NULL 的 global 记忆，
     * 删除/纠正/固定永不扩散，新空间也永远补不到它（doc 34 L9）。
     * 唯一索引 `(workspace_id, global_key) WHERE global_key IS NOT NULL AND deleted_at IS NULL`
     * 由 0267 建在库里。
     */
    globalKey: uuid("global_key"),
    /** 固定记忆：高优先级、不参与衰减。 */
    pinned: boolean("pinned").notNull().default(false),
    /** 上下文容量层：resident 常驻、active 按需召回、archived 不自动注入。 */
    budgetTier: text("budget_tier").notNull().default("active"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    conflictGroup: uuid("conflict_group"),
    embeddingProfileVersion: text("embedding_profile_version"),
    sourceType: text("source_type").notNull().default("model_inferred"),
    /** 气泡“忽略”时间；忽略后 30 天内不重复弹出，管理页仍可见。 */
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    /** embedding 状态：none | pending | ready | failed。 */
    embeddingStatus: text("embedding_status").notNull().default("none"),
    /** 内容/来源/认识状态每次变化递增；用于防止旧修订覆盖用户的新纠正。 */
    revision: integer("revision").notNull().default(1),
    /** 谁写下当前版本，不等同于 sourceType（来源性质）。词表见 0360。 */
    authorType: text("author_type").notNull().default("extractor"),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    /** epistemic status describes evidence, not write success. */
    epistemicStatus: text("epistemic_status").notNull().default("tentative"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /**
     * 回收区到期时间（= deleted_at + 30 天，40 §4.6.4）。
     *
     * **它不是「到期自动消失」**：到期只表示用户随时可以要求彻底清除而不再有
     * 版本历史挡路。到期清理走 `purgeExpiredRecycledMemories`。
     */
    purgeAfter: timestamp("purge_after", { withTimezone: true }),
    /**
     * 判断记录的依据事件（可多条，40 §4.5.4）。
     *
     * 事实记忆用单值的 `sourceEventId`——一条事实来自一条消息就够。
     * 判断不一样：「她觉得用户当时其实是卡在术语上」可能同时依据好几条消息。
     * 只在 `kind === 'judgment'` 时必填（迁移 0347 用 CHECK 钉住）。
     */
    sourceEventIds: text("source_event_ids").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // 内容去重：同一 (kind, content 前缀 hash) 至多一条活跃记忆。
    contentUnique: uniqueIndex("assistant_memory_items_content_unique_idx")
      .on(t.workspaceId, t.userId, t.kind, t.sourceEventId)
      .where(sql`${t.deletedAt} IS NULL AND ${t.sourceEventId} IS NOT NULL`),
    workspaceUserIdx: index("assistant_memory_items_ws_user_idx").on(
      t.workspaceId, t.userId, t.updatedAt,
    ),
    validUntilIdx: index("assistant_memory_items_valid_until_idx").on(
      t.workspaceId, t.userId, t.validUntil,
    ).where(sql`${t.validUntil} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  }),
);

/** Immutable snapshots of replaced memory versions. Current version lives on assistant_memory_items. */
/**
 * Procedural 手册（40 §4.6.10，验收 A69）。
 *
 * 「讲机制先反例后定义」这类**可复用的表达/协作经验**此前只能躺在一条普通
 * preference 里，和「我叫小伴」混在一起。差别是实质的：偏好说的是「他是什么样的人」，
 * 手册说的是「**遇到这类事先这么做**」——它有触发条件、步骤、例外和证据。
 *
 * 刻意**没有**的列：tool_scope（手册不能扩大工具范围）、schedule（不能自动启动复习）、
 * user_stated（不能假装是用户说的）。§4.6.10 那三条禁令在结构上被满足，
 * 而不是靠每个调用方自觉。
 */
export type CompanionPlaybookEpistemicStatus = "supported" | "tentative" | "disputed";
export type CompanionPlaybookAuthor = "companion" | "extractor" | "maintenance";

export const companionProceduralPlaybooks = pgTable(
  "companion_procedural_playbooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * 稳定身份：由触发条件规范化而来。
     *
     * §4.6.10 要求「稳定 ID」。同一条经验被重新整理时命中同一行、只升 `version`，
     * 而不是每次长出一份看起来不同的新条目——否则她会有五条几乎一样的"讲机制要举例"。
     */
    playbookKey: text("playbook_key").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** 触发条件。目录里只注入它，正文（步骤/例外）不注入。 */
    triggerCondition: text("trigger_condition").notNull(),
    steps: jsonb("steps").notNull().default(sql`'[]'::jsonb`),
    exceptions: jsonb("exceptions").notNull().default(sql`'[]'::jsonb`),
    /** 证据：从哪些记忆/事件归纳出来的。遗忘/修订会经触发器把它降级为 disputed。 */
    evidence: jsonb("evidence").notNull().default(sql`'[]'::jsonb`),
    version: integer("version").notNull().default(1),
    epistemicStatus: text("epistemic_status").notNull().default("tentative"),
    author: text("author").notNull().default("companion"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    keyUnique: uniqueIndex("companion_procedural_playbooks_key_unique")
      .on(t.workspaceId, t.userId, t.playbookKey),
    catalogIdx: index("companion_procedural_playbooks_catalog_idx")
      .on(t.workspaceId, t.userId, t.title),
  }),
);

export const assistantMemoryItemRevisions = pgTable(
  "assistant_memory_item_revisions",
  {
    memoryId: uuid("memory_id").notNull().references(() => assistantMemoryItems.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    kind: text("kind").notNull(),
    content: text("content").notNull(),
    sourceEventId: text("source_event_id"),
    sourceSessionId: uuid("source_session_id"),
    sourceSpeaker: text("source_speaker"),
    sourceBasis: text("source_basis"),
    appliesWhen: text("applies_when"),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    userStated: boolean("user_stated").notNull(),
    userConfirmed: boolean("user_confirmed").notNull(),
    importance: real("importance").notNull(),
    confidence: real("confidence").notNull(),
    scope: text("scope").notNull(),
    sourceType: text("source_type").notNull(),
    authorType: text("author_type").notNull(),
    authorId: uuid("author_id"),
    epistemicStatus: text("epistemic_status").notNull(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ name: "assistant_memory_item_revisions_pkey", columns: [t.memoryId, t.revision] }),
    ownerIdx: index("assistant_memory_item_revisions_owner_idx").on(t.workspaceId, t.userId, t.memoryId, t.revision),
  }),
);

/**
 * 记忆来源抑制墓碑。只保存来源 UUID 与 kind，不保存原文；用户忘记某来源后，
 * 后续自动抽取不得再次创建同一来源的同类记忆。用户级主键让抑制跨学习空间生效。
 */
export const assistantMemorySourceSuppressions = pgTable(
  "assistant_memory_source_suppressions",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    sourceEventId: text("source_event_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({
      name: "assistant_memory_source_suppressions_pkey",
      columns: [t.userId, t.kind, t.sourceEventId],
    }),
  }),
);

/** Append-only record of memory movements between prompt-capacity tiers. */
export const assistantMemoryBudgetEvents = pgTable(
  "assistant_memory_budget_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    memoryId: uuid("memory_id").notNull().references(() => assistantMemoryItems.id, { onDelete: "cascade" }),
    memoryRevision: integer("memory_revision").notNull(),
    fromTier: text("from_tier").$type<CompanionMemoryBudgetTier>().notNull(),
    toTier: text("to_tier").$type<CompanionMemoryBudgetTier>().notNull(),
    actorType: text("actor_type").$type<"user" | "companion" | "maintenance">().notNull(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    ownerIdx: index("assistant_memory_budget_events_owner_idx").on(
      t.workspaceId, t.userId, t.memoryId, t.createdAt,
    ),
  }),
);

/**
 * 语义孪生的判据表达式——**整个仓库只有这一处**把 `<=>` 与阈值拼在一起
 * （doc 34 L14；两边各自写一遍就是"同一句话两个来源"，改一处忘一处必然发生）。
 *
 * @param lhs 左边向量表达式，如 `dv.embedding`
 * @param rhs 右边向量表达式（已是 vector，或带 `::vector` 的自表达）
 */
export function semanticTwinPredicateSql(lhs: string, rhs: string): string {
  return `1 - (${lhs} <=> ${rhs}) > ${MEMORY_SEMANTIC_SIMILARITY_THRESHOLD}`;
}
