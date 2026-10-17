import assert from "node:assert/strict";
import { test } from "node:test";

import { getCompanionAgentTool } from "@astella/shared";
import {
  buildCasualFirstStepRequest,
  buildQuestionFirstStepRequest,
  shouldKeepSpeculativeFirstStep,
  shouldKeepSpeculativeQuestionStep,
} from "../agent/companion-speculative-first-step.ts";

/**
 * 保留投机结果的条件（2026-10-07）：投机的提示词里没有注意力块，所以只有真实解释
 * **什么都没带来**时，缺那一块才等价于没缺。四条缺一不可。
 */
test("解释为空时才留下投机的闲聊版", () => {
  assert.equal(shouldKeepSpeculativeFirstStep({ intent: "conversation", toolUse: "none", subjects: [], ambiguities: [] }), true);
});

test("任何工具意图都作废：该看该动的轮次必须看到真实的解释", () => {
  for (const toolUse of ["read", "act", "uncertain"] as const) {
    assert.equal(shouldKeepSpeculativeFirstStep({ intent: "conversation", toolUse, subjects: [], ambiguities: [] }), false, toolUse);
  }
});

test("非闲聊的意图作废", () => {
  for (const intent of ["question", "task", "task_control", "mixed"] as const) {
    assert.equal(shouldKeepSpeculativeFirstStep({ intent, toolUse: "none", subjects: [], ambiguities: [] }), false, intent);
  }
});

test("有待核对的指称或未解歧义时作废（哪怕她是闲聊）", () => {
  assert.equal(shouldKeepSpeculativeFirstStep({
    intent: "conversation", toolUse: "none",
    subjects: [{ description: "那篇笔记" }], ambiguities: [],
  }), false, "有指称：真实解释会指出对象，投机的提示词里没有");
  assert.equal(shouldKeepSpeculativeFirstStep({
    intent: "conversation", toolUse: "none",
    subjects: [], ambiguities: ["与任务的关系尚未澄清。"],
  }), false, "有歧义：该先核对再答");
});

test("方言指代需要澄清时作废，让正式回复看到结构化解释", () => {
  assert.equal(shouldKeepSpeculativeFirstStep({
    intent: "conversation", toolUse: "none", subjects: [], ambiguities: [],
    voiceStyle: { decision: "clarify", instruction: null, persistentPreference: { action: "keep", dialect: null } },
  }), false);
});

test("她上一条还挂着用户没接的收尾时作废——投机的请求是按未改写的历史发出去的", () => {
  assert.equal(shouldKeepSpeculativeFirstStep({
    intent: "conversation", toolUse: "none", subjects: [], ambiguities: [],
    pendingOfferIndexes: [5],
  }), false, "留着它就等于绕过收尾降级，用户看到的还是那笔没结清的账");
  assert.equal(shouldKeepSpeculativeFirstStep({
    intent: "conversation", toolUse: "none", subjects: [], ambiguities: [],
    pendingOfferIndexes: [],
  }), true, "没有待收的账时不额外花一次调用");
});


test("提前生成的闲聊第一步提供自身工具，业务写入不进入投机面", () => {
  const own = getCompanionAgentTool("companion_write_self_note")!, business = getCompanionAgentTool("companion_create_note")!;
  const request = buildCasualFirstStepRequest({ turnPolicy: "当前身份", permissionLevel: "read_only", stepBudget: 3,
    messages: [{ role: "user", content: "你在关注什么？" }], maxTokens: 8000,
    tools: [own, business].map(({ name, description, parameters }) => ({ name, description, parameters })) });
  assert.deepEqual(request.tools?.map(tool => tool.name), ["companion_write_self_note"]);
  assert.doesNotMatch(request.systemPrompt, /本轮没有可调用工具/);
});

/**
 * 提问版投机（2026-10-13）：问题轮的保留条件比闲聊版更严一档——解释要"什么都没带来"，
 * 并且与后台目标无关（有关联时真实提示词里带着目标引用，少那一块可能漏掉语义）。
 */
test("干净的问题（无指称、无歧义、无候选动作、目标无关）留下提问版", () => {
  assert.equal(shouldKeepSpeculativeQuestionStep({
    intent: "question", toolUse: "none", subjects: [], ambiguities: [], candidateOperations: [],
    goalRelation: "unrelated", pendingOfferIndexes: [],
  }), true);
});

test("非 question 意图或任何工具意图都作废提问版", () => {
  for (const intent of ["conversation", "task", "task_control", "mixed"] as const) {
    assert.equal(shouldKeepSpeculativeQuestionStep({ intent, toolUse: "none", goalRelation: "unrelated" }), false, intent);
  }
  for (const toolUse of ["read", "act", "uncertain"] as const) {
    assert.equal(shouldKeepSpeculativeQuestionStep({ intent: "question", toolUse, goalRelation: "unrelated" }), false, toolUse);
  }
});

test("提问版遇到指称、歧义、候选动作、目标关联或待收的账都作废", () => {
  const base = { intent: "question", toolUse: "none", subjects: [], ambiguities: [], candidateOperations: [],
    goalRelation: "unrelated", pendingOfferIndexes: [] } as const;
  assert.equal(shouldKeepSpeculativeQuestionStep({ ...base, subjects: [{ description: "那篇笔记" }] }), false, "有指称");
  assert.equal(shouldKeepSpeculativeQuestionStep({ ...base, ambiguities: ["指代不明"] }), false, "有歧义");
  assert.equal(shouldKeepSpeculativeQuestionStep({ ...base, candidateOperations: ["companion_read_note"] }), false, "有候选动作");
  assert.equal(shouldKeepSpeculativeQuestionStep({ ...base, pendingOfferIndexes: [4] }), false, "有待收的账");
  assert.equal(shouldKeepSpeculativeQuestionStep({ ...base, voiceStyle: { decision: "clarify" } as never }), false, "方言待澄清");
  for (const goalRelation of ["new", "continue", "revise", "control", "discuss", "unclear", undefined]) {
    assert.equal(shouldKeepSpeculativeQuestionStep({ ...base, goalRelation } as never), false, `目标关系 ${goalRelation}`);
  }
});

test("提问版的第一步与真实第一步同形：完整工具面、开思考、知识核对指引、温度 0.3", () => {
  const own = getCompanionAgentTool("companion_write_self_note")!, business = getCompanionAgentTool("companion_create_note")!;
  const request = buildQuestionFirstStepRequest({ turnPolicy: "当前身份", permissionLevel: "full", stepBudget: 5,
    messages: [{ role: "user", content: "牛顿第二定律是什么？" }], maxTokens: 8000,
    tools: [own, business].map(({ name, description, parameters }) => ({ name, description, parameters })) });
  // 与闲聊版不同：写类工具照发（工具面只由声明决定），不是只看自身工具。
  assert.deepEqual(request.tools?.map(tool => tool.name), ["companion_write_self_note", "companion_create_note"]);
  assert.equal(request.disableThinking, false);
  assert.equal(request.temperature, 0.3);
  assert.equal(request.toolChoice, "auto");
  // 知识核对指引在场（与真实提问步同一份 responseStrategy 文案）。
  assert.match(request.systemPrompt, /方向是否颠倒/);
  // 唯一的差别就是还没有注意力块。
  assert.doesNotMatch(request.systemPrompt, /current_turn_interpretation_data/);
});
