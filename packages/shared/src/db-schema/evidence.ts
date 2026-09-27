import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { reviewStatusEnum } from "./enums.ts";
import { users, workspaces } from "./identity.ts";
import { notes } from "./note.ts";

/**
 * `review_schedules` 那一列 `reminder_kind` 的取值（迁移 0297；39 §9.1 末段）。
 *
 * **两处字面量、一处判据**：`$type` 用的这个联合与迁移里的 CHECK 各写了一份，而
 * `review-reminder-kind-guard.test.ts` 逐字比对这两份并在两个方向都变异自证。
 * 抄第二份省事，少一个判据就等于"改了 schema 忘了改迁移"这种红灯永远不亮。
 */
export const ReviewReminderKindValues = ["one_time", "sustained"] as const;
export type ReviewReminderKind = (typeof ReviewReminderKindValues)[number];

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
    // 0297（W5-4 刀一；39 §9.1 末段）：这一条是「仅提醒这一次」还是「持续安排复习」。
    // 两种来意共用同一把唯一键（同一目标同一维度只挂一条待处理），差别只有"处理掉之后
    // 会不会自己长出下一次"——所以它是一列而不是另一张表，理由见迁移头注。
    // **不可空且默认 sustained**：存量三个写入方里有两个按定义是持续的，而把存量判成
    // one_time 会让那些行在处理后静默不再排下一次，且没有任何人授权过这件事。
    reminderKind: text("reminder_kind").$type<ReviewReminderKind>().notNull().default("sustained"),
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

/**
 * 目标级「暂不安排」（迁移 0295；39 §9.1 规则表第三行）。
 *
 * 一条**未解除**的行 = 本人在该笔记内对该目标的持续回访被排除，优先于笔记与卡片授权，
 * 不停止其他目标。解除写 `released_at` 而不是删行——§9.1 明写"不删除历史"，而重新
 * 暂不安排一次要能再 INSERT，所以唯一性只能是**部分**唯一（同 0287 那一支的形状）。
 *
 * 放在 reviewSchedules 旁边：两张表由同一个调度边界读写
 * （`apps/api/src/modules/review/review-schedule-boundary.ts`），调用方已经在从这个
 * 子路径深导入，不需要新出口。
 */
export const objectiveReviewHoldsV2 = pgTable(
  "objective_review_holds_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    noteId: uuid("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
    // **不设外键**：存的是"可确认的目标 id"，与 reviewSchedules.subjectId 同形。钉在
    // learning_objectives_v2 上会让目标被合并／退役时顺手删掉她那条没解除的排除。
    objectiveId: uuid("objective_id").notNull(),
    reasonCode: text("reason_code").notNull().default("user_deferred_objective"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // **是不是 NULL 就是活/历史的分界**：两条部分索引与那条部分唯一索引都以它为准。
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releaseReason: text("release_reason"),
  },
  (t) => ({
    // 一个（空间, 人, 笔记, 目标）只能有一份活着的 hold；解除后的行留作历史。
    liveUnique: uniqueIndex("orh_v2_ws_user_note_obj_live_idx")
      .on(t.workspaceId, t.userId, t.noteId, t.objectiveId)
      .where(sql`${t.releasedAt} IS NULL`),
    // 调度边界每次授权前问的那一发（不带 note_id），同样只查未解除的。
    liveLookupIdx: index("orh_v2_ws_user_obj_live_idx")
      .on(t.workspaceId, t.userId, t.objectiveId)
      .where(sql`${t.releasedAt} IS NULL`),
    releaseCheck: check(
      "orh_v2_release_chk",
      sql`${t.releasedAt} IS NULL OR ${t.releasedAt} >= ${t.createdAt}`,
    ),
    // 空串会把"用户没给理由"与"系统没记理由"混成同一种读数。
    reasonCheck: check("orh_v2_reason_chk", sql`${t.reasonCode} <> ''`),
  }),
);

/**
 * 持续回访授权的**来源记法**（39 §9.1 第一段与第三段；39d W7-3 刀五）。
 *
 * §9.1 明写两句话，今天它们都没有落点：
 *  - 「笔记的『安排以后复习』…卡片的『开启复习』…**两种意图可以分别存在**」；
 *  - 「一个目标可能同时被笔记与卡片授权覆盖。**内部维护授权来源**，避免重复建立
 *    相同目标、相同回访目的的待办；取消一项授权不误删另一项」。
 *
 * 在这张表之前，`ReviewAuthorizationSourceV2`（`note_subscription` / `card_review`）
 * 只活在 `@ailearn/shared/review-authorization-rules-v2` 的类型里：**没有任何地方
 * 写它、也没有任何地方读它**，于是「暂停笔记复习时说明已单独开启的卡片是否继续」
 * 这句话没有可查的来源，"分别开停"也没有那颗开关能拨。
 *
 * **主体分两种**（`subjectType`），这不是把两个东西硬塞进一张表：
 *  - `note` → 笔记订阅。§9.1「笔记订阅覆盖此后在这篇笔记中实际学过、或经本人声明／
 *    首次回忆确认需要维护的核心目标」——它是**整篇**的持续授权，不是逐目标的。
 *  - `objective` → 卡片订阅。「卡片的『开启复习』表示维护具体提取目标」，主体就是
 *    那个目标（与 `review_schedules.subject_id` 同形，不设外键：目标被合并或退役
 *    时不该顺手删掉她的授权记录，那会变成"悄悄取消订阅"）。
 *
 * **暂停保留行，不删**（`status='paused'` + `paused_at`）：§9.1「暂停只停该来源」
 * 说的是停，不是撤销授权。留着行，屏上那颗开关才在"关"的位置上，下次恢复也不必
 * 重新问一遍"你当时授权的范围是哪些目标"。唯一性同样只作用在**活着的那一份**上
 * （部分唯一索引），与 0287／0295 同一套形状。
 *
 * 提醒与排除都**不在**这张表里：一次性提醒是 `reminder_kind='one_time'` 的那条排程，
 * 目标排除是 `objective_review_holds_v2`。三件事各有一张表，是为了让"取消一项授权
 * 不误删另一项"这句话在结构上成立——它们本来就不该互相覆盖。
 */
export const reviewSubscriptionsV2 = pgTable(
  "review_subscriptions_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** 见 `ReviewAuthorizationSourceV2`；词表在那份规则模块里，这里只存它交出来的值。 */
    source: text("source").notNull(),
    /** `note` = 笔记订阅（整篇）；`objective` = 卡片订阅（那个目标）。 */
    subjectType: text("subject_type").notNull(),
    /** `note` 档是笔记 id，`objective` 档是目标 id。**不设外键**，理由见头注。 */
    subjectId: uuid("subject_id").notNull(),
    status: text("status").notNull().default("active"),
    /** §9.1 第一句那句话要能被屏上念出来，所以范围是**必填**，不是省略。 */
    scopeNote: text("scope_note").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    pauseReason: text("pause_reason"),
  },
  (t) => ({
    // 一个（空间, 人, 来源, 主体）只能有一份**活着**的授权。暂停留行 ⇒ 恢复是
    // 改 status 而不是插第二条，于是"她什么时候授权的"这件事不会因为暂停而丢。
    liveUnique: uniqueIndex("rs_v2_ws_user_source_subject_live_idx")
      .on(t.workspaceId, t.userId, t.source, t.subjectType, t.subjectId)
      .where(sql`${t.status} = 'active'`),
    // 「这条安排还由谁撑着」那一发：调度边界每次问「覆盖我的来源有哪些」都走它。
    liveLookupIdx: index("rs_v2_ws_user_subject_live_idx")
      .on(t.workspaceId, t.userId, t.subjectType, t.subjectId)
      .where(sql`${t.status} = 'active'`),
    // 暂停的时间不能早于授权：反过来那一份读出来会读成"我暂停过一句还没说过的话"。
    pausedCheck: check(
      "rs_v2_paused_chk",
      sql`(${t.status} = 'active' AND ${t.pausedAt} IS NULL) OR (${t.status} = 'paused' AND ${t.pausedAt} IS NOT NULL)`,
    ),
    scopeCheck: check("rs_v2_scope_chk", sql`${t.scopeNote} <> ''`),
  }),
);
