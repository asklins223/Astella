// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "../../../app/room-store";
import { companionSpring, useCompanionTactile } from "../companion/use-companion-tactile";

let time = 0, sequence = 0;
let resize: ResizeObserverCallback | null = null;
const frames = new Map<number, FrameRequestCallback>();
function advance(count: number) {
  act(() => { for (let i = 0; i < count; i++) { time += 1000 / 60; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(time)); } });
}
function House({ page, width = 140, gap = 58 }: { page: "a" | "b"; width?: number; gap?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useCompanionTactile(ref, page);
  return <div ref={ref}><nav className="cc-room-tabs" aria-orientation="vertical"><span className="cc-room-tabs__cushion" />{["a", "b"].map((id, index) => <button key={id} aria-selected={id === page} ref={button => {
    if (button) {
      for (const [key, value] of Object.entries({ offsetLeft: 5, offsetTop: 6 + index * gap, offsetWidth: width, offsetHeight: 50 })) Object.defineProperty(button, key, { configurable: true, value });
    }
  }}>{id}</button>)}</nav><div id="companion-panel-a" hidden={page !== "a"} /><div id="companion-panel-b" hidden={page !== "b"} /></div>;
}
beforeEach(() => {
  time = 0; sequence = 0; resize = null; frames.clear();
  useRoomStore.setState({ motionMode: "full", reducedMotion: false });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("ResizeObserver", class { constructor(callback: ResizeObserverCallback) { resize = callback; } observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); useRoomStore.setState({ motionMode: "full", reducedMotion: false }); });

describe("伴星的弹性触感可以连续打断", () => {
  it("反向切换保留当前位置与速度，Full 轻微回弹，Lite 平稳靠近，Off 直接到达", () => {
    const moving = companionSpring({ position: 0, velocity: 0 }, 1, .08, "full");
    expect(companionSpring(moving, 0, 0, "full")).toEqual(moving);
    expect(companionSpring(moving, 0, .01, "full").position).toBeGreaterThan(moving.position);
    let full = { position: 0, velocity: 0 }, lite = { position: 0, velocity: 0 }, maximum = 0;
    for (let i = 0; i < 120; i++) {
      full = companionSpring(full, 1, 1 / 60, "full"); maximum = Math.max(maximum, full.position);
      lite = companionSpring(lite, 1, 1 / 60, "lite"); expect(lite.position).toBeLessThanOrEqual(1);
    }
    expect(maximum).toBeGreaterThan(1); expect(maximum).toBeLessThan(1.06);
    expect(full.position).toBeCloseTo(1, 5); expect(lite.position).toBeCloseTo(1, 5);
    expect(companionSpring(moving, 0, .01, "off")).toEqual({ position: 0, velocity: 0 });
  });

  it("快速往返页签接续圆垫的位置，旧页面清理，内容与焦点不等动效", () => {
    const view = render(<House page="a" />);
    const cushion = document.querySelector<HTMLElement>(".cc-room-tabs__cushion")!;
    view.rerender(<House page="b" />); advance(4);
    const current = cushion.style.transform;
    expect(current).not.toBe("translate3d(5px, 6px, 0)");
    view.rerender(<House page="a" />);
    expect(cushion.style.transform).toBe(current);
    expect(document.querySelector<HTMLElement>("#companion-panel-b")!.style.transform).toBe("");
    expect(document.querySelector<HTMLElement>("#companion-panel-a")!.hidden).toBe(false);
    advance(80); expect(cushion.style.transform).toBe("translate3d(5px, 6px, 0)");
    expect(cushion.style.width).toBe("140px"); expect(cushion.style.height).toBe("50px");
  });

  it("缩窄左栏时圆垫继续当前运动，并贴合竖排页签的新尺寸", () => {
    const view = render(<House page="a" />);
    const cushion = document.querySelector<HTMLElement>(".cc-room-tabs__cushion")!;
    view.rerender(<House page="b" />); advance(4);
    const reveal = vi.fn();
    document.querySelector<HTMLElement>('.cc-room-tabs [aria-selected="true"]')!.scrollIntoView = reveal;
    const current = cushion.style.transform;
    view.rerender(<House page="b" width={105} gap={68} />);
    act(() => resize?.([], {} as ResizeObserver));
    expect(cushion.style.transform).toBe(current);
    expect(reveal).toHaveBeenCalledOnce();
    advance(100);
    expect(cushion.style.transform).toBe("translate3d(5px, 74px, 0)");
    expect(cushion.style.width).toBe("105px"); expect(cushion.style.height).toBe("50px");
  });

  it("持续按下保持压缩，释放后恢复；减少动态立即清理所有过渡", () => {
    const view = render(<House page="a" />);
    const button = view.getByRole("button", { name: "a" });
    fireEvent(button, new MouseEvent("pointerdown", { bubbles: true, button: 0 })); advance(80);
    expect(button.style.transform).toContain("scale(0.967)");
    fireEvent(window, new MouseEvent("pointerup", { bubbles: true })); advance(80);
    expect(button.style.transform).toBe("");
    view.rerender(<House page="b" />); advance(3);
    act(() => useRoomStore.setState({ reducedMotion: true }));
    expect(document.querySelector<HTMLElement>("#companion-panel-b")!.style.transform).toBe("");
    expect(document.querySelector<HTMLElement>(".cc-room-tabs__cushion")!.style.transform).toBe("translate3d(5px, 64px, 0)");
    fireEvent(button, new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    expect(button.style.transform).toBe("");
  });
});
