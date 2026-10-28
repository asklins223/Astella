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
