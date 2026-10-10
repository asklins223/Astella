import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ChevronLeft, ChevronRight, FileText, History, Loader2, Sparkles, X } from "lucide-react";
import type { CompanionChatSession, CompanionProposalUiState } from "../../app/companion-chat-session";
import { CompanionProposalChoice, companionProposalExpired } from "./CompanionProposalChoice";
import { useCompanionTransient } from "./use-companion-transient";

export function CompanionStatusPaper({ identity, title = "笔记关联", paused, children }: { identity: string; title?: string; paused: boolean; children: ReactNode }) {
  return <ReplyPaper identity={identity} title={title} kind="note-status" icon={<FileText size={17} />} holdMs={60_000} paused={paused}>{children}</ReplyPaper>;
}

function ReplyPaper({ identity, title, holdMs, paused, icon, children, confirmation = false, kind, hidden = false }: {
  identity: string; title: string; holdMs: number; paused: boolean; icon: ReactNode;
  children: ReactNode; confirmation?: boolean; kind?: string; hidden?: boolean;
}) {
  const life = useCompanionTransient(identity, holdMs, paused || hidden);
  const [removed, setRemoved] = useState(false);
  useEffect(() => {
    if (life.visible) { setRemoved(false); return; }
    const timer = window.setTimeout(() => setRemoved(true), 280);
    return () => window.clearTimeout(timer);
  }, [life.visible]);
  if (removed) return null;
  return (
    <article className="companion-hud__paper" data-stage={life.visible ? "visible" : "leaving"}
      data-confirmation={confirmation || undefined} data-kind={kind} aria-label={title} hidden={hidden}
      aria-hidden={!life.visible || hidden || undefined} inert={!life.visible || hidden || undefined}
      onPointerMove={life.activity} onKeyDown={life.activity} onWheel={life.activity} onFocus={life.activity}>
      <header><strong>{icon}{title}</strong><button type="button" onClick={life.dismiss} aria-label={`收起${title}`}><X size={16} /></button></header>
      <div className="companion-hud__paper-body">{children}</div>
      {kind !== "proposal-results" ? <footer>{confirmation ? "收起后仍可在对话记录处理" : kind === "note-status" ? "稍后收起 · 原文仍在笔记中" : `${Math.round(holdMs / 1_000)} 秒后收起 · 对话记录中保留`}</footer> : null}
    </article>
  );
}

function paperStatus(state: CompanionProposalUiState | undefined) {
  if (!state || state.phase !== "ready") return state?.phase ?? "loading";
  return state.proposal.status === "pending" && companionProposalExpired(state.proposal.expiresAt)
    ? "expired" : state.proposal.status;
}

const ongoing = (status: ReturnType<typeof paperStatus>) => ["loading", "error", "pending", "accepted", "executing"].includes(status);
const resultLabels = { succeeded: "已完成", rejected: "已跳过", expired: "已过期", failed: "执行失败" } as const;

function ProposalPapers({ chat, paused, hostRef, focusRef }: { chat: CompanionChatSession; paused: boolean; hostRef: RefObject<HTMLDivElement | null>; focusRef: RefObject<boolean> }) {
  const known = useRef(new Set<string>());
  const replyId = useRef<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [, refreshExpiry] = useState(0);
  // Historical loading/error snapshots belong to the journal. Only a live reply
  // can introduce an unread snapshot here; hydrated terminal actions stay quiet.
  if (chat.liveReply && replyId.current !== chat.liveReply.messageId) {
    for (const id of known.current) if (!ongoing(paperStatus(chat.proposalStates[id]))) known.current.delete(id);
    replyId.current = chat.liveReply.messageId;
  }
  for (const id of chat.liveReply?.proposalIds ?? []) known.current.add(id);
  for (const [id, state] of Object.entries(chat.proposalStates)) {
    if (state.phase === "ready" && ["pending", "accepted", "executing"].includes(paperStatus(state))) known.current.add(id);
  }
  const ids = [...known.current].filter(id => id in chat.proposalStates || chat.liveReply?.proposalIds.includes(id));
  const active = ids.filter(id => ongoing(paperStatus(chat.proposalStates[id])));
  const results = ids.filter(id => !ongoing(paperStatus(chat.proposalStates[id])));
  const nextExpiry = Math.min(...ids.flatMap(id => {
    const state = chat.proposalStates[id];
    if (state?.phase !== "ready" || state.proposal.status !== "pending" || !state.proposal.expiresAt) return [];
    const at = Date.parse(state.proposal.expiresAt);
    return at > Date.now() ? [at] : [];
  }));
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const timer = window.setTimeout(() => refreshExpiry(value => value + 1), Math.min(nextExpiry - Date.now() + 30, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [nextExpiry]);
  const summary = Object.entries(resultLabels).flatMap(([status, label]) => {
    const count = results.filter(id => paperStatus(chat.proposalStates[id]) === status).length;
    return count ? [`${label} ${count} 项`] : [];
  }).join(" · ");
  const openHistory = () => chat.setMode("history");
  const resultIdentity = results.map(id => `${id}:${paperStatus(chat.proposalStates[id])}`).join("|");
  const id = selectedId && active.includes(selectedId) ? selectedId : active[0];
  const index = active.indexOf(id);
  const state = id ? chat.proposalStates[id] : undefined;
  const status = paperStatus(state);
  const executing = status === "accepted" || status === "executing";
  const singleResult = results.length === 1 ? chat.proposalStates[results[0]] : undefined;
  const failedId = [...results].reverse().find(id => paperStatus(chat.proposalStates[id]) === "failed");
  const failed = failedId ? chat.proposalStates[failedId] : undefined;
  useLayoutEffect(() => {
    if (!focusRef.current || (document.activeElement !== document.body && document.activeElement?.isConnected)) return;
    const paper = hostRef.current?.querySelector<HTMLElement>('.companion-hud__paper:not([hidden])[data-stage="visible"]');
    paper?.querySelector<HTMLButtonElement>(".companion-choice-card__confirm, .companion-proposal-record-link > button")?.focus({ preventScroll: true });
  }, [active.join("|"), resultIdentity, id, status]);
  // Keep the receipt mounted while a decision is on top, so switching decisions
  // or opening the journal cannot restart a dismissed receipt's lifetime.
  return <>
    {id ? <ReplyPaper identity={`proposal:${active.join("|")}`} title={executing ? "正在执行" : "等你确认"}
        kind="proposal-choice" icon={executing ? <Loader2 size={17} /> : <Sparkles size={17} />}
        holdMs={Infinity} paused={paused} confirmation>
        {status === "pending" ? <span className="companion-hud__sr-status" role="status">{chat.companionName} 有 {active.length} 项动作待处理，当前是第 {index + 1} 项；可以稍后在对话记录中决定。</span> : null}
        {active.length > 1 ? <nav className="companion-proposal-pager" aria-label="待处理动作">
          <span>{index + 1} / {active.length} 项</span>
          <button type="button" aria-label="上一项待处理动作" disabled={index === 0} onClick={() => setSelectedId(active[index - 1])}><ChevronLeft size={16} /></button>
          <button type="button" aria-label="下一项待处理动作" disabled={index === active.length - 1} onClick={() => setSelectedId(active[index + 1])}><ChevronRight size={16} /></button>
        </nav> : null}
        {executing && state?.phase === "ready" ? <div className="companion-proposal-receipt" role="status">
          <strong>{state.proposal.title}</strong><p>正在处理，结果会留在对话记录里。</p>
          {state.error ? <p>{state.error}</p> : null}
        </div> : <CompanionProposalChoice proposalId={id} state={state} context="bubble"
          onDecide={decision => { void chat.decideProposal(id, decision); }} onRetry={() => { void chat.retryProposal(id); }} />}
        <div className="companion-proposal-record-link">{summary ? <span>{summary}</span> : null}<button type="button" onClick={openHistory}><History size={14} />查看对话记录</button></div>
      </ReplyPaper> : null}
      {results.length ? <ReplyPaper identity={`proposal-results:${resultIdentity}`} title="动作结果" kind="proposal-results"
        icon={<Sparkles size={17} />} holdMs={failedId ? Infinity : 10_000} paused={paused} hidden={active.length > 0}>
        <div className="companion-proposal-receipt" role="status">
          <strong>{summary}</strong>
          {singleResult?.phase === "ready" ? <p>{singleResult.proposal.title}</p> : null}
          {failed?.phase === "ready" ? <p className="companion-proposal-receipt__error">{results.length > 1 ? `${failed.proposal.title}：` : ""}{failed.error || "执行失败，请在记录中核对。"}</p> : null}
        </div>
        <div className="companion-proposal-record-link"><button type="button" onClick={openHistory}><History size={14} />查看对话记录</button></div>
      </ReplyPaper> : null}
  </>;
}

/** Cache arrived papers, never hydrate old terminal actions as fresh notifications. */
export function CompanionReplyPapers({ chat, paused, extra }: { chat: CompanionChatSession; paused: boolean; extra?: ReactNode }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const focusRef = useRef(false);
  return <div ref={hostRef} className="companion-hud__papers" aria-label={`${chat.companionName} 递来的纸签`}
      onFocusCapture={() => { focusRef.current = true; }} onBlurCapture={event => { focusRef.current = event.currentTarget.contains(event.relatedTarget as Node | null); }}>
      <ProposalPapers chat={chat} paused={paused} hostRef={hostRef} focusRef={focusRef} />
      {extra}
    </div>;
}
