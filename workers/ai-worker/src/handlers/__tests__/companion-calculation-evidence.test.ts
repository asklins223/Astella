import assert from "node:assert/strict";
import test from "node:test";
import { reviewCompanionStepCorrection } from "../turn/companion-step-plan.ts";
import { unverifiedNumericClaims } from "../turn/companion-dialogue-content.ts";

const calculation = [
  { role: "assistant" as const, content: "", toolCalls: [{ id: "calc", name: "agent_calculate", arguments: { expression: "1/6" } }] },
  { role: "tool" as const, toolCallId: "calc", content: '{"value":0.16666666666666666}' },
];
const base = { contextText: "", messages: calculation, turnToolUse: "read", pageContext: null,
  groundedTutorContext: null, stepCalls: 0, toolCallCount: 1, finalAnswerOnly: false,
  stepCount: 2, stepBudget: 8, nowMs: 100, deadlineAt: 1000, userAskedForAction: false,
  requestedActionTools: [], actionSteerAttempts: 0, lookupClaimSteered: false, quoteCorrectionUsed: false };

test("计算回执不把生活类比的引号当作真实来源引文", () => {
  const result = reviewCompanionStepCorrection({ ...base,
    said: "先来个生活例子：你想问的是「既然下雨了，我带伞的概率有多大」。" });
  assert.deepEqual(result.unverifiedQuotes, []);
  assert.equal(result.correctQuote, false);
  assert.equal(result.steerPlan.steer, false);
});

test("计算不豁免明确归属原文的引用，也不豁免资料读取与页面选区", () => {
  const quote = "教材原文写着：「既然下雨了，我带伞的概率有多大」。";
  assert.equal(reviewCompanionStepCorrection({ ...base, said: quote }).unverifiedQuotes.length, 1);
  const source = [{ role: "assistant" as const, content: "", toolCalls: [{ id: "read", name: "companion_read_note", arguments: {} }] },
    { role: "tool" as const, toolCallId: "read", content: "原文只有这句话。" }];
  assert.equal(reviewCompanionStepCorrection({ ...base, messages: [...calculation, ...source],
    said: "笔记原文写着：「这是一段来源中并不存在的知识原文」。" }).unverifiedQuotes.length, 1);
  assert.equal(reviewCompanionStepCorrection({ ...base, messages: [],
    said: "「这是一段来源中并不存在的知识原文」。" }).unverifiedQuotes.length, 0,
  "没有来源归属的「」是强调或概括，不按逐字原文判");
  assert.equal(reviewCompanionStepCorrection({ ...base, pageContext: { selection: { text: "真实页面原文。" } },
    said: "你刚划选的原文是：「这是一段来源中并不存在的知识原文」。" }).unverifiedQuotes.length, 1);
});

test("教学示例的百分比不触发个人读数纠正，真实读数和来源声明仍核对", () => {
  assert.deepEqual(unverifiedNumericClaims(
    "代入得到后验概率 16.7%。\n\n先验概率为 1%。\n\n第二组结果约为 77.4%。\n\n你本周的正确率是 83%。\n\n页面显示患病率是 2%。", ""), ["83%", "2%"]);
  assert.deepEqual(unverifiedNumericClaims("你学了20%。你的得分提高17%。你完成了80%。", ""), ["20%", "17%", "80%"]);
});
