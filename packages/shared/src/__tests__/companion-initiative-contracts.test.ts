import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { companionParticipationPreferencesWriteV1Schema, companionAttentionWriteV1Schema,
  companionAwarenessObservationV1Schema, companionInitiativeInputV1Schema } from "../contracts/companion-initiative-contracts.ts";
import { companionStreamEventV1Schema } from "../contracts/companion-conversation-contracts.ts";
import { getCompanionAgentTool, validateCompanionAgentToolArguments } from "../companion-agent-registry.ts";

test("participation retains unseen user prose and open timing without a fixed rule type", () => {
  for (const markdown of ["学久了提醒我走走", "每学五十分钟提醒一次", "我重新打开上次没弄懂的笔记时，先帮我回忆一下", "晚上聊轻松一点，先歇会儿时不要接着讲题"]) {
    assert.equal(companionParticipationPreferencesWriteV1Schema.parse({ expectedRevision: 0, markdown, enabled: true }).markdown, markdown);
  }
  assert.equal(companionParticipationPreferencesWriteV1Schema.safeParse({ expectedRevision: 0, markdown: "你好", enabled: true, ruleType: "greeting" }).success, false);
});
test("attention is derived and can be completed without a perpetual clock", () => {
  const value = { key: "an-interest", expectedRevision: 0, intent: "材料有新进展时回来比较；疑问解决就收尾。", topics: ["result.available"],
    nextReviewAt: null, expiresAt: null, preferenceRevision: null, selfNote: { key: "interest", revision: 1 }, state: "active" };
  assert.equal(companionAttentionWriteV1Schema.parse(value).nextReviewAt, null);
  assert.equal(companionAttentionWriteV1Schema.safeParse({ ...value, topics: ["invented.event"] }).success, false);
});
test("help requires a domain fact; long dwell alone has no difficulty flag", () => {
  const observation = { version: 1, id: randomUUID(), deviceSessionId: "browser:session", appLaunchId: randomUUID(), host: "browser",
    topic: "help.available", occurredAt: new Date().toISOString(), elapsedMs: 30_000,
    context: { foreground: true, unlocked: true, typing: false, learning: true, conversationId: null, page: null } };
  assert.equal(companionAwarenessObservationV1Schema.safeParse(observation).success, false);
  assert.equal(companionAwarenessObservationV1Schema.safeParse({ ...observation, evidence: { domain: "source", entityId: "id", revision: "1", description: "本次解析失败，有重新解析入口。" } }).success, true);
});
test("quiet presence requires an observed foreground, allowed, non-typing duration", () => {
  const observation = { version: 1, id: randomUUID(), deviceSessionId: "browser:session", appLaunchId: randomUUID(), host: "browser",
    topic: "presence.quiet", occurredAt: new Date().toISOString(), elapsedMs: 15_000,
    context: { foreground: true, unlocked: true, typing: false, learning: false, quietForMs: 180_000,
      conversationId: null, page: null } };
  assert.equal(companionAwarenessObservationV1Schema.safeParse(observation).success, true);
  assert.equal(companionAwarenessObservationV1Schema.safeParse({ ...observation, context: { ...observation.context, foreground: false } }).success, false);
  assert.equal(companionAwarenessObservationV1Schema.safeParse({ ...observation, context: { ...observation.context, typing: true } }).success, false);
  assert.equal(companionAwarenessObservationV1Schema.safeParse({ ...observation, context: { ...observation.context, quietForMs: undefined } }).success, false);
});
test("initiative source has its own identity, and speech/silence have explicit events", () => {
  const input = { version: 1, kind: "initiative", preparationJobId: randomUUID(), observationId: randomUUID(), attentionKey: null, attentionRevision: null,
    preferenceRevision: 1, parentRunId: null, deviceSessionId: "desktop:launch:window", topic: "app.started", intent: "接住启动问候", facts: {} };
  assert.equal(companionInitiativeInputV1Schema.parse(input).kind, "initiative");
  const base = { version: 1, eventId: "event-1", workspaceId: randomUUID(), conversationId: randomUUID(), seq: 2, runId: randomUUID(), generation: 1, accountEpoch: 0, createdAt: new Date().toISOString() };
  assert.equal(companionStreamEventV1Schema.safeParse({ ...base, type: "turn.completed", payload: { messageIds: [], silent: true } }).success, true);
  for (const name of ["companion_read_participation", "companion_save_participation", "companion_arrange_attention", "companion_publish_utterance"]) assert.ok(getCompanionAgentTool(name), name);
  assert.equal(validateCompanionAgentToolArguments("companion_publish_utterance", { text: "先用一个小例子说明。" }).success, true);
});
