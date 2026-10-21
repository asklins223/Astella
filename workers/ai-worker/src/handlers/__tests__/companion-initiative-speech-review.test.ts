import assert from "node:assert/strict";
import { test } from "node:test";
import { initiativeSpeechReviewMessages, parseInitiativeSpeechReview, reviewCompanionInitiativeSpeech } from "../proactive/companion-initiative-speech-review.ts";
test("publication review preserves a substantive correction and rejects semantic repetition or failed-request deferral", () => {
  assert.equal(parseInitiativeSpeechReview(JSON.stringify({ decision: "publish", reason: "由6V纠正为9V，事实有实际更新" })), null);
  assert.match(parseInitiativeSpeechReview(JSON.stringify({ decision: "repeat", reason: "只将问你个事儿改成问你个事" }))!, /repeat/);
  assert.match(parseInitiativeSpeechReview(JSON.stringify({ decision: "failed_request_replay", reason: "把未交付的三句话改成以后想听再说" }))!, /failed_request_replay/);
  assert.throws(() => parseInitiativeSpeechReview('{"decision":"publish"}'));
  const messages = initiativeSpeechReviewMessages("电压应为9V。", { previous: [{ id: "old", text: "电压为6V。" }], unfinished: null });
  assert.match(messages[0]!.content, /纠错即使只改一个数字也是新内容/);
});
test("ordinary user requests do not spend a publication-review call", async () => {
  const result = await reviewCompanionInitiativeSpeech({ read: { initiativeInput: null }, provider: { chatCompletion: () => { throw new Error("must not call"); } } } as never);
  assert.equal(result, null);
});
