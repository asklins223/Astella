import assert from "node:assert/strict";
import { test } from "node:test";
import { companionVisibleCharacterCount } from "../turn/companion-note-length.ts";

test("visible character count ignores syntax, links, headings and speech tags", () => {
  assert.equal(companionVisibleCharacterCount("[excited]你好，世界！\n```js\nignored\n```"), 4);
  assert.equal(companionVisibleCharacterCount("阅读[秦朝](note://00000000-0000-4000-8000-000000000001)。"), 4);
  assert.equal(companionVisibleCharacterCount("阅读[秦朝](https://example.com/a-very-long-address)。"), 4);
  assert.equal(companionVisibleCharacterCount("## 标题不能凑字数\n\n这是正文。"), 4);
});
