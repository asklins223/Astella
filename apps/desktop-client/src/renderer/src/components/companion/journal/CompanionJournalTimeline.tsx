import { Fragment, useRef, type ReactNode } from "react";
import { Sparkles } from "lucide-react";
import { companionMessageText, type CompanionChatSession } from "../../../app/companion-session/companion-chat-session";
import type { CompanionMessageV1 } from "@astella/shared/companion-conversation-contracts";
import { CompanionChatRecordArticle, messageDayKey, messageDayLabel, messageTime, shouldShowRunTrace } from "../hud/CompanionChatRecord";
import { CompanionRunTraceView } from "./CompanionRunTraceView";
import { savedCompanionNote } from "../../../app/companion-session/companion-agent-nodes";
import { useCompanionTypewriter } from "../content/companion-typewriter";

const bodyText = (message: CompanionMessageV1) => companionMessageText({ ...message,
  blocks: message.blocks.filter(block => block.type === "text") });

/** 同一运行在流式、发布和完成三个阶段保留同一个回复区域。 */
function CompanionReplyGroup({ chat, runId, messages, live, received, showProcess = true, identitySuffix = "" }: {
  readonly chat: CompanionChatSession;
  readonly runId: string;
  readonly messages: readonly CompanionMessageV1[];
  readonly live: boolean;
  readonly received: string;
  readonly showProcess?: boolean;
  readonly identitySuffix?: string;
}) {
  const trace = chat.runTraces.find(item => item.summary.runId === runId);
  const saved = messages.map(bodyText).filter(Boolean).join("\n\n");
  const lastReceived = useRef(received);
  if (received) lastReceived.current = received;
  const target = live && received ? received : saved || lastReceived.current;
  const reveal = useCompanionTypewriter(target, live, `${chat.conversationId}:${runId}${identitySuffix}`);
  const status = live ? [...trace?.events ?? []].reverse().find(event => event.type === "assistant.status") : undefined;
  const label = (status?.payload as { safeLabel?: unknown } | undefined)?.safeLabel;
  const savedIds = new Set(trace?.nodes.flatMap(node => {
    const note = savedCompanionNote(node); return note ? [note.noteId] : [];
  }) ?? []);
  const remainder = target.startsWith(saved) ? target.slice(saved.length).replace(/^\n\n/, "") : messages.length ? "" : target;
  // 临时展示项只投影真实 SSE 正文，不保存、不生成服务端身份。
  const displayed = [...messages];
  if (remainder) displayed.push({ version: 1, id: `stream:${runId}`, runId,
    workspaceId: messages[0]?.workspaceId ?? chat.messages[0]?.workspaceId ?? "",
    conversationId: chat.conversationId ?? "", seq: 0, role: "assistant", kind: "text",
    blocks: [{ type: "text", text: remainder }], clientMessageId: null, contentSha256: "",
    createdAt: trace?.summary.createdAt ?? "", editedAt: null });
  let start = 0;
  return <Fragment>
    <div className="companion-record__turn companion-history__process-turn" data-role="assistant" data-process-run-id={runId}>
      <header><span className="companion-record__author"><i className="companion-record__avatar" aria-hidden="true"><Sparkles size={15} /></i><strong>{chat.companionName}</strong></span>
        <time>{messageTime(messages[0]?.createdAt ?? trace?.summary.createdAt ?? "")}</time></header>
      {showProcess && (live || trace && shouldShowRunTrace(trace)) ? <CompanionRunTraceView trace={trace} live={live} runId={runId}
        liveLabel={typeof label === "string" ? label : null}
        liveFallbackLabel={received ? "正在回复…" : chat.thinking ? "正在思考…" : "正在准备回复…"}
        startedAt={trace?.summary.createdAt} activityKey={trace?.events?.at(-1)?.seq}
        proposalStates={chat.proposalStates} onRecoverRun={chat.recoverRun}
        onDecideProposal={(id, decision) => void chat.decideProposal(id, decision)} onRetryProposal={id => chat.retryProposal(id)} /> : null}
    </div>
    {displayed.map((message, index) => {
      const full = bodyText(message);
      const offset = start; start += full.length + (full ? 2 : 0);
      const visible = reveal.text.slice(offset, offset + full.length);
      const hasRichContent = message.blocks.some(block => block.type !== "text");
      if (!visible && !hasRichContent) return null;
      return <CompanionChatRecordArticle key={`body:${index}`} message={message} chat={chat} showTrace={false} showHeader={false}
        bubble groupEnd={index === displayed.length - 1} representedNoteIds={savedIds}
        responseText={visible} responseBusy={live || reveal.busy} />;
    })}
  </Fragment>;
}

export function CompanionJournalTimeline({ chat }: { readonly chat: CompanionChatSession }) {
  const activeRunId = chat.phase === "sending" ? chat.draft?.runId ?? chat.processRunId : null;
  const scope = useRef(chat.conversationId);
  const pending = useRef(new Map<string, string>());
  if (scope.current !== chat.conversationId) { scope.current = chat.conversationId; pending.current.clear(); }
  if (activeRunId) pending.current.set(activeRunId, chat.draft?.text ?? pending.current.get(activeRunId) ?? "");
  const seenRuns = new Set<string>();
  const items: ReactNode[] = [];
  const messages = chat.messages.filter(message => {
    const run = message.runId ? chat.runTraces.find(trace => trace.summary.runId === message.runId)?.summary : undefined;
    const block = message.blocks.length === 1 ? message.blocks[0] : undefined;
    return !(message.kind === "error" && run?.status === "succeeded" && run.assistantMessageId
      && run.assistantMessageId !== message.id && block?.type === "text"
      && ["这次回复没能完成。", "这条回复暂时没能完成。", "这次回复中断了。"].includes(block.text.trim()));
  });
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    const previous = messages[index - 1];
    if (!previous || messageDayKey(previous.createdAt) !== messageDayKey(message.createdAt)) items.push(
      <div className="companion-history__day" key={`day:${message.id}`} data-day-key={messageDayKey(message.createdAt)}>{messageDayLabel(message.createdAt)}</div>);
    if (message.role !== "assistant") {
      items.push(<CompanionChatRecordArticle key={message.id} message={message} chat={chat} showTrace={false} />);
      continue;
    }
    const runId = message.runId ?? message.id;
    const firstGroup = !seenRuns.has(runId);
    seenRuns.add(runId);
    const group = [message];
    while (messages[index + 1]?.role === "assistant" && (messages[index + 1]?.runId ?? messages[index + 1]?.id) === runId) {
      group.push(messages[++index]!);
    }
    const later = messages.slice(index + 1).some(item => item.role === "assistant" && (item.runId ?? item.id) === runId);
    const live = runId === activeRunId && !later;
    const earlier = messages.slice(0, index - group.length + 1)
      .filter(item => item.role === "assistant" && (item.runId ?? item.id) === runId).map(bodyText).filter(Boolean).join("\n\n");
    const raw = live ? chat.draft?.text ?? "" : "";
    const received = earlier && raw.startsWith(earlier) ? raw.slice(earlier.length).replace(/^\n\n/, "") : raw;
    items.push(<CompanionReplyGroup key={firstGroup ? `reply:${runId}` : `reply:${runId}:${message.id}`}
      chat={chat} runId={runId} messages={group} live={live} received={received} showProcess={firstGroup}
      identitySuffix={firstGroup ? "" : `:${message.id}`} />);
    if (runId !== activeRunId) pending.current.delete(runId);
  }
  for (const [runId, received] of pending.current) {
    if (seenRuns.has(runId)) continue;
    if (runId !== activeRunId && !received) { pending.current.delete(runId); continue; }
    items.push(<CompanionReplyGroup key={`reply:${runId}`} chat={chat} runId={runId} messages={[]}
      live={runId === activeRunId} received={received} />);
  }
  return <>{items}</>;
}
