export class CompanionOutputTimeoutError extends Error {
  constructor(readonly code: "provider_first_output_timeout" | "provider_idle_timeout" | "provider_progress_timeout") {
    super(code === "provider_first_output_timeout" ? "模型尚未返回首段输出"
      : code === "provider_progress_timeout" ? "模型持续思考，但尚未返回可用回答或工具调用" : "模型输出中断，等待新的进展超时");
    this.name = "CompanionOutputTimeoutError";
  }
}
function configured(value: string | undefined, fallback: number): number {
  if (value === "0") return Infinity;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
export function companionOutputWatchdogPolicy(workload: "casual" | "adaptive" = "adaptive",
  attempt: "primary" | "recovery" = "primary", options: { deepThinking?: boolean } = {}) {
  // First observed output, idle progress and first text/tool progress are
  // distinct attempt deadlines. They do not cap the entire multi-step task or
  // diagnose whether a slow first event came from prefill, generation or transport.
  // One silence budget for every step, including a casual opening and the
  // recovery attempt. Switch only after a full minute with no output at all.
  // Thinking tokens and tool calls are output. A shorter casual cut is not
  // applied. COMPANION_PROVIDER_FIRST_OUTPUT_TIMEOUT_MS=0 disables the switch.
  void workload;
  void attempt;
  void options;
  return { firstOutputMs: configured(process.env.COMPANION_PROVIDER_FIRST_OUTPUT_TIMEOUT_MS, 60_000),
    idleMs: configured(process.env.COMPANION_PROVIDER_IDLE_TIMEOUT_MS, 60_000),
    firstMeaningfulOutputMs: configured(process.env.COMPANION_PROVIDER_FIRST_MEANINGFUL_OUTPUT_TIMEOUT_MS, Infinity) };
}

export interface CompanionOutputWatchdogPolicy {
  firstOutputMs: number;
  idleMs: number;
  firstMeaningfulOutputMs?: number;
}
/** Watches an attempt, not the task's lifetime. Reasoning keeps idle detection
 * alive but cannot postpone the first answer/tool indefinitely. Once useful
 * output starts, a healthy long stream has no additional lifetime cap. */
export async function watchCompanionOutput<T>(operation: (signal: AbortSignal,
  activity: (kind?: "text" | "reasoning" | "tool") => void) => Promise<T>,
  parent: AbortSignal, policy: CompanionOutputWatchdogPolicy = companionOutputWatchdogPolicy()): Promise<T> {
  parent.throwIfAborted();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let meaningfulTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectWatch: (error: unknown) => void = () => undefined;
  let settled = false;
  const fail = (error: unknown) => { if (settled) return; settled = true; controller.abort(error); rejectWatch(error); };
  const cancelled = () => fail(parent.reason ?? new DOMException("Aborted", "AbortError"));
  const arm = (ms: number, code: CompanionOutputTimeoutError["code"]) => {
    clearTimeout(timer);
    if (!settled && Number.isFinite(ms)) timer = setTimeout(() => fail(new CompanionOutputTimeoutError(code)), Math.min(ms, 2_147_483_647));
  };
  const watch = new Promise<never>((_, reject) => { rejectWatch = reject; });
  parent.addEventListener("abort", cancelled, { once: true });
  arm(policy.firstOutputMs, "provider_first_output_timeout");
  if (policy.firstMeaningfulOutputMs !== undefined && Number.isFinite(policy.firstMeaningfulOutputMs))
    meaningfulTimer = setTimeout(() => fail(new CompanionOutputTimeoutError("provider_progress_timeout")),
      Math.min(policy.firstMeaningfulOutputMs, 2_147_483_647));
  const activity = (_kind?: "text" | "reasoning" | "tool") => {
    // Thinking tokens and tool calls are output. Any of them satisfies the
    // silence budget and restarts the idle wait.
    clearTimeout(meaningfulTimer);
    arm(policy.idleMs, "provider_idle_timeout");
  };
  try { return await Promise.race([Promise.resolve().then(() => operation(controller.signal, activity)), watch]); }
  finally { settled = true; clearTimeout(timer); clearTimeout(meaningfulTimer); parent.removeEventListener("abort", cancelled); }
}
import type { AgentTurnRequest, AgentTurnResult } from "@astella/shared";
import type { AIProvider } from "../../lib/ai-provider.ts";


/** Buffered transports may still observe native reasoning/tool output. For
 * transports without observations, the response itself is the first output. */
export function executeWatchedCompanionTurn(provider: AIProvider, request: AgentTurnRequest, signal: AbortSignal,
  policy: CompanionOutputWatchdogPolicy = companionOutputWatchdogPolicy()) {
  return watchCompanionOutput<AgentTurnResult>((attempt, activity) =>
    provider.executeAgentTurn!(request, attempt, { onOutputActivity: activity }), signal, policy);
}
