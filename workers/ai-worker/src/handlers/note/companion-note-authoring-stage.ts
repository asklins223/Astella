import { companionOperationName, type AgentTurnRequest } from "@astella/shared";
import { explicitCompanionProductRequest } from "../tools/companion-tool-intent.ts";
import { userForbidsNoteLibraryRead } from "./companion-note-authoring.ts";

/** The writer requires a real library search. Expose that dependency before
 * asking the model to draft notes, instead of rejecting an expensive draft. */
export function companionNoteNeedsRelatedSearch(userText: string, libraryReadAllowed: boolean,
  messages: AgentTurnRequest["messages"]): boolean {
  if (!libraryReadAllowed || !explicitCompanionProductRequest(userText).newNote || userForbidsNoteLibraryRead(userText)) return false;
  let currentRequest = messages.length - 1;
  while (currentRequest >= 0 && messages[currentRequest].role !== "user") currentRequest -= 1;
  const currentMessages = currentRequest < 0 ? messages : messages.slice(currentRequest);
  const searches = new Set(currentMessages.flatMap(message => message.toolCalls ?? [])
    .filter(call => companionOperationName(call) === "notes.read.search").map(call => call.id));
  return !currentMessages.some(message => {
    if (message.role !== "tool" || !message.toolCallId || !searches.has(message.toolCallId) || typeof message.content !== "string") return false;
    try { return JSON.parse(message.content).ok === true; } catch { return false; }
  });
}

/** Resolve and read before drafting an edit. No prose/tool arguments need a
 * long reasoning pass while the source identity is still unknown. */
export function companionNoteEditPrerequisite(input: {
  requestedActions: readonly string[]; hasPageNote: boolean;
  /** A complete host prefetch already supplied the version and full body. */
  hostNotePrefetched?: boolean;
  successfulTools: readonly { name: string; arguments: Record<string, unknown>; data: Record<string, unknown> }[];
}): "search" | "read" | null {
  if (!input.requestedActions.includes("notes.write.edit")) return null;
  if (input.hostNotePrefetched === true) return null;
  if (input.successfulTools.some(tool => tool.name === "notes.read.read" && tool.arguments.includeBlocks === true)) return null;
  const search = input.successfulTools.find(tool => tool.name === "notes.read.search");
  if (input.hasPageNote || (Array.isArray(search?.data.notes) && search.data.notes.length > 0)) return "read";
  return search ? null : "search";
}
