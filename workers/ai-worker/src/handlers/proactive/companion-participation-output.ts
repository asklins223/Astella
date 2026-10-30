/** Only suppress an exact reply/paragraph replay, never a semantically similar new thought. */
export function repeatsCompanionParentReply(text: string, parentReplies: readonly string[]): boolean {
  const normalize = (value: string) => value.trim().replace(/\s+/gu, " ");
  const candidate = normalize(text);
  return Boolean(candidate) && parentReplies.some(reply => normalize(reply) === candidate
    || reply.split(/\n\s*\n/u).some(paragraph => normalize(paragraph) === candidate));
}
