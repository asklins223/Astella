/**
 * OPS-01: Worker Prometheus 指标模块（ADR-0006 §1-3）
 *
 * Worker 侧指标覆盖 Job 队列（depth/terminal/retry/lease lost/duration）、
 * Provider 调用（volume/latency/token，P0-12 新增，此前为零）
 * 和当前 Companion 记忆/摘要任务。
 *
 * 指标命名与 API 侧 lib/metrics.ts 保持一致，使 Prometheus 可以用同一
 * 套告警规则跨进程聚合。
 *
 * 隐私约束（ADR-0006 §4）：
 *   - 永不记录 Note/Source/answer/quote/question 正文
 *   - 永不记录 API Key、lease token 原文
 *   - workspace/user 标识不作为 label
 */

import promClient, {
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics,
} from "prom-client";
import http from "node:http";
import { sharedAiCircuitRejectObserverHealth } from "@ailearn/shared/circuit-breaker";
import {
  COMPANION_SUMMARY_TOTAL_DEF,
  COMPANION_MEMORY_USED_COUNT_DEF,
  COMPANION_MEMORY_RETRIEVAL_MODE_TOTAL_DEF,
} from "@ailearn/shared/metrics-definitions";

// ─── 指标注册器 ──────────────────────────────────────────────────────────

const registry = new promClient.Registry();
collectDefaultMetrics({ register: registry });

// ─── allowlist ───────────────────────────────────────────────────────────

export const JOB_STATUSES = ["pending", "running", "succeeded", "failed", "dead"] as const;

// ─── Job 指标 ───────────────────────────────────────────────────────────

/** Job 队列深度 gauge（按 status 分桶） */
export const jobQueueDepth = new Gauge({
  name: "ailearn_job_queue_depth",
  help: "Number of jobs in queue by status",
  labelNames: ["status"] as const,
  registers: [registry],
});

/** 最老 pending job 的等待秒数 gauge */
export const jobOldestPendingAgeSeconds = new Gauge({
  name: "ailearn_job_oldest_pending_age_seconds",
  help: "Age of the oldest pending job in seconds",
  registers: [registry],
});

/** Job 终态计数器（succeeded/dead） */
export const jobTerminalTotal = new Counter({
  name: "ailearn_job_terminal_total",
  help: "Total jobs that reached a terminal state",
  labelNames: ["type", "status"] as const,
  registers: [registry],
});

/** Job 重试计数器 */
export const jobRetriesTotal = new Counter({
  name: "ailearn_job_retries_total",
  help: "Total job retries by type",
  labelNames: ["type"] as const,
  registers: [registry],
});

/** Job lease 丢失计数器 */
export const jobLeaseLostTotal = new Counter({
  name: "ailearn_job_lease_lost_total",
  help: "Total jobs where the lease was lost or reaped",
  labelNames: ["type"] as const,
  registers: [registry],
});

/** Job 因不可重试错误（欠费/鉴权/配置）直接进入 dead 状态的计数器 */
export const jobNonRetryableDeadTotal = new Counter({
  name: "ailearn_job_non_retryable_dead_total",
  help: "Total jobs marked dead due to non-retryable errors (billing/auth/config)",
  labelNames: ["type"] as const,
  registers: [registry],
});

/** Job 运行时长直方图（秒） */
export const jobDurationSeconds = new Histogram({
  name: "ailearn_job_duration_seconds",
  help: "Job execution duration in seconds by type",
  labelNames: ["type"] as const,
  buckets: [0.5, 1, 2.5, 5, 10, 15, 30, 60, 90, 120],
  registers: [registry],
});

// ─── 方案 22：Companion Memory 可观测性（§9.9）──────────────────────────

/**
 * 桌宠记忆检索模式计数器（vector / keyword_fallback）。
 * 每次 Context Orchestrator 检索后记录。
 */
export const companionMemoryRetrievalModeTotal = new Counter({
  name: COMPANION_MEMORY_RETRIEVAL_MODE_TOTAL_DEF.name,
  help: COMPANION_MEMORY_RETRIEVAL_MODE_TOTAL_DEF.help,
  labelNames: [...COMPANION_MEMORY_RETRIEVAL_MODE_TOTAL_DEF.labelNames],
  registers: [registry],
});

/**
 * 每轮对话实际使用的记忆数量直方图。
 */
export const companionMemoryUsedCount = new Histogram({
  name: COMPANION_MEMORY_USED_COUNT_DEF.name,
  help: COMPANION_MEMORY_USED_COUNT_DEF.help,
  // 桶原样搬自共享定义：改它会改直方图的分位数，属于数据契约而不是措辞
  buckets: [...COMPANION_MEMORY_USED_COUNT_DEF.buckets],
  labelNames: [...COMPANION_MEMORY_USED_COUNT_DEF.labelNames],
  registers: [registry],
});

/**
 * 会话摘要任务结果计数器（success / failed）。
 */
export const companionSummaryTotal = new Counter({
  name: COMPANION_SUMMARY_TOTAL_DEF.name,
  help: COMPANION_SUMMARY_TOTAL_DEF.help,
  labelNames: [...COMPANION_SUMMARY_TOTAL_DEF.labelNames],
  registers: [registry],
});

/**
 * 桌宠日记生成结果计数器。
 *
 * 标签就是 `companion_daily_summaries.failure_reason` 那四个取值加 `generated`：
 * 日记改成由她按人格写之后，"没有日记"有三种成因且只有一种该重试，
 * 光看 jobs.status 分不出"没同意"和"模型挂了"。
 */
export const companionDiaryTotal = new Counter({
  name: "ailearn_companion_diary_total",
  help: "Companion daily diary generation results",
  labelNames: ["result"] as const,
  registers: [registry],
});

/** Provider 指标的读取口：测试与 /metrics 自检都用它，不另开一条聚合路径。 */
export async function providerMetricSnapshot(): Promise<string> {
  return registry.metrics();
}

// ─── Provider 指标（ADR-0006 §2 Provider 维度）───────────────────────────
//
// 此前 worker 侧只有 Job 维度，Provider 维度（模型调用）一个指标都没有：
// 调用量、延迟、超时、schema failure、用户配置错误全都只能在日志里数，
// 而模型调用是这套系统里唯一按次计费、且单次耗时可达数十秒的外部依赖。
//
// 隐私（ADR-0006 §4）：label 只有 provider 实现 id、调用方法与终态枚举，
// **不含** model id、prompt、响应或任何 workspace/user 标识。

/**
 * 一次 provider 调用的方法口径 allowlist —— 与 `AIProvider` 接口上的方法
 * 一一对应（lib/ai-provider.ts）。provider 新增实现方法时这里必须同步加，
 * 否则那个方法的调用不会出现在任何指标里。
 */
export const PROVIDER_CALL_KINDS = ["chat", "stream", "agent_turn", "embed"] as const;

/**
 * provider 调用的终态 allowlist。
 *
 * `schema_failure`（模型没按合同回）与 `config_error`（我们自己没配对）单独成格：
 * 两者的处置完全不同，混进 `error` 就只能靠翻日志分辨——这正是 ADR-0006 §2 把
 * 它们与 provider_4xx/5xx 并列列出的原因。
 */
export const PROVIDER_CALL_OUTCOMES = [
  "success",
  "timeout",
  "cancelled",
  "blocked",
  "schema_failure",
  "config_error",
  "error",
] as const;

export type ProviderCallKind = (typeof PROVIDER_CALL_KINDS)[number];
export type ProviderCallOutcome = (typeof PROVIDER_CALL_OUTCOMES)[number];

/**
 * provider 调用计数器（按 provider × 方法 × 终态）。
 * 调用量与四类失败都由这一条派生（`...{outcome="timeout"}` 等），**不再**另立
 * `provider_timeouts_total` 之类的平行计数器——两份计数器必须同步递增，
 * 只要有一处漏了，告警就会静默少算。
 */
export const providerCallsTotal = new Counter({
  name: "ailearn_provider_calls_total",
  help: "AI provider calls by provider, call kind and terminal outcome",
  labelNames: ["provider", "kind", "outcome"] as const,
  registers: [registry],
});

/**
 * 熔断拒绝次数（按上游 host × 触发原因）。
 *
 * P0-14。**这一条不是为了好看加的**——本项目刚吃过一次"指标存在但从不阻断"
 * 的亏（`coverage-gate.mjs --report-only` 退出码恒为 0，四组关键门禁红了很久
 * 没人看见）。熔断比覆盖率门禁更危险：它会**主动拒绝请求**，所以"它在拒绝"
 * 必须能被告警发现，而不是靠翻日志。
 *
 * reason 两类：
 *   - `open`         熔断已打开，连冷却都没满 → 直接拒
 *   - `half_open`    half-open 里探测已在飞 → 挤掉后来者
 */
export const aiCircuitOpenTotal = new Counter({
  name: "ailearn_ai_circuit_open_total",
  help: "AI upstream calls rejected by the circuit breaker before any network request",
  labelNames: ["host", "reason"] as const,
  registers: [registry],
});

/** Optional circuit metrics observer health; a caught callback error must still alert. */
export const aiCircuitObserverHealthy = new Gauge({
  name: "ailearn_ai_circuit_observer_healthy",
  help: "1 when the optional circuit rejection observer is installed and has no consecutive failures",
  registers: [registry],
  collect() {
    this.set(sharedAiCircuitRejectObserverHealth().healthy ? 1 : 0);
  },
});

export const aiCircuitObserverFailureCount = new Gauge({
  name: "ailearn_ai_circuit_observer_failure_count",
  help: "Process-local lifetime count of isolated circuit observer callback failures",
  registers: [registry],
  collect() {
    this.set(sharedAiCircuitRejectObserverHealth().failuresTotal);
  },
});

export const aiCircuitObserverLastFailureTimestampSeconds = new Gauge({
  name: "ailearn_ai_circuit_observer_last_failure_timestamp_seconds",
  help: "Unix timestamp of the last isolated circuit observer callback failure, or zero",
  registers: [registry],
  collect() {
    const failedAt = sharedAiCircuitRejectObserverHealth().lastFailureAt;
    this.set(failedAt === null ? 0 : failedAt / 1_000);
  },
});

/**
 * provider 调用耗时直方图（秒）。桶上界到 300s：与 handler 共享超时的上限，
 * 超长调用本身就是要看的信号，不该落进 +Inf 桶。
 */
export const providerCallDurationSeconds = new Histogram({
  name: "ailearn_provider_call_duration_seconds",
  help: "AI provider call duration in seconds by provider and call kind",
  labelNames: ["provider", "kind"] as const,
  buckets: [0.5, 1, 2.5, 5, 10, 20, 30, 60, 120, 300],
  registers: [registry],
});

/**
 * provider token 用量计数器（按 provider × 方法 × prompt/completion）。
 *
 * token 成本此前只落在 `ai_audit_log` / `ai_artifacts`（要查库、且只在部分调用
 * 路径上写），`/metrics` 上没有成本视角。**只有返回了 usage 的调用才递增**
 * （`ProviderUsage` 各字段可空），不要用 0 补齐——那会让"没报 usage"和
 * "真的没用 token"在图上长得一样。
 */
export const providerCallTokensTotal = new Counter({
  name: "ailearn_provider_call_tokens_total",
  help: "AI provider tokens by provider, call kind and direction (prompt/completion)",
  labelNames: ["provider", "kind", "direction"] as const,
  registers: [registry],
});

/**
 * 记一次外发调用。**全仓唯一**碰这三个 provider 指标的地方。
 *
 * ## 为什么必须是这一个函数
 *
 * 调用量、耗时、token 是三份不同的量，但它们**描述同一次外发**。若让
 * `createGovernedProvider` 自己分别 inc/observe，任何一个漏掉的分支
 * （抛错的 catch、流式没有 usage、被治理门拦下根本没发出去）都会让三份量
 * 互相矛盾——于是"调用数对得上但 token 对不上"这种问题无法定位。
 * 收口到一个函数之后：**一次外发 = 一次 recordProviderCall**，
 * 三份量要么一起记、要么一起不记。
 *
 * ## token 只在真的有 usage 时记
 *
 * 流式接口的返回类型不带 usage（`AIProvider.chatCompletionStream` 只回
 * `{content, toolCalls?, finishReason?}`）。那种情况 `promptTokens`/`completionTokens`
 * 留空 → 这一次不递增 token 计数器，**不用 0 补齐**：补 0 会让"没报 usage"
 * 和"真的没用 token"在图上长得一样，于是流式成本永远显示为 0 而不是"未知"。
 */
export function recordProviderCall(input: {
  provider: string;
  kind: ProviderCallKind;
  outcome: ProviderCallOutcome;
  /** 这一次外发从开始到结束的墙钟（秒）。被治理门拦下时是接近 0 的值。 */
  durationSeconds: number;
  promptTokens?: number | null;
  completionTokens?: number | null;
}): void {
  providerCallsTotal.inc({
    provider: input.provider,
    kind: input.kind,
    outcome: input.outcome,
  });
  providerCallDurationSeconds.observe(
    { provider: input.provider, kind: input.kind },
    input.durationSeconds,
  );
  const prompt = input.promptTokens;
  const completion = input.completionTokens;
  if (typeof prompt === "number" && Number.isFinite(prompt) && prompt > 0) {
    providerCallTokensTotal.inc({ provider: input.provider, kind: input.kind, direction: "prompt" }, prompt);
  }
  if (typeof completion === "number" && Number.isFinite(completion) && completion > 0) {
    providerCallTokensTotal.inc({ provider: input.provider, kind: input.kind, direction: "completion" }, completion);
  }
}

/**
 * 启动一个轻量 HTTP 服务器暴露 /metrics 端点。
 * Prometheus scraper 通过此端口拉取 Worker 指标。
 *
 * 端口通过 WORKER_METRICS_PORT 环境变量配置，默认 9100。
 */
export function resolveMetricsPort(raw = process.env.WORKER_METRICS_PORT): number {
  if (raw === undefined || raw.trim() === "") return 9_100;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : 9_100;
}

export interface MetricsServerOptions {
  /**
   * 稳定 P1-4（2026-09-15 审计）：worker 健康检查此前只 fetch `/metrics`——那只是
   * Prometheus registry 的序列化，DB 不可达或并发槽漏光时它照样返回 200，编排器
   * 因此永远不会重启 worker，队列静默停摆（与 API 侧 `/ready` 做 schema 探测形成
   * 反差）。传入 readyProbe 后暴露 `/ready` 做真实依赖探测。
   *
   * 未传 readyProbe 时 `/ready` 返回 503（fail-closed）：宁可让没接探测的部署
   * 显式暴露出"未就绪"，也不要出现"没探测 = 健康"的假阳性。
   */
  readyProbe?: () => Promise<void>;
}

export function startMetricsServer(
  port = resolveMetricsPort(),
  options: MetricsServerOptions = {},
): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/metrics") {
      try {
        const metrics = await registry.metrics();
        res.writeHead(200, { "Content-Type": registry.contentType });
        res.end(metrics);
      } catch (err) {
        res.writeHead(500);
        res.end(`# metrics collection failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      return;
    }
    if (req.url === "/ready") {
      const probe = options.readyProbe;
      if (!probe) {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("not ready: ready probe not configured\n");
        return;
      }
      try {
        await probe();
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ready\n");
      } catch (err) {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end(`not ready: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      return;
    }
    res.writeHead(404);
    res.end("Not Found\n");
  });

  // 2026-08-11：监听 'error'——端口占用/地址不可用时异步 error 事件若无监听
  // 会让进程崩溃且无日志（此前 listen 后无人处理 error）。
  server.on("error", (err) => {
    console.error(`[metrics] metrics server error on port ${port}: ${err.message}`);
  });

  server.listen(port, "0.0.0.0");
  return server;
}
