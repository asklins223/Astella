// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { groupNoteAiRanges, resolveNoteAiRanges } from "../../../companion/content/note-companion-editing";
import { createNoteWorkingLayer } from "../document/note-ai-working-layer";
afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); });
describe("一整段工作范围", () => {
  it("合并重叠工具范围，跨三段保留一个范围，独立请求不串起来", () => {
    const resolved = resolveNoteAiRanges([
      { startBlock: 0, endBlock: 2, label: "改写", expectedBlocks: ["甲", "乙", "丙"] },
      { startBlock: 1, endBlock: 1, label: "写入" }, { startBlock: 3, endBlock: 3, label: "另外一段" },
    ], ["甲", "乙", "丙", "丁"].map(content => ({ content })));
    expect(groupNoteAiRanges(resolved).map(({ startBlock, endBlock }) => [startBlock, endBlock])).toEqual([[0, 2], [3, 3]]);
  });
  it("三段共享一片波面；尺寸更新不重建波面，释放后清空图层", () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const host = document.createElement("div"); document.body.append(host);
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 20, 400, 700));
    const elements = [0, 1, 2].map(index => {
      const element = document.createElement("p"); host.append(element);
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue(new DOMRect(20, 40 + index * 100, 360, 80)); return element;
    });
    let active = true;
    const layer = createNoteWorkingLayer(host, () => active ? [{ id: "selection", label: "正在改写", elements }] : []);
    vi.advanceTimersByTime(32);
    const range = host.querySelector<HTMLElement>(".note-ai-work-range")!;
    expect(host.querySelectorAll(".note-ai-work-cloud")).toHaveLength(1);
    expect(range.style.height).toBe("292px");
    layer.update(); vi.advanceTimersByTime(32); expect(host.querySelector(".note-ai-work-range")).toBe(range);
    active = false; layer.update(); vi.advanceTimersByTime(32); expect(host.querySelector(".note-ai-work-range")).toBeNull();
    layer.destroy(); expect(host.querySelector(".note-ai-work-layer")).toBeNull();
  });
});
