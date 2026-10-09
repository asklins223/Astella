import { useEffect, useId, useState } from "react";
import {
  BarChart3,
  Bell,
  BookOpen,
  Brain,
  CalendarClock,
  Check,
  ChevronDown,
  CircleDashed,
  Ear,
  FileText,
  History,
  Layers,
  ListChecks,
  Network,
  ScanSearch,
  Sparkles,
  Square,
  TriangleAlert,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  countAgentToolCalls,
  type CompanionAgentNode,
  type CompanionAgentNodes,
  nodeLabel,
} from "../../app/companion-agent-nodes";

/** 实际工具调用的独立过程气泡。执行状态来自 SSE，展开只改变阅读范围。 */

/** 本 run 的真实消耗。来自 `companion_turn_runs`，不是客户端数事件数出来的。 */
export interface CompanionAgentRailProgress {
  readonly stepCount: number;
  readonly maxSteps: number;
  readonly toolCallCount: number;
  readonly maxToolCalls: number;
}

export type CompanionAgentRailTurnState = "running" | "done" | "stopped" | "failed";

/**
 * 工具名 → 图标。方案 §1 要求「按工具名映射（打开卡片/复习/星图等）」。
 * 名字取自执行器的 switch（`companion-agent-runtime.ts`）；不认识的一律扳手，
 * 不猜语义（猜错比不认识更坏）。
 */
const TOOL_ICONS: Record<string, LucideIcon> = {
  companion_read_context: ScanSearch,
  companion_read_history: History,
  companion_read_memory: Brain,
  companion_open_card: Layers,
  companion_open_page: Network,
  companion_open_note: FileText,
  companion_search_notes: ScanSearch,
  companion_read_note: FileText,
  companion_create_note: FileText,
  companion_edit_note: FileText,
  companion_get_learning_stats: BarChart3,
  companion_list_task_queue: ListChecks,
  companion_list_due_reviews: CalendarClock,
  companion_schedule_reminder: Bell,
  companion_list_reminders: Bell,
  companion_cancel_reminder: Bell,
  companion_start_learning: Sparkles,
};

function nodeIcon(node: CompanionAgentNode): LucideIcon {
  // 等待 ≠ 思考：本轮没开思考档时服务端只会发 `waiting`，
  // 这里也就不会给她挂一本"正在想"的书。
  if (node.kind === "waiting") return Ear;
  if (node.kind === "acting") return Wrench;
  if (node.kind === "thinking") return BookOpen;
  return (node.toolName ? TOOL_ICONS[node.toolName] : undefined) ?? Wrench;
}

const STATE_LABEL: Record<CompanionAgentNode["state"], string> = {
  running: "进行中",
  succeeded: "已完成",
  waiting_confirmation: "等你确认",
  outcome_unknown: "结果待核对",
  failed: "未完成",
  cancelled: "已停止",
  not_executed: "没有开始",
  unavailable: "这次用不了",
};

function nodeMark(node: CompanionAgentNode) {
  if (node.state === "succeeded") return <Check size={14} aria-hidden="true" />;
  if (["failed", "outcome_unknown", "not_executed", "unavailable"].includes(node.state)) return <TriangleAlert size={14} aria-hidden="true" />;
  if (node.state === "cancelled") return <X size={14} aria-hidden="true" />;
  return <CircleDashed size={14} aria-hidden="true" />;
}

export function CompanionAgentRail({ nodes, progress, turnState, companionName, onActivity, onReadingChange, onDismiss, onStop, stopping = false }: {
  readonly nodes: CompanionAgentNodes;
  readonly progress: CompanionAgentRailProgress | null;
  readonly turnState: CompanionAgentRailTurnState;
  readonly companionName: string;
  readonly onActivity?: () => void;
  readonly onReadingChange?: (open: boolean) => void;
  readonly onDismiss?: () => void;
  readonly onStop?: () => void;
  readonly stopping?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  useEffect(() => {
    onReadingChange?.(expanded);
    return () => onReadingChange?.(false);
  }, [expanded, onReadingChange]);

  // 等待模型与思考帧不构成工具调用，普通聊天始终不生成这张气泡。
  const tools = nodes.filter(node => node.kind === "tool");
  if (tools.length === 0) return null;
  const latestFirst = [...tools].reverse();
  const unresolved = latestFirst.find(node => node.state === "outcome_unknown") ?? latestFirst.find(node => node.state === "waiting_confirmation");
  const running = latestFirst.find(node => node.state === "running");
  const issue = latestFirst.find(node => ["failed", "not_executed", "unavailable", "cancelled"].includes(node.state));
  const current = unresolved ?? running ?? issue ?? tools[tools.length - 1];
  const count = Math.max(progress?.toolCallCount ?? 0, countAgentToolCalls(tools));
  const completed = tools.filter(node => node.state === "succeeded").length;
  const state = unresolved?.state ?? (turnState === "failed" ? "failed"
    : turnState === "stopped" ? "cancelled" : turnState === "running" && running ? "running" : issue?.state ?? (turnState === "running" ? "running" : running ? "outcome_unknown" : "succeeded"));
  const composing = turnState === "running" && !running && !unresolved && !issue;
  const active = turnState === "running" && !composing;
  const headline = composing ? "正在组织回复…" : active || unresolved || issue ? nodeLabel(current)
    : state === "succeeded" ? "操作已完成" : state === "failed" ? "回复未完成" : STATE_LABEL[state];
  const CurrentIcon = composing ? BookOpen : state === "succeeded" && !active ? Check : state === "cancelled" ? X : nodeIcon(current);
  const countText = `${count} 项操作`;

  return (
    <section className="companion-hud__rail" data-turn={turnState} data-state={state}
      data-expanded={expanded || undefined}
      onPointerMove={onActivity} onWheel={onActivity} onKeyDown={onActivity} onFocus={onActivity}
      aria-label={`${companionName} 的做事经过`}>
      <header className="companion-hud__rail-heading">
        <strong><Wrench size={13} aria-hidden="true" />做事经过</strong>
        <div className="companion-hud__rail-actions"><button type="button" className="text-action" aria-expanded={expanded} aria-controls={detailsId}
          onClick={() => { onActivity?.(); setExpanded(value => !value); }}>
          {expanded ? "收起过程" : "查看过程"}<ChevronDown size={12} aria-hidden="true" />
        </button>
        {turnState === "running" && onStop ? <button type="button" className="text-action" onClick={onStop} disabled={stopping} aria-label="停止这一轮"><Square size={10} fill="currentColor" aria-hidden="true" />{stopping ? "停止中" : "停止"}</button>
          : onDismiss ? <button type="button" className="text-action companion-hud__rail-dismiss" onClick={onDismiss} aria-label="收起做事经过"><X size={14} /></button> : null}</div>
      </header>
      <div className="companion-hud__rail-current" role="status" aria-live="polite" aria-atomic="true" aria-label={`${companionName} 正在做的事`}>
        <span className="companion-hud__rail-current-icon" aria-hidden="true"><CurrentIcon size={18} /></span>
        <div><p>{headline}</p><span>{state === "succeeded" ? countText : <>{composing ? "工具操作已结束" : STATE_LABEL[state]}<span aria-hidden="true"> · </span>{countText}</>}</span></div>
      </div>
      {expanded ? <div id={detailsId} className="companion-hud__rail-details">
        <ol className="companion-hud__rail-steps">
          {tools.map(node => {
            const Icon = nodeIcon(node);
            return <li key={node.key} data-state={node.state}>
              <span className="companion-hud__rail-icon"><Icon size={14} aria-hidden="true" /></span>
              <div className="companion-hud__rail-label"><span>{nodeLabel(node)}</span>{node.summary ? <small>{node.summary}</small> : null}</div>
              <span className="companion-hud__rail-mark">{nodeMark(node)}<span>{STATE_LABEL[node.state]}</span></span>
            </li>;
          })}
        </ol>
        <p className="companion-hud__rail-summary">已完成 {completed} 项 · 共 {countText}{progress && progress.stepCount > 0 ? ` · ${progress.stepCount} 步` : ""}</p>
      </div> : <div id={detailsId} hidden />}
    </section>
  );
}
