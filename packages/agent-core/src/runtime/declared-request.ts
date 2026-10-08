import { AgentRole, type AgentTurnRequest, type AgentTurnResult } from "@astella/shared";
import { AGENT_GOAL_DELIVERY_CAPABILITY, type AgentOperationV1 } from "@astella/shared/agent-contracts";
import type { AgentDirectRequestV1 } from "@astella/shared/agent-request-contracts";
import { getAgentCapability } from "@astella/shared/agent-capability-catalog";
import { projectAgentGoalEvidence } from "./goal-delivery.ts";

/** A user's button already selected the action. Use the same checkpoint/tool/
 * receipt driver without asking a model to reinterpret that selection. */
export function declaredAgentRequestStep(input: {
  runId: string; revision: number; goal: string; directRequest: AgentDirectRequestV1;
  messages: AgentTurnRequest["messages"]; operations: readonly AgentOperationV1[];
}): { request: AgentTurnRequest; response: AgentTurnResult } {
  const capability = input.directRequest.capability;
  const current = input.operations.filter(operation => operation.revision === input.revision && operation.capability === capability);
  if (current.some(operation => ["accepted", "running", "outcome_unknown"].includes(operation.status)))
    throw new Error("Declared request is waiting for an authoritative receipt");
  const evidence = projectAgentGoalEvidence(input.messages, input.operations).filter(value => value.name === capability);
  const reused = current.length === 0 && evidence.length > 0;
  const done = reused || (current.length > 0 && current.every(operation => operation.status === "succeeded" && operation.result !== null));
  const summaries = {
    note_mind_map_generate: "脑图已生成，可以在速看或对话手记里回看。",
    note_overview_generate: "速看已生成，可以在原页面或对话手记里回看。",
    note_dynamic_artifact_generate: "互动演示已生成，可以打开操作和观察。",
    note_expansion_generate: "知识拓展草稿已准备好，等你挑选后再保存。",
    card_generation_generate: "学习卡候选已准备好，等你审核决定收下哪些。",
  };
  const summary = current.some(operation => operation.result?.kind === "no_cards_recommended")
    ? "这版材料暂不建议制卡，结论和原因已保留。" : done ? summaries[capability]
      : capability === "card_generation_generate" ? "这批学习卡的生成或核对没有完成。已写出的草稿保留，可以打开本次生成任务查看进度和重试方式。"
        : "这次生成没有完成，已有内容保留。";
  const response: AgentTurnResult = { content: "", usage: {}, providerRequestId: null, toolCalls: current.length || reused ? [{
    id: `domain-delivery:${input.runId}:${input.revision}`, name: AGENT_GOAL_DELIVERY_CAPABILITY,
    arguments: { outcome: done ? "completed" : "failed", summary, requirements: [{ requirement: input.goal.slice(0,500),
      fulfilled: done, textOnly: false, evidenceCallIds: done ? evidence.map(value => value.callId) : [] }] },
  }] : [{ id: `domain-retry:${input.runId}:${input.revision}`, name: capability,
    arguments: { noteId: input.directRequest.noteId, noteVersionId: input.directRequest.request.noteVersionId } }], finishReason: "tool_calls" };
  const tools = [capability, AGENT_GOAL_DELIVERY_CAPABILITY].map(name => {
    const entry = getAgentCapability(name);
    if (!entry?.surfaces.includes("goal")) throw new Error("Declared capability is unavailable");
    return { name, description: entry.definition.description, parameters: entry.definition.parameters };
  });
  return { request: { role: AgentRole.COMPANION_AGENT, systemPrompt: "按页面已确认的单项请求核对真实回执。", messages: input.messages,
    tools, maxTokens: 1, temperature: 0 }, response };
}
