import { createHash } from "node:crypto";
import type { CompanionGuidanceVoiceProfileV1 } from "@ailearn/shared/companion-voice-contracts";
import type { TtsEngineConfig } from "./tts-config.ts";

/** Guidance always uses the configured default Qwen voice, independently of dialogue preferences. */
export function guidanceVoiceProfile(config: TtsEngineConfig): CompanionGuidanceVoiceProfileV1 {
  const { model, voice, format, sampleRate, instruction } = config.qwen;
  return {
    version: 1,
    profileId: createHash("sha256").update(JSON.stringify([1, "qwen", model, voice, format, sampleRate, instruction])).digest("hex"),
    voice,
  };
}
