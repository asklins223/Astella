// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "../../../../app/room-store";
import { useSettingsTactile } from "../use-settings-tactile";

let time = 0;
let sequence = 0;
const frames = new Map<number, FrameRequestCallback>();
function advance(count: number) {
  act(() => {
    for (let i = 0; i < count; i++) {
      time += 1000 / 60;
      const callbacks = [...frames.values()]; frames.clear();
      callbacks.forEach(callback => callback(time));
    }
  });
}
async function sync() { await act(async () => {}); }
function Fixture({ page, checked = false }: { page: "a" | "b"; checked?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useSettingsTactile(ref);
  return <div ref={ref}>
    <nav className="settings-menu"><span data-settings-cushion />{["a", "b"].map((id, index) => <button key={id} aria-current={id === page ? "page" : undefined} ref={element => {
      if (!element) return;
      for (const [key, value] of Object.entries({ offsetLeft: index * 100, offsetTop: 0, offsetWidth: 90, offsetHeight: 65 })) Object.defineProperty(element, key, { configurable: true, value });
    }}>{id}</button>)}</nav>
    <div data-settings-page={page}><button className={`switch${checked ? " on" : ""}`} aria-checked={checked}><i /></button><input aria-label="名字" /><button data-settings-bounce>叶子</button></div>
  </div>;
}
beforeEach(() => {
  time = 0; sequence = 0; frames.clear();
  useRoomStore.setState({ motionMode: "full", reducedMotion: false });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); useRoomStore.setState({ motionMode: "full", reducedMotion: false }); });

describe("设置册在连续操作中接续", () => {
  it("反向切页保留圆垫当前位置；当前页面和输入立即可用", async () => {
    const { container, rerender } = render(<Fixture page="a" />);
    const cushion = container.querySelector<HTMLElement>("[data-settings-cushion]")!;
    rerender(<Fixture page="b" />); await sync(); advance(4);
    const moving = cushion.style.transform;
    expect(moving).not.toBe("translate3d(0px, 0px, 0)");
    expect(moving).not.toBe("translate3d(100px, 0px, 0)");
    rerender(<Fixture page="a" />); await sync();
    expect(cushion.style.transform).toBe(moving);
    const input = container.querySelector("input")!;
    input.focus(); fireEvent.change(input, { target: { value: "刚输入的名字" } });
    expect(document.activeElement).toBe(input);
    advance(90);
    expect(cushion.style.transform).toBe("translate3d(0px, 0px, 0)");
    expect(container.querySelector<HTMLElement>("[data-settings-page]")!.style.transform).toBe("");
  });

  it("关闭动效或开启系统减少动态时，中途运动立即结束，开关直接到位", async () => {
    const { container, rerender } = render(<Fixture page="a" />);
    rerender(<Fixture page="b" checked />); await sync(); advance(3);
    act(() => useRoomStore.setState({ motionMode: "off" }));
    expect(container.querySelector<HTMLElement>("[data-settings-cushion]")!.style.transform).toBe("translate3d(100px, 0px, 0)");
    expect(container.querySelector<HTMLElement>(".switch i")!.style.transform).toBe("translate3d(20px, 0, 0)");
    expect(container.querySelector<HTMLElement>("[data-settings-page]")!.style.transform).toBe("");
    expect(frames.size).toBe(0);
    act(() => useRoomStore.setState({ motionMode: "full", reducedMotion: true }));
    rerender(<Fixture page="a" />); await sync();
    expect(container.querySelector<HTMLElement>(".switch i")!.style.transform).toBe("translate3d(0px, 0, 0)");
    expect(frames.size).toBe(0);
  });

  it("按下即响应，取消后回弹，卸载清理帧；输入 Enter 不产生按钮按压", () => {
    const { container, unmount } = render(<Fixture page="a" />);
    const leaf = container.querySelector<HTMLElement>("[data-settings-bounce]")!;
    fireEvent(leaf, new MouseEvent("pointerdown", { button: 0, bubbles: true })); advance(5);
    expect(leaf.style.transform).not.toBe("");
    fireEvent(window, new MouseEvent("pointercancel", { bubbles: true })); advance(90);
    expect(leaf.style.transform).toBe("");
    fireEvent.keyDown(container.querySelector("input")!, { key: "Enter" });
    expect(frames.size).toBe(0);
    fireEvent.click(leaf); advance(3);
    expect(leaf.style.transform).not.toBe("");
    unmount(); expect(frames.size).toBe(0);
  });
});
