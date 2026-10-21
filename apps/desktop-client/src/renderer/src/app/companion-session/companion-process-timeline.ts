import { appendCompanionAgentNode, nodeLabel, type CompanionAgentNode, type CompanionRunTrace } from "./companion-agent-nodes";
export type CompanionProcessRow =
  | { key: string; kind: "thinking"; text: string; lastIndex: number }
  | { key: string; kind: "node"; node: CompanionAgentNode };

/** Older archives may contain model repair instructions in this tool receipt. */
export function companionProcessNodeSummary(node: CompanionAgentNode): string {
  if (node.toolName === "companion_publish_utterance" && node.state === "not_executed") return "这次分条发送没有执行。";
  return node.summary ?? "";
}

/** 连续思考占一行；同一次工具的状态更新留在原来的时间位置。 */
export function companionProcessRows(trace: CompanionRunTrace): CompanionProcessRow[] {
  if (!trace.events?.length) return [
    ...(trace.summary.thinkingText ? [{ key: "thinking:record", kind: "thinking" as const, text: trace.summary.thinkingText, lastIndex: -1 }] : []),
    ...trace.nodes.filter(node => node.kind === "tool" || !trace.summary.thinkingText)
      .map(node => ({ key: node.key, kind: "node" as const, node })),
  ];
  const rows: CompanionProcessRow[] = [];
  let nodes: readonly CompanionAgentNode[] = [];
  let contiguousThinking = false;
  for (const event of trace.events ?? []) {
    if (event.type === "assistant.thinking") {
      const payload = event.payload as { text?: unknown; index?: unknown };
      if (typeof payload.text !== "string" || typeof payload.index !== "number") continue;
      const last = rows.at(-1);
      if (contiguousThinking && last?.kind === "thinking" && last.lastIndex + 1 === payload.index) {
        rows[rows.length - 1] = { ...last, text: last.text + payload.text, lastIndex: payload.index };
      } else rows.push({ key: `thinking:${event.seq}`, kind: "thinking", text: payload.text, lastIndex: payload.index });
      contiguousThinking = true;
      continue;
    }
    if (event.type !== "agent.tool") continue;
    contiguousThinking = false;
    const tool = (event.payload as { tool?: { toolCallId?: string; preparationToolCallId?: string } }).tool;
    nodes = appendCompanionAgentNode(nodes, { eventType: event.type, payload: event.payload });
    const node = nodes.find(item => item.key === `tool:${tool?.toolCallId}`);
    if (!node) continue;
    const index = rows.findIndex(row => row.kind === "node" && (row.key === node.key
      || row.key === `tool:${tool?.preparationToolCallId}`));
    const row: CompanionProcessRow = { key: node.key, kind: "node", node };
    if (index >= 0) rows[index] = row;
    else rows.push(row);
  }
  const recorded = rows.filter(row => row.kind === "thinking").map(row => row.text).join("");
  if (trace.summary.thinkingText && trace.summary.thinkingText.length > recorded.length) {
    const tools = rows.filter(row => row.kind === "node");
    rows.splice(0, rows.length, { key: "thinking:record", kind: "thinking", text: trace.summary.thinkingText, lastIndex: -1 }, ...tools);
  }
  for (const node of trace.nodes) {
    if (node.kind === "tool" && !rows.some(row => row.key === node.key)) rows.push({ key: node.key, kind: "node", node });
  }
  if (!rows.length) for (const node of trace.nodes) rows.push({ key: node.key, kind: "node", node });
  return rows.map(row => row.kind === "node"
    ? { ...row, node: trace.nodes.find(node => node.key === row.key) ?? row.node } : row);
}

/**
 * 收起那一格只说她在做什么，不搬思考原文。
 *
 * 原来给的是最后一条 row，而最后一条常常是 thinking：模型的内心独白是英文写的，
 * 于是「执行工具 4 次」后面挂着半句 "Recommending it again is fine, it's substantive.
 * Write the final reply."（2026-10-14 用户截图指出）。完整思考记录的位置是展开后的
 * 时间线，那一格本来就是给它留的；收起态要的是进度，不是原文。
 */
export function companionProcessPreview(trace: CompanionRunTrace, rows: readonly CompanionProcessRow[]): string {
  const status = trace.summary.status;
  if (["succeeded", "failed", "cancelled", "superseded"].includes(status)) {
    const tools = trace.nodes.filter(node => node.kind === "tool");
    const unresolvedTools = tools.filter(node => ["running", "waiting_confirmation", "outcome_unknown"].includes(node.state));
    const unexecuted = tools.filter(node => node.state === "not_executed" || node.state === "unavailable").length;
    const failed = tools.filter(node => node.state === "failed").length;
    const succeededSteps = tools.filter(node => node.state === "succeeded").length;
    // 结论只跟这一轮走（2026-10-21 下午的记录）：跑完且有成功步骤就是「已完成」，
    // 某一步没做成时用下面的计数如实说明，不把整轮改口成「已结束」——同一轮在
    // 气泡的运行卡上说「已完成 · N 项未完成」，手记里再说「已结束」是两套结论。
    // 只有一步都没成功（或还有结果待核对）时才不声称完成。
    const label = status === "succeeded"
      ? !unresolvedTools.length && (succeededSteps > 0 || tools.length === 0) ? "已完成" : "已结束"
      : status === "failed" ? "回复未完成" : status === "superseded" ? "已由新请求接替" : "已停止";
    // "已完成" alone does not say what was done, and a stalled operation must
    // carry its own reason; both keep the real receipt visible in the collapsed row.
    const last = (resolved: readonly CompanionAgentNode[]) => resolved.at(-1);
    const detail = status === "succeeded" && !unexecuted && !failed && !unresolvedTools.length ? last(tools) : last(unresolvedTools);
    return [label,
      unresolvedTools.length ? `${unresolvedTools.length} 项操作结果待核对` : "",
      unexecuted ? `${unexecuted} 项操作未执行` : "",
      failed ? `${failed} 项操作未成功` : "",
      detail ? [nodeLabel(detail), companionProcessNodeSummary(detail)].filter(Boolean).join(" · ") : "",
    ].filter(Boolean).join(" · ");
  }
  const latest = trace.events?.at(-1);
  if (latest?.type === "agent.tool") {
    const tool = (latest.payload as { tool?: { toolCallId?: string } }).tool;
    const node = trace.nodes.find(node => node.key === `tool:${tool?.toolCallId}`);
    if (node) return [nodeLabel(node), companionProcessNodeSummary(node)].filter(Boolean).join(" · ");
  }
  const lastTool = [...rows].reverse().find(row => row.kind === "node");
  return lastTool?.kind === "node"
    ? [nodeLabel(lastTool.node), companionProcessNodeSummary(lastTool.node)].filter(Boolean).join(" · ") : "";
}
