import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { reviewStatusEnum } from "./enums.ts";
import { users } from "./identity.ts";

/**
 * 复习计划（对齐产品文档 §9.5）。
 * 由 learning-run commit 驱动生成，按离散档位调度下次复习时间。
 */
export const reviewSchedules = pgTable(
  "review_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    subjectType: text("subject_type").notNull(), // card
    subjectId: uuid("subject_id").notNull(),
    status: reviewStatusEnum("status").notNull().default("pending"),
    nextReviewAt: timestamp("next_review_at", { withTimezone: true }).notNull(),
    intervalDays: integer("interval_days").notNull().default(1),
    lastReviewAt: timestamp("last_review_at", { withTimezone: true }),
    generation: integer("generation").notNull().default(0),
    policyVersion: text("policy_version"), // discrete-v2
    reasonCode: text("reason_code"),
    supersedesScheduleId: uuid("supersedes_schedule_id"),
    // 0287（D2 §3.2 第 3 条）：这条安排服务哪个观察维度；空串 = 未指定维度。
    // **不可空**是判据的一部分——可空列在唯一索引里不参与比较，那一档会整个漏掉。
    reviewDimension: text("review_dimension").notNull().default(""),
    // 方案 16 §18.1 defer_review：用户队列"展示层延后"（不改 official
    // next_review_at、不消费 schedule、不创建 successor；仅队列 UI 展示）。
    userDeferredUntil: timestamp("user_deferred_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    // CONC-10: updatedAt 记录最近一次 status 变更时间。
    // deleteNote 取消计划时设为 deletedAt，restoreDeletedNote 恢复时
    // 用 updatedAt = deletedAt 精确匹配，避免误恢复之前手动取消的计划。
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    subjectIdx: index("review_schedules_subject_idx").on(t.subjectType, t.subjectId),
    nextIdx: index("review_schedules_next_idx").on(t.nextReviewAt, t.status),
    userStatusIdx: index("review_schedules_user_status_idx").on(t.userId, t.status, t.nextReviewAt),
    workspaceStatusNextIdx: index("review_schedules_workspace_status_next_idx")
      .on(t.workspaceId, t.status, t.nextReviewAt),

    idWorkspaceUnique: uniqueIndex("review_schedules_id_workspace_unique").on(t.id, t.workspaceId),
    // 0287（39 §15.3-18 / D2 §3.2）：待处理的那一份唯一；终态行允许同一目标留多行历史，
    // 所以这是**部分**唯一索引，且键里不放 subject_type（它被 CHECK 成恒为 card，
    // 放进去只会留一条绕过唯一性的路）。
    pendingSubjectDimUnique: uniqueIndex("review_schedules_pending_subject_dim_unique")
      .on(t.workspaceId, t.userId, t.subjectId, t.reviewDimension)
      .where(sql`${t.status} = 'pending'`),
  }),
);
