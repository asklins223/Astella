import assert from "node:assert/strict";
import { test } from "node:test";
import { companionNoteLengthIssue, companionRequestedNoteLength, companionVisibleCharacterCount } from "../turn/companion-note-length.ts";

test("the requested note length is read from this turn only", () => {
  assert.deepEqual(companionRequestedNoteLength("给我写一个约400字、有完整结尾的故事"), { min: 340, max: 460 });
  assert.deepEqual(companionRequestedNoteLength("恰好二百字的短文"), { min: 200, max: 200 });
  assert.deepEqual(companionRequestedNoteLength("至少三百字的介绍"), { min: 300, max: Infinity });
  assert.deepEqual(companionRequestedNoteLength("不超过五百字的记录"), { min: 1, max: 500 });
  assert.deepEqual(companionRequestedNoteLength("别写400字，写200字的故事"), { min: 170, max: 230 });
  assert.equal(companionRequestedNoteLength("不要写400字的故事"), null);
  assert.equal(companionRequestedNoteLength("解释一下‘400字’这句话"), null);
  assert.equal(companionRequestedNoteLength("什么是400字的总结？"), null);
  assert.equal(companionRequestedNoteLength("整理一下这篇笔记的结构"), null);
});

test("visible character count ignores syntax, links, headings and speech tags", () => {
  assert.equal(companionVisibleCharacterCount("[excited]你好，世界！\n```js\nignored\n```"), 4);
  assert.equal(companionVisibleCharacterCount("阅读[秦朝](note://00000000-0000-4000-8000-000000000001)。"), 4);
  assert.equal(companionVisibleCharacterCount("阅读[秦朝](https://example.com/a-very-long-address)。"), 4);
  assert.equal(companionVisibleCharacterCount("## 标题不能凑字数\n\n这是正文。"), 4);
});

test("the saved body must meet the requested length", () => {
  const length = companionRequestedNoteLength("约400字的笔记")!;
  assert.ok(companionNoteLengthIssue("这".repeat(114), length));
  assert.equal(companionNoteLengthIssue("这".repeat(400), length), null);
  assert.equal(companionNoteLengthIssue("这".repeat(460), length), null);
  assert.ok(companionNoteLengthIssue("这".repeat(461), length));
});
