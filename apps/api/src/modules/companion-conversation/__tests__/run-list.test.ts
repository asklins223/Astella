import assert from "node:assert/strict";
import { test } from "node:test";
import { companionRunListQueryV1Schema } from "@ailearn/shared";
import { projectCompanionRunListV1 } from "../run-list.ts";

const createdAt = new Date("2026-10-01T00:00:00.000Z");
const first = {
  id: "00000000-0000-4000-8000-000000000001",
  conversationId: "00000000-0000-4000-8000-000000000010",
  status: "failed" as const,
  generation: 1,
  createdAt,
  cursorCreatedAt: "2026-10-01T00:00:00.000000Z",
  startedAt: createdAt,
  finishedAt: createdAt,
  assistantMessageId: null,
  errorCode: "provider-private-response",
  providerId: "provider-a",
  modelId: "model-a",
  promptVersion: "companion-v1",
  stepCount: 2,
  toolCallCount: 1,
  agentElapsedMs: 1200,
};

test("run list is stable, owner-safe metadata with a task filter and bounded cursor", () => {
  const report = projectCompanionRunListV1([
    first,
    { ...first, id: "00000000-0000-4000-8000-000000000002", status: "succeeded", errorCode: null },
  ], 1);
  assert.equal(report.items.length, 1);
  assert.equal(report.items[0]?.failureCategory, "unknown");
  assert.equal(report.items[0]?.assistantMessagePersisted, false);
  assert.equal(report.nextCursor?.beforeId, first.id);
  assert.equal(report.nextCursor?.beforeCreatedAt, first.cursorCreatedAt);
  assert.equal(JSON.stringify(report).includes("provider-private-response"), false);
  assert.equal(companionRunListQueryV1Schema.parse({ conversationId: first.conversationId, limit: "5" }).limit, 5);
  assert.equal(companionRunListQueryV1Schema.safeParse({ beforeId: first.id }).success, false);
  assert.equal(companionRunListQueryV1Schema.parse({
    beforeCreatedAt: "2026-10-01T00:00:00.123456Z",
    beforeId: first.id,
  }).beforeCreatedAt, "2026-10-01T00:00:00.123456Z");
  assert.equal(companionRunListQueryV1Schema.safeParse({ limit: "100" }).success, false);
});
