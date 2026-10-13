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

test("explicit Chinese quantities can be restated without changing the user's requested duration", () => {
  const evidence = companionNumericEvidenceContext([{role:"user",content:"以后连续学习五十分钟提醒我；两小时后再看三十个例子。"}]);
  assert.deepEqual(unverifiedNumericClaims("满 50 分钟提醒你，2 小时后看 30 个例子。",evidence),[]);
  assert.deepEqual(unverifiedNumericClaims("你已经学了 45 分钟。",evidence),["45分钟"]);
  assert.deepEqual(unverifiedNumericClaims("第 1203 次。","一千二百零三次"),[]);
});

test("current participation observations are evidence, while a self-authored attention intent is not", () => {
  const evidence=companionNumericEvidenceContext([{role:"system",content:"<participation_awareness>当前连续 51 分钟</participation_awareness><initiative_input>随便写了 88 分钟的意图</initiative_input>"}]);
  assert.deepEqual(unverifiedNumericClaims("前台已记录 51 分钟。",evidence),[]);
  assert.deepEqual(unverifiedNumericClaims("你学了 88 分钟。",evidence),["88分钟"]);
});
