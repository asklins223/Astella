/**
 * The "this tool cannot run in this turn" branch.
 *
 * A capability can be declared yet unavailable for this turn (vision switched
 * off for the account, web search turned off or out of quota). The user needs
 * to hear which switch is missing; the model needs to say so instead of
 * pretending the action happened. Both derive from `event.constraints`, so the
 * decision stays next to it.
 */

import type { CompanionAgentToolExecutionConstraints } from "@astella/shared";
import { unavailableCompanionToolSummary } from "./companion-tool-outcome.ts";
import { companionToolFailureFaces } from "./companion-tool-failure-faces.ts";

export interface CompanionUnavailableTool {
  /** Ledger status, so the audit trail says why nothing ran. */
  readonly ledgerStatus: string;
  readonly safeSummary: string;
  /** The receipt content the model sees. */
  readonly receipt: string;
  /** True when the quota ran out rather than the capability being off. */
  readonly quotaReached: boolean;
}

export function judgeCompanionUnavailableTool(input: {
  toolName: string;
  constraints: CompanionAgentToolExecutionConstraints;
  searchLimitReached: boolean;
}): CompanionUnavailableTool | null {
  const summary = unavailableCompanionToolSummary(input.toolName, input.constraints, {
    searchLimitReached: input.searchLimitReached,
  });
  if (!summary) return null;
  const faces = companionToolFailureFaces({
    status: input.searchLimitReached && input.constraints.webSearchEnabled === true
      ? "not_executed" : "unavailable",
    safeSummary: summary,
  });
  return {
    ledgerStatus: faces.ledgerStatus,
    safeSummary: faces.safeSummary,
    receipt: JSON.stringify({ ok: false, status: faces.modelStatus, error: faces.safeSummary }),
    quotaReached: input.searchLimitReached,
  };
}
