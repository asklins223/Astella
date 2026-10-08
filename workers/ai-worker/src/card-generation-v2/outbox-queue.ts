/**
 * 制卡 V2 outbox 的**队列与租约**内核：认领、续租、租约围栏、完成/失败、回收孤儿，
 * 以及本进程的在途表。（39d W7-7 刀二·内核搬家第二块砖；第一块是 `retry-classification.ts`。）
 *
 * 为什么单独一个文件：这套东西是**两条链共用**的——简化链与旧四阶段链走同一张 outbox、
 * 同一份租约纪律，而旧链的阶段代码此刻还留在 `handlers/card-generation-v2-handler.ts` 里等删。
 * 混在一起时"删旧链"＝在四千行文件里做外科手术；搬开之后就是一次整文件删除。
 *
 * 两条纪律原样跟着搬，不顺手改：
 * - 租约健康看 `lease_expires_at − started_at` 是否封顶，续租是算术不是心跳；
 * - 完成/失败一律带 `lease_token` 的 CAS——租约被 reaper 收走后迟到的结果必须静默忽略。
 *
 * `pollV2Outbox` 与 `processV2OutboxJob` **故意留**在旧 handler：前者要调后者的分发，
 * 跟过来就成 `handler → queue → handler` 的循环 import。它们只通过这里导出的
 * `v2Inflight` 操作在途表（唯一的另一个写者）。
 */

import { sql, type SQL } from "drizzle-orm";
import { db } from "../db.ts";
import { logger } from "../lib/logger.ts";

/** 错误文本落库/落日志前的统一脱敏与截断（两条链与 worker 入口共用）。 */
export function sanitizeOperationalError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 1000);
  if (typeof error === "string") return error.slice(0, 1000);
  try {
    return JSON.stringify(error).slice(0, 1000);
  } catch {
    return String(error).slice(0, 1000);
  }
}

export interface PendingOutboxJob {
  id: string;
  workspaceId: string;
  runId: string;
  jobType: string;
  payload: Record<string, unknown>;
  /**
   * 认领时写入的不可变租约令牌（migration 新增列 lease_token），
   * complete/fail 用它做 status+lease 门闩，防止租约过期后迟到的完成/失败
   * 覆盖他人已提交的结果（仿 0121 learning-run outbox 的 owner CAS 范式）。
   */
  leaseToken: string;
}

/**
 * V2 outbox 租约时长（30 分钟）。
 *
 * 仍保留 30 分钟的宽窗口作为启动/连接故障的兜底，同时 processV2OutboxJob
 * 会在管道执行期间周期续租。这样慢速但正常的 planner→author→grounding→pedagogy
 * 不会被 reaper 误回收，worker 真正失联时仍可由 lease 过期触发回收。
 * 120s 一次性租约在没有 heartbeat 时会在正常 job 跑完前过期，reaper 会把它
 * 误回收并发重跑整管道；因此这里采用“长窗口 + heartbeat + token CAS”的组合。
 * lease_expires_at 的真实用途是回收「崩溃/失联 worker 的孤儿 job」，而非惩罚
 * 仍在合法执行的长任务；token CAS 防止过期后迟到的结果覆盖新 owner。
 * 代价是 heartbeat 不可用时崩溃后的孤儿最长需 30min 才能被 reaper 回收；正常
 * 路径则会持续续租。
 *
 * 2026-09-15（评审 M1）：租约窗口不再被当作"job 最长时长"的同义词——阶段级护栏
 * 由 `V2_PIPELINE_BUDGET_MS`（默认 60min，执行中续租）承担：预算到期会
 * abort 在途 LLM 调用并把 job 终结为 failed（不重试），合法长任务由心跳保持租约。
 */
export const V2_OUTBOX_LEASE_TIMEOUT_MS = 30 * 60_000;

/**
 * 单个 V2 job 的**墙钟预算**（阶段级护栏，评审 M1）。
 *
 * 20 卡上限时理论最坏 ≈ planner 1 + author ≤20 + grounding ≤20 + pedagogy 1 +
 * bounded repair ≤20 ≈ 62 次调用 × 单调用 75s ≈ 77min，远超 30min 租约窗口；
 * 此前没有任何阶段级预算，只能靠租约心跳兜底（心跳依赖 DB 可用，DB 故障时
 * 租约静默流失）。本预算在到期时 abort 整个 job 的 LLM 调用并把 job 直接终结
 * 为 failed（**不重试**——重试会把同样的钱再花一遍），run 落 needs_attention
 * 并带可解释原因。
 *
 * 默认 60min：给多阶段生成与推理留出空间，租约由已有心跳持续续期。
 * 可经 V2_PIPELINE_BUDGET_MS 覆盖。
 */
export const V2_PIPELINE_BUDGET_MS = (() => {
  const raw = Number(process.env.V2_PIPELINE_BUDGET_MS ?? 60 * 60_000);
  if (Number.isFinite(raw) && raw > 0) return raw;
  logger.warn(
    { raw: process.env.V2_PIPELINE_BUDGET_MS },
    "V2_PIPELINE_BUDGET_MS 非法，回退 60min",
  );
  return 60 * 60_000;
})();

/**
 * 租约续租（= 租约丢失探测）间隔。
 *
 * H5（2026-09-15 评审）：此前为 `lease/3 = 10min`——租约一旦被 reaper 回收，
 * 最坏 10min 后才发现，期间每个在途/后续 LLM 调用都是纯损失（单调用最长 75s）。
 * 收紧到 2min（仍远小于 30min 租约，留足抖动余量），把"租约已丢但仍在烧钱"
 * 的窗口从分钟级降到 2min。每次续租只是一条 `UPDATE ... WHERE id AND lease_token`
 * （走主键），开销可忽略。
 */
export const V2_LEASE_RENEWAL_INTERVAL_MS = (() => {
  const raw = Number(process.env.V2_LEASE_RENEWAL_INTERVAL_MS ?? 120_000);
  if (Number.isFinite(raw) && raw >= 5_000 && raw < V2_OUTBOX_LEASE_TIMEOUT_MS) return raw;
  return 120_000;
})();

/**
 * V2 outbox 的进程内并发上限。
 *
 * poll 是被主 worker tick 周期调用的；单次 poll 超时后，已经认领的管道仍会
 * 在后台继续执行。因此只限制单次 claim 不够，必须把仍在运行的管道纳入全局
 * inflight 计数，否则每个 tick 都能再认领一批，最终打满 DB/provider 连接池。
 */
export const V2_OUTBOX_MAX_CONCURRENCY = (() => {
  const raw = Number(process.env.V2_OUTBOX_MAX_CONCURRENCY ?? 4);
  if (Number.isInteger(raw) && raw > 0 && raw <= 64) return raw;
  logger.warn(
    { raw: process.env.V2_OUTBOX_MAX_CONCURRENCY },
    "V2_OUTBOX_MAX_CONCURRENCY 非法，回退 4",
  );
  return 4;
})();

/**
 * 本进程在途的 V2 job：promise → 它认领时拿到的租约凭据。
 * 记凭据是为了关停时能把租约**交还**（`releaseInflightV2OutboxLeases`）；
 * 只记 promise 的话，强杀之后只能等 30 分钟租约自然过期。
 */
export const v2Inflight = new Map<Promise<void>, { jobId: string; leaseToken: string }>();

/** 本进程在途 V2 job 数。 */
export function getV2OutboxInflightCount(): number {
  return v2Inflight.size;
}

/** 等待当前 worker 已认领的 V2 管道结束；返回是否在 deadline 内排空。 */
export async function waitForV2OutboxDrain(timeoutMs: number): Promise<boolean> {
  if (v2Inflight.size === 0) return true;

  const pending = Promise.allSettled([...v2Inflight.keys()]).then(() => true);
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * V2 poll 的总超时上界（对齐租约窗口）。
 *
 * pollV2Outbox 被 worker 主 tick 调用（index.ts tick()），而 V2 管道是分钟级
 * 多轮 LLM 调用。`CardGenerationProviderRuntime.chatJson` 会把 AbortSignal 透传给
 * `provider.chatCompletion`：调用方传入的外部 signal，或单调用预算
 * `V2_PROVIDER_CALL_TIMEOUT_MS`（默认 75s，AbortSignal.timeout）任一中止信号都会
 * 真中止底层 HTTP 调用（第五轮审计 W#4 修复：不再是「不传 signal、靠外层挂起」）。
 * 故此常量不再用于为单个卡死 LLM 调用兜底，而是给整次 poll 一个总量上界：
 * - 与租约窗口一致：poll 永不超出「单 job 的最坏合法时长」，语义上 poll 的生命
 *   期被限制在释放前必须能完成/失败该 job 的窗口内；
 * - 超时后 poll 立即返回（tick 继续），底层任务继续后台运行——因租约 30min 未过期，
 *   后台任务仍可带 lease CAS 完成/失败该 job，reaper 不会误回收，不丢副作用；
 *   仅「主循环继续推进」与「阻塞等待该 job」解耦。
 */
export const V2_POLL_TIMEOUT_MS = V2_OUTBOX_LEASE_TIMEOUT_MS;

/**
 * Claim pending V2 outbox jobs。
 * 使用 `FOR UPDATE SKIP LOCKED` 实现并发安全的 claim；认领即写入租约
 * （started_at / lease_token / lease_expires_at），供 complete/fail 门闩及
 * reaper 回收孤儿使用。
 *
 * 依赖迁移：新增列 started_at timestamptz、lease_token uuid、lease_expires_at timestamptz。
 *
 * round-8 🟡5（保持现状 + 说明）：本 claim 可能在 poll 的 5s awaitBudgetMs 边界被 abort。
 * abort 只让 pollV2Outbox 返回（Promise.race 拒绝），不会取消本函数内部 db.execute；
 * 已认领改行若已提交（status=processing + lease_token），其所属 `processV2OutboxJob`
 * 由 abortable 内的**同一后台连续体**继续执行（processV2OutboxJob 不接收 poll signal），
 * 因此正常情况下不会出现"认领后无主"。仅当整个 worker 恰好在这条缝隙整体退出时，
 * 该行才保持 processing 等待 reaper（30min lease 过期后回收，lease_token CAS 兜底，
 * 不丢数据、不重复计费）。最小正确方案：不改 claim 逻辑，靠连续体 + reaper 双兜底。
 */
export async function claimV2OutboxJobs(limit = 1): Promise<PendingOutboxJob[]> {
  const rows = await db.execute(sql`
    UPDATE public.card_generation_run_outbox_v2
    SET status = 'processing', processed_at = now(),
        started_at = now(),
        lease_token = gen_random_uuid(),
        lease_expires_at = now() + make_interval(secs => ${V2_OUTBOX_LEASE_TIMEOUT_MS / 1000}),
        next_attempt_at = NULL
    WHERE id IN (
      SELECT id FROM public.card_generation_run_outbox_v2
      WHERE status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY created_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, workspace_id, run_id, job_type, payload, lease_token
  `);
  return rows.map((r) => ({
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    runId: String(r.run_id),
    jobType: String(r.job_type),
    payload: r.payload as Record<string, unknown>,
    leaseToken: String(r.lease_token),
  }));
}

/**
 * 续租 V2 outbox job。返回 false 表示租约已被 reaper/其他 worker 接管；调用方
 * 必须停止提交结果，不能把迟到的完成或失败写回他人的 lease。
 */
export async function renewV2OutboxLease(jobId: string, leaseToken: string): Promise<boolean> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE public.card_generation_run_outbox_v2
    SET lease_expires_at = now() + make_interval(secs => ${V2_OUTBOX_LEASE_TIMEOUT_MS / 1000})
    WHERE id = ${jobId} AND status = 'processing' AND lease_token = ${leaseToken}
      AND lease_expires_at > now()
    RETURNING id
  `);
  return rows.length > 0;
}

/**
 * 只需要「能执行一条 SQL」的句柄。租约判定被两处共用——管道里的收尾围栏，以及
 * Agent 父预算记账前那次核验——后者拿到的是 agent 那段受限事务的 executor，
 * 把它当整条 `WorkerTransaction` 收下会逼调用方去断言一个它并不拥有的形状。
 */
export interface OutboxLeaseTx {
  execute(query: SQL): Promise<unknown>;
}

/**
 * 在**调用方这一段事务里**核实并续租 outbox，返回租约是否还在。
 *
 * 单独的具名函数（而不是只留 `fenceV2OutboxLease`）是因为 Agent 记账那一格需要在
 * 「核实租约」与「给父目标加钱」之间保持同一段事务：先提交记账、再在外面查租约，
 * 会把一次已知失去租约的调用记成新的付费请求。
 */
export async function renewV2OutboxLeaseInTransaction(
  tx: OutboxLeaseTx, job: PendingOutboxJob,
): Promise<boolean> {
  const rows = await tx.execute(sql`
    UPDATE public.card_generation_run_outbox_v2
    SET lease_expires_at = now() + make_interval(secs => ${V2_OUTBOX_LEASE_TIMEOUT_MS / 1000})
    WHERE id = ${job.id} AND status = 'processing' AND lease_token = ${job.leaseToken}
      AND lease_expires_at > now()
    RETURNING id
  `);
  if (!Array.isArray(rows)) throw new Error("Unexpected outbox lease result");
  return rows.length > 0;
}

/**
 * Fence a V2 pipeline at the transaction boundary.  The lease update is part
 * of the same transaction as the pipeline writes, so a reaper that won the
 * token CAS makes the whole transaction roll back instead of leaving a late
 * candidate/run mutation behind.
 */
export async function fenceV2OutboxLease(tx: OutboxLeaseTx, job: PendingOutboxJob): Promise<void> {
  if (!await renewV2OutboxLeaseInTransaction(tx, job)) {
    throw new Error("V2 outbox lease lost before transaction commit");
  }
}

/**
 * 交还本进程持有的**一条** V2 租约：清空 token 并把过期时间推到当下。
 *
 * 为什么不直接改回 pending：`reapStaleV2OutboxJobs` 已经是"过期租约 → attempts+1 +
 * 退避 + 重投"的唯一实现，另起一条接管路径会让两处语义漂移；这里只是把它的前提
 * （`lease_expires_at < now()`）提前造成。
 *
 * 为什么连 `lease_token` 一起清空：本进程此刻可能还有在途 LLM 调用与一个未提交的
 * 大事务。token 一空，它的 `fenceV2OutboxLease` 当场失败（整个事务回滚），迟到的
 * complete/fail 也过不了 token CAS（0 行）——防双付的语义照旧成立，只是不再挂满
 * 30 分钟。
 */
export async function releaseV2OutboxLease(jobId: string, leaseToken: string): Promise<boolean> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE public.card_generation_run_outbox_v2
    SET lease_token = NULL, lease_expires_at = now()
    WHERE id = ${jobId} AND status = 'processing' AND lease_token = ${leaseToken}
    RETURNING id
  `);
  return rows.length > 0;
}

/**
 * 关停前交还所有在途租约（由 `index.ts` 的 drain 分支调用）。
 *
 * dev 里 tsx watch 只给 5 秒（日志原话：`Process didn't exit in 5s. Force killing...`），
 * 而一条付费管道要跑几分钟。不在这一刻交还，进程被强杀后这条 run 的租约会一直挂到
 * 自然过期（30 分钟）：其间那篇笔记被 in-flight 守卫锁住（再点生成只吃 409），
 * 已经花掉的钱也白付。返回交还条数，仅用于日志。
 */
export async function releaseInflightV2OutboxLeases(): Promise<number> {
  let released = 0;
  for (const { jobId, leaseToken } of v2Inflight.values()) {
    try {
      if (await releaseV2OutboxLease(jobId, leaseToken)) released += 1;
    } catch (error) {
      logger.warn(
        { jobId, error: sanitizeOperationalError(error) },
        "V2 outbox lease release failed",
      );
    }
  }
  return released;
}

/**
 * Mark outbox job as completed（status + lease 门闩）。
 * 仅当该行确系本次认领的 lease_token 且仍处于 processing 时才更新；否则
 * 表示租约已被 reaper 回收或移交给他人，迟到完成必须静默忽略。
 */
export async function completeV2OutboxJob(jobId: string, leaseToken: string): Promise<void> {
  await db.execute(sql`
    UPDATE public.card_generation_run_outbox_v2
    SET status = 'completed', processed_at = now(),
        started_at = NULL, lease_token = NULL, lease_expires_at = NULL
    WHERE id = ${jobId} AND status = 'processing' AND lease_token = ${leaseToken}
      AND lease_expires_at > now()
  `);
}

/**
 * Mark outbox job as failed and increment attempts（status + lease 门闩）。
 *
 * §17.1 重试分类：
 * - retryable（provider/网络 5xx/429/408/超时）→ 保留 pending，attempts < 6 重试；
 * - non-retryable（schema/协议错误）→ 直接 failed。
 * 门闩条件与 complete 相同：仅当 lease_token 匹配且仍 processing 时生效。
 *
 * 2026-08-16（实机验证修复）：outbox 终态 failed 时同步把 run 置为
 * `needs_attention` 并写 error（此前 run 永远卡 planning，用户端只见
 * "生成中"永不结束）。retryable 重试中不动 run（仍 planning/processing）。
 *
 * 2026-08-25（AI 设计审计修复）：retryable 分支原先的第二条 run UPDATE 在
 * CASE 里引用了 runs 表上不存在的 `attempts` 列（该列只在 outbox 表），
 * PostgreSQL 解析期必抛 42703——run 回写是死代码且每次可重试失败都污染
 * poll 日志。现改为第一条 UPDATE `RETURNING status`，以 outbox 行的实际
 * 终态决定是否同步 run：status='failed'（重试耗尽或达上限）才置
 * needs_attention，语义与非重试分支及文档声明完全一致。
 */
export async function failV2OutboxJob(
  jobId: string,
  leaseToken: string,
  error: string,
  retryable = true,
): Promise<void> {
  if (!retryable) {
    // Outbox 终态与 run 的 needs_attention 必须在同一 SQL 语句内完成。
    // 若先成功释放 outbox lease、再单独 UPDATE run，第二步失败会留下
    // “outbox=failed、run=planning/processing”的永久悬挂状态。
    await db.execute(sql`
      WITH updated AS (
        UPDATE public.card_generation_run_outbox_v2
        SET status = 'failed', attempts = attempts + 1, last_error = ${error},
            started_at = NULL, lease_token = NULL, lease_expires_at = NULL
        WHERE id = ${jobId} AND status = 'processing' AND lease_token = ${leaseToken}
          AND lease_expires_at > now()
        RETURNING id, run_id, workspace_id
      )
      UPDATE public.card_generation_runs_v2 AS run
      SET status = 'needs_attention', error_code = 'generation_failed', error_message = ${error},
          updated_at = now()
      FROM updated
      WHERE updated.run_id = run.id
        AND updated.workspace_id = run.workspace_id
        AND run.status NOT IN ('review_ready', 'no_cards_recommended', 'activating', 'activated',
                               'closed_without_activation', 'failed', 'cancelled', 'stale')
    `);
    return;
  }
  // 与 reaper 保持同一语义：本次失败后 attempts + 1 达到 6 就终止，
  // 不再让正常失败路径比崩溃回收路径多重试一次。
  //
  // 2026-09-15（管线评审 H1）：retryable 分支此前**无退避**——status 直接回
  // pending，下一个 poll 立即重新认领并重放整条已付费的 LLM 管道（planner→
  // author→grounding→pedagogy），429/5xx 时形成重试风暴。现在写入指数退避的
  // 下次可认领时间：attempts=0..4 → 15s/30s/60s/120s/240s（封顶 300s）。
  // 退避只改变排队时机，不改变 attempts 上限与 fail-closed 语义。
  await db.execute(sql`
    WITH updated AS (
      UPDATE public.card_generation_run_outbox_v2
      SET status = CASE
        WHEN attempts + 1 >= 6 THEN 'failed'
        ELSE 'pending'
      END,
      attempts = attempts + 1,
      next_attempt_at = CASE
        WHEN attempts + 1 >= 6 THEN NULL
        ELSE now() + make_interval(secs => LEAST(300, 15 * power(2, attempts))::int)
      END,
      last_error = ${error},
      started_at = NULL, lease_token = NULL, lease_expires_at = NULL
      WHERE id = ${jobId} AND status = 'processing' AND lease_token = ${leaseToken}
        AND lease_expires_at > now()
      RETURNING status, run_id, workspace_id
    )
    UPDATE public.card_generation_runs_v2 AS run
    SET status = 'needs_attention', error_code = 'generation_failed', error_message = ${error},
        updated_at = now()
    FROM updated
    WHERE updated.status = 'failed'
      AND updated.run_id = run.id
      AND updated.workspace_id = run.workspace_id
      AND run.status NOT IN ('review_ready', 'no_cards_recommended', 'activating', 'activated',
                             'closed_without_activation', 'failed', 'cancelled', 'stale')
  `);
}

/**
 * Reap stale processing outbox jobs（孤儿回收）。
 * worker 崩溃/网络分区时 leasing job 永卡 processing，此函数把超期未更新的
 * processing 行收回复投。按 `lease_expires_at < now()` 判定过期（单窗口，租约
 * 到期即回收，与 claim 写入的 30min 租约及主队列 started_at 单窗口语义一致，
 * 修复第三轮 W#2 的"双重减去"）。
 *
 * 回收语义对齐主队列 0105 `astella_reap_stale_jobs`（修复第三轮 W#1）：每次
 * 回收都 `attempts = attempts + 1`；回收后即达重试上限（attempts + 1 >= 6）的行
 * 转 `failed`（不再无限重投，崩溃路径也计入重试上限）；否则重置回 `pending`
 * 并清空租约三列（started_at / lease_token / lease_expires_at），供重新认领。
 *
 * 子查询含 `FOR UPDATE SKIP LOCKED`（对齐主队列 0105 reaper，第四轮审计 #4）：防
 * 多 worker 实例并发 reap 同一批超期行——已被本实例锁定排队待回收的行会被跳过，
 * 避免外 UPDATE 相互阻塞甚至重复回收同一行（并行 UPDATE 到同一 id 会因锁等待而
 * 串行化，且一个实例已 SET 租约清空、另一实例再命中时范围已变）。
 *
 * 返回被回收（重置/转失败）的行数。
 */
export async function reapStaleV2OutboxJobs(limit = 100): Promise<number> {
  const rows = await db.execute<{
    id: string;
    run_id: string;
    workspace_id: string;
    status: string;
  }>(sql`
    WITH reaped AS (
      UPDATE public.card_generation_run_outbox_v2
      SET status = CASE
          WHEN attempts + 1 >= 6 THEN 'failed'
          ELSE 'pending'
        END,
          attempts = attempts + 1,
          -- H1（2026-09-15）：回收重投同样退避，避免崩溃恢复时多个孤儿 job
          -- 在同一个 tick 被立即重领并同时重放整条 LLM 管道。
          next_attempt_at = CASE
            WHEN attempts + 1 >= 6 THEN NULL
            ELSE now() + make_interval(secs => LEAST(300, 15 * power(2, attempts))::int)
          END,
          started_at = NULL, lease_token = NULL, lease_expires_at = NULL,
          processed_at = NULL
      WHERE id IN (
        SELECT id FROM public.card_generation_run_outbox_v2
        WHERE status = 'processing'
          AND lease_expires_at < now()
        ORDER BY created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, run_id, workspace_id, status
    ), marked AS (
      UPDATE public.card_generation_runs_v2 AS run
      SET status = 'needs_attention', error_code = 'generation_failed',
          error_message = 'V2 outbox lease expired', updated_at = now()
      FROM reaped
      WHERE reaped.status = 'failed'
        AND reaped.run_id = run.id
        AND reaped.workspace_id = run.workspace_id
        AND run.status NOT IN ('review_ready', 'no_cards_recommended', 'activating', 'activated',
                               'closed_without_activation', 'failed', 'cancelled', 'stale')
    )
    SELECT id, run_id, workspace_id, status FROM reaped
  `);
  return rows.length;
}
