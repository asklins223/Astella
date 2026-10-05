import test from "node:test";
import assert from "node:assert/strict";
import { resolveAgentTurnInterpretation } from "../attention.ts";
const input = { requestHash: "a".repeat(64), objects: [{ kind: "agent_run" as const, id: "11111111-1111-1111-1111-111111111111", revision: 2 }],
  capabilities: ["agent_control_goal", "agent_list_goals"] };
const task = { intent: "task_control", toolUse: "act", subjects: [{ description: "刚才那件事", objectIndex: 0 }],
  goalRelation: "control", goalObjectIndex: 0, candidateOperations: ["agent_control_goal"], ambiguities: [] };
test("a task can bind a scoped goal; subsequent small talk cannot inherit its operation or relation", () => {
  const control = resolveAgentTurnInterpretation(task, input);
  assert.deepEqual(control.goalReference, input.objects[0]);
  const chat = resolveAgentTurnInterpretation({ ...task, intent: "conversation", toolUse: "none", subjects: [{ description: "今天晚饭" }] }, input);
  assert.equal(chat.goalRelation, "unrelated");
  assert.equal(chat.goalReference, null);
  assert.deepEqual(chat.candidateOperations, []);
  assert.equal(chat.toolUse, "none");
});
test("invented object identity, unavailable capability and unresolved ambiguity never authorize a write", () => {
  const result = resolveAgentTurnInterpretation({ ...task, goalObjectIndex: 50,
    subjects: [{ description: "它", objectIndex: 50 }], candidateOperations: ["invented_delete"], ambiguities: ["修改哪件事未明确"] }, input);
  assert.equal(result.goalReference, null);
  assert.equal(result.subjects[0]?.reference, null);
  assert.equal(result.toolUse, "uncertain");
  assert.equal(result.status, "uncertain");
  assert.deepEqual(result.candidateOperations, []);
  assert.ok(result.ambiguities.length >= 3);
});
test("invalid interpretation remains explicit unknown rather than continuing a historical action", () => {
  const result = resolveAgentTurnInterpretation({ needsTool: true }, input);
  assert.equal(result.toolUse, "uncertain");
  assert.equal(result.requestHash, input.requestHash);
  assert.equal(result.goalReference, null);
});
test("omitting a goal index cannot hide unresolved task control or revision", () => {
  const { goalObjectIndex: _index, ...withoutGoal } = task;
  for (const goalRelation of ["continue", "revise", "control", "discuss", "unclear"]) {
    const result = resolveAgentTurnInterpretation({ ...withoutGoal, goalRelation }, input);
    assert.equal(result.goalReference, null);
    assert.equal(result.toolUse, "uncertain");
    assert.equal(result.status, "uncertain");
    assert.ok(result.ambiguities.length > 0);
  }
});
