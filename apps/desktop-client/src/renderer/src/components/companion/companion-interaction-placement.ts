import type { Rect } from "./companion-home-placement";

export interface CompanionFloatingPlacement {
  side: "left" | "right";
  headDock: "above" | "left" | "right" | "below";
  head: Rect & { width: number; height: number };
  papers: Rect & { width: number; height: number };
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, Math.max(low, high)));
const rect = (left: number, top: number, width: number, height: number): Rect & { width: number; height: number } => ({ left, top, width, height, right: left + width, bottom: top + height });

/** Keeps the conversation book beside the protected head; tails may sit beneath it. */
export function companionHistoryPlacement(role: Rect, viewportWidth: number, preferredWidth = 760) {
  const edge = 18;
  const gap = 16;
  const leftRoom = Math.max(0, role.left - gap - edge);
  const rightRoom = Math.max(0, viewportWidth - role.right - gap - edge);
  let side: "left" | "right" = (role.left + role.right) / 2 >= viewportWidth / 2 ? "left" : "right";
  if (side === "left" && leftRoom < 300 && rightRoom > leftRoom) side = "right";
  if (side === "right" && rightRoom < 300 && leftRoom > rightRoom) side = "left";
  const width = Math.min(preferredWidth, side === "left" ? leftRoom : rightRoom);
  const left = side === "left" ? role.left - gap - width : role.right + gap;
  return { side, left: clamp(left, edge, viewportWidth - width - edge), width };
}

/** Measures only floating surfaces; never changes a page's seat or width. */
export function companionFloatingPlacement({ role, viewport, headHeight, headWidth: preferredWidth = 340, hasPapers = false, paperWidth: preferredPaperWidth = 360 }: {
  role: Rect; viewport: { width: number; height: number }; headHeight: number; headWidth?: number; hasPapers?: boolean; paperWidth?: number;
}): CompanionFloatingPlacement {
  const edge = 14;
  const ceiling = Math.min(58, viewport.height * .15);
  const gap = 16;
  const availableLeft = Math.max(0, role.left - edge - gap);
  const availableRight = Math.max(0, viewport.width - role.right - edge - gap);
  let side: "left" | "right" = (role.left + role.right) / 2 >= viewport.width / 2 ? "left" : "right";
  // A dragged role may sit at the centre. Use the other side only when the chosen
  // side cannot hold a readable paper and the other side actually can.
  if (side === "left" && availableLeft < 220 && availableRight > availableLeft + 80) side = "right";
  if (side === "right" && availableRight < 220 && availableLeft > availableRight + 80) side = "left";
  const available = side === "left" ? availableLeft : availableRight;
  const headWidth = Math.min(preferredWidth, viewport.width - edge * 2);
  let height = Math.min(Math.max(0, headHeight), viewport.height - ceiling - edge);
  if (hasPapers && viewport.height < 550) height = Math.min(height, (viewport.height - ceiling - edge - gap) * .5);
  const above = role.top - gap - height >= ceiling;
  let head = above
    ? rect(clamp((role.left + role.right - headWidth) / 2, edge, viewport.width - headWidth - edge), role.top - gap - height, headWidth, height)
    : rect(side === "left" ? Math.max(edge, role.left - gap - Math.min(headWidth, available)) : role.right + gap,
      clamp(role.top, ceiling, viewport.height - height - edge), Math.min(headWidth, Math.max(180, available)), height);
  if (available < 180) {
    const aboveSpace = Math.max(0, role.top - gap - ceiling);
    const belowSpace = Math.max(0, viewport.height - edge - role.bottom - gap);
    height = Math.min(height, Math.max(aboveSpace, belowSpace));
    if (hasPapers && Math.min(aboveSpace, belowSpace) < 100) {
      // A narrow side corridor needs a shared vertical stack. Reserve readable
      // paper space before sizing the reply, rather than leaving a zero-height
      // paper after the reply has consumed the entire corridor.
      height = Math.min(height, Math.max(0, Math.max(aboveSpace, belowSpace) - gap - 100));
    }
    head = rect(clamp((role.left + role.right - headWidth) / 2, edge, viewport.width - headWidth - edge),
      aboveSpace >= belowSpace ? role.top - gap - height : role.bottom + gap, headWidth, height);
  }
  const paperWidth = Math.min(preferredPaperWidth, available >= 180 ? available : viewport.width - edge * 2);
  let paperLeft = side === "left" ? Math.max(edge, role.left - gap - paperWidth) : Math.min(role.right + gap, viewport.width - paperWidth - edge);
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
      { top: ceiling, bottom: Math.max(ceiling, role.top - gap) },
      { top: Math.min(viewport.height - edge, role.bottom + gap), bottom: viewport.height - edge },
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
  return { side, headDock, head, papers: rect(paperLeft, paperTop, paperWidth, Math.max(0, paperBottom - paperTop)) };
}
