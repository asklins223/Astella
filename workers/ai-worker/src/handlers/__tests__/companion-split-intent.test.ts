import assert from "node:assert/strict";
import { test } from "node:test";
import {
  companionSplitIntentMessages, companionSplitMessageCount, parseCompanionSplitIntent, splitCompanionReplyParts,
  companionReplyMessageDrafts, COMPANION_SPLIT_MESSAGES_DEFAULT, COMPANION_SPLIT_MESSAGES_MAX,
} from "../turn/companion-split-intent.ts";

test("split verdict parsing defaults the count and clamps it to a usable range", () => {
  assert.deepEqual(parseCompanionSplitIntent('{"decision":"split"}'), { decision: "split" });
  assert.deepEqual(parseCompanionSplitIntent('{"decision":"split","messages":3}'), { decision: "split", messages: 3 });
  assert.deepEqual(parseCompanionSplitIntent('```json\n{"decision":"single"}\n```'), { decision: "single" });
  assert.deepEqual(parseCompanionSplitIntent("我觉得是分开的"), { decision: "unsure" });
  assert.equal(companionSplitMessageCount({ decision: "split" }), COMPANION_SPLIT_MESSAGES_DEFAULT);
  assert.equal(companionSplitMessageCount({ decision: "split", messages: 1 }), 2);
  assert.equal(companionSplitMessageCount({ decision: "split", messages: 99 }), COMPANION_SPLIT_MESSAGES_MAX);
});

test("the judge prompt asks only about delivery shape, not content", () => {
  const [system] = companionSplitIntentMessages("随便聊两句");
  assert.match(String(system.content), /多条独立消息/);
  assert.doesNotMatch(String(system.content), /字数|风格/);
});

test("one reply written as two messages is cut at its own blank line", () => {
  // Measured live: this is the shape the model actually produces.
  assert.deepEqual(splitCompanionReplyParts("早呀！☀️\n\n今天想先做哪件事呀？", 2),
    ["早呀！☀️", "今天想先做哪件事呀？"]);
  assert.deepEqual(splitCompanionReplyParts("早。\n\n今天想先做哪件事？", 2), ["早。", "今天想先做哪件事？"]);
  // A single paragraph stays one message.
  assert.deepEqual(splitCompanionReplyParts("在的～今天怎么啦？", 2), ["在的～今天怎么啦？"]);
  assert.deepEqual(splitCompanionReplyParts("   \n\n ", 2), []);
});

test("a blank line inside a code block is not a message boundary", () => {
  const text = "第一种写法：\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\n第二种写法在下面。";
  assert.deepEqual(splitCompanionReplyParts(text, 3), [
    "第一种写法：",
    "```js\nconst a = 1;\n\nconst b = 2;\n```",
    "第二种写法在下面。",
  ]);
});

test("extra paragraphs join the last message instead of being dropped", () => {
  const parts = splitCompanionReplyParts("一\n\n二\n\n三\n\n四", 2);
  assert.equal(parts.length, 2);
  assert.equal(parts[0], "一");
  assert.equal(parts[1], "二\n\n三\n\n四", "nothing is lost or reordered when trimming to the requested count");
  // A request for more messages than the reply contains keeps the real count.
  assert.deepEqual(splitCompanionReplyParts("一\n\n二", 4), ["一", "二"]);
});

test("each part becomes its own message and only the last carries the results", () => {
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
  assert.equal(drafts[0]!.blocks.length, 1, "the first message holds only its own text");
  assert.equal(drafts[1]!.blocks.length, 2, "rich blocks trail the reply, on the last message");
  assert.equal(drafts[1]!.blocks[1]!.type, "nav");
  // Each draft is hashed over its own blocks, so a later edit of one message
  // cannot silently invalidate the others.
  assert.equal(new Set(drafts.map(draft => draft.contentSha256)).size, drafts.length);
});

test("a single part keeps today's one-message shape", () => {
  let counter = 0;
  const drafts = companionReplyMessageDrafts({
    parts: ["在的～今天怎么啦？"],
    richBlocks: [{ type: "citation", label: "来源" }],
    emotion: "neutral",
    hash: blocks => `hash:${JSON.stringify(blocks).length}`,
    newId: () => `m${++counter}`,
  });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]!.blocks.length, 2);
});
