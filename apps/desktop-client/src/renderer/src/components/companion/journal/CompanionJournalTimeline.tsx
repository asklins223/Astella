import { type ReactNode } from "react";
import { Sparkles } from "lucide-react";
import type { CompanionChatSession } from "../../../app/companion-session/companion-chat-session";
import type { CompanionMessageV1 } from "@astella/shared/companion-conversation-contracts";
import { CompanionChatRecordArticle, messageDayKey, messageDayLabel, messageTime, shouldShowRunTrace } from "../hud/CompanionChatRecord";
import { CompanionRunTraceView } from "./CompanionRunTraceView";
import { CompanionProposalChoice } from "./CompanionProposalChoice";
import { journalProposalNeedsAttention } from "./companion-journal-model";
import { renderCompanionMarkdown } from "../content/companion-markdown";
import { CompanionMessageAudioButton } from "../voice/CompanionMessageAudioButton";

/** 过程以 run 为稳定身份独立排在时间线上，正文由草稿落地为消息时仍是原来的面板。 */
export function CompanionJournalTimeline({ chat, draftText }: {
  readonly chat: CompanionChatSession;
  readonly draftText: string;
}) {
  const activeRunId = chat.phase === "sending" ? chat.draft?.runId ?? chat.processRunId : null;
  const seenRuns = new Set<string>();
  const items: ReactNode[] = [];
  const messages = chat.messages.filter(message => !(activeRunId && message.role === "assistant" && message.runId === activeRunId));
  const addProcess = (runId: string, message?: CompanionMessageV1) => {
    if (seenRuns.has(runId)) return false;
    seenRuns.add(runId);
    const trace = chat.runTraces.find(item => item.summary.runId === runId);
    const hasProcess = Boolean(trace && shouldShowRunTrace(trace));
    items.push(<div className="companion-record__turn companion-history__process-turn" data-role="assistant" key={`process:${runId}`} data-process-run-id={runId}>
      <header><span className="companion-record__author"><i className="companion-record__avatar" aria-hidden="true"><Sparkles size={15} /></i><strong>{chat.companionName}</strong></span>
        <span className="companion-record__meta">{message && chat.messages.filter(item => item.role === "assistant" && item.runId === runId).length <= 1
          ? <CompanionMessageAudioButton runId={runId} /> : null}
          <time>{message ? messageTime(message.createdAt) : chat.draft?.text.trim() ? "正在回复…" : chat.thinking ? "正在思考…" : "正在准备回复…"}</time></span></header>
      {hasProcess && trace ? <CompanionRunTraceView trace={trace} live={runId === activeRunId} /> : null}
    </div>);
    return true;
  };
  messages.forEach((message, index) => {
    const previous = messages[index - 1];
    if (!previous || messageDayKey(previous.createdAt) !== messageDayKey(message.createdAt)) items.push(
      <div className="companion-history__day" key={`day:${message.id}`} data-day-key={messageDayKey(message.createdAt)}>{messageDayLabel(message.createdAt)}</div>);
    let hasRunHeading = false;
    if (message.role === "assistant") {
      const runId = message.runId ?? chat.runTraces.find(trace => trace.summary.assistantMessageId === message.id)?.summary.runId;
      if (runId) hasRunHeading = addProcess(runId, message);
    }
    items.push(<CompanionChatRecordArticle key={message.id} message={message} chat={chat} showTrace={false} showHeader={!hasRunHeading} />);
  });
  const hasActiveHeading = activeRunId ? addProcess(activeRunId) : false;
  if (chat.phase === "sending") {
    const trace = chat.runTraces.find(item => item.summary.runId === activeRunId);
    const choices = [...new Set((trace?.nodes ?? chat.nodes).flatMap(node => node.proposalId ? [node.proposalId] : []))]
      .filter(id => journalProposalNeedsAttention(chat.proposalStates[id]));
    const body = chat.draft?.text.trim() ? draftText : "";
    items.push(<article className="companion-record__turn" key={`draft:${activeRunId ?? "pending"}`} data-role="assistant" data-live="true" data-headerless={hasActiveHeading || undefined}>
      {!hasActiveHeading ? <header><span className="companion-record__author"><i className="companion-record__avatar" aria-hidden="true"><Sparkles size={15} /></i><strong>{chat.companionName}</strong></span>
        <time>{body ? "正在回复…" : chat.thinking ? "正在思考…" : "正在准备回复…"}</time></header> : null}
      {body ? <div className="companion-record__body">{renderCompanionMarkdown(body)}</div> : null}
      {choices.length ? <div className="companion-record__decisions">{choices.map(id => <CompanionProposalChoice key={id} proposalId={id}
        state={chat.proposalStates[id]} context="history" onDecide={decision => { void chat.decideProposal(id, decision); }}
        onRetry={() => chat.retryProposal(id)} />)}</div> : null}
    </article>);
  }
  return <>{items}</>;
}
