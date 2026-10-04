import { practiceTrailEventOutbox } from "@ailearn/shared/db-schema/learning-runs";
import {
  appendRunEvent,
  classifyFailClosedReason,
  failClosedNotAssessable,
  finishCriticAssessmentWrite,
  hookJourneyOnRunCompleted,
  originObjectiveId,
  closeStructuredSolutionSql,
  processAssessmentCommand,
  readHelpConditionV2,
  readVariantCeiling,
  supplementOffer,
  type CommandRow,
} from "./run-processing-assessment.ts";

export { closeStructuredSolutionSql };
/**
 * LearningRun processing outbox 消费（§13.5 唯一执行主链 P2 版）。
 *
 * 在 API 进程内轮询 learning_run_processing_outbox，按命令驱动：
 * - assessment_requested：
 *   - source=deterministic_declared_unable → 确定性报告 completed →
 *     写 commit_requested（canonical_unable 路径）；
 *   - source=assessment_critic（text/voice）→ 调用真 Critic（run-critic）；
 *     全部 covered 且无提示暴露 → demonstrated → commit_requested；
 *     提示暴露 → practice_completed（0 canonical/schedule）；
 *     部分覆盖 → checkpoint(partial)；Critic 不可用/输出非法 → fail
 *     closed not_assessable（绝不猜"掌握"）。
 * - commit_requested：
 *   - 校验 phase/epoch；按 private contract 的 schedulingAuthorization
 *     消费/创建 review_schedules，发布恰好一个
 *     canonical_learning_event_outbox envelope，写 run.result 并 completed。
 *     disposition 由命令 payload 决定（unable_evidence | mastery_evidence）。
 *
 * 幂等：outbox scope key 唯一 + 命令处理前检查当前行状态（重复 tick 不重复
 * 写结果）。答案正文不进入本模块任何队列/事件 payload（Critic 输入只在本
 * 进程内存构造）。
 */

import { reviewDimensionForObservationV2, type ReviewDimensionV2 } from "@ailearn/shared/review-dimension-v2";
import { and, eq, inArray, sql, desc } from "drizzle-orm";
import {
  helpConditionCooldownAfterV2,
} from "@ailearn/shared/help-condition-rules-v2";
import {
  db,
  withWorkspaceTransaction,
  currentApiWorkspaceTransaction,
} from "../../../db/client.ts";
import {
  canonicalLearningEventOutbox,
  learningAssessments,
  learningArtifacts,
  learningRunPrivateContracts,
  learningRuns,
} from "@ailearn/shared/db-schema/learning-runs";
import {
  evidenceEligibilityStatesV2,
  initialValidationRemindersV2,
  learningObjectivesV2,
  learningObjectiveRevisionsV2,
} from "@ailearn/shared/db-schema/card-generation-v2";
import { reviewSchedules } from "@ailearn/shared/db-schema/evidence";
// W7-8 刀二：判据在纯函数里（§9.1「自动策略不能悄悄把提醒提前」），这一层只负责
// 把那一列读出来递给它，并把「抬过」如实带回。
import {
  decideNextReviewAtWithManualDateV2,
  type ManualDateConstraintEndedV2,
} from "@ailearn/shared/review-manual-date-constraint-v2";
import { ensurePendingReviewScheduleV2 } from "../../review/review-schedule-boundary.ts";
// 39d W5-5：§14.2「待复核时不持续放大结论」的那一闸。与上面那道笔记依据闸并排调用。
import { disputeScheduleResolutionV2, markCorrectionAppliedV2 } from "../disputes/run-disputes.ts";
import { readObjectiveNoteChangeImpactV1 } from "../../learning-objectives/change-impact-service.ts";
import {
  calculateDiscreteV2Schedule,
} from "@ailearn/shared";
import { backfillPresentationHistory } from "../run-service.ts";
// 方案 16 §20：run_result 埋点（尽力而为，独立小事务）。
import { insertLearningMetricEvent } from "../../observability/learning-metrics.ts";
import { learningMetricEvents } from "@ailearn/shared/db-schema/learning-metrics";
import { CanonicalLearningEventEnvelopeV1, LearningRunResultV1, LearningRunReturnTargetV1, SchedulingAuthorizationV1 } from "@ailearn/shared";
import { sha256Hex } from "@ailearn/shared/content-hash";
import {
  CriticOutputError,
  CriticUnavailableError,
  createOpenAICompatibleCritic,
  type CriticTransport,
  type RubricVerdictOutput,
} from "../planning/run-critic.ts";
import { loadFrozenTargetSnapshotV2 } from "../../card-generation-v2/target-snapshot-adapter.ts";
import { insertDomainEvents } from "../../card-generation-v2/helpers.ts";
import { materializeCanonicalChangeSet } from "../../understanding/projection-service.ts";
// P0-13（2026-09-29 审计）：本文件此前有 16 处 `process.stderr.write`，整条结算/评估
// 链路完全绕过 pino —— 没有 reqId（request-context 的 ALS 在这条链上白建）、没有
// level、字段全是拼进字符串的，运维只能用 grep 字符串的方式关联同一个 run 的 HTTP
// 日志与后台日志。全部改为结构化 logger 调用，控制流/抛出/返回值一字未动。
import { logger } from "../../../lib/logger.ts";


/** 从 outbox payload 里安全读字符串参数（payload 是 jsonb，形状不可信）。 */
function readPayloadString(payload: unknown, key: string): string {
  if (payload && typeof payload === "object") {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

let criticTransport: CriticTransport | null = null;
function getCriticTransport(): CriticTransport {
  if (criticTransport === null) {
    criticTransport = createOpenAICompatibleCritic({ currentActiveTransaction: currentApiWorkspaceTransaction });
  }
  return criticTransport;
}

/**
 * 测试钩子（设计 P1-16，2026-09-15 审计）：惰性单例此前**既不能重置也不能注入**
 * ——单测只能走真实 transport（或整模块 mock，等于测 mock 路径）。传入 null 即清空
 * 单例（下次调用重新按 env 构造），传入 transport 即注入替身。
 */
export function setCriticTransportForTests(transport: CriticTransport | null): void {
  criticTransport = transport;
}

const LEASE_SECONDS = 120;

export interface ProcessingTickResult {
  processed: number;
  failed: number;
}

/**
 * 批内并发度（2026-10-03）。
 *
 * 默认 4：与 worker 侧 `DEFAULT_QUEUE_CONCURRENCY` 同值，也与「一次 Critic 调用
 * ~8 秒」相称——4 路并发时一轮 tick 的最坏耗时仍是单条的耗时，而不是 4 倍。
 * 上界 16：再高对吞吐的边际收益迅速衰减，而每路都可能同时持有事务连接，
 * 会去挤 HTTP 请求的池（API 主池只有 25 条，见 db/client.ts）。
 */
export const DEFAULT_RUN_PROCESSING_CONCURRENCY = 4;
export const MAX_RUN_PROCESSING_CONCURRENCY = 16;

export function resolveRunProcessingConcurrency(raw: string | undefined): number {
  const parsed = Number(raw ?? DEFAULT_RUN_PROCESSING_CONCURRENCY);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_RUN_PROCESSING_CONCURRENCY;
  return Math.min(parsed, MAX_RUN_PROCESSING_CONCURRENCY);
}

/**
 * 让轮询循环立刻再跑一次（2026-09-20 实走复盘 #6）。
 *
 * 打分 outbox 此前固定 10 秒一跳，用户提交后**平均要干等 5 秒**才有人开始处理，
 * 而那段时间界面上只有一行字。提交是明确的事件，没必要让轮询节奏决定用户体感：
 * 事务提交后喊一声，循环立刻跑下一轮；10 秒轮询退化成兜底（进程重启、漏喊、
 * 失败退避时仍能自愈）。
 *
 * 注册方是 `server.ts` 的循环本体——它才知道自己的定时器在哪。未注册时调用是
 * 空操作（测试与集成脚本自己驱动 tick，不需要这条路径）。
 */
let processingWaker: (() => void) | null = null;

export function setLearningRunProcessingWaker(waker: (() => void) | null): void {
  processingWaker = waker;
}

export function wakeLearningRunProcessing(): void {
  processingWaker?.();
}

export async function runLearningRunProcessingTick(
  workerId: string,
  maxCommands: number,
): Promise<ProcessingTickResult> {
  // B#1/R1（round-3 审计）：原实现一次 claim 至多 maxCommands 行、全部打同一
  // lease_expires_at（now+120s），而批内严格串行且 assessment 分支做事务外
  // Critic HTTP（数十秒）——批内靠后行很可能在轮到前租约已过期，另一实例
  // 会重领并重跑同一命令（重复计费 + 重复副作用）。0150 的 mark 带 lease CAS
  // 只防迟一拍实例的“置位覆盖”，不防重复执行。
  // 改为逐条领取（p_max=1）：每条在其处理前才被 claim，租约在处理的时点是
  // 新鲜的（120s），即使前面若干条耗时超长也不会波及后续行。claim 内部
  // FOR UPDATE SKIP LOCKED + 租约条件保证并发安全；租约过期被其它实例重领的
  // 行，本实例后续 mark/release 的 lease_owner CAS 会正确失效（no-op）。
  //
  // ─── 2026-10-03：逐条认领改为「小批量认领 + 批内并发」────────────────
  // 上面那条 B#1/R1 约束保护的是它**自己描述的那个失效模式**：大批量认领 +
  // 串行处理，于是靠后行等到轮到时租约已过期。它保护的不是"批量认领"本身——
  // `ailearn_claim_run_processing` 的 FOR UPDATE SKIP LOCKED 与统一租约，对
  // 并发认领者本来就是安全的；而**批内并发恰好消除了租约失效的成因**：
  // 并发 C 时一批 C 行同时开始处理，一轮最坏耗时仍是**单条**的耗时
  // （一次 Critic 约 8s），而不是 C×8s。租约在 claim 时打 120s，到"最后一行
  // 开始处理"那一刻只过了约 8s，租约依然新鲜。
  //
  // 反过来说：**串行是租约问题的症状，不是病因**。并发之后租约安全性比原实现
  // 更强——原实现里第 15 行要等 14×8=112s 才开始处理，那才是真正贴着 120s
  // 租约边缘走的地方。
  //
  // 批大小同时受 maxCommands 剩余额度约束，避免最后一轮多认领再丢弃。
  let processed = 0;
  let failed = 0;
  const concurrency = resolveRunProcessingConcurrency(process.env.RUN_PROCESSING_CONCURRENCY);

  while (processed + failed < maxCommands) {
    const batchSize = Math.min(concurrency, maxCommands - (processed + failed));
    const now = new Date();
    const claimedRows = await db.execute(sql`
      SELECT * FROM public.ailearn_claim_run_processing(
        ${workerId}, ${LEASE_SECONDS * 1000}, ${batchSize}, ${now.toISOString()}
      )
    `);
    const claimed = (claimedRows as unknown) as ClaimedCommand[];
    if (claimed.length === 0) break;

    // 批内并发。用 allSettled 而不是 all：一条命令炸了不能连坐同批的其它
    // 命令——这与原串行实现的失败隔离完全一致（原实现里一条失败只累加 failed
    // 并继续下一条）。
    const outcomes = await Promise.allSettled(
      claimed.map((row) => processClaimedCommand(row, workerId)),
    );

    // 结算按认领顺序逐条走，保证日志与事件写入的相对顺序稳定可复现。
    for (let index = 0; index < claimed.length; index += 1) {
      const outcome = outcomes[index];
      if (outcome.status === "fulfilled") {
        processed += 1;
        continue;
      }
      failed += 1;
      await settleFailedCommand(claimed[index], outcome.reason, workerId);
    }
  }
  return { processed, failed };
}

/**
 * 把一条失败的命令结算成 `recoverable_error`（2026-10-03 从主循环抽出）。
 *
 * 抽取的原因是并发批处理：原来这段逻辑内联在 try/catch 里，与"认领→处理"
 * 严格交替；批并发之后处理与结算必须分开，否则一条失败命令的结算会挡住同批
 * 其它命令的启动。**函数体自原 catch 块逐字搬运**，行为不变。
 */
async function settleFailedCommand(row: ClaimedCommand, err: unknown, workerId: string): Promise<void> {
      // 2026-08-15（§13.2 recoverable_error）：业务可恢复错误不再无限重试
      // （tick failed 循环），而是把 Run 置为 recoverable_error + failure
      // （用户可 retry_assessment/retry_commit/retry_prepare 或 end）。
      // Critic 网络失败已在事务外 fail closed（not_assessable，不走到这里）。
      // 原先这里第一行是 `failed += 1;`——那是主循环的局部计数器，搬进本函数
      // 后已由调用方在 await 之前累加（见 runLearningRunProcessingTick 的批结算
      // 循环），否则要么编译不过、要么计数两遍。
      // M6（2026-08-24 审查）：内部错误详情（Postgres 驱动/约束名/内部路径）
      // 只进服务端日志；事件 payload 只带稳定的 stage/code，绝不原样经 SSE
      // 推给客户端。
      const message = err instanceof Error ? err.message : String(err);
      // P0-13：err 走仓库统一的 safeErrorSerializer（只留 category/name/code，不带
      // 正文）；errorMessage 保留此前截断到 500 字的服务端内部细节——M6 要求这些细节
      // "只进服务端日志"，所以它们仍在这条日志里，只是不再被拼进字符串前缀。
      logger.error(
        {
          err,
          errorMessage: message.slice(0, 500),
          runId: row.run_id,
          workspaceId: row.workspace_id,
          userId: row.user_id,
          commandType: row.command_type,
          outboxRowId: row.id,
          taskId: row.task_id,
          artifactId: row.artifact_id,
          workerId,
        },
        "[run-tick] command failed",
      );
      const stage = row.command_type === "commit_requested" ? "commit"
        : row.command_type === "assessment_requested" ? "assessment"
        : "prepare";
      const failureCode = stage === "prepare"
        ? "planner_unavailable"
        : stage === "assessment"
          ? "assessment_timeout"
          : "commit_conflict";
      const assessmentId = readPayloadString(row.payload, "assessmentId");
      const settledAt = new Date();
      try {
        await withWorkspaceTransaction(
          { workspaceId: row.workspace_id, userId: row.user_id },
          async (tx) => {
            const settle = await tx.update(learningRuns)
              .set({
                phase: "recoverable_error",
                failure: { stage, code: failureCode, retryable: true },
                revision: sql`revision + 1`,
                updatedAt: settledAt,
              })
              .where(and(
                eq(learningRuns.id, row.run_id),
                eq(learningRuns.workspaceId, row.workspace_id),
                eq(learningRuns.userId, row.user_id),
                inArray(learningRuns.phase, ["preparing", "assessing", "committing"]),
              ))
              .returning({ id: learningRuns.id });
            // H1（2026-08-24 审查）：assessment 的失败必须落到 assessment 行自身。
            // 此前只改 run.phase，assessment 停在 running（Critic 写回事务回滚时）
            // 或退回 queued（prepare 事务整体回滚时），而 retry_assessment 只认
            // status='failed' → 重试恒 409，run 永久卡在 recoverable_error。
            // 只有真正把 run 置为 recoverable_error 的那次 CAS 才收尾 assessment
            // （run 已被并发 end/结算推进时不越权改写）。
            if (assessmentId && settle.length > 0) {
              await tx.update(learningAssessments)
                .set({ status: "failed", rubricResults: [], trustClass: null, reportHash: null, updatedAt: settledAt })
                .where(and(
                  eq(learningAssessments.id, assessmentId),
                  eq(learningAssessments.runId, row.run_id),
                  inArray(learningAssessments.status, ["queued", "running"]),
                ));
            }
            // 稳定 P0-4（2026-09-15 审计）：事件只在**真正**把 run 置为
            // recoverable_error 时写。此前 appendRunEvent 无 settle.length 门控——
            // CAS 更新 0 行（run 已是 completed / 已被并发结算）时事件照写，
            // 给已完成的 run 留下脏的 recoverable_error 事件序列。
            if (settle.length > 0) {
              await appendRunEvent(tx, {
                id: row.id,
                runId: row.run_id,
                taskId: row.task_id,
                artifactId: row.artifact_id,
                workspaceId: row.workspace_id,
                userId: row.user_id,
                commandType: row.command_type,
                payload: row.payload as Record<string, unknown>,
              }, "learning_run.recoverable_error", { stage, code: failureCode }, settledAt);
            }
          },
        );
      } catch (settleErr) {
        logger.error(
          {
            err: settleErr,
            errorMessage: settleErr instanceof Error ? settleErr.message : "unknown",
            runId: row.run_id,
            workspaceId: row.workspace_id,
            userId: row.user_id,
            commandType: row.command_type,
            outboxRowId: row.id,
            workerId,
          },
          "[run-tick] recoverable settle failed",
        );
      }
      // 停止该 outbox 行重试（用户 retry 动作重新入队）。
      // PERF-B8：mark 增加 lease CAS（0150），传 workerId 防租约过期后的
      // 慢一拍实例对已由他人处理的行置位。
      await db.execute(sql`
        SELECT public.ailearn_mark_run_processing_processed(${row.id}, ${workerId}, now())
      `).catch((markErr) => {
        // L9（2026-08-24 审查）：mark 失败不再静默——幂等兜底仍在（重放靠状态
        // 检查），但必须留日志，否则 outbox 行会一直可重领。
        logger.warn(
          {
            err: markErr,
            errorMessage: markErr instanceof Error ? markErr.message : "unknown",
            runId: row.run_id,
            workspaceId: row.workspace_id,
            commandType: row.command_type,
            outboxRowId: row.id,
            workerId,
          },
          "[run-tick] mark processed failed",
        );
      });
}

interface ClaimedCommand {
  id: string;
  run_id: string;
  task_id: string;
  artifact_id: string | null;
  workspace_id: string;
  user_id: string;
  command_type: string;
  payload: unknown;
  idempotency_key: string;
}

async function processClaimedCommand(row: ClaimedCommand, workerId: string): Promise<void> {
  // 直接用 claim 返回字段（RLS 下 ailearn_api 不能跨 workspace 重读 outbox 行）。
  const typed: CommandRow = {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    artifactId: row.artifact_id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    commandType: row.command_type,
    payload: row.payload as Record<string, unknown>,
  };
  // 连接池纪律（2026-08-14）：Critic HTTP 调用（数十秒）绝不能在 DB 事务内
  // 执行——事务持有连接会耗尽连接池（并发评估时 SSE/队列请求 26-55s 等待
  // 甚至 500）。三阶段：事务内读+标记 → 事务外 HTTP → 事务内写。
  // 同理（2026-08-16）：P8 LLM 记忆候选生成也是网络调用，由 processCommitCommand
  // 返回延后描述，事务提交后再在新事务中刷新——不钉住结算事务连接。
  const outcome = await withWorkspaceTransaction(
    { workspaceId: row.workspace_id, userId: row.user_id },
    async (tx) => {
      if (row.command_type === "assessment_requested") {
        return {
          criticContext: await processAssessmentCommand(tx, typed),
          proactiveDefer: null,
        };
      }
      if (row.command_type === "commit_requested") {
        return {
          criticContext: null,
          proactiveDefer: await processCommitCommand(tx, typed),
        };
      }
      return { criticContext: null, proactiveDefer: null };
    },
  );
  const { criticContext, proactiveDefer } = outcome;

  if (criticContext) {
    // 事务外：真 Critic 调用（不持有任何 DB 连接）。
    // 事务边界的核对挪进了任务运行基础（`createOpenAICompatibleCritic` 每步发调用前
    // 读 `currentApiWorkspaceTransaction`）。这里再核一次就是两个来源——
    // 留一处，且留在那一条判据**必然会被执行**的那一处。
    logger.debug(
      {
        runId: row.run_id,
        workspaceId: row.workspace_id,
        commandType: row.command_type,
        taskId: row.task_id,
        artifactId: row.artifact_id,
        assessmentId: criticContext.assessmentId,
        runtimeEpoch: criticContext.runtimeEpoch,
      },
      "[run-tick] calling critic",
    );
    let verdicts: RubricVerdictOutput[];
    try {
      verdicts = await getCriticTransport().assess(criticContext.input, {
        workspaceId: row.workspace_id,
        userId: row.user_id,
        assessmentId: criticContext.assessmentId,
        // V2 的冻结公开载荷哈希就是这一步真正的输入身份；V1 没有那一项，退回
        // assessment 行 id——至少"同一次评估的两次尝试"在台账里认得出是同一件事。
        inputSnapshotHash: criticContext.input.v2?.publicPayloadHash ?? criticContext.assessmentId,
      });
    } catch (err) {
      // 2026-08-15：Critic 不可用/输出非法（含 provider 网络失败）必须在
      // 事务外直接 fail closed → not_assessable（0 副作用），而不是冒泡让
      // tick 记 failed 无限重试——否则 Run 永远卡在 assessing。
      if (err instanceof CriticUnavailableError || err instanceof CriticOutputError) {
        logger.error(
          {
            err,
            errorMessage: err.message,
            reasonCode: classifyFailClosedReason(err.message),
            runId: row.run_id,
            workspaceId: row.workspace_id,
            userId: row.user_id,
            commandType: row.command_type,
            outboxRowId: row.id,
            assessmentId: criticContext.assessmentId,
            runtimeEpoch: criticContext.runtimeEpoch,
          },
          "[run-tick] critic fail-closed",
        );
        await withWorkspaceTransaction(
          { workspaceId: row.workspace_id, userId: row.user_id },
          (tx) => failClosedNotAssessable(
            tx,
            typed,
            criticContext.assessmentId,
            new Date(),
            criticContext.runtimeEpoch,
            classifyFailClosedReason(err.message),
          ),
        );
        return;
      }
      throw err;
    }
    logger.debug(
      {
        runId: row.run_id,
        workspaceId: row.workspace_id,
        commandType: row.command_type,
        assessmentId: criticContext.assessmentId,
        verdictCount: verdicts.length,
      },
      "[run-tick] critic verdicts received",
    );
    await withWorkspaceTransaction(
      { workspaceId: row.workspace_id, userId: row.user_id },
      (tx) => finishCriticAssessmentWrite(tx, typed, criticContext, verdicts),
    );
    logger.debug(
      {
        runId: row.run_id,
        workspaceId: row.workspace_id,
        commandType: row.command_type,
        assessmentId: criticContext.assessmentId,
        verdictCount: verdicts.length,
      },
      "[run-tick] critic write-back done",
    );
  }

  // 稳定 P0-4（2026-09-15 审计）：成功 mark 此前是**裸 await**——mark 抖动会
  // 冒泡进上面 :132 的 catch-all，把一条已成功处理的命令记成 failed，并（在修复
  // 前）给已 completed 的 run 写 recoverable_error 事件。与失败路径 (:204-210)
  // 对齐：mark 失败只记日志。命令本身幂等（重放靠状态检查），租约到期后行会被
  // 重新领取，不会丢副作用。
  //
  // 设计 P1-11（2026-09-15 审计）：mark 必须**先于**下面的 P8 记忆候选生成——
  // 此前顺序相反，而上面的注释却写着"不阻塞后续标记/埋点"（代码与注释矛盾）。
  // 后果：一次挂起的个性化 LLM 调用（当时无 AbortSignal，只受 300s 共享超时约束）
  // 会让这条 outbox 行的完成被推迟最多 5 分钟/条，直接拖慢整条 tick 串行链。
  await db.execute(sql`
    SELECT public.ailearn_mark_run_processing_processed(${row.id}, ${workerId}, now())
  `).catch((markErr) => {
    logger.warn(
      {
        err: markErr,
        errorMessage: markErr instanceof Error ? markErr.message : "unknown",
        runId: row.run_id,
        workspaceId: row.workspace_id,
        commandType: row.command_type,
        outboxRowId: row.id,
        workerId,
      },
      "[run-tick] mark processed failed",
    );
  });

  // 方案 16 §20：run_result 埋点（completed + result 才记；幂等去重）。
  await recordRunOutcomeMetric({ workspaceId: row.workspace_id, userId: row.user_id }, row.run_id);

  // 事务已提交且命令已标记完成：P8 LLM 记忆候选生成（含 upsert）在独立事务执行，
  // 不持有结算事务的连接。函数内部 fail-open 静默降级（自带 try/catch），
  // 且此刻标记已落库——即便它失败/被关停打断，也只是这一次个性化候选缺失，
  // 不会让已完成的命令被重放。
  if (proactiveDefer) {
    const { flushDeferredProactiveMemoryCandidates } = await import(
      "../../companion-conversation/delivery/proactive-hook.ts"
    );
    await flushDeferredProactiveMemoryCandidates(proactiveDefer);
  }
}

/**
 * §20 run_result：run 进入 completed 且有 result 时记 outcome/scheduleImpact/
 * activeSecondsUsed（funnel 末端）。独立小事务 + 幂等（同 run 只记一次）+
 * 静默容错——埋点失败绝不回滚结算。
 */
async function recordRunOutcomeMetric(
  scope: { workspaceId: string; userId: string },
  runId: string,
): Promise<void> {
  try {
    await withWorkspaceTransaction(scope, async (tx) => {
      const already = await tx
        .select({ id: learningMetricEvents.id })
        .from(learningMetricEvents)
        .where(and(
          eq(learningMetricEvents.workspaceId, scope.workspaceId),
          eq(learningMetricEvents.userId, scope.userId),
          eq(learningMetricEvents.runId, runId),
          eq(learningMetricEvents.eventType, "run_result"),
        ))
        .limit(1);
      if (already[0]) return;
      const runs = await tx
        .select()
        .from(learningRuns)
        .where(and(
          eq(learningRuns.id, runId),
          eq(learningRuns.workspaceId, scope.workspaceId),
          eq(learningRuns.userId, scope.userId),
        ))
        .limit(1);
      const run = runs[0];
      if (!run || run.phase !== "completed" || !run.result) return;
      const result = run.result as { outcome?: string; scheduleImpact?: unknown };
      await insertLearningMetricEvent(tx, scope, {
        eventType: "run_result",
        runId,
        origin: run.origin,
        goal: run.goal,
        outcome: result.outcome,
        scheduleImpact: result.scheduleImpact,
        activeSecondsUsed: run.activeSecondsUsed,
      });
    });
  } catch (error) {
    logger.warn(
      {
        err: error,
        errorMessage: error instanceof Error ? error.message : String(error),
        runId,
        workspaceId: scope.workspaceId,
        userId: scope.userId,
      },
      "[metrics] drop run_result (best-effort)",
    );
  }
}


/**
 * §12.5 的补充额度是**单槽**：id 恒为 `supplement:1`，补充任务恒占 sequence 2
 * （planFollowupTask 写死，且结算侧 H3 只按"至多两个 assessment"收敛）。所以
 * 用过一次之后绝不能再次签发——2026-09-23 实测：第二次点"继续补充证据"直接撞
 * learning_tasks_run_sequence_unique，run 侧看到的是一个裸 500。
 */
async function revalidateV2CommitEpochs(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
  contract: { workspaceId: string; expectedObjectiveLifecycleEpoch: number | null },
): Promise<void> {
  const snapshot = await loadFrozenTargetSnapshotV2(tx, contract.workspaceId, command.runId);
  if (!snapshot) throw new CriticOutputError("V2 run missing frozen snapshot during commit");

  const objRows = await tx
    .select({ lifecycle: learningObjectivesV2.lifecycle, lifecycleEpoch: learningObjectivesV2.lifecycleEpoch })
    .from(learningObjectivesV2)
    .where(and(
      eq(learningObjectivesV2.workspaceId, contract.workspaceId),
      eq(learningObjectivesV2.objectiveId, snapshot.target.objectiveId),
    ))
    .limit(1);
  const obj = objRows[0];
  if (!obj || obj.lifecycle !== "active") {
    throw new CriticOutputError("commit fail-closed: objective lifecycle no longer active");
  }
  if (contract.expectedObjectiveLifecycleEpoch !== null
      && obj.lifecycleEpoch !== contract.expectedObjectiveLifecycleEpoch) {
    throw new CriticOutputError("commit fail-closed: objective lifecycle epoch drift");
  }

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
      eq(evidenceEligibilityStatesV2.workspaceId, contract.workspaceId),
      inArray(evidenceEligibilityStatesV2.evidenceSnapshotId, evidenceIds),
    ))
    .for("update")
    .orderBy(evidenceEligibilityStatesV2.evidenceSnapshotId);
  const byEvidenceId = new Map(evRows.map((r) => [r.evidenceSnapshotId, r]));
  for (const e of evidence) {
    const row = byEvidenceId.get(e.evidenceSnapshotId);
    if (!row || row.status !== "usable") {
      throw new CriticOutputError(`commit fail-closed: evidence ${e.evidenceSnapshotId} not usable`);
    }
    if (row.eligibilityEpoch !== e.expectedEvidenceEligibilityEpoch) {
      throw new CriticOutputError(`commit fail-closed: evidence ${e.evidenceSnapshotId} epoch drift`);
    }
  }
}

/**
 * Commit 门禁拒绝的统一收尾（H2，2026-08-24 审查）。
 *
 * 任何「这条 Commit 不能结算」的判定都必须把 run 从 committing 移到可恢复的
 * checkpoint(not_assessable)（用户出口：finish_without_commit / end），而不是
 * 裸 return null 让 run 永久停在 committing。CAS 绑定 phase + runtimeEpoch：
 * 并发的 end(abandonLockedEvidence) 先赢时这里安全 no-op。
 */
async function settleCommitRejection(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
  run: { revision: number; runtimeEpoch: number },
  reason: string,
): Promise<null> {
  const at = new Date();
  const reasonCode = classifyFailClosedReason(reason);
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
    .where(and(
      eq(learningRuns.id, command.runId),
      eq(learningRuns.workspaceId, command.workspaceId),
      eq(learningRuns.userId, command.userId),
      eq(learningRuns.phase, "committing"),
      eq(learningRuns.runtimeEpoch, run.runtimeEpoch),
    ));
  await appendRunEvent(tx, command, "learning_commit.failed", { reason }, at);
  return null;
}

async function processCommitCommand(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
): Promise<import("../../companion-conversation/delivery/proactive-hook.ts").ProactiveMemoryDeferInput | null> {
  // Lock the run before reading phase/epoch.  end/abandon takes the same row
  // lock, so a late commit either observes the terminal phase or wins the
  // serialization before the user's end operation; it can never write after
  // end has committed.
  const runRows = await tx
    .select()
    .from(learningRuns)
    .where(and(
      eq(learningRuns.id, command.runId),
      eq(learningRuns.workspaceId, command.workspaceId),
      eq(learningRuns.userId, command.userId),
    ))
    .limit(1)
    .for("update");
  const run = runRows[0];
  if (!run) return null;
  if (run.phase !== "committing") return null; // 已提交或已 end。
  const expectedRuntimeEpoch = command.payload.runtimeEpoch;
  // Commit payloads are produced by the current assessment/retry paths and
  // must carry the epoch they observed. Missing epoch is not a legacy case we
  // need to preserve before launch; fail closed so an untrusted/stale payload
  // can never commit against a later run incarnation.
  if (typeof expectedRuntimeEpoch !== "number" || run.runtimeEpoch !== expectedRuntimeEpoch) {
    return null;
  }

  // §16.4 防火墙：sandbox Run 无论评估结果如何都强制 sandbox_only——
  // 0 canonical envelope、0 official schedule、最多带 TTL 的 sandbox trail。
  if (run.sandboxNamespaceId) {
    await finishSandboxCommit(tx, command, run, new Date());
    return null;
  }

  const contractRows = await tx
    .select()
    .from(learningRunPrivateContracts)
    .where(and(
      eq(learningRunPrivateContracts.runId, command.runId),
      eq(learningRunPrivateContracts.workspaceId, command.workspaceId),
      eq(learningRunPrivateContracts.userId, command.userId),
    ))
    .limit(1);
  const contract = contractRows[0];
  // H2（2026-08-24 审查）：以下所有「拒绝结算」都必须留下收尾状态，绝不裸
  // return null——裸 return 会让 run 永久停在 committing（outbox 行随即被标记
  // processed，无任何后续驱动）。
  if (!contract) return settleCommitRejection(tx, command, run, "missing_contract");

  // §16.7 V2 Commit：复验同一 target 闭包（objective lifecycle epoch + 全部
  // evidence eligibility epoch）。Trusted Commit 只在该闭包仍匹配且 evidence
  // 全 usable 时才可能产 canonical / 恰一 successor。
  if (contract.snapshotHash) {
    await revalidateV2CommitEpochs(tx, command, contract);
  }

  // H3（2026-08-24 审查）：结算必须绑定「本次 Commit 的那一条 assessment」：
  // payload.assessmentId 是权威引用（全部入队点都写它），command.taskId 是
  // 同一条命令的 task 闭包。此前只按 run + status='completed' 取第一行且无
  // ORDER BY——activate_followup 产生第二个 assessment 后，结算会引用任意旧
  // assessment 的 reportHash/trustClass/rubricResults 构造 canonical envelope。
  const requestedAssessmentId = readPayloadString(command.payload, "assessmentId");
  const assessmentRows = await tx
    .select()
    .from(learningAssessments)
    .where(and(
      eq(learningAssessments.runId, command.runId),
      eq(learningAssessments.workspaceId, command.workspaceId),
      eq(learningAssessments.userId, command.userId),
      eq(learningAssessments.status, "completed"),
      eq(learningAssessments.taskId, command.taskId),
      ...(requestedAssessmentId ? [eq(learningAssessments.id, requestedAssessmentId)] : []),
    ))
    .orderBy(desc(learningAssessments.createdAt))
    .limit(1);
  const assessment = assessmentRows[0];
  if (!assessment) return settleCommitRejection(tx, command, run, "assessment_not_found");
  // 命令行的 artifact 与 assessment 的 artifact 必须一致，否则 canonical 事实
  // 会把 A 的作答与 B 的评估拼在一起（同 H3 的弱引用类别）。
  if (command.artifactId && assessment.artifactId !== command.artifactId) {
    return settleCommitRejection(tx, command, run, "artifact_assessment_mismatch");
  }

  // 按命令 disposition 分派：mastery_evidence（demonstrated）、
  // facet_evidence（partial 结算：只写允许的 facet）、unable_evidence。
  const disposition = String(command.payload.disposition ?? "unable_evidence");
  const isCanonicalEvidence = disposition === "mastery_evidence" || disposition === "facet_evidence";
  const isDemonstrated = disposition === "mastery_evidence";
  const artifactRows = command.artifactId
    ? await tx.select().from(learningArtifacts).where(and(
        eq(learningArtifacts.id, command.artifactId),
        eq(learningArtifacts.workspaceId, command.workspaceId),
      )).limit(1)
    : [];
  const artifact = artifactRows[0];
  const payload = (artifact?.payload ?? {}) as { kind?: string };
  if (isCanonicalEvidence) {
    // demonstrated 只来自 assessment_critic 且 trustClass=mastery_eligible；
    // facet_evidence 允许 mastery_eligible 或 facet_eligible（§6.4 partial）。
    if (payload.kind === "declared_unable") {
      return settleCommitRejection(tx, command, run, "artifact_kind_mismatch");
    }
    const allowedTrust = isDemonstrated
      ? ["mastery_eligible"]
      : ["mastery_eligible", "facet_eligible"];
    // H2：trustClass 门禁此前裸 return null（与 ceiling 门禁不对称），
    // practice_only/diagnostic_only/null 的 assessment 会把 run 永久留在 committing。
    if (assessment.trustClass === null || !allowedTrust.includes(assessment.trustClass)) {
      return settleCommitRejection(tx, command, run, "trust_class_not_eligible");
    }
    // §7.7 防御纵深：提交 Variant 的 ceiling 必须允许对应等级——
    // practice/diagnostic ceiling 的 Variant 绝不产 canonical。
    const ceiling = await readVariantCeiling(tx, command.artifactId);
    const allowedCeilings = isDemonstrated
      ? ["mastery_eligible"]
      : ["mastery_eligible", "facet_eligible"];
    if (ceiling === null || !allowedCeilings.includes(ceiling)) {
      return settleCommitRejection(tx, command, run, "variant_ceiling_not_eligible");
    }
  } else if (payload.kind !== "declared_unable") {
    return settleCommitRejection(tx, command, run, "unable_artifact_mismatch");
  }

  const at = new Date();
  const authorization = contract.schedulingAuthorization as SchedulingAuthorizationV1;
  const objectiveId = originObjectiveId(run.origin);
  /**
   * 这一次观察服务的是**提取**还是**应用**（§9.1「记住定义与在综合情境中使用」）。
   *
   * 判据就是这一轮冻结下来的 `goal`：§8.4 那三行里只有「新情境能力检查」服务应用，
   * 其余（轻量回忆、可核对的短答）都是提取。分成两格之后，"她记住了"与"她会用了"
   * 才不会挤进同一行——而 §9.2「三种事实分开记录」要的就是这个分开。
   *
   * 此前这一格恒为空串：列在、索引在、边界也收，唯独没有人传过。
   */
  const reviewDimension = reviewDimensionForObservationV2({ transferSuitable: run.goal === "transfer" });
  // facet_evidence（partial 结算）按同一授权路径消费/创建 schedule——
  // §6.4：partial 允许写 facet，调度授权不因部分覆盖而作废。
  const scheduleImpact = isCanonicalEvidence
    ? await applyDemonstratedSchedule(tx, command, authorization, at, reviewDimension, disposition)
    : await applyUnableSchedule(tx, command, authorization, at, reviewDimension);

  // 发布恰好一个 canonical envelope（§16.2 unique commitId/canonicalEventId）。
  const commitId = crypto.randomUUID();
  const factKind = isCanonicalEvidence
    ? (authorization.kind === "consume_pending" ? "scheduled_review" : "initial_validation")
    : "canonical_unable";
  const factDisposition: "mastery_evidence" | "facet_evidence" | "unable_evidence" =
    disposition === "mastery_evidence"
      ? "mastery_evidence"
      : disposition === "facet_evidence"
        ? "facet_evidence"
        : "unable_evidence";
  const canonicalEventId = `canonical:${sha256Hex(`${factKind}:${command.runId}:${assessment.id}`).slice(0, 24)}`;
  const envelope: CanonicalLearningEventEnvelopeV1 = {
    version: 1,
    canonicalEventId,
    eventHash: sha256Hex(JSON.stringify({
      canonicalEventId,
      commitId,
      runId: command.runId,
      keyPointId: objectiveId,
      fact: { kind: factKind, disposition: factDisposition },
    })),
    commitId,
    workspaceId: command.workspaceId,
    userId: command.userId,
    runId: command.runId,
    taskIds: [command.taskId],
    artifactIds: command.artifactId ? [command.artifactId] : ["00000000-0000-0000-0000-000000000000"],
    keyPointId: objectiveId,
    targetFingerprint: contract.targetFingerprint,
    fact: {
      kind: factKind,
      factId: `${factKind}:${assessment.id}`,
      disposition: factDisposition,
    },
    assessments: isCanonicalEvidence
      ? [{
          source: "assessment_critic",
          assessmentId: assessment.id,
          reportHash: assessment.reportHash ?? "",
          trustClass: factDisposition === "mastery_evidence" ? "mastery_eligible" : "facet_eligible",
        }]
      : [{
          source: "deterministic_declared_unable",
          assessmentId: assessment.id,
          reportHash: assessment.reportHash ?? "",
        }],
    occurredAt: at.toISOString(),
  };
  await tx.insert(canonicalLearningEventOutbox).values({
    commitId,
    canonicalEventId,
    workspaceId: command.workspaceId,
    userId: command.userId,
    runId: command.runId,
    envelope: envelope as never,
    status: "pending",
    createdAt: at,
  });
  // P7：Projector 在同一幂等事务物化 immutable change set + 前移 checkpoint。
  const projectionResult = await materializeCanonicalChangeSet(tx, {
    workspaceId: command.workspaceId,
    userId: command.userId,
  }, envelope, command.runId, at);

  const rubricFacets = (Array.isArray(assessment.rubricResults)
    ? (assessment.rubricResults as Array<{ facet?: string; verdict?: string }>)
    : []);
  const coveredFacets = rubricFacets
    .filter((item) => item.verdict === "covered")
    .map((item) => item.facet)
    .filter((facet): facet is string => typeof facet === "string" && facet.length > 0);
  const gapFacets = rubricFacets
    .filter((item) => item.verdict !== "covered")
    .map((item) => item.facet)
    .filter((facet): facet is string => typeof facet === "string" && facet.length > 0);

  const result: LearningRunResultV1 = isDemonstrated
    ? {
        outcome: "demonstrated",
        // M10（2026-08-24 审查）：没有 covered facet 记录时不得伪造 ["explain"]
        // ——那会污染理解投影与漏斗指标。空数组是唯一的诚实用法。
        demonstratedFacets: coveredFacets as never,
        gapFacets: [] as never,
        scheduleImpact,
        returnTarget: run.returnTarget as LearningRunReturnTargetV1,
        projection: projectionResult?.toCheckpointToken
          ? {
              baselineCheckpoint: {
                version: 1,
                workspaceId: command.workspaceId,
                userId: command.userId,
                token: projectionResult.toCheckpointToken,
                capturedAt: at.toISOString(),
              },
              sourceChange: { kind: "canonical", canonicalEventId: envelope.canonicalEventId },
              changeSetId: projectionResult.changeSetId,
            }
          : undefined,
      }
    : factDisposition === "facet_evidence"
      ? {
          outcome: "partial",
          demonstratedFacets: coveredFacets as never,
          gapFacets: gapFacets as never,
          scheduleImpact,
          returnTarget: run.returnTarget as LearningRunReturnTargetV1,
          projection: projectionResult?.toCheckpointToken
            ? {
                baselineCheckpoint: {
                  version: 1,
                  workspaceId: command.workspaceId,
                  userId: command.userId,
                  token: projectionResult.toCheckpointToken,
                  capturedAt: at.toISOString(),
                },
                sourceChange: { kind: "canonical", canonicalEventId: envelope.canonicalEventId },
                changeSetId: projectionResult.changeSetId,
              }
            : undefined,
        }
      : {
          outcome: "declared_unable",
          demonstratedFacets: [],
          gapFacets: [],
          scheduleImpact,
          returnTarget: run.returnTarget as LearningRunReturnTargetV1,
          projection: projectionResult?.toCheckpointToken
            ? {
                baselineCheckpoint: {
                  version: 1,
                  workspaceId: command.workspaceId,
                  userId: command.userId,
                  token: projectionResult.toCheckpointToken,
                  capturedAt: at.toISOString(),
                },
                sourceChange: { kind: "canonical", canonicalEventId: envelope.canonicalEventId },
                changeSetId: projectionResult.changeSetId,
              }
            : undefined,
        };
  await tx.update(learningRuns)
    .set({ phase: "completed", result: result as never, revision: run.revision + 1, updatedAt: at })
    .where(and(
      eq(learningRuns.id, command.runId),
      eq(learningRuns.workspaceId, command.workspaceId),
      eq(learningRuns.userId, command.userId),
      eq(learningRuns.phase, "committing"),
      eq(learningRuns.runtimeEpoch, run.runtimeEpoch),
    ));
  await appendRunEvent(tx, command, "learning_commit.completed", { commitId }, at);
  await appendRunEvent(tx, command, "learning_run.completed", {}, at);
  // §17.3：trusted first Commit（V2 run 且 canonical/mastery_evidence）→ 将
  // pending/ready 的 Initial Validation Reminder 标 completed 并幂等发领域事件
  // （同一 Commit 事务内；重复 commit 因 reminder 已 completed 而幂等）。
  if (contract.snapshotHash && isDemonstrated) {
    const completedReminders = await tx.update(initialValidationRemindersV2)
      .set({ status: "completed", updatedAt: at })
      .where(and(
        eq(initialValidationRemindersV2.workspaceId, command.workspaceId),
        eq(initialValidationRemindersV2.userId, command.userId),
        eq(initialValidationRemindersV2.objectiveId, objectiveId),
        inArray(initialValidationRemindersV2.status, ["pending", "ready"]),
      ))
      .returning({
        reminderId: initialValidationRemindersV2.reminderId,
        reminderRevision: initialValidationRemindersV2.reminderRevision,
      });
    await insertDomainEvents(tx, command.workspaceId, completedReminders.map((r) => ({
      eventType: "initial_validation_reminder.completed",
      aggregateKind: "reminder",
      aggregateId: r.reminderId,
      aggregateRevision: r.reminderRevision,
      payload: {
        objectiveId,
        runId: command.runId,
        commitId,
        factKind,
      },
      idempotencyKey: `completed:${commitId}:${r.reminderId}`,
    })));
  }
  // §7.8：结算回填 presentation_history（outcome/exposed，按 runId 幂等）。
  await backfillPresentationHistory(tx, { runId: command.runId, outcome: result.outcome });
  // P6 Journey：canonical 结算事件（含 scheduleImpact）驱动旅程完成。
  await hookJourneyOnRunCompleted(tx, command, {
    runId: command.runId,
    result: result as unknown as Record<string, unknown>,
  }, at);
  // P8 Orchestrator：确定性 Policy 判定后 durable deliver（事务内）+ LLM
  // 记忆候选生成（延后到事务提交后，避免网络调用钉住结算事务连接）。
  return await (await import("../../companion-conversation/delivery/proactive-hook.ts")).hookProactiveOnRunCompleted(
    tx,
    { workspaceId: command.workspaceId, userId: command.userId },
    {
      runId: command.runId,
      outcome: result.outcome,
      trustOutcome: result.outcome,
      // Plan 23 CS-05：Pet/Companion 不再用 claim/summary 拼标题。
      // 从 Objective revision 查 conceptLabel 作为学习卡标签。
      keyPointClaim: await (async () => {
        try {
          const revRows = await tx
            .select({ conceptLabel: learningObjectiveRevisionsV2.conceptLabel })
            .from(learningObjectiveRevisionsV2)
            .where(and(
              eq(learningObjectiveRevisionsV2.workspaceId, command.workspaceId),
              eq(learningObjectiveRevisionsV2.objectiveId, objectiveId),
            ))
            .orderBy(desc(learningObjectiveRevisionsV2.revision))
            .limit(1);
          return revRows[0]?.conceptLabel ?? "";
        } catch {
          return "";
        }
      })(),
      scheduleImpact: result.scheduleImpact.kind,
    },
    at,
  );
}

/** sandbox Commit 收尾：sandbox trail（scope=sandbox + TTL）+ 0 canonical/schedule。 */
async function finishSandboxCommit(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
  run: { id: string; revision: number; runtimeEpoch: number; sandboxNamespaceId: string | null; returnTarget: unknown },
  at: Date,
): Promise<void> {
  const practiceEventId = `sandbox:${sha256Hex(`${command.runId}:sandbox`).slice(0, 24)}`;
  const runRows = await tx
    .select({ origin: learningRuns.origin })
    .from(learningRuns)
    .where(eq(learningRuns.id, command.runId))
    .limit(1);
    const keyPointId = originObjectiveId(runRows[0]?.origin);
  await tx.insert(practiceTrailEventOutbox).values({
    practiceEventId,
    workspaceId: command.workspaceId,
    userId: command.userId,
    runId: command.runId,
    scope: "sandbox",
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
      scope: "sandbox",
      reasons: ["sandbox"],
      occurredAt: at.toISOString(),
      // TTL：sandbox trail 默认 24 小时过期（§16.4）。
      expiresAt: new Date(at.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    } as never,
    status: "pending",
    createdAt: at,
  }).onConflictDoNothing();
  const result: LearningRunResultV1 = {
    outcome: "practice_completed",
    demonstratedFacets: [],
    gapFacets: [],
    scheduleImpact: { kind: "none", reasonCode: "sandbox" },
    returnTarget: run.returnTarget as never,
  };
  await tx.update(learningRuns)
    .set({ phase: "completed", result: result as never, revision: run.revision + 1, updatedAt: at })
    .where(and(
      eq(learningRuns.id, command.runId),
      eq(learningRuns.workspaceId, command.workspaceId),
      eq(learningRuns.userId, command.userId),
      eq(learningRuns.phase, "committing"),
      eq(learningRuns.runtimeEpoch, run.runtimeEpoch),
    ));
  await appendRunEvent(tx, command, "learning_run.completed", {}, at);
    // §7.8：结算回填 presentation_history（outcome/exposed，按 runId 幂等）。
    await backfillPresentationHistory(tx, { runId: command.runId, outcome: result.outcome });
}


/** demonstrated 的 schedule 处理：按 discrete-v2 推进。 */
async function noteEvidenceAllowsScheduleChange(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
  authorization: SchedulingAuthorizationV1,
): Promise<boolean> {
  if (authorization.kind !== "create_initial" && authorization.kind !== "consume_pending") return true;
  const impact = await readObjectiveNoteChangeImpactV1(tx, {
    workspaceId: command.workspaceId,
    userId: command.userId,
  }, authorization.keyPointId, { lockSourceNotes: true, includeUnchanged: true });
  return impact === null || impact.status === "unaffected";
}

/**
 * 39d W5-5 / §14.2「待复核时不持续放大结论」：这个目标上有一份还没结论的争议时，
 * 本次结算**不动排期**。
 *
 * 与上面那道笔记依据闸并排，位置也在它之后、**消费 pending 之前**——`consume_pending`
 * 那一档会把那条待办写成 `completed` 再排一条继任，先消费后挡就会把用户队列里那一条
 * 变成一个没有对象的提醒（§8.5 明写不能留下无对象的提醒）。
 *
 * 判据在 `run-disputes.ts`，那一侧复用 `decideDisputedObservationV2`：复核"维持"之后
 * 放行，冻着不放就变成 §16.22 那条"反复要求用户接受同一判定"。这里只做调用与回执，
 * 不重写规则。
 *
 * **W5-5 第五刀（2026-09-27，系统侧复核落地之后）多走的那一步**：复核结论是"修正"时，
 * 更正记录由 `dispute-recheck.ts` 的 `commit` 写好、但**尚未被消费**。这一次结算就是它
 * 的消费者：`disputeScheduleResolutionV2` 交回"该消费哪一条"，这里调
 * `markCorrectionAppliedV2` **消费一次**，然后照常往下走唯一调度边界重算（§9.6「需要
 * 重新计算时仍经唯一调度服务，基于全部适用事实和当前授权给出一次明确回执」）。
 * 不这么做，那条更正就是一条"有人写、没人读"的记录——`markCorrectionAppliedV2` 至今
 * 零生产调用方，也正是 §16.25 要防的"两种更正混算"里最容易发生的那一种。
 */
async function disputeAllowsScheduleChange(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
  authorization: SchedulingAuthorizationV1,
  at: Date,
): Promise<{ allowed: true } | { allowed: false; reasonCode: "assessment_disputed" }> {
  if (authorization.kind !== "create_initial" && authorization.kind !== "consume_pending") {
    return { allowed: true };
  }
  const resolution = await disputeScheduleResolutionV2(tx, {
    workspaceId: command.workspaceId,
    userId: command.userId,
    objectiveId: authorization.keyPointId,
  });
  if (resolution.blocked) return { allowed: false, reasonCode: resolution.reasonCode };
  if (resolution.correctionToApply) {
    // 只许一次：已应用过的那一次被 `markCorrectionAppliedV2` 判成 `alreadyApplied` 并
    // **不**重置应用时间（§9.6「不能重复消费同一日程」）。它幂等，所以重放结算命令
    // 不会把同一次更正消费第二遍。
    await markCorrectionAppliedV2(tx, {
      workspaceId: command.workspaceId,
      userId: command.userId,
      assessmentId: resolution.correctionToApply.assessmentId,
      at,
    });
  }
  return { allowed: true };
}

/**
 * W7-8 刀二：把 §9.1「在手动日期约束仍有效时，自动策略不能悄悄把提醒提前」接进结算。
 *
 * ## 这一格今天是怎么坏的
 *
 * 到期队列那一读**认** `review_schedules.user_deferred_until`（`review/service.ts:190`），
 * 所以"延后到那天之前不该出现在队列里"这一半成立。另一半没有：四个写入点都直接落
 * `nextReviewAt: decision.nextReviewAt`——**不读那一列**。她选了"下周三"而策略算出
 * "后天"，提醒就悄悄提前了，而且没有任何一处会留痕。
 *
 * ## 为什么在这一层读，而不是让 `ensurePendingReviewScheduleV2` 自己去夹
 *
 * 那一支是"唯一写入安排"的**边界**（`review-schedule-boundary.ts`，两条链与四处调用
 * 共用）。让它顺手读 `user_deferred_until` 看起来更省事，但它写的是**排期**，
 * 而手动日期是**展示层的延后**（§18.1/§18.3 那一族：只改展示的时间列，官方到期不变）。
 * 让边界替展示层改官方日期，就把两件事搅在一起了——而这正是本仓库反复记的同一个错。
 * 所以读在结算这一层，判在纯函数里，写的仍是边界。
 *
 * ## `requirementChanged` 为什么给的是"那一格被消费过没有"
 *
 * §9.1「手动日期约束属于**本次需求版本**」。消费掉的那一格（`consumed`/`superseded`）
 * 就是需求换版的那一刻：她已经按那条手动日期走完了一轮，约束不该再压住下一轮。
 */
async function clampToManualDateV2(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  input: {
    workspaceId: string;
    userId: string;
    subjectId: string;
    /**
     * 手动日期约束挂在**某一格需求**上（§9.1「手动日期约束属于本次需求版本」）。
     * 同一个目标现在可能有提取、应用两格，limit(1) 又没有排序——不按维度筛的话，
     * 它读到的是"随便哪一格"的手动日期，于是**另一格的约束会来压住这一格的日期**，
     * 或者反过来：她设的手动日期根本没被这条路径认到。
     */
    reviewDimension: ReviewDimensionV2;
    policyNextReviewAt: Date;
    /** 本次需求是否已换版（那一格被消费／被继任取代）。 */
    requirementChanged: boolean;
  },
): Promise<{ nextReviewAt: Date; raisedByConstraint: boolean; constraint: ManualDateConstraintEndedV2 }> {
  const rows = await tx
    .select({ manualDeferredUntil: reviewSchedules.userDeferredUntil })
    .from(reviewSchedules)
    .where(and(
      eq(reviewSchedules.workspaceId, input.workspaceId),
      eq(reviewSchedules.userId, input.userId),
      eq(reviewSchedules.subjectId, input.subjectId),
      eq(reviewSchedules.reviewDimension, input.reviewDimension),
    ))
    .orderBy(desc(reviewSchedules.updatedAt))
    .limit(1);
  const decided = decideNextReviewAtWithManualDateV2({
    policyNextReviewAt: input.policyNextReviewAt,
    manualDeferredUntil: rows[0]?.manualDeferredUntil ?? null,
    requirementChanged: input.requirementChanged,
  });
  return {
    nextReviewAt: decided.nextReviewAt,
    raisedByConstraint: decided.raisedByConstraint,
    constraint: decided.constraint,
  };
}

async function applyDemonstratedSchedule(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
  authorization: SchedulingAuthorizationV1,
  at: Date,
  reviewDimension: ReviewDimensionV2,
  disposition?: string,
): Promise<LearningRunResultV1["scheduleImpact"]> {
  // 39d W5-1 主体刀二：**借助完成冷却**的真正起算点。此前这三处把
  // `unassistedEligibleAfter` 写死成 `null`，而 `null` 在策略里的含义是
  // 「没有需要冷却的帮助」＝「这次是独立表现」——于是「判不出来」与「确凿独立」
  // 在下游完全一样，§14.1.1「保留回答但不签发独立证据」被解成了反面。
  const helpCondition = await readHelpConditionV2(tx, command);
  const helpCooldown = helpConditionCooldownAfterV2({ condition: helpCondition, at });
  // §13.6：facet_evidence（partial/结构化 facet 结算）0 schedule effect——
  // 不消费 pending、不创建 successor（canonical facet observation 照常发布）。
  if (disposition === "facet_evidence") {
    return { kind: "none", reasonCode: "facet_only" };
  }
  if (!await noteEvidenceAllowsScheduleChange(tx, command, authorization)) {
    return { kind: "none", reasonCode: "note_evidence_changed" };
  }
  // §14.2「待复核时不持续放大结论」：争议未决就不推进复习间隔。与上面那道闸并排，
  // 同样挡在 consume_pending 之前——先消费再挡会留下一个没有对象的提醒（§8.5）。
  const disputeGate = await disputeAllowsScheduleChange(tx, command, authorization, at);
  if (!disputeGate.allowed) {
    return { kind: "none", reasonCode: disputeGate.reasonCode };
  }
  // 证据存在性：cardKeyPoints.quote 读取已退役。可走到 Commit 的
  // canonical run 必然已通过 V2 evidence closure 复验（revalidateV2CommitEpochs
  // 要求全部 usable，fail closed），故 hard evidence 恒成立（P2 保守口径）。
  const hasHardEvidence = true;

  if (authorization.kind === "create_initial") {
    const decision = calculateDiscreteV2Schedule({
      currentIntervalDays: 1,
      outcome: "correct",
      hasValidServerQuestion: true,
      hasHardEvidence,
      now: at,
      unassistedEligibleAfter: helpCooldown.eligibleAfter,
    });
    // W7-8 刀二：先把策略算出来的那一天过一遍手动日期约束。
    const clamped = await clampToManualDateV2(tx, {
      workspaceId: command.workspaceId,
      userId: command.userId,
      subjectId: authorization.keyPointId,
      reviewDimension,
      policyNextReviewAt: decision.nextReviewAt,
      // 继任那一支：那一格刚被消费 ⇒ 需求已换版；新建那一支没有换版。
      requirementChanged: false,
    });
    if (clamped.raisedByConstraint) {
      // 「不能悄悄」：抬过要留痕，否则日志与回执里看不出这一天被人动过。
      logger.warn(
        { runId: command.runId,
          workspaceId: command.workspaceId, subjectId: authorization.keyPointId,
        policy: decision.nextReviewAt.toISOString(), clamped: clamped.nextReviewAt.toISOString(),
        constraint: clamped.constraint,
        },
        "[schedule] 手动日期约束抬过了策略日期",
      );
    }
    const scheduled = await ensurePendingReviewScheduleV2(tx, {
      workspaceId: command.workspaceId,
      userId: command.userId,
      // V2 objective 维度：subjectType="card" + subjectId=objectiveId（§29.4
      // 惯例；与 surface-service/card-service 读取端一致）。
      subjectId: authorization.keyPointId,
      // §9.1 事实提取与综合应用分别观察。此前这一格恒为空串（列在、索引在、
      // 边界也收，唯独没有人传过），于是两种需求塌成一格。
      reviewDimension,
      // §9.1「在手动日期约束仍有效时，自动策略不能悄悄把提醒提前」——这一格此前
      // 直接落策略日期，于是她选的日期会被悄悄提前。
      nextReviewAt: clamped.nextReviewAt,
      intervalDays: decision.afterIntervalDays,
      generation: 1,
      policyVersion: decision.policyVersion,
      reasonCode: decision.reasonCode,
      at,
    });
    // dueAt 取**库里那一条**的到期时间：这一格已被占（并发/重放）时，屏幕上
    // 不能出现一个没人持有的日期。
    if (scheduled.held) return { kind: "none", reasonCode: "objective_held" };
    // ⚠️ 与上面两处 `successor` 分支**同形**：刀三给闸接进去来源级授权之后，`held` **不是**
    // 「没有到期时间」的那一档——`source_paused` / `never_authorized` 两档是
    // **`held: false` 而 `nextReviewAt: null`**。而上一行那句注释恰好与 `!` 自相矛盾：
    // 「dueAt 取**库里那一条**的到期时间：这一格已被占（并发/重放）时，屏幕上不能出现一个
    // 没人持有的日期」——**并发/重放时那一条可能根本没有**，而 `!` 恰恰说它一定有。
    if (scheduled.nextReviewAt === null) {
      return {
        kind: "none",
        reasonCode: scheduled.sourcePaused === true
          ? "source_paused"
          : (scheduled.neverAuthorized === true ? "never_authorized" : "no_next_review_at"),
      };
    }
    return { kind: "created", dueAt: scheduled.nextReviewAt.toISOString(), policyReason: "demonstrated" };
  }
  if (authorization.kind === "consume_pending") {
    const currentRows = await tx
      .select({ intervalDays: reviewSchedules.intervalDays })
      .from(reviewSchedules)
      .where(and(
        eq(reviewSchedules.id, authorization.scheduleId),
        eq(reviewSchedules.workspaceId, command.workspaceId),
        eq(reviewSchedules.userId, command.userId),
      ))
      .limit(1);
    const decision = calculateDiscreteV2Schedule({
      currentIntervalDays: currentRows[0]?.intervalDays ?? 1,
      outcome: "correct",
      hasValidServerQuestion: true,
      hasHardEvidence,
      now: at,
      unassistedEligibleAfter: helpCooldown.eligibleAfter,
    });
    const consumed = await tx
      .update(reviewSchedules)
      .set({ status: "completed", lastReviewAt: at, updatedAt: at })
      .where(and(
        eq(reviewSchedules.id, authorization.scheduleId),
        eq(reviewSchedules.workspaceId, command.workspaceId),
        eq(reviewSchedules.userId, command.userId),
        eq(reviewSchedules.generation, authorization.scheduleGeneration),
        eq(reviewSchedules.status, "pending"),
      ))
      .returning({ id: reviewSchedules.id });
    if (consumed.length === 0) {
      // generation 已变化：0 schedule 副作用（不猜）。
      return { kind: "none", reasonCode: "stale" };
    }
    // W7-8 刀二：先把策略算出来的那一天过一遍手动日期约束。
    const successorClamped = await clampToManualDateV2(tx, {
      workspaceId: command.workspaceId,
      userId: command.userId,
      subjectId: authorization.keyPointId,
      reviewDimension,
      policyNextReviewAt: decision.nextReviewAt,
      // 继任那一支：那一格刚被消费 ⇒ 需求已换版；新建那一支没有换版。
      requirementChanged: true,
    });
    if (successorClamped.raisedByConstraint) {
      // 「不能悄悄」：抬过要留痕，否则日志与回执里看不出这一天被人动过。
      logger.warn(
        { runId: command.runId,
          workspaceId: command.workspaceId, subjectId: authorization.keyPointId,
        policy: decision.nextReviewAt.toISOString(), clamped: successorClamped.nextReviewAt.toISOString(),
        constraint: successorClamped.constraint,
        },
        "[schedule] 手动日期约束抬过了策略日期",
      );
    }
    const successor = await ensurePendingReviewScheduleV2(tx, {
      workspaceId: command.workspaceId,
      userId: command.userId,
      subjectId: authorization.keyPointId,
      // §9.1 事实提取与综合应用分别观察。此前这一格恒为空串（列在、索引在、
      // 边界也收，唯独没有人传过），于是两种需求塌成一格。
      reviewDimension,
      // 继任那一支：那一格刚被消费掉 ⇒ **本次需求已换版**，所以约束到此结束
      // （§9.1「手动日期约束属于本次需求版本，不能变成永久禁止以后安排的规则」）。
      nextReviewAt: successorClamped.nextReviewAt,
      intervalDays: decision.afterIntervalDays,
      generation: authorization.scheduleGeneration + 1,
      supersedesScheduleId: authorization.scheduleId,
      policyVersion: decision.policyVersion,
      reasonCode: decision.reasonCode,
      at,
    });
    if (successor.held) return { kind: "none", reasonCode: "objective_held" };
    // ⚠️ `held` **不是**「没有到期时间」的那一档。W7-8 刀三给这道闸接进去的**来源级授权**
    // 里有**两档 `held: false` 而 `nextReviewAt: null`**：`paused_all`（她把来源停掉了）与
    // `never_authorized`（§9.1「**没人替她开过授权**」）。第一版写的是
    // `successor.nextReviewAt!.toISOString()`——那个 `!` 背后的假设是「**没有日期 ⇒ 被排除**」，
    // 而**刀三自己把那个假设打破了**，于是这两档在真库上直接
    // `Cannot read properties of null (reading 'toISOString')`，整条 tick 挂掉。
    //
    // **结算族那三条红（P2 纵切 / E04 消费 schedule / RUN-V2-WIRE-01）全是它的下游。**
    //
    // 形状：**两档都说不同的话**——`source_paused` 是「她停掉了，照办」；`never_authorized`
    // 是「**没人替她开过授权**」，那要**问**，不能与「她停掉了」走同一条路（§9.1 规则表）。
    if (successor.nextReviewAt === null) {
      return {
        kind: "none",
        reasonCode: successor.sourcePaused === true
          ? "source_paused"
          : (successor.neverAuthorized === true ? "never_authorized" : "no_next_review_at"),
      };
    }
    return {
      kind: "rescheduled",
      dueAt: successor.nextReviewAt.toISOString(),
      consumedScheduleId: authorization.scheduleId,
      policyReason: "demonstrated",
    };
  }
  const reasonCode = authorization.kind === "record_only" ? "record_only" : authorization.reasonCode;
  return { kind: "none", reasonCode: (reasonCode ?? "not_authorized") as never };
}

/** declared_unable 的 schedule 处理：按 discrete-v2 创建/消费 successor。 */
async function applyUnableSchedule(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
  authorization: SchedulingAuthorizationV1,
  at: Date,
  reviewDimension: ReviewDimensionV2,
): Promise<LearningRunResultV1["scheduleImpact"]> {
  // 39d W5-1 主体刀二：**借助完成冷却**的真正起算点。此前这三处把
  // `unassistedEligibleAfter` 写死成 `null`，而 `null` 在策略里的含义是
  // 「没有需要冷却的帮助」＝「这次是独立表现」——于是「判不出来」与「确凿独立」
  // 在下游完全一样，§14.1.1「保留回答但不签发独立证据」被解成了反面。
  const helpCondition = await readHelpConditionV2(tx, command);
  const helpCooldown = helpConditionCooldownAfterV2({ condition: helpCondition, at });
  if (!await noteEvidenceAllowsScheduleChange(tx, command, authorization)) {
    return { kind: "none", reasonCode: "note_evidence_changed" };
  }
  // §14.2「未经确认的争议结果**不继续作为负面推荐依据**」——这一档比 demonstrated
  // 更该挡：`declared_unable` 本身就是负面结论，被申诉期间继续拿它推排程，
  // 等于让一次未确认的判定持续把用户往回拽。
  const disputeGate = await disputeAllowsScheduleChange(tx, command, authorization, at);
  if (!disputeGate.allowed) {
    return { kind: "none", reasonCode: disputeGate.reasonCode };
  }
  const calculateUnableDecision = (currentIntervalDays: number) => calculateDiscreteV2Schedule({
    currentIntervalDays,
    outcome: "unable",
    hasValidServerQuestion: true,
    hasHardEvidence: true,
    now: at,
      unassistedEligibleAfter: helpCooldown.eligibleAfter,
  });
  if (authorization.kind === "create_initial") {
    const decision = calculateUnableDecision(1);
    // W7-8 刀二：先把策略算出来的那一天过一遍手动日期约束。
    const clamped = await clampToManualDateV2(tx, {
      workspaceId: command.workspaceId,
      userId: command.userId,
      subjectId: authorization.keyPointId,
      reviewDimension,
      policyNextReviewAt: decision.nextReviewAt,
      // 继任那一支：那一格刚被消费 ⇒ 需求已换版；新建那一支没有换版。
      requirementChanged: false,
    });
    if (clamped.raisedByConstraint) {
      // 「不能悄悄」：抬过要留痕，否则日志与回执里看不出这一天被人动过。
      logger.warn(
        { runId: command.runId,
          workspaceId: command.workspaceId, subjectId: authorization.keyPointId,
        policy: decision.nextReviewAt.toISOString(), clamped: clamped.nextReviewAt.toISOString(),
        constraint: clamped.constraint,
        },
        "[schedule] 手动日期约束抬过了策略日期",
      );
    }
    const scheduled = await ensurePendingReviewScheduleV2(tx, {
      workspaceId: command.workspaceId,
      userId: command.userId,
      subjectId: authorization.keyPointId,
      // §9.1 事实提取与综合应用分别观察。此前这一格恒为空串（列在、索引在、
      // 边界也收，唯独没有人传过），于是两种需求塌成一格。
      reviewDimension,
      // §9.1「在手动日期约束仍有效时，自动策略不能悄悄把提醒提前」——这一格此前
      // 直接落策略日期，于是她选的日期会被悄悄提前。
      nextReviewAt: clamped.nextReviewAt,
      intervalDays: decision.afterIntervalDays,
      generation: 1,
      policyVersion: decision.policyVersion,
      reasonCode: decision.reasonCode,
      at,
    });
    if (scheduled.held) return { kind: "none", reasonCode: "objective_held" };
    // 同上（`declared_unable` 那一支）：`held` 不是「没有日期」的那一档。
    if (scheduled.nextReviewAt === null) {
      return {
        kind: "none",
        reasonCode: scheduled.sourcePaused === true
          ? "source_paused"
          : (scheduled.neverAuthorized === true ? "never_authorized" : "no_next_review_at"),
      };
    }
    return { kind: "created", dueAt: scheduled.nextReviewAt.toISOString(), policyReason: "declared_unable" };
  }
  if (authorization.kind === "consume_pending") {
    const currentRows = await tx
      .select({ intervalDays: reviewSchedules.intervalDays })
      .from(reviewSchedules)
      .where(and(
        eq(reviewSchedules.id, authorization.scheduleId),
        eq(reviewSchedules.workspaceId, command.workspaceId),
        eq(reviewSchedules.userId, command.userId),
      ))
      .limit(1);
    const decision = calculateUnableDecision(currentRows[0]?.intervalDays ?? 1);
    const consumed = await tx
      .update(reviewSchedules)
      .set({ status: "completed", lastReviewAt: at, updatedAt: at })
      .where(and(
        eq(reviewSchedules.id, authorization.scheduleId),
        eq(reviewSchedules.workspaceId, command.workspaceId),
        eq(reviewSchedules.userId, command.userId),
        eq(reviewSchedules.generation, authorization.scheduleGeneration),
        eq(reviewSchedules.status, "pending"),
      ))
      .returning({ id: reviewSchedules.id });
    if (consumed.length === 0) {
      // generation 已变化：0 schedule 副作用（不猜）。
      return { kind: "none", reasonCode: "stale" };
    }
    // W7-8 刀二：先把策略算出来的那一天过一遍手动日期约束。
    const successorClamped = await clampToManualDateV2(tx, {
      workspaceId: command.workspaceId,
      userId: command.userId,
      subjectId: authorization.keyPointId,
      reviewDimension,
      policyNextReviewAt: decision.nextReviewAt,
      // 继任那一支：那一格刚被消费 ⇒ 需求已换版；新建那一支没有换版。
      requirementChanged: true,
    });
    if (successorClamped.raisedByConstraint) {
      // 「不能悄悄」：抬过要留痕，否则日志与回执里看不出这一天被人动过。
      logger.warn(
        { runId: command.runId,
          workspaceId: command.workspaceId, subjectId: authorization.keyPointId,
        policy: decision.nextReviewAt.toISOString(), clamped: successorClamped.nextReviewAt.toISOString(),
        constraint: successorClamped.constraint,
        },
        "[schedule] 手动日期约束抬过了策略日期",
      );
    }
    const successor = await ensurePendingReviewScheduleV2(tx, {
      workspaceId: command.workspaceId,
      userId: command.userId,
      subjectId: authorization.keyPointId,
      // §9.1 事实提取与综合应用分别观察。此前这一格恒为空串（列在、索引在、
      // 边界也收，唯独没有人传过），于是两种需求塌成一格。
      reviewDimension,
      // 继任那一支：那一格刚被消费掉 ⇒ **本次需求已换版**，所以约束到此结束
      // （§9.1「手动日期约束属于本次需求版本，不能变成永久禁止以后安排的规则」）。
      nextReviewAt: successorClamped.nextReviewAt,
      intervalDays: decision.afterIntervalDays,
      generation: authorization.scheduleGeneration + 1,
      supersedesScheduleId: authorization.scheduleId,
      policyVersion: decision.policyVersion,
      reasonCode: decision.reasonCode,
      at,
    });
    if (successor.held) return { kind: "none", reasonCode: "objective_held" };
    if (successor.nextReviewAt === null) {
      return {
        kind: "none",
        reasonCode: successor.sourcePaused === true
          ? "source_paused"
          : (successor.neverAuthorized === true ? "never_authorized" : "no_next_review_at"),
      };
    }
    return {
      kind: "rescheduled",
      dueAt: successor.nextReviewAt.toISOString(),
      consumedScheduleId: authorization.scheduleId,
      policyReason: "declared_unable",
    };
  }
  // record_only / no_effect：0 schedule 副作用。
  const reasonCode = authorization.kind === "record_only" ? "record_only" : authorization.reasonCode;
  return {
    kind: "none",
    reasonCode: (reasonCode ?? "not_authorized") as never,
  };
}


// CommandRow 事件写入辅助。
