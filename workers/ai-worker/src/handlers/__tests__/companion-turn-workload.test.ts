import assert from "node:assert/strict";
import { test } from "node:test";
import { companionDirectInterpretation, createCompanionDirectControls } from "../turn/companion-entry-mode.ts";
import { companionStepReasoning, resolveCompanionTurnWorkload } from "../turn/companion-turn-workload.ts";
import { createCompanionMessageDelivery, requestedCompanionMessageCount } from "../turn/companion-message-delivery.ts";

const attention = companionDirectInterpretation("a".repeat(64));
const workload = (userText: string, requiresGrounding = false) => resolveCompanionTurnWorkload({
  mode: "direct_fast", userText, attention, requiresGrounding,
});

test("only complete casual utterances opt out of reasoning; compounds and uncertain replies retain it", () => {
  for (const text of ["在吗？", "在吗？今天有点累。", "今天有点累。", "哈哈，谢谢你。", "谢谢你，晚安。", "Hey, good morning!",
    "刚从外面回来，风好大。", "今天终于把拖了很久的事搞定了。", "今天脑子不想转了，我就想靠这儿待会儿。不用问我问题，也别安排学习。"])
    assert.equal(workload(text), "casual", text);
  for (const text of ["好", "继续", "谢谢，帮我记一下", "在吗？请证明这个结论", "你好，1+1等于几", "为什么海水是咸的？",
    "分两条消息发给我：早安，然后问好", "今天有点累，明天提醒我休息", "什么叫晚安？", "‘晚安’这个词怎么翻译？",
    "我今天想证明根号二是无理数", "我最近有个问题想请教你", "我刚才说的计划继续做", "今天这道题怎么算", "我今天就想删除笔记"])
    assert.equal(workload(text), "adaptive", text);
  assert.equal(workload("你好", true), "adaptive", "a picture or selected material keeps reasoning");
  assert.equal(resolveCompanionTurnWorkload({ mode: "direct_thinking", userText: "你好", attention, requiresGrounding: false }), "adaptive");
});

test("new tool evidence, corrections, explicit thinking and deepen override casual inference", async () => {
  const base = { mode: "direct_fast", workload: "casual", deepened: false,
    repairing: false, readOnlyRequiredStep: false, toolCallCount: 0 } as const;
  assert.equal(companionStepReasoning(base), "none");
  assert.equal(companionStepReasoning({ ...base, toolCallCount: 1 }), "medium");
  assert.equal(companionStepReasoning({ ...base, repairing: true, readOnlyRequiredStep: true }), "high");
  assert.equal(companionStepReasoning({ ...base, mode: "direct_thinking" }), "high");
  assert.equal(companionStepReasoning({ ...base, workload: "adaptive" }), undefined);
  const controls = createCompanionDirectControls({ mode: "direct_fast", userText: "你好", attention, casual: true });
  assert.equal(controls.disableThinking(), true);
  await controls.apply("companion_deepen", {});
  assert.equal(controls.disableThinking(), false);
  assert.equal(companionStepReasoning({ ...base, deepened: controls.deepened() }), "high");
});

test("message counts describe separate publications, never paragraphs or quoted old instructions", () => {
  for (const text of ["分两条消息发给我：先早安，再问好", "请分成3条独立消息给我", "拆成两条气泡发我", "Please reply in two separate messages"])
    assert.equal(requestedCompanionMessageCount(text), text.includes("3") ? 3 : 2, text);
  for (const text of ["分两点解释一下", "用两段话回答", "别分两条消息", "我之前说过分两条消息", "把‘分两条消息’翻译成英文"])
    assert.equal(requestedCompanionMessageCount(text), null, text);
  const delivery = createCompanionMessageDelivery("分两条消息发给我：早安，再晚安");
  assert.equal(delivery.incomplete(), true);
  delivery.record("first"); delivery.record("first");
  assert.equal(delivery.incomplete(), true, "replaying one publication must not count twice");
  delivery.record("second");
  assert.equal(delivery.incomplete(), false);
  assert.equal(delivery.full(), true);
  assert.equal(createCompanionMessageDelivery("分两条消息", false).incomplete(), false, "host observations aren't user requests");
});
