import { useMemo, useState } from "react";
import { canResumeCompanionRun } from "@astella/shared/companion-chat-desktop-contracts";
import { gatewayErrorMessage } from "../../../app/client/desktop-client";
import { companionReplyFailureMessage } from "../../../app/companion-session/companion-chat-routing";
import { ChevronRight, CircleCheck, CircleDashed, TriangleAlert, X } from "lucide-react";
import { companionRunTraceExpired, nodeLabel, savedCompanionNote, type CompanionRunTrace } from "../../../app/companion-session/companion-agent-nodes";
import { companionProcessPreview, companionProcessRows, companionProcessNodeSummary, type CompanionProcessRow } from "../../../app/companion-session/companion-process-timeline";
import type { CompanionProposalUiState } from "../../../app/companion-session/companion-chat-session";
import { CompanionProposalChoice } from "./CompanionProposalChoice";
import { useJournalDisclosure } from "./companion-journal-view-state";
import { previewCompanionNote } from "./companion-result-preview";

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
  const [expanded, toggle] = useJournalDisclosure(`${runId}:${row.key}`, !thinking && streaming && state === "running");
  const text = thinking ? row.text : companionProcessNodeSummary(row.node);
  // 思考是一段可自由开合的内容，默认收起：过程展开时先看到“想过什么”的摘要，
  // 需要读全文再点开。实时那一行在气泡里，手记不替用户把整段思考摊开。
  if (thinking) {
    return <details className="companion-history__trace-step companion-history__trace-thinking" open={expanded}>
      <summary aria-expanded={expanded} aria-label={`${expanded ? "收起" : "展开"}这段思考`}
        onClick={event => { event.preventDefault(); toggle(); }}>
        <span className="companion-history__trace-mark" aria-hidden="true">{stateMark(state)}</span>
        <strong>{state === "running" ? "正在思考" : "思考"}</strong>
        {!expanded && text ? <span className="companion-history__trace-step-preview" aria-hidden="true">{text.replace(/\s+/g, " ").trim()}</span> : null}
      </summary>
      <div className="companion-history__trace-step-detail"><p>{text || (state === "running" ? "正在思考…" : "这一段没有留下文字。")}</p></div>
    </details>;
  }
  const savedNote = row.kind === "node" ? savedCompanionNote(row.node) : null;
  return <details className="companion-history__trace-step companion-history__trace-tool" open={expanded}>
    <summary aria-expanded={expanded} aria-label={`${expanded ? "收起" : "展开"}这项操作详情`}
      onClick={event => { event.preventDefault(); toggle(); }}>
      <span className="companion-history__trace-mark" aria-hidden="true">{stateMark(state)}</span>
      <strong>{nodeLabel(row.node)}</strong>
      <small>{NODE_STATE_LABEL[state]}</small>
      {text ? <span className="companion-history__trace-separator" aria-hidden="true">·</span> : null}
      <span className="companion-history__trace-step-preview" aria-hidden="true">{text.replace(/\s+/g, " ").trim()}</span>
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
export function CompanionRunTraceView({ trace, live = false,
  proposalStates, onDecideProposal, onRetryProposal, onRecoverRun,
}: {
  readonly trace: CompanionRunTrace;
  readonly live?: boolean;
  readonly quiet?: boolean;
  readonly proposalStates?: Readonly<Record<string, CompanionProposalUiState>>;
  readonly onDecideProposal?: (proposalId: string, decision: "confirm" | "reject") => void;
  readonly onRetryProposal?: (proposalId: string) => void;
  readonly onRecoverRun?: (runId: string, reconcileOnly?: boolean) => Promise<string>;
}) {
  const streaming = live && ["accepted", "running"].includes(trace.summary.status);
  const [expanded, toggle] = useJournalDisclosure(trace.summary.runId, streaming);
  const [recovering, setRecovering] = useState(false);
  const [recoveryNotice, setRecoveryNotice] = useState("");
  const resume = canResumeCompanionRun(trace.summary);
  const unknown = trace.nodes.some(node => node.state === "outcome_unknown");
  const recover = async (reconcileOnly: boolean) => {
    if (!onRecoverRun || recovering) return;
    setRecovering(true);
    try { setRecoveryNotice(await onRecoverRun(trace.summary.runId, reconcileOnly)); }
    catch (error) { setRecoveryNotice(gatewayErrorMessage(error)); }
    finally { setRecovering(false); }
  };
  const rows = useMemo(() => companionProcessRows(trace), [trace.events, trace.nodes, trace.summary.thinkingText]);
  const preview = companionProcessPreview(trace, rows).replace(/\s+/g, " ").trim().slice(-360);
  const hasThinking = rows.some(row => row.kind === "thinking");
  const toolCount = Math.max(trace.summary.toolCallCount, trace.nodes.filter(node => node.kind === "tool").length);
  const label = hasThinking ? "思考与过程" : toolCount ? `执行工具 ${toolCount} 次` : "处理过程";
  if (!rows.length && !toolCount && !companionRunTraceExpired(trace) && !resume) return null;
  return <><details className="companion-history__trace" open={expanded} data-live={streaming || undefined}>
    <summary aria-expanded={expanded} aria-label={`${expanded ? "收起" : "展开"}${label}`}
      onClick={event => { event.preventDefault(); toggle(); }}>
      <ChevronRight className="companion-history__trace-chevron" size={15} aria-hidden="true" />
      <span className="companion-history__trace-label">{label}</span>
      {!expanded ? <span className="companion-history__trace-preview" aria-hidden="true">{preview}</span> : null}
    </summary>
    <ol className="companion-history__trace-timeline">
      {rows.map(row => {
        const state = row.kind === "thinking" ? streaming && row === rows.at(-1) ? "running" : "succeeded"
          : displayedNodeState(row.node.state, trace.summary.status, row.node.kind === "tool");
        return <li key={row.key} data-state={state} data-kind={row.kind}>
          <ProcessStep row={row} runId={trace.summary.runId} state={state} streaming={streaming} proposalStates={proposalStates} onDecideProposal={onDecideProposal} onRetryProposal={onRetryProposal} />
        </li>;
      })}
    </ol>
    {companionRunTraceExpired(trace) ? <p className="companion-history__trace-expired">这条旧对话的过程详情未留存。</p> : null}
  </details>
    {onRecoverRun && (resume || unknown) ? <div className="companion-history__recovery">
      <p>{unknown ? "有操作尚未取得确定回执，先核对保存结果。" : companionReplyFailureMessage(trace.summary.errorCode, true)}</p>
      {unknown ? <button type="button" disabled={recovering} onClick={() => void recover(true)}>核对保存结果</button> : null}
      {resume ? <button type="button" disabled={recovering} onClick={() => void recover(false)}>从中断处继续</button> : null}
    </div> : null}
    {recoveryNotice ? <p role="status">{recoveryNotice}</p> : null}
  </>;
}
