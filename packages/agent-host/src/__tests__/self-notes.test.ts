import assert from "node:assert/strict";
import { test } from "node:test";
import { projectCompanionSelfNote } from "../self-notes.ts";

test("a missing usage column reads as never used instead of breaking the note list", () => {
  const note = projectCompanionSelfNote({
    user_disabled: false, entry_key: "growth:voice", revision: 1, title: "说话方式",
    body: "先说结论。", tier: "resident", next_review_at: null, expires_at: null,
    reason: "test", updated_at: "2026-11-11T00:00:00Z",
  });
  assert.equal(note.lastUsedAt, null);
  assert.equal(note.updatedAt, "2026-11-11T00:00:00.000Z");
});
