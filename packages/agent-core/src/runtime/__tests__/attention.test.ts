import test from "node:test";
import assert from "node:assert/strict";
import { resolveAgentTurnInterpretation } from "../attention.ts";
import { agentTurnInterpretationV1Schema } from "@astella/shared/agent-contracts";
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
test("待收的账只能指向宿主真的给出去过的那几条消息", () => {
  const result = resolveAgentTurnInterpretation({ ...task, intent: "conversation", toolUse: "none",
    goalRelation: "unrelated", pendingOfferIndexes: [3, 9, 3] },
  { ...input, offerCandidates: [0, 1, 2, 3, 4] });
  assert.deepEqual(result.pendingOfferIndexes, [3],
    "越界索引被丢掉，重复索引合并——解释不能发明一条不存在的历史");
});
test("宿主没有交出候选时一律不认（接线前的默认必须是「什么都不改」）", () => {
  const without = resolveAgentTurnInterpretation({ ...task, pendingOfferIndexes: [1] }, input);
  assert.deepEqual(without.pendingOfferIndexes, []);
  const empty = resolveAgentTurnInterpretation(task, input);
  assert.deepEqual(empty.pendingOfferIndexes, [], "模型没给这个字段时默认没有待收的账");
});

test("模型不能在现役合同中返回退休用途字段", () => {
  const result = resolveAgentTurnInterpretation({ ...task, dialogueFrame: { purpose: "correction" } }, input);
  assert.equal(result.status, "uncertain");
  assert.equal(result.toolUse, "uncertain");
  assert.equal("dialogueFrame" in result, false);
});

test("存量解释读取时丢弃退休实验字段，保留原有任务与权限判断", () => {
  const current = resolveAgentTurnInterpretation(task, input);
  const recorded = { ...current, dialogueFrame: {
    purpose: "correction", userState: [{ topic: "报告", aspect: "progress", quote: "写完了" }],
  } };
  assert.deepEqual(agentTurnInterpretationV1Schema.parse(recorded), current);
  assert.equal("dialogueFrame" in recorded, true, "解析不能改写原始历史记录");
  assert.equal(agentTurnInterpretationV1Schema.safeParse({ ...recorded, invented: true }).success, false,
    "移除实验字段不能放宽其他未声明字段");
});
