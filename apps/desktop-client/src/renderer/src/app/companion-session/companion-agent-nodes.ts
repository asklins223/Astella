/**
 * 伴星 agent 节点流（2026-09-19）。
 *
 * 服务端早在 `assistant.status` / `agent.tool` 里把"她在做什么"发了出来
 * （见 `companion-conversation-contracts.ts` 的 stream event 联合），桌面端也早就收到了
 * 这些帧——但会话层只认 delta/final/error/turn.cancelled，其余全部丢弃，所以用户能看到的
 * 只有"她在想"一句固定文案。这个模块把那些被丢掉的帧收敛成一条**可渲染的节点列表**。
 *
 * 三条不变量（全部来自协议语义，不是本模块发明的）：
 *
 * 1. **文案只用协议里的 `safeLabel`**。这里不合成"正在整理证据"这类描述——那会让 UI
 *    和服务端说两套话，且一旦协议改了措辞就永久漂移。
 * 2. **`agent.tool` 按 `toolCallId` 幂等**。同一个工具调用会经历
 *    `requested → executing → succeeded/failed` 多次上报，它们是**同一行**的状态迁移，
 *    不是多次操作。重追加会让轨道在一步里长出一串重复行。
 * 3. **同一步的多次上报只改状态点，不追加第二行。**（曾是 `agent.skill` 的
 *    selected/completed；技能层删除后这条只对工具成立，但幂等键的语义没变。）
 *
 * 状态映射到 UI 只保留六档（轨道只需要这六档的视觉），映射表是 `TOOL_STATE`。
 */

import { COMPANION_AGENT_TOOL_LABELS } from "@astella/shared/companion-agent-registry";
import { companionCreatedNoteV1Schema, companionEditedNoteV1Schema, type CompanionCreatedNoteV1, type CompanionEditedNoteV1 } from "@astella/shared/companion-note-authoring-contracts";

import type {
  CompanionRunNodeEventV1,
  CompanionRunSummaryV1,
} from "@astella/shared/companion-chat-desktop-contracts";

/**
 * 节点在 UI 上的状态。协议里的 `blocked` 归到 `failed`（都是"这条路走不通，要看见"），
 * `expired` 归到 `cancelled`（都是"没做成，但不是错误"）——这两条与方案 §1 的状态点
 * 配色表一一对应。
 */
export type CompanionAgentNodeState =
  | "running"
  | "succeeded"
  | "waiting_confirmation"
  | "outcome_unknown"
  | "failed"
  | "cancelled"
  /**
   * 40b §3.2 的另两类，与 `failed` 分开显示。
   *
   * 合在一起会让用户读到一句他无法行动的话：
   * - `not_executed`：**根本没开始**（参数没通过），所以"重试"是有意义的；
   * - `unavailable`：能力**这一轮没有**（比如没开图片外发），重调同一个工具没有意义。
   *
   * 两者都显示成"失败"时，用户既不知道该改参数还是该去开开关，
   * 而 `unavailable` 的合同要求恰恰是「指出实际影响及可用替代」。
   */
  | "not_executed"
  | "unavailable";

/** 节点类型只影响图标：等待 / 思考气泡 / 扳手 / 星形 / 按工具名映射。 */
export type CompanionAgentNodeKind = "waiting" | "thinking" | "acting" | "tool";

export interface CompanionAgentNode {
  /** 幂等键：工具用 `tool:${toolCallId}`，状态用递增序号。 */
  readonly key: string;
  readonly kind: CompanionAgentNodeKind;
  /** 协议原文 `safeLabel`（状态节点是 `assistant.status.safeLabel`）。 */
  readonly label: string;
  readonly state: CompanionAgentNodeState;
  /** `agent.tool.name`，只用于图标映射与 route 归属。 */
  readonly toolName: string | null;
  /** `agent.tool.safeSummary`，可有可无。 */
  readonly summary: string | null;
  /**
   * 需要用户确认的工具节点所绑定的真实提案。
   *
   * 服务端 `agent.tool` 已经显式下发这个字段；保留到节点投影后，历史记录才能把
   * 选择卡放回触发它的那一步，而不是在整条 assistant 消息末尾猜位置。
   */
  readonly proposalId: string | null;
  readonly noteCreated?: CompanionCreatedNoteV1;
  readonly noteEdited?: Pick<CompanionEditedNoteV1, "noteId" | "noteVersionId" | "summary">;
  readonly occurredAt?: string;
}

/** 只读快照，避免渲染层拿到可变数组。 */
export type CompanionAgentNodes = readonly CompanionAgentNode[];

export function savedCompanionNote(node: CompanionAgentNode) {
  return node.noteCreated ?? (node.noteEdited ? { noteId: node.noteEdited.noteId,
    noteVersionId: node.noteEdited.noteVersionId, title: "修改后的笔记" } : null);
}

/** Display labels are projected from the registered capabilities. */
export const TOOL_LABELS = COMPANION_AGENT_TOOL_LABELS;

/** 一个节点该显示的那句话。工具节点用上面的表；思考/动作节点的 label 本来就是人话。 */
export function nodeLabel(node: CompanionAgentNode): string {
  if (node.kind === "tool" && node.toolName) return TOOL_LABELS[node.toolName] ?? "正在处理…";
  return node.label;
}

/** 当前节点优先。工具结束只说明进入回复阶段，不推断已读完材料或成功执行。 */
export function companionTurnProcessLine(nodes: readonly CompanionAgentNode[]): string {
  const latest = nodes[nodes.length - 1];
  if (latest?.state === "running") return nodeLabel(latest);
  if (latest?.state === "outcome_unknown") return "操作结果待核对…";
  if (latest?.state === "waiting_confirmation") return "等你确认这项操作";
  if (nodes.some((node) => node.kind === "tool")) return "正在组织回复…";
  return "正在准备回复…";
}

const TOOL_STATE: Record<string, CompanionAgentNodeState> = {
  requested: "running",
  executing: "running",
  waiting_confirmation: "waiting_confirmation",
  succeeded: "succeeded",
  outcome_unknown: "outcome_unknown",
  failed: "failed",
  blocked: "failed",
  expired: "cancelled",
  not_executed: "not_executed",
  unavailable: "unavailable",
};

const UNRECOGNIZED_TOOL_STATUS_SUMMARY =
  "工具状态无法识别，操作结果待核对；确认结果前不要重复操作。";

/**
 * 把一个 SSE 帧折进节点列表。不是节点帧就原样返回（同一个引用，React 不会白重渲）。
 *
 * 参数刻意收成 `{eventType, payload}` 这种最小形状：调用方拿到的 payload 是
 * `unknown`（SSE 解析层不做逐类型校验），这里逐字段判定类型，任何不合形状的帧都被
 * 当成"不认识"丢弃——UI 宁可少一行，也不猜一个可能错的文案。
 */
export function appendCompanionAgentNode(
  nodes: CompanionAgentNodes,
  event: { readonly eventType: string; readonly payload: unknown },
): CompanionAgentNodes {
  switch (event.eventType) {
    case "assistant.status":
      return appendStatusNode(nodes, event.payload);
    case "agent.tool":
      return appendToolNode(nodes, event.payload);
    default:
      return nodes;
  }
}

function appendStatusNode(nodes: CompanionAgentNodes, payload: unknown): CompanionAgentNodes {
  const value = payload as { status?: unknown; safeLabel?: unknown };
  if (typeof value?.safeLabel !== "string" || value.safeLabel.length === 0) return nodes;
  const kind: CompanionAgentNodeKind = value.status === "acting" ? "acting"
    : value.status === "waiting" ? "waiting" : "thinking";
  const last = nodes[nodes.length - 1];
  // 同一 status 连续到达（thinking/acting 之间反复）只在末行改文案与图标，不新增行。
  if (last && (last.kind === "waiting" || last.kind === "thinking" || last.kind === "acting")) {
    if (last.label === value.safeLabel && last.kind === kind) return nodes;
    return [...nodes.slice(0, -1), { ...last, kind, label: value.safeLabel }];
  }
  return [...nodes, {
    key: `status:${nodes.length}`,
    kind,
    label: value.safeLabel,
    state: "running",
    toolName: null,
    summary: null,
    proposalId: null,
  }];
}

function appendToolNode(nodes: CompanionAgentNodes, payload: unknown): CompanionAgentNodes {
  const tool = (payload as { tool?: unknown })?.tool as
    | { toolCallId?: unknown; preparationToolCallId?: unknown; name?: unknown; status?: unknown; safeLabel?: unknown; safeSummary?: unknown; proposalId?: unknown; noteCreated?: unknown; noteEdit?: unknown; occurredAt?: unknown }
    | undefined;
  if (!tool) return nodes;
  if (typeof tool.toolCallId !== "string" || tool.toolCallId.length === 0) return nodes;
  if (typeof tool.safeLabel !== "string" || tool.safeLabel.length === 0) return nodes;
  // A model retry can name a write already recorded under a previous call id.
  // The saved operation replaces its preview so only one row stays active.
  const previewKey = typeof tool.preparationToolCallId === "string" && tool.preparationToolCallId !== tool.toolCallId
    ? `tool:${tool.preparationToolCallId}` : null;
  if (previewKey) {
    const savedKey = `tool:${tool.toolCallId}`;
    const savedExists = nodes.some(node => node.key === savedKey);
    nodes = savedExists ? nodes.filter(node => node.key !== previewKey)
      : nodes.map(node => node.key === previewKey ? { ...node, key: savedKey } : node);
  }
  const name = typeof tool.name === "string" && tool.name.length > 0 ? tool.name : null;
  const rawStatus = typeof tool.status === "string" ? tool.status : "";
  // Payload is unknown at the SSE boundary. An unfamiliar or missing state cannot
  // safely mean "still running": a write may already have happened. Fail closed
  // onto the existing reconciliation state and never invite a blind replay.
  const knownState = Object.prototype.hasOwnProperty.call(TOOL_STATE, rawStatus)
    ? TOOL_STATE[rawStatus]
    : undefined;
  const state = knownState ?? "outcome_unknown";
  const summary = knownState
    ? (typeof tool.safeSummary === "string" && tool.safeSummary.length > 0 ? tool.safeSummary : null)
    : UNRECOGNIZED_TOOL_STATUS_SUMMARY;
  const proposalId = typeof tool.proposalId === "string" && tool.proposalId.length > 0 ? tool.proposalId : null;
  const key = `tool:${tool.toolCallId}`;
  const receipt = state === "succeeded" ? companionCreatedNoteV1Schema.safeParse(tool.noteCreated) : null;
  const edit = state === "succeeded" ? companionEditedNoteV1Schema.safeParse(tool.noteEdit) : null;
  const extra = { ...(receipt?.success ? { noteCreated: receipt.data } : {}),
    ...(edit?.success ? { noteEdited: { noteId: edit.data.noteId, noteVersionId: edit.data.noteVersionId, summary: edit.data.summary } } : {}),
    ...(typeof tool.occurredAt === "string" && Number.isFinite(Date.parse(tool.occurredAt)) ? { occurredAt: tool.occurredAt } : {}) };
  const index = nodes.findIndex((node) => node.key === key);
  if (index >= 0) {
    const existing = nodes[index];
    // Reconnect/replayed preparation cannot revive a settled operation.
    if (existing.state !== "running" && existing.state !== "waiting_confirmation" && state === "running") return nodes;
    if (existing.occurredAt && extra.occurredAt && Date.parse(extra.occurredAt) < Date.parse(existing.occurredAt)) return nodes;
    if (existing.state === state && existing.label === tool.safeLabel && existing.summary === summary
      && existing.proposalId === proposalId && !receipt?.success && !edit?.success && !extra.occurredAt) return nodes;
    return nodes.map((node, at) => (at === index
      ? { ...node, state, label: tool.safeLabel as string, toolName: name, summary, proposalId, ...extra }
      : node));
  }
  return [...nodes, { key, kind: "tool", label: tool.safeLabel, state, toolName: name, summary, proposalId, ...extra }];
}

/**
 * 本轮用掉的工具次数——**去重后的 `toolCallId` 个数**。
 *
 * 直接数节点行数是错的：同一个调用会上报多次状态。这里是 UI 除了 run 摘要之外的
 * 唯一计数来源，所以必须与幂等键同一口径。
 */
export function countAgentToolCalls(nodes: CompanionAgentNodes): number {
  return nodes.reduce((total, node) => total + (node.kind === "tool" ? 1 : 0), 0);
}

/** 补回漏接的工具帧；较旧快照不能把 SSE 已落定的操作倒退成进行中。 */
export function reconcileCompanionAgentNodes(live: CompanionAgentNodes, snapshot: CompanionAgentNodes): CompanionAgentNodes {
  const missing = snapshot.filter(node => node.kind === "tool" && !live.some(item => item.key === node.key));
  let changed = missing.length > 0;
  const updated = live.map(node => {
    const saved = snapshot.find(item => item.key === node.key && item.kind === "tool");
    if (!saved) return node;
    // 等待选择仍会得到后续回执；普通终态保持即时帧的结果。
    if ((node.state === "running" || node.state === "waiting_confirmation") && saved.state !== "running" && saved.state !== node.state) {
      changed = true;
      return saved;
    }
    if (node.state === saved.state && ((!node.noteCreated && saved.noteCreated) || (!node.noteEdited && saved.noteEdited) || (!node.occurredAt && saved.occurredAt))) {
      changed = true;
      return { ...node, ...(!node.noteCreated && saved.noteCreated ? { noteCreated: saved.noteCreated } : {}),
        ...(!node.noteEdited && saved.noteEdited ? { noteEdited: saved.noteEdited } : {}),
        ...(!node.occurredAt && saved.occurredAt ? { occurredAt: saved.occurredAt } : {}) };
    }
    return node;
  });
  if (!changed) return live;
  for (const node of missing) {
    const savedIndex = snapshot.findIndex(item => item.key === node.key);
    const following = snapshot.slice(savedIndex + 1).find(item => updated.some(current => current.key === item.key));
    const insertAt = following ? updated.findIndex(item => item.key === following.key) : updated.length;
    updated.splice(insertAt, 0, node);
  }
  return updated;
}

/** 一轮 run 的过程留痕：服务端摘要 + 由事件折出的节点。 */
export interface CompanionRunTrace {
  readonly summary: CompanionRunSummaryV1;
  readonly nodes: CompanionAgentNodes;
  readonly events?: readonly CompanionRunNodeEventV1[];
}

/**
 * 把只读端点返回的「事件 + run 摘要」合成每条消息要展示的过程留痕。
 *
 * 摘要与节点**按 `runId` 对齐**（不是按消息）：一条消息未必有节点（TTL 已清理），
 * 一轮 run 也未必有消息（还没终态）。两边都用 `runId` 做键，缺谁都不编。
 *
 * 节点沿用实时链路那一个收敛函数，所以"实时看到的过程"与"翻历史看到的过程"
 * 不可能出现两套口径。
 */
export function buildCompanionRunTraces(
  runs: readonly CompanionRunSummaryV1[],
  items: readonly CompanionRunNodeEventV1[],
): readonly CompanionRunTrace[] {
  const byRun = new Map<string, CompanionRunNodeEventV1[]>();
  for (const item of items) {
    if (!item.runId) continue;
    byRun.set(item.runId, [...byRun.get(item.runId) ?? [], item]);
  }
  return runs.map((summary) => {
    const events = mergeProcessEvents(summary.processTimeline ?? [], byRun.get(summary.runId) ?? []);
    return { summary, events, nodes: processNodes(events) };
  });
}

function mergeProcessEvents(left: readonly CompanionRunNodeEventV1[], right: readonly CompanionRunNodeEventV1[]) {
  const bySeq = new Map(left.map(event => [event.seq, event]));
  for (const event of right) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

function processNodes(events: readonly CompanionRunNodeEventV1[]): CompanionAgentNodes {
  return events.reduce<CompanionAgentNodes>((nodes, event) => appendCompanionAgentNode(nodes, {
    eventType: event.type, payload: event.payload,
  }), []);
}

/** 快照补全已收到的事件；旧轮询不撤销终态，也不清掉刚完成的记录。 */
export function mergeCompanionRunTraces(current: readonly CompanionRunTrace[], incoming: readonly CompanionRunTrace[]): readonly CompanionRunTrace[] {
  const result = new Map(current.map(trace => [trace.summary.runId, trace]));
  for (const trace of incoming) {
    const previous = result.get(trace.summary.runId);
    if (!previous) { result.set(trace.summary.runId, trace); continue; }
    const events = mergeProcessEvents(previous.events ?? [], trace.events ?? []);
    const previousTerminal = ["succeeded", "failed", "cancelled", "superseded"].includes(previous.summary.status);
    const incomingActive = ["accepted", "running", "waiting_for_confirmation"].includes(trace.summary.status);
    const older = (trace.summary.eventCursor ?? 0) < (previous.summary.eventCursor ?? 0);
    const preserveStatus = older || (previousTerminal && incomingActive
      && (trace.summary.eventCursor ?? 0) === (previous.summary.eventCursor ?? 0));
    result.set(trace.summary.runId, {
      summary: { ...trace.summary,
        status: preserveStatus ? previous.summary.status : trace.summary.status,
        errorCode: preserveStatus ? previous.summary.errorCode : trace.summary.errorCode,
        eventCursor: Math.max(trace.summary.eventCursor ?? 0, previous.summary.eventCursor ?? 0),
        assistantMessageId: older ? previous.summary.assistantMessageId ?? trace.summary.assistantMessageId
          : trace.summary.assistantMessageId ?? previous.summary.assistantMessageId,
        thinkingText: (trace.summary.thinkingText?.length ?? 0) >= (previous.summary.thinkingText?.length ?? 0)
          ? trace.summary.thinkingText : previous.summary.thinkingText,
        processTimeline: trace.summary.processTimeline ?? previous.summary.processTimeline,
        stepCount: Math.max(trace.summary.stepCount, previous.summary.stepCount),
        toolCallCount: Math.max(trace.summary.toolCallCount, previous.summary.toolCallCount),
      },
      events,
      nodes: reconcileCompanionAgentNodes(previous.nodes, processNodes(events)),
    });
  }
  return [...result.values()];
}

/** SSE 与历史共用同一份过程记录，正文落地时无需等下一次轮询再搬面板。 */
export function recordCompanionRunEvent(current: readonly CompanionRunTrace[], event: {
  runId: string; generation: number; seq: number; eventType: string; payload: unknown;
}): readonly CompanionRunTrace[] {
  const process = ["assistant.status", "assistant.thinking", "agent.tool"].includes(event.eventType);
  const terminal = ["assistant.final", "turn.completed", "turn.cancelled", "error"].includes(event.eventType);
  const accepted = event.eventType === "turn.accepted";
  if (!process && !terminal && !accepted) return current;
  const previous = current.find(trace => trace.summary.runId === event.runId);
  if (previous && event.generation < previous.summary.generation) return current;
  const newest = event.seq >= (previous?.summary.eventCursor ?? 0);
  if (!process && !newest) return current;
  const payload = event.payload as { messageId?: unknown; text?: unknown; code?: string; userMessageId?: string };
  const events = process ? mergeProcessEvents(previous?.events ?? [], [{ version: 1, seq: event.seq,
    runId: event.runId, type: event.eventType, payload: event.payload }]) : previous?.events ?? [];
  const nodes = processNodes(events);
  const thinkingText = events.filter(item => item.type === "assistant.thinking")
    .map(item => (item.payload as { text?: string }).text ?? "").join("");
  const summary: CompanionRunSummaryV1 = { version: 1, runId: event.runId, generation: event.generation,
    status: "running", stepCount: 0, toolCallCount: 0, maxSteps: null, maxToolCalls: null,
    assistantMessageId: null, nodeCount: nodes.length, ...previous?.summary,
    eventCursor: Math.max(previous?.summary.eventCursor ?? 0, event.seq),
    ...(accepted && newest ? { status: "accepted" as const, errorCode: null, userMessageId: payload.userMessageId ?? previous?.summary.userMessageId } : {}),
    ...(event.eventType === "error" && newest ? { errorCode: payload.code ?? null } : {}),
    ...(thinkingText ? { thinkingText: thinkingText.length >= (previous?.summary.thinkingText?.length ?? 0)
      ? thinkingText : previous?.summary.thinkingText } : {}),
    ...(terminal && newest ? { status: event.eventType === "error" ? "failed" : event.eventType === "turn.cancelled" ? "cancelled" : "succeeded" } : {}),
    ...(typeof payload.messageId === "string" && newest ? { assistantMessageId: payload.messageId } : {}),
  };
  summary.toolCallCount = Math.max(summary.toolCallCount, countAgentToolCalls(nodes));
  const trace = { summary, nodes: reconcileCompanionAgentNodes(previous?.nodes ?? [], nodes), events };
  return previous ? current.map(item => item.summary.runId === event.runId ? trace : item) : [...current, trace];
}

/**
 * 过程留痕是否"已被 TTL 清掉"。
 *
 * 这是本模块唯一的判据来源，UI 不许自己判断：服务端记录了步数（`stepCount > 0`）
 * 却读不到任何节点事件，就是过期；两者都为 0 是"这轮没有过程"（single_step 闲聊），
 * 是两种不同的说法，不能合并。
 */
export function companionRunTraceExpired(trace: CompanionRunTrace): boolean {
  return !trace.summary.thinkingText?.trim()
    && !trace.events?.length
    && trace.summary.stepCount > 0 && trace.summary.nodeCount === 0 && trace.nodes.length === 0;
}
