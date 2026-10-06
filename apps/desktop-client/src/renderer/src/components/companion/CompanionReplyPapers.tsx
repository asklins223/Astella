import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileText, Image, Layers, Sparkles, X } from "lucide-react";
import type { CompanionContentBlockV1 } from "@astella/shared/companion-conversation-contracts";
import type { CompanionChatSession, CompanionProposalUiState } from "../../app/companion-chat-session";
import { CompanionMessageRichBlocks } from "./CompanionChatRecord";
import { CompanionProposalChoice, companionProposalExpired } from "./CompanionProposalChoice";
import { useCompanionTransient } from "./use-companion-transient";

interface PaperBlock { key: string; block: CompanionContentBlockV1 }

export function CompanionStatusPaper({ identity, title = "笔记关联", paused, children }: { identity: string; title?: string; paused: boolean; children: ReactNode }) {
  return <ReplyPaper identity={identity} title={title} kind="note-status" icon={<FileText size={17} />} holdMs={60_000} paused={paused}>{children}</ReplyPaper>;
}

function ReplyPaper({ identity, title, holdMs, paused, icon, children, confirmation = false, kind, onRetire }: {
  identity: string; title: string; holdMs: number; paused: boolean; icon: ReactNode;
  children: ReactNode; confirmation?: boolean; kind?: string; onRetire?: () => void;
}) {
  const life = useCompanionTransient(identity, holdMs, paused);
  const [removed, setRemoved] = useState(false);
  const retireRef = useRef(onRetire);
  retireRef.current = onRetire;
  useEffect(() => {
    if (life.visible) { setRemoved(false); return; }
    const timer = window.setTimeout(() => { setRemoved(true); retireRef.current?.(); }, 280);
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
  const [papers, setPapers] = useState<readonly PaperBlock[]>([]);
  const seen = useRef(new Set<string>());
  const knownProposals = useRef(new Set<string>());
  const retired = useRef(new Set<string>());
  useEffect(() => {
    if (!chat.richReply) return;
    const additions: PaperBlock[] = [];
    chat.richReply.blocks.forEach((block, index) => {
      if (block.type === "text" || block.type === "action_ref") return;
      const key = `${chat.richReply!.messageId}:${index}`;
      if (seen.current.has(key)) return;
      seen.current.add(key);
      additions.push({ key, block });
    });
    if (additions.length) setPapers(previous => [...previous, ...additions]);
  }, [chat.richReply]);
  useEffect(() => {
    if (!chat.richReply) return;
    const keys = chat.richReply.blocks.flatMap((block, index) => block.type !== "text" && block.type !== "action_ref" ? [`${chat.richReply!.messageId}:${index}`] : []);
    if (keys.length > 0 && keys.every(key => retired.current.has(key))) chat.dismissRichReply();
  }, [papers, chat.richReply, chat.dismissRichReply]);
  for (const [id, state] of Object.entries(chat.proposalStates)) {
    if (state.phase !== "ready" || (state.proposal.status === "pending" && !companionProposalExpired(state.proposal.expiresAt))) knownProposals.current.add(id);
  }
  for (const id of chat.liveReply?.proposalIds ?? []) knownProposals.current.add(id);
  return <div className="companion-hud__papers" aria-label={`${chat.companionName} 递来的纸签`}>
    {[...knownProposals.current].map(id => <ProposalPaper key={id} id={id} state={chat.proposalStates[id]} chat={chat} paused={paused} />)}
    {extra}
    {papers.map(({ key, block }) => <ReplyPaper key={key} identity={key} kind={block.type}
      title={block.type === "image" ? "给你看的图片" : block.type === "card" ? "学习卡片" : block.type === "diagram" ? "一起理清的步骤" : block.type === "nav" ? "可以接着看这里" : block.type === "code" ? "代码片段" : "引用与原文"}
      icon={block.type === "image" ? <Image size={17} /> : block.type === "card" || block.type === "diagram" ? <Layers size={17} /> : <FileText size={17} />}
      holdMs={block.type === "image" || block.type === "card" ? 90_000 : 60_000} paused={paused}
      onRetire={() => { retired.current.add(key); setPapers(current => current.filter(paper => paper.key !== key)); }}>
      <CompanionMessageRichBlocks blocks={[block]} chat={chat} />
    </ReplyPaper>)}
  </div>;
}
