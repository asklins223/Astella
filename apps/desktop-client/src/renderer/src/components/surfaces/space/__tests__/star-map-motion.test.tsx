// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "../../../../app/room-store";
import { STAR_PAN_DECAY_MS, starPanRelease, stepStarSpring } from "../star-map-motion";
import { useStarMapMotion } from "../use-star-map-motion";

let time = 0, sequence = 0;
const frames = new Map<number, FrameRequestCallback>();
function advance(count: number) {
  act(() => { for (let i = 0; i < count; i++) {
    time += 1000 / 60;
    const current = [...frames.values()]; frames.clear(); current.forEach(callback => callback(time));
  } });
}
function Paper({ open, selected }: { open: boolean; selected: string }) {
  const root = useRef<HTMLDivElement>(null);
  useStarMapMotion(root, open, selected);
  return <div ref={root}>
    <nav data-star-tabs><span className="universe-tab-cushion" />{["a", "b"].map((value, index) => <button key={value} aria-pressed={value === selected} ref={node => {
      if (node) {
        Object.defineProperty(node, "offsetLeft", { configurable: true, value: index * 90 });
        Object.defineProperty(node, "offsetWidth", { configurable: true, value: 80 });
      }
    }}>{value}</button>)}</nav>
    <aside className="universe-detail-panel" inert={!open || undefined}><div className="universe-detail-body">{selected}</div></aside>
  </div>;
}
const property = (element: HTMLElement, name: string) => Number(element.style.getPropertyValue(name));

beforeEach(() => {
  frames.clear(); time = 0; sequence = 0;
  useRoomStore.setState({ motionMode: "full", reducedMotion: false });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); useRoomStore.setState({ motionMode: "full", reducedMotion: false });
});

describe("星图的连续触感", () => {
  it("松手后只短暂滑行；短拖动不会把星域甩出视野，停住、Lite 和 Off 不续滑", () => {
    const release = starPanRelease(2.1, 1.3, 100, 0, "full")!;
    expect(Math.hypot(release.velocityX, release.velocityY) * STAR_PAN_DECAY_MS).toBeLessThanOrEqual(45);
    expect(release.velocityY / release.velocityX).toBeCloseTo(1.3 / 2.1);
    const long = starPanRelease(10, 10, 2000, 0, "full")!;
    expect(Math.hypot(long.velocityX, long.velocityY) * STAR_PAN_DECAY_MS).toBeLessThanOrEqual(120.001);
    expect(starPanRelease(2.1, 1.3, 100, 500, "full")).toBeNull();
    expect(starPanRelease(2.1, 1.3, 100, 0, "lite")).toBeNull();
    expect(starPanRelease(2.1, 1.3, 100, 0, "off")).toBeNull();
  });
  it("反向切换保留当前位置与速度，Full 轻弹，Lite 收敛，Off 即时到位", () => {
    const moving = stepStarSpring({ position: 0, velocity: 0 }, 1, .06);
    expect(stepStarSpring(moving, 0, 0)).toEqual(moving);
    expect(stepStarSpring(moving, 0, .001).position).toBeGreaterThan(moving.position);
    let full = { position: 0, velocity: 0 }, lite = { position: 0, velocity: 0 }, maximum = 0;
    for (let i = 0; i < 150; i++) {
      full = stepStarSpring(full, 1, 1 / 60); maximum = Math.max(maximum, full.position);
      lite = stepStarSpring(lite, 1, 1 / 60, "lite"); expect(lite.position).toBeLessThanOrEqual(1);
    }
    expect(maximum).toBeGreaterThan(1); expect(maximum).toBeLessThan(1.06);
    expect(full.position).toBeCloseTo(1, 5);
    expect(stepStarSpring(moving, 0, .01, "off")).toEqual({ position: 0, velocity: 0 });
  });
  it("旁页未展开完就关闭再打开，位置连续；功能停用即时生效", () => {
    const view = render(<Paper open={false} selected="a" />);
    view.rerender(<Paper open selected="a" />); advance(5);
    const panel = view.container.querySelector<HTMLElement>("aside")!;
    const position = panel.style.getPropertyValue("--star-panel");
    view.rerender(<Paper open={false} selected="a" />);
    expect(panel.style.getPropertyValue("--star-panel")).toBe(position);
    expect(panel.hasAttribute("inert")).toBe(true);
    advance(2); const closing = panel.style.getPropertyValue("--star-panel");
    view.rerender(<Paper open selected="a" />);
    expect(panel.style.getPropertyValue("--star-panel")).toBe(closing);
    expect(panel.hasAttribute("inert")).toBe(false);
    advance(90); expect(property(panel, "--star-panel")).toBe(1);
  });
  it("页签快速往返和按下释放接续同一轨迹，焦点不等动画", () => {
    const view = render(<Paper open selected="a" />);
    view.rerender(<Paper open selected="b" />); advance(4);
    const cushion = view.container.querySelector<HTMLElement>(".universe-tab-cushion")!;
    const moving = cushion.style.transform;
    view.rerender(<Paper open selected="a" />); expect(cushion.style.transform).toBe(moving);
    const button = view.getByRole("button", { name: "a" }); button.focus();
    fireEvent(button, new MouseEvent("pointerdown", { bubbles: true, button: 0 })); advance(4);
    const pressed = button.style.getPropertyValue("--star-press"); expect(Number(pressed)).toBeLessThan(1);
    fireEvent(window, new MouseEvent("pointerup", { bubbles: true }));
    expect(button.style.getPropertyValue("--star-press")).toBe(pressed); expect(document.activeElement).toBe(button);
    advance(90); expect(button.style.getPropertyValue("--star-press")).toBe("");
    expect(cushion.style.transform).toBe("translate3d(0px, 0, 0)");
  });
  it("Off 和系统减少动态立即结束在途动效，不留循环帧", () => {
    const view = render(<Paper open selected="a" />); view.rerender(<Paper open selected="b" />); advance(3);
    act(() => useRoomStore.setState({ reducedMotion: true }));
    expect(frames.size).toBe(0);
    expect(view.container.querySelector<HTMLElement>("aside")!.style.getPropertyValue("--star-panel")).toBe("1");
    expect(view.container.querySelector<HTMLElement>(".universe-tab-cushion")!.style.transform).toBe("translate3d(90px, 0, 0)");
    act(() => useRoomStore.setState({ reducedMotion: false, motionMode: "off" }));
    view.rerender(<Paper open={false} selected="a" />);
    expect(frames.size).toBe(0); expect(view.container.querySelector("aside")!.getAttribute("data-visible")).toBe("false");
  });
  it("Lite 不缩放按钮，卸载清理所有帧", () => {
    useRoomStore.setState({ motionMode: "lite" });
    const view = render(<Paper open selected="a" />);
    const button = view.getByRole("button", { name: "a" });
    fireEvent(button, new MouseEvent("pointerdown", { bubbles: true, button: 0 })); advance(3);
    expect(button.style.getPropertyValue("--star-press")).toBe("");
    expect(property(view.container.querySelector("aside")!, "--star-panel")).toBeGreaterThan(0);
    view.unmount(); expect(frames.size).toBe(0);
  });
});
