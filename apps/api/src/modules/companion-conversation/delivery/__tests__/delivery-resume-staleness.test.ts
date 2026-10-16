import assert from "node:assert/strict";
import test from "node:test";
import { dropStaleAmbientOnResume } from "../delivery-service.ts";

/**
 * 「离线/专注回来后丢弃过时招呼」的分类必须按**投递身份**判（2026-10-16）。
 *
 * 旧判据是"payload 里有没有 text"，注释还写着"不带 text 的是约定提醒与学习完成这类触发式投递"，
 * 而真库里的两种情况恰好相反：约定提醒（0270 的 `reminder:<id>`）与学习完成
 * （`run.completed:<runId>`）**都写了 text**。于是：
 *   - 用户上午 9 点约的提醒，下午回到电脑前时已经被静默丢掉（「提醒不准」）；
 *   - 刚跑完学习的那句「要继续吗」同样被丢掉。
 * 这条测试同时钉住两件相反的事：该丢的照样丢，不该丢的一条都不能丢。
 */
const AMBIENT_STALE_MS = 30 * 60_000;

type Row = Parameters<typeof dropStaleAmbientOnResume>[0][number];
let seq = 0;
function row(payloadRef: Record<string, unknown>, ageMs: number): Row {
  seq += 1;
  const createdAt = new Date(Date.now() - ageMs);
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    assistantSessionId: null,
    workspaceId: "10000000-0000-4000-8000-000000000001",
    userId: "10000000-0000-4000-8000-000000000002",
    inboxSequence: seq,
    dedupeKey: `d-${seq}`,
    state: "queued",
    kind: "system_event",
    payloadRef,
    displayLease: null,
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 2 * 60 * 60 * 1000),
  } as unknown as Row;
}

const OLD = AMBIENT_STALE_MS + 90 * 60_000;
const FRESH = 60_000;

test("约定提醒到点后过很久仍必须出现（它有真实时间语义）", () => {
  const kept = dropStaleAmbientOnResume([
    row({ kind: "system_event", systemEventId: "reminder:r1", text: "该复习这篇笔记了" }, OLD),
  ], new Date());
  assert.equal(kept.length, 1, "通知里写了 text，但它不是过时招呼：丢掉等于「提醒不准」");
  assert.equal(kept[0]?.payloadRef && (kept[0].payloadRef as { text?: string }).text, "该复习这篇笔记了");
});

test("刚跑完学习的那句不按过时招呼丢（用户正在等它）", () => {
  const kept = dropStaleAmbientOnResume([
    row({ kind: "system_event", systemEventId: "run.completed:run-1", text: "刚才的学习已完成，要继续吗？" }, OLD),
  ], new Date());
  assert.equal(kept.length, 1);
});

test("她自己开口说的那类：过了 30 分钟照样丢（不形成消息债务）", () => {
  const kept = dropStaleAmbientOnResume([
    row({ kind: "system_event", systemEventId: "initiative:m1", text: "刚才那道题我想了想" }, OLD),
  ], new Date());
  assert.deepEqual(kept, [], "问候/随时感想/日记更新这些正是这段清理的对象");
});

test("她自己开口说的那类：刚发出来的不丢", () => {
  const kept = dropStaleAmbientOnResume([
    row({ kind: "system_event", systemEventId: "initiative:m2", text: "在的" }, FRESH),
  ], new Date());
  assert.equal(kept.length, 1);
});

test("没有 systemEventId 的那几类（提案、动作结果、记忆候选）不受这段影响", () => {
  const kept = dropStaleAmbientOnResume([
    row({ kind: "proposal", proposalId: "p1" }, OLD),
    row({ kind: "action_result", proposalId: "p1" }, OLD),
    row({ kind: "memory_candidate", memoryItemId: "m1" }, OLD),
  ], new Date());
  assert.equal(kept.length, 3);
});
