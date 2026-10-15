import type { AgentTurnRequest } from "@astella/shared";
import { noteBlockRenderedTextV1 } from "@astella/shared/note-doc-schema";
import { recomputedBlockSources } from "./companion-dialogue-content.ts";

/** Compare against material the tools actually returned, after JSON decoding. */
export function companionQuoteSourceTexts(
  contextText: string,
  messages: AgentTurnRequest["messages"],
): string[] {
  const sources: string[] = [];
  const strings = (value: unknown): void => {
    if (typeof value === "string") sources.push(value, noteBlockRenderedTextV1("paragraph", value));
    else if (Array.isArray(value)) value.forEach(strings);
    else if (value && typeof value === "object") Object.values(value).forEach(strings);
  };
  const contextMessages = messages.filter(message => message.role === "user" || message.role === "system");
  const readBlock = (block: string) => {
    sources.push(block);
    const data = block.slice(block.indexOf(">") + 1, block.lastIndexOf("</"));
    try { strings(JSON.parse(data)); } catch { /* A plain source block is already retained. */ }
  };
  const contextBlocks = recomputedBlockSources(contextText);
  contextBlocks.forEach(readBlock);
  if (!contextMessages.length && !contextBlocks.length && contextText) sources.push(contextText);
  for (const message of contextMessages) {
    const content = typeof message.content === "string" ? message.content
      : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
    if (message.role === "user") strings(content);
    else recomputedBlockSources(content).forEach(readBlock);
  }
  for (const message of messages) {
    if (message.role !== "tool" || typeof message.content !== "string") continue;
    try { strings(JSON.parse(message.content)); }
    catch { sources.push(message.content); }
  }
  return [...new Set(sources)];
}
