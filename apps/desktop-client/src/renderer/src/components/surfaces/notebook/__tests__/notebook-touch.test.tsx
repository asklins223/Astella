// @vitest-environment jsdom
import { useRef } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "../../../../app/room-store";
import { stepTouchSpring, useNotebookTouch } from "../use-notebook-touch";

let time = 0, nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();
function advance(milliseconds: number) {
  act(() => {
    time += milliseconds;
    const pending = [...frames.values()]; frames.clear();
    pending.forEach(callback => callback(time));
  });
}
function Fixture() {
  const ref = useRef<HTMLDivElement | null>(null);
  useNotebookTouch(ref);
  return <div ref={ref}><button type="button">翻页</button><button type="button" disabled>不可用</button></div>;
}
beforeEach(() => {
  time = 0; nextFrame = 0; frames.clear();
  useRoomStore.setState({ motionMode: "full", reducedMotion: false });
  vi.spyOn(performance, "now").mockImplementation(() => time);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  useRoomStore.setState({ motionMode: "full", reducedMotion: false });
});

describe("笔记控件的按压回弹", () => {
  it("松手保留当前速度，随后回到原尺寸；连续按压不会跳到初始尺寸", () => {
    let spring = { value: 1, velocity: 0 };
    for (let i = 0; i < 6; i++) spring = stepTouchSpring(spring.value, spring.velocity, .955, .008);
    expect(spring.value).toBeLessThan(.99);
    const released = stepTouchSpring(spring.value, spring.velocity, 1, .001);
    expect(Math.abs(released.value - spring.value)).toBeLessThan(.002);
    const pressedAgain = stepTouchSpring(released.value, released.velocity, .955, .001);
    expect(Math.abs(pressedAgain.value - released.value)).toBeLessThan(.002);
    for (let i = 0; i < 160; i++) spring = stepTouchSpring(spring.value, spring.velocity, 1, .008);
    expect(spring.value).toBeCloseTo(1, 4);
    expect(spring.velocity).toBeCloseTo(0, 3);
  });

  it("键盘和指针共用同一按压状态，松手到纸面外也会恢复，卸载清理运动", () => {
    const view = render(<Fixture />), button = view.getByRole("button", { name: "翻页" });
    fireEvent.keyDown(button, { key: " " }); advance(32); advance(16);
    const pressed = Number(button.style.getPropertyValue("--note-touch-scale"));
    expect(pressed).toBeLessThan(.99);
    fireEvent.keyUp(document, { key: " " });
    fireEvent.keyDown(button, { key: "Enter" });
    expect(Number(button.style.getPropertyValue("--note-touch-scale"))).toBe(pressed);
    advance(16);
    fireEvent.pointerCancel(document);
    for (let i = 0; i < 100; i++) advance(16);
    expect(button.style.getPropertyValue("--note-touch-scale")).toBe("");
    expect(frames.size).toBe(0);
    fireEvent.keyDown(button, { key: "Enter" }); advance(16);
    view.unmount();
    expect(frames.size).toBe(0);
    expect(button.style.getPropertyValue("--note-touch-scale")).toBe("");
  });

  it.each([
    { motionMode: "off" as const, reducedMotion: false },
    { motionMode: "lite" as const, reducedMotion: false },
    { motionMode: "full" as const, reducedMotion: true },
  ])("切换偏好 %j 立即取消按压，不留下缩小的按钮", preference => {
    const view = render(<Fixture />), button = view.getByRole("button", { name: "翻页" });
    fireEvent.keyDown(button, { key: "Enter" }); advance(16);
    expect(button.style.getPropertyValue("--note-touch-scale")).not.toBe("");
    act(() => useRoomStore.setState(preference));
    expect(button.style.getPropertyValue("--note-touch-scale")).toBe("");
    expect(frames.size).toBe(0);
    fireEvent.keyDown(button, { key: " " }); advance(16);
    expect(button.style.getPropertyValue("--note-touch-scale")).toBe("");
    expect(frames.size).toBe(0);
  });
});
