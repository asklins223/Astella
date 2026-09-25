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
