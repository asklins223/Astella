import type { AgentTurnRequest } from "@astella/shared";
import { noteBlockRenderedTextV1 } from "@astella/shared/note-doc-schema";

/** Compare against material the tools actually returned, after JSON decoding. */
export function companionQuoteSourceText(
  contextText: string,
  messages: AgentTurnRequest["messages"],
): string {
  const sources = [contextText];
  const strings = (value: unknown): void => {
    if (typeof value === "string") sources.push(value, noteBlockRenderedTextV1("paragraph", value));
    else if (Array.isArray(value)) value.forEach(strings);
    else if (value && typeof value === "object") Object.values(value).forEach(strings);
  };
  for (const message of messages) {
    if (message.role !== "tool" || typeof message.content !== "string") continue;
    try { strings(JSON.parse(message.content)); }
    catch { sources.push(message.content); }
  }
  return sources.join("\n");
}
