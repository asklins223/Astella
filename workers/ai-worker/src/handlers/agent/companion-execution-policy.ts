import type { CompanionAgentBudgetSnapshotV1 } from "@astella/shared";
import { resolveCompanionAgentBudget } from "../../lib/handler-timeout-config.ts";

/** Emit periodic cost warnings without interrupting a user-directed long run. */
export function shouldWarnCompanionModelCalls(count: number, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.WORKER_COMPANION_CALL_WARNING_INTERVAL?.trim();
  const parsed = raw ? Number(raw) : 50;
  const interval = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 50;
  return Number.isSafeInteger(count) && count > 0 && count % interval === 0;
}

/** Defaults do not truncate long-running tasks. Operators can set model-call,
 * web-search and deadline budgets; the remaining counts are receipt diagnostics.
 * Historical numeric receipts remain readable. */
export function companionExecutionPolicy(env: NodeJS.ProcessEnv = process.env): CompanionAgentBudgetSnapshotV1 {
  const limit = (key: string): number | null => {
    const value = env[key]?.trim();
    if (!value) return null;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${key} must be a positive integer`);
    return parsed;
  };
  return {
    maxSteps: limit("WORKER_COMPANION_MAX_STEPS"),
    maxToolCallsPerStep: limit("WORKER_COMPANION_MAX_TOOL_CALLS_PER_STEP"),
    maxToolCalls: limit("WORKER_COMPANION_MAX_TOOL_CALLS"),
    maxModelCalls: limit("WORKER_COMPANION_MAX_MODEL_CALLS"),
    maxWebSearchCalls: limit("WORKER_COMPANION_MAX_WEB_SEARCH_CALLS"),
    deadlineMs: Number.isFinite(resolveCompanionAgentBudget().loopDeadlineMs) ? resolveCompanionAgentBudget().loopDeadlineMs : null,
  };
}
