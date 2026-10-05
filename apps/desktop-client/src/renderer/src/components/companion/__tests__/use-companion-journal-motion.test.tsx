// @vitest-environment jsdom
import { StrictMode, useRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRoomStore } from "../../../app/room-store";
import { useCompanionJournalMotion } from "../use-companion-journal-motion";

let now = 0, id = 0;
const frames = new Map<number, FrameRequestCallback>();
beforeEach(() => {
  now = 0; id = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key));
  useRoomStore.setState({ reducedMotion: false });
});
afterEach(() => { cleanup(); frames.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useRoomStore.setState({ reducedMotion: false }); });
function Journal({ open, mode = "full" }: { open: boolean; mode?: "full" | "lite" | "off" }) {
  const root = useRef<HTMLDivElement>(null);
  const { mounted, exiting } = useCompanionJournalMotion(open, root, mode);
  return mounted ? <div ref={root} data-testid="journal" inert={exiting || undefined}>手记内容</div> : null;
}
const presence = (root: HTMLElement) => Number(root.style.getPropertyValue("--journal-presence"));
const advance = (count: number) => {
  for (let i = 0; i < count; i++) act(() => {
    now += 1000 / 60; const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(now));
  });
};

it.each(["full", "lite"] as const)("%s keeps the same page and continuous position when closing is interrupted by reopening", mode => {
  const view = render(<StrictMode><Journal open mode={mode} /></StrictMode>);
  const page = view.getByTestId("journal"); advance(5);
  const opened = presence(page); expect(opened).toBeGreaterThan(0);
  view.rerender(<StrictMode><Journal open={false} mode={mode} /></StrictMode>);
  expect(page.hasAttribute("inert")).toBe(true); expect(presence(page)).toBe(opened);
  advance(3); const closing = presence(page);
  view.rerender(<StrictMode><Journal open mode={mode} /></StrictMode>);
  expect(view.getByTestId("journal")).toBe(page); expect(presence(page)).toBe(closing);
  expect(page.hasAttribute("inert")).toBe(false);
  advance(80); expect(presence(page)).toBe(1); expect(frames.size).toBe(0);
  view.rerender(<StrictMode><Journal open={false} mode={mode} /></StrictMode>);
  advance(80); expect(view.queryByTestId("journal")).toBeNull(); expect(frames.size).toBe(0);
});

it.each([{ mode: "off" as const, reduced: false }, { mode: "full" as const, reduced: true }])("%j opens and closes immediately", ({ mode, reduced }) => {
  useRoomStore.setState({ reducedMotion: reduced });
  const view = render(<Journal open={false} mode={mode} />);
  view.rerender(<Journal open mode={mode} />);
  expect(presence(view.getByTestId("journal"))).toBe(1);
  view.rerender(<Journal open={false} mode={mode} />);
  expect(view.queryByTestId("journal")).toBeNull(); expect(frames.size).toBe(0);
});

it("switching to reduced motion while the book is moving settles immediately and cancels queued frames", () => {
  const view = render(<Journal open />); advance(3);
  act(() => useRoomStore.setState({ reducedMotion: true }));
  expect(presence(view.getByTestId("journal"))).toBe(1); expect(frames.size).toBe(0);
});
