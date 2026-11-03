/** Rank literal query terms within an already fetched document. This selects
 * an exact text window, never synthesizes evidence or authorizes another URL.
 * Rare terms weigh more than repeated navigation/site names. */
export function selectPublicDocumentQueryWindow(body: string, query: string, windowChars: number): {
  offset: number; matchedTerms: string[];
} | null {
  const terms = [...new Set(Array.from(new Intl.Segmenter(undefined, { granularity: "word" }).segment(query))
    .filter(item => item.isWordLike && Array.from(item.segment).length >= 2).map(item => item.segment.toLocaleLowerCase()))];
  if (!terms.length || Array.from(body).length <= windowChars) return null;
  const matches = terms.flatMap(term => {
    const literal = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const positions = Array.from(body.matchAll(new RegExp(literal, "giu")), match => match.index!);
    return positions.length ? [{ term, positions, weight: Math.log1p(body.length / (positions.length * windowChars)) }] : [];
  });
  if (!matches.length) return null;
  const positions = matches.flatMap((item, term) => item.positions.map(index => ({ index, term }))).sort((a, b) => a.index - b.index);
  const counts = matches.map(() => 0);
  let left = 0, right = 0, weight = 0;
  let best = { offset: 0, matchedTerms: [] as string[], weight: -1 };
  // Evaluate starts near actual term occurrences, not every character. Common
  // site/navigation words cannot win by repeating in one window. Two moving
  // cursors keep this linear after sorting, including very repetitive pages.
  for (const offset of [0, ...positions.map(item => Math.max(0, item.index - Math.floor(windowChars / 4)))]) {
    while (right < positions.length && positions[right]!.index < offset + windowChars) {
      const term = positions[right++]!.term;
      if (counts[term]!++ === 0) weight += matches[term]!.weight;
    }
    while (left < right && positions[left]!.index < offset) {
      const term = positions[left++]!.term;
      if (--counts[term]! === 0) weight -= matches[term]!.weight;
    }
    if (weight > best.weight + 1e-12) best = { offset, weight,
      matchedTerms: matches.filter((_item, index) => counts[index]! > 0).map(item => item.term) };
  }
  if (best.offset === 0) return null;
  return { offset: Array.from(body.slice(0, best.offset)).length, matchedTerms: best.matchedTerms };
}
