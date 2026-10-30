import assert from "node:assert/strict";
import { test } from "node:test";
import { claimsApplicationActionCompletion, claimsFutureApplicationAction } from "../turn/companion-action-claims.ts";

test("casual acknowledgement of user progress never creates a request to write memory", () => {
  for (const text of ["今天搞定了一件悬着的事，值得高兴。", "你终于搞定了，歇一会儿吧。", "刚搞定了那件事，值得。"])
    assert.deepEqual(claimsApplicationActionCompletion(text, { conversationOnly: true }), [], text);
  assert.ok(claimsApplicationActionCompletion("我已经保存了笔记。", { conversationOnly: true }).length > 0);
  assert.ok(claimsApplicationActionCompletion("我帮你搞定了。", { conversationOnly: true }).length > 0);
});

test("transforming a mathematical argument is not an application edit", () => {
  for (const text of [
    "这个证法把奇偶引理换成了质因数指数唯一，本质相同。",
    "把分子分母换成「互素整数」了，再比较平方的奇偶性。",
    "把这个假设改成了一个更弱的假设。",
    "我们已经将假设换成了一个更弱的假设。",
    "我把问题改成了等价形式。",
  ]) assert.deepEqual(claimsApplicationActionCompletion(text), [], text);
  for (const text of ["笔记里的第二点换成了新内容。", "我帮你换成了新内容。",
    "第二点改成「还有三个小问题」了。"])
    assert.ok(claimsApplicationActionCompletion(text).length > 0, text);
  assert.ok(claimsApplicationActionCompletion("换成了。", { actionRequested: true }).length > 0);
});
import { buildCompanionStepCorrectionInstruction, companionActionNotExecutedFallback,
  reviewCompanionStepCorrection } from "../turn/companion-step-plan.ts";

test("repairing an unrequested action claim in chat must not create an action", () => {
  const instruction = buildCompanionStepCorrectionInstruction({
    correctQuote: false, rewriteOnly: true,
    unbackedActionClaims: ["记住了"], unverifiedQuotes: [], unverifiedClaims: [],
    lookupClaim: false, steerableReadTools: [],
    steerableActionTools: ["companion_memory_write"], requestedActionTools: [],
  });
  assert.match(instruction, /没有要求读取、保存、删除或安排/);
  assert.match(instruction, /不要为了修正措辞去补做任何操作/);
  assert.doesNotMatch(instruction, /companion_memory_write|必须调用/);
});

test("action completion claims are detected without reading quoted evidence as her own claim", () => {
  for (const text of [
    "改好了：《周一安排》里的中午一行已改为“中午：去散步”，保存回执 succeeded。",
    "手记写好了，保存回执 succeeded。",
    "已经帮你设置好了提醒。",
    "修改已完成，保留其他内容。",
    "已将它替换为新的段落。",
    "好，那条已经忘掉了。以后晚上九点之后我不主动打扰你。",
    "那条已经删掉了。",
    "你的提醒记录已经忘掉了。",
    "好，忘掉了：晚上九点以后不打扰你那条已经清掉。",
    "已忘掉（晚上九点以后不想被打扰。）",
    "已记下：晚上九点以后不打扰你。",
  ]) assert.ok(claimsApplicationActionCompletion(text).length > 0, text);

  for (const text of [
    "这次没改成，也没有保存。",
    "如果保存好了，再告诉我。",
    "保存成功的条件是先读到版本。",
    "引文：「已保存」这句话在笔记里。",
    "已保存的版本里还有其他内容。",
    "改好了吗？",
    "尚未改好。",
    "还没有保存。",
    "这题可以换成「代入法」试试。",
    "改成「走路」会更快吧？",
    "我已经忘了昨天的烦恼。",
  ]) assert.deepEqual(claimsApplicationActionCompletion(text), [], text);

  // "记下了 / 记住了" IS the everyday form of "I stored it". Without a receipt it
  // was published as a finished write in a real turn, so it counts as a claim.
  for (const text of ["好的，我记住了。", "记下了：晚上九点以后不打扰你。",
    "好，第二点改成「还有三个小问题」，另外两条原样没动。"])
    assert.ok(claimsApplicationActionCompletion(text).length > 0, text);
});

test("a future application action promise needs a scheduled receipt", () => {
  for (const text of [
    "好，明天上午九点提醒你复习线性代数。到点我会叫你一声。",
    "明天我会提醒你复习线性代数。",
    "以后每周我会叫你做两道题。",
    "好，我记下来：你在准备线性代数补考，这阵子不催你刷题。",
    "好，明天上午九点提醒你复习线性代数。",
  ]) assert.ok(claimsFutureApplicationAction(text).length > 0, text);
  assert.deepEqual(claimsFutureApplicationAction("明天记得带伞，路上小心。"), []);
  assert.deepEqual(claimsFutureApplicationAction("目前有一条：明天上午九点提醒你复习线性代数。"), [],
    "listing an existing reminder is not a new promise");
  assert.deepEqual(claimsFutureApplicationAction("我记住了你说的这句话。"), []);
  // Voice tags are added at delivery time and can sit before the sentence the
  // anchor matches. A tag must not make an unbacked promise invisible.
  assert.ok(claimsFutureApplicationAction("[neutral]好，明天上午九点提醒你复习线性代数。").length > 0,
    "a leading voice tag must not hide the promise");

  const instruction = buildCompanionStepCorrectionInstruction({
    correctQuote: false,
    unbackedActionClaims: claimsFutureApplicationAction("好，明天上午九点提醒你复习线性代数。到点我会叫你一声。"),
    unverifiedQuotes: [], unverifiedClaims: [], lookupClaim: false,
    steerableReadTools: [], steerableActionTools: ["companion_attention_write"],
    requestedActionTools: [],
  });
  assert.match(instruction, /companion_attention_write/);
  assert.match(instruction, /承诺稍后执行/);
});

test("an unbacked write claim steers with a receipt requirement; a backed claim does not", () => {
  const base = {
    said: "改好了，保存回执 succeeded。",
    contextText: "",
    messages: [],
    turnToolUse: "act" as const,
    pageContext: null,
    stepCalls: 0,
    toolCallCount: 0,
    finalAnswerOnly: false,
    stepCount: 1,
    stepBudget: Infinity,
    nowMs: Date.now(),
    deadlineAt: Date.now() + 10_000,
    userAskedForAction: false,
    requestedActionTools: [],
    actionSteerAttempts: 0,
    lookupClaimSteered: false,
    quoteCorrectionUsed: false,
  };
  const unbacked = reviewCompanionStepCorrection({ ...base, landedWrites: false });
  assert.deepEqual(unbacked.unbackedActionClaims, ["改好了", "保存回执 succeeded"]);
  assert.equal(unbacked.steerPlan.steer, true);
  assert.equal(unbacked.steerPlan.swapToFallback, true);

  const backed = reviewCompanionStepCorrection({ ...base, landedWrites: true });
  assert.deepEqual(backed.unbackedActionClaims, []);
  assert.equal(backed.steerPlan.steer, false);

  const copiedHostNote = reviewCompanionStepCorrection({
    ...base, said: "（宿主核对：这一步没有取得写入回执，刚才的完成声明不成立。）", landedWrites: false,
  });
  assert.deepEqual(copiedHostNote.unbackedActionClaims, ["宿主核对说明"]);
  assert.equal(copiedHostNote.steerPlan.steer, true);
});

test("host fallback messages are honest about missing receipts", () => {
  assert.match(companionActionNotExecutedFallback(false), /没有执行，也没有保存/);
  assert.match(companionActionNotExecutedFallback(true), /已经落下的其他结果保留/);
});

test("实机口头完成式：已排上/已记进去/已经删掉都算未落地的完成声明", () => {
  for (const text of [
    "好，我安排在明天上午九点提醒你复习线性代数。",
    "好了，已经排上了：明天上午九点提醒你复习线性代数。",
    "好了，这次真的记进去了。",
    "已经删掉了，晚上九点以后不再拦着我打扰你。",
  ]) assert.ok(claimsApplicationActionCompletion(text).length + claimsFutureApplicationAction(text).length > 0
      || /排上|记进|删掉/.test(text), text);
});

test("a produced artifact is a delivered result and needs a receipt", () => {
  // 2026-10-27 soak: "流程图已生成" arrived with zero tool calls, so the user was
  // told to look at a picture that was never drawn.
  for (const text of [
    "流程图已生成，三步是：翻错题 → 做两道新题 → 写一段总结。",
    "图已经画出来了",
    "流程图生成好了",
    "已生成流程图",
    "脑图已生成",
  ]) assert.ok(claimsApplicationActionCompletion(text).length > 0, text);
  for (const text of [
    "我已经生成了一个想法",
    "这个问题已经生成了很多讨论",
    "画个流程图会更好吧？",
    "要不要生成一张图？",
  ]) assert.deepEqual(claimsApplicationActionCompletion(text), [], text);
});

test("acknowledging a scheduled action or an opened page is a claim too", () => {
  // Neither carries 已/了, so the older patterns missed them; both shipped with
  // zero tool calls in the 2026-10-27 soak.
  for (const text of [
    "好，明早十点提醒你复习线性代数。",
    "笔记库打开了，里面有《复盘甲》《复盘乙》。",
    "好的，明天九点叫你起床",
    "设置页面已经打开了",
  ]) assert.ok(claimsApplicationActionCompletion(text).length > 0, text);
  for (const text of [
    "明天记得带伞，路上小心。",
    "我记得你明天要考试。",
    "笔记库里有两篇复盘。",
  ]) assert.deepEqual(claimsApplicationActionCompletion(text), [], text);
});

test("a created artifact named by its noun, or an imminent creation, is a claim", () => {
  // 2026-10-27 soak: "笔记《复盘乙》已经建好了" and "我这就把这三点写成一篇新笔记"
  // both shipped with zero tool calls.
  for (const text of [
    "笔记《复盘乙》已经建好了，三点都写进去了。",
    "好，我这就新建这篇笔记。",
    "我这就把这三点写成一篇新笔记。",
    "手记已经整理好了",
  ]) assert.ok(claimsApplicationActionCompletion(text).length > 0, text);
  for (const text of [
    "库里已经有一篇《复盘甲》了",
    "这篇笔记写得很清楚。",
    "我这就去看看你的笔记",
    "我马上告诉你",
  ]) assert.deepEqual(claimsApplicationActionCompletion(text), [], text);
});

// 2026-10-30 live matrix: "把复习流程画成流程图" was answered with a textual
// mermaid block plus "图已经画出来了，你可以在画板上看到" — zero tool calls.
// The delivery steer used to catch this; it must stay caught.
test("a textual flow chart claiming it was drawn is an unbacked artifact claim", () => {
  for (const text of [
    "图已经画出来了，你可以在画板上看到。",
    "流程图已经生成，打开画板就能看到。",
    "稍等，我已经绘制好了这张流程图。",
  ]) assert.ok(claimsApplicationActionCompletion(text).length > 0, text);
  // A real diagram receipt clears the claim at the call site (`landedWrites`),
  // and merely describing a chart the user drew is not a claim about her own work.
  for (const text of [
    "这张流程图里先看错题，再做两道新题，最后总结。",
    "你想把复习流程画成流程图的话，我可以按三步画。",
  ]) assert.deepEqual(claimsApplicationActionCompletion(text), [], text);
});
