// @vitest-environment jsdom
import { expect, it } from "vitest";
import { guideOverlap, guideWindowMask, placeGuideChapter } from "../guide-layout";

it("places the chapter beside either companion seat and keeps compact windows in bounds", () => {
  const viewport = { width: 1440, height: 810 };
  for (const companion of [{ left: 760, top: 350, width: 300, height: 320 }, { left: 80, top: 350, width: 300, height: 320 }]) {
    const chapter = { ...placeGuideChapter(viewport, companion), top: 98, height: 686 };
    expect(guideOverlap(chapter, companion)).toBe(0);
    expect(chapter.left + chapter.width).toBeLessThanOrEqual(1412);
  }
  for (const width of [380, 760, 960]) {
    const chapter = placeGuideChapter({ width, height: 540 }, null);
    expect(chapter.left).toBeGreaterThanOrEqual(18);
    expect(chapter.left + chapter.width).toBeLessThanOrEqual(width - 28);
  }
});

it("keeps the full resident clear in the window-wide movie scrim", () => {
  const mask = guideWindowMask({ width: 1440, height: 810 }, { left: 1110, top: 470, width: 290, height: 320 }, null);
  const svg = decodeURIComponent(mask);
  expect(svg).toContain('width="100%" height="100%"');
  expect(svg).toContain('x="1092" y="452" width="326" height="356"');
});
