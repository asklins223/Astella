/**
 * **本人对建议关系**的确认／隐藏（39d W5-6 刀七；39 §11.3、§16.20、§14.4）。
 *
 * §11.3 的三句在这里各有一个数据面：
 *  - "模型推测的前置、相似或应用关系先作为**待确认建议**，不自动成为实线或影响正式掌握"
 *    —— 今天的 `relations` 是一列 jsonb，没有"待确认／已确认"的分层；这一张是那层分层的
 *    **本人那一半**（公共那一半是 W8-1 星图三层的事，不在这里）。
 *  - "用户可**纠正或隐藏**建议关系" —— `decision` 只有 `confirmed` / `dismissed` 两种，
 *    改主意走 UPDATE 而不是插第二行（读侧不必判"哪一行更新"）。
 *  - "关系修改**不伪造过去的学习事实**" —— 这张表**不许**有表现类列，判据在
 *    `personal-relation-decisions.test.ts` 的列名守卫。
 *
 * 为什么另立一张表，而不是给 `learning_objective_revisions_v2.relations` 加 `confirmedBy`：
 * 那一列是**公共材料血缘**，随修订定版。把它变成"某个人确认过"就是把个人数据烧进公共快照，
 * 正是 §11.3「不能让只读成员的确认修改公共知识结构」要禁止的。
 *
 * 隔离：RLS 按 (workspace_id, user_id)，与 0300 那张本人绑定同一支，**没有** worker 那一支。
 */
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users, workspaces } from "./identity.ts";
import { notes } from "./note.ts";

/** §11.3 要求这四类分开表达，不许压成一个"相关"。 */
export const personalRelationKindV2Values = [
  "relates_to", // 展示语义关系
  "prerequisite", // 理解时需要
  "explains", // 用于解释
  "contrasts", // 可对比
] as const;
export type PersonalRelationKindV2 = (typeof personalRelationKindV2Values)[number];

export const personalRelationDecisionsV2 = pgTable(
  "personal_relation_decisions_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    /** §11.3「首先只影响本人的学习视图」：键里必须带 user_id。 */
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** 所在篇（可空：跨篇关系首期不做，§11.3 说"首期以单篇笔记中可核对关系为主"）。 */
    noteId: uuid("note_id").references(() => notes.id, { onDelete: "cascade" }),
    /** 方向：确认 A→B 与隐藏 B→A 可以同时存在，所以两端分列而不是一对。 */
    fromObjectiveId: uuid("from_objective_id").notNull(),
    toObjectiveId: uuid("to_objective_id").notNull(),
    relation: text("relation").$type<PersonalRelationKindV2>().notNull(),
    /**
     * 只有 `confirmed` / `dismissed` 两种。**没有** `pending` 那一档：
     * 没表态就是不写这一行。写成状态会让"还没看"与"看过并保留"在读侧长得一样，
     * 而 §11.3 说的正是"待确认建议"要能与"已确认"分开。
     */
    decision: text("decision").notNull(),
    /** 确认那一刻的依据（模型给的理由 / 来源块）。dismissed 允许为空。 */
    evidence: jsonb("evidence").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * 同一个人对**同一条边、同一种关系**至多一行。改主意走 UPDATE。
     * 键里不放 decision——放了就能插两行"确认"与"隐藏"，读侧就得自己判谁新，
     * 而那正是 §11.3「用户可纠正」想避免的分叉。
     */
    edgeUnique: uniqueIndex("prd_v2_ws_user_edge_relation_idx")
      .on(t.workspaceId, t.userId, t.fromObjectiveId, t.toObjectiveId, t.relation),
    noteIdx: index("prd_v2_ws_user_note_idx")
      .on(t.workspaceId, t.userId, t.noteId)
      .where(sql`${t.noteId} IS NOT NULL`),
    relationChk: check(
      "prd_v2_relation_chk",
      sql`${t.relation} IN ('relates_to', 'prerequisite', 'explains', 'contrasts')`,
    ),
    decisionChk: check("prd_v2_decision_chk", sql`${t.decision} IN ('confirmed', 'dismissed')`),
    // 自环不是关系，是数据错误。
    noSelfLoopChk: check("prd_v2_no_self_loop_chk", sql`${t.fromObjectiveId} <> ${t.toObjectiveId}`),
  }),
);
