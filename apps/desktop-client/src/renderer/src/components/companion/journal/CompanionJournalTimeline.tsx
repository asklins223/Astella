import { type ReactNode } from "react";
import { Sparkles } from "lucide-react";
import type { CompanionChatSession } from "../../../app/companion-session/companion-chat-session";
import type { CompanionMessageV1 } from "@astella/shared/companion-conversation-contracts";
import { CompanionChatRecordArticle, messageDayKey, messageDayLabel, messageTime, shouldShowRunTrace } from "../hud/CompanionChatRecord";
import { CompanionRunTraceView } from "./CompanionRunTraceView";
import { CompanionProposalChoice } from "./CompanionProposalChoice";
import { journalProposalNeedsAttention } from "./companion-journal-model";
import { renderCompanionMarkdown } from "../content/companion-markdown";
import { CompanionRunTiming } from "./CompanionRunTiming";
import { savedCompanionNote } from "../../../app/companion-session/companion-agent-nodes";

/** 过程以 run 为稳定身份独立排在时间线上，正文由草稿落地为消息时仍是原来的面板。 */
export function CompanionJournalTimeline({ chat, draftText }: {
  readonly chat: CompanionChatSession;
  readonly draftText: string;
}) {
  const activeRunId = chat.phase === "sending" ? chat.draft?.runId ?? chat.processRunId : null;
  const seenRuns = new Set<string>();
  const items: ReactNode[] = [];
  const messages = chat.messages.filter(message => {
    if (activeRunId && message.role === "assistant" && message.runId === activeRunId) return false;
    const run = message.runId ? chat.runTraces.find(trace => trace.summary.runId === message.runId)?.summary : undefined;
    // A resumed run may have an old no-content failure message and a real final
    // answer. Keep partial work and receipts; omit only the superseded placeholder.
    const block = message.blocks.length === 1 ? message.blocks[0] : undefined;
    return !(message.kind === "error" && run?.status === "succeeded" && run.assistantMessageId
      && run.assistantMessageId !== message.id && block?.type === "text"
      && ["这次回复没能完成。", "这条回复暂时没能完成。", "这次回复中断了。"].includes(block.text.trim()));
  });
  const addProcess = (runId: string, message?: CompanionMessageV1) => {
    if (seenRuns.has(runId)) return false;
    seenRuns.add(runId);
    const trace = chat.runTraces.find(item => item.summary.runId === runId);
    const hasProcess = Boolean(trace && shouldShowRunTrace(trace));
    // Status events stay in the transport history even when thinking rows replace
    // them in the process panel. Read the actual status, never the model's thoughts.
    const status = runId === activeRunId ? [...trace?.events ?? []].reverse().find(event => event.type === "assistant.status") : undefined;
    const statusPayload = status?.payload as { safeLabel?: unknown } | undefined;
    const liveStatus = typeof statusPayload?.safeLabel === "string" ? statusPayload.safeLabel : null;
    // 名字和时间属于这条助手消息，出现在过程之前；过程只是名字下面的一块可折叠记录。
    // 朗读属于回复正文，放在回复的操作行里，不再顶在过程的头上。
    items.push(<div className="companion-record__turn companion-history__process-turn" data-role="assistant" key={`process:${runId}`} data-process-run-id={runId}>
      <header><span className="companion-record__author"><i className="companion-record__avatar" aria-hidden="true"><Sparkles size={15} /></i><strong>{chat.companionName}</strong></span>
        <time>{message ? messageTime(message.createdAt) : chat.draft?.text.trim() ? "正在回复…" : liveStatus || (chat.thinking ? "正在思考…" : "正在准备回复…")}</time></header>
      {runId === activeRunId ? <CompanionRunTiming runId={runId} startedAt={trace?.summary.createdAt} activityKey={trace?.events?.at(-1)?.seq} active /> : null}
      {hasProcess && trace ? <CompanionRunTraceView trace={trace} live={runId === activeRunId} proposalStates={chat.proposalStates}
        onRecoverRun={chat.recoverRun}
        onDecideProposal={(id, decision) => void chat.decideProposal(id, decision)} onRetryProposal={id => chat.retryProposal(id)} /> : null}
    </div>);
    return true;
  };
  /** 同一个 run 的连续助手消息合成一组；组里只留一个名字，正文各占一个气泡。 */
  const sameRun = (left: CompanionMessageV1 | undefined, right: CompanionMessageV1 | undefined): boolean =>
    left?.role === "assistant" && right?.role === "assistant"
      && (left.runId ?? left.id) === (right.runId ?? right.id);
  messages.forEach((message, index) => {
    const previous = messages[index - 1];
    if (!previous || messageDayKey(previous.createdAt) !== messageDayKey(message.createdAt)) items.push(
      <div className="companion-history__day" key={`day:${message.id}`} data-day-key={messageDayKey(message.createdAt)}>{messageDayLabel(message.createdAt)}</div>);
    const runFirst = message.role === "assistant" && !sameRun(previous, message);
    const runLast = message.role === "assistant" && !sameRun(message, messages[index + 1]);
    let hasRunHeading = false;
    let savedIds: ReadonlySet<string> | undefined;
    if (message.role === "assistant") {
      const runId = message.runId ?? chat.runTraces.find(trace => trace.summary.assistantMessageId === message.id)?.summary.runId;
      if (runId) hasRunHeading = addProcess(runId, message);
      // 同一条运行的成果清单已经把每篇保存过的笔记列在回复下面；正文里那条
      // "打开当前笔记"不再画第二遍，避免同一份成果出现两个入口。
      const trace = runId ? chat.runTraces.find(item => item.summary.runId === runId) : undefined;
      const saved = new Set(trace?.nodes.flatMap(node => {
        const note = savedCompanionNote(node);
        return note ? [note.noteId] : [];
      }) ?? []);
      if (saved.size) savedIds = saved;
    }
    items.push(<CompanionChatRecordArticle key={message.id} message={message} chat={chat} showTrace={false}
      showHeader={runFirst && !hasRunHeading}
      bubble={message.role === "assistant"}
      groupEnd={message.role !== "assistant" || runLast}
      representedNoteIds={savedIds} />);
  });
  const hasActiveHeading = activeRunId ? addProcess(activeRunId) : false;
  if (chat.phase === "sending") {
    const trace = chat.runTraces.find(item => item.summary.runId === activeRunId);
    const choices = [...new Set((trace?.nodes ?? chat.nodes).flatMap(node => node.proposalId ? [node.proposalId] : []))]
      .filter(id => journalProposalNeedsAttention(chat.proposalStates[id]));
    const body = chat.draft?.text.trim() ? draftText : "";
    items.push(<article className="companion-record__turn" key={`draft:${activeRunId ?? "pending"}`} data-role="assistant" data-live="true" data-bubble data-headerless={hasActiveHeading || undefined}>
      {!hasActiveHeading ? <header><span className="companion-record__author"><i className="companion-record__avatar" aria-hidden="true"><Sparkles size={15} /></i><strong>{chat.companionName}</strong></span>
        <time>{body ? "正在回复…" : chat.thinking ? "正在思考…" : "正在准备回复…"}</time></header> : null}
      {body ? <div className="companion-record__body companion-record__body--bubble">{renderCompanionMarkdown(body)}</div> : null}
      {choices.length ? <div className="companion-record__decisions">{choices.map(id => <CompanionProposalChoice key={id} proposalId={id}
        state={chat.proposalStates[id]} context="history" onDecide={decision => { void chat.decideProposal(id, decision); }}
        onRetry={() => chat.retryProposal(id)} />)}</div> : null}
    </article>);
  }
  return <>{items}</>;
}
