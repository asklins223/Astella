/**
 * LearningRun 服务（文档 16 §13 P2 纵切）。
 *
 * 事务纪律：全部函数接收 `tx: ApiTransaction`，只在调用方
 * withWorkspaceTransaction 事务内执行（路由层统一包装；RLS 上下文由
 * withWorkspaceTransaction 设置）。禁止在事务外直接写表。
 *
 * P2 范围：card/today/review 入口 + text/voice 单一 Task + pause/resume/end/
 * skip/request_hint/switch_variant 动作 + draft CAS + 原子 submission +
 * result/return-contract。star_map/onboarding sandbox 入口 fail closed
 * （后续阶段开放），结构题与 followup 属 P4。
 *
 * 关键不变量：
 * - 创建幂等：learning_run_idempotency(workspace,user,key) 唯一；
 * - 提交原子：校验 → assistance snapshot → 锁 Artifact → 排队 Assessment →
 *   outbox（§12.3 七步在同一事务）；
 * - declared_unable 只走 submission，不进 action API；
 * - 答案正文不进事件 payload / outbox payload。
 */

import { applyAction, getRunPublicView, loadInteractionQualifications, recentPresentedPayloadHashes, type ActionInput } from "./run-action.ts";
import { loadRun, type RunScope } from "./run-loader.ts";

export { applyAction, getRunPublicView };
export type { ActionInput };

import { reviewDimensionForObservationV2, type ReviewDimensionV2 } from "@astella/shared/review-dimension-v2";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { learningActivityLeases, learningArtifacts, learningAssessments, learningRunActionLedger, learningRunEvents, learningRunIdempotency, learningRunPrivateContracts, learningRunProcessingOutbox, learningRuns, learningTaskDisclosureProfiles, learningTaskDrafts, learningTaskPresentationHistory, learningTaskPrivateSolutions, learningTaskSafetyReports, learningTaskVariants, learningTasks } from "@astella/shared/db-schema/learning-runs";
import { evidenceEligibilityStatesV2, learningCardsV2, learningExposuresV2, learningObjectivesV2, learningTargetSnapshotsV2 } from "@astella/shared/db-schema/card-generation-v2";

import { reviewSchedules } from "@astella/shared/db-schema/evidence";
import { sourceAuthorizationForObjectiveV2 } from "../review/review-subscriptions.ts";
import { noteLearningRounds } from "@astella/shared/db-schema/note-learning-rounds";
import { validationAssistanceExposures } from "@astella/shared/db-schema/validation-v2";
import { companionSandboxNamespaces } from "@astella/shared/db-schema/companion-sandbox";
import { understandingProjectionCheckpoints } from "@astella/shared/db-schema/understanding-projection";
import type { GetLearningRunResultResponseV2, LearningRunOriginV2, LearningRunPublicSnapshotV2, LearningRunPublicV1, LearningRunSubmittedAnswerV2, LearningRunResultAssessmentV2, LearningRunTargetPublicV2, LearningRunTargetRevealV2, LearningRunReturnContractV2, LearningRunResultV2, LearningRunReturnContractV1, LearningRunReturnTargetV2, SchedulingAuthorizationV1, SubmitTaskArtifactV1 } from "@astella/shared";
import { uncoveredFacets } from "./run-result-facets.ts";
import { getLearningRunResultResponseV2Schema, learningRunOriginV2Schema, learningRunPublicSnapshotV2Schema, artifactPayloadSchema, learningRunResultAssessmentV2Schema, learningRunResultSchema, learningRunResultV2Schema, learningRunPhaseV2Schema, learningRunReturnContractSchema, learningRunReturnContractV2Schema, learningRunReturnTargetV2Schema, learningRunTargetPublicV2Schema, learningRunTargetRevealV2Schema } from "@astella/shared";
import { learningRunOutcomeSchema, taskIntentSchema } from "@astella/shared/learning-run-contracts";
import type { RoundNextStepV1, RoundPracticeV1 } from "@astella/shared/note-learning-round-contracts";
import { computeExposureScopeIdV2 } from "@astella/shared/card-generation-v2-hashing";
import { extractAnswerText } from "@astella/shared/card-generation-v2-pipeline";
import { computeRunContractHash, planRun, clampTimeBudget, rubricTargetIdsOf, type PlannerOptions, type PlannerV2Target } from "./planning/run-planner.ts";
import { isDeterministicStructuredPayload } from "./planning/run-structured.ts";
import { sha256Hex } from "@astella/shared/content-hash";
import { freezeTargetSnapshotV2, prepareCardContentEpoch, loadFrozenTargetSnapshotV2, buildLearningRunTargetPublicV2, TargetSnapshotError, type FrozenTargetSnapshotV2 } from "../card-generation-v2/target-snapshot-adapter.ts";
import { artifactAlreadyLocked, contextStale, contextStaleFromFreezeCode, idempotencyConflict, invalidPhase, LearningRunServiceError, scheduleGenerationChanged, staleRunRevision, staleTaskRevision, variantNotAuthorized } from "./run-errors.ts";
import { deriveReturnTargetV1 } from "./run-view.ts";
import { decryptDraftPayload, encryptDraftPayload, isDraftEncryptionAvailable } from "./run-draft-crypto.ts";
import { buildLearningRunAllowedActionsV2 } from "./run-action-availability.ts";
import { readObjectiveNoteChangeImpactV1 } from "../learning-objectives/change-impact-service.ts";

// ─── 服务接口（路由层注入）───────────────────────────────────────────────

/** §16.3 V2 PREPARE 请求（wire 上带 originV2；与 V1 的 origin 互斥）。 */
export interface CreateLearningRunV2Request {
  originV2: LearningRunOriginV2;
  goal: LearningRunPublicV1["goal"];
  requestedTimeBudgetSeconds?: number;
  responsePreference?: "adaptive" | "voice" | "text" | "structured";
  idempotencyKey: string;
}

export interface CreateRunV2Input extends RunScope {
  request: CreateLearningRunV2Request;
}

export interface DraftInput extends RunScope {
  runId: string;
  taskId: string;
  variantId: string;
  variantRevision: number;
  taskRevision: number;
  expectedDraftRevision: number | null;
  payload: unknown | null;
  rendererState: unknown;
  idempotencyKey: string;
  requestContext?: { version: 2; snapshotId: string };
  assertDraftAllowed?: () => void;
}

export interface SubmitInput extends RunScope {
  runId: string;
  taskId: string;
  request: SubmitTaskArtifactV1;
  requestContext?: { version: 2; snapshotId: string };
}

// ─── 权限与读取 ──────────────────────────────────────────────────────────

/**
 * §7.8：Run 结算回填 presentation_history（outcome/exposed；按 runId 幂等）。
 * exposed 以服务端事件账本判定（learning_task.hint_requested），不信任客户端。
 */
export async function backfillPresentationHistory(
  tx: ApiTransaction,
  input: { runId: string; outcome: string },
): Promise<void> {
  const hintRows = await tx
    .select({ id: learningRunEvents.id })
    .from(learningRunEvents)
    .where(and(
      eq(learningRunEvents.runId, input.runId),
      eq(learningRunEvents.eventType, "learning_task.hint_requested"),
    ))
    .limit(1);
  await tx
    .update(learningTaskPresentationHistory)
    .set({ outcome: input.outcome, exposed: hintRows.length > 0 })
    .where(eq(learningTaskPresentationHistory.runId, input.runId));
}


// F16·①（round-4）：createRunV2 每次热路径都全表物化 interaction
// qualifications（无 WHERE）。表为全局参考表（无 workspaceId 维度，见 migration
// 0144），故可安全做进程内短 TTL 缓存（60s）：参考数据低频更新，缓存可消
// 每请求全扫热点。cache-hit 检查时顺带清过期条目，避免 Map 无界。

/**
 * V2 origin 特有 fail-closed 校验（§16.4 sandbox 隔离 + P7 投影基线新鲜度）。
 *
 * 校验 onboarding sandbox namespace 的存在性/归属/过期，以及 star_map
 * baseline checkpoint 的签名、作用域与 watermark 新鲜度；校验失败一律
 * contextStale（409）。
 */
async function validateV2OriginExtras(
  tx: ApiTransaction,
  scope: RunScope,
  originV2: LearningRunOriginV2,
): Promise<void> {
  if (originV2.kind === "onboarding" && originV2.sampleMode === "sandbox") {
    // 沙箱教学空间：必须存在、属于当前 workspace/user、active 且未过期。
    if (!originV2.sandboxNamespaceId) throw contextStale("沙箱教学空间参数缺失");
    const nsRows = await tx
      .select({
        id: companionSandboxNamespaces.id,
        status: companionSandboxNamespaces.status,
        expiresAt: companionSandboxNamespaces.expiresAt,
      })
      .from(companionSandboxNamespaces)
      .where(and(
        eq(companionSandboxNamespaces.id, originV2.sandboxNamespaceId),
        eq(companionSandboxNamespaces.workspaceId, scope.workspaceId),
        eq(companionSandboxNamespaces.userId, scope.userId),
      ))
      .limit(1);
    const ns = nsRows[0];
    if (!ns || ns.status !== "active" || ns.expiresAt.getTime() < Date.now()) {
      throw contextStale("沙箱教学空间不存在或已过期");
    }
    return;
  }
  if (originV2.kind === "star_map") {
    // 投影基线：签名可解析、作用域匹配且不落后于最新投影 → 才允许基于星图启动。
    const { parseCheckpointToken, watermarkBehind } = await import("../understanding/projection-checkpoint.ts");
    const baseline = parseCheckpointToken(originV2.baselineCheckpoint.token);
    if (!baseline
      || baseline.workspaceId !== scope.workspaceId
      || baseline.userId !== scope.userId) {
      throw contextStale("投影基线 checkpoint 无效或作用域不符");
    }
    const latestRows = await tx
      .select({
        canonical: understandingProjectionCheckpoints.lastCanonicalEventId,
        practice: understandingProjectionCheckpoints.lastPracticeEventId,
        capturedAt: understandingProjectionCheckpoints.capturedAt,
      })
      .from(understandingProjectionCheckpoints)
      .where(and(
        eq(understandingProjectionCheckpoints.workspaceId, scope.workspaceId),
        eq(understandingProjectionCheckpoints.userId, scope.userId),
      ))
      .orderBy(desc(understandingProjectionCheckpoints.capturedAt))
      .limit(1);
    const latest = latestRows[0]
      ? {
          workspaceId: scope.workspaceId,
          userId: scope.userId,
          lastCanonicalEventId: latestRows[0].canonical,
          lastPracticeEventId: latestRows[0].practice,
          capturedAt: latestRows[0].capturedAt.toISOString(),
        }
      : null;
    if (watermarkBehind(baseline, latest)) {
      throw contextStale("投影基线已过期（星图有新的变化）");
    }
  }
}

// ─── createRunV2（§16.2 PREPARE：V2 Origin → freeze snapshot → V2 planner）────


/**
 * §16.3 V2 schedulingAuthorization：
 * - review：必须存在匹配 objective 的 pending schedule 且 generation OCC；
 * - card：无 pending schedule 时 create_initial，否则 no_effect；
 * - star_map：有 pending 则 consume_pending，否则 create_initial；
 * - today/onboarding：no_effect。
 */
async function resolveV2Scheduling(
  tx: ApiTransaction,
  scope: RunScope,
  origin: LearningRunOriginV2,
  objectiveId: string,
  semanticTargetFingerprint: string,
  /**
   * 这一次要消费的是哪一维的安排（§9.1 / §9.5）。
   *
   * 同一个目标现在可能有**两条**待处理安排：一条「记住它」、一条「在新情境里用」。
   * `findPending` 此前按 subject 取一条、generation 倒序、limit 1——两行 generation
   * 都是 1，于是它**随便挑一条**：可能这一次答的是提取，却把「应用」那条消费掉了，
   * 而把「提取」留在原地等下次。§9.5 那句「同一作答只保存一个原始身份，每个目标的
   * 同一次日程影响最多提交一次」靠的就是这一格挑对。
   */
  reviewDimension: ReviewDimensionV2,
): Promise<SchedulingAuthorizationV1> {
  if (origin.kind === "review" || origin.kind === "card" || origin.kind === "star_map" || origin.kind === "note_round") {
    const noteImpact = await readObjectiveNoteChangeImpactV1(tx, scope, objectiveId, {
      lockSourceNotes: true,
      includeUnchanged: true,
    });
    if (noteImpact && noteImpact.status !== "unaffected") {
      if (origin.kind === "review") {
        throw new LearningRunServiceError(
          "review_note_evidence_changed",
          "这项复习依赖的笔记证据已变化或无法核对，请先回笔记核对原文；这条复习安排仍保留。",
          409,
          { blockedReason: "note_evidence_changed" },
        );
      }
      // Old-round practice may continue against its frozen snapshot, but it
      // must not consume or create a schedule whose note evidence is no longer
      // current and verifiable.
      return { kind: "no_effect", reasonCode: "note_evidence_changed" };
    }
  }

  const findPending = async () => {
    const rows = await tx
      .select({ id: reviewSchedules.id, generation: reviewSchedules.generation,
        nextReviewAt: reviewSchedules.nextReviewAt, reminderKind: reviewSchedules.reminderKind })
      .from(reviewSchedules)
      .where(and(
        eq(reviewSchedules.workspaceId, scope.workspaceId),
        eq(reviewSchedules.userId, scope.userId),
        eq(reviewSchedules.subjectType, "card"),
        eq(reviewSchedules.subjectId, objectiveId),
        eq(reviewSchedules.status, "pending"),
        // §9.1 事实提取与综合应用分别观察：只取**这一次真正服务**的那一维，
        // 不在两行之间挑。
        eq(reviewSchedules.reviewDimension, reviewDimension),
      ))
      .orderBy(desc(reviewSchedules.generation))
      .limit(1)
      .for("update");
    return rows[0] ?? null;
  };

  if (origin.kind === "review") {
    const rows = await tx
      .select({
        id: reviewSchedules.id,
        subjectId: reviewSchedules.subjectId,
        generation: reviewSchedules.generation,
        status: reviewSchedules.status,
        nextReviewAt: reviewSchedules.nextReviewAt,
        reminderKind: reviewSchedules.reminderKind,
      })
      .from(reviewSchedules)
      .where(and(
        eq(reviewSchedules.id, origin.scheduleId),
        eq(reviewSchedules.workspaceId, scope.workspaceId),
        eq(reviewSchedules.userId, scope.userId),
      ))
      .limit(1)
      // Freeze the authorization row with the V2 PREPARE transaction. The
      // schedule is still consumed only by canonical Commit/result, but a
      // concurrent consumer cannot change status/generation after this
      // authorization has been read.
      .for("update");
    const sched = rows[0];
    if (!sched || sched.subjectId !== objectiveId || sched.generation !== origin.scheduleGeneration) {
      throw scheduleGenerationChanged();
    }
    if (sched.status !== "pending") throw scheduleGenerationChanged();
    if (sched.reminderKind !== "one_time") {
      const source = await sourceAuthorizationForObjectiveV2(tx, { ...scope, objectiveId });
      if (source.authorization !== "covered") {
        throw new LearningRunServiceError(
          "review_source_inactive",
          "这项复习的持续授权已暂停，请刷新今日复习",
          409,
        );
      }
    }
    const now = new Date();
    if (sched.nextReviewAt.getTime() > now.getTime()) {
      throw new LearningRunServiceError(
        "review_not_due",
        "该复习尚未到开始时间",
        409,
        { blockedReason: "not_due", effectiveStartAt: sched.nextReviewAt.toISOString() },
      );
    }
    const exposureRows = await tx
      .select({ unassistedEligibleAfter: validationAssistanceExposures.unassistedEligibleAfter })
      .from(validationAssistanceExposures)
      .where(and(
        eq(validationAssistanceExposures.workspaceId, scope.workspaceId),
        eq(validationAssistanceExposures.userId, scope.userId),
        eq(validationAssistanceExposures.inputScheduleId, origin.scheduleId),
      ));
    const cooldownUntil = exposureRows.reduce<Date | null>(
      (latest, row) => !latest || row.unassistedEligibleAfter > latest ? row.unassistedEligibleAfter : latest,
      null,
    );
    if (cooldownUntil && cooldownUntil.getTime() > now.getTime()) {
      throw new LearningRunServiceError(
        "review_assistance_cooldown",
        "该复习仍处于辅助暴露冷却期",
        409,
        { blockedReason: "cooldown", effectiveStartAt: cooldownUntil.toISOString() },
      );
    }
    return {
      kind: "consume_pending",
      scheduleId: origin.scheduleId,
      scheduleGeneration: origin.scheduleGeneration,
      keyPointId: objectiveId,
      targetFingerprint: semanticTargetFingerprint,
      dueAt: new Date().toISOString(),
      schedulerPolicyId: "discrete-v2",
    };
  }
  if (origin.kind === "card" || origin.kind === "star_map") {
    const pending = await findPending();
    if (pending) {
      return {
        kind: "consume_pending",
        scheduleId: pending.id,
        scheduleGeneration: pending.generation,
        keyPointId: objectiveId,
        targetFingerprint: semanticTargetFingerprint,
        dueAt: new Date().toISOString(),
        schedulerPolicyId: "discrete-v2",
      };
    }
    return {
      kind: "create_initial",
      keyPointId: objectiveId,
      targetFingerprint: semanticTargetFingerprint,
      schedulerPolicyId: "discrete-v2",
    };
  }
  // 笔记轮次内的练习（D1 §4.3 / 39d W4-5 ②）：
  // - 轮次本身必须是**开着**的（active/paused）——closed 之后不可恢复，新学习
  //   产生新轮次（D1 §5.1），把练习记到一个已封存的轮次上是静默改历史；
  // - §9.1「结束一轮都不默认授权未来提醒」⇒ 无来源时不 create_initial；
  // - §9.5/§9.6：同一目标已有 pending 安排时复用（这一次练习消费那一次日程），
  //   已有明确有效来源而尚无排程时，结算可建立首次回访。
  if (origin.kind === "note_round") {
    const roundRows = await tx
      .select({ id: noteLearningRounds.id, phase: noteLearningRounds.phase })
      .from(noteLearningRounds)
      .where(and(
        eq(noteLearningRounds.id, origin.roundId),
        eq(noteLearningRounds.workspaceId, scope.workspaceId),
        eq(noteLearningRounds.userId, scope.userId),
      ))
      .limit(1);
    const round = roundRows[0];
    if (!round || (round.phase !== "active" && round.phase !== "paused")) {
      throw new LearningRunServiceError(
        "note_round_not_open",
        "这一轮已经结束，请从笔记页开始新的一轮",
        409,
        { blockedReason: "round_not_open" },
      );
    }
    const pending = await findPending();
    const source = await sourceAuthorizationForObjectiveV2(tx, { ...scope, objectiveId });
    if (pending) {
      if (pending.nextReviewAt.getTime() > Date.now()) {
        // Immediate practice in a note round must not consume the delayed
        // recall that the learner explicitly scheduled for a later day.
        return { kind: "no_effect", reasonCode: "pending_not_due" };
      }
      if (pending.reminderKind !== "one_time" && source.authorization !== "covered") {
        return { kind: "no_effect", reasonCode: "not_authorized" };
      }
      return {
        kind: "consume_pending",
        scheduleId: pending.id,
        scheduleGeneration: pending.generation,
        keyPointId: objectiveId,
        targetFingerprint: semanticTargetFingerprint,
        dueAt: new Date().toISOString(),
        schedulerPolicyId: "discrete-v2",
      };
    }
    if (source.authorization === "covered") {
      return {
        kind: "create_initial",
        keyPointId: objectiveId,
        targetFingerprint: semanticTargetFingerprint,
        schedulerPolicyId: "discrete-v2",
      };
    }
    return { kind: "no_effect", reasonCode: "not_authorized" };
  }
  // today / onboarding：无调度效果。
  if (origin.kind === "onboarding" && origin.sampleMode === "sandbox") {
    return { kind: "no_effect", reasonCode: "sandbox" };
  }
  return { kind: "no_effect", reasonCode: "not_authorized" };
}

/**
 * §16.2 createRunV2（PREPARE V2 路径）。
 *
 * 顺序：解析 Origin → workspace-scoped active Objective+Card（fail closed，
 * 经由 freeze）→ 读 cardContentEpoch → freeze LearningTargetSnapshotV2 →
 * 调度授权 → V2 planner（只消费 snapshot）→ 原子写 run/private contract（含
 * V2 target 闭包）/task/variants/events。V2 run 的 contract 冻结 expected
 * objective lifecycle epoch 与 evidence eligibility vector hash。
 */
export async function createRunV2(
  tx: ApiTransaction,
  input: CreateRunV2Input,
  now: () => Date = () => new Date(),
): Promise<{
  runId: string;
  frozen: FrozenTargetSnapshotV2;
  snapshotId: string;
}> {
  const { workspaceId, userId } = input;
  const request = input.request;
  const originV2 = request.originV2;

  // 幂等：同 key 重放返回既有 run（重新加载 frozen snapshot）。
  const requestFingerprint = sha256Hex(JSON.stringify({
    originV2,
    goal: request.goal,
    requestedTimeBudgetSeconds: request.requestedTimeBudgetSeconds ?? null,
    responsePreference: request.responsePreference ?? null,
  }));
  // The idempotency row has a foreign key to the run, so it cannot be claimed
  // before a run exists with a normal INSERT. Serialize the canonical key at
  // the transaction level instead; the loser waits for the winner to commit,
  // then observes the ledger row before any PREPARE side effect.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${workspaceId}:${userId}:${request.idempotencyKey}`}, 0))`);
  const idemRows = await tx
    .select({ runId: learningRunIdempotency.runId, clientRequestId: learningRunIdempotency.clientRequestId })
    .from(learningRunIdempotency)
    .where(and(
      eq(learningRunIdempotency.workspaceId, workspaceId),
      eq(learningRunIdempotency.userId, userId),
      eq(learningRunIdempotency.idempotencyKey, request.idempotencyKey),
    ))
    .limit(1);
  if (idemRows[0]) {
    if (idemRows[0].clientRequestId !== requestFingerprint) throw idempotencyConflict();
    const runRows = await tx.select().from(learningRuns).where(eq(learningRuns.id, idemRows[0].runId)).limit(1);
    if (!runRows[0]) throw contextStale("幂等 run 不存在");
    const snap = await loadFrozenTargetSnapshotV2(tx, workspaceId, idemRows[0].runId);
    if (!snap) throw contextStale("幂等 V2 run 缺少 frozen snapshot");
    return { runId: idemRows[0].runId, frozen: { snapshot: snap, publicTarget: buildLearningRunTargetPublicV2(snap), objectiveLifecycleEpoch: snap.objectiveLifecycleEpoch, evidenceEligibilityVectorHash: snap.target.evidenceEligibilityVectorHash, cardContentEpoch: snap.cardContentEpoch }, snapshotId: snap.snapshotId };
  }

  const objectiveId = originV2.objectiveId;
  // freezeTargetSnapshotV2 performs the workspace-scoped active-objective check.
  // origin 特有 fail-closed 校验（2026-08-23 补回：V2 rebase 时随 resolveOriginTarget
  // 一并丢失——sandbox namespace 过期/伪造投影基线此前可静默通过）。
  await validateV2OriginExtras(tx, { workspaceId, userId }, originV2);
  const cardContentEpoch = await prepareCardContentEpoch(tx, workspaceId);
  const runId = crypto.randomUUID();

  // lts_v2_run_fk（0138：snapshot.run_id → learning_runs.id RESTRICT）要求 run 行
  // 先于 snapshot 存在。先插骨架行（phase='preparing'，target_fingerprint 占位，
  // 同事务内对外不可见），freeze/plan 完成后 UPDATE 为最终值（R20 修复）。
  const createdAt0 = now();
  await tx.insert(learningRuns).values({
    id: runId,
    workspaceId,
    userId,
    origin: originV2 as never,
    // returnTarget 一律由 origin 确定性推导出完整 V1 合同形状（含 keyPointId/
    // scheduleId/lens/filter/destination），修复此前非 card 分支缺字段的漂移
    // （2026-08-22 审查：review/onboarding/star_map 存储值缺 V1 合同字段）。
    returnTarget: deriveReturnTargetV1(originV2),
    // 目标身份经严格 V2 origin 的 objectiveId 读取。
    targetFingerprint: "",
    goal: request.goal,
    createdAt: createdAt0,
    updatedAt: createdAt0,
  });

  // PREPARE 内部起算：freeze snapshot（读 exact revisions，不读 live claim）。
  let frozen: FrozenTargetSnapshotV2;
  try {
    frozen = await freezeTargetSnapshotV2(tx, {
      workspaceId,
      userId,
      runId,
      objectiveId,
      cardContentEpoch,
    });
  } catch (error) {
    // A caller-supplied objective that is missing, inactive, or no longer has
    // a complete public target is an origin/context drift, not an internal
    // server error. Keep the boundary typed and fail closed without exposing
    // target-snapshot internals or leaving a visible skeleton run behind.
    if (error instanceof TargetSnapshotError) {
      throw contextStaleFromFreezeCode(error.code);
    }
    throw error;
  }

  const schedulingAuthorization = await resolveV2Scheduling(
    tx,
    { workspaceId, userId },
    originV2,
    objectiveId,
    frozen.snapshot.target.semanticTargetFingerprint,
    // 判据是这一轮**冻结**下来的 goal：§8.4 里只有「新情境能力检查」服务应用。
    reviewDimensionForObservationV2({ transferSuitable: request.goal === "transfer" }),
  );

  const timeBudgetSeconds = clampTimeBudget(request.requestedTimeBudgetSeconds);
  const v2Target: PlannerV2Target = {
    objectiveStatement: frozen.snapshot.target.objectiveStatement,
    publicSummary: frozen.snapshot.target.publicSummary,
    knowledgeForm: frozen.snapshot.target.knowledgeForm,
    preferredIntents: frozen.snapshot.target.preferredIntents,
    canonicalAnswer: frozen.snapshot.target.canonicalAnswer,
    scoringRubric: frozen.snapshot.target.scoringRubric,
    relations: frozen.snapshot.target.relations,
    practiceItem: frozen.snapshot.target.practiceItem ?? null,
    evidence: frozen.snapshot.target.evidence,
    publishedTargetEligibility: frozen.snapshot.publishedTargetEligibility,
  };
  const [recentPublicPayloadHashes, interactionQualifications] = await Promise.all([
    recentPresentedPayloadHashes(tx, {
      workspaceId,
      userId,
      keyPointId: objectiveId,
    }),
    loadInteractionQualifications(tx),
  ]);
  let applicationScenario: string | undefined;
  if (originV2.kind === "note_round" && request.goal === "transfer") {
    const rows = await tx.execute(sql`SELECT t.application_scenario
      FROM note_learning_round_targets AS t
      JOIN note_learning_rounds AS r ON r.id = t.round_id
        AND r.workspace_id = t.workspace_id AND r.user_id = t.user_id
        AND r.driving_question_revision = t.driving_question_revision
      WHERE t.workspace_id = ${workspaceId} AND t.user_id = ${userId}
        AND t.round_id = ${originV2.roundId} AND r.note_id = ${originV2.noteId}
        AND t.objective_id = ${objectiveId} AND r.phase IN ('active','paused')`);
    const value = rows[0]?.application_scenario;
    if (typeof value !== "string" || !value.trim()) {
      throw contextStale("这一轮还没有核对通过的新情境，请返回笔记继续学习");
    }
    applicationScenario = value;
  }
  const plannerOptions: PlannerOptions = {
    runId,
    goal: request.goal,
    responsePreference: request.responsePreference ?? "adaptive",
    timeBudgetSeconds,
    recentPublicPayloadHashes,
    interactionQualifications,
    applicationScenario,
  };
  const plan = planRun(
    {
      keyPointId: objectiveId,
      claim: frozen.snapshot.target.objectiveStatement,
      sourceFingerprint: frozen.snapshot.target.semanticTargetFingerprint,
      evidenceContentHashes: frozen.snapshot.target.evidence.map((e) => e.evidenceSnapshotHash),
      v2: v2Target,
    },
    plannerOptions,
  );

  const runtimeEpoch = 0;
  const contractHash = computeRunContractHash({
    runId,
    workspaceId,
    userId,
    keyPointId: objectiveId,
    targetFingerprint: frozen.snapshot.target.semanticTargetFingerprint,
    runtimeEpoch,
    timeBudgetSeconds,
    planningClosesAtActiveSecond: 150,
    schedulingAuthorization,
    taskPlanHash: plan.runPlanHash,
    projectionBaselineCheckpointToken: null,
    // §16.2 step 8：V2 Run 把 snapshotHash 纳入 private contract hash closure。
    snapshotHash: frozen.snapshot.snapshotHash,
  });

  const task = plan.tasks[0];
  const primaryVariant = plan.primaryVariant;
  const alternativeVariants = plan.alternativeVariants;
  const createdAt = now();

  // 骨架行在 freeze 前已插入（lts_v2_run_fk）；此处 UPDATE 为 plan 后的最终值。
  await tx.update(learningRuns)
    .set({
      targetFingerprint: frozen.snapshot.target.semanticTargetFingerprint,
      timeBudgetSeconds,
      plannedActiveSeconds: plan.plannedActiveSeconds,
      activeTaskId: task.taskId,
      phase: "active",
      sandboxNamespaceId: originV2.kind === "onboarding" && originV2.sampleMode === "sandbox" ? originV2.sandboxNamespaceId ?? null : null,
      updatedAt: createdAt,
    })
    .where(and(
      eq(learningRuns.id, runId),
      eq(learningRuns.workspaceId, workspaceId),
    ));
  await tx.insert(learningRunIdempotency).values({
    workspaceId,
    userId,
    idempotencyKey: request.idempotencyKey,
    clientRequestId: requestFingerprint,
    runId,
    createdAt,
  }).onConflictDoNothing();

  // V2 private contract：冻结 target 闭包 + expected lifecycle epoch + evidence vector。
  await tx.insert(learningRunPrivateContracts).values({
    runId,
    workspaceId,
    userId,
    // objective 身份经 snapshotId→snapshot 关联。
    targetFingerprint: frozen.snapshot.target.semanticTargetFingerprint,
    runtimeEpoch,
    timeBudgetSeconds,
    planningClosesAtActiveSecond: 150,
    schedulingAuthorization,
    taskPlanHash: plan.runPlanHash,
    projectionBaselineCheckpointToken: null,
    contractHash,
    snapshotId: frozen.snapshot.snapshotId,
    snapshotHash: frozen.snapshot.snapshotHash,
    semanticTargetFingerprint: frozen.snapshot.target.semanticTargetFingerprint,
    targetRevisionHash: frozen.snapshot.target.targetRevisionHash,
    expectedObjectiveLifecycleEpoch: frozen.objectiveLifecycleEpoch,
    evidenceEligibilityVectorHash: frozen.evidenceEligibilityVectorHash,
    publishedTargetEligibility: frozen.snapshot.publishedTargetEligibility,
    createdAt,
  });
  await tx.insert(learningTasks).values({
    id: task.taskId,
    runId,
    workspaceId,
    userId,
    sequence: task.sequence,
    intent: task.intent,
    prompt: task.prompt,
    targetSummary: task.targetSummary,
    hintLevels: task.hintLevels,
    status: "active",
    revision: 1,
    presentedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  });
  // PERF-A#13：在变体循环前一次性 IN 查询两个 variant 的 disclosure profile
  // 存在性，避免每个 variant 在 PREPARE 热路径各加一次 SELECT 往返。
  const disclosureHashesV2 = Array.from(new Set(
    [primaryVariant, ...alternativeVariants]
      .map((v) => v.disclosureProfileHash)
      .filter((h): h is string => Boolean(h)),
  ));
  const existingDisclosureHashesV2 = new Set<string>();
  if (disclosureHashesV2.length > 0) {
    const existingDisclosureRowsV2 = await tx
      .select({ profileHash: learningTaskDisclosureProfiles.profileHash })
      .from(learningTaskDisclosureProfiles)
      .where(and(
        eq(learningTaskDisclosureProfiles.workspaceId, workspaceId),
        inArray(learningTaskDisclosureProfiles.profileHash, disclosureHashesV2),
      ));
    for (const r of existingDisclosureRowsV2) existingDisclosureHashesV2.add(r.profileHash);
  }
  for (const [index, variant] of [primaryVariant, ...alternativeVariants].entries()) {
    const closure = plan.closures[variant.variantId];
    await tx.insert(learningTaskVariants).values({
      id: variant.variantId,
      taskId: task.taskId,
      workspaceId,
      userId,
      purpose: task.purpose,
      templateTrustCeiling: task.templateTrustCeiling,
      estimatedActiveSeconds: task.estimatedActiveSeconds,
      interaction: variant.interaction,
      publicPayloadHash: variant.publicPayloadHash,
      inputSchemaHash: variant.inputSchemaHash,
      disclosureProfileHash: variant.disclosureProfileHash,
      privateSolutionHash: closure.privateSolutionHash,
      safetyReportHash: closure.reportHash,
      rubricTargetIds: rubricTargetIdsOf(closure.solution),
      alternatives: [],
      revision: 1,
      status: index === 0 ? "active" : "standby",
      createdAt,
      updatedAt: createdAt,
    });
    await tx.insert(learningTaskPrivateSolutions).values({
      variantId: variant.variantId,
      workspaceId,
      userId,
      solution: closure.solution,
      privateSolutionHash: closure.privateSolutionHash,
      runPlanHash: closure.runPlanHash,
      createdAt,
    });
    await tx.insert(learningTaskSafetyReports).values({
      taskId: task.taskId,
      variantId: variant.variantId,
      workspaceId,
      userId,
      publicPayloadHash: variant.publicPayloadHash,
      inputSchemaHash: variant.inputSchemaHash,
      privateSolutionHash: closure.privateSolutionHash,
      disclosureProfileHash: variant.disclosureProfileHash,
      qualificationProfileHash: null,
      runPlanHash: closure.runPlanHash,
      injectionScan: closure.safetyReport.injectionScan,
      privateLeakageScan: closure.safetyReport.privateLeakageScan,
      schemaValidation: closure.safetyReport.schemaValidation,
      accessibilityProfile: closure.safetyReport.accessibilityProfile,
      activationDecision: closure.safetyReport.activationDecision,
      reportHash: closure.reportHash,
      createdAt,
    });
    // disclosure profile：同 (workspace, profileHash) 幂等复用（同一目标的
    // 确定性变体重建不得撞 hash 唯一约束——23505 修复）。
    // PERF-A#13：存在性已由循环前一次 IN 查询预载，无需每 variant SELECT。
    // M2（2026-08-24 审查）：check-then-insert 在并发 PREPARE 下仍会双双 miss
    // （text variant 的 hash 由 publicPayloadHash 派生，同目标题面恒等），
    // loser 撞 (workspace, profileHash) 唯一索引 → 整个创建事务 500。
    // onConflictDoNothing 把该竞态收敛为幂等复用。
    if (!existingDisclosureHashesV2.has(variant.disclosureProfileHash)) {
      await tx.insert(learningTaskDisclosureProfiles).values({
        variantId: variant.variantId,
        workspaceId,
        userId,
        disclosedFieldPaths: closure.disclosure.disclosedFieldPaths,
        hiddenFieldPaths: closure.disclosure.hiddenFieldPaths,
        answerBearingFieldsHidden: true,
        profileHash: variant.disclosureProfileHash,
        createdAt,
      }).onConflictDoNothing();
    }
  }
  await tx.insert(learningTaskPresentationHistory).values({
    workspaceId,
    userId,
    // 目标是经 runId 关联到 run.origin 判别。
    intent: task.intent,
    publicPayloadHash: primaryVariant.publicPayloadHash,
    interactionFamily: primaryVariant.interaction.kind,
    presentedAt: createdAt,
    outcome: "not_answered",
    exposed: false,
    // 迁移 0143：runId 关联，结算时回填 outcome/exposed（§7.8）。
    runId,
    createdAt,
  });

  const eventValues = [
    { runId, workspaceId, userId, eventType: "learning_run.created", payload: {} },
    { runId, workspaceId, userId, eventType: "learning_run.prepared", payload: { snapshotId: frozen.snapshot.snapshotId } },
    { runId, workspaceId, userId, eventType: "learning_run.started", payload: {} },
    { runId, workspaceId, userId, eventType: "learning_task.presented", payload: { taskId: task.taskId } },
  ];
  for (const [index, event] of eventValues.entries()) {
    await tx.insert(learningRunEvents).values({
      runId: event.runId,
      workspaceId,
      userId,
      sequence: index + 1,
      eventType: event.eventType as never,
      payload: event.payload,
      occurredAt: createdAt,
    });
  }
  await tx.update(learningRuns)
    .set({ eventCursor: eventValues.length, updatedAt: createdAt })
    .where(eq(learningRuns.id, runId));

  return { runId, frozen, snapshotId: frozen.snapshot.snapshotId };
}

// ─── getRunPublicView ────────────────────────────────────────────────────

/**
 * 这一轮里开出去的练习（W4-6 刀三）：`origin ->> 'roundId'` 反查，按开出的先后排。
 *
 * 为什么读侧要单独有这一发：W4-5 ② 把 `note_round` 这个 origin 落地了，但**没有任何
 * 地方读得出来"这一轮里做过一次练习"**——轮次读合同里那一格在那之前是空的。这是那笔
 * producer 欠账的读半边（写半边就是用户在轮次里点「练一道」）。
 *
 * 四格都取自 run 行本身：`phase` 是它走到哪一步，`outcome` 只在**结算之后**才有
 * （`result` 里的那一档），`startedAt` 是它什么时候开的。空数组是真的"还没练过"。
 */
export type NoteRoundPracticeObservation = RoundPracticeV1 & {
  objectiveId: string | null;
  goal: LearningRunPublicV1["goal"];
  gapFacets: RoundNextStepV1["gapFacets"];
  gapFacetsKnown: boolean;
  updatedAt: string;
};

export async function listNoteRoundPractices(
  tx: ApiTransaction,
  scope: { workspaceId: string; userId: string },
  roundId: string,
): Promise<NoteRoundPracticeObservation[]> {
  const rows = await tx
    .select({
      runId: learningRuns.id,
      phase: learningRuns.phase,
      result: learningRuns.result,
      origin: learningRuns.origin,
      goal: learningRuns.goal,
      createdAt: learningRuns.createdAt,
      updatedAt: learningRuns.updatedAt,
    })
    .from(learningRuns)
    .where(and(
      eq(learningRuns.workspaceId, scope.workspaceId),
      eq(learningRuns.userId, scope.userId),
      sql`${learningRuns.origin} ->> 'roundId' = ${roundId}`,
    ))
    .orderBy(asc(learningRuns.createdAt), asc(learningRuns.id));
  return rows.map((row) => {
    const outcome = (row.result as { outcome?: unknown } | null)?.outcome;
    const gapFacets = (row.result as { gapFacets?: unknown } | null)?.gapFacets;
    // 只认得出名字的那几档：`result` 是一个历史形状自由的 jsonb，读侧**不许**
    // 把里面不认识的东西端出去（合同收不下就会在客户端变成"整份拒收"）。
    const parsed = typeof outcome === "string" ? learningRunOutcomeSchema.safeParse(outcome) : null;
    const parsedGaps = taskIntentSchema.array().safeParse(gapFacets);
    const objectiveId = row.origin && typeof row.origin === "object"
      ? (row.origin as { objectiveId?: unknown }).objectiveId : null;
    return {
      runId: row.runId,
      phase: row.phase,
      outcome: parsed?.success ? parsed.data : null,
      startedAt: row.createdAt.toISOString(),
      objectiveId: typeof objectiveId === "string" ? objectiveId : null,
      goal: row.goal as LearningRunPublicV1["goal"],
      gapFacets: parsedGaps.success ? [...new Set(parsedGaps.data)] : [],
      gapFacetsKnown: parsedGaps.success,
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

type V2RunContext = {
  run: Awaited<ReturnType<typeof loadRun>>;
  originV2: LearningRunOriginV2;
  returnTargetV2: LearningRunReturnTargetV2;
  snapshotId: string;
  target: LearningRunTargetPublicV2;
  publishedTargetEligibility: "eligible" | "practice_only" | "blocked";
};

function unsupportedV2Contract(message: string): LearningRunServiceError {
  return new LearningRunServiceError("unsupported_contract", message, 409);
}

function deriveReturnTargetV2(origin: LearningRunOriginV2): LearningRunReturnTargetV2 {
  switch (origin.kind) {
    case "card":
      return { kind: "card", cardId: origin.cardId, objectiveId: origin.objectiveId };
    case "review":
      return {
        kind: "review",
        scheduleId: origin.scheduleId,
        objectiveId: origin.objectiveId,
      };
    case "star_map":
      return {
        kind: "star_map",
        objectiveId: origin.objectiveId,
        lens: origin.lens,
        filter: origin.filter,
        ...(origin.routePlanId ? { routePlanId: origin.routePlanId } : {}),
      };
    case "today":
      return {
        kind: "today",
      };
    case "onboarding":
      return {
        kind: "onboarding",
        destination: origin.sampleMode === "sandbox" ? "today" : "card",
      };
    case "note_round":
      // 回到这一轮所在的笔记（D1 §4.3）；roundId 供读侧定位。
      return { kind: "note_round", roundId: origin.roundId, noteId: origin.noteId };
  }
}

type V2ReturnTargetAvailability = {
  reason: "return_target_deleted" | "permission_revoked";
  fallbackTargetV2: LearningRunReturnTargetV2 | null;
} | null;

/**
 * Resolve only server-proven return destinations. A terminal run may outlive
 * its review schedule/card, so return must not blindly replay the frozen
 * origin as a navigable destination. A review target may fall back to the
 * same active objective's card; otherwise the V2 contract stays unavailable.
 */
async function resolveV2ReturnTargetAvailability(
  tx: ApiTransaction,
  input: RunScope,
  context: V2RunContext,
): Promise<V2ReturnTargetAvailability> {
  const target = context.returnTargetV2;
  if (target.kind === "today" || target.kind === "onboarding" || target.kind === "star_map") {
    return null;
  }

  // 笔记轮次：落点由**轮次行还在不在**证明（当前没有删除轮次的入口；行没了
  // 属理论路径），回退到 today——与其他"目标消失"的回退同一形状。
  if (target.kind === "note_round") {
    const roundRows = await tx
      .select({ id: noteLearningRounds.id })
      .from(noteLearningRounds)
      .where(and(
        eq(noteLearningRounds.id, target.roundId),
        eq(noteLearningRounds.workspaceId, input.workspaceId),
        eq(noteLearningRounds.userId, input.userId),
      ))
      .limit(1);
    if (roundRows[0]) return null;
    return { reason: "return_target_deleted", fallbackTargetV2: { kind: "today" } };
  }

  const objectiveRows = await tx
    .select({ objectiveId: learningObjectivesV2.objectiveId })
    .from(learningObjectivesV2)
    .where(and(
      eq(learningObjectivesV2.workspaceId, input.workspaceId),
      eq(learningObjectivesV2.objectiveId, target.objectiveId),
      eq(learningObjectivesV2.lifecycle, "active"),
    ))
    .limit(1);
  const activeObjective = objectiveRows[0];
  const activeCardRows = activeObjective
    ? await tx
      .select({ cardId: learningCardsV2.cardId })
      .from(learningCardsV2)
      .where(and(
        eq(learningCardsV2.workspaceId, input.workspaceId),
        eq(learningCardsV2.objectiveId, target.objectiveId),
        eq(learningCardsV2.lifecycle, "active"),
      ))
      .limit(1)
    : [];
  const activeCard = activeCardRows[0];

  if (target.kind === "card") {
    if (activeCard?.cardId === target.cardId) return null;
    return { reason: "return_target_deleted", fallbackTargetV2: null };
  }

  const scheduleRows = await tx
    .select({ id: reviewSchedules.id })
    .from(reviewSchedules)
    .where(and(
      eq(reviewSchedules.id, target.scheduleId),
      eq(reviewSchedules.workspaceId, input.workspaceId),
      eq(reviewSchedules.userId, input.userId),
      eq(reviewSchedules.subjectType, "card"),
      eq(reviewSchedules.subjectId, target.objectiveId),
    ))
    .limit(1);
  if (scheduleRows[0]) return null;
  if (activeCard) {
    return {
      reason: "return_target_deleted",
      fallbackTargetV2: {
        kind: "card",
        cardId: activeCard.cardId,
        objectiveId: target.objectiveId,
      },
    };
  }
  return { reason: "return_target_deleted", fallbackTargetV2: null };
}

function projectLearningRunPublicSnapshotV2(
  context: V2RunContext,
  view: LearningRunPublicV1,
): LearningRunPublicSnapshotV2 {
  return learningRunPublicSnapshotV2Schema.parse({
    version: 2,
    runId: context.run.id,
    snapshotId: context.snapshotId,
    originV2: context.originV2,
    target: context.target,
    returnTargetV2: context.returnTargetV2,
    phase: learningRunPhaseV2Schema.parse(view.phase),
    runRevision: view.revision,
    runtimeEpoch: view.runtimeEpoch,
    activeSecondsUsed: view.activeSecondsUsed,
    timeBudgetSeconds: view.timeBudgetSeconds,
    activeTask: view.activeTask,
    allowedActions: buildLearningRunAllowedActionsV2(view),
    publishedTargetEligibility: context.publishedTargetEligibility,
    // 审计 F28：只有 checkpoint 相位才有"为什么停在这里"；其他相位不编造原因。
    checkpointReason: view.phase === "checkpoint" ? view.checkpoint?.reasonCode ?? "input_incomplete" : null,
  });
}


async function loadV2RunContext(
  tx: ApiTransaction,
  input: RunScope & { runId: string },
): Promise<V2RunContext> {
  const run = await loadRun(tx, input, input.runId);
  const contractRows = await tx
    .select({ snapshotId: learningRunPrivateContracts.snapshotId })
    .from(learningRunPrivateContracts)
    .where(and(
      eq(learningRunPrivateContracts.runId, run.id),
      eq(learningRunPrivateContracts.workspaceId, input.workspaceId),
      eq(learningRunPrivateContracts.userId, input.userId),
    ))
    .limit(1);
  const snapshotId = contractRows[0]?.snapshotId;
  if (!snapshotId) throw unsupportedV2Contract("该 run 没有 V2 snapshot binding");

  const originParsed = learningRunOriginV2Schema.safeParse(run.origin);
  if (!originParsed.success) throw unsupportedV2Contract("该 run 不是严格 V2 origin");
  const snapshot = await loadFrozenTargetSnapshotV2(tx, input.workspaceId, run.id);
  if (!snapshot || snapshot.snapshotId !== snapshotId || snapshot.runId !== run.id || snapshot.userId !== input.userId) {
    throw unsupportedV2Contract("V2 snapshot binding 不完整");
  }
  const target = learningRunTargetPublicV2Schema.parse(buildLearningRunTargetPublicV2(snapshot));
  const returnTargetV2 = learningRunReturnTargetV2Schema.parse(deriveReturnTargetV2(originParsed.data));
  return {
    run,
    originV2: originParsed.data,
    returnTargetV2,
    snapshotId,
    target,
    publishedTargetEligibility: snapshot.publishedTargetEligibility,
  };
}

/** Strict V2 public snapshot; server-private target fields never leave this adapter. */
export async function getLearningRunPublicSnapshotV2(
  tx: ApiTransaction,
  input: RunScope & { runId: string },
): Promise<LearningRunPublicSnapshotV2> {
  const context = await loadV2RunContext(tx, input);
  const view = await getRunPublicView(tx, input);
  return projectLearningRunPublicSnapshotV2(context, view);
}

/**
 * Projects the exact V1 view stored in the action ledger into the public V2
 * response. This keeps an idempotent replay tied to the original response
 * snapshot instead of silently replacing it with the run's current state.
 */
export async function getLearningRunPublicSnapshotV2FromView(
  tx: ApiTransaction,
  input: RunScope & { runId: string },
  view: LearningRunPublicV1,
): Promise<LearningRunPublicSnapshotV2> {
  const context = await loadV2RunContext(tx, input);
  return projectLearningRunPublicSnapshotV2(context, view);
}

/**
 * 答后反馈（2026-09-18）：取本次 run 最新一次已出结论的评估，随结果载荷下发
 * 逐 rubric 判定与给用户看的一句说明。老 run / 尚未评估的 run 没有这份数据，
 * 字段保持可选，不阻断结果读取。
 */
/**
 * 本轮交上来的原文（审计 F29）。只取**已锁**的 artifact——未锁的是草稿，不算"交过"；
 * 同一个任务被补充证据覆盖过两次时取最后一次（用户要看到的是那一轮真正结算的内容）。
 * 结构化作答（顺序/连线/选择）没有单句原文，跳过而不是替它编一句。
 */
function projectLearningRunResultV2(
  context: V2RunContext,
  rawResult: unknown,
  assessment?: LearningRunResultAssessmentV2,
  submitted: LearningRunSubmittedAnswerV2[] = [],
): LearningRunResultV2 {
  const parsed = learningRunResultSchema.safeParse(rawResult);
  if (!parsed.success) throw unsupportedV2Contract("V2 result 的 nested result 不是 canonical 结果");
  return learningRunResultV2Schema.parse({
    version: 2,
    runId: context.run.id,
    snapshotId: context.snapshotId,
    originV2: context.originV2,
    outcome: parsed.data.outcome,
    demonstratedFacets: parsed.data.demonstratedFacets,
    // 练习缺口以本次逐项判定为准；无法评估不等于用户能力缺失。
    gapFacets: parsed.data.outcome === "practice_completed" && assessment?.rubricResults.length
      ? uncoveredFacets(assessment.rubricResults)
      : parsed.data.gapFacets,
    scheduleImpact: parsed.data.scheduleImpact,
    returnTargetV2: context.returnTargetV2,
    ...(parsed.data.projection ? { projection: parsed.data.projection } : {}),
    ...(assessment ? { assessment } : {}),
    ...(submitted.length > 0 ? { submitted } : {}),
  });
}


async function loadResultSubmissionsV2(
  tx: ApiTransaction,
  runId: string,
): Promise<LearningRunSubmittedAnswerV2[]> {
  const rows = await tx
    .select({
      taskId: learningArtifacts.taskId,
      sequence: learningTasks.sequence,
      payload: learningArtifacts.payload,
    })
    .from(learningArtifacts)
    .innerJoin(learningTasks, eq(learningTasks.id, learningArtifacts.taskId))
    .where(and(
      eq(learningArtifacts.runId, runId),
      eq(learningArtifacts.status, "locked"),
    ))
    .orderBy(asc(learningTasks.sequence), asc(learningArtifacts.revision));
  // "同一 sequence 只有一条"实际由部分唯一索引 `learning_artifacts_task_locked_unique_idx`
  // 保证（一个任务只能有一条 locked），这里的 Map 只是防止有人日后放宽那条索引时静默多报。
  const latest = new Map<number, { taskId: string; kind: "text" | "voice"; text: string }>();
  for (const row of rows) {
    const parsed = artifactPayloadSchema.safeParse(row.payload);
    if (!parsed.success) continue;
    if (parsed.data.kind === "text") {
      latest.set(row.sequence, { taskId: row.taskId, kind: "text", text: parsed.data.text });
    } else if (parsed.data.kind === "voice") {
      latest.set(row.sequence, { taskId: row.taskId, kind: "voice", text: parsed.data.confirmedTranscript });
    }
  }
  return [...latest.entries()].map(([sequence, value]) => ({ sequence, ...value }));
}

async function loadResultAssessmentV2(
  tx: ApiTransaction,
  runId: string,
): Promise<LearningRunResultAssessmentV2 | undefined> {
  const rows = await tx
    .select({
      id: learningAssessments.id,
      source: learningAssessments.source,
      status: learningAssessments.status,
      trustClass: learningAssessments.trustClass,
      rubricResults: learningAssessments.rubricResults,
    })
    .from(learningAssessments)
    .where(and(
      eq(learningAssessments.runId, runId),
      inArray(learningAssessments.status, ["completed", "not_assessable"]),
    ))
    .orderBy(desc(learningAssessments.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  const parsed = learningRunResultAssessmentV2Schema.safeParse({
    // §14.2：争议与更正都挂在**一次具体判定**上，界面要开得起来先得拿得到这个 id。
    // 与 `submitted` 同一个理由做成可选——老 result 里没有这一格，解析不过就整块
    // 不投影，而不是拿一个猜出来的 id 去提交一份申诉。
    assessmentId: row.id,
    source: row.source,
    status: row.status,
    trustClass: row.trustClass,
    rubricResults: row.rubricResults ?? [],
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * 答后揭示（2026-09-18）：旅程形成可信结论后，学习者有权看到这次到底想考什么
 * 的完整答案与教学支撑。数据取自冻结的 Target Snapshot（与卡片当前版本解耦，
 * 不需要 CAS），并在 learning_exposures_v2 记一笔 answer_reveal —— 答案可以看，
 * 但要记账，未来的验证规划依旧能看到「同一提示最近被揭示过」。
 * 前提是 run.result 已存在：没有可信结论就不揭示，否则等于让答案绕过提取练习。
 */
export async function revealRunTargetV2(
  tx: ApiTransaction,
  input: RunScope & { runId: string },
): Promise<LearningRunTargetRevealV2> {
  const runRows = await tx
    .select({
      id: learningRuns.id,
      workspaceId: learningRuns.workspaceId,
      userId: learningRuns.userId,
      result: learningRuns.result,
    })
    .from(learningRuns)
    .where(and(eq(learningRuns.id, input.runId), eq(learningRuns.workspaceId, input.workspaceId)))
    .limit(1);
  const run = runRows[0];
  if (!run) throw new LearningRunServiceError("run_not_found", "学习旅程不存在", 404);
  if (!run.result) {
    throw new LearningRunServiceError("reveal_not_available", "这次旅程还没有形成可信结果，暂不能揭示答案", 409);
  }

  const snapshotRows = await tx
    .select()
    .from(learningTargetSnapshotsV2)
    .where(and(
      eq(learningTargetSnapshotsV2.runId, run.id),
      eq(learningTargetSnapshotsV2.workspaceId, input.workspaceId),
    ))
    .orderBy(desc(learningTargetSnapshotsV2.frozenAt))
    .limit(1);
  const snapshot = snapshotRows[0];
  if (!snapshot) throw new LearningRunServiceError("reveal_not_available", "这次旅程没有冻结的目标快照", 404);

  const target = snapshot.target as {
    canonicalAnswer?: unknown;
    learningSupport?: { explanation?: string; boundary?: string; misconception?: string; workedExample?: string };
  };
  const answerText = target.canonicalAnswer
    ? extractAnswerText(target.canonicalAnswer as never).trim()
    : "";
  if (!answerText) {
    throw new LearningRunServiceError("reveal_not_available", "这次旅程的目标没有可揭示的文字答案", 409);
  }
  const support = {
    explanation: (target.learningSupport?.explanation ?? "").trim(),
    ...(target.learningSupport?.boundary?.trim() ? { boundary: target.learningSupport.boundary.trim() } : {}),
    ...(target.learningSupport?.misconception?.trim() ? { misconception: target.learningSupport.misconception.trim() } : {}),
    ...(target.learningSupport?.workedExample?.trim() ? { workedExample: target.learningSupport.workedExample.trim() } : {}),
  };

  /**
   * 同一 run 只记一笔：重复点开结果页不产生新账目（§16.19「重试不再次记学习」）。
   * 但**第二次回出去的 id 必须是库里那一笔的**——两次调用回两个 id，合同里
   * `exposureId` 那一格就成了第二个来源（这一族此前 0 条用例读，见 39d §19 的 W6-3 那格）。
   */
  const idempotencyKey = `run-reveal:${run.id}`;
  const inserted = await tx.insert(learningExposuresV2).values({
    workspaceId: input.workspaceId,
    exposureId: crypto.randomUUID(),
    userId: run.userId,
    objectiveId: snapshot.objectiveId,
    objectiveRevision: snapshot.objectiveRevision,
    cardId: snapshot.cardId,
    cardRevision: snapshot.cardRevision,
    exposureKind: "answer_reveal",
    contextHash: computeExposureScopeIdV2({ workspaceId: input.workspaceId, objectiveId: snapshot.objectiveId }),
    idempotencyKey,
  }).onConflictDoNothing().returning({ exposureId: learningExposuresV2.exposureId });
  // 撞了唯一键 ⇒ 那一笔一定在（同一发事务里刚写的），取回来的是它的 id，不是猜的。
  const exposureId = inserted[0]?.exposureId ?? (await tx
    .select({ exposureId: learningExposuresV2.exposureId })
    .from(learningExposuresV2)
    .where(and(
      eq(learningExposuresV2.workspaceId, input.workspaceId),
      eq(learningExposuresV2.userId, run.userId),
      eq(learningExposuresV2.idempotencyKey, idempotencyKey),
    ))
    .limit(1))[0].exposureId;

  return learningRunTargetRevealV2Schema.parse({
    version: 2,
    runId: run.id,
    snapshotId: snapshot.snapshotId,
    objectiveId: snapshot.objectiveId,
    objectiveRevision: snapshot.objectiveRevision,
    cardId: snapshot.cardId,
    cardRevision: snapshot.cardRevision,
    answerText,
    support,
    exposureId,
    exposedAt: new Date().toISOString(),
  });
}

export async function getResultPayloadV2(
  tx: ApiTransaction,
  input: RunScope & { runId: string },
): Promise<GetLearningRunResultResponseV2> {
  const context = await loadV2RunContext(tx, input);
  const base = {
    version: 2 as const,
    runId: context.run.id,
    snapshotId: context.snapshotId,
    originV2: context.originV2,
    returnTargetV2: context.returnTargetV2,
  };
  if (context.run.result) {
    const assessment = await loadResultAssessmentV2(tx, context.run.id);
    const submitted = await loadResultSubmissionsV2(tx, context.run.id);
    return getLearningRunResultResponseV2Schema.parse({
      ...base,
      status: "learning_result",
      httpStatus: 200,
      result: projectLearningRunResultV2(context, context.run.result, assessment, submitted),
    });
  }
  if (context.run.phase === "ended" || context.run.phase === "cancelled" || context.run.phase === "stale") {
    return getLearningRunResultResponseV2Schema.parse({
      ...base,
      status: "terminal_without_result",
      httpStatus: 200,
      phase: context.run.phase,
      reasonCode: context.run.terminalReasonCode ?? "user_ended",
    });
  }
  return getLearningRunResultResponseV2Schema.parse({
    ...base,
    status: "pending",
    httpStatus: 202,
    phase: learningRunPhaseV2Schema.parse(context.run.phase),
    runRevision: context.run.revision,
  });
}

export async function getReturnContractV2(
  tx: ApiTransaction,
  input: RunScope & { runId: string },
): Promise<LearningRunReturnContractV2> {
  const context = await loadV2RunContext(tx, input);
  const currentContract = learningRunReturnContractSchema.safeParse(await getReturnContract(tx, input));
  if (!currentContract.success) throw unsupportedV2Contract("当前 return contract 无法安全读取");
  const base = {
    version: 2 as const,
    runId: context.run.id,
    snapshotId: context.snapshotId,
    originV2: context.originV2,
    returnTargetV2: context.returnTargetV2,
  };
  if (currentContract.data.status !== "run_active" && currentContract.data.status !== "unavailable") {
    const availability = await resolveV2ReturnTargetAvailability(tx, input, context);
    if (availability) {
      return learningRunReturnContractV2Schema.parse({
        ...base,
        status: "unavailable",
        reason: availability.reason,
        fallbackTargetV2: availability.fallbackTargetV2,
      });
    }
  }
  switch (currentContract.data.status) {
    case "run_active":
      return learningRunReturnContractV2Schema.parse({
        ...base,
        status: "run_active",
        runPhase: currentContract.data.runPhase,
      });
    case "no_projection_change":
      return learningRunReturnContractV2Schema.parse({
        ...base,
        status: "no_projection_change",
        sourceChange: { kind: "none" },
      });
    case "projection_pending":
      return learningRunReturnContractV2Schema.parse({
        ...base,
        status: "projection_pending",
        sourceChange: currentContract.data.sourceChange,
        currentCheckpoint: currentContract.data.currentCheckpoint,
        retryAfterMs: currentContract.data.retryAfterMs,
      });
    case "ready":
      return learningRunReturnContractV2Schema.parse({
        ...base,
        status: "ready",
        sourceChange: currentContract.data.sourceChange,
        targetCheckpoint: currentContract.data.targetCheckpoint,
        changeSetId: currentContract.data.changeSetId,
      });
    case "unavailable":
      return learningRunReturnContractV2Schema.parse({
        ...base,
        status: "unavailable",
        reason: currentContract.data.reason,
        fallbackTargetV2: currentContract.data.fallbackTarget ? context.returnTargetV2 : null,
      });
  }
}

export async function putDraft(
  tx: ApiTransaction,
  input: DraftInput,
  now: () => Date = () => new Date(),
): Promise<unknown> {
  const draftRequestHash = sha256Hex(JSON.stringify({
    version: input.requestContext?.version ?? 1,
    ...(input.requestContext?.snapshotId ? { snapshotId: input.requestContext.snapshotId } : {}),
    runId: input.runId,
    taskId: input.taskId,
    variantId: input.variantId,
    variantRevision: input.variantRevision,
    taskRevision: input.taskRevision,
    expectedDraftRevision: input.expectedDraftRevision,
    payload: input.payload,
    rendererState: input.rendererState,
  }));
  // M1（2026-08-24 审查）：draft 幂等边界必须与 action 一致地串行化。此前两个
  // 同 idempotencyKey 的并发 PUT 会同时 miss ledger 并各自执行写入，loser 撞
  // ledger 唯一索引 → 裸 23505/500（loadRun 未加 FOR UPDATE，run 行锁不覆盖）。
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`v2-draft:${input.workspaceId}:${input.userId}:${input.runId}:${input.idempotencyKey}`}, 0)
    )
  `);
  const existingLedger = await tx
    .select({
      responseStatus: learningRunActionLedger.responseStatus,
      responseSnapshot: learningRunActionLedger.responseSnapshot,
      requestHash: learningRunActionLedger.requestHash,
    })
    .from(learningRunActionLedger)
    .where(and(
      eq(learningRunActionLedger.runId, input.runId),
      eq(learningRunActionLedger.idempotencyKey, input.idempotencyKey),
    ))
    .limit(1);
  if (existingLedger[0]) {
    if (existingLedger[0].requestHash !== draftRequestHash) throw idempotencyConflict();
    if (existingLedger[0].responseStatus === "success" && existingLedger[0].responseSnapshot) {
      return existingLedger[0].responseSnapshot;
    }
    throw new LearningRunServiceError("draft_in_progress", "草稿保存正在处理", 409);
  }
  input.assertDraftAllowed?.();
  const run = await loadRun(tx, input, input.runId);
  if (!["active", "paused"].includes(run.phase)) throw invalidPhase(run.phase, "active");
  if (run.activeTaskId !== input.taskId) throw new LearningRunServiceError("task_not_active", "该任务不是当前任务", 409);

  const taskRows = await tx.select().from(learningTasks).where(and(eq(learningTasks.id, input.taskId), eq(learningTasks.runId, run.id))).limit(1);
  if (!taskRows[0]) throw new LearningRunServiceError("task_not_found", "任务不存在", 404);
  if (taskRows[0].revision !== input.taskRevision) throw staleTaskRevision(taskRows[0].revision, input.taskRevision);
  const variantRows = await tx.select().from(learningTaskVariants)
    .where(and(eq(learningTaskVariants.id, input.variantId), eq(learningTaskVariants.taskId, input.taskId), eq(learningTaskVariants.status, "active")))
    .limit(1);
  if (!variantRows[0]) throw variantNotAuthorized();
  if (variantRows[0].revision !== input.variantRevision) throw variantNotAuthorized();

  const at = now();
  // §12.7 CAS：draft 行锁（FOR UPDATE）防并发丢更新。
  const existing = await tx
    .select()
    .from(learningTaskDrafts)
    .where(eq(learningTaskDrafts.taskId, input.taskId))
    .limit(1)
    .for("update")
    .execute();
  const current = existing[0];
  // 无草稿行视为版本 0：客户端首次保存发 expectedDraftRevision=0（见 V2 合同
  // min(0)），此前 undefined !== 0 导致首次保存必然 409。
  if (input.expectedDraftRevision !== null && (current?.draftRevision ?? 0) !== input.expectedDraftRevision) {
    throw new LearningRunServiceError("stale_draft_revision", "草稿已变化，请重新保存", 409, {
      currentDraftRevision: current?.draftRevision ?? null,
    });
  }
  const draftRevision = (current?.draftRevision ?? 0) + 1;
  const expiresAt = new Date(at.getTime() + 24 * 60 * 60 * 1000);
  // §12.7：静态加密落库——payload 与 rendererState 一起加密（rendererState
  // 可能含光标/选中位置，不得明文）；无密钥 fail closed（绝不落明文）。
  const encrypted = encryptDraftPayload({
    payload: input.payload,
    rendererState: input.rendererState,
  });
  if (!isDraftEncryptionAvailable() || encrypted === null) {
    throw new LearningRunServiceError("draft_encryption_unavailable", "草稿保存暂不可用", 409);
  }
  if (current) {
    await tx.update(learningTaskDrafts).set({
      variantId: input.variantId,
      taskRevision: input.taskRevision,
      draftRevision,
      payload: encrypted as never,
      rendererState: {} as never,
      savedAt: at,
      expiresAt,
      updatedAt: at,
    }).where(eq(learningTaskDrafts.taskId, input.taskId));
  } else {
    await tx.insert(learningTaskDrafts).values({
      runId: run.id,
      taskId: input.taskId,
      variantId: input.variantId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      taskRevision: input.taskRevision,
      draftRevision,
      payload: encrypted as never,
      rendererState: {} as never,
      savedAt: at,
      expiresAt,
      createdAt: at,
      updatedAt: at,
    });
  }
  const receipt = {
    version: 1,
    runId: run.id,
    taskId: input.taskId,
    variantId: input.variantId,
    // V1 callers keep the historical receipt shape. V2 callers need this
    // internal metadata persisted in the idempotency ledger; the route
    // adapter promotes it to the strict V2 receipt and therefore preserves
    // the original runRevision on response-loss replay.
    ...(input.requestContext?.version === 2 ? { runRevision: run.revision } : {}),
    taskRevision: input.taskRevision,
    draftRevision,
    savedAt: at.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  await tx.insert(learningRunActionLedger).values({
    runId: run.id,
    workspaceId: input.workspaceId,
    userId: input.userId,
    actionKind: "draft",
    idempotencyKey: input.idempotencyKey,
    requestHash: draftRequestHash,
    responseStatus: "success",
    responseSnapshot: receipt,
    acceptedActionId: crypto.randomUUID(),
    createdAt: at,
    updatedAt: at,
  });
  return receipt;
}

/** 读取当前草稿（跨设备恢复；解密失败返回 payload=null，绝不伪造）。 */
export async function getDraft(
  tx: ApiTransaction,
  input: RunScope & { runId: string; taskId: string },
): Promise<unknown | null> {
  await loadRun(tx, input, input.runId);
  const rows = await tx
    .select()
    .from(learningTaskDrafts)
    .where(and(
      eq(learningTaskDrafts.taskId, input.taskId),
      eq(learningTaskDrafts.workspaceId, input.workspaceId),
      eq(learningTaskDrafts.userId, input.userId),
    ))
    .limit(1);
  const draft = rows[0];
  if (!draft) return null;
  if (!isDraftEncryptionAvailable()) {
    throw new LearningRunServiceError("draft_encryption_unavailable", "草稿恢复暂不可用", 409);
  }
  const decrypted = decryptDraftPayload(draft.payload) as {
    payload: unknown;
    rendererState: unknown;
  } | null;
  if (decrypted === null) {
    // 密文损坏：fail closed（返回空 payload，绝不伪造）。
    return {
      version: 1,
      runId: draft.runId,
      taskId: draft.taskId,
      variantId: draft.variantId,
      taskRevision: draft.taskRevision,
      draftRevision: draft.draftRevision,
      payload: null,
      rendererState: {},
      savedAt: draft.savedAt.toISOString(),
      expiresAt: draft.expiresAt.toISOString(),
    };
  }
  return {
    version: 1,
    runId: draft.runId,
    taskId: draft.taskId,
    variantId: draft.variantId,
    taskRevision: draft.taskRevision,
    draftRevision: draft.draftRevision,
    payload: decrypted.payload,
    rendererState: decrypted.rendererState,
    savedAt: draft.savedAt.toISOString(),
    expiresAt: draft.expiresAt.toISOString(),
  };
}

// ─── submitArtifact（§12.3 原子提交）─────────────────────────────────────

/**
 * §16.2/§16.7：Artifact lock 的 epoch 复验。FOR UPDATE 锁定全部
 * evidence eligibility 行（稳定 id 顺序），
 *   复验 expectedObjectiveLifecycleEpoch 与每个 expectedEvidenceEligibilityEpoch；
 *   任何 restricted/revoked 或 epoch 漂移 → fail closed。
 */
async function revalidateV2ArtifactEpochs(
  tx: ApiTransaction,
  runId: string,
): Promise<void> {
  const contractRows = await tx
    .select({
      workspaceId: learningRunPrivateContracts.workspaceId,
      expectedObjectiveLifecycleEpoch: learningRunPrivateContracts.expectedObjectiveLifecycleEpoch,
    })
    .from(learningRunPrivateContracts)
    .where(eq(learningRunPrivateContracts.runId, runId))
    .limit(1);
  const contract = contractRows[0];
  if (!contract) throw new LearningRunServiceError("v2_snapshot_missing", "run 缺少 private contract", 409);

  const snapshot = await loadFrozenTargetSnapshotV2(tx, contract.workspaceId, runId);
  if (!snapshot) throw new LearningRunServiceError("v2_snapshot_missing", "V2 run 缺少 frozen snapshot", 409);

  // 1. 复验 objective lifecycle：仍 active 且 epoch 未漂移。
  const objRows = await tx
    .select({ lifecycle: learningObjectivesV2.lifecycle, lifecycleEpoch: learningObjectivesV2.lifecycleEpoch })
    .from(learningObjectivesV2)
    .where(and(
      eq(learningObjectivesV2.workspaceId, snapshot.workspaceId),
      eq(learningObjectivesV2.objectiveId, snapshot.target.objectiveId),
    ))
    .limit(1);
  const obj = objRows[0];
  if (!obj || obj.lifecycle !== "active") {
    throw new LearningRunServiceError("v2_artifact_objective_stale", "objective 生命周期已变更", 409);
  }
  if (contract.expectedObjectiveLifecycleEpoch !== null
      && obj.lifecycleEpoch !== contract.expectedObjectiveLifecycleEpoch) {
    throw new LearningRunServiceError("v2_artifact_objective_epoch_drift", "objective lifecycle epoch 漂移", 409);
  }

  // 2. 按稳定 evidence id 顺序锁定 eligibility 行并逐一复验（usable + epoch 匹配）。
  const evidence = [...snapshot.target.evidence].sort((a, b) => a.evidenceSnapshotId.localeCompare(b.evidenceSnapshotId));
  if (evidence.length === 0) return;
  // 批量锁定全部 evidence 行（一次 round-trip），按 evidenceSnapshotId 稳定排序
  // 保持锁顺序一致，避免逐条 SELECT ... FOR UPDATE 的 N 次往返与锁持有时间延长。
  const evidenceIds = evidence.map((e) => e.evidenceSnapshotId);
  const evRows = await tx
    .select({
      evidenceSnapshotId: evidenceEligibilityStatesV2.evidenceSnapshotId,
      status: evidenceEligibilityStatesV2.status,
      eligibilityEpoch: evidenceEligibilityStatesV2.eligibilityEpoch,
    })
    .from(evidenceEligibilityStatesV2)
    .where(and(
      eq(evidenceEligibilityStatesV2.workspaceId, snapshot.workspaceId),
      inArray(evidenceEligibilityStatesV2.evidenceSnapshotId, evidenceIds),
    ))
    .for("update")
    .orderBy(evidenceEligibilityStatesV2.evidenceSnapshotId);
  const byEvidenceId = new Map(evRows.map((r) => [r.evidenceSnapshotId, r]));
  for (const e of evidence) {
    const row = byEvidenceId.get(e.evidenceSnapshotId);
    if (!row || row.status !== "usable") {
      throw new LearningRunServiceError("v2_artifact_evidence_not_usable",
        `evidence ${e.evidenceSnapshotId} 状态 ${row?.status ?? "missing"}`, 409);
    }
    if (row.eligibilityEpoch !== e.expectedEvidenceEligibilityEpoch) {
      throw new LearningRunServiceError("v2_artifact_evidence_epoch_drift",
        `evidence ${e.evidenceSnapshotId} epoch 漂移`, 409);
    }
  }
}

export async function submitArtifact(
  tx: ApiTransaction,
  input: SubmitInput,
  now: () => Date = () => new Date(),
): Promise<unknown> {
  const run = await loadRun(tx, input, input.runId, true);

  // 幂等：同 idempotencyKey 重放返回原 receipt（不重复锁定）；同 key 不同
  // 内容 → idempotency_conflict。必须先于 phase/revision 校验——提交成功后
  // run 已进入 assessing，重放必须仍然安全返回原回执。
  const submissionRequestHash = sha256Hex(JSON.stringify({
    version: input.requestContext?.version ?? 1,
    ...(input.requestContext?.snapshotId ? { snapshotId: input.requestContext.snapshotId } : {}),
    runId: input.runId,
    taskId: input.taskId,
    variantId: input.request.variantId,
    variantRevision: input.request.variantRevision,
    runRevision: input.request.runRevision,
    taskRevision: input.request.taskRevision,
    inputSchemaHash: input.request.inputSchemaHash,
    payload: input.request.payload,
    baseArtifactId: input.request.baseArtifactId ?? null,
    baseRevision: input.request.baseRevision ?? null,
  }));
  const ledgerRows = await tx
    .select({
      responseSnapshot: learningRunActionLedger.responseSnapshot,
      responseStatus: learningRunActionLedger.responseStatus,
      requestHash: learningRunActionLedger.requestHash,
    })
    .from(learningRunActionLedger)
    .where(and(
      eq(learningRunActionLedger.runId, run.id),
      eq(learningRunActionLedger.idempotencyKey, input.request.idempotencyKey),
    ))
    .limit(1);
  if (ledgerRows[0]) {
    if (ledgerRows[0].requestHash !== submissionRequestHash) throw idempotencyConflict();
    if (ledgerRows[0].responseStatus === "success" && ledgerRows[0].responseSnapshot) {
      return ledgerRows[0].responseSnapshot;
    }
    throw new LearningRunServiceError("submission_in_progress", "提交正在处理", 409);
  }

  if (run.phase !== "active") throw invalidPhase(run.phase, "active");
  if (run.revision !== input.request.runRevision) throw staleRunRevision(run.revision, input.request.runRevision);
  if (run.activeTaskId !== input.taskId) throw new LearningRunServiceError("task_not_active", "该任务不是当前任务", 409);

  const taskRows = await tx.select().from(learningTasks).where(and(eq(learningTasks.id, input.taskId), eq(learningTasks.runId, run.id))).limit(1);
  if (!taskRows[0]) throw new LearningRunServiceError("task_not_found", "任务不存在", 404);
  const task = taskRows[0];
  if (task.revision !== input.request.taskRevision) throw staleTaskRevision(task.revision, input.request.taskRevision);

  const variantRows = await tx.select().from(learningTaskVariants)
    .where(and(eq(learningTaskVariants.id, input.request.variantId), eq(learningTaskVariants.taskId, input.taskId), eq(learningTaskVariants.status, "active")))
    .limit(1);
  if (!variantRows[0]) throw variantNotAuthorized();
  const variant = variantRows[0];
  if (variant.revision !== input.request.variantRevision) throw variantNotAuthorized();
  if (variant.inputSchemaHash !== input.request.inputSchemaHash) throw variantNotAuthorized();

  // payload ↔ interaction 匹配（§12.3：结构化答案不得冒充文本；text/voice 只允许开放回答；
  // P4 结构 payload 做 allowlist 校验：ID 集合必须属于当前 Variant）。
  const payload = input.request.payload;
  const interaction = variant.interaction as {
    kind: string;
    publicTokenIds?: string[];
    publicNodeIds?: string[];
    allowedEdgeKinds?: string[];
    publicElementIds?: string[];
    allowedOperationKinds?: string[];
    replacementOptionIds?: string[];
    publicOptionIds?: string[];
    publicLeftIds?: string[];
    publicRightIds?: string[];
  };
  if (interaction.kind === "text_response" && payload.kind !== "text" && payload.kind !== "declared_unable") {
    throw new LearningRunServiceError("payload_variant_mismatch", "作答类型与题目不符", 400);
  }
  if (interaction.kind === "voice_teachback" && payload.kind !== "voice" && payload.kind !== "declared_unable") {
    throw new LearningRunServiceError("payload_variant_mismatch", "作答类型与题目不符", 400);
  }
  if (interaction.kind === "ordering") {
    if (payload.kind !== "ordering") throw new LearningRunServiceError("payload_variant_mismatch", "作答类型与题目不符", 400);
    const allowed = new Set(interaction.publicTokenIds ?? []);
    const ordered = payload.orderedTokenIds;
    if (ordered.length !== allowed.size || ordered.some((id) => !allowed.has(id)) || new Set(ordered).size !== ordered.length) {
      throw new LearningRunServiceError("payload_variant_mismatch", "排序内容与题目不符", 400);
    }
  }
  if (interaction.kind === "relation_canvas") {
    if (payload.kind !== "relation") throw new LearningRunServiceError("payload_variant_mismatch", "作答类型与题目不符", 400);
    const nodes = new Set(interaction.publicNodeIds ?? []);
    const edgeKinds = new Set(interaction.allowedEdgeKinds ?? []);
    if (payload.edges.length > 16) {
      throw new LearningRunServiceError("payload_variant_mismatch", "关系数量超出题目允许范围", 400);
    }
    for (const edge of payload.edges) {
      if (!nodes.has(edge.fromNodeId) || !nodes.has(edge.toNodeId) || !edgeKinds.has(edge.edgeKind)) {
        throw new LearningRunServiceError("payload_variant_mismatch", "关系内容与题目不符", 400);
      }
    }
  }
  if (interaction.kind === "repair") {
    if (payload.kind !== "repair") throw new LearningRunServiceError("payload_variant_mismatch", "作答类型与题目不符", 400);
    const elements = new Set(interaction.publicElementIds ?? []);
    const ops = new Set(interaction.allowedOperationKinds ?? []);
    const options = new Set(interaction.replacementOptionIds ?? []);
    if (payload.operations.length > 16) {
      throw new LearningRunServiceError("payload_variant_mismatch", "修复操作数量超出题目允许范围", 400);
    }
    for (const operation of payload.operations) {
      if (!ops.has(operation.op)) {
        throw new LearningRunServiceError("payload_variant_mismatch", "修复操作与题目不符", 400);
      }
      const elementKey = operation.op === "insert"
        ? (operation as { afterElementId?: string | null }).afterElementId ?? null
        : (operation as { elementId?: string }).elementId ?? null;
      if (elementKey !== null && !elements.has(elementKey)) {
        throw new LearningRunServiceError("payload_variant_mismatch", "修复操作与题目不符", 400);
      }
      const optionKey = (operation as { replacementOptionId?: string }).replacementOptionId;
      if (optionKey !== undefined && !options.has(optionKey)) {
        throw new LearningRunServiceError("payload_variant_mismatch", "修复选项与题目不符", 400);
      }
      // replace/insert 必须携带选项（remove/move 不允许携带）。
      if ((operation.op === "replace" || operation.op === "insert") && optionKey === undefined) {
        throw new LearningRunServiceError("payload_variant_mismatch", "修复操作缺少选项", 400);
      }
    }
  }

  // 客观题（2026-09-21 方案 §3 D2）：提交的选项 id 必须属于本题 public 载荷——
  // 正确项只在私有 solution 里，所以这里只防"编一个没给过的 id"，不接触答案。
  if (interaction.kind === "single_choice") {
    if (payload.kind !== "choice") throw new LearningRunServiceError("payload_variant_mismatch", "作答类型与题目不符", 400);
    if (!payload.selectedOptionId || !(interaction.publicOptionIds ?? []).includes(payload.selectedOptionId)) {
      throw new LearningRunServiceError("payload_variant_mismatch", "请从本题给出的选项里选一个", 400);
    }
  }
  if (interaction.kind === "true_false") {
    if (payload.kind !== "true_false") throw new LearningRunServiceError("payload_variant_mismatch", "作答类型与题目不符", 400);
    if (typeof payload.answer !== "boolean") {
      throw new LearningRunServiceError("payload_variant_mismatch", "请先给出这条说法对不对", 400);
    }
  }
  if (interaction.kind === "matching") {
    if (payload.kind !== "matching") throw new LearningRunServiceError("payload_variant_mismatch", "作答类型与题目不符", 400);
    const lefts = new Set(interaction.publicLeftIds ?? []);
    const rights = new Set(interaction.publicRightIds ?? []);
    if (payload.assignments.length > 8) {
      throw new LearningRunServiceError("payload_variant_mismatch", "配对数量超出题目允许范围", 400);
    }
    for (const assignment of payload.assignments) {
      if (!lefts.has(assignment.leftId) || !rights.has(assignment.rightId)) {
        throw new LearningRunServiceError("payload_variant_mismatch", "配对内容与题目不符", 400);
      }
    }
  }

  // §5.3/§12.3 structured_bundle：一次原子提交两个 part（partAnswers 逐项
  // allowlist 校验——partId/ID 集合必须属于当前 Variant；缺 part 或伪造 ID
  // fail closed）。
  if (interaction.kind === "structured_bundle") {
    const bundle = interaction as unknown as {
      parts: Array<{
        partId: string;
        interaction: {
          kind: "ordering" | "relation_canvas" | "repair";
          publicTokenIds?: string[];
          publicNodeIds?: string[];
          allowedEdgeKinds?: string[];
          publicElementIds?: string[];
          allowedOperationKinds?: string[];
          replacementOptionIds?: string[];
        };
      }>;
    };
    if (payload.kind !== "structured_bundle") {
      throw new LearningRunServiceError("payload_variant_mismatch", "作答类型与题目不符", 400);
    }
    const partAnswers = payload.partAnswers;
    if (!Array.isArray(partAnswers) || partAnswers.length !== bundle.parts.length) {
      throw new LearningRunServiceError("payload_variant_mismatch", "组合作答的 part 数量与题目不符", 400);
    }
    for (let index = 0; index < partAnswers.length; index += 1) {
      const part = bundle.parts[index];
      const answer = partAnswers[index] as { kind?: string; partId?: string } & Record<string, unknown>;
      if (answer.partId !== part.partId) {
        throw new LearningRunServiceError("payload_variant_mismatch", "part 引用与题目不符", 400);
      }
      const partInteraction = part.interaction;
      if (partInteraction.kind === "ordering") {
        if (answer.kind !== "ordering") throw new LearningRunServiceError("payload_variant_mismatch", "part 作答类型与题目不符", 400);
        const allowed = new Set(partInteraction.publicTokenIds ?? []);
        const ordered = (answer.orderedTokenIds ?? []) as string[];
        if (ordered.length !== allowed.size || ordered.some((id) => !allowed.has(id)) || new Set(ordered).size !== ordered.length) {
          throw new LearningRunServiceError("payload_variant_mismatch", "排序内容与题目不符", 400);
        }
      } else if (partInteraction.kind === "relation_canvas") {
        if (answer.kind !== "relation") throw new LearningRunServiceError("payload_variant_mismatch", "part 作答类型与题目不符", 400);
        const nodes = new Set(partInteraction.publicNodeIds ?? []);
        const edgeKinds = new Set(partInteraction.allowedEdgeKinds ?? []);
        const edges = (answer.edges ?? []) as Array<{ fromNodeId: string; toNodeId: string; edgeKind: string }>;
        if (edges.length > 16) throw new LearningRunServiceError("payload_variant_mismatch", "关系数量超出题目允许范围", 400);
        for (const edge of edges) {
          if (!nodes.has(edge.fromNodeId) || !nodes.has(edge.toNodeId) || !edgeKinds.has(edge.edgeKind)) {
            throw new LearningRunServiceError("payload_variant_mismatch", "关系内容与题目不符", 400);
          }
        }
      } else if (partInteraction.kind === "repair") {
        if (answer.kind !== "repair") throw new LearningRunServiceError("payload_variant_mismatch", "part 作答类型与题目不符", 400);
        const elements = new Set(partInteraction.publicElementIds ?? []);
        const ops = new Set(partInteraction.allowedOperationKinds ?? []);
        const options = new Set(partInteraction.replacementOptionIds ?? []);
        const operations = (answer.operations ?? []) as Array<Record<string, unknown>>;
        if (operations.length > 16) throw new LearningRunServiceError("payload_variant_mismatch", "修复操作数量超出题目允许范围", 400);
        for (const operation of operations) {
          const op = operation.op as string;
          if (!ops.has(op)) throw new LearningRunServiceError("payload_variant_mismatch", "修复操作与题目不符", 400);
          const elementKey = op === "insert"
            ? (operation.afterElementId as string | null | undefined) ?? null
            : (operation.elementId as string | null | undefined) ?? null;
          if (elementKey !== null && !elements.has(elementKey)) {
            throw new LearningRunServiceError("payload_variant_mismatch", "修复操作与题目不符", 400);
          }
          const optionKey = operation.replacementOptionId as string | undefined;
          if (optionKey !== undefined && !options.has(optionKey)) {
            throw new LearningRunServiceError("payload_variant_mismatch", "修复选项与题目不符", 400);
          }
          if ((op === "replace" || op === "insert") && optionKey === undefined) {
            throw new LearningRunServiceError("payload_variant_mismatch", "修复操作缺少选项", 400);
          }
        }
      } else {
        throw new LearningRunServiceError("payload_variant_mismatch", "part 类型无法识别", 400);
      }
    }
  }

  // 已锁定检查（§12.3：artifact_already_locked）。
  const lockedRows = await tx.select().from(learningArtifacts)
    .where(and(eq(learningArtifacts.taskId, input.taskId), eq(learningArtifacts.status, "locked")))
    .limit(1);
  if (lockedRows.length > 0) throw artifactAlreadyLocked();

  const at = now();

  // assistance snapshot：从事件账本判定提示暴露（服务端事实，不信任客户端）。
  const hintRows = await tx.select().from(learningRunEvents)
    .where(and(eq(learningRunEvents.runId, run.id), eq(learningRunEvents.eventType, "learning_task.hint_requested")))
    .limit(1);
  const assistanceSnapshotHash = hintRows.length > 0
    ? sha256Hex("assistance:practice_only:hint_requested")
    : sha256Hex("assistance:none");

  // §16.2/§16.7 V2 Artifact lock：按稳定 evidence id 顺序锁定 eligibility 行，
  // 复验 objective lifecycle epoch 与全部 expectedEvidenceEligibilityEpoch；
  // 任何 restricted/revoked 或 epoch 漂移 → fail closed（绝不锁成 trusted Artifact）。
  await revalidateV2ArtifactEpochs(tx, run.id);

  // 0120：closure 哈希从 variant 行读（private 表对 astella_api 无 SELECT）。
  const artifactId = crypto.randomUUID();
  const assessmentId = crypto.randomUUID();
  const payloadHash = sha256Hex(JSON.stringify(payload));

  await tx.insert(learningArtifacts).values({
    id: artifactId,
    runId: run.id,
    taskId: input.taskId,
    variantId: variant.id,
    workspaceId: input.workspaceId,
    userId: input.userId,
    revision: 1,
    payload: payload as never,
    payloadHash,
    publicPayloadHash: variant.publicPayloadHash,
    inputSchemaHash: variant.inputSchemaHash,
    privateSolutionHash: variant.privateSolutionHash ?? "",
    safetyReportHash: variant.safetyReportHash ?? "",
    disclosureProfileHash: variant.disclosureProfileHash,
    assistanceSnapshotHash,
    qualificationProfileHash: null,
    status: "locked",
    lockedAt: at,
    createdAt: at,
    updatedAt: at,
  });
  await tx.insert(learningAssessments).values({
    id: assessmentId,
    runId: run.id,
    taskId: input.taskId,
    artifactId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    source: payload.kind === "declared_unable"
      ? "deterministic_declared_unable"
      : isDeterministicStructuredPayload(payload.kind)
        ? "deterministic_structured"
        : "assessment_critic",
    status: "queued",
    rubricResults: [],
    createdAt: at,
    updatedAt: at,
  });
  await tx.update(learningTasks).set({ status: "answered", revision: task.revision + 1, updatedAt: at })
    .where(eq(learningTasks.id, input.taskId));
  await tx.update(learningRuns).set({ phase: "assessing", revision: run.revision + 1, updatedAt: at })
    .where(eq(learningRuns.id, run.id));

  // 事件 + 幂等账本（同事务）。
  await tx.insert(learningRunEvents).values({
    runId: run.id,
    workspaceId: input.workspaceId,
    userId: input.userId,
    sequence: run.eventCursor + 1,
    eventType: "learning_artifact.locked",
    payload: { taskId: input.taskId, artifactId },
    occurredAt: at,
  });
  await tx.insert(learningRunEvents).values({
    runId: run.id,
    workspaceId: input.workspaceId,
    userId: input.userId,
    sequence: run.eventCursor + 2,
    eventType: "learning_assessment.queued",
    payload: { taskId: input.taskId, artifactId, assessmentId },
    occurredAt: at,
  });
  await tx.update(learningRuns).set({ eventCursor: run.eventCursor + 2, updatedAt: at }).where(eq(learningRuns.id, run.id));

  const receipt = {
    version: 1,
    runId: run.id,
    taskId: input.taskId,
    artifactId,
    artifactRevision: 1,
    artifactStatus: "locked",
    assessment: { assessmentId, status: "queued" },
    runRevision: run.revision + 1,
    taskRevision: task.revision + 1,
    eventCursor: run.eventCursor + 2,
  };
  // §13.5：Assessment 只能由内部 outbox 驱动（不在提交事务外暴露 assess 调用）。
  await tx.insert(learningRunProcessingOutbox).values({
    runId: run.id,
    taskId: input.taskId,
    artifactId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    commandType: "assessment_requested",
    payload: { taskId: input.taskId, artifactId, assessmentId },
    idempotencyKey: `assessment:${assessmentId}`,
    availableAt: at,
    createdAt: at,
    updatedAt: at,
  });
  await tx.insert(learningRunActionLedger).values({
    runId: run.id,
    workspaceId: input.workspaceId,
    userId: input.userId,
    actionKind: "submit",
    idempotencyKey: input.request.idempotencyKey,
    requestHash: submissionRequestHash,
    responseStatus: "success",
    responseSnapshot: receipt,
    acceptedActionId: crypto.randomUUID(),
    createdAt: at,
    updatedAt: at,
  });

  return receipt;
}

// ─── getReturnContract ───────────────────────────────────────────────────

export async function getReturnContract(
  tx: ApiTransaction,
  input: RunScope & { runId: string },
): Promise<LearningRunReturnContractV1> {
  const run = await loadRun(tx, input, input.runId);
  const returnTarget = run.returnTarget as LearningRunPublicV1["returnTarget"];
  const activePhases = ["preparing", "active", "assessing", "checkpoint", "committing", "paused", "recoverable_error"];
  if (activePhases.includes(run.phase)) {
    return {
      version: 1,
      status: "run_active",
      runPhase: run.phase as never,
      returnTarget,
    };
  }
  // P7：终态按 change set 物化状态返回投影语义。
  const { understandingChangeSets } = await import("@astella/shared/db-schema/understanding-projection");
  const changeSetRows = await tx
    .select()
    .from(understandingChangeSets)
    .where(and(
      eq(understandingChangeSets.runId, input.runId),
      eq(understandingChangeSets.workspaceId, input.workspaceId),
      eq(understandingChangeSets.userId, input.userId),
    ))
    .orderBy(desc(understandingChangeSets.createdAt))
    .limit(1);
  const changeSet = changeSetRows[0];
  if (changeSet) {
    return {
      version: 1,
      status: "ready",
      sourceChange: changeSet.kind === "canonical"
        ? { kind: "canonical", canonicalEventId: changeSet.sourceEventId }
        : { kind: "practice_only", practiceEventId: changeSet.sourceEventId },
      targetCheckpoint: {
        version: 1,
        workspaceId: input.workspaceId,
        userId: input.userId,
        token: changeSet.toCheckpointToken,
        capturedAt: changeSet.createdAt.toISOString(),
      },
      returnTarget,
      changeSetId: changeSet.changeSetId,
    };
  }
  // canonical/practice 发生过但 change set 未物化（投影暂时失败）→ pending。
  const runResult = run.result as { outcome?: string } | null;
  if (runResult && (runResult.outcome === "demonstrated" || runResult.outcome === "declared_unable" || runResult.outcome === "practice_completed")) {
    return {
      version: 1,
      status: "projection_pending",
      sourceChange: runResult.outcome === "practice_completed"
        ? { kind: "practice_only", practiceEventId: `practice:${sha256Hex(`${input.runId}:structured`).slice(0, 24)}` }
        : { kind: "canonical", canonicalEventId: `canonical:${sha256Hex(`${input.runId}`).slice(0, 24)}` },
      currentCheckpoint: {
        version: 1,
        workspaceId: input.workspaceId,
        userId: input.userId,
        token: "initial",
        capturedAt: new Date(0).toISOString(),
      },
      returnTarget,
      retryAfterMs: 3000,
    };
  }
  // skipped/ended 无 practice trail：0 投影变化。
  return {
    version: 1,
    status: "no_projection_change",
    sourceChange: { kind: "none" },
    returnTarget,
  };
}

// ─── SSE 事件读取 ────────────────────────────────────────────────────────

// F8（round-4）：SSE 每 tick 无界读该 run 全部事件日志（含 jsonb payload）入内存。
// 改为 keyset 谓词（sequence > after）+ LIMIT 分批：SSE 轮询循环每 3s 续读、cursor
// 随返回递增，天然支持续流；Last-Event-ID 契约与事件顺序保持（ORDER BY sequence）。
const SSE_EVENTS_BATCH = 200;
// F15·①：每 (run) 保留的最多 lease 条数（超出的旧行在下次续租时 DELETE）。
const ACTIVITY_LEASE_KEEP_LATEST = 50;

export async function getEventsAfter(
  tx: ApiTransaction,
  input: RunScope & { runId: string; afterSequence: number },
): Promise<Array<{ sequence: number; eventType: string; payload: Record<string, unknown>; occurredAt: string }>> {
  await loadRun(tx, input, input.runId);
  // F8：把 seq > after 过滤下推到 SQL 谓词（命中 (runId,occurredAt) 前缀索引外还应
  // 结合 sequence 界；LIMIT 约束每 tick 内存/传输体积）。调用方（SSE 轮询/集成测试）
  // 通过 cursor 递增续读，返回 shape 保持不变。
  const rows = await tx
    .select()
    .from(learningRunEvents)
    .where(and(
      eq(learningRunEvents.runId, input.runId),
      eq(learningRunEvents.workspaceId, input.workspaceId),
      eq(learningRunEvents.userId, input.userId),
      gt(learningRunEvents.sequence, input.afterSequence),
    ))
    .orderBy(learningRunEvents.sequence)
    .limit(SSE_EVENTS_BATCH);
  return rows.map((r) => ({
    sequence: r.sequence,
    eventType: r.eventType,
    payload: r.payload as Record<string, unknown>,
    occurredAt: r.occurredAt.toISOString(),
  }));
}

// ─── 活动时间 lease（§13.3）─────────────────────────────────────────────

export async function recordActivityLease(
  tx: ApiTransaction,
  input: RunScope & { runId: string; deviceSessionId: string; startedAt: string; endedAt: string },
): Promise<void> {
  const run = await loadRun(tx, input, input.runId, true);
  if (run.phase !== "active") throw invalidPhase(run.phase, "active");
  const receivedStartedAt = new Date(input.startedAt);
  const receivedEndedAt = new Date(input.endedAt);
  if (Number.isNaN(receivedStartedAt.getTime()) || Number.isNaN(receivedEndedAt.getTime())) {
    throw new LearningRunServiceError("invalid_lease", "续租时间非法", 400);
  }
  // §13.3：客户端 reported duration 非权威——服务端以接收时间与最近一次已
  // 计费 lease 的结束时间为下界（重叠/重复 lease 幂等去重），每次最多计 20 秒。
  const lastRows = await tx
    .select({ leaseEndedAt: learningActivityLeases.leaseEndedAt })
    .from(learningActivityLeases)
    .where(and(
      eq(learningActivityLeases.runId, run.id),
      eq(learningActivityLeases.deviceSessionId, input.deviceSessionId),
    ))
    .orderBy(desc(learningActivityLeases.leaseEndedAt))
    .limit(1);
  const lowerBoundMs = Math.max(
    receivedStartedAt.getTime(),
    lastRows[0]?.leaseEndedAt.getTime() ?? receivedStartedAt.getTime(),
  );
  const upperBoundMs = Math.min(receivedEndedAt.getTime(), Date.now());
  const creditedSeconds = Math.min(
    20,
    Math.max(0, Math.floor((upperBoundMs - lowerBoundMs) / 1000)),
  );
  // F15·①（round-4）：learning_activity_leases 纯 append-only 无 TTL 清理 → 表无界
  // 增长（activeSecondsUsed 上限 180 不抑制行增长）。客户端每 15s 续租（POST
  // /activity-lease），每次写入前删除该 run 的旧 lease：仅保留最近
  // ACTIVITY_LEASE_KEEP_LATEST 条 + 清掉 24h 前全部（双条件，NOT IN 子查询借助
  // run_idx 有界）。幂等去重由 onConflictDoNothing 保证，删除不影响计费语义。
  await tx.delete(learningActivityLeases)
    .where(and(
      eq(learningActivityLeases.runId, run.id),
      sql`${learningActivityLeases.createdAt} < now() - interval '24 hours'`, // 超 24h 全部清
    ));
  await tx.delete(learningActivityLeases).where(and(
    eq(learningActivityLeases.runId, run.id),
    sql`${learningActivityLeases.id} NOT IN (
      SELECT ${learningActivityLeases.id} FROM ${learningActivityLeases}
      WHERE ${learningActivityLeases.runId} = ${run.id}
      ORDER BY ${learningActivityLeases.leaseEndedAt} DESC
      LIMIT ${ACTIVITY_LEASE_KEEP_LATEST}
    )`,
  ));
  // F15·②：run 行为 loadRun(..., true) FOR UPDATE 热行写锁 保持——结算/commit
  // 的 CAS（activeSecondsUsed 上限 + 幂等去重）已兜底并发计费正确性；若拆分锁
  // 会引入计数竞态，维持现状更安全。
  const inserted = await tx.insert(learningActivityLeases).values({
    runId: run.id,
    workspaceId: input.workspaceId,
    userId: input.userId,
    deviceSessionId: input.deviceSessionId,
    leaseStartedAt: receivedStartedAt,
    leaseEndedAt: receivedEndedAt,
    creditedSeconds,
    createdAt: new Date(),
  }).onConflictDoNothing().returning({ id: learningActivityLeases.id });
  if (inserted.length === 0) return; // 重复 lease（同 (run,device,startedAt)）不计费。
  await tx.update(learningRuns)
    .set({
      activeSecondsUsed: Math.min(180, run.activeSecondsUsed + creditedSeconds),
      updatedAt: new Date(),
    })
    .where(eq(learningRuns.id, run.id));
}
