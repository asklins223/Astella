/**
 * Per-job-type handler timeout resolution.
 *
 * Timeouts are configurable via environment variables:
 *   WORKER_MODEL_TIMEOUT_MS              — global default (fallback)
 *   WORKER_TIMEOUT_<TYPE>_MS             — per-job handler budget
 *   WORKER_PROVIDER_TIMEOUT_MS           — nested provider-call default
 *   WORKER_PROVIDER_TIMEOUT_<TYPE>_MS    — nested provider-call override
 *
 * Note-learning products (overview / mind map / line explanation / expansion draft)
 * also carry a built-in per-type provider contract (DEFAULT_PROVIDER_TIMEOUTS) so a
 * single stalled model call fails in minutes instead of the global 15-minute default.
 * An explicitly set env still wins.
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
  // A renewable, user-cancellable agent task has no guessed total wall-clock
  // deadline. Deployment overrides and individual provider timeouts still apply.
  companion_agent: Infinity,
  companion_followup_suggestions: 15_000,
  agent_run_advance: DEFAULT_AI_TASK_TIMEOUT_MS,
  companion_memory_extract: DEFAULT_AI_TASK_TIMEOUT_MS,
  companion_summarizer: DEFAULT_AI_TASK_TIMEOUT_MS,
  companion_daily_summary: DEFAULT_AI_TASK_TIMEOUT_MS,
  companion_memory_embedding_rebuild: DEFAULT_AI_TASK_TIMEOUT_MS,
  companion_memory_organize: DEFAULT_AI_TASK_TIMEOUT_MS,
  // 方案 50 §9.2：后台回顾。一次结构化调用 + 至多一次协议修复，走 maintenance 车道。
  companion_reflection: DEFAULT_AI_TASK_TIMEOUT_MS,
  note_overview_generate: DEFAULT_AI_TASK_TIMEOUT_MS,
  note_mind_map_generate: DEFAULT_AI_TASK_TIMEOUT_MS,
  note_annotation_explain: DEFAULT_AI_TASK_TIMEOUT_MS,
  note_dynamic_artifact_generate: DEFAULT_AI_TASK_TIMEOUT_MS,
  note_expansion_generate: DEFAULT_AI_TASK_TIMEOUT_MS,
};

const GLOBAL_DEFAULT_MS = DEFAULT_AI_TASK_TIMEOUT_MS;
const PROVIDER_SAFETY_MARGIN_MS = 15_000;
const DEFAULT_PROVIDER_TIMEOUT_MS = DEFAULT_AI_PROVIDER_TIMEOUT_MS;

/**
 * 笔记学习产物的**单次模型调用**预算（毫秒）。
 *
 * 与 handler 时限分开的理由：handler 回答的是"这个任务总共能跑多久"（默认 30 min，
 * 长笔记要多段并行），这里回答的是"**一发** provider 请求最多等多久"。此前派生预算
 * 只受 `WORKER_PROVIDER_TIMEOUT_MS`（部署默认 15 min）约束，于是模型一旦陷入长思考，
 * 用户看到的是十几分钟的转圈：2026-10-16 线上一次速看单发 242 s（mimo-v2.6-flash
 * 在 medium 档产出 9,411 completion token），而客户端 1.6 s 轮询从不放弃、纸面也没有
 * 任何进度。这里给结构化笔记任务一个明确契约：超时就失败、纸面给重试，而不是无限等。
 *
 * 数字只写"正常量级已经远远够用"的值（正常一次 10–30 s）：它不是省钱的闸门，
 * 是"这一发已经不正常了"的判据。长笔记不受影响——分段是并行的，每段各有一份预算。
 *
 * 优先级与 {@link resolveHandlerTimeout} 一致：
 *   per-type env > WORKER_PROVIDER_TIMEOUT_MS > 这里的内置值 > 全局内置。
 * 也就是说部署仍可用 `WORKER_PROVIDER_TIMEOUT_<TYPE>_MS` 覆盖任何一个值。
 */
const DEFAULT_PROVIDER_TIMEOUTS: Record<string, number> = {
  // 速看：整篇一次读，正常十几秒。
  note_overview_generate: 120_000,
  // 脑图：结构化节点更多，但也不该按分钟等。
  note_mind_map_generate: 150_000,
  // 原句讲解：一句话的讲解，最短的一发。
  note_annotation_explain: 90_000,
  // 拓展草稿：多篇候选。
  note_expansion_generate: 150_000,
};

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(Math.floor(parsed)) || parsed <= 0) return undefined;
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
  if (perTypeEnv !== undefined) return jobType === "companion_agent" ? perTypeEnv : clamp(perTypeEnv);

  // A legacy global chat/job timeout is not an explicit agent-task policy.
  // Only WORKER_TIMEOUT_COMPANION_AGENT_MS opts this task into a total deadline.
  if (jobType === "companion_agent") return Infinity;

  // 2. Global env var — operator-wide override applies to all job types
  //    that don't have an explicit per-type env var.
  const globalEnv = parsePositiveInt(process.env.WORKER_MODEL_TIMEOUT_MS);
  if (globalEnv !== undefined) return clamp(globalEnv);

  // 3. Per-type built-in default — sensible per-type values when no env.
  const perTypeDefault = DEFAULT_TIMEOUTS[jobType];
  if (perTypeDefault !== undefined) return perTypeDefault === Infinity ? Infinity : clamp(perTypeDefault);

  // 4. Global built-in default.
  return clamp(GLOBAL_DEFAULT_MS);
}

/**
 * Resolve a nested provider-call budget that leaves time for the handler's
 * deterministic fallback or retry-state persistence.
 *
 * Priority: per-type env > WORKER_PROVIDER_TIMEOUT_MS > per-type task contract
 * (DEFAULT_PROVIDER_TIMEOUTS) > global built-in default.
 */
export function resolveProviderCallTimeout(jobType: string): number {
  const handlerTimeout = resolveHandlerTimeout(jobType);
  const requested =
    parsePositiveInt(process.env[providerEnvKeyForType(jobType)])
    ?? parsePositiveInt(process.env.WORKER_PROVIDER_TIMEOUT_MS)
    ?? DEFAULT_PROVIDER_TIMEOUTS[jobType]
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
 *   handler abort                 仅按显式伴星部署配置启用整轮时限
 *          └─ loop deadline         有限时限扣除持久化余量；默认没有整轮硬截止
 * ```
 *
 * 租约不再限制合法任务的总时长；运行时持续续租，失去租约或取消仍立即中止。
 * 显式配置的预算跨确认续跑累加；循环为持久化留下余量。
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
  defaultProviderTimeouts: { ...DEFAULT_PROVIDER_TIMEOUTS },
  globalDefaultMs: GLOBAL_DEFAULT_MS,
  defaultProviderTimeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
  providerSafetyMarginMs: PROVIDER_SAFETY_MARGIN_MS,
  companionAgentPersistenceMarginMs: COMPANION_AGENT_PERSISTENCE_MARGIN_MS,
};
