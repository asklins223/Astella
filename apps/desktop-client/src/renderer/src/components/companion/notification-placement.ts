type Rect = { left: number; top: number; width: number; height: number };
const right = (r: Rect) => r.left + r.width;
const bottom = (r: Rect) => r.top + r.height;
const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(right(a), right(b)) - Math.max(a.left, b.left))
  * Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.top, b.top));

/** The same paper finds room beside a character, a chat panel or an unavailable model. */
export function placeCompanionNotification(input: {
  viewport: { width: number; height: number }; paper: { width: number; height: number };
  companion: Rect | null; obstacles?: readonly Rect[]; compact?: boolean;
}): { left: number; top: number; side: "left" | "right" | "detached" } {
  const { viewport, companion } = input;
  const width = Math.min(input.paper.width, viewport.width - 24), height = Math.min(input.paper.height, viewport.height - 24);
  const clamp = (value: number, maximum: number) => Math.max(12, Math.min(value, maximum - 12));
  const fallback = { left: viewport.width - width - 18, top: viewport.height - height - 22, side: "detached" as const };
  const candidates = companion ? [
    ...input.compact ? [{ left: right(companion)-width, top: companion.top-height-16, side: "right" as const }] : [],
    { left: companion.left - width - 16, top: companion.top + 8, side: "left" as const },
    { left: right(companion) + 16, top: companion.top + 8, side: "right" as const },
    { left: companion.left - width - 16, top: companion.top - height - 16, side: "left" as const },
    { left: viewport.width - width - 18, top: 84, side: "detached" as const }, fallback,
  ] : [fallback];
  const obstacles = [...input.obstacles ?? [], ...companion ? [companion] : []];
  return candidates.map((candidate, index) => {
    const rect = { ...candidate, width, height, left: clamp(candidate.left, viewport.width - width), top: clamp(candidate.top, viewport.height - height) };
    return { ...rect, score: obstacles.reduce((total, obstacle) => total + overlap(rect, obstacle), 0) + index };
  }).sort((a, b) => a.score - b.score)[0];
}
