import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentOperationV1 } from "@astella/shared/agent-contracts";
import { declaredAgentRequestStep } from "../declared-request.ts";

const input: Parameters<typeof declaredAgentRequestStep>[0] = {
  runId: "run", revision: 2, goal: "生成速看", directRequest: {
    capability: "note_overview_generate", noteId: "note", request: { noteVersionId: "version", requestId: "request" },
  }, messages: [
    { role: "assistant", content: "", toolCalls: [{ id: "accepted", name: "note_overview_generate", arguments: { noteId: "note", noteVersionId: "version" } }] },
    { role: "tool", toolCallId: "accepted", content: JSON.stringify({ status: "accepted", operationId: "operation" }) },
  ], operations: [],
};
const operation: AgentOperationV1 = { operationId: "operation", runId: "run", revision: 2,
  scope: { workspaceId: "space", userId: "user" }, capability: "note_overview_generate", execution: { kind: "job", id: "job" },
  status: "succeeded", lastEventSeq: 1, error: null, result: { kind: "artifact", artifact: {
    kind: "note_overview", id: "artifact", jobId: "job", noteId: "note", noteVersionId: "version",
  } } };
test("a declared request delivers only its authoritative operation, with no planning call", () => {
  const step = declaredAgentRequestStep({ ...input, operations: [operation] });
  assert.equal(step.response.toolCalls[0]?.name, "agent_deliver_goal");
  assert.equal(step.response.toolCalls[0]?.arguments.outcome, "completed");
  assert.deepEqual((step.response.toolCalls[0]?.arguments.requirements as { evidenceCallIds: string[] }[])[0]?.evidenceCallIds, ["accepted"]);
  assert.deepEqual(step.request.tools.map(value => value.name), ["note_overview_generate", "agent_deliver_goal"]);
});
test("running and uncertain operations wait; failed operations never become completion", () => {
  for (const status of ["accepted", "running", "outcome_unknown"] as const)
    assert.throws(() => declaredAgentRequestStep({ ...input, operations: [{ ...operation, status, result: null }] }), /authoritative receipt/);
  const failed = declaredAgentRequestStep({ ...input, operations: [{ ...operation, status: "failed", result: null }] });
  assert.equal(failed.response.toolCalls[0]?.arguments.outcome, "failed");
});
test("a confirmed reused result finishes a retry; an unrelated result cannot suppress the selected capability", () => {
  const retry = declaredAgentRequestStep({ ...input, operations: [] });
  assert.equal(retry.response.toolCalls[0]?.name, "note_overview_generate");
  const reused = declaredAgentRequestStep({ ...input, operations: [{ ...operation, revision: 1 }] });
  assert.equal(reused.response.toolCalls[0]?.arguments.outcome, "completed");
  const unrelated = declaredAgentRequestStep({ ...input, operations: [{ ...operation, operationId: "another", revision: 1 }] });
  assert.equal(unrelated.response.toolCalls[0]?.name, "note_overview_generate");
});
