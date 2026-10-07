import assert from "node:assert/strict";
import { test } from "node:test";

import { shouldKeepSpeculativeFirstStep } from "../companion-speculative-first-step.ts";

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
