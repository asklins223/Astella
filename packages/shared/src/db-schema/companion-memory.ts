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
  selfDescription?: PersonaOrigin;
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
  /**
   * 她自己攒的「她是谁」（方案 50 §8.1）：真实相处里形成的自我认识——关注的角度、
   * 讲法上的偏好、还在修订的看法。与 `speakingStyle`（用户或预设给的说话方式）分工不同，
   * 跟着账号人格走不可变版本，不是第二份记忆库。
   *
   * 容量在 `PERSONA_FIELD_CAPACITY`（`pet-persona-merge.ts` 那一个纯模块）：契约、
   * 装配计量与界面都从那一处取；那是**工程容量**（进完整请求计量），不是说话篇幅。
   * 旧档案没有这一项时读作「还没有自我描述」，不回填、不制造一次成长版本。
   */
  selfDescription?: string;
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

/**
 * 一条待生效修订是**谁在什么时候提的**（方案 50 §4 新增并发风险 / §9.3）。
 *
 * `author` 只说"这一版的正文归谁"，答不出"这一版出自哪一次提议"。少了后者，
 * 同一个账号里两次互不相干的提议就会被当成同一次的两笔改动**盲目并到一起**——
 * 比如上一轮没被采用的一条说话方式，和她后来在另一个空间回顾出来的一条。
 *
 * 所以版本行上除 author 再记一对提案身份：
 *  - `assistant_tool`：一次前台 run 里的连续修改（同 `proposalId` 可以延续）；
 *  - `assistant_reflection`：一次后台反思（`proposalId` 是 reflection id）。
 * 两者不同就不合并，新提议回到**当前生效**的基线上重评，旧的那版留在历史里。
 *
 * 旧行没有这两列内容，读作「来源不明的历史提议」，不参与延续判断。
 */
export type CompanionPersonaProposalKind = "assistant_tool" | "assistant_reflection";

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
    proposalKind: text("proposal_kind").$type<CompanionPersonaProposalKind | null>(),
    proposalId: text("proposal_id"),
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

/**
 * 一次有界后台反思的输入水位与结论（方案 50 §8.3，迁移 0400）。
 *
 * 执行状态（running / lease / attempt）**不在这里**——那是现役 jobs 体系的职责。
 * 这张表只回答"这一次回顾看了哪一段、按哪一版人格看的、结论是什么、留下了哪一版待生效"，
 * 让 §12.2 要求分辨的那些结果码有处可记：无合适触发、来源不足、`no_change`、
 * 提交冲突、已暂存未采用，是四种不同的事实，不是同一句"后台维护正常"。
 */
export type CompanionReflectionDecision =
  | "queued" | "running" | "trigger_none" | "insufficient_input" | "no_change"
  | "proposed" | "committed" | "source_invalid" | "protocol_failed"
  | "commit_conflict" | "lease_lost" | "governance_denied";

export const companionReflections = pgTable(
  "companion_reflections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    jobId: uuid("job_id"),
    triggerKind: text("trigger_kind").$type<"exchange_segment">().notNull(),
    inputFromSeq: bigint("input_from_seq", { mode: "number" }).notNull(),
    inputToSeq: bigint("input_to_seq", { mode: "number" }).notNull(),
    inputFingerprint: text("input_fingerprint").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    strategyVersion: text("strategy_version").notNull(),
    baselinePersonaRevision: integer("baseline_persona_revision").notNull(),
    decision: text("decision").$type<CompanionReflectionDecision>().notNull().default("queued"),
    /** 脱敏短句；不放模型隐藏推理，也不放用户原文。 */
    decisionSummary: text("decision_summary"),
    pendingPersonaRevision: integer("pending_persona_revision"),
    resultRef: jsonb("result_ref").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    dedupeUnique: uniqueIndex("companion_reflections_dedupe_unique").on(t.userId, t.dedupeKey),
    conversationWatermarkIdx: index("companion_reflections_conversation_watermark_idx").on(
      t.conversationId, t.inputToSeq,
    ),
  }),
);

/**
 * 有类型的派生关系（0400）：`read` = 这次反思读过的依据，`produced` = 它产出的版本。
 *
 * 分成两边是因为撤回要顺着边走：原文被删 → 依赖它的经验停用 → 由该来源支持的人格修改
 * 取消 pending 或生成修订（§9.4）。混在一张表里，"读过的"和"造出来的"就分不开，
 * 递进核对只能整片撤。
 */
export const companionReflectionSources = pgTable(
  "companion_reflection_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reflectionId: uuid("reflection_id").notNull().references(
      () => companionReflections.id, { onDelete: "cascade" },
    ),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    /**
     * `read` = 这次回顾读过的全部素材；`cited` = 某条结论**点名引用**的依据；
     * `produced` = 这次产出的版本。三者必须分开：撤回一条被删掉的原话时，
     * 只有把它当作依据（cited）的那条结论该失效，仅仅"当时读过"不算依据。
     */
    relation: text("relation").$type<"read" | "cited" | "produced">().notNull(),
    sourceKind: text("source_kind").$type<
      "user_message" | "assistant_message" | "memory" | "tool_receipt" | "persona_revision" | "method"
    >().notNull(),
    sourceId: text("source_id").notNull(),
    /** 那一版来源的身份证据：记忆用 revision 号，消息用内容哈希。空串表示没有可核对的版本。 */
    sourceRevision: text("source_revision").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    edgeUnique: uniqueIndex("companion_reflection_sources_edge_unique").on(
      t.reflectionId, t.relation, t.sourceKind, t.sourceId, t.sourceRevision,
    ),
    targetIdx: index("companion_reflection_sources_target_idx").on(t.userId, t.sourceKind, t.sourceId),
  }),
);

/**
 * 反思那次模型调用的**响应检查点**（0401）。
 *
 * 与现役规则同一条：响应先落检查点，副作用后提交。少了这一格，
 * "模型答过了但 worker 在这中间断了"只能重跑一次，而重跑可能给出**另一份**结论——
 * 同一段相处留下两版人格，比多花一次钱严重得多。
 */
export const companionReflectionCheckpoints = pgTable(
  "companion_reflection_checkpoints",
  {
    jobId: uuid("job_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    taskId: text("task_id").notNull(),
    taskVersion: integer("task_version").notNull(),
    inputSnapshotHash: text("input_snapshot_hash").notNull(),
    output: jsonb("output").$type<unknown>().notNull(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    /** 这次回顾当时看到的是哪一版人格；不是那一版就不能拿旧检查点去提交。 */
    personaProfileRevision: integer("persona_profile_revision"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    keyUnique: uniqueIndex("companion_reflection_checkpoints_key_unique").on(
      t.jobId, t.taskId, t.taskVersion, t.inputSnapshotHash,
    ),
    userCreatedIdx: index("companion_reflection_checkpoints_user_created_idx").on(t.userId, t.createdAt),
  }),
);

/** Workspace-scoped relationship state only; persona expression is account-scoped above. */
export const petProfiles = pgTable(  "pet_profiles",
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
    /**
     * 方案 44 §5.2：这份摘要接续的是哪一份。
     *
     * 此前没有这一列，于是每份摘要都默认代表「全部更早历史」——实际上它只代表
     * 自己读过的那一段。沿 parent 链回溯才能知道某次调用到底覆盖到多早；只取
     * 最新一份局部摘要会把更早的覆盖索引挤掉。
     */
    parentSummaryId: uuid("parent_summary_id"),
    /** 同一来源键上的版本号；提交前用它做父版本比较（44 §5.3）。 */
    revision: integer("revision").notNull().default(1),
    /** 结构化覆盖清单：跨来源 span、未覆盖区间与原文取回入口（44 §3.3／§5.5）。 */
    coverageManifest: jsonb("coverage_manifest").$type<Record<string, unknown>>(),
    /** 压缩策略版本；策略变了旧幂等键不可复用（44 §5.3）。 */
    compactionPolicyVersion: text("compaction_policy_version"),
    /**
     * 摘要被验证时，会话的内容修订号（44 §3.3）。
     *
     * 读取侧对不上就当这份摘要失效：消息被改写或删除之后，旧摘要不该再用它那句
     * 「更早那段对话」把已经不存在的内容重新说一遍。追加消息不动修订号，所以正常
     * 追加不会让已有摘要失效。
     */
    verifiedContextRevision: bigint("verified_context_revision", { mode: "number" }),
    /**
     * 这份摘要派生出的那条记忆（方案 44 §3.3）。
     *
     * 方向原本是单向的「摘要 → 记忆」（`source_event_id`），没有反向引用，于是用户
     * 遗忘那条记忆之后摘要仍每轮注入同样的内容——遗忘被一句一句 undo 掉了。
     * 这条反向引用加上 0388 的触发器补上那一侧。
     */
    derivedMemoryId: uuid("derived_memory_id"),
    status: text("status").notNull().default("candidate"), // candidate | confirmed | rejected | stale | pending | processing
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
    parentIdx: index("conversation_summaries_parent_idx").on(
      t.workspaceId, t.userId, t.conversationId, t.parentSummaryId,
    ),
    manifestIdx: index("conversation_summaries_manifest_idx").on(
      t.workspaceId, t.userId, t.conversationId,
    ),
    derivedMemoryIdx: index("conversation_summaries_derived_memory_idx").on(t.derivedMemoryId),
    verifiedIdx: index("conversation_summaries_verified_idx").on(
      t.workspaceId, t.userId, t.conversationId, t.coverageThroughSeq,
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
