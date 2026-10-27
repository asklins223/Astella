import assert from "node:assert/strict";
import test from "node:test";
import { companionTimeWakeupConstraint } from "../agent/companion-execution-constraints.ts";
import { shouldKeepSpeculativeFirstStep, shouldKeepSpeculativeQuestionStep } from "../agent/companion-speculative-first-step.ts";
import { resolveAgentTurnInterpretation } from "@astella/agent-core";

const prohibited = { executionConstraints: { timeBasedWakeups: "forbid" as const } };
test("事件触发限制同时覆盖提醒、自己的重评和关注计划时间，仍允许取消时间", () => {
  for (const [name, field] of [["attention.write.arrange", "nextReviewAt"],
    ["attention.write.schedule_wake", "at"], ["attention.write.schedule_reminder", "fireAtLocal"]]) {
    assert.ok(companionTimeWakeupConstraint(prohibited, name!, { [field!]: "2026-10-15T18:00:00+08:00" }));
    assert.equal(companionTimeWakeupConstraint(prohibited, name!, { [field!]: null }), null);
    assert.equal(companionTimeWakeupConstraint({}, name!, { [field!]: "2026-10-15T18:00:00+08:00" }), null);
  }
  assert.equal(companionTimeWakeupConstraint(prohibited, "attention.write.save_participation", { enabled: true }), null);
});

test("新的禁止条件必须进入真实请求，不保留未包含条件的投机回复", () => {
  assert.equal(shouldKeepSpeculativeFirstStep({ ...prohibited, intent: "conversation", toolUse: "none" }), false);
  assert.equal(shouldKeepSpeculativeQuestionStep({ ...prohibited, intent: "question", toolUse: "none", goalRelation: "unrelated" }), false);
});

test("时间禁止必须引用当前原话，不能把上一轮的单轮要求当成当前限制", () => {
  const proposal = { intent: "task", toolUse: "act", subjects: [], goalRelation: "unrelated",
    candidateOperations: [], ambiguities: [], voiceStyle: { decision: "none", instruction: null },
    executionConstraints: { timeBasedWakeups: "forbid", sourceQuote: "不要固定时间" } };
  const binding = { requestHash: "0".repeat(64), objects: [], capabilities: [] };
  const valid = resolveAgentTurnInterpretation(proposal, { ...binding, currentUserText: "只按事件触发，不要固定时间。" });
  assert.equal(valid.executionConstraints?.timeBasedWakeups, "forbid");
  const stale = resolveAgentTurnInterpretation(proposal, { ...binding, currentUserText: "五分钟后提醒我喝水。" });
  assert.equal(stale.executionConstraints?.timeBasedWakeups, "unspecified");
  assert.equal(stale.status, "uncertain");
  assert.match(stale.ambiguities.join(""), /未引用本轮原话/);
});

test("关注计划的控制不索要后台目标身份，真正的目标控制仍要求绑定", () => {
  const proposal = { intent: "task_control", toolUse: "act", subjects: [], goalRelation: "control",
    candidateOperations: ["attention.write.arrange"], ambiguities: [], voiceStyle: { decision: "none", instruction: null } };
  const binding = { requestHash: "0".repeat(64), objects: [], capabilities: ["attention.write.arrange", "goals.write.control"] };
  const domain = resolveAgentTurnInterpretation(proposal, binding);
  assert.equal(domain.goalRelation, "unrelated");
  assert.equal(domain.status, "interpreted");
  const voice = resolveAgentTurnInterpretation({ ...proposal, toolUse: "none", candidateOperations: [],
    voiceStyle: { decision: "apply", instruction: "使用四川话。" } }, binding);
  assert.equal(voice.goalRelation, "unrelated");
  assert.equal(voice.status, "interpreted");
  const goal = resolveAgentTurnInterpretation({ ...proposal, candidateOperations: ["goals.write.control"] }, binding);
  assert.equal(goal.status, "uncertain");
  assert.match(goal.ambiguities.join(""), /所指任务/);
});
