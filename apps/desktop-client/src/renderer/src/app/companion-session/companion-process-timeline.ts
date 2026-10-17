import { appendCompanionAgentNode, nodeLabel, type CompanionAgentNode, type CompanionRunTrace } from "./companion-agent-nodes";

export type CompanionProcessRow =
  | { key: string; kind: "thinking"; text: string; lastIndex: number }
  | { key: string; kind: "node"; node: CompanionAgentNode };

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
  const latest = trace.events?.at(-1);
  if (latest?.type === "agent.tool") {
    const tool = (latest.payload as { tool?: { toolCallId?: string } }).tool;
    const node = trace.nodes.find(node => node.key === `tool:${tool?.toolCallId}`);
    if (node) return [nodeLabel(node), node.summary].filter(Boolean).join(" · ");
  }
  const lastTool = [...rows].reverse().find(row => row.kind === "node");
  return lastTool?.kind === "node"
    ? [nodeLabel(lastTool.node), lastTool.node.summary].filter(Boolean).join(" · ") : "";
}
