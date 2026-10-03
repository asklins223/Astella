// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "../../../app/room-store";
import { CardPackObject } from "../library/card-pack-object";
import { createCardPackMotion } from "../library/use-card-pack-motion";

let time = 0, nextFrame = 0;
let frames = new Map<number, FrameRequestCallback>();
function advance(count = 1) {
  for (let index = 0; index < count; index++) {
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

describe("立体卡包接续最新意图", () => {
  it("开到一半合包保留呈现角度与速度，最后停在关闭位置", () => {
    const host = document.createElement("span");
    const object = createCardPackMotion(host, { pitch: -7, yaw: -14, lift: 0, open: 0, press: 0 });
    object.target({ open: 1 }); advance(4);
    const before = object.pose().open;
    expect(before).toBeGreaterThan(0); expect(before).toBeLessThan(1);
    object.target({ open: 0 }); expect(object.pose().open).toBe(before);
    advance(); expect(Math.abs(object.pose().open - before)).toBeLessThan(.2);
    advance(120); expect(object.pose().open).toBe(0); expect(frames.size).toBe(0);
    object.destroy(); expect(host.style.length).toBe(0);
  });

  it("Off 在运动中即时完成最新状态，销毁不留下一帧循环", () => {
    const host = document.createElement("span");
    const object = createCardPackMotion(host, { pitch: -7, yaw: -14, lift: 0, open: 0, press: 0 });
    object.target({ open: 1 }); advance(3); object.mode("off");
    expect(object.pose().open).toBe(1); expect(frames.size).toBe(0);
    object.target({ open: 0 }); expect(object.pose().open).toBe(0);
    object.destroy(); expect(host.style.length).toBe(0);
  });

  it.each(["lite", "off", "reduced"] as const)("%s 保留立体造型与即时开合，指针和按键不引入空间运动", preference => {
    useRoomStore.setState({ motionMode: preference === "reduced" ? "full" : preference, reducedMotion: preference === "reduced" });
    const onToggle = vi.fn();
    const view = render(<CardPackObject identity="note" title="笔记" count={4} opened={false} onToggle={onToggle}>四张卡</CardPackObject>);
    const button = screen.getByRole("button", { name: "打开卡包：笔记" });
    fireEvent.focus(button); fireEvent.keyDown(button, { key: "Enter" }); fireEvent.click(button); expect(onToggle).toHaveBeenCalledTimes(1);
    view.rerender(<CardPackObject identity="note" title="笔记" count={4} opened onToggle={onToggle}>四张卡</CardPackObject>);
    fireEvent.keyUp(button, { key: "Enter" }); fireEvent.pointerUp(button);
    const pose = view.container.querySelector<HTMLElement>(".card-pack-object__scene")!;
    expect(pose.style.getPropertyValue("--pack-open")).toBe("1");
    expect(pose.style.getPropertyValue("--pack-lift")).toBe("0px");
    expect(pose.style.getPropertyValue("--pack-press")).toBe("0");
    expect(frames.size).toBe(0);
  });
});
