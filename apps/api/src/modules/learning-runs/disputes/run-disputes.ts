/**
 * 学习判定的**争议与更正**写入侧（39d W5-5；39 §14.2、§9.6、§16.11、§16.22、§16.25）。
 *
 * 这一份只回答"现在要写什么"，**不判规则**：为什么只能复核一次、争议期间该怎么处置
 * 那次观察、两种更正差在哪、结束要不要落排除——那些在
 * `@astella/shared/assessment-dispute-rules-v2`。理由与 `objective-review-holds.ts`
 * 同一条：执法点要少，判据要能被逐条单测；规则写在服务里就只能在起库的集成测试里验。
 *
 * 四条业务约束在这里被真正执行（不是"已设计"）：
 *  1. **§14.2 关联原产物和版本**：`openAssessmentDisputeV2` 从 assessment 读出它评的
 *     那一件产物，把 `artifact_revision`／`artifact_payload_hash` **冻结**进争议行。
 *     §4.3"每道用于能力判断的题目在呈现前固定目标、题面、评分条件与初始证据资格"
 *     在这里是同一件事的另一半——争议指向的是当时那一版，不是"现在的"那一版。
 *  2. **§16.22 不形成死循环**：`completeDisputeRecheckV2` 先过
 *     `decideDisputeRecheckV2`，再靠 0296 的 `recheck_count <= 1` 与无条件唯一索引
 *     兜底。一次都不到第二次。
 *  3. **§16.25 不混算**：`recordAssessmentCorrectionV2` 两种 kind 写**两行两表**，
 *     都不碰 `learning_assessments.rubric_results`——原判那一行永远不被改写，
 *     所以"更正"与"补答"在读侧不可能被合并统计。
 *  4. **§9.6 争议期间的日程**：复核结论不由这里直接插排期。`corrected` 那一档交回
 *     `scheduleImpactHint`，由唯一调度边界（`review-schedule-boundary.ts`）按全部
 *     适用事实和当前授权重算一次——§9.6 原话是"需要重新计算时仍经唯一调度服务……
 *     没有调度变化也应说明原因"，就地插一条就绕过了它。
 */
import { and, eq, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  assessmentCorrectionsV2,
  assessmentDisputesV2,
  learningAssessments,
  learningArtifacts,
  learningObjectiveOriginsV2,
  learningRuns,
} from "@astella/shared/db-schema";
import {
  decideDisputedObservationV2,
  decideDisputeCloseV2,
  decideDisputeRecheckV2,
  decideSupplementArtifactRequiredV2,
  type AssessmentCorrectionKindV2,
  type AssessmentDisputeKindV2,
  type AssessmentDisputeRecheckOutcomeV2,
  type AssessmentDisputeViewV2,
} from "@astella/shared/assessment-dispute-rules-v2";
import { holdObjectiveFromReviewV2 } from "../../review/objective-review-holds.ts";
import type { ApiTransaction } from "../../../db/client.ts";

type DisputeTx = ApiTransaction;

// ─── 错误（每个都要能被路由翻成一个具体状态码，不是 500）─────────────────

/** 那次判定不存在，或不属于当前会话身份。§14.4：争议是个人数据，读别人的要 404。 */
export class AssessmentDisputeNotFoundV2 extends Error {
  constructor() {
    super("assessment_not_found");
  }
}

/** 这次判定已经有一份争议了（无条件唯一索引，0296 注释第 2 条）。 */
export class AssessmentDisputeAlreadyOpenV2 extends Error {
  constructor(readonly disputeId: string) {
    super("assessment_already_disputed");
  }
}

export class AssessmentDisputeClosedV2 extends Error {
  constructor() {
    super("dispute_closed");
  }
}

/** §16.22：这一次判定已经复核过，不能再来一轮。 */
export class AssessmentDisputeRecheckExhaustedV2 extends Error {
  constructor(readonly disputeId: string) {
    super("recheck_already_performed");
  }
}

/** §16.25：「用户补答」这一档必须指得出补充后的表现是哪一次作答。 */
export class AssessmentCorrectionShapeV2 extends Error {
  constructor() {
    super("supplement_artifact_required");
  }
}

/** 更正只许一条（0296 的 `assessment_corrections_v2_dispute_unique_idx`）。 */
export class AssessmentCorrectionAlreadyRecordedV2 extends Error {
  constructor(readonly correctionId: string) {
    super("correction_already_recorded");
  }
}

type DisputeRow = typeof assessmentDisputesV2.$inferSelect;

// ─── 读侧 ─────────────────────────────────────────────────────────────────

/**
 * 读一次判定上的争议；没有就 null。
 *
 * 调用方要的是 `decideDisputedObservationV2` 的三个入参，所以这里返回**整行**而不是
 * 已经判好的结论——判据在 shared，执法点在这里之外（结算那一发）也要能自己问一次。
 */
export async function findDisputeForAssessmentV2(
  tx: DisputeTx,
  input: { workspaceId: string; userId: string; assessmentId: string },
): Promise<DisputeRow | null> {
  const rows = await tx.select().from(assessmentDisputesV2).where(and(
    eq(assessmentDisputesV2.workspaceId, input.workspaceId),
    eq(assessmentDisputesV2.userId, input.userId),
    eq(assessmentDisputesV2.assessmentId, input.assessmentId),
  )).limit(1);
  return rows[0] ?? null;
}

/**
 * 这个目标现在有没有**未结束**的争议——判据二里"这次观察算不算数"要问的那一句。
 *
 * 按 (workspace, user, objective) 查，与 0296 的 `assessment_disputes_v2_objective_idx`
 * 同一形状。`objectiveId` 为 null 时返回 null：那一次观察没挂目标，判不出受影响目标，
 * 也就没有"按目标暂停复用"可执行——§14.2 的挂起只能挂到有确定目标的那一次。
 */
export async function liveDisputesForObjectiveV2(
  tx: DisputeTx,
  input: { workspaceId: string; userId: string; objectiveId: string | null },
): Promise<DisputeRow[]> {
  if (!input.objectiveId) return [];
  return await tx.select().from(assessmentDisputesV2).where(and(
    eq(assessmentDisputesV2.workspaceId, input.workspaceId),
    eq(assessmentDisputesV2.userId, input.userId),
    eq(assessmentDisputesV2.objectiveId, input.objectiveId),
    // "未结束"就是 closed_at IS NULL——不是"没有 recheck_undetermined"。
    // §14.2 让"仍无法判断"维持争议状态，那一档至今没有结论，正是本函数要捞出来的那一档。
    isNull(assessmentDisputesV2.closedAt),
  ));
}

/** 这次更正有没有已经被应用过（判据二"只许应用一次"的读数）。 */
export async function findCorrectionForDisputeV2(
  tx: DisputeTx,
  input: { workspaceId: string; userId: string; disputeId: string },
): Promise<typeof assessmentCorrectionsV2.$inferSelect | null> {
  const rows = await tx.select().from(assessmentCorrectionsV2).where(and(
    eq(assessmentCorrectionsV2.workspaceId, input.workspaceId),
    eq(assessmentCorrectionsV2.userId, input.userId),
    eq(assessmentCorrectionsV2.disputeId, input.disputeId),
  )).limit(1);
  return rows[0] ?? null;
}

/** 组一份界面能直接念的读侧（`assessmentDisputeViewV2Schema` 的形状）。 */
export async function getAssessmentDisputeViewV2(
  tx: DisputeTx,
  input: { workspaceId: string; userId: string; assessmentId: string },
): Promise<AssessmentDisputeViewV2 | null> {
  const dispute = await findDisputeForAssessmentV2(tx, input);
  if (!dispute) return null;
  const corrections = await tx.select().from(assessmentCorrectionsV2).where(and(
    eq(assessmentCorrectionsV2.workspaceId, input.workspaceId),
    eq(assessmentCorrectionsV2.userId, input.userId),
    eq(assessmentCorrectionsV2.disputeId, dispute.id),
  ));
  return {
    version: 2 as const,
    id: dispute.id,
    assessmentId: dispute.assessmentId,
    artifactId: dispute.artifactId,
    artifactRevision: dispute.artifactRevision,
    objectiveId: dispute.objectiveId,
    kind: dispute.kind,
    status: dispute.status,
    statement: dispute.statement,
    supplement: dispute.supplement,
    recheckOutcome: dispute.recheckOutcome,
    recheckReason: dispute.recheckReason,
    corrections: corrections.map((c) => ({
      id: c.id,
      kind: c.kind,
      reason: c.reason,
      supplementArtifactId: c.supplementArtifactId,
      createdAt: c.createdAt.toISOString(),
    })),
    createdAt: dispute.createdAt.toISOString(),
    resolvedAt: (dispute.closedAt ?? (dispute.recheckCount > 0 ? dispute.updatedAt : null))?.toISOString() ?? null,
  };
}

/**
 * 结算那一发在动排期之前要问的一句：这个目标上有没有一份**还没结论**的争议？
 *
 * §14.2「待复核时**不持续放大结论**」。落到数据上就是：只要判据说这一次的结论不能拿去
 * 推进复习间隔，本次结算就**不动排期**——`consume_pending` 连那条待办都不消费。
 * 消费掉却不再排一条继任，等于把用户队列里那一条变成一个没有对象的提醒（§8.5 明写
 * "不能留下无对象的提醒"），所以挡在消费**之前**而不是之后。
 *
 * 判据不重写：先读活争议，再交给 `decideDisputedObservationV2`。那一档
 * `upheld`（复核维持）会放行——§14.2 的"不持续放大"针对的是**还没有结论**的时候，
 * 维持之后结论就成立了，再冻下去就成了 §16.22 那条"反复要求用户接受同一判定"。
 *
 * 挡的是**这个目标**的排期，不是别的目标：争议挂在 `objective_id` 上，而结算排的
 * 也是 `authorization.keyPointId`（= 目标 id），同一件事的两个读法。
 * §14.1.1 那句"无法区分时保守标记"是这里的默认取向。
 */
export async function scheduleBlockedByDisputeV2(
  tx: DisputeTx,
  input: { workspaceId: string; userId: string; objectiveId: string },
): Promise<
  | { readonly blocked: true; readonly reasonCode: "assessment_disputed" }
  | { readonly blocked: false }
> {
  const resolution = await disputeScheduleResolutionV2(tx, input);
  // 只投影"挡不挡"：这道闸的对外形状被 `assessment-disputes-postgres.integration.ts`
  // 与 `disputed-objective-due-queue-postgres.integration.ts` 逐字段断言过，
  // 把"可应用的那条更正"漏出去会让那两份的形状漂移。
  return resolution.blocked ? { blocked: true, reasonCode: "assessment_disputed" } : { blocked: false };
}

/**
 * 上面那道闸的**完整**读数：挡不挡，以及（不挡时）有没有一条「该由本次结算消费
 * 一次」的更正。
 *
 * 两格合取，来自同一个循环——**不允许**分别实现：一个目标上可以同时挂着多条活争议
 * （§9.1 明写「一个目标可能同时被笔记与卡片授权覆盖」），所以
 *   - 任何一条仍然 withholds ⇒ 整条挡（§14.2「待复核时不持续放大结论」），连
 *     「可应用」那一格也不给；
 *   - 全部都有结论、且其中至少一条判成 `apply_correction_once` ⇒ 不挡，并把那一条交回
 *     调用方去**消费一次**（`markCorrectionAppliedV2`），随后由唯一调度边界按全部适用
 *     事实重算（§9.6「需要重新计算时仍经唯一调度服务……给出一次明确回执」）。
 *
 * 消费一次之后就落到 `correction_already_applied`（仍然 withholds）：§16.22 的
 * 「不能反复要求用户接受同一判定」对"消费"同样成立——同一次更正不被消费第二次。
 * 那之后这个目标上这次观察不再被放大，用户的出口是结束争议并暂不安排（§14.2）。
 */
export async function disputeScheduleResolutionV2(
  tx: DisputeTx,
  input: { workspaceId: string; userId: string; objectiveId: string },
): Promise<
  | { readonly blocked: true; readonly reasonCode: "assessment_disputed"; readonly correctionToApply: null }
  | {
    readonly blocked: false;
    readonly correctionToApply: { readonly assessmentId: string; readonly disputeId: string } | null;
  }
> {
  const disputes = await liveDisputesForObjectiveV2(tx, input);
  let pending: { assessmentId: string; disputeId: string } | null = null;
  for (const dispute of disputes) {
    const correction = await findCorrectionForDisputeV2(tx, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      disputeId: dispute.id,
    });
    const decided = decideDisputedObservationV2({
      hasLiveDispute: true,
      recheckOutcome: dispute.recheckOutcome,
      correctionAlreadyApplied: dispute.correctionAppliedAt !== null || correction?.appliedAt != null,
    });
    if (decided.action === "use_as_is") continue;
    if (decided.action === "apply_correction_once") {
      if (!pending) pending = { assessmentId: dispute.assessmentId, disputeId: dispute.id };
      continue;
    }
    // 仍 withholds（未复核／仍无法判断／更正已应用过）⇒ 整条挡，且不给"可应用"。
    return { blocked: true, reasonCode: "assessment_disputed", correctionToApply: null };
  }
  return { blocked: false, correctionToApply: pending };
}

// ─── 写侧 ─────────────────────────────────────────────────────────────────

/**
 * 开一份争议。
 *
 * 冻结的那两列是这一发的核心（§14.2"关联原产物和版本"）：assessment 指向它评的那件产物，
 * 我们把产物的 `revision` 与 `payload_hash` 抄进争议行。产物本身是**不可变**的
 * （`learning_artifacts` 有 `locked` + `lockedAt` 的 CHECK），所以这里不是"引用"，
 * 是"记下当时是哪一版"——日后产物被 supersede，争议仍指向当初那一版。
 *
 * 目标取自 `learning_runs.objective_id`（若该 run 挂了目标）。取不到就存 null：
 * §14.2 的处置要按目标才落得了地，判不出目标时宁可存空，也不要猜一个。
 */
export async function openAssessmentDisputeV2(
  tx: DisputeTx,
  input: {
    workspaceId: string;
    userId: string;
    assessmentId: string;
    kind: AssessmentDisputeKindV2;
    statement: string;
    at: Date;
  },
): Promise<{ dispute: DisputeRow; created: boolean }> {
  const assessments = await tx.select({
    id: learningAssessments.id,
    artifactId: learningAssessments.artifactId,
    runId: learningAssessments.runId,
  }).from(learningAssessments).where(and(
    eq(learningAssessments.workspaceId, input.workspaceId),
    eq(learningAssessments.userId, input.userId),
    eq(learningAssessments.id, input.assessmentId),
  )).limit(1);
  const assessment = assessments[0];
  if (!assessment) throw new AssessmentDisputeNotFoundV2();

  const artifacts = await tx.select({
    id: learningArtifacts.id,
    revision: learningArtifacts.revision,
    payloadHash: learningArtifacts.payloadHash,
  }).from(learningArtifacts).where(and(
    eq(learningArtifacts.id, assessment.artifactId),
    eq(learningArtifacts.workspaceId, input.workspaceId),
    eq(learningArtifacts.userId, input.userId),
  )).limit(1);
  const artifact = artifacts[0];
  // assessment 一定评的是一件存在的产物；读不到说明数据不自洽，不要开出一份
  // 没有原产物的争议——§14.2 的第一句就是"关联原产物"。
  if (!artifact) throw new AssessmentDisputeNotFoundV2();

  // 目标取自 `learning_runs.origin->>'objectiveId'`（0222 那条索引就是按这个表达式建的，
  // `note_round`／`card` 两种 origin 都把它带在上面）。取不到就存 null：§14.2 的处置要
  // 按目标才落得了地，判不出目标时宁可存空，也不要猜一个。
  const runs = await tx
    .select({ objectiveId: sql<string | null>`${learningRuns.origin} ->> 'objectiveId'` })
    .from(learningRuns)
    .where(and(
      eq(learningRuns.id, assessment.runId),
      eq(learningRuns.workspaceId, input.workspaceId),
    ))
    .limit(1);

  const inserted = await tx.insert(assessmentDisputesV2).values({
    workspaceId: input.workspaceId,
    userId: input.userId,
    assessmentId: input.assessmentId,
    artifactId: artifact.id,
    artifactRevision: artifact.revision,
    artifactPayloadHash: artifact.payloadHash,
    objectiveId: runs[0]?.objectiveId ?? null,
    kind: input.kind,
    status: "open",
    statement: input.statement,
    createdAt: input.at,
    updatedAt: input.at,
  }).onConflictDoNothing().returning();

  const dispute = inserted[0];
  if (dispute) return { dispute, created: true };
  // 撞的是**无条件**唯一索引 ⇒ 这条判定已经有争议（无论是否已结束）。
  // §16.22 的出口是"结束并暂不安排"，不是再开一份，所以这里报冲突而不是复活旧的。
  const existing = await findDisputeForAssessmentV2(tx, input);
  if (!existing) {
    throw new Error("争议写入被唯一索引挡下但回读不到那一行：并发或数据不一致，请重试");
  }
  throw new AssessmentDisputeAlreadyOpenV2(existing.id);
}

/**
 * 补充说明（§14.2"用户提出争议后，可补充说明"）。
 *
 * 刻意**不**重置 `recheckCount`／`recheckOutcome`：补充是补充，复核已经发生过就是发生过。
 * 把它做成"重新打开"就是 §16.22 那条死循环的入口。
 */
export async function submitDisputeSupplementV2(
  tx: DisputeTx,
  input: { workspaceId: string; userId: string; assessmentId: string; supplement: string; at: Date },
): Promise<{ dispute: DisputeRow; accepted: true }> {
  const dispute = await findDisputeForAssessmentV2(tx, input);
  if (!dispute) throw new AssessmentDisputeNotFoundV2();
  if (dispute.closedAt) throw new AssessmentDisputeClosedV2();
  const updated = await tx.update(assessmentDisputesV2)
    .set({ supplement: input.supplement, updatedAt: input.at })
    .where(and(
      eq(assessmentDisputesV2.id, dispute.id),
      eq(assessmentDisputesV2.workspaceId, input.workspaceId),
      eq(assessmentDisputesV2.userId, input.userId),
    ))
    .returning();
  return { dispute: updated[0] ?? dispute, accepted: true };
}

/**
 * 落**一次**重新检查的结论。
 *
 * 状态与 `recheck_count` 在同一发里推进：先按判据问能不能复核（给出可念的 409 原因），
 * 再写结论、计数与时间。幂等不是靠"重复调用返回同样的值"——**重复调用是冲突**，
 * 因为 §16.22 判的是"已经复核过"，把第二次当成 no-op 会让调用方以为还能再试。
 * 真要重放同一份报告，调用方拿回既有回执即可（`getAssessmentDisputeViewV2`）。
 */
export async function completeDisputeRecheckV2(
  tx: DisputeTx,
  input: {
    workspaceId: string;
    userId: string;
    assessmentId: string;
    outcome: AssessmentDisputeRecheckOutcomeV2;
    reason: string;
    reportHash: string;
    at: Date;
  },
): Promise<{ dispute: DisputeRow; outcome: AssessmentDisputeRecheckOutcomeV2 }> {
  const dispute = await findDisputeForAssessmentV2(tx, input);
  if (!dispute) throw new AssessmentDisputeNotFoundV2();

  const decided = decideDisputeRecheckV2({
    disputeClosed: dispute.closedAt !== null,
    recheckPerformed: dispute.recheckCount > 0,
  });
  if (!decided.allowed) {
    if (decided.reasonCode === "dispute_closed") throw new AssessmentDisputeClosedV2();
    throw new AssessmentDisputeRecheckExhaustedV2(dispute.id);
  }

  const statusByOutcome: Record<AssessmentDisputeRecheckOutcomeV2, DisputeRow["status"]> = {
    upheld: "recheck_upheld",
    corrected: "recheck_corrected",
    // 原判过宽：状态名要说得出「宽」，**不能**复用 `recheck_undetermined`——
    // §16.22 的读侧是按状态**分别**判的（`recheck_upheld` 放行、其余扣住），
    // 合成一个状态就等于把「原判被否定了」也放行。
    over_broad: "recheck_over_broad",
    undetermined: "recheck_undetermined",
  };
  // `recheckCount` 一次就是 1（判据已挡住 0→2）。同时写进 WHERE，
  // 让并发下的第二次 UPDATE 落空——库上的 CHECK 是最后一道，不指望它给出理由。
  const updated = await tx.update(assessmentDisputesV2).set({
    status: statusByOutcome[input.outcome],
    recheckOutcome: input.outcome,
    recheckReason: input.reason,
    recheckReportHash: input.reportHash,
    recheckCount: 1,
    updatedAt: input.at,
  }).where(and(
    eq(assessmentDisputesV2.id, dispute.id),
    eq(assessmentDisputesV2.workspaceId, input.workspaceId),
    eq(assessmentDisputesV2.userId, input.userId),
    eq(assessmentDisputesV2.recheckCount, 0),
  )).returning();
  const row = updated[0];
  if (!row) {
    // 判据读到 0、UPDATE 却挡下来了 ⇒ 并发下的第二次。报同一档冲突。
    throw new AssessmentDisputeRecheckExhaustedV2(dispute.id);
  }
  return { dispute: row, outcome: input.outcome };
}

/**
 * 写一条**只追加**的更正记录。
 *
 * 这一发**不**改 `learning_assessments.rubric_results`——那是 §14.2"不重写历史原回答"
 * 的字面形状。原判的逐条结果被抄进 `superseded_rubric_results` 只为可追溯，
 * 原行保持原样；读侧要显示"更正后的样子"时，把这一行叠在原判上，不去动它。
 *
 * `system_misjudgment` 与 `user_supplement` 的差别不在"改了什么"，在**依据是哪一次**：
 * 前者依据的仍是同一份原回答（所以 `supplementArtifactId` 必须为空，0296 的 CHECK 钉住），
 * 后者依据用户后来补的那份作答（必须有）。§16.25 的"两者不混算"由此在数据层成立。
 */
export async function recordAssessmentCorrectionV2(
  tx: DisputeTx,
  input: {
    workspaceId: string;
    userId: string;
    assessmentId: string;
    kind: AssessmentCorrectionKindV2;
    reason: string;
    supplementArtifactId?: string | null;
    correctedRubricResults?: unknown[];
    at: Date;
  },
): Promise<{ correction: typeof assessmentCorrectionsV2.$inferSelect; created: boolean }> {
  const dispute = await findDisputeForAssessmentV2(tx, input);
  if (!dispute) throw new AssessmentDisputeNotFoundV2();
  if (dispute.closedAt) throw new AssessmentDisputeClosedV2();
  // 更正的前提是复核结论是"修正"：§14.2"若重新检查发现原回答本身已满足原评分条件，
  // 应以更正记录修正原判"——没有那个结论就没有可更正的东西。
  if (dispute.recheckOutcome !== "corrected") {
    throw new AssessmentCorrectionShapeV2();
  }

  const shape = decideSupplementArtifactRequiredV2({
    kind: input.kind,
    supplementArtifactId: input.supplementArtifactId ?? null,
  });
  if (shape.required && !shape.provided) throw new AssessmentCorrectionShapeV2();

  const existing = await findCorrectionForDisputeV2(tx, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    disputeId: dispute.id,
  });
  if (existing) {
    // §9.6"不能重复消费同一日程"的另一半：同一次更正写第二行，界面上就是两次表现。
    throw new AssessmentCorrectionAlreadyRecordedV2(existing.id);
  }

  const assessments = await tx.select({ rubricResults: learningAssessments.rubricResults })
    .from(learningAssessments)
    .where(and(
      eq(learningAssessments.id, dispute.assessmentId),
      eq(learningAssessments.workspaceId, input.workspaceId),
    ))
    .limit(1);

  const inserted = await tx.insert(assessmentCorrectionsV2).values({
    workspaceId: input.workspaceId,
    userId: input.userId,
    disputeId: dispute.id,
    assessmentId: dispute.assessmentId,
    kind: input.kind,
    reason: input.reason,
    supplementArtifactId: input.kind === "user_supplement" ? (input.supplementArtifactId ?? null) : null,
    supersededRubricResults: assessments[0]?.rubricResults ?? [],
    correctedRubricResults: input.correctedRubricResults ?? [],
    createdAt: input.at,
  }).onConflictDoNothing().returning();
  if (inserted[0]) return { correction: inserted[0], created: true };
  const raced = await findCorrectionForDisputeV2(tx, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    disputeId: dispute.id,
  });
  if (!raced) throw new Error("更正写入被唯一索引挡下但回读不到那一行：并发，请重试");
  throw new AssessmentCorrectionAlreadyRecordedV2(raced.id);
}

/**
 * 把这一条更正标记为"已应用"，并给结算那一发一个可执行的交接。
 *
 * 单独一个动作而不是塞进 `recordAssessmentCorrectionV2`：写记录与消费记录是**两件事**，
 * §9.6 说的"需要重新计算时仍经唯一调度服务……没有调度变化也应说明原因"要求消费方
 * 拿着全部适用事实去排，而不是在写记录时就顺手把间隔推了。合成一发就等于
 * "写下即生效"，那正是 §9.6 禁止的重复消费形状。
 *
 * 幂等：已经应用过就交回 `alreadyApplied`，**不重置** `appliedAt`。重放与迟到回执
 * 因此不会把"应用时间"往后挪，也不会让同一次更正被消费第二次。
 */
export async function markCorrectionAppliedV2(
  tx: DisputeTx,
  input: { workspaceId: string; userId: string; assessmentId: string; at: Date },
): Promise<{ applied: true; alreadyApplied: boolean; scheduleImpactHint: string }> {
  const dispute = await findDisputeForAssessmentV2(tx, input);
  if (!dispute) throw new AssessmentDisputeNotFoundV2();
  const correction = await findCorrectionForDisputeV2(tx, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    disputeId: dispute.id,
  });
  if (!correction) {
    // 没有更正记录就没什么可应用的。交回判据，让调用方知道该走哪一档。
    return {
      applied: true,
      alreadyApplied: false,
      scheduleImpactHint: decideDisputedObservationV2({
        hasLiveDispute: true,
        recheckOutcome: dispute.recheckOutcome,
        correctionAlreadyApplied: false,
      }).action,
    };
  }
  if (correction.appliedAt) {
    return { applied: true, alreadyApplied: true, scheduleImpactHint: "correction_already_applied" };
  }
  await tx.update(assessmentCorrectionsV2)
    .set({ appliedAt: input.at })
    .where(and(
      eq(assessmentCorrectionsV2.id, correction.id),
      eq(assessmentCorrectionsV2.workspaceId, input.workspaceId),
      eq(assessmentCorrectionsV2.userId, input.userId),
    ));
  await tx.update(assessmentDisputesV2)
    .set({ correctionAppliedAt: input.at, updatedAt: input.at })
    .where(and(
      eq(assessmentDisputesV2.id, dispute.id),
      eq(assessmentDisputesV2.workspaceId, input.workspaceId),
      eq(assessmentDisputesV2.userId, input.userId),
    ));
  return { applied: true, alreadyApplied: false, scheduleImpactHint: "reschedule_via_boundary" };
}

/**
 * 结束争议；本人要的话，顺带把该目标**暂不安排**。
 *
 * 排除复用 0295 的 `holdObjectiveFromReviewV2`，不另立机制（§9.1 规则表行 2 已把它
 * 定义为优先于笔记与卡片授权的持续排除），顺带继承它已有的"撤下此刻排着的那一条待办"——
 * 不重写一遍那几行 UPDATE。判"能不能落排除"的是 `decideDisputeCloseV2`：
 * 判不出受影响目标时**只结束争议**，不猜一个目标去动别人的安排。
 *
 * 结束时把 `status` 落成 `closed_held`。注意 `recheck_undetermined`（仍无法判断）**不是**
 * 关闭：§14.2"判断仍不可靠时维持争议状态，不强行选一方作为事实"——那一档至今没有结论，
 * 正是本函数存在的理由。
 */
export async function closeAssessmentDisputeV2(
  tx: DisputeTx,
  input: {
    workspaceId: string;
    userId: string;
    assessmentId: string;
    holdObjective: boolean;
    note?: string;
    at: Date;
  },
): Promise<{
  dispute: DisputeRow;
  outcome: "hold_objective" | "close_without_hold" | "hold_unavailable";
  dismissedPendingSchedules: number;
}> {
  const dispute = await findDisputeForAssessmentV2(tx, input);
  if (!dispute) throw new AssessmentDisputeNotFoundV2();
  if (dispute.closedAt) {
    // 已经结束过：交回既有那一行，不重写 `closedAt`（结束时间是发生过的那一次）。
    return { dispute, outcome: "close_without_hold" as const, dismissedPendingSchedules: 0 };
  }
  // 排除表的 `note_id` 是指向 `notes` 的外键，而这一路手上只有 objectiveId。
  // 先问一次"挂得上哪篇"，再交给判据决定——排不出笔记时如实走第三档，
  // 而不是抛错把整个结束动作卡死。
  const noteId = dispute.objectiveId
    ? await noteIdForObjectiveV2(tx, {
      workspaceId: input.workspaceId,
      objectiveId: dispute.objectiveId,
    })
    : null;
  const decided = decideDisputeCloseV2({
    objectiveId: dispute.objectiveId,
    userAskedForHold: input.holdObjective,
    noteBindingAvailable: noteId !== null,
  });

  let dismissedPendingSchedules = 0;
  if (decided.outcome === "hold_objective" && dispute.objectiveId) {
    // 判到这一档时 noteId 必然存在（`decideDisputeCloseV2` 的第三档挡住了缺绑定）。
    const hold = await holdObjectiveFromReviewV2(tx, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      noteId: noteId as string,
      objectiveId: dispute.objectiveId,
      reasonCode: "dispute_unresolved",
    });
    dismissedPendingSchedules = hold.dismissedPendingSchedules;
  }

  const updated = await tx.update(assessmentDisputesV2).set({
    status: "closed_held",
    closedAt: input.at,
    updatedAt: input.at,
  }).where(and(
    eq(assessmentDisputesV2.id, dispute.id),
    eq(assessmentDisputesV2.workspaceId, input.workspaceId),
    eq(assessmentDisputesV2.userId, input.userId),
  )).returning();
  return {
    dispute: updated[0] ?? dispute,
    outcome: decided.outcome,
    dismissedPendingSchedules,
  };
}

/**
 * 目标属于哪一篇笔记；排不出就返回 null。
 *
 * 只认 `origin_kind='note'` 的那一档绑定：手动与导入来源的目标没有"这篇笔记"，
 * 而 `objective_review_holds_v2.note_id` 不可空。返回 null 而不抛错，是为了让
 * `decideDisputeCloseV2` 那一档能判成 `hold_unavailable`——争议照样结束，
 * 只是把"没能落排除"如实说出来（§14.2 的出口是"可结束"）。
 */
async function noteIdForObjectiveV2(
  tx: DisputeTx,
  input: { workspaceId: string; objectiveId: string },
): Promise<string | null> {
  const rows = await tx.select({ noteId: learningObjectiveOriginsV2.noteId })
    .from(learningObjectiveOriginsV2)
    .where(and(
      eq(learningObjectiveOriginsV2.workspaceId, input.workspaceId),
      eq(learningObjectiveOriginsV2.objectiveId, input.objectiveId),
      eq(learningObjectiveOriginsV2.originKind, "note"),
    ))
    .limit(1);
  return rows[0]?.noteId ?? null;
}
