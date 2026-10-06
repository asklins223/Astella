import type { AgentTurnRequest } from "@astella/shared";
import { AGENT_GOAL_DELIVERY_CAPABILITY, agentGoalDeliveryV1Schema,
  type AgentGoalDeliveryV1, type AgentOperationV1 } from "@astella/shared/agent-contracts";

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

function goalCallLedger(messages: AgentTurnRequest["messages"]) {
  const calls = new Map<string, string>();
  const results = new Map<string, Record<string, unknown>>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) calls.set(call.id, call.name);
    if (message.role === "tool" && message.toolCallId && typeof message.content === "string") {
      try { const value = record(JSON.parse(message.content)); if (value) results.set(message.toolCallId, value); } catch { /* Invalid output provides no evidence. */ }
    }
  }
  return { calls, results };
}

function successfulCallIds(ledger: ReturnType<typeof goalCallLedger>, operations: readonly AgentOperationV1[]) {
  return [...ledger.calls].filter(([id, name]) => {
    const result = ledger.results.get(id);
    if (name === AGENT_GOAL_DELIVERY_CAPABILITY || !result) return false;
    if (!result.operationId) return result.status === "succeeded";
    return operations.some(operation => operation.operationId === result.operationId && operation.capability === name
      && operation.status === "succeeded" && operation.result !== null);
  });
}

/** Prompt evidence and commit validation follow the same actual receipt rule. */
export function projectAgentGoalEvidence(messages: AgentTurnRequest["messages"], operations: readonly AgentOperationV1[]) {
  return successfulCallIds(goalCallLedger(messages), operations).map(([callId, name]) => ({ callId, name }));
}

/** A stopped model is not a delivery. Validate its declared coverage against actual receipts. */
export function validateAgentGoalDelivery(messages: AgentTurnRequest["messages"], operations: readonly AgentOperationV1[], callId: string):
  { delivery: AgentGoalDeliveryV1; error: null } | { delivery: null; error: string } {
  const ledger = goalCallLedger(messages);
  const { calls, results } = ledger;
  const result = results.get(callId);
  if (calls.get(callId) !== AGENT_GOAL_DELIVERY_CAPABILITY || result?.kind !== "goal_delivery" || result.status !== "proposed")
    return { delivery: null, error: "交付说明没有通过执行边界，请重新提交。" };
  const parsed = agentGoalDeliveryV1Schema.safeParse(result.delivery);
  if (!parsed.success) return { delivery: null, error: "交付说明格式不完整，请补齐要求与真实依据。" };
  const delivery = parsed.data;
  if (delivery.outcome !== "completed") return { delivery, error: null };
  if (operations.some(operation => operation.status !== "succeeded" || operation.result === null))
    return { delivery: null, error: "生成仍未取得全部成功回执，不能宣布目标完成。" };
  const successful = new Set(successfulCallIds(ledger, operations).map(([id]) => id));
  for (const requirement of delivery.requirements) {
    if (!requirement.fulfilled) return { delivery: null, error: "还有要求未满足，请继续处理或说明缺少的部分。" };
    if (!requirement.textOnly && requirement.evidenceCallIds.length === 0)
      return { delivery: null, error: "动作类要求缺少真实成功回执，文字不能代替执行。" };
    for (const evidenceId of requirement.evidenceCallIds) {
      if (!successful.has(evidenceId))
        return { delivery: null, error: "交付依据尚未成功或不属于本目标，请核对后再交付。" };
    }
  }
  return { delivery, error: null };
}
