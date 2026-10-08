export type SourceBlock = { ordinal: number; type: string; content: string };

function compactEvidence(value: string): { text: string; sourceOffsets: number[] } {
  const chars = Array.from(value);
  const text: string[] = [];
  const sourceOffsets: number[] = [];
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    if (/\s/u.test(char)) continue;
    // Ignore common Markdown emphasis/code markers while retaining the exact
    // original offsets for the quotation that will be shown to the reader.
    if ("*_~`".includes(char)) continue;
    text.push(char);
    sourceOffsets.push(index);
  }
  return { text: text.join(""), sourceOffsets };
}

export function exactQuote(blockText: string, candidate: string): string | null {
  const needle = compactEvidence(candidate).text;
  if (needle.length < 1) return null;
  const source = compactEvidence(blockText);
  const offset = source.text.indexOf(needle);
  if (offset < 0) return null;
  const start = Array.from(source.text.slice(0, offset)).length;
  const from = source.sourceOffsets[start];
  const to = source.sourceOffsets[start + Array.from(needle).length - 1];
  if (from === undefined || to === undefined) return null;
  const quote = Array.from(blockText).slice(from, to + 1).join("").trim();
  return quote.length <= 500 ? quote : null;
}

export function imageSafeText(content: string): { text: string; imageCount: number } {
  let imageCount = 0;
  const text = content.replace(/!\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/gu, () => {
    imageCount += 1;
    return "";
  });
  const safeText = text.replace(/<img\b[^>]*>/giu, () => { imageCount += 1; return ""; }).replace(/!\[[^\]]*\]\[[^\]]*\]/gu, () => { imageCount += 1; return ""; });
  return { text: safeText, imageCount };
}

function splitAtCodePointLimit(value: string, limit: number): string[] {
  const chars = Array.from(value);
  const result: string[] = [];
  for (let index = 0; index < chars.length; index += limit) {
    result.push(chars.slice(index, index + limit).join(""));
  }
  return result;
}

export function buildChunks(blocks: readonly SourceBlock[], limit = 16_000) {
  const chunks: { readonly lines: readonly { ordinal: number; text: string }[]; readonly ordinals: ReadonlySet<number> }[] = [];
  let lines: { ordinal: number; text: string }[] = [];
  let charCount = 0;
  const flush = () => {
    if (lines.length === 0) return;
    chunks.push({ lines, ordinals: new Set(lines.map((line) => line.ordinal)) });
    lines = [];
    charCount = 0;
  };

  for (const block of blocks) {
    const safe = block.type === "image"
      ? { text: "", imageCount: 1 }
      : imageSafeText(block.content);
    const content = safe.text.trim();
    if (!content) continue;
    for (const piece of splitAtCodePointLimit(content, limit)) {
      const size = Array.from(piece).length;
      if (charCount > 0 && charCount + size > limit) flush();
      lines.push({ ordinal: block.ordinal, text: piece });
      charCount += size;
      if (charCount >= limit) flush();
    }
  }
  flush();
  return chunks;
}

