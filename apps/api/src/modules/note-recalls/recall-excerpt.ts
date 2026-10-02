export type RecallTextBlock = { readonly ordinal: number; readonly type: string; readonly text: string };
export type RecallExcerpt = { readonly ordinal: number; readonly title: string | null; readonly text: string; readonly truncated: boolean };

const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const stop = new Set(["为什么", "是什么", "怎么", "怎样", "如何", "哪些", "什么", "这一", "这篇", "笔记", "主要", "部分", "问题", "IndexTTS".toLowerCase()]);
const terms = (text: string) => {
  const words = text.toLowerCase().match(/[a-z][a-z\d-]{2,}|[\p{Script=Han}]+/gu) ?? [];
  const result = new Set<string>();
  for (const word of words) {
    if (/^[a-z]/u.test(word)) { if (!stop.has(word)) result.add(word); continue; }
    for (let i = 0; i < word.length - 1; i++) {
      const term = word.slice(i, i + 2);
      if (![...stop].some(item => item.includes(term))) result.add(term);
    }
  }
  return result;
};

/** Choose a real paragraph; images, link-only lines and headings cannot become answers. */
export function recallExcerptCandidates(blocks: readonly RecallTextBlock[]): RecallExcerpt[] {
  let title: string | null = null;
  return blocks.flatMap(block => {
    if (block.type === "heading") { title = block.text.replace(/^#{1,6}\s+/u, "").trim().slice(0, 200) || null; return []; }
    if (!["paragraph", "quote", "list"].includes(block.type)) return [];
    const text = block.text.trim();
    const prose = text.replace(/!?\[[^\]]*\]\([^)]*\)|https?:\/\/\S+/gu, "").replace(/[^\p{L}\p{N}]/gu, "");
    if (prose.length < 12) return [];
    const max = 900;
    const prefix = text.slice(0, max);
    const sentenceEnd = Math.max(prefix.lastIndexOf("。"), prefix.lastIndexOf("！"), prefix.lastIndexOf("？"));
    const excerpt = text.length > max && sentenceEnd > max / 2 ? prefix.slice(0, sentenceEnd + 1) : prefix;
    return [{ ordinal: block.ordinal, title, text: excerpt, truncated: excerpt.length < text.length }];
  });
}

/** Rotate real paragraph locations, independent of self reports or inferred mastery. */
export function nextRecallExcerpt(candidates: readonly RecallExcerpt[], usedOrdinals: readonly number[]): RecallExcerpt | null {
  if (!candidates.length) return null;
  const unused = candidates.find(candidate => !usedOrdinals.includes(candidate.ordinal));
  if (unused) return unused;
  const last = candidates.findIndex(candidate => candidate.ordinal === usedOrdinals[0]);
  return candidates[(last + 1) % candidates.length];
}

/** A companion question must identify an unambiguous source, rather than copy the whole note. */
export function groundedRecallExcerpt(candidates: readonly RecallExcerpt[], question: string): RecallExcerpt | null {
  const questionTerms = terms(question);
  const scores = candidates.map(candidate => {
    const candidateTerms = terms(`${candidate.title ?? ""} ${candidate.text}`);
    const score = [...questionTerms].filter(term => candidateTerms.has(term)).length;
    const title = normalize(candidate.title ?? "");
    const titleMatch = title.length >= 3 && normalize(question).includes(title);
    return { candidate, score: score + (titleMatch ? 10 : 0) };
  }).sort((a, b) => b.score - a.score);
  const first = scores[0], second = scores[1];
  if (!first || first.score < 2 || (second && first.score < second.score + 1)) return null;
  return first.candidate;
}
