import { CompanionReadBatch } from "../tools/companion-read-batch.ts";

export type CompanionReviewParagraph = { text: string; separator: string };
/** Preserve original paragraph separators; blank lines inside fenced code are
 * part of that same review unit. Every unit still sees the complete draft. */
export function splitCompanionReviewParagraphs(draft: string): CompanionReviewParagraph[] {
  const parts: CompanionReviewParagraph[] = [];
  let fence: { marker: string; length: number } | undefined;
  let start = 0, offset = 0, separator = "";
  for (const line of draft.split(/(?<=\n)/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1]![0] === fence.marker && marker[1]!.length >= fence.length
        && line.slice(marker[0].length).trim() === "") fence = undefined;
    } else if (marker) fence = { marker: marker[1]![0]!, length: marker[1]!.length };
    else if (/^ {0,3}(?:\d{1,3}[.)、]|[-+*])\s+/.test(line) && offset > start && draft.slice(start, offset).trim()) {
      const end = draft[offset - 1] === "\n" ? offset - 1 : offset;
      parts.push({ text: draft.slice(start, end), separator });
      separator = draft.slice(end, offset); start = offset;
    }
    else if (/^[ \t\r]*\n$/.test(line) && offset > start) {
      const end = draft[offset - 1] === "\n" ? offset - 1 : offset;
      const text = draft.slice(start, end);
      if (text.trim()) { parts.push({ text, separator }); separator = draft.slice(end, offset + line.length); }
      else separator += draft.slice(start, offset + line.length);
      start = offset + line.length;
    } else if (/^[ \t\r]*\n$/.test(line)) { separator += line; start = offset + line.length; }
    offset += line.length;
  }
  if (draft.slice(start).trim()) parts.push({ text: draft.slice(start), separator });
  return parts;
}

/** Actual Unicode character count, excluding interface-only citation markers. */
export function companionReviewProseLength(draft: string): number {
  return Array.from(draft.replace(/\[\^web-[^\]\s]+\]/g, "")).length;
}

/** Short answers need one coherent verdict: independently rewriting each
 * sentence can repeat the whole answer and cannot enforce a total word count.
 * Long answers retain parallel paragraph review and early verified delivery.
 * This only groups complete text; it never clips source material or a draft. */
export function companionReviewUnits(draft: string): CompanionReviewParagraph[] {
  const parts = splitCompanionReviewParagraphs(draft);
  const proseLength = companionReviewProseLength(draft);
  return parts.length > 1 && proseLength <= 800
    ? [{ text: parts.map(part => part.separator + part.text).join(""), separator: "" }]
    : parts;
}

/** Verify independent units concurrently but publish only the next verified
 * paragraph in original order. A later failure cannot erase an earlier body.
 * Each review returns a parsed complete verdict, never an unfinished JSON key. */
export async function reviewCompanionParagraphs(input: {
  paragraphs: readonly CompanionReviewParagraph[];
  signal: AbortSignal;
  review: (paragraph: CompanionReviewParagraph, index: number, signal: AbortSignal) => Promise<string>;
  validate: (text: string) => void;
  publish?: (delta: string) => Promise<boolean>;
}): Promise<string> {
  const batch = new CompanionReadBatch({ count: input.paragraphs.length, signal: input.signal,
    operation: () => "review.paragraph", prepare: async index => index, key: String,
    execute: (index, _prepared, signal) => input.review(input.paragraphs[index]!, index, signal) });
  let text = "";
  try {
    for (const [index, paragraph] of input.paragraphs.entries()) {
      input.signal.throwIfAborted();
      const entry = await batch.at(index);
      const reviewed = entry ? await entry.result : await input.review(paragraph, index, input.signal);
      input.signal.throwIfAborted();
      if (!reviewed.trim()) continue;
      const delta = (text ? paragraph.separator : "") + reviewed;
      input.validate(text + delta);
      if (input.publish && !await input.publish(delta)) throw new Error("verified paragraph delivery stopped");
      text += delta;
    }
    return text;
  } finally { await batch.close(); }
}
