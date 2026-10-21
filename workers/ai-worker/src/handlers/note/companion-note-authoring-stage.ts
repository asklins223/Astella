import type { AgentTurnRequest } from "@astella/shared";
import { explicitCompanionProductRequest } from "../tools/companion-tool-intent.ts";
import { userForbidsNoteLibraryRead } from "./companion-note-authoring.ts";

/** The writer requires a real library search. Expose that dependency before
 * asking the model to draft notes, instead of rejecting an expensive draft. */
export function companionNoteNeedsRelatedSearch(userText: string, libraryReadAllowed: boolean,
  messages: AgentTurnRequest["messages"]): boolean {
  if (!libraryReadAllowed || !explicitCompanionProductRequest(userText).newNote || userForbidsNoteLibraryRead(userText)) return false;
  const searches = new Set(messages.flatMap(message => message.toolCalls ?? [])
    .filter(call => call.name === "companion_search_notes").map(call => call.id));
  return !messages.some(message => {
    if (message.role !== "tool" || !message.toolCallId || !searches.has(message.toolCallId) || typeof message.content !== "string") return false;
    try { return JSON.parse(message.content).ok === true; } catch { return false; }
  });
}
