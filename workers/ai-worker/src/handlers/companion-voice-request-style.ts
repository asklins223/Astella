import { qwenDialectRequestedByUser, QWEN_TTS_STANDARD_MANDARIN_INSTRUCTION } from "@astella/shared/tts-voice-catalog";
import type { AgentVoiceStyleDecisionV1 } from "@astella/shared/agent-contracts";

/**
 * Give explicit current-turn dialect requests a deterministic path to Qwen TTS.
 * The structured attention interpreter handles all semantic style and scene decisions.
 * This narrow fallback only maps an explicitly requested, named dialect to the provider's
 * supported spelling; it does not infer a scene or style from topic keywords.
 */
export function companionVoiceRequestStyle(userText: string): string | null {
  const dialect = qwenDialectRequestedByUser(userText);
  return dialect ? `请用${dialect}表达，保持自然语速和清晰吐字` : null;
}

/**
 * Resolve this turn's voice direction from the structured semantic classifier first.
 * User-text matching is only a recovery path for an explicit named dialect when the
 * classifier has no decision; it cannot invent a scene or override semantic output.
 *
 * 账号里存的长期方言由**这一轮在做什么**决定要不要念出来：陪说话、讲解、读资料都照方言；
 * 字要落进笔记或卡片里的文案工作回普通话——方言写进文档就是文字风格异常。
 * 用户这一句点名要哪种口音走 `semantic` 那一支，压过这条默认。
 */
export function resolveCompanionVoiceInstruction(
  userText: string,
  semanticDecision: AgentVoiceStyleDecisionV1 | null,
  turn: { accountDialect?: string | null; documentWork?: boolean } = {},
): {
  instruction: string | null;
  source: "semantic" | "dialect-preference" | "mandarin-for-document-work" | "request-fallback" | "none" | "clarify";
} {
  if (semanticDecision?.decision === "clarify") return { instruction: null, source: "clarify" };
  const semantic = semanticDecision?.decision === "apply" ? semanticDecision.instruction : null;
  if (semantic) return { instruction: semantic, source: "semantic" };
  if (turn.accountDialect) {
    return turn.documentWork
      ? { instruction: QWEN_TTS_STANDARD_MANDARIN_INSTRUCTION, source: "mandarin-for-document-work" }
      : { instruction: `请用${turn.accountDialect}表达`, source: "dialect-preference" };
  }
  const fallback = companionVoiceRequestStyle(userText);
  return fallback
    ? { instruction: fallback, source: "request-fallback" }
    : { instruction: null, source: "none" };
}
