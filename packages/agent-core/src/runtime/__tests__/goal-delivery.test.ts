import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentTurnRequest } from "@ailearn/shared";
import { AGENT_GOAL_DELIVERY_CAPABILITY, type AgentGoalDeliveryV1, type AgentOperationV1 } from "@ailearn/shared/agent-contracts";
import { projectAgentGoalEvidence, validateAgentGoalDelivery } from "../goal-delivery.ts";

const delivery: AgentGoalDeliveryV1 = { outcome: "completed", summary: "计算结果为 3。", requirements: [
  { requirement: "实际核对12/4", fulfilled: true, evidenceCallIds: ["calc"], textOnly: false },
] };
function messages(value = delivery, evidence: Record<string, unknown> = { status: "succeeded", value: 3 }): AgentTurnRequest["messages"] {
  return [
    { role: "assistant", content: "", toolCalls: [{ id: "calc", name: "agent_calculate", arguments: { expression: "12/4" } }] },
    { role: "tool", toolCallId: "calc", content: JSON.stringify(evidence) },
    { role: "assistant", content: "", toolCalls: [{ id: "delivery", name: AGENT_GOAL_DELIVERY_CAPABILITY, arguments: value }] },
    { role: "tool", toolCallId: "delivery", content: JSON.stringify({ status: "proposed", kind: "goal_delivery", delivery: value }) },
  ];
}
test("only an explicit declaration backed by a successful actual result is a completed delivery", () => {
  assert.deepEqual(validateAgentGoalDelivery(messages(), [], "delivery").delivery, delivery);
  assert.equal(validateAgentGoalDelivery([{ role: "assistant", content: "嗨，还没有看到任务" }], [], "delivery").delivery, null);
  for (const value of [{ status: "failed" }, { status: "accepted" }, {}])
    assert.equal(validateAgentGoalDelivery(messages(delivery, value), [], "delivery").delivery, null);
});

test("上下文只提供成功依据；失败调用、自引和无法解析的输出不能出现在可引用目录", () => {
  assert.deepEqual(projectAgentGoalEvidence(messages(), []), [{ callId: "calc", name: "agent_calculate" }]);
  for (const result of [{ status: "failed" }, { status: "accepted" }, { status: "outcome_unknown" }])
    assert.deepEqual(projectAgentGoalEvidence(messages(delivery, result), []), []);
  const invalid = messages(); invalid[1]!.content = "invalid JSON";
  assert.deepEqual(projectAgentGoalEvidence(invalid, []), []);
});
test("missing coverage, invented/cross-run evidence and self-citation cannot complete a goal", () => {
  for (const requirement of [
    { ...delivery.requirements[0]!, fulfilled: false },
    { ...delivery.requirements[0]!, evidenceCallIds: [] },
    { ...delivery.requirements[0]!, evidenceCallIds: ["other-run"] },
    { ...delivery.requirements[0]!, evidenceCallIds: ["delivery"] },
  ]) assert.equal(validateAgentGoalDelivery(messages({ ...delivery, requirements: [requirement] }), [], "delivery").delivery, null);
});
test("an accepted generation is evidence only after its own authoritative operation succeeds", () => {
  const operation: AgentOperationV1 = { operationId: "operation", runId: "run", revision: 1,
    scope: { workspaceId: "space", userId: "user" }, capability: "note_overview_generate", execution: { kind: "job", id: "job" },
    status: "running", lastEventSeq: 1, result: null, error: null };
  const history = messages(delivery, { status: "accepted", operationId: "operation" });
  history[0]!.toolCalls![0]!.name = "note_overview_generate";
  assert.equal(validateAgentGoalDelivery(history, [operation], "delivery").delivery, null);
  assert.deepEqual(projectAgentGoalEvidence(history, [operation]), []);
  const succeeded = { ...operation, status: "succeeded" as const, result: { kind: "artifact" as const, artifact: {
    kind: "note_overview" as const, id: "artifact", jobId: "job", noteId: "note", noteVersionId: "version",
  } } };
  assert.ok(validateAgentGoalDelivery(history, [succeeded], "delivery").delivery);
  assert.deepEqual(projectAgentGoalEvidence(history, [succeeded]), [{ callId: "calc", name: "note_overview_generate" }]);
  assert.equal(validateAgentGoalDelivery(history, [{ ...succeeded, operationId: "other" }], "delivery").delivery, null);
});
test("a pure answer may finish without a side effect; a missing input or failure is an explicit unresolved outcome", () => {
  const pure = { ...delivery, requirements: [{ requirement: "解释概念", fulfilled: true, textOnly: true, evidenceCallIds: [] }] };
  assert.ok(validateAgentGoalDelivery(messages(pure), [], "delivery").delivery);
  for (const outcome of ["needs_input", "failed"] as const) {
    const unresolved = { ...delivery, outcome, requirements: [{ ...delivery.requirements[0]!, fulfilled: false }] };
    assert.equal(validateAgentGoalDelivery(messages(unresolved), [], "delivery").delivery?.outcome, outcome);
  }
});
