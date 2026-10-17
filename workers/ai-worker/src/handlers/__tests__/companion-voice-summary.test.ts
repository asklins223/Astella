import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMPANION_VOICE_SUMMARY_DEFAULT_CHARS,
  isVoiceSegmentWithinSummary,
  resolveCompanionVoiceSummaryMaxChars,
} from "../turn/companion-voice-summary.ts";

test("语音摘要预算默认有界，显式 0 表示整篇朗读", () => {
  assert.equal(resolveCompanionVoiceSummaryMaxChars(undefined), COMPANION_VOICE_SUMMARY_DEFAULT_CHARS);
  assert.equal(resolveCompanionVoiceSummaryMaxChars(""), COMPANION_VOICE_SUMMARY_DEFAULT_CHARS);
  assert.equal(resolveCompanionVoiceSummaryMaxChars("0"), 0);
  assert.equal(resolveCompanionVoiceSummaryMaxChars("-1"), COMPANION_VOICE_SUMMARY_DEFAULT_CHARS);
  assert.equal(resolveCompanionVoiceSummaryMaxChars("320.9"), 320);
});

test("只朗读本消息前缀；后续段落只显示不合成", () => {
  assert.equal(isVoiceSegmentWithinSummary(0, 0, 200), true);
  assert.equal(isVoiceSegmentWithinSummary(199, 0, 200), true);
  assert.equal(isVoiceSegmentWithinSummary(200, 0, 200), false);
  // 每条消息各有一份预算；displayStart 是消息内下标。
  assert.equal(isVoiceSegmentWithinSummary(0, 0, 200), true);
  assert.equal(isVoiceSegmentWithinSummary(999, 0, 0), true, "0 = 读全篇");
});
