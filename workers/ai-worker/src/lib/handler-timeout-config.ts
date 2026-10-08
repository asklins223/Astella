/**
 * Per-job-type handler timeout resolution.
 *
 * Timeouts are configurable via environment variables:
 *   WORKER_MODEL_TIMEOUT_MS              — global default (fallback)
 *   WORKER_TIMEOUT_PARSE_SOURCE_MS       — parse_source override
 *   WORKER_PROVIDER_TIMEOUT_MS           — nested provider-call default
 *   WORKER_PROVIDER_TIMEOUT_<TYPE>_MS    — nested provider-call override
 *
 * Running jobs renew their lease. Lease duration controls crash recovery,
 * while handler/provider deadlines control execution time independently.
 */

import { LEASE_TIMEOUT_MS } from "../queue.ts";
import { DEFAULT_AI_PROVIDER_TIMEOUT_MS, DEFAULT_AI_TASK_TIMEOUT_MS } from "@astella/shared";

const MAX_ALLOWED_TIMEOUT_MS = 24 * 60 * 60_000;

/** Default per-type timeouts (milliseconds). */
const DEFAULT_TIMEOUTS: Record<string, number> = {
  // URL fetch + text segmentation, no AI call.
  parse_source: 60_000,
  companion_agent: DEFAULT_AI_TASK_TIMEOUT_MS,
  agent_run_advance: DEFAULT_AI_TASK_TIMEOUT_MS,
  companion_memory_extract: DEFAULT_AI_TASK_TIMEOUT_MS,
  companion_summarizer: DEFAULT_AI_TASK_TIMEOUT_MS,
  companion_daily_summary: DEFAULT_AI_TASK_TIMEOUT_MS,
  companion_memory_embedding_rebuild: DEFAULT_AI_TASK_TIMEOUT_MS,
  companion_memory_organize: DEFAULT_AI_TASK_TIMEOUT_MS,
  companion_thought: DEFAULT_AI_TASK_TIMEOUT_MS,
  note_overview_generate: DEFAULT_AI_TASK_TIMEOUT_MS,
  note_mind_map_generate: DEFAULT_AI_TASK_TIMEOUT_MS,
  note_annotation_explain: DEFAULT_AI_TASK_TIMEOUT_MS,
  note_dynamic_artifact_generate: DEFAULT_AI_TASK_TIMEOUT_MS,
  note_expansion_generate: DEFAULT_AI_TASK_TIMEOUT_MS,
};

const GLOBAL_DEFAULT_MS = DEFAULT_AI_TASK_TIMEOUT_MS;
const PROVIDER_SAFETY_MARGIN_MS = 15_000;
const DEFAULT_PROVIDER_TIMEOUT_MS = DEFAULT_AI_PROVIDER_TIMEOUT_MS;

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function envKeyForType(jobType: string): string {
  return `WORKER_TIMEOUT_${jobType.toUpperCase()}_MS`;
}

function providerEnvKeyForType(jobType: string): string {
  return `WORKER_PROVIDER_TIMEOUT_${jobType.toUpperCase()}_MS`;
}

/**
 * Resolve the handler timeout for a given job type.
 *
 * Priority:
 *   1. Per-type env var (e.g. WORKER_TIMEOUT_PARSE_SOURCE_MS)
 *   2. Global env var (WORKER_MODEL_TIMEOUT_MS)
 *   3. Per-type built-in default
 *   4. Global built-in default (30 minutes)
 *
 * Explicit deployment overrides are retained; lease renewal permits long work.
 */
export function resolveHandlerTimeout(jobType: string): number {
  // 1. Per-type env var — highest priority, explicit operator override.
  const perTypeEnv = parsePositiveInt(process.env[envKeyForType(jobType)]);
  if (perTypeEnv !== undefined) return clamp(perTypeEnv);

  // 2. Global env var — operator-wide override applies to all job types
  //    that don't have an explicit per-type env var.
  const globalEnv = parsePositiveInt(process.env.WORKER_MODEL_TIMEOUT_MS);
  if (globalEnv !== undefined) return clamp(globalEnv);

  // 3. Per-type built-in default — sensible per-type values when no env.
  const perTypeDefault = DEFAULT_TIMEOUTS[jobType];
  if (perTypeDefault !== undefined) return clamp(perTypeDefault);

  // 4. Global built-in default.
  return clamp(GLOBAL_DEFAULT_MS);
}

/**
 * Resolve a nested provider-call budget that leaves time for the handler's
 * deterministic fallback or retry-state persistence.
 */
export function resolveProviderCallTimeout(jobType: string): number {
  const handlerTimeout = resolveHandlerTimeout(jobType);
  const requested =
    parsePositiveInt(process.env[providerEnvKeyForType(jobType)])
    ?? parsePositiveInt(process.env.WORKER_PROVIDER_TIMEOUT_MS)
    ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  const available = handlerTimeout > PROVIDER_SAFETY_MARGIN_MS
    ? handlerTimeout - PROVIDER_SAFETY_MARGIN_MS
    : Math.max(1_000, handlerTimeout - 1_000);
  return Math.max(1, Math.min(requested, available));
}

function clamp(ms: number): number {
  return Math.min(ms, MAX_ALLOWED_TIMEOUT_MS);
}

/**
 * 伴星 agent 的**唯一预算链**（方案 29 §4.9 第 6 项）。
 *
 * ```
 *   lease heartbeat (120s)         job 租约：续租停止后回收崩溃任务
 *   handler abort (30min)          runWithAbortTimeout 强制执行
 *          └─ loop deadline         agent 循环自己的 deadline = abort - 持久化余量
 * ```
 *
 * 租约不再限制合法任务的总时长；运行时持续续租，失去租约或取消仍立即中止。
 * 合同预算跨确认续跑累加，handler 是单次执行预算；循环为持久化留下余量。
 *
 * 走函数而不是常量：handler 超时可以被 `WORKER_TIMEOUT_COMPANION_AGENT_MS`
 * 覆盖，而 abort 用的是**解析后**的值——循环若用静态常量算 deadline，env 一改
 * 就会和真正的 abort 错位。
 */
export const COMPANION_AGENT_PERSISTENCE_MARGIN_MS = 15_000;

export interface CompanionAgentBudget {
  /** 最外层：job 租约。 */
  readonly leaseMs: number;
  /** runWithAbortTimeout 强制的 handler 上限。 */
  readonly handlerAbortMs: number;
  /** agent 循环自己的 deadline（handler 起点 + 这个数）。 */
  readonly loopDeadlineMs: number;
}

export function resolveCompanionAgentBudget(jobType = "companion_agent"): CompanionAgentBudget {
  const handlerAbortMs = resolveHandlerTimeout(jobType);
  return {
    leaseMs: LEASE_TIMEOUT_MS,
    handlerAbortMs,
    // 持久化余量给 delta 回放 / TTS 段 / 终态事务，确保它们发生在 abort 之前。
    loopDeadlineMs: Math.max(1, handlerAbortMs - COMPANION_AGENT_PERSISTENCE_MARGIN_MS),
  };
}

/** Structured page generation shares the normal execution budget. */
export function resolveNoteDynamicArtifactBudget(): CompanionAgentBudget {
  return resolveCompanionAgentBudget("note_dynamic_artifact_generate");
}

/** Exposed for logging / diagnostics. */
export const RESOLVED_TIMEOUT_INFO = {
  leaseTimeoutMs: LEASE_TIMEOUT_MS,
  maxAllowedTimeoutMs: MAX_ALLOWED_TIMEOUT_MS,
  defaultTimeouts: { ...DEFAULT_TIMEOUTS },
  globalDefaultMs: GLOBAL_DEFAULT_MS,
  defaultProviderTimeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
  providerSafetyMarginMs: PROVIDER_SAFETY_MARGIN_MS,
  companionAgentPersistenceMarginMs: COMPANION_AGENT_PERSISTENCE_MARGIN_MS,
};
