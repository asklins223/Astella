import { test } from "node:test";
import assert from "node:assert/strict";
import { companionInitiativeAttentionIntent, renderCompanionInitiativeObservation } from "../companion-initiative-observation.ts";
import { companionResponseStrategy } from "../companion-response-strategy.ts";
import type { CompanionInitiativeInputV1 } from "@astella/shared/companion-initiative-contracts";

function initiative(over: Partial<CompanionInitiativeInputV1> = {}): CompanionInitiativeInputV1 {
  return {
    version: 1, kind: "initiative",
    preparationJobId: "11111111-1111-4111-8111-111111111111",
    observationId: null, attentionKey: null, attentionRevision: null,
    preferenceRevision: 0, parentRunId: null, deviceSessionId: "desktop:launch:3",
    topic: "app.started", intent: "",
    facts: { canSpeak: true, awareness: { sessions: [] }, attention: [], observation: null, selfNote: null },
    ...over,
  } as CompanionInitiativeInputV1;
}

test("招呼与陪着说话用陪聊档，不再按讲题模式生成", () => {
  for (const topic of ["app.started", "app.foreground", "study.started", "preference.changed", "presence.quiet"]) {
    const attention = companionInitiativeAttentionIntent(topic);
    assert.equal(attention.intent, "conversation", topic);
    const strategy = companionResponseStrategy(attention);
    assert.equal(strategy.mode, "casual", topic);
    assert.ok(strategy.temperature > 0.7, `${topic} 不该拿讲题的低温`);
    assert.equal(strategy.guidance, "", `${topic} 不该挂知识复核提示`);
    // 陪聊档同时命中现役的「闲聊关思考」判据，不需要为主动通道另开一档。
    assert.ok(companionInitiativeAttentionIntent(topic).toolUse === "none");
  }
});

test("页面与难题帮助留在讲解档，自己的关注走办事档", () => {
  assert.equal(companionResponseStrategy(companionInitiativeAttentionIntent("page.arrived")).mode, "knowledge");
  assert.equal(companionResponseStrategy(companionInitiativeAttentionIntent("help.available")).mode, "knowledge");
  assert.equal(companionResponseStrategy(companionInitiativeAttentionIntent("reply.finished")).mode, "knowledge");
  assert.equal(companionInitiativeAttentionIntent("attention.due").intent, "task");
  assert.equal(companionInitiativeAttentionIntent("self_note.due").intent, "task");
  // 办事档要求工具可用：她要真去查阅和推进自己的记事。
  assert.equal(companionInitiativeAttentionIntent("attention.due").toolUse, "uncertain");
});

test("观察消息说清这是什么时刻，只留她真正要读的事实", () => {
  const text = renderCompanionInitiativeObservation(initiative({
    topic: "help.available", intent: "这次资料处理失败了，看能不能给一个可操作的下一步。",
    facts: { canSpeak: true, awareness: { sessions: [] }, attention: [], observation: {
      facts: { evidence: { domain: "source", entityId: "src-77", revision: "v3", description: "PDF 解析在第 2 页失败" } },
    } },
  }));
  assert.match(text, /这不是他发来的话/);
  assert.match(text, /宿主报告/);
  assert.match(text, /src-77/, "领域事实的实体身份要能带回去，否则她看得见描述点不回那份资料");
  assert.match(text, /PDF 解析在第 2 页失败/);
  assert.match(text, /这次资料处理失败了/);
  // 准备 job、租约与运行身份是宿主管线，不是她的话头。
  for (const plumbing of ["preparationJobId", "attentionRevision", "observationId", "deviceSessionId", "sessions"])
    assert.ok(!text.includes(plumbing), `观察消息不该带宿主内部字段 ${plumbing}`);
});

test("没有值得说的就不说，这条规矩跟着每一次观察", () => {
  assert.match(renderCompanionInitiativeObservation(initiative()), /安静结束/);
  assert.match(renderCompanionInitiativeObservation(initiative()), /不要把「没什么补充」「本轮不发言」当成一句话发出去/);
});

test("安静机会只报告可观察到的前台停顿，不替用户推断情绪或需求", () => {
  const text = renderCompanionInitiativeObservation(initiative({
    topic: "presence.quiet",
    facts: { canSpeak: true, awareness: { sessions: [] }, attention: [], observation: {
      facts: { context: { quietForMs: 240_000 }, evidence: null },
    } },
  }));
  assert.match(text, /前台约 4 分钟没有新的操作/);
  assert.match(text, /不说明他走神、空闲或需要帮助/);
});

test("人不在这台设备前面时，不叫她把话发出去", () => {
  const away = renderCompanionInitiativeObservation(initiative({
    topic: "attention.due", intent: "接着想他上次没弄懂的那一步。",
    facts: { canSpeak: false, awareness: { sessions: [] }, attention: [], observation: null },
  }));
  assert.match(away, /现在不要把话发出去/);
  assert.match(away, /写进自己的记事或关注/);
  assert.ok(!/现在可以把话说到他身边/.test(away));
});

test("她要处理的事原样到达，多条关注合起来也不裁尾", () => {
  const long = `第一件：${"先把这次的实际进展查清楚。".repeat(200)}`;
  const second = `第二件：${"他问过但没有答的那个疑问还要接着想。".repeat(200)}`;
  const text = renderCompanionInitiativeObservation(initiative({ topic: "attention.due", intent: `${long}\n${second}` }));
  assert.ok(text.includes(long) && text.includes(second), "关注意图被静默截断等于替她忘掉后半件事");
});
