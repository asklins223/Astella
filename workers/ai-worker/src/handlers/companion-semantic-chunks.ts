import { measureChatRequest, type ContextTokenCountingPorts } from "@astella/agent-core";
import type { ChatMessage, ChatOptions } from "@astella/shared";
import { sha256Utf8V1, stableStringify } from "@astella/shared/content-hash";
import { restoreCompanionSemanticCheckpoint, type CompanionSemanticCheckpointStore } from "./companion-semantic-checkpoint.ts";

export interface CompanionSourcePart {
  /** UTF-16 offsets into the immutable complete source; end is exclusive. */
  start: number;
  end: number;
  total: number;
  text: string;
}

/** A capacity boundary partitions the source; it never discards the remainder.
 * Prefer existing paragraph/message boundaries and never split a surrogate pair. */
function sourceBoundary(text: string, start: number, end: number): number {
  if (end >= text.length) return text.length;
  if (end > start && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
  const newline = text.lastIndexOf("\n", end - 1);
  return newline >= start + (end - start) / 2 ? newline + 1 : end;
}

/** Read every part in order, carrying the preceding semantic checkpoint into
 * the next request. Only successful completion returns coverage. A failed or
 * cancelled part cannot turn the unprocessed suffix into a covered source. */
export async function summarizeCompleteCompanionSource<T>(input: {
  text: string;
  previous: T | null;
  inputTokens: number;
  options: ChatOptions;
  counting?: ContextTokenCountingPorts;
  signal?: AbortSignal;
  messages: (part: CompanionSourcePart, previous: T | null) => ChatMessage[];
  summarize: (messages: ChatMessage[], part: CompanionSourcePart, index: number) => Promise<T>;
  checkpoint?: { store: CompanionSemanticCheckpointStore; parse: (value: unknown) => T };
}): Promise<{ summary: T; parts: number }> {
  if (!Number.isSafeInteger(input.inputTokens) || input.inputTokens <= 0 || !input.text.length)
    throw new Error("semantic source compaction requires a nonempty source and a positive input capacity");
  let start = 0, parts = 0, previous = input.previous;
  const identity = input.checkpoint ? {
    sourceSha256: sha256Utf8V1(input.text),
    contractSha256: sha256Utf8V1(stableStringify({ version: 1, contract: input.checkpoint.store.contract,
      inputTokens: input.inputTokens, options: input.options,
      initialMessages: input.messages({ start: 0, end: input.text.length, total: input.text.length, text: input.text }, input.previous) })),
  } : null;
  if (identity && input.checkpoint) {
    input.signal?.throwIfAborted();
    const restored = restoreCompanionSemanticCheckpoint({ ...identity, text: input.text,
      value: await input.checkpoint.store.load(), parse: input.checkpoint.parse });
    input.signal?.throwIfAborted();
    if (restored) {
      start = restored.end; parts = restored.parts; previous = restored.summary;
      input.checkpoint.store.onResume?.({ end: start, total: input.text.length, parts, sourceSha256: identity.sourceSha256 });
    }
  }
  while (start < input.text.length) {
    input.signal?.throwIfAborted();
    const request = (end: number) => {
      const part = { start, end, total: input.text.length, text: input.text.slice(start, end) };
      return { part, messages: input.messages(part, previous) };
    };
    const fits = async (messages: ChatMessage[]) => {
      input.signal?.throwIfAborted();
      const measured = await measureChatRequest(messages, input.options, input.counting);
      return measured.inputTokens + measured.errorMarginTokens <= input.inputTokens;
    };
    let selected = request(input.text.length);
    if (!await fits(selected.messages)) {
      // Every candidate measures the complete request, including the growing
      // checkpoint, protocol, metadata and output mode's tool declarations.
      let low = start, high = input.text.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (await fits(request(middle).messages)) low = middle;
        else high = middle - 1;
      }
      const end = sourceBoundary(input.text, start, low);
      if (end <= start) throw new Error("semantic checkpoint and protocol leave no capacity for the next source character");
      selected = request(end);
      if (!await fits(selected.messages)) throw new Error("semantic source part exceeds measured request capacity");
    }
    input.signal?.throwIfAborted();
    previous = await input.summarize(selected.messages, selected.part, parts);
    input.signal?.throwIfAborted();
    if (identity && input.checkpoint) {
      // Persist only a completed, schema-validated cumulative state, before
      // requesting the next part. The unread suffix never becomes coverage.
      previous = input.checkpoint.parse(previous);
      const summaryJson = stableStringify(previous);
      await input.checkpoint.store.save({ version: 1, ...identity, total: input.text.length,
        end: selected.part.end, parts: parts + 1, prefixSha256: sha256Utf8V1(input.text.slice(0, selected.part.end)),
        summaryJson, summarySha256: sha256Utf8V1(summaryJson) });
      input.signal?.throwIfAborted();
    }
    parts++;
    start = selected.part.end;
  }
  return { summary: previous!, parts };
}
