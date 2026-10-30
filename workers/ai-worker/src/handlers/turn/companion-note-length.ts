import { stripVoiceExpressionTags } from "@astella/shared/voice-expression-tags";

/** A deterministic count for evaluation; never infers constraints from user prose. */
export function companionVisibleCharacterCount(text: string): number {
  return Array.from(stripVoiceExpressionTags(text).replace(/```[\s\S]*?```/gu, "")
    .replace(/^ {0,3}#{1,6}\s+.*$/gmu, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1").replace(/<[^>]*>/gu, "")
    .replace(/[\s\p{P}\p{S}]/gu, "")).length;
}
