// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCompanionHistoryScroll } from "../use-companion-history-scroll";
import { interactionSession } from "./companion-interaction-fixtures";

const loadOlder = vi.fn(async () => undefined);
let notifyResize: () => void;
function Harness({ searching = false }: { searching?: boolean }) {
  const [recordOpen, setRecordOpen] = useState(searching);
  const chat = interactionSession({ historyHasMore: true, loadOlderMessages: loadOlder,
    messages: [{ id: "older", createdAt: "2026-09-29T07:00:00Z" }] as never });
  const scroll = useCompanionHistoryScroll({ chat, open: true, mounted: true, recordOpen });
  return <>
    <button onClick={() => { scroll.pendingJumpRef.current = { messageId: "older" }; setRecordOpen(false); }}>定位旧消息</button>
    <output>{scroll.atLatest ? "最新" : "正在看历史"}</output>
    <div data-testid="list" ref={scroll.listRef} onScroll={scroll.handleListScroll} onWheel={scroll.handleListWheel}>
      <div ref={scroll.contentRef}><article data-message-id="older">已存在的旧消息</article></div>
    </div>
  </>;
}
beforeEach(() => {
  vi.useFakeTimers();
  loadOlder.mockClear();
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { notifyResize = callback; } observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(2000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return { top: this.tagName === "ARTICLE" ? -700 : 100, height: this.tagName === "ARTICLE" ? 100 : 400 } as DOMRect;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("keeps a search hit in view despite a queued follow frame and transition scroll event", async () => {
  render(<Harness searching />);
  act(() => vi.advanceTimersByTime(20));
  const list = screen.getByTestId("list");
  list.scrollTop = 1600;
  act(() => notifyResize());
  fireEvent.click(screen.getByText("定位旧消息"));
  fireEvent.scroll(list);
  await act(async () => { vi.advanceTimersByTime(50); await Promise.resolve(); });
  expect(list.querySelector('[data-message-id="older"]')).toBeTruthy();
  expect(list.scrollTop).toBe(650);
  expect(screen.getByText("正在看历史")).toBeTruthy();
});

it("follows new geometry until the user scrolls up, including a frame already queued", () => {
  render(<Harness />);
  act(() => vi.advanceTimersByTime(20));
  const list = screen.getByTestId("list");
  list.scrollTop = 100;
  act(() => { notifyResize(); vi.advanceTimersByTime(20); });
  expect(list.scrollTop).toBe(2000);
  list.scrollTop = 100;
  act(() => notifyResize());
  fireEvent.wheel(list, { deltaY: -40 });
  act(() => vi.advanceTimersByTime(20));
  expect(list.scrollTop).toBe(100);
});

it("keeps a task or search record at its heading when geometry changes", () => {
  render(<Harness searching />);
  const list = screen.getByTestId("list");
  expect(list.scrollTop).toBe(0);
  act(() => { notifyResize(); vi.advanceTimersByTime(40); });
  expect(list.scrollTop).toBe(0);
});

it("loads older conversation pages only while browsing the conversation", () => {
  const view = render(<Harness searching />);
  const list = screen.getByTestId("list");
  list.scrollTop = 0;
  fireEvent.scroll(list);
  expect(loadOlder).not.toHaveBeenCalled();
  view.unmount();
  render(<Harness />);
  fireEvent.scroll(screen.getByTestId("list"));
  expect(loadOlder).toHaveBeenCalledOnce();
});
