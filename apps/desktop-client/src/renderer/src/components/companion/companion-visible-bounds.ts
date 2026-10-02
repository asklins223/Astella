import type { Rect } from "./companion-home-placement";

/** The driver publishes a fixed model shape; the outer shell owns seat position and size. */
export function companionLayoutBounds(element: HTMLElement, region: "ink" | "head" = "ink"): Rect {
  // The inner character layer may lift, rotate or squash. Those poses must
  // never move the controls, papers, bubbles or the task's reserved seat.
  const box = (element.closest<HTMLElement>(".companion-visual-shell") ?? element).getBoundingClientRect();
  const style = getComputedStyle(element);
  const fraction = (edge: string, fallback: number) => {
    const value = Number.parseFloat(style.getPropertyValue(`--companion-model-${region}-${edge}`)
      || style.getPropertyValue(`--companion-model-ink-${edge}`));
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
  };
  return {
    left: box.left + box.width * fraction("left", 0),
    right: box.left + box.width * fraction("right", 1),
    top: box.top + box.height * fraction("top", 0),
    bottom: box.top + box.height * fraction("bottom", 1),
  };
}

export function companionControlsBounds(role: Rect, viewport: { width: number; height: number }, size: { width: number; height: number }, verticalRole = role) {
  const side = (role.left + role.right) / 2 >= viewport.width / 2 ? "left" : "right";
  const left = side === "left" ? role.left - 8 - size.width : role.right + 8;
  const center = Math.max(12 + size.height / 2, Math.min(viewport.height - 12 - size.height / 2,
    verticalRole.top + (verticalRole.bottom - verticalRole.top) * .52));
  return { side, left, right: left + size.width, top: center - size.height / 2, bottom: center + size.height / 2 } as const;
}

export interface Live2DDrawableBox { x: number; y: number; width: number; height: number }

/** Cubism's part ancestry identifies hair meshes without guessing a face width. */
export interface Live2DPartHierarchy {
  parts: { ids: readonly string[]; parentIndices: ArrayLike<number> };
  drawables: { parentPartIndices: ArrayLike<number> };
}

export function live2DHeadDrawableIndices(model: Live2DPartHierarchy | undefined, headPartIds: readonly string[]): ReadonlySet<number> {
  const indices = new Set<number>();
  if (!model || !headPartIds.length) return indices;
  const headParts = new Set(headPartIds);
  for (let drawable = 0; drawable < model.drawables.parentPartIndices.length; drawable += 1) {
    let part = model.drawables.parentPartIndices[drawable];
    // The limit also makes malformed ancestry safe to read.
    for (let depth = 0; part >= 0 && part < model.parts.ids.length && depth < model.parts.ids.length; depth += 1) {
      if (headParts.has(model.parts.ids[part])) { indices.add(drawable); break; }
      part = model.parts.parentIndices[part];
    }
  }
  return indices;
}

/** pixi-live2d's getDrawableBounds is already in canvas pixels, with y pointing down. */
export function projectVisibleLive2DBounds(drawables: readonly Live2DDrawableBox[], model: {
  width: number; height: number; scale: number; x: number; y: number;
}, canvas: { width: number; height: number }): Rect | null {
  if (!drawables.length) return null;
  const offsetX = model.x - model.width * model.scale / 2;
  const offsetY = model.y - model.height * model.scale / 2;
  const clip = (value: number, max: number) => Math.max(0, Math.min(max, value));
  const left = clip(Math.min(...drawables.map(box => box.x)) * model.scale + offsetX, canvas.width);
  const right = clip(Math.max(...drawables.map(box => box.x + box.width)) * model.scale + offsetX, canvas.width);
  const top = clip(Math.min(...drawables.map(box => box.y)) * model.scale + offsetY, canvas.height);
  const bottom = clip(Math.max(...drawables.map(box => box.y + box.height)) * model.scale + offsetY, canvas.height);
  return left < right && top < bottom ? { left, right, top, bottom } : null;
}
