// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CompanionTypewriterState, useCompanionTypewriter } from "../companion-typewriter";
import { renderCompanionStreamingMarkdown } from "../companion-markdown-reveal";
import { prepareCompanionTypewriter, resetCompanionTypewriters } from "../../../../app/companion-session/companion-typewriter-state";
import { useRoomStore } from "../../../../app/home/room-store";
import { stableCompanionMarkdownPrefix } from "../../../../app/companion-session/companion-markdown-boundary";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  useRoomStore.setState({ reducedMotion: false, motionMode: "full" });
});
afterEach(() => { cleanup(); resetCompanionTypewriters(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("does not dump a large network burst or split a family emoji", () => {
  const state = new CompanionTypewriterState();
  state.setTarget("👨‍👩‍👧‍👦" + "星".repeat(5000));
  state.advance(32);
  expect(state.visible).toBe("👨‍👩‍👧‍👦");
  state.advance(2000);
  expect(Array.from(new Intl.Segmenter().segment(state.visible))).toHaveLength(2);
});

it("paces Chinese at about 37 glyphs and English at 110 characters per second", () => {
  const chinese = new CompanionTypewriterState(); chinese.setTarget("星".repeat(500));
  const latin = new CompanionTypewriterState(); latin.setTarget("a".repeat(500));
  for (let index = 0; index < 100; index++) { chinese.advance(10); latin.advance(10); }
  expect(chinese.visible.length).toBeGreaterThanOrEqual(36);
  expect(chinese.visible.length).toBeLessThanOrEqual(37);
  expect(latin.visible.length).toBeGreaterThanOrEqual(109);
  expect(latin.visible.length).toBeLessThanOrEqual(110);
});

it("keeps the same cursor after the server publishes its final message", () => {
  const text = "这段话在服务端完成之后，仍会沿同一个打字游标逐字显示，而不是一次跳到结尾。";
  const view = renderHook(({ live }) => useCompanionTypewriter(text, live), { initialProps: { live: true } });
  act(() => vi.advanceTimersByTime(96));
  const before = view.result.current.text;
  expect(before.length).toBeGreaterThan(0);
  expect(before.length).toBeLessThan(text.length);
  view.rerender({ live: false });
  expect(view.result.current.text).toBe(before);
  expect(view.result.current.busy).toBe(true);
  act(() => vi.advanceTimersByTime(2000));
  expect(view.result.current).toEqual({ text, busy: false });
});

it("pauses while hidden and resumes without catching up in one frame", () => {
  const view = renderHook(() => useCompanionTypewriter("星".repeat(500), true));
  act(() => vi.advanceTimersByTime(32));
  const before = view.result.current.text.length;
  vi.mocked(Object.getOwnPropertyDescriptor(document, "hidden")!.get!).mockReturnValue(true);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  act(() => vi.advanceTimersByTime(10_000));
  expect(view.result.current.text.length).toBe(before);
  vi.mocked(Object.getOwnPropertyDescriptor(document, "hidden")!.get!).mockReturnValue(false);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  act(() => vi.advanceTimersByTime(16));
  expect(view.result.current.text.length - before).toBeLessThanOrEqual(2);
});

it("shows completed history immediately and respects reduced motion", () => {
  const history = renderHook(() => useCompanionTypewriter("历史正文", false));
  expect(history.result.current).toEqual({ text: "历史正文", busy: false });
  useRoomStore.setState({ reducedMotion: true });
  const live = renderHook(() => useCompanionTypewriter("实时正文", true));
  expect(live.result.current).toEqual({ text: "实时正文", busy: false });
});

it("reveals formatted glyphs without printing Markdown delimiters", () => {
  const source = "## 标题\n\n**重点内容**，正文。\n\n下一段。";
  const view = render(<>{renderCompanionStreamingMarkdown(source, "## 标题\n\n**重点")}</>);
  expect(view.container.querySelector("strong")?.textContent).toBe("重点");
  expect(view.container.textContent).not.toContain("**");
  expect(view.container.textContent).not.toContain("下一段");
  view.rerender(<>{renderCompanionStreamingMarkdown(source, source)}</>);
  expect(view.container.textContent).toContain("下一段");
});

it("types a published-only response and retains its cursor when the view reopens", () => {
  const identity = "conversation:published-only";
  prepareCompanionTypewriter(identity);
  const text = "这条回复没有任何增量，只收到正式消息，也必须逐字显示。";
  const first = renderHook(() => useCompanionTypewriter(text, false, identity));
  expect(first.result.current.text).toBe("");
  act(() => vi.advanceTimersByTime(64));
  const prefix = first.result.current.text;
  expect(prefix.length).toBeGreaterThan(0);
  expect(prefix.length).toBeLessThan(text.length);
  first.unmount();
  const reopened = renderHook(() => useCompanionTypewriter(text, false, identity));
  expect(reopened.result.current.text).toBe(prefix);
  act(() => vi.advanceTimersByTime(1000));
  expect(reopened.result.current.text).toBe(text);
});

it.each([
  ["正文 **未闭合", "正文 "], ["正文 **完整**。", "正文 **完整**。"],
  ["`inline", ""], ["## ", ""], ["```swi", ""],
  ["```swift\nlet value = 1", "```swift\nlet value = 1"],
  ["| 名称 | 数量 |\n| --- |", ""],
  ["| 名称 | 数量 |\n| --- | --- |\n| 下一", "| 名称 | 数量 |\n| --- | --- |\n"],
  ["[原文](https://example", ""], ["[原文](https://example.invalid)", "[原文](https://example.invalid)"],
  ["2 * 3 = 6", "2 * 3 = 6"],
])("waits for stable Markdown syntax: %s", (source, expected) => {
  expect(stableCompanionMarkdownPrefix(source)).toBe(expected);
});

it("resumes typing a newly closed span and a final literal without accrued waiting credit", () => {
  const state = new CompanionTypewriterState();
  state.setTarget("正文 **等待闭合", false);
  for (let i = 0; i < 200; i++) state.advance(16);
  expect(state.visible).toBe("正文 "); expect(state.busy).toBe(true); expect(state.canAdvance).toBe(false);
  state.setTarget("正文 **等待闭合**，后文。", false); state.advance(16);
  expect(state.visible.length - "正文 ".length).toBeLessThanOrEqual(2);
  while (state.canAdvance) state.advance(16);
  state.setTarget(state.target + "未闭合 `内容", false);
  while (state.canAdvance) state.advance(16);
  const prefix = state.visible;
  state.setTarget(state.target, true);
  expect(state.visible).toBe(prefix); expect(state.canAdvance).toBe(true);
});
