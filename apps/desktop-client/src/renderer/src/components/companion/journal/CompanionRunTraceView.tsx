import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { canResumeCompanionRun } from "@astella/shared/companion-chat-desktop-contracts";
import { gatewayErrorMessage } from "../../../app/client/desktop-client";
import { companionReplyFailureMessage } from "../../../app/companion-session/companion-chat-routing";
import { ChevronRight, CircleCheck, CircleDashed, Loader2, Sparkles, TriangleAlert, Wrench, X } from "lucide-react";
import { companionRunTraceExpired, nodeLabel, savedCompanionNote, type CompanionRunTrace } from "../../../app/companion-session/companion-agent-nodes";
import { companionProcessPreview, companionProcessRows, companionProcessNodeSummary, type CompanionProcessRow } from "../../../app/companion-session/companion-process-timeline";
import type { CompanionProposalUiState } from "../../../app/companion-session/companion-chat-session";
import { CompanionProposalChoice } from "./CompanionProposalChoice";
import { useJournalDisclosure } from "./companion-journal-view-state";
import { previewCompanionNote } from "./companion-result-preview";
import { companionElapsedLabel, useRunElapsed } from "./CompanionRunTiming";
import { CompanionThinkingStatus } from "../content/companion-typewriter";
import { useRoomStore } from "../../../app/home/room-store";

const NODE_STATE_LABEL = { running: "进行中", succeeded: "已完成", waiting_confirmation: "待确认",
  outcome_unknown: "结果待核对", failed: "失败", cancelled: "已停止", not_executed: "没有开始", unavailable: "这次用不了" } as const;
type NodeState = keyof typeof NODE_STATE_LABEL;

function displayedNodeState(state: NodeState, runStatus: string, tool: boolean): NodeState {
  if (state !== "running" && state !== "waiting_confirmation") return state;
  if (!tool && runStatus === "succeeded") return "succeeded";
  if (!tool && runStatus === "failed") return "failed";
  if (runStatus === "succeeded" || runStatus === "failed") return state === "running" ? "outcome_unknown" : state;
  if (["cancelled", "cancel_requested", "superseded"].includes(runStatus)) return "cancelled";
  return state;
}

function stateMark(state: NodeState) {
  if (state === "succeeded") return <CircleCheck size={14} />;
  if (state === "cancelled") return <X size={14} />;
  if (["failed", "outcome_unknown", "not_executed", "unavailable"].includes(state)) return <TriangleAlert size={14} />;
  return <CircleDashed size={14} />;
}

function ProcessStep({ row, state, runId, streaming, proposalStates, onDecideProposal, onRetryProposal }: {
  readonly row: CompanionProcessRow;
  readonly state: NodeState;
  readonly runId: string;
  readonly streaming: boolean;
  readonly proposalStates?: Readonly<Record<string, CompanionProposalUiState>>;
  readonly onDecideProposal?: (proposalId: string, decision: "confirm" | "reject") => void;
  readonly onRetryProposal?: (proposalId: string) => void;
}) {
  const thinking = row.kind === "thinking";
  const [expanded, toggle] = useJournalDisclosure(`${runId}:${row.key}`);
  const text = thinking ? row.text : companionProcessNodeSummary(row.node);
  // 思考是一段可自由开合的内容，默认收起：过程展开时先看到“想过什么”的摘要，
  // 需要读全文再点开。实时那一行在气泡里，手记不替用户把整段思考摊开。
  if (thinking) {
    return <div className="companion-history__trace-step companion-history__trace-thinking">
      <div className="companion-history__trace-thinking-head">
        <span className="companion-history__trace-mark" aria-hidden="true">{stateMark(state)}</span>
        <strong>{state === "running" ? "正在思考" : "思考"}</strong>
      </div>
      <div className="companion-history__trace-step-detail"><p>{text || (state === "running" ? "正在思考…" : "这一段没有留下文字。")}</p></div>
    </div>;
  }
  const savedNote = row.kind === "node" ? savedCompanionNote(row.node) : null;
  return <details className="companion-history__trace-step companion-history__trace-tool" open={expanded}>
    <summary aria-expanded={expanded} aria-label={`${expanded ? "收起" : "展开"}这项操作详情`}
      onClick={event => { event.preventDefault(); toggle(); }}>
      <span className="companion-history__trace-mark" aria-hidden="true">{stateMark(state)}</span>
      <strong>{nodeLabel(row.node)}</strong>
      <small>{NODE_STATE_LABEL[state]}</small>
    </summary>
    <div className="companion-history__trace-step-detail">
      <p>{text || NODE_STATE_LABEL[state]}</p>
      {savedNote ? <button type="button" className="companion-result-link"
        onClick={event => previewCompanionNote({ ...savedNote, runId }, event.currentTarget)}>预览《{savedNote.title}》</button> : null}
      {row.kind === "node" && row.node.proposalId && proposalStates && onDecideProposal ? <CompanionProposalChoice
        proposalId={row.node.proposalId} state={proposalStates[row.node.proposalId]} context="history"
        onDecide={decision => onDecideProposal(row.node.proposalId!, decision)}
        onRetry={onRetryProposal ? () => onRetryProposal(row.node.proposalId!) : undefined} /> : null}
    </div>
  </details>;
}

/** Stream the current step openly; completed history stays compact unless chosen. */
export function CompanionRunTraceView({ trace, live = false, runId, liveLabel, liveFallbackLabel,
  startedAt, activityKey, proposalStates, onDecideProposal, onRetryProposal, onRecoverRun,
}: {
  readonly trace?: CompanionRunTrace;
  readonly live?: boolean;
  readonly runId?: string;
  readonly liveLabel?: string | null;
  readonly liveFallbackLabel?: string;
  readonly startedAt?: string;
  readonly activityKey?: string | number;
  readonly quiet?: boolean;
  readonly proposalStates?: Readonly<Record<string, CompanionProposalUiState>>;
  readonly onDecideProposal?: (proposalId: string, decision: "confirm" | "reject") => void;
  readonly onRetryProposal?: (proposalId: string) => void;
  readonly onRecoverRun?: (runId: string, reconcileOnly?: boolean) => Promise<string>;
}) {
  const summary = trace?.summary;
  const nodes = trace?.nodes ?? [];
  const streaming = live && (!summary || ["accepted", "running"].includes(summary.status));
  const clockRunId = summary?.runId ?? runId ?? "live";
  const rows = useMemo(() => trace ? companionProcessRows(trace) : [], [trace]);
  const [expanded, toggle] = useJournalDisclosure(clockRunId, streaming);
  const viewport = useRef<HTMLOListElement>(null);
  const followsActivity = useRef(true);
  const reduced = useRoomStore(state => state.reducedMotion || state.motionMode === "off");
  useLayoutEffect(() => {
    const list = viewport.current;
    if (!list || !expanded) return;
    if (!streaming) { list.scrollTop = 0; return; }
    if (followsActivity.current) list.scrollTo?.({ top: list.scrollHeight, behavior: reduced ? "instant" : "smooth" });
  }, [trace, expanded, streaming, reduced]);
  const [recovering, setRecovering] = useState(false);
  const [recoveryNotice, setRecoveryNotice] = useState("");
  const { elapsed, idle } = useRunElapsed({
    runId: clockRunId,
    startedAt: startedAt ?? summary?.createdAt,
    activityKey,
    active: streaming,
  });
  const resume = summary ? canResumeCompanionRun(summary) : false;
  const unknown = nodes.some(node => node.state === "outcome_unknown");
  const recover = async (reconcileOnly: boolean) => {
    if (!onRecoverRun || recovering) return;
    setRecovering(true);
    try { setRecoveryNotice(await onRecoverRun(clockRunId, reconcileOnly)); }
    catch (error) { setRecoveryNotice(gatewayErrorMessage(error)); }
    finally { setRecovering(false); }
  };
  const preview = trace ? companionProcessPreview(trace, rows).replace(/\s+/g, " ").trim().slice(-360) : "";
  const hasThinking = rows.some(row => row.kind === "thinking");
  const toolCount = Math.max(summary?.toolCallCount ?? 0, nodes.filter(node => node.kind === "tool").length);
  const expired = trace ? companionRunTraceExpired(trace) : false;
  const disclosureAvailable = rows.length > 0 || toolCount > 0 || expired || resume;
  const runningNode = rows.find((row): row is Extract<CompanionProcessRow, { kind: "node" }> =>
    row.kind === "node" && row.node.state === "running");
  // 「正在准备回复…」只是传输层的占位状态；手记里已经能看到她真的在想或已经在写，
  // 就用后者，别让摘要和下面那一行说两套话。宿主给出具体进度时仍以宿主为准。
  const hostLabel = liveLabel?.trim() ?? "";
  const genericHost = !hostLabel || hostLabel === "正在准备回复…";
  const liveText = runningNode ? nodeLabel(runningNode.node)
    : (genericHost ? liveFallbackLabel : hostLabel) || hostLabel || "正在准备回复…";
  const label = streaming ? liveText : hasThinking ? "思考与过程" : toolCount ? `执行工具 ${toolCount} 次` : "处理过程";
  const delayed = streaming && idle >= 10;
  const showElapsed = streaming && elapsed >= 2;
  if (!trace && !live) return null;
  if (trace && !disclosureAvailable && !live) return null;
  const headerContent = <>
    <span className="companion-history__trace-state" aria-hidden="true">
      {!streaming ? hasThinking ? <Sparkles size={14} /> : <Wrench size={14} /> : null}
    </span>
    <span className="companion-history__trace-label">{streaming ? <CompanionThinkingStatus>{label}</CompanionThinkingStatus> : label}</span>
    {!expanded && rows.length ? <small className="companion-history__trace-count">{rows.length} 个步骤</small> : null}
    {showElapsed ? <span className="companion-history__trace-elapsed">已用时 {companionElapsedLabel(elapsed)}</span> : null}
    {!expanded && !streaming && preview ? <span className="companion-history__trace-preview" aria-hidden="true">{preview}</span> : null}
    {disclosureAvailable ? <ChevronRight className="companion-history__trace-chevron" size={15} aria-hidden="true" /> : null}
  </>;
  const delayNote = delayed ? <p className="companion-run-delay" role="status">
    {idle >= 30 ? "暂时没有新进展，已有成果仍可查看；可停止这一轮。" : "这一步比平时久，仍在等待服务返回。"}
  </p> : null;
  if (!disclosureAvailable) {
    return <div className="companion-history__trace companion-history__trace--static" data-live={streaming || undefined} role="status">
      <div className="companion-history__trace-live-row">{headerContent}</div>
      {delayNote}
    </div>;
  }
  return <><details className="companion-history__trace" open={expanded} data-live={streaming || undefined}>
    <summary aria-expanded={expanded} aria-label={`${expanded ? "收起" : "展开"}${label}`}
      onClick={event => { event.preventDefault(); toggle(); }}>
      {headerContent}
    </summary>
    {delayNote}
    <ol className="companion-history__trace-timeline" ref={viewport} aria-busy={streaming}
      onWheel={() => { followsActivity.current = false; }}
      onTouchStart={() => { followsActivity.current = false; }}
      onScroll={event => { const list = event.currentTarget;
        if (list.scrollHeight - list.scrollTop - list.clientHeight < 16) followsActivity.current = true;
      }}>
      {rows.map(row => {
        const state = row.kind === "thinking" ? streaming && row === rows.at(-1) ? "running" : "succeeded"
          : displayedNodeState(row.node.state, summary?.status ?? "running", row.node.kind === "tool");
        return <li key={row.key} data-state={state} data-kind={row.kind}>
          <ProcessStep row={row} runId={clockRunId} state={state} streaming={streaming} proposalStates={proposalStates} onDecideProposal={onDecideProposal} onRetryProposal={onRetryProposal} />
        </li>;
      })}
    </ol>
    {expired ? <p className="companion-history__trace-expired">这条旧对话的过程详情未留存。</p> : null}
  </details>
    {onRecoverRun && (resume || unknown) ? <div className="companion-history__recovery">
      <p>{unknown ? "有操作尚未取得确定回执，先核对保存结果。" : companionReplyFailureMessage(summary?.errorCode, true)}</p>
      {unknown ? <button type="button" disabled={recovering} onClick={() => void recover(true)}>核对保存结果</button> : null}
      {resume ? <button type="button" disabled={recovering} onClick={() => void recover(false)}>从中断处继续</button> : null}
    </div> : null}
    {recoveryNotice ? <p role="status">{recoveryNotice}</p> : null}
  </>;
}
