// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { playLearningCardReward } from "../learning-card-motion";
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; });
it("cancels every paper particle on exit/replay and preserves the final score", () => {
  document.body.innerHTML = '<section><div class="lc-celebration-effects"></div><strong data-award-score>67</strong></section>';
  const root = document.querySelector("section")!, animations: Array<{ cancel: ReturnType<typeof vi.fn> }> = [];
  const animate = vi.fn((frames: Keyframe[]) => {
    for (const frame of frames) for (const property of Object.keys(frame)) expect(["transform", "opacity", "offset"]).toContain(property);
    const animation = { cancel: vi.fn() }; animations.push(animation); return animation as unknown as Animation;
  });
  HTMLElement.prototype.animate = animate;
  const stop = playLearningCardReward(root, 67, false);
  expect(animations).toHaveLength(102); expect(root.querySelectorAll("i")).toHaveLength(102);
  stop(); expect(animations.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(true);
  expect(root.querySelectorAll("i")).toHaveLength(0); expect(root.querySelector("strong")!.textContent).toBe("67");
  const finish = playLearningCardReward(root, 67, true); expect(animations).toHaveLength(102); finish();
});
