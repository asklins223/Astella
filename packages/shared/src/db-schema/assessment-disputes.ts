/**
 * 学习判定的**争议与更正**数据面（39d W5-5；39 §14.2、§9.6、§16.11、§16.22、§16.25）。
 *
 * 为什么是**两张**表而不是一张带状态列的：
 *  1. 争议行是可变的（受理 → 复核 → 收尾），更正行是**只追加**的。§14.2 两句话说的
 *     是两件事："更正以新的有理由记录表达，不重写历史原回答"（更正要留痕）与
 *     "待复核时不持续放大结论"（争议有过程）。合成一张表，想保留更正历史就得让
 *     状态列可反复改写——那正是"重写历史"的形状。
 *  2. §16.25 要把「系统误判更正」与「用户补答」**分开计数**。它们在同一条争议行上
 *     只能靠一个枚举值区分，而 §16.25 的验收就是"两者不混算"；两行两表让"混算"
 *     在查询层就不可能发生。
 *
 * 与相邻两张表的关系：
 *  - 争议挂 `learning_assessments`（被质疑的那次判定）与 `learning_artifacts`
 *    （**不可变**的原答案）。§14.2 要求"争议记录关联原产物和版本"，所以这里冻结
 *    `artifact_revision` 与 `artifact_payload_hash` 两列：原答案行本身不会被改写，
 *    但争议要能说清"当时是第几版"。
 *  - "结束并暂不安排"复用 0295 的 `objective_review_holds_v2`，不另立一套
 *    （判据见 `review-authorization-rules-v2` 与 §9.1 规则表行 2）。
 *
 * 隔离：§14.4"每个人的作答……为个人数据"——RLS 按 (workspace_id, user_id)，
 * 另一位成员读不到、也不被这条记录影响。
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users, workspaces } from "./identity.ts";
import { learningArtifacts, learningAssessments } from "./learning-runs.ts";
import type {
  AssessmentDisputeKindV2,
  AssessmentDisputeStatusV2,
  AssessmentDisputeRecheckOutcomeV2,
  AssessmentCorrectionKindV2,
} from "../assessment-dispute-rules-v2.ts";

// ─── assessment_disputes_v2（争议本体，一个判定至多一份）───────────────────

export const assessmentDisputesV2 = pgTable(
  "assessment_disputes_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** 被质疑的那一次判定。 */
    assessmentId: uuid("assessment_id").notNull().references(() => learningAssessments.id, { onDelete: "cascade" }),
    /**
     * 原答案（不可变产物）。§14.2："争议记录关联原产物和版本"——所以版本是**冻结**的
     * 两列而不是 join 出来的现值：产物行日后被 supersede，争议仍要指向当时那一版。
     */
    artifactId: uuid("artifact_id").notNull().references(() => learningArtifacts.id, { onDelete: "cascade" }),
    artifactRevision: integer("artifact_revision").notNull(),
    artifactPayloadHash: text("artifact_payload_hash").notNull(),
    /** 受影响的目标（可空：那次观察没挂目标时就判不出来）。"暂不安排"按它生效。 */
    objectiveId: uuid("objective_id"),
    reviewDimension: text("review_dimension").notNull().default(""),
    kind: text("kind").$type<AssessmentDisputeKindV2>().notNull(),
    status: text("status").$type<AssessmentDisputeStatusV2>().notNull().default("open"),
    statement: text("statement").notNull(),
    /** §14.2"用户提出争议后，可补充说明"；**不重开**已落库的复核。 */
    supplement: text("supplement"),
    recheckOutcome: text("recheck_outcome").$type<AssessmentDisputeRecheckOutcomeV2>(),
    /** §14.2 要"展示维持／修正／仍无法判断的**理由**"——没有理由的结论交不出来。 */
    recheckReason: text("recheck_reason"),
    recheckReportHash: text("recheck_report_hash"),
    /**
     * §16.22「争议不形成死循环」的**数据面**闸门：一个判定至多一次重新检查。
     *
     * 判据在 `decideDisputeRecheckV2`，那一层是为了给出可念的理由；这一列是为了让
     * 绕过服务层的写路径也被数据库挡下。两处都要有：只留判据时一次重试就能多跑一轮
     * 模型，只留 CHECK 时调用方拿不到能翻成 409 的原因。
     */
    recheckCount: integer("recheck_count").notNull().default(0),
    /** 这一次更正是否已经被应用过（判据二「只许应用一次」的读数）。 */
    correctionAppliedAt: timestamp("correction_applied_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * **一个判定至多一份争议**（无条件的部分唯一）。
     *
     * §16.22 的原话是"不能反复要求用户接受同一判定"，而 §14.2 给的出口是
     * "仍有争议时可结束并将该项暂不安排"——不是"再开一次"。所以这里不用
     * `WHERE closed_at IS NULL`：带条件就意味着关掉之后还能对同一次判定再开一轮，
     * 那正是这条规则要挡的循环。要再争就换一次作答，那条路已经由
     * `assessment_corrections_v2` 的 `user_supplement` 覆盖（§16.25）。
     */
    assessmentUnique: uniqueIndex("assessment_disputes_v2_assessment_unique_idx").on(t.assessmentId),
    wsUserIdx: index("assessment_disputes_v2_ws_user_idx").on(t.workspaceId, t.userId, t.createdAt),
    objectiveIdx: index("assessment_disputes_v2_objective_idx").on(t.workspaceId, t.userId, t.objectiveId),
    kindChk: check(
      "assessment_disputes_v2_kind_chk",
      sql`${t.kind} IN ('explanation_faulty', 'item_faulty', 'misunderstood', 'misjudged')`,
    ),
    statusChk: check(
      "assessment_disputes_v2_status_chk",
      sql`${t.status} IN ('open', 'recheck_upheld', 'recheck_corrected', 'recheck_undetermined', 'closed_held')`,
    ),
    // §16.22 的硬闸：至多一次重新检查。
    recheckOnceChk: check("assessment_disputes_v2_recheck_once_chk", sql`${t.recheckCount} <= 1`),
    /**
     * 复核三态与 `recheck_count`／`recheck_outcome` 必须一致。
     *
     * 分成两条 CHECK 而不是一条，是因为它们的失败形状不同：`status='open'` 却带着
     * 结论，是"有结论没走状态"；带着结论但 `recheck_count=0`，是"复核没计数"——
     * 后者会让 §16.22 的闸门在统计上失真（读数永远是 0，看起来像"从没复核过"）。
     */
    openHasNoOutcomeChk: check(
      "assessment_disputes_v2_open_no_outcome_chk",
      sql`${t.status} <> 'open' OR (${t.recheckOutcome} IS NULL AND ${t.recheckCount} = 0)`,
    ),
    recheckedHasOutcomeChk: check(
      "assessment_disputes_v2_rechecked_has_outcome_chk",
      sql`${t.recheckCount} = 0 OR (${t.recheckOutcome} IS NOT NULL AND ${t.recheckReportHash} IS NOT NULL AND ${t.recheckReason} IS NOT NULL)`,
    ),
    outcomeChk: check(
      "assessment_disputes_v2_outcome_chk",
      sql`${t.recheckOutcome} IS NULL OR ${t.recheckOutcome} IN ('upheld', 'corrected', 'over_broad', 'undetermined')`,
    ),
    statementChk: check("assessment_disputes_v2_statement_chk", sql`length(${t.statement}) > 0`),
    revisionChk: check("assessment_disputes_v2_revision_chk", sql`${t.artifactRevision} >= 1`),
    // 「修正」这一档必须有更正行；这一列让读侧不必 join 就知道有没有更正记录。
    correctedHasOutcomeChk: check(
      "assessment_disputes_v2_corrected_has_reason_chk",
      sql`${t.status} <> 'recheck_corrected' OR ${t.recheckOutcome} = 'corrected'`,
    ),
  }),
);

// ─── assessment_corrections_v2（更正记录，只追加）──────────────────────────

export const assessmentCorrectionsV2 = pgTable(
  "assessment_corrections_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    disputeId: uuid("dispute_id").notNull().references(() => assessmentDisputesV2.id, { onDelete: "cascade" }),
    assessmentId: uuid("assessment_id").notNull().references(() => learningAssessments.id, { onDelete: "cascade" }),
    kind: text("kind").$type<AssessmentCorrectionKindV2>().notNull(),
    /** §14.2 更正必须是"有理由"的。 */
    reason: text("reason").notNull(),
    /**
     * `user_supplement` 必填（§16.25"记录补充后的表现"要指得出是哪一次表现）；
     * `system_misjudgment` 恒为 null——它依据的仍是**同一份**原回答，另挂一次作答
     * 会让"系统误判"与"用户补答"在数据上长得一样。
     */
    supplementArtifactId: uuid("supplement_artifact_id").references(() => learningArtifacts.id, {
      onDelete: "set null",
    }),
    /** 原判的逐条结果快照——**不改** `learning_assessments.rubric_results`（§14.2）。 */
    supersededRubricResults: jsonb("superseded_rubric_results").notNull().default([]),
    correctedRubricResults: jsonb("corrected_rubric_results").notNull().default([]),
    /** 这次更正有没有已经被应用过（判据二读数，附在行上便于审计）。 */
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * 一次争议至多一条更正：复核只有一次（0296 的 CHECK），结论只有一个，
     * 所以第二次更正不是"重试"而是"重复计学习"。§16.25 的"不倒算"在数据面上
     * 就是这一条——同一次更正消费两次，界面上会显示成两次表现。
     */
    disputeUnique: uniqueIndex("assessment_corrections_v2_dispute_unique_idx").on(t.disputeId),
    wsUserIdx: index("assessment_corrections_v2_ws_user_idx").on(t.workspaceId, t.userId, t.createdAt),
    kindChk: check(
      "assessment_corrections_v2_kind_chk",
      sql`${t.kind} IN ('system_misjudgment', 'user_supplement')`,
    ),
    // §16.25 两档的形状差异在数据面上钉住：补答必挂一次新作答，系统误判必不挂。
    supplementShapeChk: check(
      "assessment_corrections_v2_supplement_shape_chk",
      sql`(${t.kind} = 'user_supplement' AND ${t.supplementArtifactId} IS NOT NULL)
        OR (${t.kind} = 'system_misjudgment' AND ${t.supplementArtifactId} IS NULL)`,
    ),
    reasonChk: check("assessment_corrections_v2_reason_chk", sql`length(${t.reason}) > 0`),
  }),
);
