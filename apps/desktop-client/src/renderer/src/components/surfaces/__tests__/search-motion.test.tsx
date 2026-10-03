// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "../../../app/room-store";
import { searchSpring, useSearchMotion } from "../study/use-search-motion";

let time = 0, sequence = 0;
const frames = new Map<number, FrameRequestCallback>();
function advance(count: number) {
  act(() => { for (let i = 0; i < count; i++) { time += 1000 / 60; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(time)); } });
}
function Tray({ selected }: { selected: string }) {
  const root = useRef<HTMLDivElement>(null);
  useSearchMotion(root, selected, selected);
  return <div ref={root}><nav className="search-types"><span className="search-types__cushion" />{["a", "b"].map((value, i) => <button key={value} aria-pressed={value === selected} ref={node => {
    if (node) { Object.defineProperty(node, "offsetLeft", { configurable: true, value: i * 92 }); Object.defineProperty(node, "offsetWidth", { configurable: true, value: 82 }); }
  }}>{value}</button>)}</nav><div className="search-preview__paper" /></div>;
}
beforeEach(() => {
  frames.clear(); time = 0; sequence = 0;
  useRoomStore.setState({ motionMode: "full", reducedMotion: false });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); useRoomStore.setState({ motionMode: "full", reducedMotion: false }); });

describe("搜索台的轻弹可以连续打断", () => {
  it("反向时沿当前位置与速度接续，Full 轻弹，Lite 不越界，Off 直接到位", () => {
    const moving = searchSpring({ position: 0, velocity: 0 }, 1, .06, "full");
    expect(searchSpring(moving, 0, 0, "full")).toEqual(moving);
    expect(searchSpring(moving, 0, .001, "full").position).toBeGreaterThan(moving.position);
    let full = { position: 0, velocity: 0 }, lite = { position: 0, velocity: 0 }, maximum = 0;
    for (let i = 0; i < 150; i++) {
      full = searchSpring(full, 1, 1 / 60, "full"); maximum = Math.max(maximum, full.position);
      lite = searchSpring(lite, 1, 1 / 60, "lite"); expect(lite.position).toBeLessThanOrEqual(1);
    }
    expect(maximum).toBeGreaterThan(1); expect(maximum).toBeLessThan(1.06);
    expect(full.position).toBeCloseTo(1, 5);
    expect(searchSpring(moving, 0, .01, "off")).toEqual({ position: 0, velocity: 0 });
  });
  it("快速往返页签不跳位置，按下与释放共享轨迹，焦点不等动画", () => {
    const view = render(<Tray selected="a" />);
    view.rerender(<Tray selected="b" />); advance(4);
    const cushion = document.querySelector<HTMLElement>(".search-types__cushion")!;
    const current = cushion.style.transform;
    view.rerender(<Tray selected="a" />);
    expect(cushion.style.transform).toBe(current);
    const button = view.getByRole("button", { name: "a" }); button.focus();
    fireEvent(button, new MouseEvent("pointerdown", { bubbles: true, button: 0 })); advance(4);
    const pressed = button.style.getPropertyValue("--search-press");
    expect(Number(pressed)).toBeLessThan(1);
    fireEvent(window, new MouseEvent("pointerup", { bubbles: true }));
    expect(button.style.getPropertyValue("--search-press")).toBe(pressed);
    expect(document.activeElement).toBe(button);
    advance(90);
    expect(button.style.getPropertyValue("--search-press")).toBe("");
    expect(cushion.style.transform).toBe("translate3d(0px, 0, 0)");
  });
  it("系统减少动态与 Off 立即结束已有回弹，并释放所有帧", () => {
    const view = render(<Tray selected="a" />); view.rerender(<Tray selected="b" />); advance(3);
    act(() => useRoomStore.setState({ reducedMotion: true }));
    expect(document.querySelector<HTMLElement>(".search-preview__paper")!.style.getPropertyValue("--search-reveal")).toBe("");
    expect(document.querySelector<HTMLElement>(".search-types__cushion")!.style.transform).toBe("translate3d(92px, 0, 0)");
    expect(frames.size).toBe(0);
    act(() => useRoomStore.setState({ reducedMotion: false, motionMode: "off" }));
    view.rerender(<Tray selected="a" />);
    expect(frames.size).toBe(0);
    expect(document.querySelector<HTMLElement>(".search-types__cushion")!.style.transform).toBe("translate3d(0px, 0, 0)");
  });
  it("Lite 保留切换反馈，按压不引入缩放，卸载清掉帧与样式", () => {
    useRoomStore.setState({ motionMode: "lite" });
    const view = render(<Tray selected="a" />); view.rerender(<Tray selected="b" />);
    const button = view.getByRole("button", { name: "b" });
    fireEvent(button, new MouseEvent("pointerdown", { bubbles: true, button: 0 })); advance(3);
    expect(button.style.getPropertyValue("--search-press")).toBe("");
    expect(document.querySelector<HTMLElement>(".search-preview__paper")!.style.getPropertyValue("--search-reveal")).not.toBe("");
    view.unmount(); expect(frames.size).toBe(0);
    expect(button.style.getPropertyValue("--search-press")).toBe("");
  });
});
