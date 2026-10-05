// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { guideOverlap, guidePointerPath, placeGuidePointer } from "../guide-layout";
import { findGuideAnchor } from "../use-guide-anchor";

afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });
it("keeps the real entrance cue clear of the narration and resident at the reported crowded position", () => {
  const viewport = { width: 1440, height: 810 };
  const anchor = { left: 1230, top: 540, width: 130, height: 60 };
  const obstacles = [{ left: 1110, top: 430, width: 310, height: 235 }, { left: 850, top: 420, width: 240, height: 290 }, { left: 104, top: 687, width: 690, height: 97 }];
  const placed = placeGuidePointer(viewport, anchor, { width: 220, height: 80 }, obstacles);
  expect(obstacles.every(box => guideOverlap(placed, box) === 0)).toBe(true);
  expect(guideOverlap(placed, anchor)).toBe(0);
  expect(placed.left).toBeGreaterThanOrEqual(14);
  expect(placed.left + placed.width).toBeLessThanOrEqual(viewport.width - 14);
  expect(placed.top + placed.height).toBeLessThanOrEqual(viewport.height - 14);
  const end = guidePointerPath(placed, anchor).split(" ").slice(-2).map(Number);
  expect(end[0]).toBeGreaterThanOrEqual(anchor.left);
  expect(end[0]).toBeLessThanOrEqual(anchor.left + anchor.width);
  expect(end[1]).toBeGreaterThanOrEqual(anchor.top);
  expect(end[1]).toBeLessThanOrEqual(anchor.top + anchor.height);
});
it("does not mistake an invisible task tab for an available entrance", () => {
  document.body.innerHTML = '<button id="task" style="opacity:0">任务</button><button id="notes">笔记</button>';
  const task = document.querySelector<HTMLElement>("#task")!, notes = document.querySelector<HTMLElement>("#notes")!;
  for (const element of [task, notes]) {
    vi.spyOn(element, "getClientRects").mockReturnValue([new DOMRect(20, 100, 48, 48)] as unknown as DOMRectList);
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue(new DOMRect(20, 100, 48, 48));
  }
  expect(findGuideAnchor("#task, #notes")?.element).toBe(notes);
  task.style.opacity = "1";
  task.setAttribute("inert", "");
  expect(findGuideAnchor("#task, #notes")?.element).toBe(notes);
});
it("finds room above the route when a large reading sheet occupies the area beside the entrance", () => {
  const anchor = { left: 22, top: 188, width: 57, height: 57 };
  const obstacles = [{ left: 104, top: 90, width: 1288, height: 75 }, { left: 104, top: 168, width: 450, height: 74 }, { left: 140, top: 309, width: 676, height: 300 }, { left: 104, top: 690, width: 850, height: 95 }, { left: 1120, top: 420, width: 302, height: 183 }];
  const placed = placeGuidePointer({ width: 1440, height: 810 }, anchor, { width: 220, height: 80 }, obstacles);
  expect(obstacles.every(box => guideOverlap(placed, box) === 0)).toBe(true);
  expect(guideOverlap(placed, anchor)).toBe(0);
});
it("honors the meaning of ordered selectors and skips an entrance behind an actual panel", () => {
  document.body.innerHTML = '<button id="secondary">备用</button><button id="preferred">入口</button><aside id="panel">纸页</aside>';
  const preferred = document.querySelector<HTMLElement>("#preferred")!, secondary = document.querySelector<HTMLElement>("#secondary")!, panel = document.querySelector<HTMLElement>("#panel")!;
  for (const element of [preferred, secondary]) {
    vi.spyOn(element, "getClientRects").mockReturnValue([new DOMRect(20, 100, 48, 48)] as unknown as DOMRectList);
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue(new DOMRect(element === preferred ? 20 : 100, 100, 48, 48));
  }
  expect(findGuideAnchor("#preferred, #secondary")?.element).toBe(preferred);
  Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: (x: number) => x < 100 ? [panel, preferred] : [secondary] });
  expect(findGuideAnchor("#preferred, #secondary")?.element).toBe(secondary);
  delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
});
