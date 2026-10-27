import { useEffect, useId } from "react";
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
  savedCompanionNote,
} from "../../../app/companion-session/companion-agent-nodes";
import { previewCompanionNote } from "../journal/companion-result-preview";
import { CompanionRunTiming } from "../journal/CompanionRunTiming";
import { useJournalDisclosure } from "../journal/companion-journal-view-state";

/** 实际工具调用的独立过程气泡。执行状态来自 SSE，展开只改变阅读范围。 */

/** 本 run 的真实消耗。来自 `companion_turn_runs`，不是客户端数事件数出来的。 */
export interface CompanionAgentRailProgress {
  readonly stepCount: number;
  readonly maxSteps: number | null;
  readonly toolCallCount: number;
  readonly maxToolCalls: number | null;
  readonly runId?: string;
  readonly createdAt?: string;
}

export type CompanionAgentRailTurnState = "running" | "done" | "stopped" | "failed";

/**
 * 工具名 → 图标。方案 §1 要求「按工具名映射（打开卡片/复习/星图等）」。
 * 名字取自执行器的 switch（`companion-agent-runtime.ts`）；不认识的一律扳手，
 * 不猜语义（猜错比不认识更坏）。
 */
const TOOL_ICONS: Record<string, LucideIcon> = {
  "observe.context": ScanSearch,
  "observe.history": History,
  "observe.stats": BarChart3,
  "observe.activity": ScanSearch,
  "memory.read.read": Brain,
  "memory.read.recall": Brain,
  "open.card": Layers,
  "open.page": Network,
  "open.note": FileText,
  "notes.read.search": ScanSearch,
  "notes.read.read": FileText,
  "notes.write.create": FileText,
  "notes.write.edit": FileText,
  "attention.write.schedule_reminder": Bell,
  "attention.read.reminders": Bell,
  "attention.write.cancel_reminder": Bell,
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

export function CompanionAgentRail({ nodes, progress, turnState, companionName, thinking, onActivity, onReadingChange, onDismiss, dismissLabel, onStop, onJournal, stopping = false }: {
  readonly nodes: CompanionAgentNodes;
  readonly progress: CompanionAgentRailProgress | null;
  readonly turnState: CompanionAgentRailTurnState;
  readonly companionName: string;
  /** 这一轮此刻在想的一行尾巴；完整思考只在手记的运行轨迹里。 */
  readonly thinking?: string;
  readonly onActivity?: () => void;
  readonly onReadingChange?: (open: boolean) => void;
  readonly onDismiss?: () => void;
  readonly dismissLabel?: string;
  readonly onStop?: () => void;
  readonly stopping?: boolean;
  readonly onJournal?: () => void;
}) {
  const [expanded, toggleExpanded] = useJournalDisclosure(`rail:${progress?.runId ?? nodes[0]?.key ?? "pending"}`, turnState === "running");
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
  // A step that failed, was skipped or never started is normal inside an agent
  // loop: the run keeps going and later steps may still produce the result the
  // user asked for. Only report those per step; they must not decide the run's
  // own state or repaint the whole card while it is still working.
  const incomplete = latestFirst.filter(node => ["failed", "not_executed", "unavailable", "cancelled"].includes(node.state));
  const issue = incomplete[0];
  const succeededCount = tools.filter(node => node.state === "succeeded").length;
  const current = unresolved ?? running ?? issue ?? tools[tools.length - 1];
  const count = Math.max(progress?.toolCallCount ?? 0, countAgentToolCalls(tools));
  const savedNotes = [...new Map(tools.flatMap(node => {
    const note = savedCompanionNote(node);
    return note ? [[`${note.noteId}:${note.noteVersionId}`, note] as const] : [];
  })).values()];
  const state = unresolved?.state ?? (turnState === "failed" ? "failed"
    : turnState === "stopped" ? "cancelled"
      : turnState === "running" ? "running"
        : running ? "outcome_unknown"
          : succeededCount > 0 ? "succeeded" : issue?.state ?? "succeeded");
  const composing = turnState === "running" && !running && !unresolved;
  const active = turnState === "running" && !composing;
  const headline = composing ? "正在组织回复…"
    : turnState === "failed" ? "回复未完成"
      : state === "cancelled" ? "这一轮已停止"
        : state === "outcome_unknown" ? "操作结果待核对"
          : state === "waiting_confirmation" ? "等你确认这项操作"
            // The reply itself arrived; only the operations fell short, so do not
            // claim the whole turn failed.
            : state === "failed" ? "这条回复里的操作没有成功"
              : state === "not_executed" ? "这条回复里的操作没有开始"
                : state === "unavailable" ? "这条回复里的操作这次没能使用"
                  : active ? nodeLabel(current) : savedNotes.length ? "笔记已经保存" : "操作已完成";
  const CurrentIcon = composing ? BookOpen : state === "succeeded" && !active ? Check : state === "cancelled" ? X : nodeIcon(current);
  const countText = `${count} 项操作`;
  const incompleteText = incomplete.length ? `${incomplete.length} 项未完成` : "";

  return (
    <section className="companion-hud__rail" data-turn={turnState} data-state={state}
      data-expanded={expanded || undefined}
      onPointerMove={onActivity} onWheel={onActivity} onKeyDown={onActivity} onFocus={onActivity}
      aria-label={`${companionName} 的做事经过`}>
      <header className="companion-hud__rail-heading">
        <strong><Wrench size={13} aria-hidden="true" />本次进展</strong>
        <div className="companion-hud__rail-actions"><button type="button" className="text-action" aria-expanded={expanded} aria-controls={detailsId}
          onClick={() => { onActivity?.(); toggleExpanded(); }}>
          {expanded ? "收起过程" : "查看过程"}<ChevronDown size={12} aria-hidden="true" />
        </button>
        {turnState === "running" && onStop ? <button type="button" className="text-action" onClick={onStop} disabled={stopping} aria-label="停止这一轮"><Square size={10} fill="currentColor" aria-hidden="true" />{stopping ? "停止中" : "停止"}</button>
          : onDismiss ? <button type="button" className="text-action companion-hud__rail-dismiss" onClick={onDismiss} aria-label={dismissLabel ?? "收起做事经过"}><X size={14} /></button> : null}</div>
      </header>
      {thinking ? <div className="companion-hud__rail-thinking" aria-hidden="true"><span>思考</span><p>{thinking}</p></div> : null}
      <div className="companion-hud__rail-current" role="status" aria-live="polite" aria-atomic="true" aria-label={`${companionName} 正在做的事`}>
        <span className="companion-hud__rail-current-icon" aria-hidden="true"><CurrentIcon size={18} /></span>
        <div><p>{headline}</p><span>{state === "succeeded" ? <>{countText}{incompleteText ? <><span aria-hidden="true"> · </span>{incompleteText}</> : null}</> : <>{composing ? "工具操作已结束" : STATE_LABEL[state]}<span aria-hidden="true"> · </span>{countText}</>}</span></div>
      </div>
      {turnState === "running" ? <CompanionRunTiming runId={progress?.runId ?? tools[0].key} startedAt={progress?.createdAt ?? tools[0].occurredAt}
        latestActivityAt={tools.at(-1)?.occurredAt} activityKey={nodes.map(node => `${node.key}:${node.state}`).join("|")} active /> : null}
      {savedNotes.length ? <div className="companion-hud__rail-results" aria-label="已保存，可立即预览">
        <p className="companion-hud__rail-results-heading"><Check size={13} />已保存 {savedNotes.length} 篇<span>现在就能读</span></p>
        {savedNotes.map(note => <button type="button" key={`${note.noteId}:${note.noteVersionId}`} onClick={event => {
          onActivity?.(); previewCompanionNote({ ...note, runId: progress?.runId }, event.currentTarget);
        }}><FileText size={16} />{note.title}<span>预览这份保存内容 →</span></button>)}
      </div> : null}
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
      </div> : <div id={detailsId} hidden />}
      {onJournal ? <button className="companion-hud__rail-journal" type="button" onClick={onJournal}>查看这次完整记录<History size={13} /></button> : null}
    </section>
  );
}
