import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompanionNoteObservation } from "../agent/companion-note-observation.ts";

function event(noteLibraryReadEnabled: boolean) {
  return {
    ctx: { workspaceId: "workspace", userId: "user", signal: new AbortController().signal },
    read: { userId: "user", runId: "run", userText: "读一下《秦朝》这篇笔记" },
    constraints: { noteLibraryReadEnabled },
  } as never;
}

test("host note observation binds a page note and never reads when the library is disabled", () => {
  const observation = createCompanionNoteObservation(event(true), false,
    { pageKind: "note", noteId: "11111111-1111-4111-8111-111111111111" });
  assert.equal(observation.hasResolvedTarget({ subjects: [] } as never), true);
  assert.equal(createCompanionNoteObservation(event(false), false,
    { pageKind: "note", noteId: "11111111-1111-4111-8111-111111111111" }).currentPage(), null);
});
