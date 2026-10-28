import assert from "node:assert/strict";
import { test } from "node:test";
import { companionReplyMessageDrafts } from "../turn/companion-reply-drafts.ts";

test("each published message is its own draft and only the last carries results", () => {
  let counter = 0;
  const drafts = companionReplyMessageDrafts({
    parts: ["早呀！", "今天想先做哪件事？"],
    richBlocks: [{ type: "nav", route: { kind: "note.library" } }],
    emotion: "neutral",
    hash: blocks => `hash:${JSON.stringify(blocks).length}`,
    newId: () => `m${++counter}`,
  });
  assert.deepEqual(drafts.map(draft => draft.text), ["早呀！", "今天想先做哪件事？"]);
  assert.deepEqual(drafts.map(draft => draft.id), ["m1", "m2"]);
  assert.equal(drafts[0]!.blocks.length, 1);
  assert.equal(drafts[1]!.blocks.length, 2);
  assert.equal(drafts[1]!.blocks[1]!.type, "nav");
  assert.equal(new Set(drafts.map(draft => draft.contentSha256)).size, drafts.length);
});
