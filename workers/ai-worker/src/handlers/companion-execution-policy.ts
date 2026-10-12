import type { CompanionAgentBudgetSnapshotV1 } from "@astella/shared";
import { resolveCompanionAgentBudget } from "../lib/handler-timeout-config.ts";

/** A run ends on completion/cancellation/deadline, not a guessed tool count.
 * Optional operator ceilings are explicit and recorded; historical numeric
 * receipts remain readable without imposing those old ceilings on new runs. */
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
