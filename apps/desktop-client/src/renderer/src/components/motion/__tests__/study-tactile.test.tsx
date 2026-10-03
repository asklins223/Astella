// @vitest-environment jsdom
import { StrictMode, useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "../../../app/room-store";
import { useTactileSurface } from "../use-tactile-surface";

let time = 0, nextFrame = 0;
let frames = new Map<number, FrameRequestCallback>();
function advance(count = 1) {
  for (let i = 0; i < count; i++) {
    time += 16;
    const callbacks = [...frames.values()]; frames.clear();
    act(() => callbacks.forEach(callback => callback(time)));
  }
}
beforeEach(() => {
  time = 0; nextFrame = 0; frames = new Map();
  vi.spyOn(performance, "now").mockImplementation(() => time);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  useRoomStore.setState({ motionMode: "full", reducedMotion: false });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useRoomStore.setState({ motionMode: "full", reducedMotion: false }); });

function Journal({ identity = "today", ready = true, onClick = () => undefined }: { identity?: string; ready?: boolean; onClick?: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useTactileSurface(root, identity);
  return ready ? <div ref={root}><button onClick={onClick}>翻开</button><button disabled>正在保存</button><div hidden><button>隐藏页签</button></div><section data-tactile-page>{identity}</section></div> : null;
}
const scale = (button: HTMLElement) => Number(button.style.getPropertyValue("--tactile-press") || "1");
const down = (button: HTMLElement) => fireEvent(button, new MouseEvent("pointerdown", { button: 0, bubbles: true }));
const up = () => fireEvent(document, new MouseEvent("pointerup"));

/** 今日学习页签条的真实几何。jsdom 不排版，不给尺寸的话量到的永远是 0，垫子就动不了。 */
const TABS = [
  { id: "today", label: "今天的足迹", left: 4, width: 118 },
  { id: "rounds", label: "学过的每一轮", left: 125, width: 130 },
] as const;

function stubTabGeometry() {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const before = { left: Object.getOwnPropertyDescriptor(proto, "offsetLeft"), width: Object.getOwnPropertyDescriptor(proto, "offsetWidth") };
  const find = (node: HTMLElement) => TABS.find(item => node.textContent?.startsWith(item.label));
  Object.defineProperty(proto, "offsetLeft", { configurable: true, get(this: HTMLElement) { return find(this)?.left ?? 0; } });
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get(this: HTMLElement) { return find(this)?.width ?? 0; } });
  return () => {
    for (const [name, descriptor] of [["offsetLeft", before.left], ["offsetWidth", before.width]] as const) {
      if (descriptor) Object.defineProperty(proto, name, descriptor); else Reflect.deleteProperty(proto, name);
    }
  };
}

/** 常驻页签 + 一个滑动的奶油垫：今日学习那一排的结构。 */
function TabbedJournal() {
  const root = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("today");
  useTactileSurface(root, tab);
  return <div ref={root}>
    <div role="tablist" data-tactile-tabs>
      <span data-tactile-cushion aria-hidden="true" />
      {TABS.map(item => <button key={item.id} type="button" role="tab"
        aria-selected={tab === item.id} onClick={() => setTab(item.id)}>{item.label}</button>)}
    </div>
    <section data-tactile-page>{tab}</section>
  </div>;
}

describe("今日学习的可打断触感", () => {
  it("在第一帧就响应按压，操作即时生效，松开后回弹并停止运算", () => {
    const onClick = vi.fn(); render(<Journal onClick={onClick} />);
    advance(100);
    const button = screen.getByRole("button", { name: "翻开" });
    down(button); advance(); expect(scale(button)).toBeLessThan(1);
    advance(5); fireEvent.click(button); expect(onClick).toHaveBeenCalledTimes(1);
    up(); let largest = 1;
    for (let i = 0; i < 40; i++) { advance(); largest = Math.max(largest, scale(button)); }
    expect(largest).toBeGreaterThan(1);
    advance(100); expect(button.style.length).toBe(0); expect(frames.size).toBe(0);
  });
  it("快速松开再按下，接住当前形状，最终回到最新意图", () => {
    render(<Journal />); advance(100);
    const button = screen.getByRole("button", { name: "翻开" });
    down(button); advance(5); up(); advance(2);
    const before = scale(button); down(button);
    expect(scale(button)).toBe(before);
    advance(100); expect(scale(button)).toBe(.95); expect(frames.size).toBe(0);
    up(); advance(100); expect(scale(button)).toBe(1); expect(frames.size).toBe(0);
  });
  it("普通重渲染不重启按压，键盘释放和失焦都能回到自然形状", () => {
    const view = render(<Journal />); advance(100);
    const button = screen.getByRole("button", { name: "翻开" }); button.focus();
    fireEvent.keyDown(button, { key: " " }); advance(5);
    const before = scale(button); view.rerender(<Journal />); expect(scale(button)).toBe(before);
    fireEvent.keyDown(button, { key: " ", repeat: true }); expect(scale(button)).toBe(before);
    fireEvent.keyUp(document, { key: " " }); advance(100);
    expect(scale(button)).toBe(1); expect(document.activeElement).toBe(button);
    down(button); advance(4); fireEvent(window, new Event("blur")); advance(100);
    expect(scale(button)).toBe(1); expect(frames.size).toBe(0);
  });
  it("Off、Lite 和系统减少动态立即停止进行中的弹性按压", () => {
    render(<Journal />); advance(100);
    const button = screen.getByRole("button", { name: "翻开" });
    for (const preference of [{ motionMode: "lite" as const }, { motionMode: "off" as const }, { reducedMotion: true }]) {
      act(() => useRoomStore.setState({ motionMode: "full", reducedMotion: false }));
      down(button); advance(4); expect(scale(button)).toBeLessThan(1);
      act(() => useRoomStore.setState(preference));
      expect(scale(button)).toBe(1); expect(frames.size).toBe(0);
      down(button); expect(frames.size).toBe(0); up();
    }
  });
  it("异步出现的纸面也能操作，禁用和隐藏按钮不触发动画，卸载清掉帧和事件", () => {
    const view = render(<Journal ready={false} />);
    view.rerender(<Journal />); advance(100);
    const button = screen.getByRole("button", { name: "翻开" });
    down(screen.getByRole("button", { name: "正在保存" }));
    down(screen.getByText("隐藏页签")); expect(frames.size).toBe(0);
    down(button); advance(3); expect(scale(button)).toBeLessThan(1);
    view.unmount(); expect(frames.size).toBe(0); expect(button.style.length).toBe(0);
    up(); expect(frames.size).toBe(0);
  });
  it("连续换页只展示最新内容，Off 中不留半透明的纸面", () => {
    const view = render(<Journal />);
    advance(3); view.rerender(<Journal identity="rounds" />); advance(2);
    view.rerender(<Journal identity="spaces" />);
    expect(screen.getByText("spaces")).toBeTruthy();
    advance(100); expect(view.container.querySelector("section")?.getAttribute("style")).toBe("");
    view.rerender(<Journal identity="today" />); advance(2);
    act(() => useRoomStore.setState({ motionMode: "off" }));
    expect(view.container.querySelector("section")?.style.length).toBe(0); expect(frames.size).toBe(0);
  });

  /**
   * 页签垫与纸面到达都是**补间的结果**，而补间要一帧一帧跑。
   * StrictMode（main.tsx 就这么挂的）把卸载也跑了一遍：卸载取消掉那一帧，
   * 帧号却没有交还，于是 `move` 里的"已经有循环在跑"永远成立。
   * 结果是选中态永远差一步：垫子留在上一页，纸面停在半透明。
   */
  it("StrictMode 跑两遍 effect，页签垫仍落到选中的一页，纸面也不留在半透明", () => {
    const restoreGeometry = stubTabGeometry();
    try {
      render(<StrictMode><TabbedJournal /></StrictMode>);
      advance(100);
      const cushion = document.querySelector<HTMLElement>("[data-tactile-cushion]")!;
      const at = () => [cushion.style.getPropertyValue("--tactile-tab-x"), cushion.style.getPropertyValue("--tactile-tab-width")];
      const paper = () => document.querySelector<HTMLElement>("[data-tactile-page]")!;
      expect(at()).toEqual(["4px", "118px"]);

      fireEvent.click(screen.getByRole("tab", { name: "学过的每一轮" }));
      advance(100);
      expect(at()).toEqual(["125px", "130px"]);
      // 落到位的纸面不留半透明：到达补间收敛后不留半截的值。
      expect(paper().style.getPropertyValue("--tactile-page")).toBe("");
      expect(frames.size).toBe(0);
    } finally { restoreGeometry(); }
  });
});
