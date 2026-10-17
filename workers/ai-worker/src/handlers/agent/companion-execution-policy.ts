import type { CompanionAgentBudgetSnapshotV1 } from "@astella/shared";
import { resolveCompanionAgentBudget } from "../../lib/handler-timeout-config.ts";

/** A run ends on completion, on the wall-clock slice, or on a real error — never
 * because a count was reached. 2026-10-16: the companion agent enforces no count
 * ceiling at all, so these optional operator numbers are **recorded** in the run
 * receipt for diagnostics and are not consulted by the loop; historical numeric
 * receipts stay readable. */
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
