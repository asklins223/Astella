// @vitest-environment jsdom
import { StrictMode, useRef } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "../../../../app/room-store";
import { useReviewDeckMotion } from "../use-review-deck-motion";

let time = 0, id = 0;
const frames = new Map<number, FrameRequestCallback>();
function advance(ms = 16) {
  act(() => {
    time += ms;
    const pending = [...frames.values()]; frames.clear();
    pending.forEach(callback => callback(time));
  });
}
function Fixture({ selected = 0 }: { selected?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const motion = useReviewDeckMotion(ref, String(selected));
  return <><div ref={ref}>
    {[0, 1].map(index => <div key={index} className="deck-card" data-testid={`card-${index}`} data-depth={index - selected} />)}
  </div><button onClick={() => { const pose = motion.grab(); motion.drag(pose.x - 40, pose.y, pose.rotate); }}>接手</button>
    <button onClick={() => motion.release(-.5)}>松手</button></>;
}
const x = (element: HTMLElement) => Number(/translate3d\(([-\d.]+)px/.exec(element.style.transform)?.[1]);
beforeEach(() => {
  time = 0; id = 0; frames.clear();
  useRoomStore.setState({ motionMode: "full", reducedMotion: false });
  vi.spyOn(performance, "now").mockImplementation(() => time);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  useRoomStore.setState({ motionMode: "full", reducedMotion: false });
});

describe("复习牌堆的连续运动", () => {
  it("往返改变目标时保留呈现位置和速度，最终安静地归位", () => {
    const view = render(<Fixture />), card = view.getByTestId("card-0");
    view.rerender(<Fixture selected={1} />);
    expect(x(card)).toBe(0);
    advance(); advance();
    const position = x(card);
    expect(position).toBeLessThan(-1);
    view.rerender(<Fixture selected={0} />);
    expect(x(card)).toBe(position);
    advance(1);
    // 改变目标后仍带着刚才的速度，不先跳回零，也不生硬地立即反向。
    expect(x(card)).toBeLessThan(position);
    for (let i = 0; i < 160; i++) advance();
    expect(x(card)).toBe(0);
    expect(frames.size).toBe(0);
  });

  it("半途抓取从当前位置接手，松手带出指针速度，卸载取消所有帧", () => {
    const view = render(<Fixture />), card = view.getByTestId("card-1");
    view.rerender(<Fixture selected={1} />); advance(); advance();
    const before = x(card);
    fireEvent.click(view.getByRole("button", { name: "接手" }));
    expect(x(card)).toBeCloseTo(before - 40);
    advance(); expect(x(card)).toBeCloseTo(before - 40);
    fireEvent.click(view.getByRole("button", { name: "松手" }));
    advance(1); expect(x(card)).toBeLessThan(before - 40);
    view.unmount(); expect(frames.size).toBe(0);
  });

  it.each([
    { motionMode: "off" as const, reducedMotion: false },
    { motionMode: "full" as const, reducedMotion: true },
  ])("%j 即刻落到最新位置，快速往返也不遗留运动", preference => {
    const view = render(<Fixture />), card = view.getByTestId("card-0");
    view.rerender(<Fixture selected={1} />); advance();
    act(() => useRoomStore.setState(preference));
    expect(card.style.transform).toBe("none");
    expect(card.style.opacity).toBe("0");
    view.rerender(<Fixture selected={0} />);
    expect(card.style.opacity).toBe("1");
    advance(); expect(frames.size).toBe(0);
  });

  it("Lite 只淡入淡出，不翻转或平移卡片", () => {
    useRoomStore.setState({ motionMode: "lite" });
    const view = render(<Fixture />), card = view.getByTestId("card-0");
    view.rerender(<Fixture selected={1} />);
    expect(card.style.transform).toBe("none");
    advance(); advance();
    expect(Number(card.style.opacity)).toBeGreaterThan(0);
    expect(Number(card.style.opacity)).toBeLessThan(1);
    for (let i = 0; i < 100; i++) advance();
    expect(card.style.opacity).toBe("0");
    expect(frames.size).toBe(0);
  });

  /**
   * 松手之后牌要回弹，是**弹簧跑起来**的结果，而弹簧要一帧一帧跑。
   * StrictMode（main.tsx 就这么挂的）把卸载也跑一遍：卸载取消掉那一帧，帧号却没
   * 交还，于是"已经有循环在跑"永远成立。牌堆从挂载那一刻起就没有弹簧了 ——
   * 拖到哪儿就停在哪儿，再也回不来（`use-tactile-surface.ts` 记着同一条，
   * 那是同一条的第一处，这里是第二处）。
   */
  it("StrictMode 跑两遍 effect，松手后牌仍弹回堆上并安静下来", () => {
    const view = render(<StrictMode><Fixture /></StrictMode>), card = view.getByTestId("card-0");
    fireEvent.click(view.getByRole("button", { name: "接手" }));
    expect(x(card)).toBe(-40);
    fireEvent.click(view.getByRole("button", { name: "松手" }));
    for (let i = 0; i < 200; i++) advance();
    expect(x(card)).toBe(0);
    expect(frames.size).toBe(0);
  });
});
