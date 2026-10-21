/**
 * context-hydration 纯函数测试（文档 16 §14.2）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildContextSnapshot,
  computeContextRevision,
  entityLookupKey,
} from "../context-hydration.ts";
import type { MainPageContextInputV2 } from "@astella/shared";

const uuid = () => crypto.randomUUID();

function makeInput(): MainPageContextInputV2 {
  const noteId = uuid();
  return {
    routeRef: { kind: "note", noteId },
    pageKind: "note",
    entityRefs: [{ kind: "note", noteId }, { kind: "source", sourceId: uuid() }],
    interactionState: "idle",
    capabilityHints: ["open_route"],
    sensitivity: "normal",
  };
}

test("computeContextRevision：确定性且对 entityRefs 顺序不敏感", () => {
  const a = makeInput();
  const b = { ...a, entityRefs: [...a.entityRefs].reverse() };
  assert.equal(computeContextRevision(a), computeContextRevision(b));
  assert.ok(computeContextRevision(a).length === 64);
});

test("computeContextRevision：内容变化必产生新 revision", () => {
  const a = makeInput();
  assert.notEqual(
    computeContextRevision(a),
    computeContextRevision({ ...a, interactionState: "formal_answer" }),
  );
  assert.notEqual(
    computeContextRevision(a),
    computeContextRevision({ ...a, entityRefs: [{ kind: "note", noteId: uuid() }] }),
  );
  assert.notEqual(
    computeContextRevision(a),
    computeContextRevision({ ...a, sensitivity: "formal_assessment" }),
  );
});

test("buildContextSnapshot：安全字段来自服务端输入，revision 与输入一致", () => {
  const input = makeInput();
  const now = new Date();
  const snapshot = buildContextSnapshot({
    contextId: "ctx-1",
    accountSessionId: "acct-1",
    deviceSessionId: "dev-1",
    workspaceId: uuid(),
    userId: uuid(),
    pageInstanceId: "page-1",
    input,
    issuedAt: now,
    expiresAt: new Date(now.getTime() + 30_000),
  });
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.contextId, "ctx-1");
  assert.equal(snapshot.workspaceId.length > 0, true);
  assert.equal(snapshot.revision, computeContextRevision(input));
  assert.equal(snapshot.expiresAt, new Date(now.getTime() + 30_000).toISOString());
});

test("entityLookupKey：全部当前 EntityRef kind 有明确映射", () => {
  const sourceId = uuid();
  const noteId = uuid();
  const journeyId = uuid();
  const assistantSessionId = uuid();
  assert.deepEqual(entityLookupKey({ kind: "source", sourceId }), { table: "sources", id: sourceId });
  assert.deepEqual(entityLookupKey({ kind: "note", noteId }), { table: "notes", id: noteId });
  assert.deepEqual(entityLookupKey({ kind: "companion_journey", journeyId }), { table: "companion_journeys", id: journeyId });
  assert.deepEqual(entityLookupKey({ kind: "assistant_session", assistantSessionId }), { table: "companion_conversations", id: assistantSessionId });
});
