export type SourceBlock = { ordinal: number; type: string; content: string };

/**
 * 引文核对那一段在这里**不再各写各的**：三条生成链（脑图/速看/拓展）过去各存一份
 * `compactEvidence` + `exactQuote`，同一类错误要修三次（表格竖线、行首编号，
 * 2026-10-14 长文实测）。判据的唯一一份在 `note-grounding-source.ts`；
 * 脑图这一档不设"最短引用"下限（「固定电压」4 个字也是真引用），所以这里原样转出。
 */
export { exactQuote } from "./note-grounding-source.ts";

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

export function buildChunks(blocks: readonly SourceBlock[], limit: number) {
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

