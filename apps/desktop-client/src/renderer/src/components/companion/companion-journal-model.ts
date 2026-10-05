import type { CompanionProposalUiState } from "../../app/companion-chat-session";
import { companionProposalExpired } from "./CompanionProposalChoice";

/** 待确认只承接仍需用户决定或重试读取的选择。 */
export function journalProposalNeedsDecision(state: CompanionProposalUiState | undefined): boolean {
  if (!state || state.phase !== "ready") return true;
  return Boolean(state.deciding || state.error)
    || (state.proposal.status === "pending" && !companionProposalExpired(state.proposal.expiresAt));
}

/** 已确认但仍在执行的动作在原对话露出进展，终态才进入附页。 */
export function journalProposalNeedsAttention(state: CompanionProposalUiState | undefined): boolean {
  return journalProposalNeedsDecision(state) || (state?.phase === "ready"
    && (state.proposal.status === "executing" || state.proposal.status === "accepted"));
}
