import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileText, Sparkles, X } from "lucide-react";
import type { CompanionChatSession, CompanionProposalUiState } from "../../app/companion-chat-session";
import { CompanionProposalChoice, companionProposalExpired } from "./CompanionProposalChoice";
import { useCompanionTransient } from "./use-companion-transient";

export function CompanionStatusPaper({ identity, title = "笔记关联", paused, children }: { identity: string; title?: string; paused: boolean; children: ReactNode }) {
  return <ReplyPaper identity={identity} title={title} kind="note-status" icon={<FileText size={17} />} holdMs={60_000} paused={paused}>{children}</ReplyPaper>;
}

function ReplyPaper({ identity, title, holdMs, paused, icon, children, confirmation = false, kind }: {
  identity: string; title: string; holdMs: number; paused: boolean; icon: ReactNode;
  children: ReactNode; confirmation?: boolean; kind?: string;
}) {
  const life = useCompanionTransient(identity, holdMs, paused);
  const [removed, setRemoved] = useState(false);
  useEffect(() => {
    if (life.visible) { setRemoved(false); return; }
    const timer = window.setTimeout(() => setRemoved(true), 280);
    return () => window.clearTimeout(timer);
  }, [life.visible]);
  if (removed) return null;
  return (
    <article className="companion-hud__paper" data-stage={life.visible ? "visible" : "leaving"}
      data-confirmation={confirmation || undefined} data-kind={kind} aria-label={title}
      onPointerMove={life.activity} onKeyDown={life.activity} onWheel={life.activity} onFocus={life.activity}>
      <header><strong>{icon}{title}</strong><button type="button" onClick={life.dismiss} aria-label={`收起${title}`}><X size={16} /></button></header>
      <div className="companion-hud__paper-body">{children}</div>
      <footer>{confirmation ? "等你决定 · 收起后仍可在对话记录处理" : kind === "note-status" ? "稍后收起 · 原文仍在笔记中" : `${Math.round(holdMs / 1_000)} 秒后收起 · 对话记录中保留`}</footer>
    </article>
  );
}

function ProposalPaper({ id, state, chat, paused }: {
  id: string; state: CompanionProposalUiState | undefined; chat: CompanionChatSession; paused: boolean;
}) {
  const [, refreshExpiry] = useState(0);
  const expiry = state?.phase === "ready" ? state.proposal.expiresAt : null;
  useEffect(() => {
    if (!expiry) return;
    const delay = Date.parse(expiry) - Date.now();
    if (!Number.isFinite(delay) || delay <= 0) return;
    const timer = window.setTimeout(() => refreshExpiry(value => value + 1), Math.min(delay + 30, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [expiry]);
  const pending = !state || state.phase !== "ready" || (state.proposal.status === "pending" && !companionProposalExpired(state.proposal.expiresAt));
  const status = pending ? "pending" : state?.phase === "ready" ? state.proposal.status : "unknown";
  return <ReplyPaper identity={`proposal:${id}:${status}`} title={pending ? "等你确认" : "动作结果"}
    icon={<Sparkles size={17} />} holdMs={pending ? Infinity : 10_000} paused={paused || Boolean(state?.phase === "ready" && state.deciding)} confirmation={pending}>
    <CompanionProposalChoice proposalId={id} state={state} context="bubble"
      onDecide={decision => { void chat.decideProposal(id, decision); }} onRetry={() => { void chat.retryProposal(id); }} />
  </ReplyPaper>;
}

/** Cache arrived papers, never hydrate old terminal actions as fresh notifications. */
export function CompanionReplyPapers({ chat, paused, extra }: { chat: CompanionChatSession; paused: boolean; extra?: ReactNode }) {
  const knownProposals = useRef(new Set<string>());
  for (const [id, state] of Object.entries(chat.proposalStates)) {
    if (state.phase !== "ready" || (state.proposal.status === "pending" && !companionProposalExpired(state.proposal.expiresAt))) knownProposals.current.add(id);
  }
  for (const id of chat.liveReply?.proposalIds ?? []) knownProposals.current.add(id);
  return <div className="companion-hud__papers" aria-label={`${chat.companionName} 递来的纸签`}>
      {[...knownProposals.current].map(id => <ProposalPaper key={id} id={id} state={chat.proposalStates[id]} chat={chat} paused={paused} />)}
      {extra}
    </div>;
}
