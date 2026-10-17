import { COMPANION_SELECTION_MAX_CHARS, COMPANION_P2_LIMITS } from "@astella/shared/companion-conversation-contracts";

/** Preserve the draft and complete source; reject instead of shortening either. */
export function companionComposerLimitNote(input: string, selection?: string | null): string | null {
  if ((selection?.length ?? 0) > COMPANION_SELECTION_MAX_CHARS) {
    return `原文超过 ${COMPANION_SELECTION_MAX_CHARS.toLocaleString()} 字，请分段选择后发送。`;
  }
  if (input.trim().length > COMPANION_P2_LIMITS.serverHardMaxChars) {
    return `消息超过 ${COMPANION_P2_LIMITS.serverHardMaxChars.toLocaleString()} 字，请分段发送。`;
  }
  return null;
}
