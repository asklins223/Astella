export type GuideRect = { left: number; top: number; width: number; height: number };
export type GuideViewport = { width: number; height: number };
const right = (box: GuideRect) => box.left + box.width;
const bottom = (box: GuideRect) => box.top + box.height;
export const guideOverlap = (a: GuideRect, b: GuideRect) => Math.max(0, Math.min(right(a), right(b)) - Math.max(a.left, b.left)) * Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.top, b.top));

/** The scrim covers every window edge; only the resident and the real target are clear. */
export function guideWindowMask(viewport: GuideViewport, companion: GuideRect | null, anchor: GuideRect | null) {
  // Feather outside the complete character, never through its face, hair or desk.
  const character = companion ? `<rect x="${companion.left - 36}" y="${companion.top - 36}" width="${companion.width + 72}" height="${companion.height + 72}" rx="38" fill="black" filter="url(#soft)"/><rect x="${companion.left - 18}" y="${companion.top - 18}" width="${companion.width + 36}" height="${companion.height + 36}" rx="14" fill="black"/>` : "";
  const target = anchor ? `<rect x="${anchor.left - 5}" y="${anchor.top - 5}" width="${anchor.width + 10}" height="${anchor.height + 10}" rx="16" fill="black"/>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${viewport.width}" height="${viewport.height}" viewBox="0 0 ${viewport.width} ${viewport.height}"><defs><filter id="soft"><feGaussianBlur stdDeviation="12"/></filter></defs><rect width="100%" height="100%" fill="white"/>${character}${target}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** Place the cue near its target without laying it over the character, narration or controls. */
export function placeGuidePointer(viewport: GuideViewport, anchor: GuideRect, size: { width: number; height: number }, obstacles: readonly GuideRect[]) {
  const width = Math.min(size.width, viewport.width - 28), height = size.height;
  const gap = 20;
  const candidates = [
    { left: right(anchor) + gap, top: anchor.top + (anchor.height - height) / 2 },
    { left: anchor.left - width - gap, top: anchor.top + (anchor.height - height) / 2 },
    { left: anchor.left + (anchor.width - width) / 2, top: bottom(anchor) + gap },
    { left: anchor.left + (anchor.width - width) / 2, top: anchor.top - height - gap },
    { left: viewport.width - width - 26, top: 105 },
    { left: 105, top: viewport.height - height - 130 },
    { left: 105, top: 14 },
    { left: viewport.width - width - 26, top: viewport.height - height - 140 },
    { left: viewport.width * .48, top: 168 },
  ].map(point => ({ ...point, left: Math.max(14, Math.min(point.left, viewport.width - width - 14)), top: Math.max(14, Math.min(point.top, viewport.height - height - 14)), width, height }));
  const center = { x: anchor.left + anchor.width / 2, y: anchor.top + anchor.height / 2 };
  return candidates.map((candidate, index) => ({ ...candidate, score: [...obstacles, anchor].reduce((score, obstacle) => score + guideOverlap(candidate, obstacle) * 100, 0) + Math.hypot(candidate.left + width / 2 - center.x, candidate.top + height / 2 - center.y) + index }))
    .sort((a, b) => a.score - b.score)[0];
}

/** Connect to the nearest edge, so arrows point at the control rather than across it. */
export function guidePointerPath(pointer: GuideRect, anchor: GuideRect) {
  const x = pointer.left + pointer.width / 2;
  // A distant cue for the left rail connects from below its text, past the chapter title.
  const y = right(anchor) < pointer.left - 250 ? bottom(pointer) : pointer.top + pointer.height / 2;
  const targetX = Math.max(anchor.left, Math.min(x, right(anchor)));
  const targetY = Math.max(anchor.top, Math.min(y, bottom(anchor)));
  const sourceX = Math.max(pointer.left, Math.min(targetX, right(pointer)));
  const sourceY = Math.max(pointer.top, Math.min(targetY, bottom(pointer)));
  return `M ${sourceX} ${sourceY} Q ${sourceX} ${targetY} ${targetX} ${targetY}`;
}
