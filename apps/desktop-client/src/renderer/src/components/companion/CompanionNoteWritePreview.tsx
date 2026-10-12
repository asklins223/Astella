import type { ReactNode } from "react";
import { useOptionalCompanionChat } from "../../app/companion-chat-session";
import { CompanionProposalChoice } from "./CompanionProposalChoice";

/** Display the changed paper without putting provisional changes in autosave.
 * Dismissal reveals the current live paper, including the user's later edits. */
export function CompanionNoteWritePreview({ noteId, children }: { noteId: string; children: ReactNode }) {
  const chat = useOptionalCompanionChat();
  const state = chat && Object.values(chat.proposalStates).find(item => item.phase === "ready"
    && ["pending", "accepted", "executing"].includes(item.proposal.status)
    && item.proposal.payload.kind === "agent_tool_review"
    && item.proposal.payload.confirmationStage === "after_preview"
    && item.proposal.payload.preview.noteId === noteId);
  const proposalId = state?.phase === "ready" ? state.proposal.proposalId : null;
  return <>
    {proposalId && chat ? <div className="companion-note-write-preview" role="region" aria-label="笔记更新预览，尚未保存">
      <CompanionProposalChoice proposalId={proposalId} state={state ?? undefined} context="history"
        onDecide={decision => void chat.decideProposal(proposalId, decision)}
        onRetry={() => void chat.retryProposal(proposalId)} />
    </div> : null}
    <div hidden={Boolean(proposalId)}>{children}</div>
  </>;
}
