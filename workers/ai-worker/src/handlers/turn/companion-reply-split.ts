/** The reply is already written; this module only decides where one message
 * ends and the next begins. The model owns the shape by writing paragraphs —
 * there is no separate judgment about whether the user asked for several. */
export const COMPANION_REPLY_SPLIT_MAX = 6;

/**
 * Cut one reply into the separate messages it already contains.
 *
 * A model asked to "say it in two messages" writes both of them in one reply,
 * separated by a blank line. A long answer written as several paragraphs is
 * delivered the same way: people text in short bubbles, and the generation that
 * answered already decided the grouping. Blank lines inside a fenced code block
 * are not boundaries; extra paragraphs beyond `limit` join the last message so
 * nothing is dropped or reordered.
 */
export function splitCompanionReplyParts(text: string, limit: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parts: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    const value = current.join("\n").trim();
    if (value) parts.push(value);
    current = [];
  };
  for (const line of trimmed.split("\n")) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      current.push(line);
      continue;
    }
    if (marker) {
      fence = marker[1];
      current.push(line);
      continue;
    }
    if (line.trim() === "") { flush(); continue; }
    current.push(line);
  }
  flush();
  if (parts.length <= 1) return parts;
  // A heading alone is not a message. Attach heading-only blocks to the
  // paragraph that follows (or to the previous one when it ends the reply).
  const grouped: string[] = [];
  let headings: string[] = [];
  for (const part of parts) {
    if (part.split("\n").every(line => /^#{1,6}\s+\S/.test(line.trim()))) { headings.push(part); continue; }
    grouped.push([...headings, part].join("\n\n"));
    headings = [];
  }
  if (headings.length > 0) {
    if (grouped.length > 0) grouped[grouped.length - 1] += `\n\n${headings.join("\n\n")}`;
    else grouped.push(...headings);
  }
  // A long-form answer is meant to be read as one piece. Splitting it into a
  // dozen bubbles is worse than one message; only conversational replies that
  // fit the cap are delivered separately.
  const cap = Math.max(2, Math.trunc(limit));
  if (grouped.length > cap) return [trimmed];
  // Structured text (headings, bold labels, lists, quotes, code) uses blank
  // lines as layout, not as message boundaries. A sectioned explanation must
  // not turn into one bubble per label.
  const structured = grouped.some(part => /^(?:#{1,6}\s|\*\*[^*\n]+\*\*\s*[:：]|[-*+]\s|\d+[.、)]\s|>\s|`{3,}|~{3,})/u
    .test(part.trim()));
  const conversational = grouped.every(part => part.length <= 160 && !part.includes("\n\n"));
  if (structured || !conversational) return [trimmed];
  return grouped;
}

/**
 * The message drafts for one reply: one entry per delivered message.
 *
 * Rich blocks (citations, saved-note cards, navigation) attach to the last
 * entry only, because they trail the reply — a list of results must never sit
 * between two sentences she said separately.
 */
export function companionReplyMessageDrafts(input: {
  parts: readonly string[];
  richBlocks: readonly Record<string, unknown>[];
  emotion: string;
  hash: (value: unknown) => string;
  newId: () => string;
  maxRichBlocks?: number;
}): Array<{ id: string; text: string; blocks: Array<Record<string, unknown>>; contentSha256: string }> {
  const parts = input.parts.length > 0 ? input.parts : [""];
  return parts.map((text, index) => {
    const last = index === parts.length - 1;
    const blocks = [
      { type: "text", text, emotion: input.emotion },
      ...(last ? input.richBlocks.slice(0, input.maxRichBlocks ?? 32) : []),
    ];
    return { id: input.newId(), text, blocks, contentSha256: input.hash(blocks) };
  });
}
