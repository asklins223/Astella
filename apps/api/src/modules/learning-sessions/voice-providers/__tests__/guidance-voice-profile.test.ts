import assert from "node:assert/strict";
import { test } from "node:test";
import { guidanceVoiceProfile } from "../guidance-voice-profile.ts";
import type { TtsEngineConfig } from "../tts-config.ts";
import { companionGuidanceVoiceProfileV1Schema } from "@astella/shared/companion-voice-contracts";

const config: TtsEngineConfig = { engine: "qwen", qwen: { workspaceId: "private-provider-workspace",
  model: "qwen-audio-3.1-tts-flash", voice: "longhua_v3.1", format: "mp3", sampleRate: 22050, instruction: "温柔自然" },
  edge: { voice: "zh-CN-XiaoxiaoNeural", rate: "+0%" } };

test("guidance recordings change identity when any audible Qwen configuration changes", () => {
  const initial = guidanceVoiceProfile(config);
  assert.deepEqual(companionGuidanceVoiceProfileV1Schema.parse(initial), initial);
  for (const change of [{ voice: "longanlingxi_v3.1" }, { model: "new-model" }, { instruction: "活泼" }, { format: "wav" }, { sampleRate: 24000 }]) {
    assert.notEqual(guidanceVoiceProfile({ ...config, qwen: { ...config.qwen, ...change } }).profileId, initial.profileId);
  }
});

test("guidance stays on default Qwen when dialogue switches to Edge and publishes no provider workspace", () => {
  const initial = guidanceVoiceProfile(config);
  assert.deepEqual(guidanceVoiceProfile({ ...config, engine: "edge", qwen: { ...config.qwen, workspaceId: "another-private-workspace" } }), initial);
  assert.equal(JSON.stringify(initial).includes(config.qwen.workspaceId), false);
});
