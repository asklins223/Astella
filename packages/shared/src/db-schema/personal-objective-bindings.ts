/**
 * **只对本人可见**的目标绑定（39d W5-6 刀四；39 §4.2、§16.20、§14.4）。
 *
 * 39 §4.2："目标的可确认材料身份与本人的计划/观察分开。只读成员可引用已有适用目标，
 * 或建立只对本人可见的目标绑定；**不能为了获得稳定 ID 要求公共编辑权**。"
 *
 * 为什么另立一张表，而不是给 `learning_objective_origins_v2` 加一列 `user_id`：
 * 那张表是**空间共用**的（只按 workspace RLS），一个只读成员把自己的学习路线写进去，
 * 另一位成员就会看到一条他没写过的目标——那是 §4.2 明写要禁止的。给共用表加用户列
 * 等于让它同时承担"公共材料血缘"和"个人计划"两件事，而这两者的**唯一性口径本来就不同**。
 * 分开之后，"只读成员不碰公共血缘"就不必靠调用方记得传对参数来保证。
 *
 * 与相邻表的关系：
 *  - `linked_objective_id` 指向公共目标，**可空**：§4.2「后来公共卡片出现时，只在目标与
 *    修订可确认一致后关联已有个人记录」——判据不成立就留空。宁可先不链接，也不要把
 *    两条不同的目标说成同一条。判据快照存 `link_evidence`，没有它链接不可复核。
 *  - 写正文由本人走既有那条路（§10.1 已落），本表**不复制一篇隐藏笔记**。
 *
 * 隔离：RLS 按 (workspace_id, user_id)，与 0296 争议表同一支，**没有** worker 那一支——
 * 这张表的每一行都是"某个人自己的计划"，伴星没有代读它的理由。
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

export const personalObjectiveBindingsV2 = pgTable(
  "personal_objective_bindings_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    /** 本人的计划就是本人的数据：键里必须带 user_id（§14.4）。 */
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** 来源笔记。**只要求读得到，不要求是本人写的**——§4.2 那半句的数据面形状。 */
    noteId: uuid("note_id").notNull(),
    /** 计划所依据的那一版正文。换一版 = 另一条计划（新的输入，不是悄悄改掉旧的）。 */
    noteVersionId: uuid("note_version_id").notNull(),
    /** 本人写下的那句话。不进公共目标、不进制卡材料、不进公共关系。 */
    objectiveStatement: text("objective_statement").notNull(),
    knowledgeForm: text("knowledge_form").notNull().default("concept"),
    conceptLabel: text("concept_label"),
    /** 后来出现了可确认的公共目标时链接到这里（可空，见头注"不猜"那段）。 */
    linkedObjectiveId: uuid("linked_objective_id"),
    /** 链接那一刻的判据快照（指纹 + revision + 依据）；没有它链接不可复核。 */
    linkEvidence: jsonb("link_evidence").notNull().default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releaseReason: text("release_reason"),
  },
  (t) => ({
    /**
     * §4.2「只对本人可见」：同一个人对同一篇同一版**至多一条**活着的计划。
     * 部分唯一（`released_at IS NULL AND status = 'active'`），与 0295/0287 同一形状——
     * 终态行留历史，撤下是写状态不是删行。
     */
    liveUnique: uniqueIndex("pob_v2_ws_user_note_version_live_idx")
      .on(t.workspaceId, t.userId, t.noteId, t.noteVersionId)
      .where(sql`${t.releasedAt} IS NULL AND ${t.status} = 'active'`),
    createdIdx: index("pob_v2_ws_user_created_idx").on(t.workspaceId, t.userId, t.createdAt),
    statusIdx: index("pob_v2_ws_user_status_idx").on(t.workspaceId, t.userId, t.status, t.createdAt),
    formChk: check(
      "pob_v2_form_chk",
      sql`${t.knowledgeForm} IN ('comparison', 'procedure', 'boundary', 'sequence', 'fact', 'definition', 'relationship', 'causal_model', 'application_rule')`,
    ),
    statusChk: check("pob_v2_status_chk", sql`${t.status} IN ('active', 'superseded', 'released')`),
    // 链接与判据快照必须同时有或同时没有：只有 id 没有判据，链接不可复核。
    linkShapeChk: check(
      "pob_v2_link_shape_chk",
      sql`(${t.linkedObjectiveId} IS NULL AND ${t.linkEvidence} = '{}'::jsonb)
        OR (${t.linkedObjectiveId} IS NOT NULL AND ${t.linkEvidence} <> '{}'::jsonb)`,
    ),
    statementChk: check("pob_v2_statement_chk", sql`length(${t.objectiveStatement}) > 0`),
    releaseChk: check("pob_v2_release_chk", sql`${t.releasedAt} IS NULL OR ${t.releasedAt} >= ${t.createdAt}`),
  }),
);
