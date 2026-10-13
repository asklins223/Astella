import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, CircleCheck, CircleDashed, TriangleAlert, X } from "lucide-react";
import { companionRunTraceExpired, nodeLabel, type CompanionRunTrace } from "../../app/companion-agent-nodes";
import { companionProcessPreview, companionProcessRows, type CompanionProcessRow } from "../../app/companion-process-timeline";
import type { CompanionProposalUiState } from "../../app/companion-chat-session";
import { CompanionProposalChoice } from "./CompanionProposalChoice";

const NODE_STATE_LABEL = { running: "进行中", succeeded: "已完成", waiting_confirmation: "待确认",
  outcome_unknown: "结果待核对", failed: "失败", cancelled: "已停止", not_executed: "没有开始", unavailable: "这次用不了" } as const;
type NodeState = keyof typeof NODE_STATE_LABEL;

function displayedNodeState(state: NodeState, runStatus: string): NodeState {
  if (state !== "running" && state !== "waiting_confirmation") return state;
  if (runStatus === "succeeded") return "succeeded";
  if (runStatus === "failed") return "failed";
  if (["cancelled", "cancel_requested", "superseded"].includes(runStatus)) return "cancelled";
  return state;
}

function stateMark(state: NodeState) {
  if (state === "succeeded") return <CircleCheck size={14} />;
  if (state === "cancelled") return <X size={14} />;
  if (["failed", "outcome_unknown", "not_executed", "unavailable"].includes(state)) return <TriangleAlert size={14} />;
  return <CircleDashed size={14} />;
}

function ProcessStep({ row, state, proposalStates, onDecideProposal, onRetryProposal }: {
  readonly row: CompanionProcessRow;
  readonly state: NodeState;
  readonly proposalStates?: Readonly<Record<string, CompanionProposalUiState>>;
  readonly onDecideProposal?: (proposalId: string, decision: "confirm" | "reject") => void;
  readonly onRetryProposal?: (proposalId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const thinking = row.kind === "thinking";
  const text = thinking ? row.text : row.node.summary ?? "";
  const label = thinking ? state === "running" ? "正在思考" : "已思考" : nodeLabel(row.node);
  return <details className={`companion-history__trace-step ${thinking ? "companion-history__trace-thinking" : "companion-history__trace-tool"}`} open={expanded}>
    <summary aria-expanded={expanded} aria-label={`${expanded ? "收起" : "展开"}${thinking ? "这段思考" : "这项操作详情"}`}
      onClick={event => { event.preventDefault(); setExpanded(current => !current); }}>
      <span className="companion-history__trace-mark" aria-hidden="true">{stateMark(state)}</span>
      <strong>{label}</strong>
      {!thinking ? <small>{NODE_STATE_LABEL[state]}</small> : null}
      {text ? <span className="companion-history__trace-separator" aria-hidden="true">·</span> : null}
      <span className="companion-history__trace-step-preview" aria-hidden="true">{text.replace(/\s+/g, " ").trim()}</span>
    </summary>
    <div className="companion-history__trace-step-detail">
      <p>{text || NODE_STATE_LABEL[state]}</p>
      {row.kind === "node" && row.node.proposalId && proposalStates && onDecideProposal ? <CompanionProposalChoice
        proposalId={row.node.proposalId} state={proposalStates[row.node.proposalId]} context="history"
        onDecide={decision => onDecideProposal(row.node.proposalId!, decision)}
        onRetry={onRetryProposal ? () => onRetryProposal(row.node.proposalId!) : undefined} /> : null}
    </div>
  </details>;
}

/** 实时、收尾与历史共用；流更新不接管用户的展开状态。 */
export function CompanionRunTraceView({ trace, defaultOpen = false, live = false,
  proposalStates, onDecideProposal, onRetryProposal,
}: {
  readonly trace: CompanionRunTrace;
  readonly defaultOpen?: boolean;
  readonly live?: boolean;
  readonly quiet?: boolean;
  readonly proposalStates?: Readonly<Record<string, CompanionProposalUiState>>;
  readonly onDecideProposal?: (proposalId: string, decision: "confirm" | "reject") => void;
  readonly onRetryProposal?: (proposalId: string) => void;
}) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const previewRef = useRef<HTMLSpanElement>(null);
  const rows = useMemo(() => companionProcessRows(trace), [trace.events, trace.nodes, trace.summary.thinkingText]);
  const preview = companionProcessPreview(trace, rows).replace(/\s+/g, " ").trim().slice(-360);
  const hasThinking = rows.some(row => row.kind === "thinking");
  const toolCount = Math.max(trace.summary.toolCallCount, trace.nodes.filter(node => node.kind === "tool").length);
  const label = toolCount ? `执行工具 ${toolCount} 次` : hasThinking ? live ? "思考中" : "思考记录" : "处理过程";
  useLayoutEffect(() => {
    const element = previewRef.current;
    if (element) element.scrollLeft = element.scrollWidth;
  }, [preview, expanded]);
  if (!rows.length && !toolCount && !companionRunTraceExpired(trace)) return null;
  return <details className="companion-history__trace" open={expanded} data-live={live || undefined}>
    <summary aria-expanded={expanded} aria-label={`${expanded ? "收起" : "展开"}${label}`}
      onClick={event => { event.preventDefault(); setExpanded(current => !current); }}>
      <ChevronRight className="companion-history__trace-chevron" size={15} aria-hidden="true" />
      <span className="companion-history__trace-label">{label}</span>
      <span ref={previewRef} className="companion-history__trace-preview" aria-hidden="true">{preview}</span>
    </summary>
    <ol className="companion-history__trace-timeline">
      {rows.map(row => {
        const state = row.kind === "thinking" ? live && row === rows.at(-1) ? "running" : "succeeded"
          : displayedNodeState(row.node.state, trace.summary.status);
        return <li key={row.key} data-state={state} data-kind={row.kind}>
          <ProcessStep row={row} state={state} proposalStates={proposalStates} onDecideProposal={onDecideProposal} onRetryProposal={onRetryProposal} />
        </li>;
      })}
    </ol>
    {companionRunTraceExpired(trace) ? <p className="companion-history__trace-expired">这条旧对话的过程详情未留存。</p> : null}
  </details>;
}
