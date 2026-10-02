// @vitest-environment jsdom
import { act, fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCompanionTransient } from "../use-companion-transient";

function Paper({ identity, hold = 1_000, paused = false }: { identity: string | null; hold?: number; paused?: boolean }) {
  const life = useCompanionTransient(identity, hold, paused);
  return life.visible ? <button onFocus={life.activity} onPointerMove={life.activity} onKeyDown={life.activity} onClick={life.dismiss}>纸签</button> : null;
}
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("temporary paper lifetime", () => {
  it("expires despite a focused control, preserves the deadline across rerenders, and can reopen", () => {
    const view = render(<Paper identity="one" />);
    const button = screen.getByRole("button");
    fireEvent.focus(button);
    advance(2_000);
    view.rerender(<Paper identity="one" />);
    expect(screen.getByRole("button")).toBeTruthy();
    advance(2_000);
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(<Paper identity={null} />);
    view.rerender(<Paper identity="one" />);
    expect(screen.getByRole("button")).toBeTruthy();
    advance(1_120);
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("pauses for hidden documents and genuine work, then expires after resuming", () => {
    const view = render(<Paper identity="two" paused />);
    advance(2_000);
    expect(screen.getByRole("button")).toBeTruthy();
    view.rerender(<Paper identity="two" />);
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    advance(2_000);
    expect(screen.getByRole("button")).toBeTruthy();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    advance(1_120);
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("keeps pending confirmations, but bounds their result and never auto-confirms", () => {
    const view = render(<Paper identity="proposal:pending" hold={Infinity} />);
    advance(240_000);
    expect(screen.getByRole("button")).toBeTruthy();
    view.rerender(<Paper identity="proposal:accepted" hold={10_000} />);
    advance(10_240);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
