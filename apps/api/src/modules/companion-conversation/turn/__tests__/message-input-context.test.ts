import assert from "node:assert/strict";
import { test } from "node:test";
import { companionMessageInputContext } from "../message-input-context.ts";
import { companionMessageV1Schema } from "@astella/shared/companion-conversation-contracts";

const noteId = "11111111-1111-4111-8111-111111111111";
const noteVersionId = "22222222-2222-4222-8222-222222222222";

test("projects the exact user selection and saved note reference without internal context", () => {
  const selection = { text: "清风徐来。\n\n水波不兴。", sharing: "user_selected" };
  const inputReference = { kind: "note", noteId, noteVersionId, title: "赤壁赋" };
  assert.deepEqual(companionMessageInputContext({ selection, inputReference, editing: { secret: true }, token: "private" }), { selection, inputReference });
});
test("old messages without a reference stay valid; invalid metadata does not invent a citation", () => {
  assert.deepEqual(companionMessageInputContext(null), {});
  assert.deepEqual(companionMessageInputContext({ selection: { text: "", sharing: "user_selected" }, inputReference: { kind: "note", noteId: "missing" } }), {});
  assert.ok(companionMessageV1Schema.shape.inputReference.isOptional());
});
test("diary references preserve the exact published version", () => {
  const inputReference = { kind: "diary", date: "2026-10-22", version: 2 };
  assert.deepEqual(companionMessageInputContext({ inputReference }), { inputReference });
});
