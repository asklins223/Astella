export class CompanionOutputTimeoutError extends Error {
  constructor(readonly code: "provider_first_output_timeout" | "provider_idle_timeout") {
    super(code === "provider_first_output_timeout" ? "模型尚未返回首段输出" : "模型输出中断，等待新的进展超时");
    this.name = "CompanionOutputTimeoutError";
  }
}
function configured(value: string | undefined, fallback: number): number {
  if (value === "0") return Infinity;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
export function companionOutputWatchdogPolicy() {
  return { firstOutputMs: configured(process.env.COMPANION_PROVIDER_FIRST_OUTPUT_TIMEOUT_MS, 20_000),
    idleMs: configured(process.env.COMPANION_PROVIDER_IDLE_TIMEOUT_MS, 45_000) };
}

/** Watches one provider attempt, not the task's lifetime. Every real output
 * resets idle time; a healthy long reasoning/tool stream may run indefinitely. */
export async function watchCompanionOutput<T>(operation: (signal: AbortSignal, activity: () => void) => Promise<T>,
  parent: AbortSignal, policy = companionOutputWatchdogPolicy()): Promise<T> {
  parent.throwIfAborted();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
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
  const activity = () => arm(policy.idleMs, "provider_idle_timeout");
  try { return await Promise.race([Promise.resolve().then(() => operation(controller.signal, activity)), watch]); }
  finally { settled = true; clearTimeout(timer); parent.removeEventListener("abort", cancelled); }
}
import type { AgentTurnRequest, AgentTurnResult } from "@astella/shared";
import type { AIProvider } from "../../lib/ai-provider.ts";


/** Buffered transports may still observe native reasoning/tool output. For
 * transports without observations, the response itself is the first output. */
export function executeWatchedCompanionTurn(provider: AIProvider, request: AgentTurnRequest, signal: AbortSignal) {
  return watchCompanionOutput<AgentTurnResult>((attempt, activity) =>
    provider.executeAgentTurn!(request, attempt, { onOutputActivity: activity }), signal);
}
