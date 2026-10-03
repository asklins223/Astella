// @vitest-environment jsdom
import { StrictMode, useRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHudPopoverMotion, type HudMenuKind } from "../use-hud-popover-motion";
import { useRoomStore } from "../../../app/room-store";

let now = 0, id = 0;
const frames = new Map<number, FrameRequestCallback>();
beforeEach(() => {
  now = 0; id = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key));
  useRoomStore.setState({ motionMode: "full", reducedMotion: false });
});
afterEach(() => {
  cleanup(); frames.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  useRoomStore.setState({ motionMode: "full", reducedMotion: false });
});
const advance = (count: number) => {
  for (let i = 0; i < count; i++) act(() => {
    now += 1000 / 60;
    const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(now));
  });
};
function Bubble({ kind }: { kind: HudMenuKind | null }) {
  const root = useRef<HTMLDivElement>(null), anchor = useRef<HTMLButtonElement>(null);
  const { shown, mode } = useHudPopoverMotion(kind, root, anchor);
  return <><button ref={anchor}>入口</button>{shown ? <div ref={root} data-testid="bubble" data-motion={mode} inert={!kind || undefined}>{shown}</div> : null}</>;
}
const presence = (root: HTMLElement) => Number(root.style.getPropertyValue("--hud-bubble-presence"));

describe("气泡弹簧的连续呈现", () => {
  it("快速收回再打开接续同一物件的呈现值，关闭立即 inert，最后回弹就位", () => {
    const result = render(<StrictMode><Bubble kind="space" /></StrictMode>);
    const bubble = result.getByTestId("bubble");
    advance(6);
    const before = presence(bubble);
    expect(before).toBeGreaterThan(0);
    result.rerender(<StrictMode><Bubble kind={null} /></StrictMode>);
    expect(bubble.hasAttribute("inert")).toBe(true);
    expect(presence(bubble)).toBe(before);
    advance(3);
    const closing = presence(bubble);
    result.rerender(<StrictMode><Bubble kind="space" /></StrictMode>);
    expect(result.getByTestId("bubble")).toBe(bubble);
    expect(presence(bubble)).toBe(closing);
    expect(bubble.hasAttribute("inert")).toBe(false);
    advance(70);
    expect(presence(bubble)).toBe(1);
    expect(frames.size).toBe(0);
    result.rerender(<StrictMode><Bubble kind={null} /></StrictMode>);
    advance(70);
    expect(result.queryByTestId("bubble")).toBeNull();
  });

  it("两种气泡快速切换立即更换内容，保持同一个呈现节点", () => {
    const result = render(<Bubble kind="space" />);
    const bubble = result.getByTestId("bubble");
    advance(5);
    const before = presence(bubble);
    result.rerender(<Bubble kind="account" />);
    expect(result.getByTestId("bubble")).toBe(bubble);
    expect(bubble.textContent).toBe("account");
    expect(presence(bubble)).toBe(before);
  });

  it.each([{ motionMode: "off" as const, reducedMotion: false }, { motionMode: "full" as const, reducedMotion: true }])(
    "%j 下立即开合，不留下待完成帧", preference => {
      useRoomStore.setState(preference);
      const result = render(<Bubble kind="space" />);
      expect(presence(result.getByTestId("bubble"))).toBe(1);
      result.rerender(<Bubble kind={null} />);
      expect(result.queryByTestId("bubble")).toBeNull();
      expect(frames.size).toBe(0);
    });

  it("运动中切到减少动态立即就位并取消后续帧", () => {
    const result = render(<Bubble kind="space" />);
    advance(3);
    act(() => useRoomStore.setState({ reducedMotion: true }));
    expect(presence(result.getByTestId("bubble"))).toBe(1);
    expect(frames.size).toBe(0);
  });

  it("缩放后按入口下方实际剩余空间限制高度，表单改为整张气泡滚动", () => {
    vi.stubGlobal("innerHeight", 480);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.tagName === "BUTTON"
        ? { top: 16, bottom: 64, left: 100, right: 200, width: 100, height: 48, x: 100, y: 16, toJSON: () => ({}) }
        : { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
    });
    const result = render(<Bubble kind="space" />);
    const bubble = result.getByTestId("bubble");
    expect(bubble.dataset.scrollWhole).toBe("true");
    expect(Number.parseFloat(bubble.style.top) + Number.parseFloat(bubble.style.getPropertyValue("--hud-bubble-max-height"))).toBeLessThan(480);
    vi.stubGlobal("innerHeight", 810);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(bubble.dataset.scrollWhole).toBe("false");
  });
});
