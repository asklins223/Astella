/**
 * 伴星记忆与空间关系数据。
 *
 * 包含：assistant_memory_embeddings / account-scoped companion persona / workspace-scoped
 * pet_profiles relationship / memory_links / conversation_summaries / memory_usage_log /
 * companion_daily_summaries。人格表按 user_id 隔离；空间关系表按 workspace_id + user_id 隔离。
 */

import {
  pgTable,
  uuid,
  bigint,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  real,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity.ts";
import { jobs } from "./job.ts";

/** pgvector 派生索引：只由 Worker 写入；Drizzle 中以 jsonb 占位 vector(1024)。 */
export const assistantMemoryEmbeddings = pgTable(
  "assistant_memory_embeddings",
  {
    memoryId: uuid("memory_id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    embedding: jsonb("embedding").$type<unknown>().notNull(),
    modelRevision: text("model_revision").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceUserIdx: index("assistant_memory_embeddings_ws_user_idx").on(
      t.workspaceId, t.userId,
    ),
  }),
);

export type PetProfileActiveness = "quiet" | "moderate" | "active";

/**
 * 人格每一项「是谁写的」。
 *
 * 换人格时只有 `preset` 写的那几项会被新预设覆盖；`user` / `assistant` 的原样留下。
 * 缺省当作 `preset`——所以没有这个键的旧档案仍然读作"整套都来自预设"，
 * 不需要回填，也不需要迁移。
 */
export type PersonaOrigin = "preset" | "user" | "assistant";

/** 边界里的四项各自记来源：口头禅是她攒的，学习提醒开关是你给的，不该混成一句。 */
export type PersonaFieldOrigin = {
  name?: PersonaOrigin;
  personalityTags?: PersonaOrigin;
  speakingStyle?: PersonaOrigin;
  examples?: PersonaOrigin;
  activeness?: PersonaOrigin;
  boundaries?: {
    allowPlayful?: PersonaOrigin;
    allowNudgeLearning?: PersonaOrigin;
    allowVoiceTags?: PersonaOrigin;
    catchphrase?: PersonaOrigin;
  };
};

/** 用户跨空间共享的人格表达内容；固定协议与授权边界不在此表。 */
export type CompanionPersonaProfileContent = {
  presetId: string | null;
  name: string;
  personalityTags: string[];
  speakingStyle: string;
  examples: { text: string }[];
  activeness: PetProfileActiveness;
  boundaries: {
    allowPlayful?: boolean;
    allowNudgeLearning?: boolean;
    allowVoiceTags?: boolean;
    catchphrase?: string | null;
  };
  fieldOrigin?: PersonaFieldOrigin;
};

/** Account-scoped current persona override. A null profile means current defaults. */
export const companionPersonaProfiles = pgTable(
  "companion_persona_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull().default(0),
    /**
     * 待生效版本（40 §4.8.4 / 40b §5.3.1，A50）。
     *
     * 它是一个**指针**，不是第二份正文：真正的内容在
     * `companion_persona_profile_versions` 的那一行里（append-only）。
     * 排队期间当前 `revision` / `profile` 一个字都不动，所以正在进行的会话
     * 不会被换人格；激活时把那一版提升为当前并清掉这个指针。
     *
     * 任何把当前版本往前推的写入（用户纠正／恢复／重置）都作废排队，
     * 但被顶掉的那一版仍在历史里、仍可恢复。
     */
    pendingRevision: integer("pending_revision"),
    profile: jsonb("profile").$type<CompanionPersonaProfileContent | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userUnique: uniqueIndex("companion_persona_profiles_user_unique").on(t.userId),
  }),
);

export type CompanionPersonaProfileVersionAuthor = "user" | "assistant_tool" | "restore" | "migration";
export type CompanionPersonaProfileVersionAction = "update" | "reset" | "restore" | "migration";

/** Immutable, owner-readable versions used by profile history and private turn replay. */
export const companionPersonaProfileVersions = pgTable(
  "companion_persona_profile_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    examplesRevision: integer("examples_revision").notNull(),
    author: text("author").$type<CompanionPersonaProfileVersionAuthor>().notNull(),
    action: text("action").$type<CompanionPersonaProfileVersionAction>().notNull(),
    reason: text("reason"),
    moduleScope: text("module_scope").array().notNull().default(sql`ARRAY['companion']::text[]`),
    sourceWorkspaceId: uuid("source_workspace_id"),
    profile: jsonb("profile").$type<CompanionPersonaProfileContent | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userRevisionUnique: uniqueIndex("companion_persona_profile_versions_user_revision_unique").on(
      t.userId, t.revision,
    ),
    userCreatedIdx: index("companion_persona_profile_versions_user_created_idx").on(
      t.userId, t.createdAt,
    ),
  }),
);

/** Workspace-scoped relationship state only; persona expression is account-scoped above. */
export const petProfiles = pgTable(
  "pet_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    familiarity: real("familiarity").notNull().default(0),
    interactionCount: integer("interaction_count").notNull().default(0),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceUserUnique: uniqueIndex("pet_profiles_workspace_user_unique").on(t.workspaceId, t.userId),
  }),
);

export const memoryLinks = pgTable(
  "memory_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memoryId: uuid("memory_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    entityType: text("entity_type").notNull(), // card | key_point | note | source | learning_run
    entityId: uuid("entity_id").notNull(),
    autoLinked: boolean("auto_linked").notNull().default(false),
    orphaned: boolean("orphaned").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniqueLink: uniqueIndex("memory_links_unique_idx").on(t.memoryId, t.entityType, t.entityId),
    entityIdx: index("memory_links_entity_idx").on(t.workspaceId, t.entityType, t.entityId),
    memoryIdx: index("memory_links_memory_idx").on(t.workspaceId, t.userId, t.memoryId),
  }),
);

export const conversationSummaries = pgTable(
  "conversation_summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull(),
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull(),
    sourceRunId: uuid("source_run_id"),
    coverageFromSeq: bigint("coverage_from_seq", { mode: "number" }),
    coverageThroughSeq: bigint("coverage_through_seq", { mode: "number" }),
    coverageSourceHash: text("coverage_source_hash"),
    status: text("status").notNull().default("candidate"), // candidate | confirmed | rejected | pending | processing
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniqueSummary: uniqueIndex("conversation_summaries_unique_idx").on(
      t.workspaceId, t.userId, t.conversationId, t.sourceRunId,
    ),
    statusIdx: index("conversation_summaries_status_idx").on(
      t.workspaceId, t.userId, t.status, t.createdAt,
    ),
  }),
);

export const memoryUsageLog = pgTable(
  "memory_usage_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    runId: uuid("run_id").notNull(),
    memoryIds: uuid("memory_ids").array().notNull(),
    retrievalMode: text("retrieval_mode").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    wsUserRunIdx: index("memory_usage_log_ws_user_run_idx").on(
      t.workspaceId, t.userId, t.runId, t.createdAt,
    ),
  }),
);

export const companionDailySummaries = pgTable(
  "companion_daily_summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    date: text("date").notNull(), // YYYY-MM-DD 用户本地日期
    timezone: text("timezone").notNull(),
    facts: jsonb("facts").$type<Record<string, unknown>>().notNull(),
    /** 日记正文的块序列（0252）；[] = 历史行，读取时从 summary 投影。 */
    blocks: jsonb("blocks").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    summary: text("summary").notNull().default(""),
    /** 选择步骤给出的**可见理由**（≤240 字）；她没选或旧行为 NULL。 */
    selectionReason: text("selection_reason"),
    /**
     * 选择步骤选中的候选 id（0353）。
     *
     * 只存理由的文字时，「正文写的是不是她选的那一段」事后无从核对——
     * 成稿那一行没有第二个字段能把正文接回选材结果。选 null 时为 NULL：
     * §5.7.5 允许她不选，两种都得如实记，NULL 不能被当成"没写"。
     */
    selectedId: text("selected_id"),
    personaProfileRevision: integer("persona_profile_revision"),
    personaExamplesRevision: integer("persona_examples_revision"),
    defaultExpressionVersion: text("default_expression_version"),
    status: text("status").notNull().default("generated"), // generated | failed
    /** status=failed 的成因；generated 行必须为 NULL（0250）。 */
    failureReason: text("failure_reason"),
    revision: integer("revision").notNull().default(1),
    /**
     * 「隐藏日记」（40 §10）：从列表与主动推荐里移除，排除后续自动引用。
     * **不删除内容，也不等于遗忘原事件**——所以恢复默认只是清这一列。
     */
    /** 这一篇由哪些真实事件成稿；撤权遮蔽按它匹配（§11.1 第 6 行）。 */
    sourceEventIds: text("source_event_ids").array(),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    /** 「删除日记」（§10/§11.1）：连派生预览与摘录一起删。墓碑由触发器守住，不可复活。 */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /** revoked_source = 撤权导致的整篇遮蔽；user_deleted = 用户主动删除。 */
    deleteReason: text("delete_reason"),
    generatedAt: timestamp("generated_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    wsUserDateUnique: uniqueIndex("companion_daily_summaries_ws_user_date_unique").on(
      t.workspaceId, t.userId, t.date,
    ),
  }),
);

/** Worker-only durable output of the diary's first (selection) step. */
export const companionDiaryGenerationCheckpoints = pgTable(
  "companion_diary_generation_checkpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    taskId: text("task_id").notNull(),
    taskVersion: integer("task_version").notNull(),
    inputSnapshotHash: text("input_snapshot_hash").notNull(),
    output: jsonb("output").$type<Record<string, unknown>>().notNull(),
    personaProfileRevision: integer("persona_profile_revision"),
    personaExamplesRevision: integer("persona_examples_revision"),
    defaultExpressionVersion: text("default_expression_version"),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    jobTaskSnapshotUnique: uniqueIndex("companion_diary_checkpoint_job_task_snapshot_unique")
      .on(t.jobId, t.taskId, t.taskVersion, t.inputSnapshotHash),
    workspaceUserIdx: index("companion_diary_checkpoint_ws_user_idx").on(t.workspaceId, t.userId, t.createdAt),
  }),
);

/**
 * 40 §7 发现簿（本人收藏的视图）。
 *
 * 与本文件其余表的差别有两条，都不是风格问题：
 *
 *  - **没有 deleted_at**。取消收藏是 `visible=false`（§7「取消收藏不删除原始
 *    回答或日记」）。加一列 deleted_at 就会有人开始用它，于是"取消收藏"和
 *    "删除"在实现上分不开，而那个错在界面上完全看不出来。
 *  - **有 masked**。来源撤权或删除之后遮蔽，而不是删行——删掉就看不出
 *    「这里曾经有过」（§7「撤权或删除后缩略图、引文和预览同样处理」）。
 */
export const companionDiscoveryEntries = pgTable(
  "companion_discovery_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    /** 簿子归属人。永远是用户本人（§7「本人收藏的视图」）。 */
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    source: text("source").notNull(),
    /** 与 kind + source 一起构成**共用收藏身份**（0358 的唯一索引）。 */
    sourceId: text("source_id").notNull(),
    author: text("author").notNull(),
    /** 当时留下的那一段。原文后来改了它不动。 */
    body: text("body").notNull(),
    /** 用户自己的批注；编辑它不改写原文。 */
    annotation: text("annotation"),
    /** 默认 private —— §7「私人内容默认不跨空间、跨成员展示」。 */
    visibility: text("visibility").notNull().default("private"),
    visible: boolean("visible").notNull().default(true),
    masked: boolean("masked").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // 共用身份：同一份内容在笔记旁与发现簿里指向**同一行**，所以编辑批注与
    // 取消收藏在两处同步。必须带 workspace_id：身份只在**本空间内**唯一。
    identityKey: uniqueIndex("companion_discovery_entries_identity_key")
      .on(t.workspaceId, t.userId, t.kind, t.source, t.sourceId),
    // 簿子页按时间倒序，且它按定义就很短。
    recentIdx: index("companion_discovery_entries_recent_idx")
      .on(t.workspaceId, t.userId, t.visible, t.createdAt),
  }),
);
