import { test } from "node:test";
import assert from "node:assert/strict";
import { repeatsCompanionParentReply } from "../proactive/companion-participation-output.ts";

test("a follow-up cannot replay the parent's complete answer or final paragraph", () => {
  const answer = "我去把那条记录找出来更新。\n\n改好了，小柚：以后就这么称呼你。";
  assert.equal(repeatsCompanionParentReply(answer, [answer]), true);
  assert.equal(repeatsCompanionParentReply("改好了，小柚：以后就这么称呼你。", [answer]), true);
  assert.equal(repeatsCompanionParentReply("  改好了，小柚：以后就这么称呼你。\n", [answer]), true);
  assert.equal(repeatsCompanionParentReply("改好了，小柚：以后就这么称呼你。还有一处需要核对。", [answer]), false);
  assert.equal(repeatsCompanionParentReply("以后就这么称呼你", [answer]), false);
  assert.equal(repeatsCompanionParentReply("", [answer]), false);
});
