/**
 * 学习运行的**动作施加**（`applyAction`，§13.2 状态机 P2 子集）（2026-09-30 拆出，P2-2）。
 *
 * ## 它是什么
 *
 * 一次「用户对这一步做了什么」的落库：批准、暂缓、重试、改判、退回……
 * 每个动作都要检查当前状态是否允许、走同一套 epoch 复核、写活动、写事件。
 * 743 行里有 20 多个动作分支，它们共享同一段前置校验与同一套写入尾巴——
 * 所以它是**一个函数**，不是 20 个。
 *
 * ## 为什么从 run-service 里分出来
 *
 * `run-service.ts` 此前 3505 行，同时装着：创建 run、读公开视图、结算合同、
 * 草稿、提交产物。`applyAction` 是其中**唯一带状态机**的一段——
 * 别的读函数只读不判，它既判又写。
 *
 * ## 环是怎么断的
 *
 * 私有依赖（六样，跟着走）：`planFollowupTask` / `resolveResponsePreferenceForRetry` /
 * `readObjectiveHints` / `insertRunEvent` / `ActionInput` / `getRunPublicView`。
 *
 * `run-service` 也要用的两样（`loadInteractionQualifications` /
 * `recentPresentedPayloadHashes`）：**让本文件当 owner**，它单向 import 回来。
 * 反过来做就是环。
 *
 * `RunScope` / `loadRun` / `originObjectiveId` 是两边共同的底座 → `run-loader.ts`。
 *
 * ## import 是**逐个加**的，不是整块复制的
 *
 * 前两版把 `run-service` 的 import 整块搬过来（想着「让 tsc 告诉我缺什么」��，
 * 结果多出 68 条未用声明要裁，而裁剪脚本用正则改名字——
 * `gt, gte` 被改成 `gtgte`，语法一坏，`tsc` 就只给 `TS1xxx`，
 * 再按它报错去修**不收敛**（每修一次造一个畸形名字）。
 *
 * 正确做法：**只搬代码，让 `tsc` 报 `Cannot find name 'X'`，再把 X 加进来。**
 * 让编译器**只加不删**。本文件的 import 列表就是这么一行行长出来的。
 *
 * ## 区间怎么算的
 *
 * 每个顶层声明的区间 = **它的块注释起点** → **下一个列 0 顶层声明的块注释起点 − 1**。
 * ① 不用大括号配平（泛型/跨行签名/内联类型都会让它数错）；
 * ② 边界要拿文件里**全部**声明来算；③ 算完打印重叠检查。
 */
import { loadRun, originObjectiveId, type RunScope } from "./run-loader.ts";
import type { ApiTransaction } from "../../db/client.ts";
import { loadFrozenTargetSnapshotV2 } from "../card-generation-v2/target-snapshot-adapter.ts";
import { readRoundGapHelpV1 } from "./gap-help/gap-help-service.ts";
import {
  buildClosure,
  buildDeterministicHint,
  buildVariant,
  clampTimeBudget,
  planRun,
  rubricTargetIdsOf,
  type PlannedTaskInput,
  type PlannerOptions,
  type RunPlannerTargetInput,
} from "./planning/run-planner.ts";
import { idempotencyConflict, invalidPhase, staleRunRevision, variantNotAuthorized, LearningRunServiceError } from "./run-errors.ts";
import { buildRunPublicView } from "./run-view.ts";
import type { LearningRunActionV1, LearningRunPublicV1, LearningRunResultV1 } from "@astella/shared";
import { cardHintPairV2Schema, type CardHintPairV2 } from "@astella/shared/card-generation-v2-contracts";
import { sha256Hex } from "@astella/shared/content-hash";
import { learningObjectiveRevisionsV2, learningObjectivesV2 } from "@astella/shared/db-schema/card-generation-v2";
import { interactionQualifications, learningArtifacts, learningAssessments, learningRunActionLedger, learningRunEvents, learningRunPrivateContracts, learningRunProcessingOutbox, learningRuns, learningTaskDisclosureProfiles, learningTaskPresentationHistory, learningTaskPrivateSolutions, learningTaskSafetyReports, learningTaskVariants, learningTasks } from "@astella/shared/db-schema/learning-runs";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

export interface ActionInput extends RunScope {
  runId: string;
  runRevision: number;
  runtimeEpoch: number;
  taskRevision?: number;
  action: LearningRunActionV1;
  idempotencyKey: string;
  requestContext?: { version: 2; snapshotId: string };
  assertActionAllowed?: () => void;
}


/**
 * §6.2/§12.2 补充证据 Task（V1 practice 微修补）：activate_followup 时即时
 * 规划并持久化一个 text 开放回答短任务（intent=repair；无 qualification →
 * purpose=practice / ceiling=practice_only，§7.7 上限）。
 */
async function planFollowupTask(
  tx: ApiTransaction,
  scope: { workspaceId: string; userId: string },
  run: typeof learningRuns.$inferSelect,
  at: Date,
): Promise<{ taskId: string }> {
  // V2：从该 run 已冻结的 LearningTargetSnapshotV2 取 canonical 目标。
  const snapshot = await loadFrozenTargetSnapshotV2(tx, scope.workspaceId, run.id);
  if (!snapshot) {
    throw new LearningRunServiceError("target_snapshot_missing", "该 run 缺少冻结的 target snapshot", 409);
  }
  const t = snapshot.target;
  const taskId = crypto.randomUUID();
  // snapshot 提供 fingerprint / objectiveStatement / evidence hashes（V1/V2 统一语义）。
  const plannerTarget: RunPlannerTargetInput = {
    keyPointId: t.objectiveId,
    claim: t.objectiveStatement,
    sourceFingerprint: t.semanticTargetFingerprint,
    evidenceContentHashes: t.evidence.map((e) => e.evidenceSnapshotHash),
    v2: {
      objectiveStatement: t.objectiveStatement,
      publicSummary: t.publicSummary,
      knowledgeForm: t.knowledgeForm,
      preferredIntents: t.preferredIntents,
      canonicalAnswer: t.canonicalAnswer,
      scoringRubric: t.scoringRubric,
      relations: t.relations,
      // 0245：存量快照没有这一字段 → null（没有练习件），不是"未计算"。
      practiceItem: t.practiceItem ?? null,
      evidence: t.evidence,
      publishedTargetEligibility: snapshot.publishedTargetEligibility,
    },
  };
  const followupTask: PlannedTaskInput = {
    taskId,
    runId: run.id,
    sequence: 2,
    intent: "repair",
    prompt: `请补充说明这个要点：${t.objectiveStatement}。指出上次回答中不准确或不完整的部分并纠正。`,
    targetSummary: t.objectiveStatement.slice(0, 160),
    hintLevels: 1,
    primaryFamily: "text",
    purpose: "practice",
    templateTrustCeiling: "practice_only",
    estimatedActiveSeconds: 40,
  };
  const textVariant = buildVariant(run.id, taskId, "text", 40, plannerTarget, followupTask);
  // §16.6：rubric 目标必须用冻结快照的 required unit ids（主任务在
  // planV2Run 里就是这么传的）。缺这个覆盖时 buildClosure 会现造
  // `rubric:repair:<hash>`，gatherCriticInput 按快照解析必然落空 →
  // 补充任务**每一次**都被 fail closed 成 not_assessable（2026-09-23 实测
  // 5/5，与卡片有没有证据无关）。
  const requiredRubricTargetIds = t.scoringRubric.units
    .filter((unit) => unit.required)
    .map((unit) => unit.rubricUnitId);
  const closure = buildClosure(
    run.id, taskId, textVariant, plannerTarget, followupTask,
    sha256Hex(`followup:${run.id}:${taskId}`),
    undefined, requiredRubricTargetIds,
  );
  await tx.insert(learningTasks).values({
    id: taskId,
    runId: run.id,
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    sequence: 2,
    intent: "repair",
    prompt: followupTask.prompt,
    targetSummary: followupTask.targetSummary,
    hintLevels: 1,
    status: "active",
    revision: 1,
    presentedAt: at,
    createdAt: at,
    updatedAt: at,
  });
  await tx.insert(learningTaskVariants).values({
    id: textVariant.variantId,
    taskId,
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    purpose: "practice",
    templateTrustCeiling: "practice_only",
    estimatedActiveSeconds: 40,
    interaction: textVariant.interaction,
    publicPayloadHash: textVariant.publicPayloadHash,
    inputSchemaHash: textVariant.inputSchemaHash,
    disclosureProfileHash: textVariant.disclosureProfileHash,
    privateSolutionHash: closure.privateSolutionHash,
    safetyReportHash: closure.reportHash,
    rubricTargetIds: rubricTargetIdsOf(closure.solution),
    alternatives: [],
    revision: 1,
    status: "active",
    createdAt: at,
    updatedAt: at,
  });
  await tx.insert(learningTaskPrivateSolutions).values({
    variantId: textVariant.variantId,
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    solution: closure.solution,
    privateSolutionHash: closure.privateSolutionHash,
    runPlanHash: closure.runPlanHash,
    createdAt: at,
  });
  await tx.insert(learningTaskSafetyReports).values({
    taskId,
    variantId: textVariant.variantId,
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    publicPayloadHash: textVariant.publicPayloadHash,
    inputSchemaHash: textVariant.inputSchemaHash,
    privateSolutionHash: closure.privateSolutionHash,
    disclosureProfileHash: textVariant.disclosureProfileHash,
    qualificationProfileHash: null,
    runPlanHash: closure.runPlanHash,
    injectionScan: closure.safetyReport.injectionScan,
    privateLeakageScan: closure.safetyReport.privateLeakageScan,
    schemaValidation: closure.safetyReport.schemaValidation,
    accessibilityProfile: closure.safetyReport.accessibilityProfile,
    activationDecision: closure.safetyReport.activationDecision,
    reportHash: closure.reportHash,
    createdAt: at,
  });
  const existingDisclosure = await tx
    .select({ id: learningTaskDisclosureProfiles.id })
    .from(learningTaskDisclosureProfiles)
    .where(and(
      eq(learningTaskDisclosureProfiles.workspaceId, scope.workspaceId),
      eq(learningTaskDisclosureProfiles.profileHash, textVariant.disclosureProfileHash),
    ))
    .limit(1);
  if (!existingDisclosure[0]) {
    await tx.insert(learningTaskDisclosureProfiles).values({
      variantId: textVariant.variantId,
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      disclosedFieldPaths: closure.disclosure.disclosedFieldPaths,
      hiddenFieldPaths: closure.disclosure.hiddenFieldPaths,
      answerBearingFieldsHidden: true,
      profileHash: textVariant.disclosureProfileHash,
      createdAt: at,
    }).onConflictDoNothing();
  }
  return { taskId };
}


/** §7.7：读取已审批且未过期的 interaction qualification（family → ceiling）。 */
type InteractionQualificationRow = { approvedCeiling: "practice_only" | "diagnostic_only" | "facet_eligible" | "mastery_eligible"; expiresAt: string | null };
const INTERACTION_QUALIFICATION_CACHE_TTL_MS = 60_000;
const interactionQualificationCache = new Map<string, { at: number; data: Map<string, InteractionQualificationRow> }>();

export async function loadInteractionQualifications(
  tx: ApiTransaction,
): Promise<Map<string, InteractionQualificationRow>> {
  const now = Date.now();
  const cached = interactionQualificationCache.get("interaction_qualifications");
  // 命中检查时顺带清理过期条目（有界）。
  if (cached) {
    if (now - cached.at < INTERACTION_QUALIFICATION_CACHE_TTL_MS) return cached.data;
    interactionQualificationCache.delete("interaction_qualifications");
  }
  const rows = await tx
    .select({
      family: interactionQualifications.family,
      approvedCeiling: interactionQualifications.approvedCeiling,
      expiresAt: interactionQualifications.expiresAt,
    })
    .from(interactionQualifications);
  const data = new Map(rows.map((row) => [
    row.family,
    { approvedCeiling: row.approvedCeiling, expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null },
  ]));
  interactionQualificationCache.set("interaction_qualifications", { at: now, data });
  return data;
}


/** §7.8：查询同一 (user,objective,intent) 最近 30 天已呈现的 publicPayloadHash 集合。 */
export async function recentPresentedPayloadHashes(
  tx: ApiTransaction,
  scope: { workspaceId: string; userId: string; keyPointId: string },
): Promise<Set<string>> {
  // Run origin is a strict V2 object; objectiveId is the only stored target key.
  const rows = await tx
    .select({ publicPayloadHash: learningTaskPresentationHistory.publicPayloadHash })
    .from(learningTaskPresentationHistory)
    .innerJoin(learningRuns, eq(learningRuns.id, sql`${learningTaskPresentationHistory.runId}`))
    .where(and(
      eq(learningTaskPresentationHistory.workspaceId, scope.workspaceId),
      eq(learningTaskPresentationHistory.userId, scope.userId),
      sql`${learningRuns.origin}->>'objectiveId' = ${scope.keyPointId}`,
      gte(learningTaskPresentationHistory.presentedAt, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
    ))
    // 热路径：只取最近一批用于展示去重（presentation-dedup 只需近端历史）。
    .orderBy(desc(learningTaskPresentationHistory.presentedAt))
    .limit(50);
  return new Set(rows.map((row) => row.publicPayloadHash));
}


function activeVariantIdFor(
  variants: Array<{ id: string; taskId: string; status: string }>,
  taskId: string,
): string | null {
  const active = variants.find((v) => v.taskId === taskId && v.status === "active");
  return active?.id ?? null;
}


/**
 * M3（2026-08-24 审查）：retry_prepare 重跑规划前，从已在册的 Variant 交互形状
 * 反推 responsePreference。
 *
 * V2 run.origin 只冻结严格 originV2（responsePreference 是请求级字段，从不
 * 持久化），此前重试恒回落 "adaptive"——用户原本选 structured 的题在重试后
 * 静默退化为开放回答。当前正在使用的 Variant 形状是最忠实的可用事实源。
 */
async function resolveResponsePreferenceForRetry(
  tx: ApiTransaction,
  runId: string,
): Promise<PlannerOptions["responsePreference"]> {
  const rows = await tx
    .select({ interaction: learningTaskVariants.interaction })
    .from(learningTaskVariants)
    .innerJoin(learningTasks, eq(learningTasks.id, learningTaskVariants.taskId))
    .where(and(
      eq(learningTasks.runId, runId),
      inArray(learningTaskVariants.status, ["active", "standby", "superseded"]),
    ))
    .orderBy(
      sql`CASE WHEN ${learningTaskVariants.status} = 'active' THEN 0 ELSE 1 END`,
      learningTaskVariants.createdAt,
    )
    .limit(1);
  const kind = (rows[0]?.interaction as { kind?: string } | null)?.kind;
  if (kind === "voice_teachback") return "voice";
  if (kind === "text_response") return "text";
  if (kind === "ordering" || kind === "relation_canvas" || kind === "repair" || kind === "structured_bundle") {
    return "structured";
  }
  return "adaptive";
}

// ─── applyAction（§13.2 状态机 P2 子集）──────────────────────────────────


/**
 * 读出这张卡自带的两级提示（迁移 0234 存在 objective revision 上）。
 *
 * 取的是目标**当前修订**——提示与答案同版本，答案被改写后旧提示不得继续下发。
 * run.origin 里没有 objectiveId（V1 来源、沙箱样例等）或该修订没有作者提示时
 * 返回 null，调用方退回派生文案；绝不因为缺提示而拒绝作答动作。
 */
async function readObjectiveHints(
  tx: ApiTransaction,
  workspaceId: string,
  origin: unknown,
): Promise<CardHintPairV2 | null> {
  const objectiveId = (origin as { objectiveId?: unknown }).objectiveId;
  if (typeof objectiveId !== "string" || objectiveId.length === 0) return null;
  const rows = await tx
    .select({ hints: learningObjectiveRevisionsV2.hints })
    .from(learningObjectiveRevisionsV2)
    .innerJoin(
      learningObjectivesV2,
      and(
        eq(learningObjectivesV2.workspaceId, learningObjectiveRevisionsV2.workspaceId),
        eq(learningObjectivesV2.objectiveId, learningObjectiveRevisionsV2.objectiveId),
      ),
    )
    .where(and(
      eq(learningObjectiveRevisionsV2.workspaceId, workspaceId),
      eq(learningObjectivesV2.objectiveId, objectiveId),
      eq(
        learningObjectivesV2.currentObjectiveRevisionId,
        learningObjectiveRevisionsV2.objectiveRevisionId,
      ),
    ))
    .limit(1);
  const parsed = cardHintPairV2Schema.safeParse(rows[0]?.hints);
  return parsed.success ? parsed.data : null;
}

// ─── 导出供 Finalizer 使用 ───────────────────────────────────────────────

export { learningRuns, learningAssessments, learningArtifacts, learningRunEvents };


export async function applyAction(
  tx: ApiTransaction,
  input: ActionInput,
  now: () => Date = () => new Date(),
): Promise<{ acceptedActionId: string; actionResult: "state_changed" | "hint_revealed" | "variant_switched"; hint?: { hintId: string; level: 1 | 2 | 3; text: string; exposureEventId: string }; previousVariantId?: string; activeVariantId?: string; snapshot: LearningRunPublicV1 }> {
  const at = now();
  const requestHash = sha256Hex(JSON.stringify({
    version: input.requestContext?.version ?? 1,
    ...(input.requestContext?.snapshotId ? { snapshotId: input.requestContext.snapshotId } : {}),
    runId: input.runId,
    runRevision: input.runRevision,
    taskRevision: input.taskRevision ?? null,
    runtimeEpoch: input.runtimeEpoch,
    action: input.action,
  }));

  // V2 action 首次请求也必须在幂等边界串行化：两个相同 key 的
  // overlap 请求不能同时 miss ledger 后各自执行副作用，再由唯一索引
  // 把 loser 变成裸 23505/500。锁释放后 loser 会读取 winner 的 receipt。
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`v2-action:${input.workspaceId}:${input.userId}:${input.runId}:${input.idempotencyKey}`}, 0)
    )
  `);

  // 幂等账本
  const ledgerRows = await tx
    .select({
      responseStatus: learningRunActionLedger.responseStatus,
      responseSnapshot: learningRunActionLedger.responseSnapshot,
      acceptedActionId: learningRunActionLedger.acceptedActionId,
      requestHash: learningRunActionLedger.requestHash,
    })
    .from(learningRunActionLedger)
    .where(and(
      eq(learningRunActionLedger.runId, input.runId),
      eq(learningRunActionLedger.idempotencyKey, input.idempotencyKey),
    ))
    .limit(1);
  if (ledgerRows[0]) {
    // 同 key 不同内容 → idempotency_conflict（§13.1），绝不静默返回旧响应。
    if (ledgerRows[0].requestHash !== requestHash) throw idempotencyConflict();
    if (ledgerRows[0].responseStatus === "success" && ledgerRows[0].responseSnapshot) {
      const snap = ledgerRows[0].responseSnapshot as {
        actionResult: string;
        hint?: { hintId: string; level: 1 | 2 | 3; text: string; exposureEventId: string };
        previousVariantId?: string;
        activeVariantId?: string;
        snapshot: LearningRunPublicV1;
      };
      return {
        acceptedActionId: ledgerRows[0].acceptedActionId ?? "",
        actionResult: snap.actionResult as "state_changed",
        hint: snap.hint,
        previousVariantId: snap.previousVariantId,
        activeVariantId: snap.activeVariantId,
        snapshot: snap.snapshot,
      };
    }
    throw new LearningRunServiceError("action_in_progress", "该操作正在处理", 409);
  }

  // V2 route authorization runs after exact replay lookup. This preserves
  // response-loss recovery even when the current phase no longer advertises
  // the original action.
  input.assertActionAllowed?.();

  // Exact replay is resolved before current epoch/revision checks. A lost
  // response must be safely recoverable after the run has advanced.
  const run = await loadRun(tx, input, input.runId, true);
  if (run.runtimeEpoch !== input.runtimeEpoch) throw new LearningRunServiceError("epoch_mismatch", "运行纪元不匹配", 409);
  if (run.revision !== input.runRevision) throw staleRunRevision(run.revision, input.runRevision);

  const writeLedger = (requestHash: string, snapshot: Record<string, unknown>, _actionResult: string, acceptedActionId: string) =>
    tx.insert(learningRunActionLedger).values({
      runId: input.runId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      actionKind: input.action.kind,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      responseStatus: "success",
      responseSnapshot: snapshot,
      acceptedActionId,
      createdAt: at,
      updatedAt: at,
    });

  const acceptedActionId = crypto.randomUUID();

  switch (input.action.kind) {
    case "pause": {
      if (run.phase !== "active") throw invalidPhase(run.phase, "active");
      await tx.update(learningRuns)
        .set({ phase: "paused", revision: run.revision + 1, updatedAt: at })
        .where(eq(learningRuns.id, run.id));
      await insertRunEvent(tx, input, "learning_run.paused", {}, at, run.eventCursor);
      break;
    }
    case "resume": {
      if (run.phase !== "paused") throw invalidPhase(run.phase, "paused");
      await tx.update(learningRuns)
        .set({ phase: "active", revision: run.revision + 1, updatedAt: at })
        .where(eq(learningRuns.id, run.id));
      await insertRunEvent(tx, input, "learning_run.resumed", {}, at, run.eventCursor);
      break;
    }
    case "skip_run": {
      if (!["active", "paused", "checkpoint"].includes(run.phase)) throw invalidPhase(run.phase, "active");
      const skippedResult: LearningRunResultV1 = {
        outcome: "skipped",
        demonstratedFacets: [],
        gapFacets: [],
        scheduleImpact: { kind: "none", reasonCode: "skipped" },
        returnTarget: run.returnTarget as LearningRunPublicV1["returnTarget"],
      };
      await tx.update(learningRuns)
        .set({
          phase: "skipped",
          result: skippedResult as never,
          terminalReasonCode: "user_ended",
          revision: run.revision + 1,
          updatedAt: at,
        })
        .where(eq(learningRuns.id, run.id));
      await insertRunEvent(tx, input, "learning_run.skipped", {}, at, run.eventCursor);
      break;
    }
    case "end": {
      if (run.phase === "completed") {
        // §13.2.5：Commit 完成后到达的 End 返回 completed snapshot（幂等）。
        break;
      }
      if (run.phase === "assessing" || run.phase === "committing") {
        if (!input.action.abandonLockedEvidence) {
          throw invalidPhase(run.phase, "active");
        }
        // abandon CAS 赢：epoch 前移，迟到 Assessment/Commit 无副作用。
        await tx.update(learningRuns)
          .set({
            phase: "ended",
            terminalReasonCode: "user_ended",
            runtimeEpoch: run.runtimeEpoch + 1,
            revision: run.revision + 1,
            activeTaskId: null,
            updatedAt: at,
          })
          .where(eq(learningRuns.id, run.id));
      } else if (run.phase === "recoverable_error") {
        // H4（2026-08-24 审查）：availability 在 recoverable_error 下已宣告 end
        // 可用（abandonLockedEvidence:false），状态机必须接受——否则与重试失败的
        // 情形叠加后 run 无任何出口，永久占用。失败阶段的在途评估一并作废：
        // epoch 前移（迟到写回无副作用）+ 未终态 assessment 收尾为 failed。
        await tx.update(learningRuns)
          .set({
            phase: "ended",
            terminalReasonCode: "user_ended",
            runtimeEpoch: run.runtimeEpoch + 1,
            revision: run.revision + 1,
            activeTaskId: null,
            updatedAt: at,
          })
          .where(eq(learningRuns.id, run.id));
        await tx.update(learningAssessments)
          .set({ status: "failed", rubricResults: [], trustClass: null, reportHash: null, updatedAt: at })
          .where(and(
            eq(learningAssessments.runId, run.id),
            inArray(learningAssessments.status, ["queued", "running"]),
          ));
      } else if (["preparing", "active", "paused"].includes(run.phase)) {
        await tx.update(learningRuns)
          .set({
            phase: "ended",
            terminalReasonCode: "user_ended",
            revision: run.revision + 1,
            activeTaskId: null,
            updatedAt: at,
          })
          .where(eq(learningRuns.id, run.id));
      } else {
        throw invalidPhase(run.phase, "active");
      }
      await insertRunEvent(tx, input, "learning_run.ended", {}, at, run.eventCursor);
      break;
    }
    case "cancel_assessment": {
      // §5.5「用户明确选择『停止本次评估』则保存原回答，停止该任务后续尝试，迟到报告不作为
      // 有效判定或调度依据；当次显示『回答已保存，评估已取消』」。
      //
      // 这一格**不改 run 的 phase**——结束活动是另一个独立动作（§5.5 原话：「结束活动、取消
      // AI 任务和撤销未来复习授权是三个独立动作」）。取消评估之后 run 仍可继续：用户可以
      // 直接结束，也可以重试一次评估（`retry_assessment`），而 §14.1.1 明确「允许未来一次
      // 条件清楚的新尝试」。
      if (run.phase === "completed") {
        // §5.5「已先完成提交的判定不因后到取消而消失，显示实际回执」——这一发是**幂等**
        // 而不是 409：她要的结果（看到实际回执）此刻已经成立，报冲突会让她以为该结果丢了。
        const current = await getRunPublicView(tx, { workspaceId: input.workspaceId, userId: input.userId, runId: run.id });
        const snapshot = { actionResult: "assessment_already_final", assessmentId: input.action.assessmentId, snapshot: current };
        await writeLedger(requestHash, snapshot, "assessment_already_final", acceptedActionId);
        return { ok: true, kind: "cancel_assessment", acceptedActionId, snapshot } as never;
      }
      if (run.phase !== "assessing" && run.phase !== "committing" && run.phase !== "recoverable_error") {
        throw invalidPhase(run.phase ?? "none", "active");
      }
      const targeted = await tx
        .update(learningAssessments)
        .set({ status: "cancelled", rubricResults: [], trustClass: null, reportHash: null, updatedAt: at })
        .where(and(
          eq(learningAssessments.id, input.action.assessmentId),
          eq(learningAssessments.runId, run.id),
          eq(learningAssessments.workspaceId, input.workspaceId),
          eq(learningAssessments.userId, input.userId),
          // 只收**未终态**的那一条：completed / not_assessable 是"已经判出来的结果"，
          // cancelled 是"不再要这个结果"，两者是两句不同的话（见上面那个 completed 分支）。
          inArray(learningAssessments.status, ["queued", "running"]),
        ))
        .returning({ id: learningAssessments.id });
      if (targeted.length === 0) {
        // 认得出这条 id 但它已是终态，与压根不认得这一条要分开说：前者是"它已经判完了"，
        // 后者是"这一发指向了一个不存在的东西"。
        const existing = await tx
          .select({ status: learningAssessments.status })
          .from(learningAssessments)
          .where(and(
            eq(learningAssessments.id, input.action.assessmentId),
            eq(learningAssessments.runId, run.id),
            eq(learningAssessments.workspaceId, input.workspaceId),
            eq(learningAssessments.userId, input.userId),
          ))
          .limit(1);
        if (existing[0]) {
          throw new LearningRunServiceError("assessment_already_final", "这次评估已经有结果了，取消不会抹掉它。", 409);
        }
        throw new LearningRunServiceError("assessment_not_found", "找不到这次评估。", 404);
      }
      // 原回答**保留**：只改 assessment 那一行，artifact 与 run 一律不动——
      // §16.36「后者原回答保留且显示评估已取消」。
      await tx.update(learningRuns).set({ revision: run.revision + 1, updatedAt: at }).where(eq(learningRuns.id, run.id));
      await insertRunEvent(tx, input, "learning_assessment.cancelled",
        { assessmentId: input.action.assessmentId, answerPreserved: true }, at, run.eventCursor);
      const cancelledView = await getRunPublicView(tx, { workspaceId: input.workspaceId, userId: input.userId, runId: run.id });
      const cancelledSnapshot = { actionResult: "assessment_cancelled", assessmentId: input.action.assessmentId, snapshot: cancelledView };
      await writeLedger(requestHash, cancelledSnapshot, "assessment_cancelled", acceptedActionId);
      return { ok: true, kind: "cancel_assessment", acceptedActionId, snapshot: cancelledSnapshot } as never;
    }
    case "request_hint": {
      if (run.phase !== "active" || !run.activeTaskId) throw invalidPhase(run.phase ?? "none", "active");
      const level = input.action.level;
      const taskRows = await tx.select().from(learningTasks).where(and(eq(learningTasks.id, run.activeTaskId), eq(learningTasks.runId, run.id))).limit(1);
      if (!taskRows[0]) throw new LearningRunServiceError("task_not_found", "任务不存在", 404);
      if (level > taskRows[0].hintLevels) throw new LearningRunServiceError("hint_not_available", "该级别提示不可用", 409);
      // 先写 exposure（事件）再返回提示；重放同 idempotencyKey 不新增 exposure。
      const exposureEventId = crypto.randomUUID();
      await insertRunEvent(tx, input, "learning_task.hint_requested", { taskId: run.activeTaskId, hintLevel: level }, at, run.eventCursor);
      await tx.update(learningRuns).set({ revision: run.revision + 1, updatedAt: at }).where(eq(learningRuns.id, run.id));
      /**
       * 优先用**这张卡自带**的提示（制卡阶段由作者产出，见 cardHintPairV2Schema）。
       * 常量表 `buildDeterministicHint` 只在卡片确实没有作者提示时才兜底——那正是
       * 用户投诉"提示是写死的、跟卡片无关"的来源（2026-09-20 实走复盘 #10）。
       */
      const authoredHints = await readObjectiveHints(tx, input.workspaceId, run.origin);
      const text = authoredHints
        ? level === 1 ? authoredHints.level1 : authoredHints.level2
        : buildDeterministicHint({ intent: taskRows[0].intent as never }, level);
      const snapshot = {
        actionResult: "hint_revealed",
        hint: { hintId: crypto.randomUUID(), level, text, exposureEventId },
        snapshot: await getRunPublicView(tx, { workspaceId: input.workspaceId, userId: input.userId, runId: run.id }),
      };
      await writeLedger(requestHash, snapshot, "hint_revealed", acceptedActionId);
      return {
        acceptedActionId,
        actionResult: "hint_revealed",
        hint: snapshot.hint,
        snapshot: snapshot.snapshot,
      };
    }
    case "switch_variant": {
      if (run.phase !== "active" || !run.activeTaskId) throw invalidPhase(run.phase ?? "none", "active");
      const targetVariantId = input.action.alternativeId;
      // F16·②（round-4）：variants 读取加 FOR UPDATE —— 锁定目标与当前 active
      // 行，防止并发 submitArtifact 在 run 锁释放窗口对已被取代的旧 variant 命中
      // status='active' 检查（stale-submit 竞态）。write 段随后在自事务内提交。
      const variantRows = await tx
        .select()
        .from(learningTaskVariants)
        .where(and(eq(learningTaskVariants.id, targetVariantId), eq(learningTaskVariants.taskId, run.activeTaskId)))
        .limit(1)
        .for("update");
      if (!variantRows[0] || variantRows[0].status !== "standby") throw variantNotAuthorized();
      const currentRows = await tx
        .select()
        .from(learningTaskVariants)
        .where(and(eq(learningTaskVariants.taskId, run.activeTaskId), eq(learningTaskVariants.status, "active")))
        .for("update");
      for (const v of currentRows) {
        /**
         * 被换下的 variant 退回 `standby`，不是 `superseded`（2026-09-20 实走复盘 #8）。
         *
         * 此前它是**单向门**：`availableAlternatives` 只列 `standby`，所以切到语音之后
         * 再也没有回到文本的动作可发——只能靠"跳过这一步 / 安全退出"脱身。
         * 提交安全不依赖 superseded：`submitArtifact` 只接受 `status = 'active'` 的
         * variant（见本文件提交路径），standby 一样提交不进去；FOR UPDATE 行锁
         * 也照旧挡住并发下的 stale-submit 竞态。
         */
        await tx.update(learningTaskVariants).set({ status: "standby", updatedAt: at }).where(eq(learningTaskVariants.id, v.id));
      }
      await tx.update(learningTaskVariants).set({ status: "active", updatedAt: at }).where(eq(learningTaskVariants.id, targetVariantId));
      await tx.update(learningRuns).set({ revision: run.revision + 1, updatedAt: at }).where(eq(learningRuns.id, run.id));
      await insertRunEvent(tx, input, "learning_task.variant_switched", {
        taskId: run.activeTaskId,
        previousVariantId: currentRows.find((v) => v.id !== targetVariantId)?.id ?? null,
        activeVariantId: targetVariantId,
        // §13.1：换题这一次修订要带上"为什么换"。取的是工具参数那一格，
        // 不是她自己事后补的说法——理由与动作走同一条提案，才对得上同一行记录。
        reason: input.action.reason,
      }, at, run.eventCursor);
      const snapshot = await getRunPublicView(tx, { workspaceId: input.workspaceId, userId: input.userId, runId: run.id });
      const snap = {
        actionResult: "variant_switched",
        previousVariantId: currentRows.find((v) => v.id !== targetVariantId)?.id ?? "",
        activeVariantId: targetVariantId,
        snapshot,
      };
      await writeLedger(requestHash, snap, "variant_switched", acceptedActionId);
      return {
        acceptedActionId,
        actionResult: "variant_switched",
        previousVariantId: snap.previousVariantId,
        activeVariantId: snap.activeVariantId,
        snapshot,
      };
    }
    case "finish_without_commit": {
      // §13.1：只对 not_assessable checkpoint 有效，生成 0 学习副作用的结果并 completed。
      const checkpoint = run.checkpoint as { kind?: string } | null;
      if (run.phase !== "checkpoint" || checkpoint?.kind !== "not_assessable") {
        throw invalidPhase(run.phase ?? "none", "checkpoint(not_assessable)");
      }
      const result: LearningRunResultV1 = {
        outcome: "not_assessable",
        demonstratedFacets: [],
        gapFacets: [],
        scheduleImpact: { kind: "none", reasonCode: "not_assessable" },
        returnTarget: run.returnTarget as LearningRunPublicV1["returnTarget"],
      };
      await tx.update(learningRuns)
        .set({
          phase: "completed",
          checkpoint: null,
          result: result as never,
          revision: run.revision + 1,
          updatedAt: at,
        })
        .where(eq(learningRuns.id, run.id));
      await insertRunEvent(tx, input, "learning_run.completed", {}, at, run.eventCursor);
      break;
    }
    case "finish_current_evidence": {
      // §13.2：只对 checkpoint(partial) 有效——按已有可信证据进入 Commit
      // （facet_evidence：只写允许的 facet，UI 明示"已证明一部分"）。
      const checkpointKind = (run.checkpoint as { kind?: string } | null)?.kind;
      if (run.phase !== "checkpoint" || checkpointKind !== "partial") {
        throw invalidPhase(run.phase ?? "none", "checkpoint(partial)");
      }
      const assessmentRows = await tx
        .select({
          id: learningAssessments.id,
          taskId: learningAssessments.taskId,
          artifactId: learningAssessments.artifactId,
        })
        .from(learningAssessments)
        .where(and(
          eq(learningAssessments.runId, run.id),
          eq(learningAssessments.status, "completed"),
          // H3（2026-08-24 审查）：绑定「产生该 partial checkpoint 的当前任务」
          // 的最新 completed assessment，而不是 run 内任意一条（无 ORDER BY 的
          // 「第一行」在 activate_followup 之后可能是旧任务的评估）。
          ...(run.activeTaskId ? [eq(learningAssessments.taskId, run.activeTaskId)] : []),
        ))
        .orderBy(desc(learningAssessments.createdAt))
        .limit(1);
      const assessment = assessmentRows[0];
      if (!assessment) {
        throw new LearningRunServiceError("assessment_not_found", "评估尚未完成，无法结算", 409);
      }
      await tx.update(learningRuns)
        .set({ phase: "committing", revision: run.revision + 1, updatedAt: at })
        .where(eq(learningRuns.id, run.id));
      await tx.insert(learningRunProcessingOutbox).values({
        runId: run.id,
        taskId: assessment.taskId,
        artifactId: assessment.artifactId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        commandType: "commit_requested",
        payload: { assessmentId: assessment.id, disposition: "facet_evidence", runtimeEpoch: run.runtimeEpoch },
        idempotencyKey: `commit:facet:${assessment.id}`,
        availableAt: at,
        createdAt: at,
        updatedAt: at,
      });
      // 与 demonstrated/unable 路径一致：Commit 完成才写 learning_commit.completed
      // 事件（learning_run_events 枚举无 commit_started）。
      break;
    }
    case "activate_followup": {
      // §6.2/§13.2：checkpoint 且 followup 已预授权（allowedFollowupIds）时
      // 激活补充证据 Task（V1 practice 微修补；激活时即时规划并持久化）。
      const checkpoint = run.checkpoint as { kind?: string; allowedFollowupIds?: string[] } | null;
      const followupId = String((input.action as { followupId?: string }).followupId ?? "");
      if (!checkpoint || !Array.isArray(checkpoint.allowedFollowupIds) || !checkpoint.allowedFollowupIds.includes(followupId)) {
        throw new LearningRunServiceError("followup_not_authorized", "该补充任务未获授权", 409);
      }
      // 39d W4-6 刀四（PRD §5.3）：这一轮已经停了（同一缺口连续两次帮助、还没有
      // 改善的证据）时，即使客户端手里那颗按钮是**当时**签发的、还没消失，也不许
      // 再激活补充任务——签发侧（tick 的 `supplementOffer`）从那之后就不再签发，
      // 这一层防的是绕过（旧快照、手拼请求）。停在授权之后：未授权的 followupId
      // 仍旧按原来的口径拒，不在这里替它说话。
      const roundOrigin = run.origin as { kind?: unknown; roundId?: unknown } | null;
      if (roundOrigin?.kind === "note_round" && typeof roundOrigin.roundId === "string") {
        const gapHelp = await readRoundGapHelpV1(
          tx,
          { workspaceId: input.workspaceId, userId: input.userId },
          roundOrigin.roundId,
        );
        if (gapHelp.stopped) {
          throw new LearningRunServiceError(
            "gap_help_stopped",
            "这一轮已经帮过两次，还没有出现改善的证据——先让你选下一步：换个解释、补上缺的前置、回材料核对，或者先结束这一轮",
            409,
          );
        }
      }
      // 单槽额度（与 tick 的 supplementOffer 同一条不变量）：用过就明确 409，
      // 不让下面写死 sequence 2 的插入去撞 learning_tasks_run_sequence_unique
      // ——那对调用方是一个裸 500（2026-09-23 实走）。仍带旧签发值的存量
      // checkpoint 也只在这一层被挡住。
      const usedFollowup = await tx
        .select({ id: learningTasks.id })
        .from(learningTasks)
        .where(and(eq(learningTasks.runId, run.id), gte(learningTasks.sequence, 2)))
        .limit(1);
      if (usedFollowup.length > 0) {
        throw new LearningRunServiceError("followup_already_used", "这个 run 已经用过唯一一次补充机会", 409);
      }
      const at = now();
      const { taskId } = await planFollowupTask(tx, {
        workspaceId: input.workspaceId,
        userId: input.userId,
      }, run, at);
      await tx.update(learningRuns)
        .set({
          phase: "active",
          activeTaskId: taskId,
          checkpoint: null,
          failure: null,
          revision: run.revision + 1,
          updatedAt: at,
        })
        .where(eq(learningRuns.id, run.id));
      await insertRunEvent(tx, input, "learning_task.presented", { taskId }, at, run.eventCursor);
      break;
    }
    case "retry_prepare": {
      // §13.2：recoverable_error(stage=prepare) → 重新 PREPARE（重跑规划并
      // 重写 planning 产物；角度轮换会避开已呈现题面）。
      const failure = run.failure as { stage?: string } | null;
      if (run.phase !== "recoverable_error" || failure?.stage !== "prepare") {
        throw invalidPhase(run.phase ?? "none", "recoverable_error(stage=prepare)");
      }
      const at = now();
      // V2：重跑规划从该 run 已冻结的 LearningTargetSnapshotV2 消费（V1 的
      // live cardKeyPoints/claim 读取已随旧栈退役，方案 20 §16）。
      const snap = await loadFrozenTargetSnapshotV2(tx, input.workspaceId, run.id);
      if (!snap) {
        throw new LearningRunServiceError("target_snapshot_missing", "该 run 缺少冻结的 target snapshot", 409);
      }
      const st = snap.target;
      const timeBudgetSeconds = clampTimeBudget(run.timeBudgetSeconds);
      const [recentPublicPayloadHashes, interactionQualifications, responsePreference] = await Promise.all([
        recentPresentedPayloadHashes(tx, {
          workspaceId: input.workspaceId,
          userId: input.userId,
          keyPointId: st.objectiveId,
        }),
        // M3（2026-08-24 审查）：qualification 数据此前漏传，V1 结构题的 ceiling
        // 判定会静默退化为 practice。
        loadInteractionQualifications(tx),
        // M3：responsePreference 是请求级字段（V2 run.origin 只存严格
        // originV2，从不持久化它），此前恒回落 "adaptive"——用户原本选
        // structured 的题在重试后静默变成开放回答。改从已持久化的在册
        // Variant 交互形状确定性反推（与用户实际看到的题目一致）。
        resolveResponsePreferenceForRetry(tx, run.id),
      ]);
      const plan = planRun(
        {
          keyPointId: st.objectiveId,
          claim: st.objectiveStatement,
          sourceFingerprint: st.semanticTargetFingerprint,
          evidenceContentHashes: st.evidence.map((e) => e.evidenceSnapshotHash),
          v2: {
            objectiveStatement: st.objectiveStatement,
            publicSummary: st.publicSummary,
            knowledgeForm: st.knowledgeForm,
            preferredIntents: st.preferredIntents,
            canonicalAnswer: st.canonicalAnswer,
            scoringRubric: st.scoringRubric,
            relations: st.relations,
            practiceItem: st.practiceItem ?? null,
            evidence: st.evidence,
            publishedTargetEligibility: snap.publishedTargetEligibility,
          },
        },
        {
          runId: run.id,
          goal: run.goal as PlannerOptions["goal"],
          responsePreference,
          timeBudgetSeconds,
          recentPublicPayloadHashes,
          interactionQualifications,
        },
      );
      // 重写 planning 产物：旧 tasks 级联清除（prepare 失败时无 assessment）。
      await tx.delete(learningTasks).where(eq(learningTasks.runId, run.id));
      const task = plan.tasks[0];
      await tx.insert(learningTasks).values({
        id: task.taskId,
        runId: run.id,
        workspaceId: input.workspaceId,
        userId: input.userId,
        sequence: task.sequence,
        intent: task.intent,
        prompt: task.prompt,
        targetSummary: task.targetSummary,
        hintLevels: task.hintLevels,
        status: "active",
        revision: 1,
        presentedAt: at,
        createdAt: at,
        updatedAt: at,
      });
      for (const [index, variant] of [plan.primaryVariant, ...plan.alternativeVariants].entries()) {
        const closure = plan.closures[variant.variantId];
        await tx.insert(learningTaskVariants).values({
          id: variant.variantId,
          taskId: task.taskId,
          workspaceId: input.workspaceId,
          userId: input.userId,
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
          createdAt: at,
          updatedAt: at,
        });
        await tx.insert(learningTaskPrivateSolutions).values({
          variantId: variant.variantId,
          workspaceId: input.workspaceId,
          userId: input.userId,
          solution: closure.solution,
          privateSolutionHash: closure.privateSolutionHash,
          runPlanHash: closure.runPlanHash,
          createdAt: at,
        });
        await tx.insert(learningTaskSafetyReports).values({
          taskId: task.taskId,
          variantId: variant.variantId,
          workspaceId: input.workspaceId,
          userId: input.userId,
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
          createdAt: at,
        });
        // disclosure profile 按 hash 去重（与 createRun 一致；M2：并发下
        // check-then-insert 仍会撞唯一索引，onConflictDoNothing 收敛为幂等复用）。
        const existingDisclosure = await tx
          .select({ id: learningTaskDisclosureProfiles.id })
          .from(learningTaskDisclosureProfiles)
          .where(and(
            eq(learningTaskDisclosureProfiles.workspaceId, input.workspaceId),
            eq(learningTaskDisclosureProfiles.profileHash, variant.disclosureProfileHash),
          ))
          .limit(1);
        if (!existingDisclosure[0]) {
          await tx.insert(learningTaskDisclosureProfiles).values({
            variantId: variant.variantId,
            workspaceId: input.workspaceId,
            userId: input.userId,
            disclosedFieldPaths: closure.disclosure.disclosedFieldPaths,
            hiddenFieldPaths: closure.disclosure.hiddenFieldPaths,
            answerBearingFieldsHidden: true,
            profileHash: variant.disclosureProfileHash,
            createdAt: at,
          }).onConflictDoNothing();
        }
      }
      await tx.update(learningRuns)
        .set({
          phase: "active",
          activeTaskId: task.taskId,
          plannedActiveSeconds: plan.plannedActiveSeconds,
          failure: null,
          revision: run.revision + 1,
          updatedAt: at,
        })
        .where(eq(learningRuns.id, run.id));
      await insertRunEvent(tx, input, "learning_run.started", {}, at, run.eventCursor);
      break;
    }
    case "retry_assessment": {
      // §13.2：recoverable_error(stage=assessment) → 重新排队评估。
      const failure = run.failure as { stage?: string } | null;
      if (run.phase !== "recoverable_error" || failure?.stage !== "assessment") {
        throw invalidPhase(run.phase ?? "none", "recoverable_error(stage=assessment)");
      }
      const at = now();
      // H1（2026-08-24 审查）：重试必须覆盖 tick 失败路径留下的全部未终态
      // assessment。prepare 事务整体回滚时 assessment 退回 queued；Critic 写回
      // 事务回滚时它停在 running（prepare 事务已提交）；worker 主动收尾才写
      // failed。此前只认 failed → 重试恒 409，叠加 end 拒绝即 run 永久卡死。
      const requestedAssessmentId = input.action.kind === "retry_assessment"
        ? input.action.assessmentId
        : null;
      const assessmentRows = await tx
        .select({ id: learningAssessments.id, taskId: learningAssessments.taskId, artifactId: learningAssessments.artifactId })
        .from(learningAssessments)
        .where(and(
          eq(learningAssessments.runId, run.id),
          inArray(learningAssessments.status, ["queued", "running", "failed"]),
          ...(requestedAssessmentId ? [eq(learningAssessments.id, requestedAssessmentId)] : []),
        ))
        .orderBy(desc(learningAssessments.createdAt))
        .limit(1);
      const assessment = assessmentRows[0] ?? null;
      if (!assessment) {
        throw new LearningRunServiceError("assessment_not_found", "没有可重试的评估", 409);
      }
      await tx.update(learningAssessments)
        .set({ status: "queued", updatedAt: at })
        .where(eq(learningAssessments.id, assessment.id));
      await tx.update(learningRuns)
        .set({ phase: "assessing", failure: null, revision: run.revision + 1, updatedAt: at })
        .where(eq(learningRuns.id, run.id));
      // outbox scope key 唯一约束是 (workspace, run, idempotency_key)：同一
      // assessment 的第二次重试必须用新的 key（run.revision 每次失败/重试都
      // 递增），否则第二次重试会撞唯一索引变成裸 23505/500。
      await tx.insert(learningRunProcessingOutbox).values({
        runId: run.id,
        taskId: assessment.taskId,
        artifactId: assessment.artifactId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        commandType: "assessment_requested",
        payload: { assessmentId: assessment.id },
        idempotencyKey: `assessment:retry:${assessment.id}:${run.revision}`,
        availableAt: at,
        createdAt: at,
        updatedAt: at,
      });
      await insertRunEvent(tx, input, "learning_assessment.queued", { assessmentId: assessment.id }, at, run.eventCursor);
      break;
    }
    case "retry_commit": {
      // §13.2：recoverable_error(stage=commit) → 重新入队 Commit。
      const failure = run.failure as { stage?: string } | null;
      if (run.phase !== "recoverable_error" || failure?.stage !== "commit") {
        throw invalidPhase(run.phase ?? "none", "recoverable_error(stage=commit)");
      }
      const at = now();
      // H3（2026-08-24 审查）：重试的必须是「当前任务（正在结算的那个任务）」的
      // completed assessment。此前取 run 内任意 completed（无序），
      // activate_followup 产生第二个 assessment 后会引用错误的评估推导
      // disposition 与 canonical envelope。committing/recoverable_error(commit)
      // 期间 activeTaskId 恒为被结算任务，故按它收敛。
      const assessmentRows = await tx
        .select({ id: learningAssessments.id, taskId: learningAssessments.taskId, artifactId: learningAssessments.artifactId, trustClass: learningAssessments.trustClass })
        .from(learningAssessments)
        .where(and(
          eq(learningAssessments.runId, run.id),
          eq(learningAssessments.status, "completed"),
          ...(run.activeTaskId ? [eq(learningAssessments.taskId, run.activeTaskId)] : []),
        ))
        .orderBy(desc(learningAssessments.createdAt))
        .limit(1);
      const assessment = assessmentRows[0];
      if (!assessment) {
        throw new LearningRunServiceError("assessment_not_found", "没有可重试的 Commit", 409);
      }
      // disposition 从 completed assessment 的 trustClass 确定性推导
      // （mastery_eligible → mastery_evidence；其余可信 → facet_evidence）。
      const disposition = assessment.trustClass === "mastery_eligible" ? "mastery_evidence" : "facet_evidence";
      await tx.update(learningRuns)
        .set({ phase: "committing", failure: null, revision: run.revision + 1, updatedAt: at })
        .where(eq(learningRuns.id, run.id));
      await tx.insert(learningRunProcessingOutbox).values({
        runId: run.id,
        taskId: assessment.taskId,
        artifactId: assessment.artifactId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        commandType: "commit_requested",
        payload: { assessmentId: assessment.id, disposition, runtimeEpoch: run.runtimeEpoch },
        // outbox scope key 唯一约束含 idempotency_key：同 assessment 的第二次
        // 重试必须换 key（run.revision 每次失败/重试都递增），否则撞唯一索引
        // → 裸 23505/500。
        idempotencyKey: `commit:retry:${assessment.id}:${run.revision}`,
        availableAt: at,
        createdAt: at,
        updatedAt: at,
      });
      await insertRunEvent(tx, input, "learning_commit.failed", { retry: true }, at, run.eventCursor);
      break;
    }
    default: {
      throw new LearningRunServiceError("action_not_supported", "该操作将在后续阶段开放", 409);
    }
  }

  const snapshot = await getRunPublicView(tx, { workspaceId: input.workspaceId, userId: input.userId, runId: run.id });
  await writeLedger(requestHash, { actionResult: "state_changed", snapshot }, "state_changed", acceptedActionId);
  return { acceptedActionId, actionResult: "state_changed", snapshot };
}


export async function insertRunEvent(
  tx: ApiTransaction,
  input: ActionInput,
  eventType: string,
  payload: Record<string, unknown>,
  at: Date,
  _hintCursor: number,
): Promise<void> {
  // 事务内重读最新 cursor（调用方传入的内存快照可能已过期——同一动作
  // 连续写多条事件时必须递增，否则撞 UNIQUE(run_id, sequence)）。
  const rows = await tx
    .select({ eventCursor: learningRuns.eventCursor })
    .from(learningRuns)
    .where(eq(learningRuns.id, input.runId))
    .limit(1);
  const sequence = (rows[0]?.eventCursor ?? 0) + 1;
  await tx.insert(learningRunEvents).values({
    runId: input.runId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    sequence,
    eventType: eventType as never,
    payload: payload as never,
    occurredAt: at,
  });
  await tx.update(learningRuns)
    .set({ eventCursor: sequence, updatedAt: at })
    .where(eq(learningRuns.id, input.runId));
}

// ─── draft（§12.7 CAS）───────────────────────────────────────────────────


export async function getRunPublicView(
  tx: ApiTransaction,
  input: RunScope & { runId: string },
): Promise<LearningRunPublicV1> {
  const runRow = await loadRun(tx, input, input.runId);
  const [taskRows, variantRows, contractRows, assessmentRows] = await Promise.all([
    tx.select().from(learningTasks).where(eq(learningTasks.runId, runRow.id)),
    tx.select().from(learningTaskVariants).where(inArray(
      learningTaskVariants.taskId,
      tx.select({ id: learningTasks.id }).from(learningTasks).where(eq(learningTasks.runId, runRow.id)),
    )),
    tx.select().from(learningRunPrivateContracts).where(eq(learningRunPrivateContracts.runId, runRow.id)).limit(1),
    // H1/H3（2026-08-24 审查）：activeAssessment 必须是「最新」评估且顺序确定。
    // 此前无 ORDER BY 的 rows[0] 在多 assessment（followup）场景下会把旧评估
    // 投影成 activeAssessment，误导 recoverable_error 的重试入口。
    tx.select().from(learningAssessments)
      .where(eq(learningAssessments.runId, runRow.id))
      .orderBy(desc(learningAssessments.createdAt)),
  ]);

  const view = buildRunPublicView({
    run: {
      id: runRow.id,
      workspaceId: runRow.workspaceId,
      userId: runRow.userId,
      assistantSessionId: runRow.assistantSessionId,
      origin: runRow.origin,
      returnTarget: runRow.returnTarget,
      // 从 origin JSONB 取 objective alias（§29.4）。
      keyPointId: originObjectiveId(runRow.origin),
      targetFingerprint: runRow.targetFingerprint,
      goal: runRow.goal as never,
      phase: runRow.phase,
      timeBudgetSeconds: runRow.timeBudgetSeconds,
      plannedActiveSeconds: runRow.plannedActiveSeconds,
      activeSecondsUsed: runRow.activeSecondsUsed,
      activeTaskId: runRow.activeTaskId,
      checkpoint: runRow.checkpoint as never,
      failure: runRow.failure as never,
      projectionStatus: runRow.projectionStatus as never,
      projectionBaselineCheckpointToken: runRow.projectionBaselineCheckpointToken,
      revision: runRow.revision,
      runtimeEpoch: runRow.runtimeEpoch,
      eventCursor: runRow.eventCursor,
      result: runRow.result as unknown as LearningRunResultV1 | null,
    },
    tasks: taskRows.map((t) => ({
      id: t.id,
      runId: t.runId,
      sequence: t.sequence,
      intent: t.intent as never,
      prompt: t.prompt,
      targetSummary: t.targetSummary,
      hintLevels: t.hintLevels as never,
      status: t.status,
      revision: t.revision,
      activeVariantId: runRow.activeTaskId === t.id ? activeVariantIdFor(variantRows, t.id) : null,
    })),
    variants: variantRows.map((v) => ({
      id: v.id,
      taskId: v.taskId,
      purpose: v.purpose as never,
      templateTrustCeiling: v.templateTrustCeiling as never,
      estimatedActiveSeconds: v.estimatedActiveSeconds,
      interaction: v.interaction as never,
      publicPayloadHash: v.publicPayloadHash,
      inputSchemaHash: v.inputSchemaHash,
      disclosureProfileHash: v.disclosureProfileHash,
      revision: v.revision,
      status: v.status as never,
      alternativeFamily: null as never,
    })),
    assessment: assessmentRows[0]
      ? {
          id: assessmentRows[0].id,
          runId: assessmentRows[0].runId,
          taskId: assessmentRows[0].taskId,
          artifactId: assessmentRows[0].artifactId,
          source: assessmentRows[0].source as never,
          status: assessmentRows[0].status,
          rubricResults: assessmentRows[0].rubricResults as never,
          trustClass: assessmentRows[0].trustClass as never,
          reportHash: assessmentRows[0].reportHash,
        }
      : null,
    baselineCheckpoint: null,
    schedulingAuthorization: contractRows[0]?.schedulingAuthorization ?? null,
  });
  return view;
}

