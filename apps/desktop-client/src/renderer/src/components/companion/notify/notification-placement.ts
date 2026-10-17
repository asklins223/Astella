type Rect = { left: number; top: number; width: number; height: number };
type Placement = { left: number; top: number; side: "left" | "right" | "detached" };
const GAP = 16;
const right = (r: Rect) => r.left + r.width;
const bottom = (r: Rect) => r.top + r.height;
const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(right(a), right(b)) - Math.max(a.left, b.left))
  * Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.top, b.top));
const distance = (a: Rect, b: Rect) => Math.hypot(
  Math.max(a.left - right(b), b.left - right(a), 0),
  Math.max(a.top - bottom(b), b.top - bottom(a), 0),
);

/** The same paper finds room beside a character, a chat panel or an unavailable model. */
export function placeCompanionNotification(input: {
  viewport: { width: number; height: number }; paper: { width: number; height: number };
  companion: Rect | null; obstacles?: readonly Rect[]; compact?: boolean;
}): Placement {
  const { viewport, companion } = input;
  const width = Math.min(input.paper.width, viewport.width - 24), height = Math.min(input.paper.height, viewport.height - 24);
  const clamp = (value: number, maximum: number) => Math.max(12, Math.min(value, maximum - 12));
  const fit = (candidate: Placement): Placement => ({
    ...candidate,
    left: clamp(candidate.left, viewport.width - width),
    top: clamp(candidate.top, viewport.height - height),
  });
  if (!companion) return fit({ left: viewport.width - width - 18, top: viewport.height - height - 22, side: "detached" });

  const side = companion.left + companion.width / 2 >= viewport.width / 2 ? "left" : "right";
  const above: Placement = {
    left: side === "left" ? right(companion) - width : companion.left,
    top: companion.top - height - GAP,
    side,
  };
  const beside: Placement = {
    left: side === "left" ? companion.left - width - GAP : right(companion) + GAP,
    top: companion.top + 8,
    side,
  };
  const anchors: Placement[] = [
    ...input.compact ? [above, beside] : [beside, above],
    { left: side === "left" ? right(companion) + GAP : companion.left - width - GAP, top: beside.top, side: side === "left" ? "right" : "left" },
    { ...above, top: bottom(companion) + GAP },
  ];
  const obstacles = [companion, ...input.obstacles ?? []];
  const clearances = obstacles.map(obstacle => ({
    left: obstacle.left - GAP, top: obstacle.top - GAP,
    width: obstacle.width + GAP * 2, height: obstacle.height + GAP * 2,
  }));
  // Make room around the actual controls, task tab and reply. An unrelated
  // empty screen corner must never compete with the character's own seat.
  const candidates = anchors.map(fit).flatMap(anchor => [anchor, ...obstacles.flatMap(obstacle => [
    { ...anchor, left: obstacle.left - width - GAP },
    { ...anchor, left: right(obstacle) + GAP },
    { ...anchor, top: obstacle.top - height - GAP },
    { ...anchor, top: bottom(obstacle) + GAP },
  ])]).map(fit);
  const scored = candidates.map(candidate => {
    const rect = { ...candidate, width, height };
    return {
      candidate,
      covered: clearances.reduce((total, obstacle) => total + overlap(rect, obstacle), 0),
      distance: distance(rect, companion),
    };
  });
  scored.sort((a, b) => a.covered - b.covered || a.distance - b.distance);
  return scored[0].candidate;
}
