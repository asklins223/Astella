import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCasualFirstStepRequest } from "../companion-speculative-first-step.ts";
import { companionResponseStrategy, companionExplanationReviewEnabled, COMPANION_KNOWLEDGE_REVIEW_V1, shouldReviewCompanionExplanation } from "../companion-response-strategy.ts";
import { companionTurnThinking } from "../companion-turn-thinking.ts";
import { companionStepRuntimePolicy } from "../companion-step-plan.ts";

test("解释、混合与分类失败使用稳定参数，内部检查不冒充独立验证", () => {
  for (const attention of [{ intent: "question", toolUse: "none" },
    { intent: "mixed", toolUse: "read" }, null, undefined]) {
    const strategy = companionResponseStrategy(attention);
    assert.equal(strategy.mode, "knowledge");
    assert.equal(strategy.temperature, 0.3);
    assert.match(strategy.guidance, /方向是否颠倒/);
    assert.match(strategy.guidance, /没有可靠依据的细节不要补猜/);
    assert.match(strategy.guidance, /不算独立证据/);
    assert.equal(companionTurnThinking(attention).disableThinking, false);
  }
});

test("闲聊预生成和正式闲聊使用同一参数，不附知识检查清单", () => {
  const strategy = companionResponseStrategy({ intent: "conversation", toolUse: "none" });
  const request = buildCasualFirstStepRequest({ turnPolicy: "接住当下这句话。", permissionLevel: "read_only",
    stepBudget: 3, messages: [{ role: "user", content: "今天先歇着" }], maxTokens: 8192 });
  assert.equal(strategy.mode, "casual");
  assert.equal(strategy.guidance, "");
  assert.equal(request.temperature, strategy.temperature);
  assert.equal(request.disableThinking, true);
  assert.ok(!request.systemPrompt.includes(COMPANION_KNOWLEDGE_REVIEW_V1));
});

test("动作、控制与带读取的聊天保留工具执行档", () => {
  for (const attention of [{ intent: "task", toolUse: "act" },
    { intent: "task_control", toolUse: "none" }, { intent: "conversation", toolUse: "read" }]) {
    const strategy = companionResponseStrategy(attention);
    assert.equal(strategy.mode, "task");
    assert.equal(strategy.temperature, 0.4);
    assert.equal(companionTurnThinking(attention).disableThinking, false);
  }
});

test("发布前复核只接管明确要求解释的无工具提问，不增加闲聊或工具动作的往返", () => {
  assert.equal(shouldReviewCompanionExplanation({intent:"question"},"为什么咖啡会凉？",0),true);
  assert.equal(shouldReviewCompanionExplanation({intent:"question"},"Explain inertia",0),true);
  assert.equal(shouldReviewCompanionExplanation({intent:"question"},"你今天看到什么？",0),false);
  assert.equal(shouldReviewCompanionExplanation({intent:"conversation"},"今天不想学",0),false);
  assert.equal(shouldReviewCompanionExplanation({intent:"task"},"详细整理笔记",1),false);
});

test("没有工具的提问不注入执行手册，不暗示可以另查记录", () => {
  const policy=companionStepRuntimePolicy({permissionLevel:"read_only",toolCount:0,stepBudget:4,
    finalAnswerOnly:false,attentionIntent:"question"});
  assert.match(policy,/本轮没有可调用工具/);
  assert.match(policy,/不把工具调用写成正文/);
  assert.match(policy,/材料不足时直接说明不足/);
  assert.doesNotMatch(policy,/companion_read_memory|outcome_unknown|后台交付/);
});


test("收益未达标的发布前自检默认关闭，只有明确实验开关才启用", () => {
  const saved=process.env.COMPANION_EXPLANATION_REVIEW_V1;
  try {
    delete process.env.COMPANION_EXPLANATION_REVIEW_V1;
    assert.equal(companionExplanationReviewEnabled(),false);
    process.env.COMPANION_EXPLANATION_REVIEW_V1="false";
    assert.equal(companionExplanationReviewEnabled(),false);
    process.env.COMPANION_EXPLANATION_REVIEW_V1="true";
    assert.equal(companionExplanationReviewEnabled(),true);
  } finally {
    if(saved===undefined)delete process.env.COMPANION_EXPLANATION_REVIEW_V1;
    else process.env.COMPANION_EXPLANATION_REVIEW_V1=saved;
  }
});
