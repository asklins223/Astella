/**
 * OPS-01: Prometheus 指标模块（ADR-0006 §1-3）
 *
 * 暴露 Prometheus-compatible 指标，供 SLO 计算和告警使用。
 * 所有 label 必须为低基数 allowlist，禁止自由文本。
 *
 * 指标分类（对应 ADR-0006 §2 与 v0.5 计划 §6.6 Must 指标集）：
 *   - HTTP：请求量、成功率、p95 延迟、5xx 数、readiness
 *   - Job：queue depth、oldest pending、wait/runtime、retry/dead、lease lost/reap
 *   - Provider：调用量、延迟、超时、schema failure、用户配置错误
 *   - Database：迁移版本、连接池状态、事务失败、RLS 拒绝
 *   - Funnel：邀请发出/消费、onboarding 完成、生成卡、提交验证、完成复习
 *   - Release：版本、commit、migration、镜像 digest
 *
 * 隐私约束（ADR-0006 §4）：
 *   - 永不记录 Note/Source/answer/quote/question 正文
 *   - 永不记录 API Key、Cookie、CSRF、Authorization、完整 URL query
 *   - 永不记录 Provider 原始请求/响应
 *   - lease token 只记录不可复用的短 fingerprint
 *   - workspace/user 标识使用 HMAC 后的不可逆标识
 */

import promClient, {
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics,
} from "prom-client";

// ─── 指标注册器 ──────────────────────────────────────────────────────────

/**
 * 独立的 Registry 实例，避免与全局默认注册器冲突。
 * 只暴露显式定义的指标，不自动收集 Node.js 运行时指标。
 */
export const registry = new promClient.Registry();

// 收集 Node.js 默认指标（process_cpu、process_memory、gc 等），
// 用于容量和性能分析，但不包含业务 label。
collectDefaultMetrics({ register: registry });

// ─── 常量与 allowlist ────────────────────────────────────────────────────

/**
 * HTTP route template allowlist。
 * 只记录路由模板（如 GET /notes/:id），不记录实际路径参数，
 * 避免高基数和路径参数泄漏。
 */
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * HTTP status class allowlist（2xx/3xx/4xx/5xx）。
 * 只记录状态类，不记录精确状态码，降低基数。
 */
export const HTTP_STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx"] as const;

/**
 * Job type allowlist — 对应 HANDLERS 注册表。
 * BUG-74/QUAL-60/QUAL-72 修复：从 JobType 枚举派生，避免硬编码与 schema 不同步。
 */
import { JobType as _JobType } from "@ailearn/shared";
export const JOB_TYPES = Object.values(_JobType) as readonly string[];

/**
 * Job status allowlist。
 */
export const JOB_STATUSES = ["pending", "running", "succeeded", "failed", "dead"] as const;

/**
 * 错误分类 allowlist — 自由文本错误必须先归类。
 */
export const ERROR_CATEGORIES = [
  "timeout",
  "schema_failure",
  "provider_5xx",
  "provider_4xx",
  "auth_error",
  "quota_exceeded",
  "network_error",
  "rls_denied",
  "validation_error",
  "unknown",
] as const;

/**
 * Funnel 事件 allowlist（ADR-0006 §2）。
 */
export const FUNNEL_EVENTS = [
  "invite_created",
  "invite_consumed",
  "invite_revoked",
  "onboarding_step",
  "onboarding_completed",
  "card_generation_terminal",
  "job_claimed",
  "job_retried",
  "job_dead",
  "job_lease_lost",
  "provider_call_terminal",
  "backup_terminal",
  "release_deployed",
  "release_rolled_back",
] as const;

// ─── HTTP 指标 ──────────────────────────────────────────────────────────

/** HTTP 请求总量计数器 */
export const httpRequestsTotal = new Counter({
  name: "ailearn_http_requests_total",
  help: "Total HTTP requests by method, route template, and status class",
  labelNames: ["method", "route", "status_class"] as const,
  registers: [registry],
});

/** HTTP 请求延迟直方图（秒）— 用于 p95 计算 */
export const httpRequestDurationSeconds = new Histogram({
  name: "ailearn_http_request_duration_seconds",
  help: "HTTP request duration in seconds by method and route template",
  labelNames: ["method", "route"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

/** HTTP 5xx 错误计数器 */
export const httpErrors5xxTotal = new Counter({
  name: "ailearn_http_errors_5xx_total",
  help: "Total HTTP 5xx responses by method and route template",
  labelNames: ["method", "route"] as const,
  registers: [registry],
});

/** Readiness 状态 gauge（1=ready, 0=not ready） */
export const readinessStatus = new Gauge({
  name: "ailearn_readiness_status",
  help: "API readiness status (1=ready, 0=not ready)",
  registers: [registry],
});

// ─── Job/Provider 指标 ──────────────────────────────────────────────────
// Job/Provider 维度指标在 API 进程内无生产写点，由 workers/ai-worker 侧
// 维护同义指标（队列深度/终态/重试/租约丢失/时长、调用量/延迟/错误）。
// 不在 API registry 注册以避免死指标。
//
// 例外是 learning_run_processing_* 那一组：那条 outbox 由 **API 进程自己**轮询
// （见 run-processing-tick.ts 模块头），worker 侧根本没有同一条消费链，所以
// 必须留在 API registry——下面那一节的注释把这个差别写清楚了，别再搬走。

// ─── P0-12（2026-09-29 审计）：LearningRun 结算链路 + 维护任务 ─────────────
//
// 审计原话：「`/metrics` 端点上没有任何字段能回答"现在有没有 run 卡在 assessing"」。
// 补这一组之前，唯一与学习链路有关的数字是 §20 落库的 learning_metric_events，
// 而那要查库才看得到；outbox 深度、tick 耗时、Critic 判分与 fail-closed 率全部为 0。
//
// 隐私（ADR-0006 §4）：这一组**没有**任何 run/workspace/user 维度 label —— 定位
// 单个 run 是日志（logger）的职责（已带 runId/workspaceId），指标只回答"量级与形状"。

/**
 * learning_run_processing_outbox 的 command_type allowlist。
 *
 * 从 db-schema 派生而不是硬编码，与上面 JOB_TYPES 同一个理由：枚举加了命令而
 * allowlist 没跟上，标签就会静默分裂成两格。
 */
import { LearningRunProcessingCommand as _LearningRunProcessingCommand } from "@ailearn/shared/db-schema/learning-runs";
import {
  COMPANION_SUMMARY_TOTAL_DEF,
  COMPANION_MEMORY_USED_COUNT_DEF,
  COMPANION_MEMORY_RETRIEVAL_MODE_TOTAL_DEF,
} from "@ailearn/shared/metrics-definitions";
export const LEARNING_RUN_PROCESSING_COMMAND_TYPES = Object.values(
  _LearningRunProcessingCommand,
) as readonly string[];

/** 单条 outbox 命令被 tick 处理后的终态 allowlist。 */
export const LEARNING_RUN_PROCESSING_OUTCOMES = ["processed", "failed"] as const;

/** Critic（模型判分）一次调用的终态 allowlist。 */
export const LEARNING_RUN_CRITIC_OUTCOMES = ["completed", "fail_closed", "error"] as const;

/**
 * Critic fail-closed 的原因码 allowlist。
 *
 * 与 `run-processing-tick.ts` 的 `CheckpointReasonCode` 同集合，也与
 * `LearningRunPublicV1["checkpoint"]["reasonCode"]` 同集合。埋点处直接用该文件的
 * `classifyFailClosedReason()` 返回值，不要自己重新判一遍。
 */
export const LEARNING_RUN_CRITIC_FAIL_CLOSED_REASONS = [
  "no_frozen_evidence",
  "critic_unavailable",
  "input_incomplete",
] as const;

/**
 * 维护类任务处理对象 allowlist：Companion TTL 六类 + 笔记软删物理清除 + session 过期。
 * 每一项都对应 `runLearningTtlMaintenance()` / `purgeSoftDeletedNotes()` /
 * `cleanupExpiredSessions()` 的一条返回计数。
 */
export const MAINTENANCE_TARGETS = [
  "companion_audit",
  "invitation_ledger",
  "stream_events",
  "voice_artifacts",
  "ai_audit_log",
  "proactive_deliveries",
  "soft_deleted_notes",
  "expired_sessions",
] as const;

/**
 * outbox 未处理行数（processed_at IS NULL）gauge，按 command_type 分格。
 * `assessment_requested` 堆积 = 大量 run 卡在 assessing；`commit_requested` 堆积
 * = 评估已出但 canonical 结算没落地——两者的处置完全不同，所以必须分格。
 */
export const learningRunProcessingOutboxDepth = new Gauge({
  name: "ailearn_learning_run_processing_outbox_depth",
  help: "Unprocessed rows in learning_run_processing_outbox by command type",
  labelNames: ["command_type"] as const,
  registers: [registry],
});

/**
 * 最老未处理 outbox 行的等待秒数 gauge。
 *
 * 与 depth 成对（与 worker 侧 jobQueueDepth / jobOldestPendingAgeSeconds 同形）：
 * depth=1 既可能是"刚提交"，也可能是"卡了一小时"，只有这一条能把这两种分开——
 * 告警必须建在它上面而不是 depth 上。
 */
export const learningRunProcessingOutboxOldestPendingAgeSeconds = new Gauge({
  name: "ailearn_learning_run_processing_outbox_oldest_pending_age_seconds",
  help: "Age of the oldest unprocessed learning_run_processing_outbox row by command type",
  labelNames: ["command_type"] as const,
  registers: [registry],
});

/**
 * 单次 tick 处理耗时直方图（秒）。
 * 桶上界到 60s：批内是严格串行的，一条 Critic HTTP（数十秒）就把这一轮拉长。
 */
export const learningRunProcessingTickDurationSeconds = new Histogram({
  name: "ailearn_learning_run_processing_tick_duration_seconds",
  help: "runLearningRunProcessingTick duration in seconds",
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [registry],
});

/** tick 处理命令条数计数器（command_type × 终态）。 */
export const learningRunProcessingCommandsTotal = new Counter({
  name: "ailearn_learning_run_processing_commands_total",
  help: "Learning run processing commands handled by command type and outcome",
  labelNames: ["command_type", "outcome"] as const,
  registers: [registry],
});

/**
 * Critic 调用次数计数器（终态口径）。
 * fail-closed 率 = `rate(...{outcome="fail_closed"}[5m]) / rate(...[5m])`。
 */
export const learningRunCriticCallsTotal = new Counter({
  name: "ailearn_learning_run_critic_calls_total",
  help: "Learning run critic (model scoring) calls by terminal outcome",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

/** Critic 调用耗时直方图（秒）——含 provider 网络时间，是判"模型慢"与"我们慢"的唯一依据。 */
export const learningRunCriticDurationSeconds = new Histogram({
  name: "ailearn_learning_run_critic_duration_seconds",
  help: "Learning run critic call duration in seconds by outcome",
  labelNames: ["outcome"] as const,
  buckets: [1, 2.5, 5, 10, 20, 30, 60, 120],
  registers: [registry],
});

/** Critic fail-closed 次数（按原因码）——fail-closed 的分子，并回答"是哪一类卡住"。 */
export const learningRunCriticFailClosedTotal = new Counter({
  name: "ailearn_learning_run_critic_fail_closed_total",
  help: "Learning run critic fail-closed settlements by reason code",
  labelNames: ["reason_code"] as const,
  registers: [registry],
});

/** 维护类任务处理行数（TTL 清理/墓碑化、笔记软删物理清除、session 过期删除）。 */
export const maintenanceRowsPurgedTotal = new Counter({
  name: "ailearn_maintenance_rows_purged_total",
  help: "Rows purged or tombstoned by maintenance task (companion TTL, soft-deleted notes, expired sessions)",
  labelNames: ["kind"] as const,
  registers: [registry],
});

// ─── Database 指标 ──────────────────────────────────────────────────────

/** 数据库迁移版本 gauge */
export const dbMigrationVersion = new Gauge({
  name: "ailearn_db_migration_version",
  help: "Latest applied database migration version",
  registers: [registry],
});

/** 数据库连接池活跃连接数 gauge */
export const dbPoolActiveConnections = new Gauge({
  name: "ailearn_db_pool_active_connections",
  help: "Active database connections in the pool",
  registers: [registry],
});

/** 数据库事务失败计数器 */
export const dbTransactionFailuresTotal = new Counter({
  name: "ailearn_db_transaction_failures_total",
  help: "Total database transaction failures",
  registers: [registry],
});

/** RLS 拒绝计数器 */
export const dbRlsDeniedTotal = new Counter({
  name: "ailearn_db_rls_denied_total",
  help: "Total RLS policy denials",
  registers: [registry],
});

// ─── Funnel 指标（ADR-0006 §2）──────────────────────────────────────────

/** Alpha 漏斗事件计数器 */
export const funnelEventsTotal = new Counter({
  name: "ailearn_funnel_events_total",
  help: "Alpha funnel events by event type",
  labelNames: ["event"] as const,
  registers: [registry],
});

// ─── RL-09/RL-10：Plan 23 P0 一致性指标 ──────────────────────────────────

/**
 * LearningObjective Surface 装配耗时直方图（RL-09 P0）。
 * 分桶覆盖冷/热路径；label lifecycle 区分 active/archived 查询成本差异。
 */
export const surfaceQueryDurationSeconds = new Histogram({
  name: "ailearn_surface_query_duration_seconds",
  help: "assembleObjectiveSurfaceV3 + listObjectiveSurfacesV3 latency by query type",
  labelNames: ["query_type"] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

/**
 * Dashboard 首页空但存在 active objective 的异常计数器（RL-10 P0）。
 * 表示前端/服务端态不一致（应有 primaryFocus 时却返回空首页）。
 */
export const dashboardEmptyWithActiveObjectivesTotal = new Counter({
  name: "ailearn_dashboard_empty_with_active_objectives_total",
  help: "Dashboard home returned empty mode (first_use/notes_without) while learning_objectives_v2 had active rows",
  registers: [registry],
});

/**
 * Dashboard 装配耗时直方图（RL-09 P0）。
 * 含 counts + listObjectiveSurfacesV3 全流程；慢请求（>1s）需告警。
 */
export const dashboardBuildDurationSeconds = new Histogram({
  name: "ailearn_dashboard_build_duration_seconds",
  help: "buildLearningDashboardV2 E2E latency",
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

/**
 * Surface 慢查询计数器（RL-09 P0）。
 * 当 surface 装配耗时超过 1s 阈值时递增；label query_type 区分 detail/list。
 */
export const surfaceSlowQueryTotal = new Counter({
  name: "ailearn_surface_slow_query_total",
  help: "Surface assembly queries exceeding 1s threshold",
  labelNames: ["query_type"] as const,
  registers: [registry],
});

// ─── 方案 22：Companion Memory 可观测性（§9.9）──────────────────────────

/**
 * 桌宠记忆检索模式计数器（vector / keyword_fallback）。
 * 每次 Context Orchestrator 检索后由 worker 侧记录。
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
 * 记忆候选生命周期计数器（created / confirmed / rejected / deleted）。
 */
export const companionMemoryCandidateTotal = new Counter({
  name: "ailearn_companion_memory_candidate_total",
  help: "Companion memory candidate lifecycle events",
  labelNames: ["event"] as const,
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
 * 桌宠人格变更计数器。
 */
export const companionPetProfileChangedTotal = new Counter({
  name: "ailearn_companion_pet_profile_changed_total",
  help: "Companion pet profile changes",
  registers: [registry],
});

// ─── Release 指标 ───────────────────────────────────────────────────────

/** Release 信息 gauge（固定值，用于 Prometheus label 关联） */
export const releaseInfo = new Gauge({
  name: "ailearn_release_info",
  help: "Release metadata: version, commit, migration count",
  labelNames: ["version", "commit", "migrations"] as const,
  registers: [registry],
});

// ─── 辅助函数 ───────────────────────────────────────────────────────────

/**
 * 将 HTTP 状态码映射到 status class。
 * 只允许 2xx/3xx/4xx/5xx 四类，降低基数。
 */
export function statusToClass(status: number): (typeof HTTP_STATUS_CLASSES)[number] {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  return "2xx";
}

/**
 * 将路由路径规范化为模板。
 * 去除路径参数（UUID、数字）和 query string，避免高基数和参数泄漏。
 * 例如：/notes/550e8400-e29b-41d4-a716-446655440000 → /notes/:id
 *      /search?q=sensitive+content → /search
 */
export function normalizeRouteTemplate(path: string): string {
  return path
    // 去除 query string（ADR-0006 §4 禁止记录完整 URL query）
    .replace(/\?.*$/, "")
    // UUID → :id
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    // 纯数字 → :id
    .replace(/\/\d+/g, "/:id")
    // 尾部斜杠
    .replace(/\/$/, "") || "/";
}

/**
 * 将自由文本错误归类到 allowlist 分类。
 * 避免在指标 label 中使用原始错误消息。
 * BUG-24 修复：使用结构化状态码匹配而非数字子串匹配，避免误分类。
 */
export function categorizeError(error: unknown): (typeof ERROR_CATEGORIES)[number] {
  if (error === null || error === undefined) return "unknown";
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  // 优先匹配语义关键词，避免数字子串误匹配
  if (message.includes("timeout") || message.includes("timed out")) return "timeout";
  if (message.includes("schema") || message.includes("parse") || message.includes("invalid json")) return "schema_failure";
  if (message.includes("validation") || message.includes("invalid")) return "validation_error";
  // 使用正则精确匹配 HTTP 状态码（前后非数字边界），而非子串匹配
  if (/(?:^|\D)(5\d{2})(?:\D|$)/.test(message)) return "provider_5xx";
  if (/(?:^|\D)(401|403)(?:\D|$)/.test(message) || message.includes("unauthorized") || message.includes("forbidden")) return "auth_error";
  if (message.includes("quota") || message.includes("rate limit") || message.includes("429")) return "quota_exceeded";
  if (message.includes("network") || message.includes("econnrefused") || message.includes("enotfound")) return "network_error";
  if (message.includes("rls") || message.includes("policy")) return "rls_denied";
  if (/(?:^|\D)(4\d{2})(?:\D|$)/.test(message)) return "provider_4xx";
  return "unknown";
}

/**
 * 记录 Funnel 事件。
 * 所有 funnel 事件必须通过此函数记录，确保 label 在 allowlist 内。
 */
export function recordFunnelEvent(event: (typeof FUNNEL_EVENTS)[number]): void {
  funnelEventsTotal.inc({ event });
}

/**
 * 设置 Release 信息。
 * 在 API 启动时调用一次，将版本信息暴露为 Prometheus label。
 */
export function setReleaseInfo(version: string, commit: string, migrations: number): void {
  releaseInfo.set({ version, commit, migrations: String(migrations) }, 1);
}

/**
 * 生成 metrics 响应文本。
 * 供 /metrics 端点使用。
 */
export async function getMetricsText(): Promise<string> {
  return registry.metrics();
}

/**
 * 获取 registry 的 content type。
 * 供 /metrics 端点设置 Content-Type header。
 */
export function getMetricsContentType(): string {
  return registry.contentType;
}
