/** Canonical spacing for exact duplicate detection. Preserve words, case and
 * punctuation: removing a qualifier or negation can change the stated fact. */
export function normalizeCompanionMemoryContent(content: string): string {
  return content.trim().replace(/\s+/gu, " ");
}
