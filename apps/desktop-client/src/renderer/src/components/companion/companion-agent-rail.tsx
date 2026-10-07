import { useEffect, useState, type CSSProperties } from "react";
import {
  BarChart3,
  Bell,
  BookOpen,
  Brain,
  CalendarClock,
  Check,
  CircleDashed,
  Ear,
  FileText,
  History,
  Layers,
  ListChecks,
  Network,
  ScanSearch,
  Sparkles,
  TriangleAlert,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  countAgentToolCalls,
  visibleAgentNodes,
  type CompanionAgentNode,
  type CompanionAgentNodes,
  nodeLabel,
} from "../../app/companion-agent-nodes";

/**
 * 头顶「步骤轨道」（方案 §1 第一层，2026-09-19）。
 *
 * 贴在状态气泡上方，一行一步，最多同时显示最近 3 步，更早的折成左端 `…+N`。
 * 它回答的是现在用户唯一看不到的那件事：**她到底做了什么、做到哪了**——在此之前
 * 工具调用、技能选择、第几步全部不可见，而服务端一直在发。
 *
 * 三条自我约束：
 *
 * 1. **文案只用 `safeLabel`**（收敛层已经保证），这里不合成描述。
 * 2. **不做表演**：状态点只在 `running` 呼吸、`waiting_confirmation` 脉冲；其余是静态
 *    的落定态。方案 §5 明确不做第二层打字机、不做循环旋转光晕。
 * 3. **收不收由回合状态决定，退场由交互生命周期决定**：`assistant.final` 后 400ms 收成一行摘要；
 *    用户按停止保留 2s（让他看见"停在这里"）；出错**不自动收**——错误必须被看见。
 *    用户能展开全部节点；宿主在完成后有限展示，不与回复气泡的退场耦合。
 */

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

/** 状态点：结果不明与失败分开提示，其余终态按方案 §1 的表呈现。 */
function nodeMark(node: CompanionAgentNode) {
  if (node.state === "succeeded") return <Check size={13} aria-hidden="true" />;
  if (node.state === "failed" || node.state === "outcome_unknown") return <TriangleAlert size={13} aria-hidden="true" />;
  if (node.state === "cancelled") return <X size={13} aria-hidden="true" />;
  return <CircleDashed size={13} aria-hidden="true" />;
}

function progressText(
  progress: CompanionAgentRailProgress | null,
  toolCalls: number,
  turnState: CompanionAgentRailTurnState,
  hasUnknownOutcome: boolean,
): string {
  // 步数只在拿到**本 run** 的摘要时才说。`assistant.status` 一轮只发一次，客户端数不出
  // 步数——与其猜一个数字，不如先只说工具次数，摘要到了再补上步数。
  const steps = progress ? `${progress.stepCount}/${progress.maxSteps} 步` : null;
  const tools = progress ? `${toolCalls}/${progress.maxToolCalls} 次工具` : `${toolCalls} 次工具`;
  if (hasUnknownOutcome) return steps ? `结果待核对 · ${steps} · ${tools}` : `结果待核对 · ${tools}`;
  // 失败必须被**读**出来，不能只靠边框变红（`companion-hud.css:599`）：矮窗口下
  // （方案 35 F4）。用词跟记录里那句「这一轮没能说完」同一口径。
  if (turnState === "failed") return steps ? `没说完 · ${steps} · ${tools}` : `没说完 · ${tools}`;
  if (turnState === "stopped") return steps ? `已停止 · ${steps} · ${tools}` : `已停止 · ${tools}`;
  return steps ? `${steps} · ${tools}` : tools;
}

export function CompanionAgentRail({
  nodes,
  progress,
  turnState,
  companionName,
  onActivity,
}: {
  readonly nodes: CompanionAgentNodes;
  readonly progress: CompanionAgentRailProgress | null;
  readonly turnState: CompanionAgentRailTurnState;
  /** 她对自己的称呼：轨道的 aria-label 用，不再写死模型名。 */
  readonly companionName: string;
  readonly onActivity?: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  /**
   * 收起时机。`final` 后 400ms 收（让最后一步的落定被看见），停止后 2s 收
   * （"停在这里"需要停留），出错不收（错误被自动折叠掉等于没提示）。
   *
   * 这里只管"收成摘要"，不管消失——消失跟着气泡走（见文件头第 3 条约束）。
   */
  useEffect(() => {
    if (turnState === "running" || turnState === "failed") {
      setCollapsed(false);
      setExpanded(false);
      return;
    }
    if (turnState === "stopped") {
      const timer = window.setTimeout(() => setCollapsed(true), 2_000);
      return () => window.clearTimeout(timer);
    }
    const collapseTimer = window.setTimeout(() => setCollapsed(true), 400);
    return () => window.clearTimeout(collapseTimer);
  }, [turnState]);

  if (nodes.length === 0) return null;

  const folded = collapsed && !expanded;
  const recent = visibleAgentNodes(nodes);
  const visible = expanded ? nodes : recent.visible;
  const hiddenCount = expanded ? 0 : recent.hiddenCount;
  // 工具次数取「摘要」与「本轮节点去重计数」的较大者：摘要是权威值但它按轮询节奏到，
  // 节点是即时的。两者同口径（都是去重后的 toolCallId 个数），取大不会虚报。
  const toolCalls = Math.max(progress?.toolCallCount ?? 0, countAgentToolCalls(nodes));
  const hasUnknownOutcome = nodes.some((node) => node.state === "outcome_unknown");

  return (
    <div
      className="companion-hud__rail"
      data-turn={turnState}
      data-collapsed={folded || undefined}
      data-expanded={expanded || undefined}
      onPointerMove={onActivity}
      onWheel={onActivity}
      onKeyDown={onActivity}
      onFocus={onActivity}
      role="status"
      aria-live="polite"
      aria-label={`${companionName} 正在做的事`}
    >
      <header className="companion-hud__rail-heading">
        <strong><Wrench size={13} aria-hidden="true" />工具过程</strong>
        <button type="button" className="text-action" aria-expanded={expanded} onClick={() => { onActivity?.(); setExpanded(value => !value); }}>
          {expanded ? "收起过程" : "查看过程"}
        </button>
      </header>
      {folded ? (
        <p className="companion-hud__rail-summary">{progressText(progress, toolCalls, turnState, hasUnknownOutcome)}</p>
      ) : (
        <ol
          className="companion-hud__rail-steps"
          style={{ "--rail-index": Math.max(0, visible.length - 1) } as CSSProperties}
        >
          {hiddenCount > 0 ? <li className="companion-hud__rail-overflow">…+{hiddenCount}</li> : null}
          {visible.map((node) => {
            const Icon = nodeIcon(node);
            return (
              <li key={node.key} data-state={node.state} data-kind={node.kind} title={node.summary ?? undefined}>
                <span className="companion-hud__rail-icon"><Icon size={13} aria-hidden="true" /></span>
                <span className="companion-hud__rail-label">
                  {nodeLabel(node)}{node.state === "outcome_unknown" ? " · 结果待核对" : ""}
                </span>
                <span className="companion-hud__rail-mark">{nodeMark(node)}</span>
              </li>
            );
          })}
        </ol>
      )}
      {!folded ? (
        <p className="companion-hud__rail-summary">{progressText(progress, toolCalls, turnState, hasUnknownOutcome)}</p>
      ) : null}
    </div>
  );
}
