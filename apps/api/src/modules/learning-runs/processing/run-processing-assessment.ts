/**
 * 学习运行**评估/评审**这一段（2026-09-30 拆出，P2-2）。
 *
 * ## 它是什么
 *
 * 「跑完一步模型之后，要不要评、评成什么、评不出来怎么收」——评估闸、critic 的准备与
 * 回写、补充提议、缺口帮助停机、以及"判不了"时的 fail-closed 表达。
 *
 * ## 为什么从 tick 里分出来
 *
 * `run-processing-tick.ts` 此前 2729 行，混着三件失败语义不同的事：
 * **认领与租约**（批处理）、本文件的**评估**、以及**提交与结算**。
 * 认领失败可以重试；评估失败要走 fail-closed 表达；提交失败要重验 epoch。
 * 混在一个文件里时，"这一步失败该按哪一类处理"要翻很久才看得到。
 *
 * ## 这一段是**照搬**的
 *
 * SQL、事务边界、判据一个字没改。
 *
 * ## import 的做法
 *
 * 本文件与 `run-processing-tick.ts` **同层**，所以那一整块 import 原样有效；
 * 搬过来之后由 `tsc` 报出没用的那些再删。多写一次裁剪，胜过猜对路径。
 */

import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  decideHelpConditionV2,
  helpConditionCountsAsIndependentV2,
  type HelpConditionV2,
} from "@ailearn/shared/help-condition-rules-v2";
import { StructuredTaskKind } from "../planning/run-structured.ts";
import { isDeterministicStructuredPayload } from "../planning/run-structured.ts";
import { uncoveredFacets } from "../run-result-facets.ts";
import {
  resolveApiStatementTimeoutMs,
  resolveApiLockTimeoutMs,
  resolveApiIdleInTransactionTimeoutMs,
  withWorkspaceTransaction,
} from "../../../db/client.ts";
import {
  learningAssessments,
  learningArtifacts,
  learningRunEvents,
  learningRunProcessingOutbox,
  learningRuns,
  learningTasks,
  learningTaskVariants,
} from "@ailearn/shared/db-schema/learning-runs";
import {
  evidenceEligibilityStatesV2,
  evidenceSnapshotsV2,
  learningExposuresV2,
} from "@ailearn/shared/db-schema/card-generation-v2";
import { noteBlocks } from "@ailearn/shared/db-schema/note";
// W7-8 刀二：判据在纯函数里（§9.1「自动策略不能悄悄把提醒提前」），这一层只负责
// 把那一列读出来递给它，并把「抬过」如实带回。
import { EXPOSURE_KINDS_V2 } from "@ailearn/shared/learning-card-v2-contracts";
// 39d W5-5：§14.2「待复核时不持续放大结论」的那一闸。与上面那道笔记依据闸并排调用。
import {
} from "@ailearn/shared";
import { backfillPresentationHistory } from "../run-service.ts";
// 方案 16 §20：run_result 埋点（尽力而为，独立小事务）。
import { LearningRunResultV1, LearningRunReturnTargetV1 } from "@ailearn/shared";
import { sha256Hex } from "@ailearn/shared/content-hash";
import {
  CriticOutputError,
  CriticUnavailableError,
  createOpenAICompatibleCritic,
  CRITIC_PROMPT_VERSION,
  flattenAnswerUnits,
  materializeCriticEvidenceRefs,
  type CriticInput,
} from "../planning/run-critic.ts";
import { loadFrozenTargetSnapshotV2 } from "../../card-generation-v2/target-snapshot-adapter.ts";
import { materializePracticeChangeSet } from "../../understanding/projection-service.ts";
import { readRoundGapHelpV1 } from "../gap-help/gap-help-service.ts";
// P0-13（2026-09-29 审计）：本文件此前有 16 处 `process.stderr.write`，整条结算/评估
// 链路完全绕过 pino —— 没有 reqId（request-context 的 ALS 在这条链上白建）、没有
// level、字段全是拼进字符串的，运维只能用 grep 字符串的方式关联同一个 run 的 HTTP
// 日志与后台日志。全部改为结构化 logger 调用，控制流/抛出/返回值一字未动。
import { logger } from "../../../lib/logger.ts";

const SUPPLEMENT_FOLLOWUP_ID = "supplement:1";

/**
 * 审计 F28：`not_assessable` 的原因码，与 `packages/shared` 的
 * `LearningRunPublicV1["checkpoint"]["reasonCode"]` 同集合。
 */
export type CheckpointReasonCode = "no_frozen_evidence" | "critic_unavailable" | "input_incomplete";

/** 该 run 还能不能被签发一次补充证据；已用过则返回空数组（按钮消失）。 */
export async function supplementOffer(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  runId: string,
  reasonCode?: CheckpointReasonCode,
): Promise<string[]> {
  // 审计 F28：系统侧缺冻结证据时，「继续补充证据」是一条注定再次失败的按钮——
  // 缺的是结算闸要拿来做比对的原文证据，用户再写一段话也补不上（实机：两题各
  // 39 毫秒空判，第二次连按钮都消失了）。所以这一种原因下不签发它。
  if (reasonCode === "no_frozen_evidence") return [];
  // 39d W4-6 刀四（PRD §5.3）：轮次里的练习，这一轮那条缺口已经连续两次帮助、
  // 还没有改善的证据 ⇒ 不再自动加题，把选择权交回用户。
  // 拦在签发口而不是某一个调用点：签发补充任务的地方不止一处（partial
  // checkpoint、not_assessable、Commit 拒绝的收尾），它们共用这一条"还能不能
  // 签发"的判断，拦在这里才不会有下一个口子漏签。
  if (await noteRoundGapHelpStopped(tx, runId)) return [];
  const used = await tx
    .select({ id: learningTasks.id })
    .from(learningTasks)
    .where(and(eq(learningTasks.runId, runId), gte(learningTasks.sequence, 2)))
    .limit(1);
  return used.length > 0 ? [] : [SUPPLEMENT_FOLLOWUP_ID];
}

/**
 * 这一场 run 是不是"轮次里已停"的练习（详情见 `gap-help-service.ts`）。
 *
 * 非 `note_round` 的 origin 在这一行就返回 false——别的来源（今日/复习/星图…）
 * 一个字节都不受影响，这是硬边界：PRD §5.3 说的是"轮次里同一缺口连续两次帮助"，
 * 别的入口没有"同一缺口"这个说法，就不能被这条规则顺手改掉。
 *
 * checkpoint 合同是 strict 的（多一个字段就会让整份 view 解析失败），所以
 * "为什么停"只用"空数组"表达，界面读到的是按钮消失；理由留在这里与
 * `gap-help-service.ts` 的注释里，不往合同里塞新字段。
 */
export async function noteRoundGapHelpStopped(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  runId: string,
): Promise<boolean> {
  const runRows = await tx
    .select({
      origin: learningRuns.origin,
      workspaceId: learningRuns.workspaceId,
      userId: learningRuns.userId,
    })
    .from(learningRuns)
    .where(eq(learningRuns.id, runId))
    .limit(1);
  const run = runRows[0];
  if (!run) return false;
  const origin = run.origin as { kind?: unknown; roundId?: unknown } | null;
  if (origin?.kind !== "note_round" || typeof origin.roundId !== "string") return false;
  const gapHelp = await readRoundGapHelpV1(
    tx,
    { workspaceId: run.workspaceId, userId: run.userId },
    origin.roundId,
  );
  return gapHelp.stopped;
}

/**
 * 审计 F28：把 `not_assessable` 的原因从自由文本收敛成可判定的码。
 *
 * 结算闸（`task rubric has no frozen evidence`）与通道故障以前都只留下一句
 * 「判不出结论」，界面因此把它们说成同一件事，并给出同一条注定无效的出路。
 * 判据按消息前缀匹配——抛错处就是这两句（`:826` 与 `commit fail-closed: …`），
 * 这里不做模糊猜测：不匹配的一律归 `input_incomplete`（也就是"这次提交本身
 * 不足以判定"），不编造系统侧原因。
 */
export function classifyFailClosedReason(message: string): CheckpointReasonCode {
  if (message.startsWith("task rubric has no frozen evidence")) return "no_frozen_evidence";
  // 同一族：任务闭包漏掉必选评分点，效果与"该评分点没有证据"完全一样——
  // 用户提交多少字都补不上。
  if (message.startsWith("task closure omits required rubric")) return "no_frozen_evidence";
  if (message.startsWith("commit fail-closed:")) return "no_frozen_evidence";
  if (message.startsWith("empty answer text") || message.startsWith("task not found")) return "input_incomplete";
  return "critic_unavailable";
}

export async function processAssessmentCommand(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
): Promise<CriticAssessmentContext | null> {
  const assessmentId = String(command.payload.assessmentId ?? "");
  if (!assessmentId) return null; // 幂等缺参：标记处理完不重试。
  const assessmentRows = await tx
    .select()
    .from(learningAssessments)
    .where(and(eq(learningAssessments.id, assessmentId), eq(learningAssessments.runId, command.runId)))
    .limit(1);
  const assessment = assessmentRows[0];
  if (!assessment) {
    logger.warn(
      {
        runId: command.runId,
        workspaceId: command.workspaceId,
        commandType: command.commandType,
        outboxRowId: command.id,
        taskId: command.taskId,
        artifactId: command.artifactId,
        assessmentId,
      },
      "[run-tick] no assessment row",
    );
    return null;
  }
  // 已处理（重放）：assessment 已不在 queued（completed/failed/not_assessable）。
  if (assessment.status !== "queued") {
    logger.debug(
      {
        runId: command.runId,
        workspaceId: command.workspaceId,
        commandType: command.commandType,
        outboxRowId: command.id,
        assessmentId,
        assessmentStatus: assessment.status,
      },
      "[run-tick] assessment already settled (not queued, replay)",
    );
    return null;
  }

  // deterministic_structured 虽没有事务外 HTTP，仍会读取 private solution 并写
  // assessment/run。与 end(abandonLockedEvidence) 抢同一 run 行锁，避免两者
  // 并发时用过期 phase/revision 将已经结束的 Run 覆盖成 checkpoint/completed。
  const runRows = await tx
    .select()
    .from(learningRuns)
    .where(eq(learningRuns.id, command.runId))
    .limit(1)
    .for("update");
  const run = runRows[0];
  if (!run) {
    logger.warn(
      {
        runId: command.runId,
        workspaceId: command.workspaceId,
        commandType: command.commandType,
        outboxRowId: command.id,
        taskId: command.taskId,
        artifactId: command.artifactId,
        assessmentId,
      },
      "[run-tick] no run row",
    );
    return null;
  }
  // end 已前移 epoch：迟到评估保留报告但无副作用。
  if (run.phase !== "assessing") {
    logger.debug(
      {
        runId: command.runId,
        workspaceId: command.workspaceId,
        commandType: command.commandType,
        outboxRowId: command.id,
        assessmentId,
        runPhase: run.phase,
      },
      "[run-tick] run not assessing (late assessment)",
    );
    return null;
  }

  const at = new Date();
  await tx.update(learningAssessments)
    .set({ status: "running", updatedAt: at })
    .where(eq(learningAssessments.id, assessmentId));

  if (assessment.source === "deterministic_declared_unable") {
    await finishDeclaredUnableAssessment(tx, command, assessmentId, run, at);
    return null;
  }

  if (assessment.source === "deterministic_structured") {
    // P4：确定性评估（private solution 对比）。读 solution 失败 fail closed。
    try {
      await finishStructuredAssessment(tx, command, assessmentId, run, at);
    } catch (err) {
      if (err instanceof CriticOutputError) {
        const reportHash = sha256Hex(`fail-closed:${assessmentId}:structured:${err.message}`);
        const reasonCode = classifyFailClosedReason(err.message);
        await tx.update(learningAssessments)
          .set({ status: "not_assessable", rubricResults: [], trustClass: null, reportHash, updatedAt: at })
          .where(eq(learningAssessments.id, assessmentId));
        await appendRunEvent(tx, command, "learning_assessment.not_assessable", { assessmentId, reasonCode }, at);
        await tx.update(learningRuns)
          .set({
            phase: "checkpoint",
            checkpoint: {
              kind: "not_assessable",
              allowedFollowupIds: await supplementOffer(tx, command.runId, reasonCode),
              reasonCode,
            },
            revision: run.revision + 1,
            updatedAt: at,
          })
          .where(eq(learningRuns.id, command.runId));
        return null;
      }
      throw err;
    }
    return null;
  }

  // assessment_critic：事务内只读输入与标记；HTTP 调用由调用方在事务外执行。
  try {
    return await prepareCriticAssessment(tx, command, assessmentId, run, at);
  } catch (err) {
    if (err instanceof CriticUnavailableError || err instanceof CriticOutputError) {
      // 与 HTTP 分支（:315）同一条 dev 可观测性：此前只有那条打日志，prepare
      // 分支静默 fail closed，于是"每题都 not_assessable"在 API 日志里读不出
      // 任何原因（2026-09-23 定位补充任务的 500 只能去翻 postgres 日志）。
      logger.error(
        {
          err,
          errorMessage: err.message,
          reasonCode: classifyFailClosedReason(err.message),
          runId: command.runId,
          workspaceId: command.workspaceId,
          commandType: command.commandType,
          outboxRowId: command.id,
          taskId: command.taskId,
          assessmentId,
        },
        "[run-tick] critic input fail-closed",
      );
      await failClosedNotAssessable(
        tx,
        command,
        assessmentId,
        at,
        undefined,
        classifyFailClosedReason(err.message),
      );
      return null;
    }
    throw err;
  }
}

/**
 * Critic 不可用/输出非法时的 fail-closed 结算：not_assessable（0 正负副作用）。
 * 供事务内（prepare 阶段）与事务外（Critic HTTP 调用失败）两处复用；
 * revision 用原子自增，避免并发 stale。
 */
export async function failClosedNotAssessable(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
  assessmentId: string,
  at: Date = new Date(),
  expectedRuntimeEpoch?: number,
  reasonCode: CheckpointReasonCode = "critic_unavailable",
): Promise<void> {
  // Critic HTTP 在事务外完成。写回前必须与 end(abandonLockedEvidence)
  // 争夺同一 run row lock，避免迟到的失败结算把已结束 run 改回 checkpoint。
  const runRows = await tx
    .select({ phase: learningRuns.phase, runtimeEpoch: learningRuns.runtimeEpoch })
    .from(learningRuns)
    .where(eq(learningRuns.id, command.runId))
    .limit(1)
    .for("update");
  const run = runRows[0];
  if (
    !run
    || run.phase !== "assessing"
    || (expectedRuntimeEpoch !== undefined && run.runtimeEpoch !== expectedRuntimeEpoch)
  ) {
    await tx.update(learningAssessments)
      .set({ status: "failed", rubricResults: [], trustClass: null, reportHash: null, updatedAt: at })
      .where(and(
        eq(learningAssessments.id, assessmentId),
        eq(learningAssessments.status, "running"),
      ));
    return;
  }
  const reportHash = sha256Hex(`fail-closed:${assessmentId}:critic-unavailable:v1`);
  await tx.update(learningAssessments)
    .set({ status: "not_assessable", rubricResults: [], trustClass: null, reportHash, updatedAt: at })
    .where(eq(learningAssessments.id, assessmentId));
  await appendRunEvent(tx, command, "learning_assessment.not_assessable", { assessmentId, reasonCode }, at);
  await tx.update(learningRuns)
    .set({
      phase: "checkpoint",
      checkpoint: {
        kind: "not_assessable",
        allowedFollowupIds: await supplementOffer(tx, command.runId, reasonCode),
        reasonCode,
      },
      revision: sql`revision + 1`,
      updatedAt: at,
    })
    .where(eq(learningRuns.id, command.runId));
}

export interface CriticAssessmentContext {
  assessmentId: string;
  at: Date;
  input: CriticInput;
  helpCondition: HelpConditionV2;
  variantCeiling: string | null;
  returnTarget: unknown;
  runtimeEpoch: number;
}

/** 事务内准备 Critic 评估：读输入、提示暴露和 Variant 上限。 */
export async function prepareCriticAssessment(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
  assessmentId: string,
  run: {
    id: string;
    revision: number;
    runtimeEpoch: number;
    eventCursor: number;
    returnTarget: unknown;
  },
  at: Date,
): Promise<CriticAssessmentContext> {
  const input = await gatherCriticInput(tx, command);
  // 提示暴露仍只能按 practice 结算，但要保留逐 rubric 的诊断反馈，不能跳过
  // Critic 而把用户的回答一律写成空结果。
  const helpCondition = await readHelpConditionV2(tx, command);
  const variantCeiling = await readVariantCeiling(tx, command.artifactId);
  logger.debug(
    {
      runId: command.runId,
      workspaceId: command.workspaceId,
      commandType: command.commandType,
      outboxRowId: command.id,
      taskId: command.taskId,
      assessmentId,
      helpCondition,
      variantCeiling,
    },
    "[run-tick] prepare ok",
  );
  return {
    assessmentId,
    at,
    input,
    helpCondition,
    variantCeiling,
    returnTarget: run.returnTarget,
    runtimeEpoch: run.runtimeEpoch,
  };
}

/** 事务内写入 Critic verdicts（HTTP 已在事务外完成）。 */
export async function finishCriticAssessmentWrite(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
  context: CriticAssessmentContext,
  verdicts: ReturnType<ReturnType<typeof createOpenAICompatibleCritic>["assess"]> extends Promise<infer T> ? T : never,
): Promise<void> {
  const {
    assessmentId,
    at,
    input,
    helpCondition: helpConditionAtPrepare,
    variantCeiling,
    returnTarget,
    runtimeEpoch,
  } = context;
  // 与 end(abandonLockedEvidence) 串行：若 end 先赢，迟到的 Critic 结果只能
  // 将 assessment 收尾为 failed，绝不重开 run 或写入 canonical commit。
  const runRows = await tx
    .select()
    .from(learningRuns)
    .where(eq(learningRuns.id, command.runId))
    .limit(1)
    .for("update");
  const runRow = runRows[0];
  if (runRow?.phase !== "assessing" || runRow.runtimeEpoch !== runtimeEpoch) {
    await tx.update(learningAssessments)
      .set({ status: "failed", rubricResults: [], trustClass: null, reportHash: null, updatedAt: at })
      .where(and(
        eq(learningAssessments.id, assessmentId),
        eq(learningAssessments.status, "running"),
      ));
    return;
  }
  // 防御性二次读取：即使未来放宽 assessing 期间的辅助动作，也不会让晚到的
  // hint 把独立作答误记为正式掌握。
  const helpCondition = helpConditionAtPrepare ?? await readHelpConditionV2(tx, command);
  const allCovered = verdicts.length > 0 && verdicts.every((v) => v.verdict === "covered");

  // §7.7 上限钳制：评估结果与提交 Variant 的 templateTrustCeiling 取最小。
  // practice/diagnostic/facet ceiling 的 Variant 即使全对也绝不能达 mastery——
  // 否则 practice Run 换模态（switch_variant 到 standby）即可绕过上限。
  const ceilingOrder = ["practice_only", "diagnostic_only", "facet_eligible", "mastery_eligible"] as const;
  // §14.1.1：只有 `independent` 那一档能签发独立证据。`unreconcilable`（判不出来）
  // 与 `unknown_no_evidence`（连判的东西都没有）都**不**算——这里原先判的是
  // 「有没有提示过」，读不到回执时它返回 false，于是「判不出来」被当成「确凿独立」。
  const notIndependent = !helpConditionCountsAsIndependentV2(helpCondition);
  const evaluated = notIndependent
    ? "practice_only"
    : allCovered
      ? "mastery_eligible"
      : "facet_eligible";
  // 未知 ceiling（含 not_assessable 或脏数据）一律钳到 practice_only（fail closed）。
  const ceiling = ceilingOrder.includes(variantCeiling as (typeof ceilingOrder)[number])
    ? (variantCeiling as (typeof ceilingOrder)[number])
    : "practice_only";
  const trustClass = ceilingOrder[Math.min(
    ceilingOrder.indexOf(evaluated),
    ceilingOrder.indexOf(ceiling),
  )];

  const rubricResults = verdicts.map((v) => ({
    rubricItemId: v.rubricItemId,
    facet: input.v2?.assessedRubricUnits.find((unit) => unit.rubricUnitId === v.rubricItemId)?.facet
      ?? input.intent,
    verdict: v.verdict,
    userFacingReason: v.userFacingReason,
  }));
  const reportHash = sha256Hex(JSON.stringify({ assessmentId, verdicts, helpCondition, variantCeiling }));
  await tx.update(learningAssessments)
    .set({ status: "completed", rubricResults, trustClass, reportHash, updatedAt: at })
    .where(eq(learningAssessments.id, assessmentId));
  await appendRunEvent(tx, command, "learning_assessment.completed", { assessmentId }, at);

  if (notIndependent || !allCovered || trustClass === "practice_only" || trustClass === "diagnostic_only") {
    // 提示暴露 / 部分覆盖 / ceiling 钳制为 practice 或 diagnostic：
    // 均不进入 canonical Commit。
    if (notIndependent || trustClass === "practice_only" || trustClass === "diagnostic_only") {
      const result: LearningRunResultV1 = {
        outcome: "practice_completed",
        demonstratedFacets: [],
        // 缺口按真实判定来。此前这里无条件写 [input.intent]，于是四条 rubric 全
        // covered 的作答也会结算成「还需补上：回忆」——结算页同屏摆着四行
        // 「说清了」和一句「你欠着回忆」，用户读到的是自相矛盾（31 号文档 P1）。
        // 结构化那条分支（:1108）早就是按 verdict 来的，这里是漏改的那一条。
        // demonstratedFacets 仍留空：练习不买掌握证据，这是合同边界，不是 bug。
        gapFacets: uncoveredFacets(rubricResults) as never,
        scheduleImpact: {
          kind: "none",
          reasonCode: trustClass === "diagnostic_only" ? "diagnostic_only" : "practice_only",
        },
        returnTarget: returnTarget as LearningRunReturnTargetV1,
      };
      await tx.update(learningRuns)
        .set({ phase: "completed", result: result as never, revision: runRow.revision + 1, updatedAt: at })
        .where(eq(learningRuns.id, command.runId));
      await appendRunEvent(tx, command, "learning_run.completed", {}, at);
    // §7.8：结算回填 presentation_history（outcome/exposed，按 runId 幂等）。
    await backfillPresentationHistory(tx, { runId: command.runId, outcome: result.outcome });
      // P6 Journey：真实首轮结算事件驱动旅程推进（JourneyReducer 唯一写步进）。
      await hookJourneyOnRunCompleted(tx, command, {
        runId: command.runId,
        result: result as unknown as Record<string, unknown>,
      }, at);
      return;
    }
    await tx.update(learningRuns)
      .set({
        phase: "checkpoint",
        checkpoint: { kind: "partial", allowedFollowupIds: await supplementOffer(tx, command.runId) },
        revision: runRow.revision + 1,
        updatedAt: at,
      })
      .where(eq(learningRuns.id, command.runId));
    return;
  }

  // 全部 covered 且无 exposure → demonstrated：进入 Commit（canonical）。
  await tx.update(learningRuns)
    .set({ phase: "committing", revision: runRow.revision + 1, updatedAt: at })
    .where(eq(learningRuns.id, command.runId));
  await tx.insert(learningRunProcessingOutbox).values({
    runId: command.runId,
    taskId: command.taskId,
    artifactId: command.artifactId,
    workspaceId: command.workspaceId,
    userId: command.userId,
    commandType: "commit_requested",
    payload: { assessmentId, disposition: "mastery_evidence", runtimeEpoch: runRow.runtimeEpoch },
    idempotencyKey: `commit:${assessmentId}`,
    availableAt: at,
    createdAt: at,
    updatedAt: at,
  });
}

/** 收集 Critic 输入：答案正文 + 题面 + claim + 证据引用 + rubric 目标。 */
export async function gatherCriticInput(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
): Promise<CriticInput> {
  // 并行读取相互独立的资源（artifact / task），缩短处理路径耗时。
  const [artifactRows, taskRows] = await Promise.all([
    tx
      .select()
      .from(learningArtifacts)
      .where(eq(learningArtifacts.id, command.artifactId ?? ""))
      .limit(1),
    tx
      .select()
      .from(learningTasks)
      .where(and(eq(learningTasks.id, command.taskId), eq(learningTasks.runId, command.runId)))
      .limit(1),
  ]);
  const artifact = artifactRows[0];
  const payload = (artifact?.payload ?? {}) as { kind?: string; text?: string; confirmedTranscript?: string };
  const answerText = payload.kind === "voice"
    ? (payload.confirmedTranscript ?? "").trim()
    : (payload.text ?? "").trim();
  if (answerText.length === 0) throw new CriticOutputError("empty answer text");

  const task = taskRows[0];
  if (!task) throw new CriticOutputError("task not found");

  const variantRows = await tx
    .select()
    .from(learningTaskVariants)
    .where(eq(learningTaskVariants.id, artifact?.variantId ?? ""))
    .limit(1);
  const variant = variantRows[0];
  const rubricTargetIds = Array.isArray(variant?.rubricTargetIds)
    ? (variant.rubricTargetIds as string[])
    : [];
  if (rubricTargetIds.length === 0) throw new CriticOutputError("no rubric targets");
  if (new Set(rubricTargetIds).size !== rubricTargetIds.length) {
    throw new CriticOutputError("duplicate rubric targets in task closure");
  }

  const snapshot = await loadFrozenTargetSnapshotV2(tx, command.workspaceId, command.runId);
  if (!snapshot) throw new CriticOutputError("V2 run missing frozen snapshot");
  const canon = snapshot.target;
  const answerUnits = flattenAnswerUnits(canon.canonicalAnswer);
  const rubricById = new Map(canon.scoringRubric.units.map((unit) => [unit.rubricUnitId, unit]));
  const assessedRubricUnits = rubricTargetIds.map((rubricTargetId) => {
    const unit = rubricById.get(rubricTargetId);
    if (!unit) throw new CriticOutputError(`task closure references unknown rubric: ${rubricTargetId}`);
    return {
      rubricUnitId: unit.rubricUnitId,
      criterion: unit.criterion,
      facet: unit.facet,
      required: unit.required,
    };
  });
  const closureTargetIds = new Set(rubricTargetIds);
  for (const requiredUnit of canon.scoringRubric.units.filter((unit) => unit.required)) {
    if (!closureTargetIds.has(requiredUnit.rubricUnitId)) {
      throw new CriticOutputError(`task closure omits required rubric: ${requiredUnit.rubricUnitId}`);
    }
  }
  const assessedEvidence = canon.evidence.filter((e) =>
    e.targetUnit.kind === "rubric" && rubricTargetIds.includes(e.targetUnit.rubricUnitId),
  );
  for (const rubricTargetId of rubricTargetIds) {
    if (!assessedEvidence.some((e) =>
      e.targetUnit.kind === "rubric" && e.targetUnit.rubricUnitId === rubricTargetId,
    )) {
      throw new CriticOutputError(`task rubric has no frozen evidence: ${rubricTargetId}`);
    }
  }
  const evidenceSnapshotIds = [...new Set(assessedEvidence.map((e) => e.evidenceSnapshotId))];
  // drizzle + postgres-js 对 UUID 数组参数存在已知序列化边界；snapshot id 来自
  // 已冻结且校验过的 binding，使用显式 uuid[] 与 target snapshot adapter 保持一致。
  const evidenceSnapshotIdsLiteral = `{${evidenceSnapshotIds.join(",")}}`;
  const evidenceRows = await tx
    .select({
      evidenceSnapshotId: evidenceSnapshotsV2.evidenceSnapshotId,
      evidenceSnapshotHash: evidenceSnapshotsV2.evidenceSnapshotHash,
      quoteHash: evidenceSnapshotsV2.quoteHash,
      blockContentHash: evidenceSnapshotsV2.blockContentHash,
      startOffset: evidenceSnapshotsV2.startOffset,
      endOffset: evidenceSnapshotsV2.endOffset,
      blockContent: noteBlocks.content,
    })
    .from(evidenceSnapshotsV2)
    .innerJoin(evidenceEligibilityStatesV2, and(
      eq(evidenceEligibilityStatesV2.workspaceId, evidenceSnapshotsV2.workspaceId),
      eq(evidenceEligibilityStatesV2.evidenceSnapshotId, evidenceSnapshotsV2.evidenceSnapshotId),
    ))
    .innerJoin(noteBlocks, and(
      eq(noteBlocks.workspaceId, evidenceSnapshotsV2.workspaceId),
      eq(noteBlocks.id, evidenceSnapshotsV2.blockId),
    ))
    .where(and(
      eq(evidenceSnapshotsV2.workspaceId, command.workspaceId),
      eq(evidenceEligibilityStatesV2.status, "usable"),
      sql`${evidenceSnapshotsV2.evidenceSnapshotId} = ANY(${evidenceSnapshotIdsLiteral}::uuid[])`,
    ));
  const evidenceRefs = materializeCriticEvidenceRefs(assessedEvidence, evidenceRows);
  return {
    taskPrompt: task.prompt,
    claim: canon.objectiveStatement,
    evidenceQuotes: evidenceRefs.map((e) => e.preview),
    answerText,
    intent: task.intent,
    rubricTargetIds,
    v2: {
      objectiveStatement: canon.objectiveStatement,
      canonicalAnswerUnits: answerUnits,
      assessedRubricUnits,
      evidenceRefs,
      taskIntent: task.intent,
      taskPrompt: task.prompt,
      interactionFamily: typeof variant?.interaction === "object" && variant.interaction && "kind" in variant.interaction
        ? String((variant.interaction as { kind: string }).kind)
        : "unknown",
      publicPayloadHash: variant?.publicPayloadHash ?? null,
      artifactText: answerText,
      semanticTargetFingerprint: canon.semanticTargetFingerprint,
      targetRevisionHash: canon.targetRevisionHash,
      snapshotHash: snapshot.snapshotHash,
      criticVersion: CRITIC_PROMPT_VERSION,
    },
  };
}

/**
 * 评估期"近期揭示"窗口。**必须与规划期那一份相等**
 * （`target-snapshot-adapter.ts` 的 `RECENT_REVEAL_WINDOW_MS`）——两处判的是同一个
 * "近期"，不相等就会出现"出题时算近期、锁定时不算"或反过来的分岔。没有从 shared
 * 抽一个共同常量，是因为那会把 card-generation-v2 拖进 learning-runs 的依赖图；
 * 改用一条守卫钉住两份相等（`learning-run-locked-answer-exposure-guard.test.ts`）。
 */
export const ASSESSMENT_REVEAL_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 这一次作答的**帮助条件**（§14.1.1；39d W5-1 主体刀二）。
 *
 * ## 为什么它是**唯一**一个读侧
 *
 * 此前有**两个**读侧读同一批事实：`hasHintExposure`（决定 `trustClass`）与三处
 * 写死 `unassistedEligibleAfter: null` 的排期调用。两个来源必然有一天说不一样的话，
 * 而它们今天说的正好是相反的两句：
 *  - 证据侧：`读不到回执 ⇒ 没有被帮助 ⇒ 可以是独立表现`；
 *  - 规则侧（§14.1.1）：`判不出来 ⇒ 保留回答但**不签发**独立证据`。
 *
 * 于是把两个读侧收成这一个：**四档**由 `decideHelpConditionV2` 判一次，
 * 证据侧读 `helpConditionCountsAsIndependentV2`、排期侧读 `helpConditionCooldownAfterV2`，
 * 两边同源。写死 `null` 那种「判不出来＝确凿独立」的形状没有第二处可以藏。
 *
 * **三样入参都取自既有读侧，没有新建事实类别**（39b §9.7 / 39 §15.3-19 的纪律）：
 *  - 锁定时刻：`learning_artifacts.lockedAt`（§14.1.1 的界就在这里）；
 *  - 帮助**请求**时刻：`learning_task.hint_requested` 事件；
 *  - 帮助**呈现**回执：`learning_exposures_v2` 里落在同一目标上的最近一条。
 *
 * **取不到锁定时刻就落 `unknown_no_evidence`**，不猜：没有锁定记录就无从谈先后，
 * 而猜成 `independent` 正是今天那个 bug 的另一副面孔。
 */
export async function readHelpConditionV2(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: { runId: string; artifactId?: string | null },
): Promise<HelpConditionV2> {
  if (!command.artifactId) return "unknown_no_evidence";
  const lockedRows = await tx
    .select({ lockedAt: learningArtifacts.lockedAt })
    .from(learningArtifacts)
    .where(eq(learningArtifacts.id, command.artifactId))
    .limit(1);
  const answerLockedAt = lockedRows[0]?.lockedAt ?? null;
  if (!answerLockedAt) return "unknown_no_evidence";

  const hintRows = await tx
    .select({ occurredAt: learningRunEvents.occurredAt })
    .from(learningRunEvents)
    .where(and(
      eq(learningRunEvents.runId, command.runId),
      eq(learningRunEvents.eventType, "learning_task.hint_requested"),
    ))
    .orderBy(asc(learningRunEvents.occurredAt))
    .limit(1);
  // 取**最早**那一条：判定问的是「锁定前有没有请求过帮助」，不是「最后一次」。
  // 取最近那一条会让同一次作答里先要提示、后要提示的轮次把前面那次藏掉。
  const helpRequestedAt = hintRows[0]?.occurredAt ?? null;

  const runRows = await tx
    .select({
      workspaceId: learningRuns.workspaceId,
      userId: learningRuns.userId,
      objectiveId: sql<string | null>`${learningRuns.origin} ->> 'objectiveId'`,
    })
    .from(learningRuns)
    .where(eq(learningRuns.id, command.runId))
    .limit(1);
  const run = runRows[0];

  let helpPresentedAt: Date | null = null;
  if (run?.objectiveId) {
    const exposureRows = await tx
      .select({ exposedAt: learningExposuresV2.exposedAt })
      .from(learningExposuresV2)
      .where(and(
        eq(learningExposuresV2.workspaceId, run.workspaceId),
        eq(learningExposuresV2.userId, run.userId),
        eq(learningExposuresV2.objectiveId, run.objectiveId),
        inArray(learningExposuresV2.exposureKind, [...EXPOSURE_KINDS_V2]),
      ))
      .orderBy(asc(learningExposuresV2.exposedAt))
      .limit(1);
    helpPresentedAt = exposureRows[0]?.exposedAt ?? null;
  }

  // **窗口不是可选项**：§16.37(a) 与 §16.21 判的是「**这次**作答有没有被帮助」，
  // 不是「这个目标上曾经被帮助过」。同篇笔记昨天的一次提示会让今天的作答落进
  // 「借助完成」——那会让用户看到一份从没借过手的回答被记成借助，而它在屏上无法自辩。
  //
  // 窗口与规划期那道闸**必须相等**（有守卫钉住），否则会出现「出题算近期、锁定不算」
  // 的分岔：同一份揭示在两个时刻得到两个答案。
  const gapMs = helpPresentedAt ? answerLockedAt.getTime() - helpPresentedAt.getTime() : null;
  const presentedWithinWindow =
    gapMs !== null && gapMs >= 0 && gapMs < ASSESSMENT_REVEAL_WINDOW_MS;

  // `reconcilable` 是「今天有没有能力把锁定前是否呈现过帮助判清楚」的**能力开关**，
  // 不由本次作答决定。有了锁定时刻就有比较的基准，所以这一侧是 `true`；
  // 取不到目标时仍返回 true —— `decideHelpConditionV2` 会因为没有呈现回执而落
  // `unreconcilable`，那正是「请求过但对不上」该去的那一档，而不是悄悄放行。
  return decideHelpConditionV2({
    answerLockedAt,
    helpRequestedAt,
    // 窗口外的那次呈现按「没对上」处理 ⇒ 请求过帮助就落 `unreconcilable`，
    // 而**不是**被当成「确凿独立」放行。判不出来与确凿独立在下游必须长得不一样。
    helpPresentedAt: presentedWithinWindow ? helpPresentedAt : null,
    reconcilable: true,
  });
}

/** 提交 Artifact 的 Variant ceiling（§7.7 上限钳制的权威输入）。 */
export async function readVariantCeiling(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  artifactId: string | null,
): Promise<string | null> {
  if (!artifactId) return null;
  const artifactRows = await tx
    .select({ variantId: learningArtifacts.variantId })
    .from(learningArtifacts)
    .where(eq(learningArtifacts.id, artifactId))
    .limit(1);
  const variantId = artifactRows[0]?.variantId;
  if (!variantId) return null;
  const variantRows = await tx
    .select({ templateTrustCeiling: learningTaskVariants.templateTrustCeiling })
    .from(learningTaskVariants)
    .where(eq(learningTaskVariants.id, variantId))
    .limit(1);
  return variantRows[0]?.templateTrustCeiling ?? null;
}

// ─── P4 deterministic_structured 评估 ────────────────────────────────────

/**
 * private solutions 读取连接串（worker 角色，按设计绕过 RLS 读私解）。
 *
 * L2（2026-08-24 审查）：此前生产环境缺 env 时会静默连本地
 * postgres://…@127.0.0.1:5432（开发默认值），把结构题评估静默降级为
 * fail-closed；且回落 DATABASE_URL_API 时该角色对 private 表无 SELECT，
 * 同样只会得到 not_assessable。现在：生产环境只接受显式 env（缺失即
 * fail fast，与 db/client.ts 的 DATABASE_URL_API 纪律一致）；非生产环境
 * 保留本地默认，但回落到 API 角色时打告警。
 */
export function resolveStructuredSolutionConnectionString(): string {
  const workerUrl = process.env.DATABASE_URL_WORKER?.trim();
  if (workerUrl) return workerUrl;
  const apiUrl = process.env.DATABASE_URL_API?.trim();
  if (apiUrl) {
    if (process.env.NODE_ENV === "production") {
      logger.warn(
        { nodeEnv: process.env.NODE_ENV, source: "DATABASE_URL_API" },
        "[run-tick] DATABASE_URL_WORKER 未配置：回落 DATABASE_URL_API，该角色无 private solution SELECT 权限——结构题评估将 fail closed",
      );
    }
    return apiUrl;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL_WORKER (or DATABASE_URL_API) is required when NODE_ENV=production");
  }
  return "postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn";
}

/** private solutions 读取连接：worker 角色（RLS 豁免）；dev fallback 用 API 连接。 */
import postgres from "postgres";
import { practiceTrailEventOutbox } from "@ailearn/shared/db-schema/learning-runs";

const structuredSolutionSql = postgres(
  resolveStructuredSolutionConnectionString(),
  {
    max: 2,
    // 空闲自动断开：tick 长驻进程中不累积连接；测试进程可在连接回收后退出。
    idle_timeout: 30,
    connect_timeout: 10,
    // 稳定 P1-2（2026-09-15 审计）：此前该池无语句超时，一条挂起的
    // private-solution 读会钉住 tick 的整条串行链（server.ts 的 tick 是
    // 单个 setTimeout 链，无总预算）。给出确定上界。
    // W3-2：该池与 API 主池共用语句、锁等待与 idle-in-transaction 三个限值。
    connection: {
      statement_timeout: resolveApiStatementTimeoutMs(),
      lock_timeout: resolveApiLockTimeoutMs(),
      idle_in_transaction_session_timeout: resolveApiIdleInTransactionTimeoutMs(),
    },
  },
);

/** 显式关闭 worker 只读连接（graceful shutdown / 测试 after 调用）。 */
export async function closeStructuredSolutionSql(): Promise<void> {
  await structuredSolutionSql.end({ timeout: 2 }).catch(() => {});
}

/** P4：确定性评估 → verdicts → practice 结算（0 canonical/schedule）。 */
export async function finishStructuredAssessment(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
  assessmentId: string,
  run: { id: string; revision: number; runtimeEpoch: number; eventCursor: number },
  at: Date,
): Promise<void> {
  const artifactRows = await tx
    .select()
    .from(learningArtifacts)
    .where(eq(learningArtifacts.id, command.artifactId ?? ""))
    .limit(1);
  const artifact = artifactRows[0];
  const payload = (artifact?.payload ?? {}) as Record<string, unknown>;
  const payloadKind = payload.kind;
  /**
   * 这张表**必须**与路由共用同一个真相（`isDeterministicStructuredPayload`）。
   *
   * 2026-09-21 实机踩到：路由那一侧已经改用了共用表，这里却还留着一份**逐字枚举**，
   * 于是 choice / true_false / matching 三种客观题载荷走到这里就 fail closed →
   * `not_assessable` + `checkpoint`，界面上是一屏「等待下一步 / 正在准备下一步」，
   * 用户点完选项后彻底卡住（截图与 `learning_assessments` 双证据）。
   * 这正是复盘 §7 记过的同一个失效形状：链路看起来通了，最后一公里静默降级。
   */
  if (typeof payloadKind !== "string" || !isDeterministicStructuredPayload(payloadKind)) {
    throw new CriticOutputError("structured assessment: unsupported payload kind");
  }

  const taskRows = await tx
    .select({ intent: learningTasks.intent })
    .from(learningTasks)
    .where(and(eq(learningTasks.id, command.taskId), eq(learningTasks.runId, command.runId)))
    .limit(1);
  const task = taskRows[0];
  if (!task) throw new CriticOutputError("structured assessment: task not found");

  // private solution：worker 角色读（api 角色对该表无 SELECT，§16.1 隔离）。
  // 权限/连接类错误同样 fail closed（不重试风暴），绝不带着半读状态评估。
  let solution: Record<string, unknown> | null = null;
  try {
    const solutionRows = await structuredSolutionSql`
      SELECT s.solution
      FROM learning_task_private_solutions s
      JOIN learning_task_variants v ON v.id = s.variant_id
      WHERE v.id = ${artifact?.variantId ?? ""} AND v.workspace_id = ${command.workspaceId}
      LIMIT 1
    `;
    solution = (solutionRows[0]?.solution ?? null) as Record<string, unknown> | null;
  } catch (err) {
    throw new CriticOutputError(
      `structured assessment: solution not readable (${err instanceof Error ? err.message.slice(0, 80) : "unknown"})`,
    );
  }
  if (!solution) throw new CriticOutputError("structured assessment: solution not readable");

  const { assessStructuredPayload, assessStructuredBundlePayload, orderingUnitFeedbackV1 } = await import("../planning/run-structured.ts");
  // §5.3/§12.3 structured_bundle：一次 Assessment 评估整个 bundle Artifact
  // （逐 part 确定性对比，取最低 verdict；part 缺失/伪造在提交层已拒绝）。
  const assessment = payloadKind === "structured_bundle"
    ? assessStructuredBundlePayload(payload, solution)
    : assessStructuredPayload(payloadKind as StructuredTaskKind, payload, solution);

  const rubricTargetIds = Array.isArray(solution.rubricTargetIds)
    ? (solution.rubricTargetIds as string[])
    : [];
  /**
   * §5.4 逐位反馈（39d W4-7 刀一）：ordering 今天能按位拆开，就**只报按位的这几格**，
   * 不再另外留一格聚合计数。理由是一条数的问题：结果页那句「N 个要点里证明了 M 个」
   * （`learning-run-surface.tsx:374`）是按条目数数的，聚合格与它按位拆出的那几格说的是
   * **同一件事**，两代同屏就是把一件事数两遍——一个用户可见的数只准有一个来源。
   *
   * 不动的是判据本身：聚合 `assessment.verdict` 仍原样写进结算、上限与 `reportHash`
   * （上面那两条都读它），这一刀只改"反馈说成什么形状"。
   * 标签读在 `tx` 这一侧而不是私解那条连接：`interaction` 是公开面，
   * worker 那条连接只该读私解（§16.1 的隔离就在这条分工上）。
   */
  let unitRows: Array<{ interaction: unknown }> = [];
  if (payloadKind === "ordering" && artifact?.variantId) {
    unitRows = await tx
      .select({ interaction: learningTaskVariants.interaction })
      .from(learningTaskVariants)
      .where(eq(learningTaskVariants.id, artifact.variantId))
      .limit(1);
  }
  const unitPrefix = rubricTargetIds[0] ?? `task:${command.taskId ?? command.artifactId ?? assessmentId}`;
  const rubricResults = payloadKind === "ordering"
    ? orderingUnitFeedbackV1({
      orderedTokenIds: Array.isArray(payload.orderedTokenIds) ? (payload.orderedTokenIds as string[]) : [],
      correctTokenIds: Array.isArray(solution.correctTokenIds) ? (solution.correctTokenIds as string[]) : [],
      labels: ((unitRows[0]?.interaction as { publicTokenLabels?: Record<string, string> } | null)
        ?.publicTokenLabels) ?? {},
    }).map((unit) => ({
      rubricItemId: `${unitPrefix}#${unit.unitKey}`,
      facet: task.intent,
      verdict: unit.verdict,
      userFacingReason: unit.userFacingReason,
    }))
    : rubricTargetIds.map((rubricItemId) => ({
      rubricItemId,
      facet: task.intent,
      verdict: assessment.verdict,
      userFacingReason: assessment.userFacingReason,
    }));
  const reportHash = sha256Hex(JSON.stringify({ assessmentId, payloadKind, verdict: assessment.verdict }));
  // §7.7：ceiling 从 qualification 数据推导（V1 无记录 → practice 上限）。
  // facet_eligible 且全部 covered → facet_evidence Commit（canonical facet
  // observation + 0 schedule，§13.6）；其余 → practice 结算。
  const ceiling = await readVariantCeiling(tx, command.artifactId);
  const facetEligible = ceiling === "facet_eligible" && assessment.verdict === "covered";
  await tx.update(learningAssessments)
    .set({
      status: "completed",
      rubricResults,
      trustClass: facetEligible ? "facet_eligible" : "practice_only",
      reportHash,
      updatedAt: at,
    })
    .where(eq(learningAssessments.id, assessmentId));
  await appendRunEvent(tx, command, "learning_assessment.completed", { assessmentId }, at);

  if (facetEligible) {
    // facet_evidence Commit：canonical facet observation，0 schedule。
    const runForCommit = (await tx
    .select({ revision: learningRuns.revision, runtimeEpoch: learningRuns.runtimeEpoch })
      .from(learningRuns)
      .where(eq(learningRuns.id, command.runId))
      .limit(1))[0];
    await tx.update(learningRuns)
      .set({ phase: "committing", revision: (runForCommit?.revision ?? 0) + 1, updatedAt: at })
      .where(eq(learningRuns.id, command.runId));
    await tx.insert(learningRunProcessingOutbox).values({
      runId: command.runId,
      taskId: command.taskId,
      artifactId: command.artifactId,
      workspaceId: command.workspaceId,
      userId: command.userId,
      commandType: "commit_requested",
      payload: { assessmentId, disposition: "facet_evidence", runtimeEpoch: runForCommit?.runtimeEpoch },
      idempotencyKey: `commit:structured:facet:${assessmentId}`,
      availableAt: at,
      createdAt: at,
      updatedAt: at,
    });
    return;
  }

  // practice 结算：0 canonical / 0 schedule；发布恰好一个 practice trail event。
  // §16.2：每个无 canonical Commit 的 Run 最多一个聚合 practice event
  // （UNIQUE(run_id, scope)）；同 Run 后续 task 的轨迹并入同一事件，不新插。
  const runRow = (await tx
    .select({ origin: learningRuns.origin, returnTarget: learningRuns.returnTarget })
    .from(learningRuns)
    .where(eq(learningRuns.id, command.runId))
    .limit(1))[0];
    const keyPointId = originObjectiveId(runRow?.origin);
  const practiceEventId = `practice:${sha256Hex(`${command.runId}:structured`).slice(0, 24)}`;
  await tx.insert(practiceTrailEventOutbox).values({
    practiceEventId,
    workspaceId: command.workspaceId,
    userId: command.userId,
    runId: command.runId,
    scope: "official_user",
    event: {
      version: 1,
      practiceEventId,
      eventHash: sha256Hex(`event:${practiceEventId}`),
      workspaceId: command.workspaceId,
      userId: command.userId,
      runId: command.runId,
      taskIds: [command.taskId],
      keyPointId,
      targetFingerprint: "",
      artifactIds: command.artifactId ? [command.artifactId] : [],
      scope: "official_user",
      reasons: ["practice_task"],
      occurredAt: at.toISOString(),
      expiresAt: null,
    } as never,
    status: "pending",
    createdAt: at,
  }).onConflictDoNothing();
  // P7：practice trail 应用（同一幂等事务物化 change set；官方 scope 显式）。
  await materializePracticeChangeSet(tx, {
    workspaceId: command.workspaceId,
    userId: command.userId,
  }, {
    runId: command.runId,
    practiceEventId,
    keyPointId,
    artifactIds: command.artifactId ? [command.artifactId] : [],
    trailScope: "official_user",
  }, at);

  const result: LearningRunResultV1 = {
    outcome: "practice_completed",
    demonstratedFacets: [],
    gapFacets: assessment.verdict === "covered" ? [] : [task.intent as never],
    scheduleImpact: { kind: "none", reasonCode: "practice_only" },
    returnTarget: runRow?.returnTarget as never,
  };
  await tx.update(learningRuns)
    .set({ phase: "completed", result: result as never, revision: run.revision + 1, updatedAt: at })
    .where(eq(learningRuns.id, command.runId));
  await appendRunEvent(tx, command, "learning_run.completed", {}, at);
    // §7.8：结算回填 presentation_history（outcome/exposed，按 runId 幂等）。
    await backfillPresentationHistory(tx, { runId: command.runId, outcome: result.outcome });
  // P6 Journey：practice 结算事件（不产 schedule，旅程停在 first_schedule 等待）。
  await hookJourneyOnRunCompleted(tx, command, {
    runId: command.runId,
    result: result as unknown as Record<string, unknown>,
  }, at);
}

export async function finishDeclaredUnableAssessment(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
  assessmentId: string,
  run: { id: string; revision: number; runtimeEpoch: number },
  at: Date,
): Promise<void> {
  // 确定性报告：确认"用户声明不会"这一事实，不对 rubric 覆盖度做生成式判断。
  const report = {
    assessmentId,
    source: "deterministic_declared_unable",
    artifactId: command.artifactId,
    reasonCode: "user_declared_unable",
    decidedAt: at.toISOString(),
  };
  const reportHash = sha256Hex(JSON.stringify(report));
  await tx.update(learningAssessments)
    .set({ status: "completed", rubricResults: [], trustClass: null, reportHash, updatedAt: at })
    .where(eq(learningAssessments.id, assessmentId));
  await appendRunEvent(tx, command, "learning_assessment.completed", { assessmentId }, at);
  // 进入 Commit（内部 outbox 驱动）。
  await tx.update(learningRuns)
    .set({ phase: "committing", revision: run.revision + 1, updatedAt: at })
    .where(eq(learningRuns.id, command.runId));
  await tx.insert(learningRunProcessingOutbox).values({
    runId: command.runId,
    taskId: command.taskId,
    artifactId: command.artifactId,
    workspaceId: command.workspaceId,
    userId: command.userId,
    commandType: "commit_requested",
    payload: { assessmentId, disposition: "unable_evidence", runtimeEpoch: run.runtimeEpoch },
    idempotencyKey: `commit:${assessmentId}`,
    availableAt: at,
    createdAt: at,
    updatedAt: at,
  });
}

/**
 * §16.7 V2 Commit epoch 复验：objective lifecycle epoch + 全部 evidence
 * eligibility epoch（按稳定 evidence id 顺序锁定）。任何 restricted/revoked
 * 或 epoch 漂移 → fail closed，不产 canonical/schedule。
 */


export interface CommandRow {
  id: string;
  runId: string;
  taskId: string;
  artifactId: string | null;
  workspaceId: string;
  userId: string;
  commandType: string;
  payload: Record<string, unknown>;
}

export async function appendRunEvent(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
  eventType: string,
  payload: Record<string, unknown>,
  at: Date,
): Promise<void> {
  // Y5（round-3 审计）：此处每事件 3 往返（select cursor → insert event → update
  // cursor）。已评估合并为单条原子 CTE（UPDATE learning_runs SET event_cursor=
  // event_cursor+1 ... RETURNING 后 INSERT），可省 2 往返。但：
  //  - appendRunEvent 仅在每条 outbox command 处理/可恢复失败路径调用（非每任务/每
  //    e action 的高频热路径），合并的绝对收益有限；
  //  - CTE 需 raw SQL，且要跨 RLS（learningRuns/learningRunEvents 均为事件序列原子
  //    递增），并对"run 行缺失"的孤儿插入边界语义有改变（现行为：run 缺失仍插
  //    sequence=1 事件、update no-op；CTE 会因 UPDATE 0 行而不插）。
  //  权衡后保持 3 往返语义不变（正确性优先，涉及事件序列一致性的边界行为不改）。
  const runRows = await tx.select({ eventCursor: learningRuns.eventCursor }).from(learningRuns)
    .where(eq(learningRuns.id, command.runId)).limit(1);
  const cursor = runRows[0]?.eventCursor ?? 0;
  await tx.insert(learningRunEvents).values({
    runId: command.runId,
    workspaceId: command.workspaceId,
    userId: command.userId,
    sequence: cursor + 1,
    eventType: eventType as never,
    payload: payload as never,
    occurredAt: at,
  });
  await tx.update(learningRuns)
    .set({ eventCursor: cursor + 1, updatedAt: at })
    .where(eq(learningRuns.id, command.runId));
}

/** 从严格 V2 run.origin 取目标 ID。 */
export function originObjectiveId(origin: unknown): string {
  if (origin && typeof origin === "object") {
    const objectiveId = (origin as { objectiveId?: unknown }).objectiveId;
    if (typeof objectiveId === "string") return objectiveId;
  }
  return "00000000-0000-0000-0000-000000000000";
}


/** P6：Run 完成事件 → 当前 workspace 的 active Journey（Reducer 幂等推进）。 */
export async function hookJourneyOnRunCompleted(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
  payload: Record<string, unknown>,
  at: Date,
): Promise<void> {
  // 同事务原子：Run 结算与 Journey 推进同时成功或整体回滚；失败时 outbox
  // 命令重试（处理幂等），最终一致。绝不在事务内吞错（吞错会造成结算成功
  // 而旅程停滞的不一致态）。
  const { findActiveJourney, applyJourneyDomainEvent } = await import("../../companion-journey/journey-service.ts");
  const journey = await findActiveJourney(tx, {
    workspaceId: command.workspaceId,
    userId: command.userId,
  });
  if (!journey) return;
  await applyJourneyDomainEvent(tx, {
    workspaceId: command.workspaceId,
    userId: command.userId,
  }, {
    journeyId: journey.journeyId,
    domainEventId: `run.completed:${command.runId}`,
    eventType: "learning_run.completed",
    payload,
  }, at);
}
