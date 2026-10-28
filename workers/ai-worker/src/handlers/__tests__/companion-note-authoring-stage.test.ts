import assert from "node:assert/strict";
import test from "node:test";
import { companionNoteEditPrerequisite } from "../note/companion-note-authoring-stage.ts";

test("an edit resolves its note, reads actual blocks, then releases drafting", () => {
  const base = { requestedActions: ["notes.write.edit"], hasPageNote: false, successfulTools: [] };
  assert.equal(companionNoteEditPrerequisite(base), "search");
  assert.equal(companionNoteEditPrerequisite({ ...base, hasPageNote: true }), "read");
  const found = { name: "notes.read.search", arguments: {}, data: { notes: [{ noteId: "actual-note" }] } };
  assert.equal(companionNoteEditPrerequisite({ ...base, successfulTools: [found] }), "read");
  assert.equal(companionNoteEditPrerequisite({ ...base, successfulTools: [{ ...found, data: { notes: [] } }] }), null,
    "an empty lookup does not force a made-up note ID");
  const read = { name: "notes.read.read", arguments: { includeBlocks: true }, data: { version: "actual-version", blocks: [] } };
  assert.equal(companionNoteEditPrerequisite({ ...base, successfulTools: [found, read] }), null);
  assert.equal(companionNoteEditPrerequisite({ ...base, requestedActions: ["notes.write.create"] }), null);
});
