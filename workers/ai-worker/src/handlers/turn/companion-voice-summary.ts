/**
 * Spoken summary budget for a companion reply.
 *
 * The display keeps the complete formatted explanation (formulas, tables,
 * steps). Speech reads only a sentence-safe prefix so a long answer does not
 * become a minute-long monologue. 0 disables the budget and reads the whole
 * reply, which is also the explicit "read it all" behaviour.
 */
export const COMPANION_VOICE_SUMMARY_DEFAULT_CHARS = 200;

export function resolveCompanionVoiceSummaryMaxChars(
  raw: string | undefined = process.env.COMPANION_VOICE_SUMMARY_MAX_CHARS,
): number {
  if (raw === undefined || raw.trim() === "") return COMPANION_VOICE_SUMMARY_DEFAULT_CHARS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return COMPANION_VOICE_SUMMARY_DEFAULT_CHARS;
  return Math.floor(parsed);
}

/** Whether a display segment belongs to the spoken prefix of this message. */
export function isVoiceSegmentWithinSummary(
  displayStart: number,
  messageOffset: number,
  maxChars: number,
): boolean {
  if (maxChars <= 0) return true;
  return displayStart < messageOffset + maxChars;
}
