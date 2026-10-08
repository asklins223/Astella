import assert from "node:assert/strict";
import { test } from "node:test";
import { companionNumericEvidenceContext } from "../companion-context-evidence.ts";
import { unverifiedNumericClaims } from "../companion-dialogue-content.ts";

test("assistant history and remembered claims cannot validate invented study time", () => {
  const evidence = companionNumericEvidenceContext([
    { role: "system", content: "<here_and_now>今日已学 0 分钟</here_and_now>\n<memory_data>本周学了 23 分钟</memory_data>\n<conversation_summary>以前学了 45 分钟</conversation_summary>" },
    { role: "assistant", content: "你学了 23 分钟，还读了 15 张卡。" },
    { role: "user", content: "现在学习情况怎么样？" },
  ]);
  assert.deepEqual(unverifiedNumericClaims("今日已学 0 分钟。", evidence), []);
  assert.deepEqual(unverifiedNumericClaims("你学了 23 分钟，之前学了 45 分钟。", evidence), ["23分钟", "45分钟"]);
  assert.deepEqual(unverifiedNumericClaims("你读了 15 张卡。", evidence), ["15张"]);
});

test("the user's own text remains evidence in multipart messages", () => {
  const evidence = companionNumericEvidenceContext([
    { role: "user", content: [{ type: "text", text: "我学了 12 分钟，" }, { type: "text", text: "看了 3 张卡。" }] },
  ]);
  assert.deepEqual(unverifiedNumericClaims("你学了 12 分钟，看了 3 张卡。", evidence), []);
});
