import { test } from "node:test";
import assert from "node:assert/strict";
import { isCompanionParticipationClosure, repeatsCompanionParentReply } from "../proactive/companion-participation-output.ts";

test("a spelled-out quiet decision is execution closure", () => {
  for (const text of ["（安静结束，本轮不发言。）", "(静默结束。)", "本轮无更多内容。", "（提醒已发，本轮无更多内容）", "（这轮没有需要补充的新内容，安静收尾。）"])
    assert.equal(isCompanionParticipationClosure(text), true);
});

test("a follow-up cannot replay the parent's complete answer or final paragraph", () => {
  const answer = "我去把那条记录找出来更新。\n\n改好了，小柚：以后就这么称呼你。";
  assert.equal(repeatsCompanionParentReply(answer, [answer]), true);
  assert.equal(repeatsCompanionParentReply("改好了，小柚：以后就这么称呼你。", [answer]), true);
  assert.equal(repeatsCompanionParentReply("  改好了，小柚：以后就这么称呼你。\n", [answer]), true);
  assert.equal(repeatsCompanionParentReply("改好了，小柚：以后就这么称呼你。还有一处需要核对。", [answer]), false);
  assert.equal(repeatsCompanionParentReply("以后就这么称呼你", [answer]), false);
  assert.equal(repeatsCompanionParentReply("", [answer]), false);
});
test("real conversation and quoted content stay speech", () => {
  for (const text of ["本轮复习还有一道题。", "我们可以安静结束这段争论。", "“安静结束”是这段代码的日志内容。", "你好。\n（安静结束。）", "", null])
    assert.equal(isCompanionParticipationClosure(text), false);
});
