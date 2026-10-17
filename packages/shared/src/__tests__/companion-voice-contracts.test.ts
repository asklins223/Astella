import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPANION_VOICE_MAX_AUDIO_BYTES,
  companionRunVoiceSegmentsResultV1Schema,
  companionVoiceSpeakRequestV1Schema,
  companionVoiceSpeakResultV1Schema,
} from "../contracts/companion/companion-voice-contracts.ts";

const request = {
  version: 1 as const,
  text: "今天还有一张复习卡。",
};

const result = {
  version: 1 as const,
  mimeType: "audio/mpeg" as const,
  // "SUQz" 是 "ID3" 的 base64：示例保持 base64 与 byteLength 自洽。
  audioBase64: "SUQz",
  byteLength: 3,
  voice: "zh-CN-XiaoxiaoNeural",
};

test("CompanionVoiceSpeakRequestV1 accepts only bounded plain text", () => {
  assert.deepEqual(companionVoiceSpeakRequestV1Schema.parse(request), request);
  assert.deepEqual(companionVoiceSpeakRequestV1Schema.parse({ version: 1, text: "  慢慢来。  " }), {
    version: 1,
    text: "慢慢来。",
  });
  assert.throws(() => companionVoiceSpeakRequestV1Schema.parse({ version: 1, text: "" }));
  assert.throws(() => companionVoiceSpeakRequestV1Schema.parse({ version: 1, text: "   " }));
  assert.throws(() => companionVoiceSpeakRequestV1Schema.parse({ version: 1, text: "字".repeat(121) }));
  assert.throws(() => companionVoiceSpeakRequestV1Schema.parse({ ...request, debugText: "must not leak" }));
  assert.throws(() => companionVoiceSpeakRequestV1Schema.parse({ ...request, version: 2 }));
  assert.throws(() => companionVoiceSpeakRequestV1Schema.parse({ text: request.text }));
});

test("CompanionVoiceSpeakResultV1 accepts only bounded audio/mpeg bytes", () => {
  assert.deepEqual(companionVoiceSpeakResultV1Schema.parse(result), result);
  assert.throws(() => companionVoiceSpeakResultV1Schema.parse({ ...result, mimeType: "audio/wav" }));
  assert.throws(() => companionVoiceSpeakResultV1Schema.parse({ ...result, mimeType: "application/json" }));
  assert.throws(() => companionVoiceSpeakResultV1Schema.parse({ ...result, audioBase64: "" }));
  assert.throws(() => companionVoiceSpeakResultV1Schema.parse({ ...result, byteLength: 0 }));
  assert.throws(() => companionVoiceSpeakResultV1Schema.parse({ ...result, byteLength: 1.5 }));
  assert.throws(() =>
    companionVoiceSpeakResultV1Schema.parse({
      ...result,
      byteLength: COMPANION_VOICE_MAX_AUDIO_BYTES + 1,
    }));
  assert.throws(() => companionVoiceSpeakResultV1Schema.parse({ ...result, voice: "" }));
  assert.throws(() => companionVoiceSpeakResultV1Schema.parse({ ...result, voice: "v".repeat(65) }));
  assert.throws(() => companionVoiceSpeakResultV1Schema.parse({ ...result, audioPath: "/tmp/tts.mp3" }));
});

/**
 * 2026-10-16 补听：这一轮没有留档时，服务端回的是 200 + `generation: null` + 空列表。
 * 原来回 404，客户端在解包那一步就抛了，"这段没有留下语音记录"永远说不出口；
 * 这一条钉住"没有可补的音频"是可解析的正常结论。
 */
test("补听清单接受没有留档的空结果，但缺字段的段仍进不来", () => {
  const runId = "11111111-1111-4111-8111-111111111111";
  const conversationId = "22222222-2222-4222-8222-222222222222";
  const segment = {
    ordinal: 1, segmentId: "a".repeat(64), displayText: "刚讲完饭锅的故事",
    displayStart: 0, displayEnd: 8, cue: { emotion: "neutral" },
  };
  assert.equal(companionRunVoiceSegmentsResultV1Schema.parse(
    { version: 1, runId, conversationId, generation: null, items: [] }).generation, null);
  assert.equal(companionRunVoiceSegmentsResultV1Schema.parse(
    { version: 1, runId, conversationId, generation: 3, items: [segment] }).items.length, 1);
  assert.throws(() => companionRunVoiceSegmentsResultV1Schema.parse(
    { version: 1, runId, conversationId, generation: 3, items: [{ ...segment, displayStart: undefined }] }));
  assert.throws(() => companionRunVoiceSegmentsResultV1Schema.parse(
    { version: 1, runId, conversationId, items: [] }));
});
