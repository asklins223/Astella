/**
 * 反思触发门的单测（方案 50 §9.1）。
 *
 * 门只答"这一段值不值得花一次模型调用"，用**已记录的结构**回答。
 * 这里钉的是四条：真的来回过、间隔够、账号排队有上限、以及读不出依据就不发调用。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { companionReflectionGate, reflectionSnapshotSufficient } from "../companion-reflection-gate.ts";
import type { ReflectionInputSnapshotV1 } from "../companion-reflection-content.ts";

const now = new Date("2026-10-10T08:00:00+08:00");
const hoursBefore = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1000);

function gateInput(overrides: Partial<Parameters<typeof companionReflectionGate>[0]> = {}) {
  return {
    userMessageCount: 3, assistantDeliveredCount: 2,
    lastReflectionAt: null, openReflectionsForAccount: 0, now, ...overrides,
  };
}

test("只有一次招呼不回顾：没有真的来回过就不花模型调用", () => {
  assert.deepEqual(companionReflectionGate(gateInput({ userMessageCount: 1, assistantDeliveredCount: 1 })),
    { run: false, reason: "too_few_user_turns" });
});

test("她还没交付过回复时不回顾：末尾只有用户的话没什么可核对", () => {
  assert.deepEqual(companionReflectionGate(gateInput({ assistantDeliveredCount: 1 })),
    { run: false, reason: "no_delivered_reply" });
});

test("同一会话不到间隔不重跑；隔过间隔可以再来一次", () => {
  assert.deepEqual(companionReflectionGate(gateInput({ lastReflectionAt: hoursBefore(6) })),
    { run: false, reason: "interval_not_reached" });
  assert.deepEqual(companionReflectionGate(gateInput({ lastReflectionAt: hoursBefore(25) })), { run: true });
});

test("账号排队够多就先不再投，让上一批走完（低频账号仍能处理）", () => {
  assert.deepEqual(companionReflectionGate(gateInput({ openReflectionsForAccount: 3 })),
    { run: false, reason: "account_backlog_full" });
  assert.deepEqual(companionReflectionGate(gateInput({ openReflectionsForAccount: 2 })), { run: true });
});

test("从没回顾过的账号不受间隔闸门影响（否则新用户第一条就永远等一天）", () => {
  assert.deepEqual(companionReflectionGate(gateInput({ lastReflectionAt: null })), { run: true });
});

function snapshot(messages: ReflectionInputSnapshotV1["messages"]): ReflectionInputSnapshotV1 {
  return {
    conversationId: "c1", fromSeq: 0, toSeq: messages.length,
    persona: { revision: 1, name: "小猫", speakingStyle: "平实", selfDescription: null, personalityTags: [] },
    messages, toolReceipts: [], relatedMemories: [],
  };
}

test("一条消息都读不出来（被删或读不到）时安静结束，不发一次调用去编", () => {
  assert.deepEqual(reflectionSnapshotSufficient(snapshot([])),
    { ok: false, reason: "no_readable_messages" });
});

test("只剩她自己的话没有用户原话时不发调用：没有可核对的对象", () => {
  const result = reflectionSnapshotSufficient(snapshot([
    { id: "a1", seq: 1, role: "assistant", kind: "text", text: "我说了两句" },
  ]));
  assert.deepEqual(result, { ok: false, reason: "no_user_utterance" });
});

test("末尾是用户还在说话时不回顾：不能在被说到一半的时候给自己下结论", () => {
  const midTurn = reflectionSnapshotSufficient(snapshot([
    { id: "u1", seq: 1, role: "user", kind: "text", text: "早啊" },
    { id: "a1", seq: 2, role: "assistant", kind: "text", text: "早！" },
    { id: "u2", seq: 3, role: "user", kind: "text", text: "今天想先看那篇…" },
  ]));
  assert.deepEqual(midTurn, { ok: false, reason: "segment_not_settled" });
  const settled = reflectionSnapshotSufficient(snapshot([
    { id: "u1", seq: 1, role: "user", kind: "text", text: "早啊" },
    { id: "a1", seq: 2, role: "assistant", kind: "text", text: "早！" },
  ]));
  assert.deepEqual(settled, { ok: true });
});
