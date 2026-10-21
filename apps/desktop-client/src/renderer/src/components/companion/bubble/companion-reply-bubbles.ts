import { companionBubblePreviewText } from "./companion-bubble-reveal";

/**
 * One bubble per published assistant message, when the joined reply and the
 * stored message parts line up. A streamed tail not yet in history stays its
 * own bubble; anything that cannot be matched stays one bubble rather than
 * inventing a boundary.
 */
export function companionReplyBubbles(joined: string, parts: readonly string[]): string[] {
  const full = joined.trim();
  const cleaned = parts.map(part => part.trim()).filter(Boolean);
  if (cleaned.length <= 1) return full ? [full] : [];
  const durable = cleaned.join("\n\n");
  if (full === durable) return cleaned;
  if (full.startsWith(`${durable}\n\n`)) {
    const tail = full.slice(durable.length + 2).trim();
    return tail ? [...cleaned, tail] : cleaned;
  }
  return full ? [full] : [];
}

/**
 * The text each bubble shows at `revealedChars` into the joined reply. Later
 * bubbles stay absent until the reveal reaches them; the two-character
 * separator between messages counts as part of the same timeline.
 */
export function companionBubbleViews(bubbles: readonly string[], revealedChars: number): string[] {
  let remaining = Math.max(0, revealedChars);
  const out: string[] = [];
  for (const bubble of bubbles) {
    if (remaining <= 0) break;
    out.push(companionBubblePreviewText(bubble, Math.min(remaining, bubble.length)));
    remaining -= bubble.length + 2;
  }
  return out;
}

/**
 * The one bubble the light HUD shows: the newest message the reveal has
 * reached. Earlier messages have been read and their bubbles are gone; the
 * next message appears only when its first character is reached.
 */
export function companionActiveBubble(
  bubbles: readonly string[],
  revealedChars: number,
): { readonly index: number; readonly text: string } | null {
  const views = companionBubbleViews(bubbles, revealedChars);
  const index = views.length - 1;
  const text = index >= 0 ? views[index] : undefined;
  return text === undefined ? null : { index, text };
}
