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
test("a mind map receipt produces a completed delivery with its own capability and summary", () => {
  const step = declaredAgentRequestStep({ ...input, goal: "生成脑图",
    directRequest: { capability: "note_mind_map_generate", noteId: "note", request: { noteVersionId: "version", requestId: "request" } },
    messages: [
      { role: "assistant", content: "", toolCalls: [{ id: "accepted", name: "note_mind_map_generate", arguments: { noteId: "note", noteVersionId: "version" } }] },
      input.messages[1]!,
    ], operations: [{ ...operation, capability: "note_mind_map_generate", result: { kind: "artifact", artifact: {
      kind: "note_mind_map", id: "map", jobId: "job", noteId: "note", noteVersionId: "version",
    } } }],
  });
  assert.equal(step.response.toolCalls[0]?.arguments.outcome, "completed");
  assert.match(String(step.response.toolCalls[0]?.arguments.summary), /脑图已生成/);
  assert.deepEqual((step.response.toolCalls[0]?.arguments.requirements as { evidenceCallIds: string[] }[])[0]?.evidenceCallIds, ["accepted"]);
  assert.deepEqual(step.request.tools.map(value => value.name), ["note_mind_map_generate", "agent_deliver_goal"]);
});
test("running and uncertain operations wait; failed operations never become completion", () => {
  for (const status of ["accepted", "running", "outcome_unknown"] as const)
    assert.throws(() => declaredAgentRequestStep({ ...input, operations: [{ ...operation, status, result: null }] }), /authoritative receipt/);
  const failed = declaredAgentRequestStep({ ...input, operations: [{ ...operation, status: "failed", result: null }] });
  assert.equal(failed.response.toolCalls[0]?.arguments.outcome, "failed");
});
test("a failed card receipt distinguishes retained drafts from candidates ready for review", () => {
  const failed = declaredAgentRequestStep({ ...input, goal: "生成学习卡", directRequest: {
    capability: "card_generation_generate", noteId: "note", request: {
      version: 2, noteVersionId: "version", sourceScope: { kind: "whole_note" }, learningGoal: "understand",
      detailThreshold: "balanced", quantity: { kind: "adaptive" }, clientRequestId: "request",
    },
  }, operations: [{ ...operation, capability: "card_generation_generate", execution: { kind: "card_generation", id: "card-run" }, status: "failed", result: null }] });
  assert.equal(failed.response.toolCalls[0]?.arguments.outcome, "failed");
  assert.match(String(failed.response.toolCalls[0]?.arguments.summary), /生成或核对没有完成/);
  assert.match(String(failed.response.toolCalls[0]?.arguments.summary), /已写出的草稿保留/);
});
test("a confirmed reused result finishes a retry; an unrelated result cannot suppress the selected capability", () => {
  const retry = declaredAgentRequestStep({ ...input, operations: [] });
  assert.equal(retry.response.toolCalls[0]?.name, "note_overview_generate");
  const reused = declaredAgentRequestStep({ ...input, operations: [{ ...operation, revision: 1 }] });
  assert.equal(reused.response.toolCalls[0]?.arguments.outcome, "completed");
  const unrelated = declaredAgentRequestStep({ ...input, operations: [{ ...operation, operationId: "another", revision: 1 }] });
  assert.equal(unrelated.response.toolCalls[0]?.name, "note_overview_generate");
});
