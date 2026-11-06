import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCompanionCursor,
  formatCompanionSse,
  createCompanionEventPump,
} from "../companion-events.ts";

const CONVERSATION_ID = "123e4567-e89b-12d3-a456-426614174000";

test("a notification during a pending read drains the next committed event immediately", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  let concurrent = 0;
  let maximumConcurrent = 0;
  const delivered: number[] = [];
  const pump = createCompanionEventPump(async () => {
    const batch = ++reads;
    maximumConcurrent = Math.max(maximumConcurrent, ++concurrent);
    if (batch === 1) await gate;
    delivered.push(batch);
    concurrent--;
    return false;
  }, () => false);
  const pendingRead = pump();
  await pump();
  await pump(); // coalesce repeated hints while the snapshot is in flight
  release();
  await pendingRead;
  assert.deepEqual(delivered, [1, 2]);
  assert.equal(maximumConcurrent, 1);
});

test("a full replay window drains its tail without waiting for another notification", async () => {
  let reads = 0;
  const pump = createCompanionEventPump(async () => ++reads < 3, () => false);
  await pump();
  assert.equal(reads, 3);
});

test("closing a stream during its read cancels queued wake-ups", async () => {
  let closed = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  const pump = createCompanionEventPump(async () => { reads++; await gate; return true; }, () => closed);
  const pendingRead = pump();
  await pump();
  closed = true;
  release();
  await pendingRead;
  await pump();
  assert.equal(reads, 1);
});

test("a failed read releases the pump for the next durable retry", async () => {
  let reads = 0;
  const pump = createCompanionEventPump(async () => {
    if (++reads === 1) throw new Error("temporary database failure");
    return false;
  }, () => false);
  await assert.rejects(pump(), /temporary database failure/);
  await pump();
  assert.equal(reads, 2);
});

test("cursor 解析：无参 → after=0", () => {
  const r = resolveCompanionCursor({ afterRaw: null, lastEventId: null, conversationId: CONVERSATION_ID });
  assert.deepEqual(r, { ok: true, after: 0 });
});

test("cursor 解析：after 合法/非法", () => {
  assert.deepEqual(resolveCompanionCursor({ afterRaw: "42", lastEventId: null, conversationId: CONVERSATION_ID }), { ok: true, after: 42 });
  assert.equal(resolveCompanionCursor({ afterRaw: "-1", lastEventId: null, conversationId: CONVERSATION_ID }).ok, false);
  assert.equal(resolveCompanionCursor({ afterRaw: "1.5", lastEventId: null, conversationId: CONVERSATION_ID }).ok, false);
  assert.equal(resolveCompanionCursor({ afterRaw: "abc", lastEventId: null, conversationId: CONVERSATION_ID }).ok, false);
});

test("cursor 解析：Last-Event-ID 格式/跨 conversation", () => {
  assert.deepEqual(
    resolveCompanionCursor({ afterRaw: null, lastEventId: `${CONVERSATION_ID}:7`, conversationId: CONVERSATION_ID }),
    { ok: true, after: 7 },
  );
  assert.equal(
    resolveCompanionCursor({ afterRaw: null, lastEventId: "not-a-cursor", conversationId: CONVERSATION_ID }).ok,
    false,
  );
  assert.equal(
    resolveCompanionCursor({ afterRaw: null, lastEventId: "other-conversation:7", conversationId: CONVERSATION_ID }).ok,
    false,
  );
});

test("cursor 解析：after 与 Last-Event-ID 并存取较大者（§5.3）", () => {
  const r = resolveCompanionCursor({ afterRaw: "3", lastEventId: `${CONVERSATION_ID}:10`, conversationId: CONVERSATION_ID });
  assert.deepEqual(r, { ok: true, after: 10 });
  const r2 = resolveCompanionCursor({ afterRaw: "12", lastEventId: `${CONVERSATION_ID}:10`, conversationId: CONVERSATION_ID });
  assert.deepEqual(r2, { ok: true, after: 12 });
});

test("SSE 格式化：id/event/data 与 envelope 字段", () => {
  const row = {
    conversation_id: CONVERSATION_ID,
    workspace_id: "123e4567-e89b-12d3-a456-4266141740aa",
    seq: "3",
    run_id: "123e4567-e89b-12d3-a456-426614174001",
    generation: 2,
    account_epoch: 0,
    created_at: new Date("2026-08-11T00:00:00.000Z"),
    type: "assistant.delta",
    payload: { appendFrom: 0, textDelta: "你" },
  };
  const sse = formatCompanionSse(row);
  assert.ok(sse.startsWith(`id: ${CONVERSATION_ID}:3\nevent: companion\n`));
  const dataLine = sse.split("\n").find((l) => l.startsWith("data: "))!;
  const parsed = JSON.parse(dataLine.slice(6));
  assert.equal(parsed.seq, 3);
  assert.equal(parsed.runId, row.run_id);
  assert.equal(parsed.generation, 2);
  assert.equal(parsed.type, "assistant.delta");
  // companionStreamEventBaseShapeV1 要求 workspaceId；缺字段会让整帧无法通过
  // 共享（strict）事件合同校验。
  assert.equal(parsed.workspaceId, row.workspace_id);
  assert.deepEqual(parsed.payload, { appendFrom: 0, textDelta: "你" });
});
