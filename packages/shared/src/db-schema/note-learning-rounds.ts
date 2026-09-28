/**
 * 轮次实体 `note_learning_rounds`（39d W4-5 第一刀；迁移 0282）。
 *
 * 它是 `learning_runs` 的**外层容器**（D1 §0）：承载本轮问题、计划与修订（共用
 * `revision` 一个计数器）、可恢复暂停、终态原因，以及跨轮聚合的归属点。
 * 单题那台机器（锁答／暴露／评估／提交／唯一调度写入）的语义一字未改，也不在这里
 * 长出第二套 phase——这里的 `phase` 只有三档（§3.3），刻度刻意粗。
 *
 * 两条读代码时最容易踩的空格：
 *  - **没有 `planRevision` 那一列**：D1 §6.3 要求状态与计划修订共用一个 `revision`，
 *    两份计数器迟早分叉；计划本体是追加式修订（D3 §5），落在自己的表上，不在这里。
 *  - **没有任何聚合字段**（§6.7）：亮度/掌握度/未解决缺口都是投影，从轮次与观察现算。
 *
 * 内容快照**不内联**（§6.4）：`noteVersionId` + `sourceContentHash` + `evidenceSnapshotIds`
 * 是按 D3 §0 实测到的既有锚点接的三件，缺一件就会在某一类变化上失明。
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const noteLearningRounds = pgTable(
  "note_learning_rounds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    noteId: uuid("note_id").notNull(),
    /** D1 §3.3 三值。`closed` 是终态且必带 `outcome`（下面的双向 CHECK）。 */
    phase: text("phase").notNull().default("active"),
    outcome: text("outcome"),
    /**
     * 本轮问题（§3.3）。`source` 三档是"可改写"这条产品要求的落点：
     * 系统建议的／用户改过的／用户自己写的——压成布尔位就分不出后两者。
     */
    drivingQuestion: text("driving_question").notNull(),
    drivingQuestionSource: text("driving_question_source").notNull(),
    drivingQuestionRevision: integer("driving_question_revision").notNull().default(1),
    // 快照引用三件（D3 §2 不允许只存版本 id：版本指针会跟着"当前"走，哈希才不会）。
    noteVersionId: uuid("note_version_id").notNull(),
    sourceContentHash: text("source_content_hash").notNull(),
    evidenceSnapshotIds: uuid("evidence_snapshot_ids").array().notNull().default(sql`'{}'`),
    /**
     * 三项预算（D1 §3.2「缺一不可」）**没有 DEFAULT**：§18.4 把起点值列为试用前冻结项，
     * 这里不替它编数。后果是每一条 INSERT 都必须显式带三份预算——这正是想要的形状。
     */
    maxModelCalls: integer("max_model_calls").notNull(),
    maxWallClockSeconds: integer("max_wall_clock_seconds").notNull(),
    maxTasks: integer("max_tasks").notNull(),
    /** 状态与计划修订共用的那一个计数器；所有写动作走 CAS，DB 侧再挡一次倒退。 */
    revision: integer("revision").notNull().default(1),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    resumedAt: timestamp("resumed_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /** D1 §6.1：同 (workspace, user, note) 至多一条未完成轮次，由部分唯一索引表达。 */
    openUnique: uniqueIndex("nlr_ws_user_note_open_unique")
      .on(t.workspaceId, t.userId, t.noteId)
      .where(sql`${t.phase} IN ('active','paused')`),
    historyIdx: index("nlr_ws_user_note_created_idx")
      .on(t.workspaceId, t.userId, t.noteId, sql`${t.createdAt} DESC`),
    phaseCheck: check("nlr_phase_chk", sql`${t.phase} IN ('active','paused','closed')`),
    outcomeCheck: check(
      "nlr_outcome_chk",
      sql`${t.outcome} IS NULL OR ${t.outcome} IN ('completed','partial','superseded','system_failure')`,
    ),
    closedOutcomeCheck: check(
      "nlr_closed_needs_outcome_chk",
      sql`(${t.phase} = 'closed') = (${t.outcome} IS NOT NULL)`,
    ),
    closedAtCheck: check(
      "nlr_closed_needs_closed_at_chk",
      sql`(${t.phase} = 'closed') = (${t.closedAt} IS NOT NULL)`,
    ),
    questionSourceCheck: check(
      "nlr_question_source_chk",
      sql`${t.drivingQuestionSource} IN ('suggested','user_rewritten','user_authored')`,
    ),
    revisionCheck: check("nlr_revision_chk", sql`${t.revision} >= 1`),
  }),
);

export type NoteLearningRoundRow = typeof noteLearningRounds.$inferSelect;
export type NoteLearningRoundInsert = typeof noteLearningRounds.$inferInsert;

/**
 * 轮次计划的追加式修订 `note_learning_round_plan_revisions`（39d W4-5 第三刀；
 * 迁移 0283）。D3 §5：「每次调整记一条：理由、时间、变更前后，不是覆盖写」。
 *
 * 每一版计划记 `plan`（roundPlanV1 合同）+ `reason`（1..500 字必填）+ `created_at`；
 * 「变更前后」的前一版就是按 `planOrdinal` 读序的上一行。`roundRevision` 记写入时
 * 轮次那个共用计数器的值（D1 §6.3：计划修订随写随推进 revision）——pause/resume
 * 不产生计划行，所以这一列在这张表里不连续，状态变化与计划变化因此可区分。
 *
 * 只追加：DB 层触发器挡 UPDATE/DELETE（`app.allow_history_mutation` 绕行口子沿用
 * 0180/0282 形状），权限层对 `ailearn_api` 只授 SELECT/INSERT。
 */
export const noteLearningRoundPlanRevisions = pgTable(
  "note_learning_round_plan_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    roundId: uuid("round_id").notNull(),
    /** 第几版计划（1 起，轮内单调）。 */
    planOrdinal: integer("plan_ordinal").notNull(),
    /** 写入时轮次的共享 revision（状态与计划共用那一个，D1 §6.3）。 */
    roundRevision: integer("round_revision").notNull(),
    /** 计划本体：roundPlanV1 合同形状（jsonb，服务层写入前过 schema）。 */
    plan: jsonb("plan").notNull(),
    /** 为什么改（D3 §5：没有理由的计划修订不落库）。 */
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ordinalUnique: uniqueIndex("nlpr_round_ordinal_unique").on(t.roundId, t.planOrdinal),
    ordinalCheck: check("nlpr_ordinal_chk", sql`${t.planOrdinal} >= 1`),
    roundRevisionCheck: check("nlpr_round_revision_chk", sql`${t.roundRevision} >= 1`),
    reasonLenCheck: check("nlpr_reason_len_chk", sql`char_length(${t.reason}) BETWEEN 1 AND 500`),
    planJsonCheck: check("nlpr_plan_json_chk", sql`jsonb_typeof(${t.plan}) = 'object'`),
  }),
);

export type NoteLearningRoundPlanRevisionRow = typeof noteLearningRoundPlanRevisions.$inferSelect;
export type NoteLearningRoundPlanRevisionInsert = typeof noteLearningRoundPlanRevisions.$inferInsert;

/**
 * 轮次里的教学产物 `note_learning_round_teachings`（39d W4-6 刀一；迁移 0284）。
 *
 * 一轮的教学历史按 `ordinal` 读序；`content` 是结构化正文（explanation＋可选 example），
 * `sourceBlockOrdinals` 是依据在快照里的定位（要能点开定位到那一块）。
 * `snapshotHash` 与 `drivingQuestionRevision` 是**生成时刻**的凭据：哈希或问题版本变了
 * 就不复用旧产物（D3 §5），服务层的"同快照同问题直接回既有那条"读的就是这两列。
 * `kernelTaskRef` 可以为 NULL：确定性 provider 这一天不走内核任务，空值是真的"没有"。
 *
 * 只追加（0284 触发器挡 UPDATE/DELETE），不存"好不好／掌握度"（§6.7 同禁）。
 *
 * `artifactId` 指回这一条自己的那份动态产物（0285 的 `note_learning_round_artifacts`）：
 * **可空——没有动态版本就是 NULL**（D4 §6.2："动态失败不冒充教学失败"，文字解释照旧
 * 在 `content` 里）。注意这条列是 0285 用 `ALTER TABLE` 加的，而 0284 那条只追加触发器
 * 只拦行级 UPDATE/DELETE（DDL 不产生行事件），所以"不可变表加列"这件事本身不冲突。
 */
export const noteLearningRoundTeachings = pgTable(
  "note_learning_round_teachings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    roundId: uuid("round_id").notNull(),
    /** 这一轮的第几条教学产物（1 起，轮内唯一）。 */
    ordinal: integer("ordinal").notNull(),
    /** 今天只有 `explanation` 一档（按知识形态选的表达方式是后续刀）。 */
    kind: text("kind").notNull(),
    /** `roundTeachingContentV1` 形状（jsonb，服务层写入前过 schema）。 */
    content: jsonb("content").notNull(),
    /** 依据块在快照里的序号（要能点开定位，而不是只给一句"根据笔记"）。 */
    sourceBlockOrdinals: integer("source_block_ordinals").array().notNull().default(sql`'{}'`),
    /** Explicitly selected private notes frozen for this teaching; never part of public note evidence. */
    personalSourceSnapshots: jsonb("personal_source_snapshots").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    /** 生成时那一版正文的哈希（D3 §5 冻结语义）。 */
    snapshotHash: text("snapshot_hash").notNull(),
    /** 生成时本轮问题的第几版；用户改写问题后必须能重新生成。 */
    drivingQuestionRevision: integer("driving_question_revision").notNull(),
    /** 内核任务/尝试的引用（回放与审计用）；确定性 provider 这一天为 NULL。 */
    kernelTaskRef: text("kernel_task_ref"),
    /** 动态版本（0285）；NULL = 这一条只有文字形态。 */
    artifactId: uuid("artifact_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ordinalUnique: uniqueIndex("nlrt_round_ordinal_unique").on(t.roundId, t.ordinal),
    ordinalCheck: check("nlrt_ordinal_chk", sql`${t.ordinal} >= 1`),
    kindCheck: check("nlrt_kind_chk", sql`${t.kind} IN ('explanation')`),
    contentJsonCheck: check("nlrt_content_json_chk", sql`jsonb_typeof(${t.content}) = 'object'`),
    snapshotHashCheck: check(
      "nlrt_snapshot_hash_chk",
      sql`char_length(${t.snapshotHash}) BETWEEN 8 AND 128`,
    ),
    drivingQuestionRevisionCheck: check("nlrt_dq_revision_chk", sql`${t.drivingQuestionRevision} >= 1`),
    sourceBlocksLenCheck: check(
      "nlrt_source_blocks_len_chk",
      sql`coalesce(array_length(${t.sourceBlockOrdinals}, 1), 0) <= 200`,
    ),
    personalSourcesCheck: check("nlrt_personal_sources_chk", sql`jsonb_typeof(${t.personalSourceSnapshots}) = 'array' AND jsonb_array_length(${t.personalSourceSnapshots}) <= 3`),
  }),
);

export type NoteLearningRoundTeachingRow = typeof noteLearningRoundTeachings.$inferSelect;
export type NoteLearningRoundTeachingInsert = typeof noteLearningRoundTeachings.$inferInsert;

/**
 * 轮次的动态产物 `note_learning_round_artifacts`（39d W4-6 刀五；迁移 0285）。
 *
 * 为什么单独一张表而不是把 HTML 塞进教学产物行：**解释文本**与**整份动态 HTML** 是
 * 两份寿命不同的东西——前者是"这一条讲了什么"（结构与依据都挂在那边），后者是
 * D4 §8 隔离展示面的输入，桌面主进程按 id 取**整份**（不套 JSON 信封）落盘，frame
 * 再从既定协议读。`round_id` 上刻意**没有唯一索引**：同一轮将来可以有多份动态版本
 * （换解释、换表达方式），唯一性不在这里表达。
 *
 * 三条 CHECK 与 0285 同宽，其中最容易踩的一条是 `html` 的**字符**长度上界
 * （524288，与 D4 §8 的 512 KiB 同宽；口径是字符而不是字节）——超配额是"整份拒绝"，
 * 任何半份 HTML 在 frame 里只会画成怪东西，所以服务层的失败策略是"不写这一行"，
 * 而不是截断一段塞进来。`snapshot_hash` 与 0284 同宽（8..128），理由与那边一样：
 * 今天 `note_versions.content_hash` 的主形状是 32 位 md5。
 *
 * 只追加（0285 触发器挡 UPDATE/DELETE，`app.allow_history_mutation` 绕行口子）。
 */
export const noteLearningRoundArtifacts = pgTable(
  "note_learning_round_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    roundId: uuid("round_id").notNull(),
    /** 今天只有 `dynamic_explanation` 一档（与教学产物表的 `kind` 分开记）。 */
    kind: text("kind").notNull(),
    /** 整份自包含 HTML 内容（放进桌面模板的那一份，不是整份文档）。 */
    html: text("html").notNull(),
    /** 生成时那一版正文的哈希（D3 §5 冻结语义）。 */
    snapshotHash: text("snapshot_hash").notNull(),
    /**
     * 实际使用的生成器版本（迁移 0304；§6.3「保存实际使用版本」）。
     *
     * 画面上那行 `data-generator-ref` 写的是同一个值，但 HTML 事后没法按生成器分组统计，
     * 所以库里留一份。默认空串：存量行的生成器版本**无从得知**，不编。
     */
    generatorRef: text("generator_ref").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /** 按轮次读这一轮的产物（重放与审计）；「按 id 取整份」走主键。 */
    roundCreatedIdx: index("nlra_round_created_idx").on(t.roundId, t.createdAt),
    kindCheck: check("nlra_kind_chk", sql`${t.kind} IN ('dynamic_explanation')`),
    htmlLenCheck: check("nlra_html_len_chk", sql`char_length(${t.html}) BETWEEN 1 AND 524288`),
    snapshotHashCheck: check("nlra_snapshot_hash_chk", sql`char_length(${t.snapshotHash}) BETWEEN 8 AND 128`),
  }),
);

export type NoteLearningRoundArtifactRow = typeof noteLearningRoundArtifacts.$inferSelect;
export type NoteLearningRoundArtifactInsert = typeof noteLearningRoundArtifacts.$inferInsert;

/**
 * 轮次动态产物的**失败**留痕（迁移 0298；39d W4-6 刀五·失败侧；§16.4 验收第一句）。
 *
 * 与上面那张**不是一张表的两个状态位**，理由三条（迁移头注有完整版）：
 *  1. 失败今天只进 `req.log.error`，日志不是学习事实——重启就没了，历史页与试用分析读不到；
 *  2. `note_learning_round_teachings.artifact_id` 留空是一个**状态**（"没有动态版本"，
 *     D4 §6.2 动态失败不冒充教学失败），而本表记的是**事件**：先失败一次、重试成功，
 *     那一次失败仍要在——状态位只能留最后一次，重试成功会把原因抹掉。
 *  3. 所以 `stage × reason` 用**一条 CHECK 穷举组合**，不是两列各自 IN：两列各自合法
 *     而组合不存在（`persist` + `over_quota`）是那种只有一条用例撞得上、事后查不到
 *     成因的形状。
 *
 * `teachingId` **可空**：产物在教学行落库**之前**构建，构建失败时那一行还不存在。
 * 留空而不是猜一个；读侧据此知道"这是一次没能归到具体讲解的失败"。
 *
 * 不建唯一索引：用户可重试（§6.2），每次失败都是一件独立的事，折叠成一行就抹掉了次数。
 */
export const noteLearningRoundArtifactFailures = pgTable(
  "note_learning_round_artifact_failures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    roundId: uuid("round_id").notNull(),
    teachingId: uuid("teaching_id").references(() => noteLearningRoundTeachings.id, { onDelete: "cascade" }),
    stage: text("stage").notNull(), // build | generate | persist
    reason: text("reason").notNull(), // empty | over_quota | model_failed | contract_rejected | persist_failed
    detail: text("detail").notNull().default(""),
    snapshotHash: text("snapshot_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    roundCreatedIdx: index("nlraf_round_created_idx").on(t.workspaceId, t.userId, t.roundId, t.createdAt),
    teachingIdx: index("nlraf_teaching_idx").on(t.teachingId),
    detailLenCheck: check("nlraf_detail_chk", sql`char_length(${t.detail}) <= 500`),
    snapshotHashCheck: check("nlraf_snapshot_hash_chk", sql`char_length(${t.snapshotHash}) BETWEEN 8 AND 128`),
    // 与迁移 0298 建立、0304 拓宽之后的同名 CHECK 同一份规则。
    stageReasonCheck: check("nlraf_stage_reason_chk", sql`(
      (${t.stage} = 'build' AND ${t.reason} IN ('empty', 'over_quota'))
      OR (${t.stage} = 'generate' AND ${t.reason} IN ('model_failed', 'contract_rejected'))
      OR (${t.stage} = 'persist' AND ${t.reason} = 'persist_failed')
    )`),
  }),
);

export type NoteLearningRoundArtifactFailureRow = typeof noteLearningRoundArtifactFailures.$inferSelect;
export type NoteLearningRoundArtifactFailureInsert = typeof noteLearningRoundArtifactFailures.$inferInsert;
