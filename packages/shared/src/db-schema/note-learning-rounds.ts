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
    /** 生成时那一版正文的哈希（D3 §5 冻结语义）。 */
    snapshotHash: text("snapshot_hash").notNull(),
    /** 生成时本轮问题的第几版；用户改写问题后必须能重新生成。 */
    drivingQuestionRevision: integer("driving_question_revision").notNull(),
    /** 内核任务/尝试的引用（回放与审计用）；确定性 provider 这一天为 NULL。 */
    kernelTaskRef: text("kernel_task_ref"),
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
  }),
);

export type NoteLearningRoundTeachingRow = typeof noteLearningRoundTeachings.$inferSelect;
export type NoteLearningRoundTeachingInsert = typeof noteLearningRoundTeachings.$inferInsert;
