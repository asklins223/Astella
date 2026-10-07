export type GuideRect = { left: number; top: number; width: number; height: number };
export type GuideViewport = { width: number; height: number };
const right = (box: GuideRect) => box.left + box.width;
const bottom = (box: GuideRect) => box.top + box.height;
/** Keep the chapter beside the resident; compact windows give reading the full available width. */
export function placeGuideChapter(viewport: GuideViewport, companion: GuideRect | null) {
  const margin = viewport.width < 700 ? 18 : viewport.width < 1100 ? 76 : 104;
  let left = margin;
  let width = Math.min(740, viewport.width - margin - 28);
  if (companion && viewport.width >= 1100) {
    const onRight = companion.left + companion.width / 2 >= viewport.width / 2;
    const available = onRight ? companion.left - margin - 32 : viewport.width - right(companion) - 60;
    if (available >= 420) {
      left = onRight ? margin : right(companion) + 32;
      width = Math.min(740, available);
    }
  }
  return { left, width };
}
export const guideOverlap = (a: GuideRect, b: GuideRect) => Math.max(0, Math.min(right(a), right(b)) - Math.max(a.left, b.left)) * Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.top, b.top));

/** The scrim covers every window edge; only the resident and the real target are clear. */
export function guideWindowMask(viewport: GuideViewport, companion: GuideRect | null, anchor: GuideRect | null) {
  // Feather outside the complete character, never through its face, hair or desk.
  const character = companion ? `<rect x="${companion.left - 36}" y="${companion.top - 36}" width="${companion.width + 72}" height="${companion.height + 72}" rx="38" fill="black" filter="url(#soft)"/><rect x="${companion.left - 18}" y="${companion.top - 18}" width="${companion.width + 36}" height="${companion.height + 36}" rx="14" fill="black"/>` : "";
  const target = anchor ? `<rect x="${anchor.left - 5}" y="${anchor.top - 5}" width="${anchor.width + 10}" height="${anchor.height + 10}" rx="16" fill="black"/>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${viewport.width}" height="${viewport.height}" viewBox="0 0 ${viewport.width} ${viewport.height}"><defs><filter id="soft"><feGaussianBlur stdDeviation="12"/></filter></defs><rect width="100%" height="100%" fill="white"/>${character}${target}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
