import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCasualFirstStepRequest } from "../companion-speculative-first-step.ts";
import { companionResponseStrategy, COMPANION_KNOWLEDGE_REVIEW_V1, isCompanionExplanation } from "../companion-response-strategy.ts";
import { companionTurnThinking } from "../companion-turn-thinking.ts";
import { companionStepRuntimePolicy } from "../companion-step-plan.ts";
import { COMPANION_DIALOGUE_CONTINUATION_GOAL_V1 } from "../companion-conversation-policy.ts";

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
  assert.ok(request.systemPrompt.includes(COMPANION_DIALOGUE_CONTINUATION_GOAL_V1));
  const policy = companionStepRuntimePolicy({ permissionLevel: "read_only", toolCount: 0,
    stepBudget: 3, finalAnswerOnly: false, attentionIntent: "conversation" });
  assert.ok(request.systemPrompt.includes(policy));
  assert.ok(policy.includes(COMPANION_DIALOGUE_CONTINUATION_GOAL_V1));
  // 闲聊姿态按**本轮意图**给，不再按工具面给（2026-10-09）：工具面已经与意图解耦，
  // "这轮有工具"不再等于"这轮要办事"。
  for (const input of [{ attentionIntent: "question", toolCount: 0 },
    { attentionIntent: "question", toolCount: 40 }, { attentionIntent: "task", toolCount: 0 },
    { attentionIntent: "mixed", toolCount: 40 }]) {
    assert.ok(!companionStepRuntimePolicy({ ...input, permissionLevel: "read_only", stepBudget: 3,
      finalAnswerOnly: false }).includes(COMPANION_DIALOGUE_CONTINUATION_GOAL_V1));
  }
  // 两种闲聊各说各的事实：那句"这一轮没有工具"只在她真的没拿到工具时出现。
  // 线上一句"我手上没有新建笔记的入口"就是这么来的——工具被摘了，她照实说；
  // 提示词反过来把没有的东西说成有，是同一类错。
  for (const toolCount of [0, 40]) {
    const casual = companionStepRuntimePolicy({ permissionLevel: "full", toolCount, stepBudget: 3,
      finalAnswerOnly: false, attentionIntent: "conversation" });
    assert.ok(casual.includes(COMPANION_DIALOGUE_CONTINUATION_GOAL_V1));
    assert.equal(casual.includes("这一轮没有工具"), toolCount === 0,
      `工具面 ${toolCount} 个时"没有工具"那句话${toolCount === 0 ? "该在" : "不该在"}`);
  }
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
  assert.equal(isCompanionExplanation({intent:"question"},"为什么咖啡会凉？",0),true);
  assert.equal(isCompanionExplanation({intent:"question"},"Explain inertia",0),true);
  assert.equal(isCompanionExplanation({intent:"question"},"你今天看到什么？",0),false);
  assert.equal(isCompanionExplanation({intent:"conversation"},"今天不想学",0),false);
  assert.equal(isCompanionExplanation({intent:"task"},"详细整理笔记",1),false);
});

test("没有工具的提问不注入执行手册，不暗示可以另查记录", () => {
  const policy=companionStepRuntimePolicy({permissionLevel:"read_only",toolCount:0,stepBudget:4,
    finalAnswerOnly:false,attentionIntent:"question"});
  assert.match(policy,/本轮没有可调用工具/);
  assert.match(policy,/不把工具调用写成正文/);
  assert.match(policy,/材料不足时直接说明不足/);
  assert.doesNotMatch(policy,/companion_read_memory|outcome_unknown|后台交付/);
});
