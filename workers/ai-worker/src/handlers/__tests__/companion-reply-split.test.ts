import assert from "node:assert/strict";
import { test } from "node:test";
import {
  splitCompanionReplyParts, companionReplyMessageDrafts, COMPANION_REPLY_SPLIT_MAX,
} from "../turn/companion-reply-split.ts";

test("one reply written as two messages is cut at its own blank line", () => {
  assert.deepEqual(splitCompanionReplyParts("早呀！☀️\n\n今天想先做哪件事呀？", COMPANION_REPLY_SPLIT_MAX),
    ["早呀！☀️", "今天想先做哪件事呀？"]);
  assert.deepEqual(splitCompanionReplyParts("早。\n\n今天想先做哪件事？", COMPANION_REPLY_SPLIT_MAX), ["早。", "今天想先做哪件事？"]);
  // A single paragraph stays one message.
  assert.deepEqual(splitCompanionReplyParts("在的～今天怎么啦？", COMPANION_REPLY_SPLIT_MAX), ["在的～今天怎么啦？"]);
  assert.deepEqual(splitCompanionReplyParts("   \n\n ", COMPANION_REPLY_SPLIT_MAX), []);
});

test("a long answer is delivered as the paragraphs the model wrote, but an over-long answer stays one message", () => {
  const parts = splitCompanionReplyParts("一\n\n二\n\n三", COMPANION_REPLY_SPLIT_MAX);
  assert.deepEqual(parts, ["一", "二", "三"], "short conversational paragraphs are the generation's own grouping");
  const tooLong = Array.from({ length: COMPANION_REPLY_SPLIT_MAX + 1 }, (_, index) => `第${index + 1}段`).join("\n\n");
  assert.deepEqual(splitCompanionReplyParts(tooLong, COMPANION_REPLY_SPLIT_MAX), [tooLong],
    "长文要连贯阅读，不硬拆成十几个气泡");
  const longParagraphs = `${"很长的解释".repeat(40)}\n\n${"另一段很长的解释".repeat(40)}`;
  assert.deepEqual(splitCompanionReplyParts(longParagraphs, COMPANION_REPLY_SPLIT_MAX), [longParagraphs],
    "长段落是连贯阅读，不分气泡");
});

test("a sectioned answer stays one message even when its labels are separated by blank lines", () => {
  const sectioned = "看了，是《大唐帝国衰亡史》里讲后梁建立的一页。\n\n**标题**：后梁建立\n\n**正文大意**：907 年，朱温废唐哀帝，建立后梁。\n\n**配图**：朱温穿龙袍坐在殿上。";
  assert.deepEqual(splitCompanionReplyParts(sectioned, COMPANION_REPLY_SPLIT_MAX), [sectioned],
    "结构化说明的空行是排版，不是消息边界");
  const listed = "可以按三步来：\n\n- 先读原文\n- 再写下问题\n- 最后复述一遍";
  assert.deepEqual(splitCompanionReplyParts(listed, COMPANION_REPLY_SPLIT_MAX), [listed]);
});

test("a heading or code block keeps the answer in one message", () => {
  const headed = "## 标题\n\n正文第一段。\n\n正文第二段。";
  assert.deepEqual(splitCompanionReplyParts(headed, COMPANION_REPLY_SPLIT_MAX), [headed],
    "结构化正文的空行是排版，不拆气泡");
  const fenced = "第一种写法：\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\n第二种写法在下面。";
  assert.deepEqual(splitCompanionReplyParts(fenced, COMPANION_REPLY_SPLIT_MAX), [fenced],
    "代码块与说明保持同一条消息");
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
