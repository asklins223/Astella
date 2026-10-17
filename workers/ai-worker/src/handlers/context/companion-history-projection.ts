/** A summary is a projection of durable history, never permission to drop an
 * arbitrary message. Keep user additions and all replies in the same exchange. */
export interface HistorySummaryCoverage {
  fromSeq: string | null;
  throughSeq: string | null;
  sourceSha256: string | null;
  uncovered?: readonly { fromSeq: string; throughSeq: string }[];
}

interface HistoryEntry { role: string; seq?: string | null }

export function companionExchangeStarts(messages: readonly HistoryEntry[]): number[] {
  if (!messages.length) return [];
  return [0, ...messages.flatMap((message, index) => index > 0
    && message.role === "user" && messages[index - 1]!.role !== "user" ? [index] : [])];
}

/** Protect the most recent answered exchange together with later additions. */
export function latestCompanionExchangeStart(messages: readonly HistoryEntry[]): number {
  let lastAssistant = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.role === "assistant") { lastAssistant = index; break; }
  }
  const starts = companionExchangeStarts(messages);
  for (let index = starts.length - 1; index >= 0; index--) if (starts[index]! <= lastAssistant) return starts[index]!;
  return 0;
}

export function projectCompanionHistory<T extends HistoryEntry>(
  messages: readonly T[], coverage?: HistorySummaryCoverage | null,
): { messages: T[]; folded: T[] } {
  const keep = () => ({ messages: [...messages], folded: [] as T[] });
  if (!coverage?.sourceSha256 || !coverage.fromSeq || !coverage.throughSeq) return keep();
  try {
    const from = BigInt(coverage.fromSeq), through = BigInt(coverage.throughSeq);
    if (from < 1n || from > through) return keep();
    const gaps = (coverage.uncovered ?? []).map(gap => [BigInt(gap.fromSeq), BigInt(gap.throughSeq)] as const);
    if (gaps.some(([start, end]) => start < 1n || start > end)) return keep();
    const starts = companionExchangeStarts(messages);
    const protectedStart = latestCompanionExchangeStart(messages);
    const kept: T[] = [], folded: T[] = [];
    for (const [index, start] of starts.entries()) {
      const exchange = messages.slice(start, starts[index + 1] ?? messages.length);
      const covered = start < protectedStart && exchange.every(message => {
        if (!message.seq) return false;
        const seq = BigInt(message.seq);
        return seq >= from && seq <= through && !gaps.some(([left, right]) => seq >= left && seq <= right);
      });
      (covered ? folded : kept).push(...exchange);
    }
    return { messages: kept, folded };
  } catch { return keep(); } // Unverifiable boundaries never replace originals.
}
