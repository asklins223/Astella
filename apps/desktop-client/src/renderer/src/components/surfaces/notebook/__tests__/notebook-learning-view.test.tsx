// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useNotebookLearningView } from "../use-notebook-learning-view";

afterEach(() => { cleanup(); document.body.innerHTML = ""; });
function fixture() {
  const scrollRef = createRef<HTMLDivElement>();
  const scroller = document.createElement("div"); scrollRef.current = scroller;
  scroller.innerHTML = '<div id="notebook-reading-leaf">' + Array.from({ length: 8 }, (_, i) => `<p data-block-ordinal="${i}">段落 ${i}</p>`).join("") + "</div>";
  document.body.append(scroller);
  scroller.getBoundingClientRect = () => ({ top: 200, bottom: 800 } as DOMRect);
  [...scroller.querySelectorAll<HTMLElement>("p")].forEach((node, i) => { node.getBoundingClientRect = () => ({ top: 200 + i * 100 - scroller.scrollTop, bottom: 280 + i * 100 - scroller.scrollTop } as DOMRect); });
  const initial = { noteId: "note", leaf: "reading", recallVisit: 0, scrollRef, inReading: true };
  const view = renderHook(input => useNotebookLearningView(input), { initialProps: initial });
  return { ...view, scroller, initial };
}

it("从正文中途进任务先从任务开头开始，返回正文接回同一段的同一位置", () => {
  const view = fixture(); view.scroller.scrollTop = 350;
  act(() => view.result.current.setLearningView("overview")); expect(view.scroller.scrollTop).toBe(0);
  view.scroller.scrollTop = 40;
  act(() => view.result.current.setLearningView("body")); expect(view.scroller.scrollTop).toBe(350);
  act(() => view.result.current.setLearningView("overview")); expect(view.scroller.scrollTop).toBe(40);
});

it("回执或线索变化不重置页面；明确再开一次回想才回到题目顶部", () => {
  const view = fixture(); act(() => view.result.current.setLearningView("recall"));
  view.scroller.scrollTop = 260;
  view.rerender({ ...view.initial }); expect(view.scroller.scrollTop).toBe(260);
  view.rerender({ ...view.initial, recallVisit: 1 }); expect(view.scroller.scrollTop).toBe(0);
});

it("草稿与记录各自记位置，返回后不会互相借用滚动；换笔记清掉旧定位", () => {
  const view = fixture(); view.scroller.scrollTop = 120;
  act(() => view.result.current.rememberReadingPosition());
  view.rerender({ ...view.initial, leaf: "expansion", inReading: false }); expect(view.scroller.scrollTop).toBe(0);
  view.scroller.scrollTop = 210; act(() => view.result.current.rememberReadingPosition());
  view.rerender({ ...view.initial, leaf: "history", inReading: false }); expect(view.scroller.scrollTop).toBe(0);
  view.scroller.scrollTop = 80; act(() => view.result.current.rememberReadingPosition());
  view.rerender({ ...view.initial, leaf: "expansion", inReading: false }); expect(view.scroller.scrollTop).toBe(210);
  view.rerender({ ...view.initial, noteId: "another" }); expect(view.scroller.scrollTop).toBe(0);
});
