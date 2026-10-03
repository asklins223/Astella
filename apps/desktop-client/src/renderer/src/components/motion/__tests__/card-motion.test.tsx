// @vitest-environment jsdom
import { useRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "../../../app/room-store";
import { stepCardSpring } from "../card-spring";
import { useCardTactile } from "../use-card-tactile";
import { createCandidateCardSpring } from "../../surfaces/review/candidate-card-spring";
import { createCardObjectSpring, useCardPaperArrival } from "../card-object-spring";

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

describe("候选纸面的可打断弹簧", () => {
  it("同一段运动不受帧切分影响", () => {
    const state = { position: 16, velocity: 80 };
    const one = stepCardSpring(state, 180, .032);
    const two = stepCardSpring(stepCardSpring(state, 180, .016), 180, .016);
    expect(one.position).toBeCloseTo(two.position, 10);
    expect(one.velocity).toBeCloseTo(two.velocity, 10);
  });
  it("快速反向从当前角度接续，最终回到最新选择", () => {
    const host = document.createElement("div"), controller = createCandidateCardSpring(host);
    const angle = () => parseFloat(host.style.getPropertyValue("--candidate-flip-turn"));
    controller.setBack(true); advance(4);
    const before = angle(); expect(before).toBeGreaterThan(0); expect(before).toBeLessThan(180);
    controller.setBack(false);
    expect(angle()).toBe(before);
    advance(); expect(Math.abs(angle() - before)).toBeLessThan(25);
    advance(100); expect(angle()).toBe(0); expect(frames.size).toBe(0);
    controller.destroy();
  });
  it("切到 Off 立即静止，销毁后没有残留姿态或帧循环", () => {
    const host = document.createElement("div"), controller = createCandidateCardSpring(host);
    controller.setBack(true); controller.tilt(1, 1); advance(3);
    controller.setMode("off");
    expect(frames.size).toBe(0);
    expect(host.style.getPropertyValue("--candidate-flip-turn")).toBe("0deg");
    expect(host.style.getPropertyValue("--candidate-lift")).toBe("0px");
    controller.destroy(); expect(host.style.length).toBe(0);
  });
  it("Lite 只有淡入，题面不旋转或位移", () => {
    const host = document.createElement("div"), controller = createCandidateCardSpring(host);
    controller.setMode("lite"); controller.setBack(true); controller.arrive(); advance();
    expect(host.style.getPropertyValue("--candidate-flip-turn")).toBe("0deg");
    expect(host.style.getPropertyValue("--candidate-lift")).toBe("0px");
    expect(Number(host.style.getPropertyValue("--candidate-paper-opacity"))).toBeLessThan(1);
    advance(100); expect(host.style.getPropertyValue("--candidate-paper-opacity")).toBe("1"); controller.destroy();
  });
});

function Controls({ onClick = () => undefined }: { onClick?: () => void }) {
  const ref = useRef<HTMLDivElement>(null); useCardTactile(ref);
  return <div ref={ref}><button onClick={onClick}>保留</button><button disabled>正在保存</button><div inert><button>隐藏题面</button></div></div>;
}
const scale = (button: HTMLElement) => Number(button.style.getPropertyValue("--card-touch-scale") || "1");

describe("卡片控件的触感不阻塞操作", () => {
  it("点击即时执行，松手后有小幅回弹并停止运算", () => {
    const onClick = vi.fn(); render(<Controls onClick={onClick} />);
    const button = screen.getByRole("button", { name: "保留" });
    fireEvent(button, new MouseEvent("pointerdown", { button: 0, bubbles: true })); advance(4);
    expect(scale(button)).toBeLessThan(1);
    fireEvent.click(button); expect(onClick).toHaveBeenCalledTimes(1);
    fireEvent(window, new MouseEvent("pointerup"));
    let largest = 1;
    for (let i = 0; i < 30; i++) { advance(); largest = Math.max(largest, scale(button)); }
    expect(largest).toBeGreaterThan(1);
    advance(100); expect(button.style.getPropertyValue("--card-touch-scale")).toBe(""); expect(frames.size).toBe(0);
  });
  it("键盘按压也有反馈，Off 切换即时清除进行中的反馈", () => {
    render(<Controls />); const button = screen.getByRole("button", { name: "保留" }); button.focus();
    fireEvent.keyDown(button, { key: "Enter" }); advance(3); expect(scale(button)).toBeLessThan(1);
    act(() => useRoomStore.setState({ motionMode: "off" }));
    expect(scale(button)).toBe(1); expect(frames.size).toBe(0); expect(document.activeElement).toBe(button);
    fireEvent.keyDown(button, { key: "Enter" }); expect(frames.size).toBe(0);
  });
  it("禁用、隐藏与系统减少动态时都不启动按压运动", () => {
    const { container } = render(<Controls />);
    for (const button of container.querySelectorAll("button")) {
      if (button.textContent === "保留") continue;
      fireEvent(button, new MouseEvent("pointerdown", { button: 0, bubbles: true }));
    }
    expect(frames.size).toBe(0);
    act(() => useRoomStore.setState({ reducedMotion: true }));
    fireEvent.keyDown(screen.getByRole("button", { name: "保留" }), { key: " " }); expect(frames.size).toBe(0);
  });
});

describe("书桌物件的连续运动", () => {
  it("反向切换保留当前位置和速度，最后停在最新目标", () => {
    const host = document.createElement("div"), object = createCardObjectSpring(host);
    object.target({ x: 100 }); advance(4);
    const before = object.pose().x;
    object.target({ x: -100 });
    expect(object.pose().x).toBe(before);
    advance(); expect(Math.abs(object.pose().x - before)).toBeLessThan(25);
    advance(100); expect(object.pose().x).toBe(-100); expect(frames.size).toBe(0);
    object.destroy();
  });
  it("抓住纸面立即跟手，松手回弹可以再次打断", () => {
    const object = createCardObjectSpring(document.createElement("div"));
    object.grab({ x: 80, rotate: 4 }); expect(object.pose().x).toBe(80);
    object.target({ x: 0, rotate: 0 }); advance(3);
    object.grab({ x: -24, rotate: -1 }); expect(object.pose().x).toBe(-24);
    object.target({ x: 0, rotate: 0 }); advance(100);
    expect(object.pose().x).toBe(0); expect(frames.size).toBe(0); object.destroy();
  });
  it("Off 立即清除运动并完成收尾，销毁不留下帧或样式", () => {
    const host = document.createElement("div"), object = createCardObjectSpring(host);
    object.target({ open: 0 }); object.kick({ y: -300 }); advance(3);
    const settled = vi.fn(); object.settled(settled); object.mode("off");
    expect(settled).toHaveBeenCalledTimes(1); expect(frames.size).toBe(0);
    expect(object.pose()).toEqual({ x: 0, y: 0, rotate: 0, scale: 1, open: 0 });
    object.destroy(); expect(host.style.length).toBe(0); expect(host.dataset.objectMotion).toBeUndefined();
  });
  it("Lite 和 Off 中选中标记仍立即定位到最新选项", () => {
    const host = document.createElement("div"), object = createCardObjectSpring(host, {}, { layoutPosition: true });
    object.target({ x: 240, y: 7 }); advance(3); object.mode("lite");
    expect(host.style.getPropertyValue("--card-object-x")).toBe("240px");
    object.target({ x: 360, y: 12 }); object.kick({ rotate: 55 });
    expect(host.style.getPropertyValue("--card-object-x")).toBe("360px");
    expect(host.style.getPropertyValue("--card-object-rotate")).toBe("0deg");
    object.mode("off"); expect(object.pose().x).toBe(360); expect(frames.size).toBe(0); object.destroy();
  });
  it("输入和计时重渲染不重播到场动画，系统减少动态立即收敛", () => {
    function Paper({ page, value }: { page: string | null; value: string }) {
      const ref = useRef<HTMLElement>(null); useCardPaperArrival(ref, page);
      return <article ref={ref}>{value}</article>;
    }
    const view = render(<Paper page="answer-one" value="" />); advance(100);
    view.rerender(<Paper page="answer-one" value="开始作答" />);
    expect(frames.size).toBe(0);
    view.rerender(<Paper page="answer-two" value="" />); advance(2);
    act(() => useRoomStore.setState({ reducedMotion: true }));
    expect(frames.size).toBe(0);
    expect(view.container.querySelector("article")?.style.getPropertyValue("--card-object-y")).toBe("0px");
  });
});
