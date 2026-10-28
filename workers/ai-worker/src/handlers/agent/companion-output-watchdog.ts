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
export function companionOutputWatchdogPolicy(workload: "casual" | "adaptive" = "adaptive") {
  // 推理模型的上下文预填充可能超过 20 秒。首段等待与输出后的失活检测分开，
  // 不把健康的长思考或多步工具流程截成固定时长的回合。12 秒是实测的分界：
  // 正常首字 2–4.5 秒，超过 12 秒基本是网关卡住；此时尽快切备用档，而不是空等 60 秒。
  const firstOutputMs = configured(process.env.COMPANION_PROVIDER_FIRST_OUTPUT_TIMEOUT_MS, 12_000);
  return { firstOutputMs: workload === "casual"
    ? configured(process.env.COMPANION_CASUAL_PROVIDER_FIRST_OUTPUT_TIMEOUT_MS,
      Number.isFinite(firstOutputMs) ? Math.min(firstOutputMs, 5_000) : Infinity) : firstOutputMs,
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
export function executeWatchedCompanionTurn(provider: AIProvider, request: AgentTurnRequest, signal: AbortSignal,
  policy = companionOutputWatchdogPolicy()) {
  return watchCompanionOutput<AgentTurnResult>((attempt, activity) =>
    provider.executeAgentTurn!(request, attempt, { onOutputActivity: activity }), signal, policy);
}
