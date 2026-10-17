import type { Rect } from "./companion-home-placement";

export interface CompanionFloatingPlacement {
  side: "left" | "right";
  headDock: "above" | "left" | "right" | "below";
  head: Rect & { width: number; height: number };
  papers: Rect & { width: number; height: number };
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, Math.max(low, high)));
const rect = (left: number, top: number, width: number, height: number): Rect & { width: number; height: number } => ({ left, top, width, height, right: left + width, bottom: top + height });

/** The character and its entry points share one protected interaction seat. */
function interactionBounds(role: Rect, controls: readonly Rect[]): Rect {
  return controls.reduce((bounds, control) => ({
    left: Math.min(bounds.left, control.left), right: Math.max(bounds.right, control.right),
    top: Math.min(bounds.top, control.top), bottom: Math.max(bounds.bottom, control.bottom),
  }), role);
}

/** Keeps the conversation book beside the protected head; tails may sit beneath it. */
export function companionHistoryPlacement(role: Rect, viewportWidth: number, preferredWidth = 760, controls: readonly Rect[] = []) {
  const bounds = interactionBounds(role, controls);
  const edge = 18;
  const gap = 16;
  const leftRoom = Math.max(0, bounds.left - gap - edge);
  const rightRoom = Math.max(0, viewportWidth - bounds.right - gap - edge);
  let side: "left" | "right" = (role.left + role.right) / 2 >= viewportWidth / 2 ? "left" : "right";
  if (side === "left" && leftRoom < 300 && rightRoom > leftRoom) side = "right";
  if (side === "right" && rightRoom < 300 && leftRoom > rightRoom) side = "left";
  const width = Math.min(preferredWidth, side === "left" ? leftRoom : rightRoom);
  const left = side === "left" ? bounds.left - gap - width : bounds.right + gap;
  return { side, left: clamp(left, edge, viewportWidth - width - edge), width };
}

/** Measures only floating surfaces; never changes a page's seat or width. */
export function companionFloatingPlacement({ role, controls = [], viewport, headHeight, headWidth: preferredWidth = 340, hasPapers = false, paperWidth: preferredPaperWidth = 360, paperHeight }: {
  role: Rect; controls?: readonly Rect[]; viewport: { width: number; height: number }; headHeight: number; headWidth?: number; hasPapers?: boolean; paperWidth?: number; paperHeight?: number;
}): CompanionFloatingPlacement {
  const bounds = interactionBounds(role, controls);
  const edge = 14;
  const ceiling = Math.min(58, viewport.height * .15);
  const gap = 16;
  const availableLeft = Math.max(0, bounds.left - edge - gap);
  const availableRight = Math.max(0, viewport.width - bounds.right - edge - gap);
  let side: "left" | "right" = (role.left + role.right) / 2 >= viewport.width / 2 ? "left" : "right";
  // A dragged role may sit at the centre. Use the other side only when the chosen
  // side cannot hold a readable paper and the other side actually can.
  if (side === "left" && availableLeft < 220 && availableRight > availableLeft + 80) side = "right";
  if (side === "right" && availableRight < 220 && availableLeft > availableRight + 80) side = "left";
  const available = side === "left" ? availableLeft : availableRight;
  const headWidth = Math.min(preferredWidth, viewport.width - edge * 2);
  let height = Math.min(Math.max(0, headHeight), viewport.height - ceiling - edge);
  if (hasPapers && viewport.height < 550) height = Math.min(height, (viewport.height - ceiling - edge - gap) * .5);
  const above = bounds.top - gap - height >= ceiling;
  let head = above
    ? rect(clamp((role.left + role.right - headWidth) / 2, edge, viewport.width - headWidth - edge), bounds.top - gap - height, headWidth, height)
    : rect(side === "left" ? Math.max(edge, bounds.left - gap - Math.min(headWidth, available)) : bounds.right + gap,
      clamp(role.top, ceiling, viewport.height - height - edge), Math.min(headWidth, Math.max(180, available)), height);
  if (available < 180) {
    const aboveSpace = Math.max(0, bounds.top - gap - ceiling);
    const belowSpace = Math.max(0, viewport.height - edge - bounds.bottom - gap);
    height = Math.min(height, Math.max(aboveSpace, belowSpace));
    if (hasPapers && Math.min(aboveSpace, belowSpace) < 100) {
      // A narrow side corridor needs a shared vertical stack. Reserve readable
      // paper space before sizing the reply, rather than leaving a zero-height
      // paper after the reply has consumed the entire corridor.
      height = Math.min(height, Math.max(0, Math.max(aboveSpace, belowSpace) - gap - 100));
    }
    head = rect(clamp((role.left + role.right - headWidth) / 2, edge, viewport.width - headWidth - edge),
      aboveSpace >= belowSpace ? bounds.top - gap - height : bounds.bottom + gap, headWidth, height);
  }
  const paperWidth = Math.min(preferredPaperWidth, available >= 180 ? available : viewport.width - edge * 2);
  let paperLeft = side === "left" ? Math.max(edge, bounds.left - gap - paperWidth) : Math.min(bounds.right + gap, viewport.width - paperWidth - edge);
  let paperTop = ceiling;
  let paperBottom = viewport.height - edge;
  const horizontalCollision = paperLeft < head.right + gap && paperLeft + paperWidth > head.left - gap;
  if (hasPapers && height > 0 && horizontalCollision) {
    const shiftedLeft = side === "left" ? head.left - gap - paperWidth : head.right + gap;
    if (shiftedLeft >= edge && shiftedLeft + paperWidth <= viewport.width - edge) paperLeft = shiftedLeft;
    else {
      // In a short window both surfaces share one side corridor. Reserve a
      // readable paper by stacking within that corridor, without moving the
      // role or changing the page beneath it.
      if (!above && available >= 180 && Math.max(head.top - gap - ceiling, viewport.height - edge - head.bottom - gap) < 140) {
        head = rect(head.left, viewport.height - edge - head.height, head.width, head.height);
      }
      const aboveSpace = head.top - gap - ceiling;
      const belowTop = head.bottom + gap;
      const belowSpace = viewport.height - edge - belowTop;
      if (aboveSpace >= belowSpace) paperBottom = head.top - gap;
      else paperTop = belowTop;
    }
  }
  // If there is no useful side corridor, put papers above the role. The page
  // remains underneath and keeps its scroll position and exact dimensions.
  if (available < 180) {
    paperLeft = clamp((role.left + role.right - paperWidth) / 2, edge, viewport.width - paperWidth - edge);
    const corridors = [
      { top: ceiling, bottom: Math.max(ceiling, bounds.top - gap) },
      { top: Math.min(viewport.height - edge, bounds.bottom + gap), bottom: viewport.height - edge },
    ].flatMap(corridor => {
      if (head.height === 0 || head.bottom <= corridor.top || head.top >= corridor.bottom) return [corridor];
      return [{ top: corridor.top, bottom: Math.max(corridor.top, head.top - gap) },
        { top: Math.min(corridor.bottom, head.bottom + gap), bottom: corridor.bottom }];
    }).sort((a, b) => (b.bottom - b.top) - (a.bottom - a.top));
    paperTop = corridors[0].top;
    paperBottom = corridors[0].bottom;
  }
  const headDock = head.bottom <= role.top ? "above" : head.top >= role.bottom ? "below"
    : head.right <= role.left ? "left" : "right";
  // Short receipts sit near the companion within the already safe corridor.
  // Long decisions retain that corridor's full scroll budget.
  if (paperHeight !== undefined && paperHeight > 0) {
    const shownHeight = Math.min(paperHeight, Math.max(0, paperBottom - paperTop));
    paperTop = clamp(bounds.top - gap - shownHeight, paperTop, paperBottom - shownHeight);
  }
  return { side, headDock, head, papers: rect(paperLeft, paperTop, paperWidth, Math.max(0, paperBottom - paperTop)) };
}
