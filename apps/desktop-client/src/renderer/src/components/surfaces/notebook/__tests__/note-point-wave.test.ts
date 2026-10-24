// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNotePointWave } from "../document/note-point-wave";

afterEach(() => { document.body.replaceChildren(); document.documentElement.classList.remove("reduce-motion"); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function scene() {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const range = document.createElement("div"); range.className = "note-ai-work-range is-offscreen";
  const canvas = document.createElement("canvas"); range.append(canvas); document.body.append(range);
  const context = { clearRect: vi.fn(), setTransform: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), arc: vi.fn(), fill: vi.fn(), fillStyle: "", globalAlpha: 1 };
  Object.defineProperty(canvas, "getContext", { value: () => context });
  return { range, canvas, context, wave: createNotePointWave(canvas, "one-selected-passage") };
}
describe("不规则点阵波浪", () => {
  it("长选区只分配可见条带，光点没有按整齐的列对齐", () => {
    vi.useFakeTimers(); const { canvas, context, wave } = scene();
    wave.resize({ width: 360, height: 20000, top: 18000, visibleHeight: 600 });
    expect(canvas.height).toBeLessThanOrEqual(900); expect(canvas.style.top).toBe("18000px");
    const positions = context.arc.mock.calls.map(args => args[0] as number);
    expect(new Set(positions.map(value => Math.round(value * 10))).size).toBeGreaterThan(300);
    expect(positions.length).toBeLessThan(6000);
    const ys = context.arc.mock.calls.map(args => args[1] as number);
    expect(Math.min(...positions)).toBeLessThan(16); expect(Math.max(...positions)).toBeGreaterThan(344);
    expect(Math.min(...ys)).toBeLessThan(16); expect(Math.max(...ys)).toBeGreaterThan(584);
    wave.destroy(); expect(canvas.height).toBe(1);
  });
  it("可见时持续起伏，减少动态和销毁都会停止后续帧", async () => {
    vi.useFakeTimers(); const { range, context, wave } = scene();
    wave.resize({ width: 360, height: 1500, top: 0, visibleHeight: 600 });
    const offscreen = context.clearRect.mock.calls.length;
    vi.advanceTimersByTime(120); expect(context.clearRect).toHaveBeenCalledTimes(offscreen);
    range.classList.remove("is-offscreen"); await Promise.resolve();
    vi.advanceTimersByTime(160); expect(context.clearRect.mock.calls.length).toBeGreaterThan(offscreen + 1);
    document.documentElement.classList.add("reduce-motion"); await Promise.resolve();
    const reduced = context.clearRect.mock.calls.length;
    vi.advanceTimersByTime(200); expect(context.clearRect).toHaveBeenCalledTimes(reduced);
    wave.destroy(); vi.advanceTimersByTime(200); expect(context.clearRect).toHaveBeenCalledTimes(reduced);
  });
});
