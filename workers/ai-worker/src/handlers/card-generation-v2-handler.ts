/**
 * 制卡 outbox 的分发点：认领 `card_generation_run_outbox_v2` 里的一条 job，按 jobType
 * 交给对应的处理函数，并把租约、墙钟预算与"可不可重试"的结算规则统一在这里做掉。
 *
 * 文件名里的 "v2" 指的是**表与合同家族**（`card_generation_*_v2`），不是那条已删除的
 * 四阶段链：2026-09-27（39d W7-7 刀二）删掉 planner→author→双 Critic→deck gate 那条链
 * 之后，这里只剩简化链的两种 job（整批 `card_generation_simplified_v1`、逐候选
 * `card_candidate_refine_v3`）加一发与链无关的激活后投影。未知 jobType 仍然
 * **fail job**（§17.1：不允许静默 complete，否则投错名字的 job 会安静消失）。
 *
 * 已经搬走的三块内核（同一次刀二）：错误可重试分类 `card-generation-v2/retry-classification.ts`、
 * 队列与租约 `card-generation-v2/outbox-queue.ts`、两条链共用的读侧与落库原语
 * `card-generation-v2/run-io.ts`。治理出口（同意、provider 选择、mock fail-fast、
 * `ai_audit_log` 唯一写入口）留在 `card-generation-v2/governed-provider.ts`——
 * 那份今天唯一的消费者就是这里的逐候选/整批两发。
 */

import { sql } from "drizzle-orm";
import { db, withWorkerWorkspaceTransaction } from "../db.ts";
import { logger } from "../lib/logger.ts";
import { runWithAbortTimeout } from "../lib/handler-timeout.ts";
import {
  claimV2OutboxJobs,
  completeV2OutboxJob,
  failV2OutboxJob,
  fenceV2OutboxLease,
  reapStaleV2OutboxJobs,
  renewV2OutboxLease,
  sanitizeOperationalError,
  v2Inflight,
  V2_LEASE_RENEWAL_INTERVAL_MS,
  V2_OUTBOX_MAX_CONCURRENCY,
  V2_PIPELINE_BUDGET_MS,
  V2_POLL_TIMEOUT_MS,
  type PendingOutboxJob,
} from "../card-generation-v2/outbox-queue.ts";
import {
  CardGenerationProviderErrorLike,
  isRetryableProviderError,
} from "../card-generation-v2/retry-classification.ts";
import { resolveGovernedCardGenerationProvider } from "../card-generation-v2/governed-provider.ts";
import {
  cardGenerationV3LlmRequested,
  processCardCandidateRefineV3Job,
  processCardGenerationSimplifiedJob,
  resolveCardGenerationV3Providers,
} from "../card-generation-v3/handler.ts";
import {
  asCardGenerationV3Transport,
  type CardGenerationV3ChatTransport,
} from "../card-generation-v3/llm-provider.ts";

export async function processV2OutboxJob(job: PendingOutboxJob): Promise<void> {
  logger.info({ jobId: job.id, runId: job.runId, jobType: job.jobType }, "V2 outbox job processing");

  let retryable = true;
  let leaseLost = false;
  let budgetExhausted = false;
  const abortController = new AbortController();
  const pipelineSignal = abortController.signal;
  const budgetTimer = setTimeout(() => {
    budgetExhausted = true;
    logger.warn(
      { jobId: job.id, runId: job.runId, budgetMs: V2_PIPELINE_BUDGET_MS },
      "V2 pipeline wall-clock budget exhausted; aborting remaining LLM calls (terminal, no retry)",
    );
    abortController.abort(new Error(`V2 pipeline budget exhausted after ${V2_PIPELINE_BUDGET_MS}ms`));
  }, V2_PIPELINE_BUDGET_MS);
  budgetTimer.unref?.();

  const leaseRenewal = async (): Promise<void> => {
    try {
      const renewed = await renewV2OutboxLease(job.id, job.leaseToken);
      if (!renewed) {
        leaseLost = true;
        // H5：租约丢失 = 结果已被他人接管，继续执行只会烧钱。立即中止在途/后续调用。
        abortController.abort(new Error("V2 outbox lease lost"));
        logger.warn(
          { jobId: job.id, runId: job.runId },
          "V2 outbox lease was lost; aborting remaining LLM calls (late result suppressed)",
        );
      }
    } catch (error) {
      // 短暂 DB 故障不要立刻放弃；下一次 heartbeat 会重试。若租约实际过期，
      // 最后的 complete/fail 仍由 status+lease_token CAS 拦截。
      logger.warn(
        { jobId: job.id, runId: job.runId, error: sanitizeOperationalError(error) },
        "V2 outbox lease renewal failed",
      );
    }
  };
  const renewalTimer = setInterval(() => {
    void leaseRenewal();
  }, V2_LEASE_RENEWAL_INTERVAL_MS);
  renewalTimer.unref?.();

  try {
    switch (job.jobType) {
      case "card_generation_simplified_v1":
        // W7-1 刀b：简化链（默认路径两次语义调用）。W7-7 刀一起它是唯一在投的链。
        await runSimplifiedChainV3Job(job, pipelineSignal, "generate");
        break;
      case "card_candidate_refine_v3":
        // W7-7 刀一：审核台上的「编辑后重检」「按反馈重生成」——同一批腿，只作用于这一张。
        await runSimplifiedChainV3Job(job, pipelineSignal, "refine");
        break;
      case "card_v2_post_activation":
        // §17.5 step 17：outbox 异步投影消费——按 receiptId 幂等对账
        // （receipt/cards/objectives 存在性 + lifecycle 校验），对账结果写入
        // 台账；personal projection 保持 0 变化（表 CHECK 结构化强制）。
        // R33：由原 ack-only 改为真实消费者（见 processPostActivationProjection）。
        await processPostActivationProjection(job);
        break;
      default:
        // §17.1：未知 jobType → 失败（不得静默 complete）。
        throw new CardGenerationProviderErrorLike(false, `unknown V2 outbox job type: ${job.jobType}`);
    }

    await leaseRenewal();
    if (leaseLost) return;
    await completeV2OutboxJob(job.id, job.leaseToken);
  } catch (error) {
    if (leaseLost) return;
    const message = sanitizeOperationalError(error);
    if (budgetExhausted) {
      // M1：预算耗尽 = 确定性终止。重试会把同样的模型费用再花一遍，且必然
      // 同样超时，因此 non-retryable 直接终结（run → needs_attention）。
      logger.error(
        { jobId: job.id, runId: job.runId, error: message, budgetMs: V2_PIPELINE_BUDGET_MS },
        "V2 outbox job terminated: pipeline wall-clock budget exhausted",
      );
      await failV2OutboxJob(
        job.id,
        job.leaseToken,
        `V2 pipeline wall-clock budget exhausted after ${V2_PIPELINE_BUDGET_MS}ms (terminal, not retried)`,
        false,
      );
      return;
    }
    retryable = isRetryableProviderError(error);
    if (pipelineSignal.aborted && retryable) {
      // 调用方主动 abort（非预算）：不作为可重试失败回队列，直接按 non-retryable
      // 终结，避免"被取消的管道"立刻重放一遍完整 LLM 序列。
      retryable = false;
    }
    if (process.env.V2_E2E_DEBUG_ERRORS === "1") {
      // eslint-disable-next-line no-console
      console.error("V2_JOB_DEBUG", job.jobType, job.runId, (error as Error)?.stack ?? String(error));
    }
    logger.error({ jobId: job.id, runId: job.runId, error: message, retryable }, "V2 outbox job failed");
    await failV2OutboxJob(job.id, job.leaseToken, message, retryable);
  } finally {
    clearInterval(renewalTimer);
    clearTimeout(budgetTimer);
  }
}

/**
 * 简化链两种 job 的共用接线（39d W7-1 刀b 建立，W7-7 刀一接上第二种 job）。
 *
 * **provider 组装只写一份**：整批与逐候选两种 job 如果各搭一遍治理出口，哪天
 * 同意/外发政策只改一边，就有一条链悄悄绕过它。
 */
async function runSimplifiedChainV3Job(
  job: PendingOutboxJob,
  signal: AbortSignal | undefined,
  kind: "generate" | "refine",
): Promise<void> {
  let llmTransport: CardGenerationV3ChatTransport | undefined;
  if (cardGenerationV3LlmRequested()) {
    // 治理出口只有一份：run 的主人、同意/外发政策、provider 选择与 `ai_audit_log` 的
    // 唯一写入口都在 `resolveGovernedCardGenerationProvider` 那一处（operation 记
    // `card_generation_v3`，制卡的账要和别的 AI 用途分得开）。
    const context = await resolveCardGenerationGovernance(job.workspaceId, job.runId);
    llmTransport = asCardGenerationV3Transport(await resolveGovernedCardGenerationProvider({
      workspaceId: job.workspaceId,
      userId: context.userId,
      operation: "card_generation_v3",
      chainLabel: "card-generation-v3",
      llmModeLabel: "CARD_GENERATION_V3_PROVIDER",
      governance: context.governance,
    }));
  }
  const providers = resolveCardGenerationV3Providers(
    llmTransport ? { transport: llmTransport } : undefined,
  );
  if (kind === "refine") {
    await processCardCandidateRefineV3Job(job, providers, signal);
    return;
  }
  await processCardGenerationSimplifiedJob(job, providers, signal);
}

/**
 * 消费 `card_v2_post_activation` outbox job：按 receiptId **幂等**对账
 * Card 列表/搜索/shared topology 投影。
 *
 * 语义（R33，替换原 ack-only 占位）：
 * 1. 台账已存在（同 workspace+receiptId）→ 已消费，直接返回（幂等重放）；
 * 2. receipt 必须存在且含 mappings（激活事务同事务写入；缺失 = 数据不一致
 *    → 非重试失败，不得静默完成；mappings 尚未就绪 = 时序瞬态 → retryable）；
 * 3. mapping 引用的 learning_cards_v2 / learning_objectives_v2 必须全部存在
 *    且 lifecycle='active'（shared topology 对账；任一缺失/未 active 可能是激活事务
 *    与下游 states 异步推进的时序窗口 → **retryable**，靠幂等重试自愈，而非
 *    一次性 failed 固化瞬时不一致）；payload 结构错误 → 非重试失败；
 * 4. 对账结果写入 `card_generation_post_activation_consumptions` 台账；
 *    personal projection 保持 0 变化——消费者唯一的写就是台账，且表 CHECK
 *    `personal_projection_writes = 0` 结构化强制（§17.5 step 17）。
 *
 * 全部读写在 ailearn_worker 角色 + workspace 上下文中执行（RLS NOBYPASSRLS
 * 验证，与主管线一致）。
 */
async function processPostActivationProjection(job: PendingOutboxJob): Promise<void> {
  // R33：payload 兼容两种落库形状——对象（drizzle insert）或 **jsonb 字符串**
  // （直接 postgres-js + `::jsonb` 的双编码路径）。归一化必须在结构校验**之前**：
  // 否则一次可正常消费的任务会被判成"结构错误"、以**非重试**失败固化下来
  // （实测 R33 用例即此路径：期望的失败原因是"台账里找不到 receipt"，而不是
  // "payload 不是对象"）。
  let normalizedPayload: unknown = job.payload;
  if (typeof normalizedPayload === "string") {
    try {
      normalizedPayload = JSON.parse(normalizedPayload);
    } catch {
      normalizedPayload = null;
    }
  }
  if (normalizedPayload === null || typeof normalizedPayload !== "object" || Array.isArray(normalizedPayload)) {
    throw new CardGenerationProviderErrorLike(
      false,
      `card_v2_post_activation payload must be an object: ${JSON.stringify(job.payload)}`,
    );
  }
  const rawPayload = normalizedPayload as Record<string, unknown>;
  const runId = rawPayload.runId;
  const workspaceId = rawPayload.workspaceId;
  const receiptId = rawPayload.receiptId;
  if (
    typeof workspaceId !== "string"
    || typeof runId !== "string"
    || typeof receiptId !== "string"
    || workspaceId.length === 0
    || runId.length === 0
    || receiptId.length === 0
  ) {
    throw new CardGenerationProviderErrorLike(
      false,
      `card_v2_post_activation payload missing fields: ${JSON.stringify(job.payload)}`,
    );
  }
  await withWorkerWorkspaceTransaction(
    { workspaceId, userId: null },
    async (tx) => {
      // 1. 幂等：台账已存在 → 已完成消费。
      const existing = await tx.execute(sql`
        SELECT id FROM public.card_generation_post_activation_consumptions
        WHERE workspace_id = ${workspaceId} AND receipt_id = ${receiptId}
        LIMIT 1
      `);
      if (existing.length > 0) return;

      // 2. receipt 必须存在。
      const receiptRows = await tx.execute(sql`
        SELECT mappings FROM public.card_activation_receipts_v2
        WHERE workspace_id = ${workspaceId} AND receipt_id = ${receiptId}
        LIMIT 1
      `);
      if (receiptRows.length === 0) {
        throw new CardGenerationProviderErrorLike(
          false,
          `post-activation receipt not found: ${receiptId}`,
        );
      }
      const mappings = (receiptRows[0] as { mappings: unknown }).mappings as Array<{
        candidateRevisionId: string;
        cardId: string;
        objectiveId: string;
      }>;
      if (!Array.isArray(mappings) || mappings.length === 0) {
        // 时序瞬态：receipt 行已可见但其 mappings 可能尚未提交/仍为空（激活事务
        // 提交与下游推进存在窗口）。按幂等对账类消费者重试是安全的（receiptId 去重），
        // 返 retryable 让 job 回 pending 限次重投，避免一次性 failed 固化瞬时不一致。
        throw new CardGenerationProviderErrorLike(
          true,
          `post-activation receipt has no mappings (retryable): ${receiptId}`,
        );
      }
      const cardIds = [...new Set(mappings.map((m) => m.cardId))];
      const objectiveIds = [...new Set(mappings.map((m) => m.objectiveId))];
      // R29/R32：drizzle+postgres-js 数组参数序列化不可靠（malformed array
      // literal）——显式 `{uuid,...}::uuid[]` 字面量（id 均来自本库 uuid 列）。
      const cardIdsLiteral = `{${cardIds.join(",")}}`;
      const objectiveIdsLiteral = `{${objectiveIds.join(",")}}`;

      // 3. Card/Objective 存在性 + lifecycle 对账（shared topology）。
      const cardRows = await tx.execute(sql`
        SELECT card_id, lifecycle FROM public.learning_cards_v2
        WHERE workspace_id = ${workspaceId} AND card_id = ANY(${cardIdsLiteral}::uuid[])
      `);
      const cardById = new Map(
        cardRows.map((r) => {
          const row = r as { card_id: string; lifecycle: string };
          return [String(row.card_id), String(row.lifecycle)] as const;
        }),
      );
      for (const id of cardIds) {
        const lifecycle = cardById.get(id);
        if (!lifecycle) {
          // 时序瞬态：卡片可能尚未落库/尚不可见（激活事务与下游 states 推进解耦）。
          // 对账类消费者重试安全（receiptId 幂等去重）→ retryable，避免固化瞬时不一致。
          throw new CardGenerationProviderErrorLike(true, `post-activation card missing (retryable): ${id}`);
        }
        if (lifecycle !== "active") {
          // lifecycle 可能由下游异步推进到 active——未就绪属于时序瞬态 → retryable。
          throw new CardGenerationProviderErrorLike(
            true,
            `post-activation card not active (retryable): ${id} (${lifecycle})`,
          );
        }
      }

      const objRows = await tx.execute(sql`
        SELECT objective_id, lifecycle FROM public.learning_objectives_v2
        WHERE workspace_id = ${workspaceId} AND objective_id = ANY(${objectiveIdsLiteral}::uuid[])
      `);
      const objById = new Map(
        objRows.map((r) => {
          const row = r as { objective_id: string; lifecycle: string };
          return [String(row.objective_id), String(row.lifecycle)] as const;
        }),
      );
      for (const id of objectiveIds) {
        const lifecycle = objById.get(id);
        if (!lifecycle) {
          // 同卡卡的时序瞬态：objective 可能尚不可见 → retryable（幂等重试安全）。
          throw new CardGenerationProviderErrorLike(true, `post-activation objective missing (retryable): ${id}`);
        }
        if (lifecycle !== "active") {
          throw new CardGenerationProviderErrorLike(
            true,
            `post-activation objective not active (retryable): ${id} (${lifecycle})`,
          );
        }
      }

      // 4. 台账写入（幂等；personal_projection_writes=0 由表 CHECK 强制）。
      await tx.execute(sql`
        INSERT INTO public.card_generation_post_activation_consumptions
          (workspace_id, run_id, receipt_id, card_ids, objective_ids,
           reconciled_card_count, reconciled_objective_count, personal_projection_writes)
        VALUES (${workspaceId}, ${runId}, ${receiptId},
                ${cardIdsLiteral}::uuid[], ${objectiveIdsLiteral}::uuid[],
                ${cardIds.length}, ${objectiveIds.length}, 0)
        ON CONFLICT (workspace_id, receipt_id) DO NOTHING
      `);
      logger.info(
        { jobId: job.id, runId: job.runId, receiptId, cardCount: cardIds.length, objectiveCount: objectiveIds.length },
        "V2 post-activation projection consumed (idempotent ledger written)",
      );
      await fenceV2OutboxLease(tx, job);
    },
  );
}

async function resolveCardGenerationGovernance(workspaceId: string, runId: string) {
  const ownerRows = await db.execute(sql`
    SELECT user_id FROM public.card_generation_runs_v2
    WHERE id = ${runId} AND workspace_id = ${workspaceId}
    LIMIT 1
  `) as unknown as Array<{ user_id: string }>;
  const userId = ownerRows[0]?.user_id ?? null;
  if (!userId) {
    throw new Error(`card-generation run ${runId} has no owning user; refusing to call an external provider`);
  }
  const { resolveAIGovernanceContext } = await import("../lib/governance.ts");
  return { userId, governance: await resolveAIGovernanceContext(workspaceId, userId) };
}

// 第五轮审计 W#6：reap 节流——每次 poll 都全表扫 reaper 在 V2 空闲（无缓存 job）
// 时是纯浪费查询。仅当距上次 reap >30s 才真正执行，其余 poll 跳过 reap 直接 claim。
const V2_REAP_THROTTLE_MS = 30_000;
let lastV2ReapAt = 0;

/**
 * 主 tick 单次 poll 的 await 预算（round-7 🟡2 修复）。
 *
 * 之前 index.ts `tick()` 对 `pollV2Outbox(1)` 同步 await，最坏被"单个制卡 job 跑完整条
 * 管道"阻塞，延迟**下一 tick**主队列的 claim/分发。修复：主 tick 以本小预算调用 poll，
 * 超时后 poll 立即返回（运行中 job 继续后台跑，靠 heartbeat、30min 租约 + lease CAS +
 * reaper 兜底，不丢副作用、不重复计费），从而使主循环每次 tick 最多阻塞该预算时长即恢复。
 */
export const V2_POLL_TICK_BUDGET_MS = 5_000;

export async function pollV2Outbox(limit = 1, awaitBudgetMs = V2_POLL_TIMEOUT_MS): Promise<number> {
  // 孤儿回收：节流地重置超期 processing 行为 pending，保证崩溃恢复且不浪费
  // 空闲时的扫描查询（V2_REAP_THROTTLE_MS）。reap 失败不阻断 claim。
  // 整体用 runWithAbortTimeout 包裹，使 poll 返回有上界（默认 V2_POLL_TIMEOUT_MS；
  // 主 tick 传更小的 V2_POLL_TICK_BUDGET_MS），防止卡死的外发 HTTP 调用冻结主
  // tick（第四轮审计 #3/#26）。超时后底层任务继续后台运行，靠 heartbeat、30min
  // 租约 + token CAS + reaper 兜底。
  // ── H4（2026-09-15 管线评审提出的那条长事务风险，随四阶段链删除而解除）────────
  // 当时的形状是"整条管道跑在一个事务里、run 行 FOR UPDATE 锁 Held 到最后一个模型
  // 调用返回"，所以一次慢 job 会占住 DB 连接并让同 run 的后续 job 排队等行锁。
  // 简化链是段与段各一个短事务（`card-generation-v3/handler.ts` 文件头那份形状说明），
  // 模型调用发生在两个短事务之间，出口闸（`@ailearn/shared/public-json-http`）还会
  // 直接拒掉"在事务里发公共 HTTP"。这里保留 poll 侧的小预算，是因为**墙钟**这件事
  // 仍然成立：job 该跑多久与主 tick 该多久返回，是两个互不相干的期限。
  // 硬边界照旧：job 墙钟预算（V2_PIPELINE_BUDGET_MS，默认 20min < 30min 租约）到期即
  // abort 并终结 job（不重试）；租约丢失即时 abort（H5）。
  return runWithAbortTimeout(
    async () => {
      const now = Date.now();
      if (now - lastV2ReapAt > V2_REAP_THROTTLE_MS) {
        lastV2ReapAt = now;
        try {
          await reapStaleV2OutboxJobs();
        } catch (error) {
          logger.warn({ error: sanitizeOperationalError(error) }, "V2 outbox reap failed");
        }
      }
      const capacity = V2_OUTBOX_MAX_CONCURRENCY - v2Inflight.size;
      if (capacity <= 0) {
        logger.debug(
          { inflight: v2Inflight.size, maxConcurrency: V2_OUTBOX_MAX_CONCURRENCY },
          "V2 outbox concurrency cap reached",
        );
        return 0;
      }

      const jobs = await claimV2OutboxJobs(Math.min(limit, capacity));
      const running = jobs.map((job) => {
        const promise = processV2OutboxJob(job);
        v2Inflight.set(promise, { jobId: job.id, leaseToken: job.leaseToken });
        promise.then(
          () => v2Inflight.delete(promise),
          (error) => {
            v2Inflight.delete(promise);
            logger.error(
              { jobId: job.id, runId: job.runId, error: sanitizeOperationalError(error) },
              "V2 outbox job rejected unexpectedly",
            );
          },
        );
        return promise;
      });
      // 主 tick 可以因 awaitBudgetMs 超时而提前返回；此处的 promise 仍被
      // v2Inflight 持有，后续 tick 不会越过并发上限继续 claim。
      await Promise.allSettled(running);
      return jobs.length;
    },
    awaitBudgetMs,
    (lateError) => logger.warn(
      { error: sanitizeOperationalError(lateError) },
      "V2 outbox poll hit timeout; background job continues under 30min lease",
    ),
  );
}
