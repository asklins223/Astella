import type { CompanionChatPhase } from "../../app/companion-chat-session";
export function visibleTurnFailure(chat: { readonly failure: string | null; readonly phase: CompanionChatPhase }): string | null {
  return chat.failure !== null && chat.phase === "error" ? chat.failure : null;
}
