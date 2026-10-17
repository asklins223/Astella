import type { Input, WebContents } from "electron";

const ZOOM_STEPS = [.5, .67, .8, .9, 1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;
type ZoomInput = Pick<Input, "type" | "key" | "control" | "meta" | "alt" | "isComposing">;

/** Native zoom shortcuts remain available when the room hides the application menu. */
export function zoomShortcutFactor(current: number, input: ZoomInput, platform: NodeJS.Platform): number | null {
  if (input.type !== "keyDown" || input.alt || input.isComposing || !(platform === "darwin" ? input.meta : input.control)) return null;
  if (input.key === "0") return 1;
  if (input.key === "+" || input.key === "=") return ZOOM_STEPS.find(step => step > current + .001) ?? ZOOM_STEPS.at(-1)!;
  if (input.key === "-") return [...ZOOM_STEPS].reverse().find(step => step < current - .001) ?? ZOOM_STEPS[0];
  return null;
}

export function installWindowZoomShortcuts(contents: WebContents, platform: NodeJS.Platform): void {
  contents.on("before-input-event", (event, input) => {
    const factor = zoomShortcutFactor(contents.getZoomFactor(), input, platform);
    if (factor === null) return;
    event.preventDefault();
    contents.setZoomFactor(factor);
  });
}
