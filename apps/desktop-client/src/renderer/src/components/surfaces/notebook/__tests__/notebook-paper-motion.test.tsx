// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "../../../../app/room-store";
import { useNotebookPaperMotion, useNotebookPaperPresence } from "../use-notebook-paper-motion";

const active: { animation: Animation; complete: () => void }[] = [];
const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const finished = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const animation = { finished, currentTime: 0, cancel: vi.fn(() => reject(new Error("cancelled"))) } as unknown as Animation;
  active.push({ animation, complete: resolve });
  return animation;
});
const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
function Paper({ value }: { value: string | null }) {
  const paper = useNotebookPaperPresence(value, value ?? "", "side", useNotebookPaperMotion());
  return paper.value ? <aside aria-label="旁页" aria-hidden={paper.closing || undefined} inert={paper.closing} ref={node => {
    paper.ref.current = node;
    node?.style.setProperty("--hud-ease-out", "cubic-bezier(0.23, 1, 0.32, 1)");
  }}>{paper.value}</aside> : null;
}
beforeEach(() => {
  useRoomStore.setState({ motionMode: "full", reducedMotion: false });
  active.length = 0; animate.mockClear();
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
});
afterEach(() => {
  cleanup();
  if (originalAnimate) Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
  else delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
  useRoomStore.setState({ motionMode: "full", reducedMotion: false });
});

describe("册页动效保留真实内容与最新操作", () => {
  it("首次从闭合状态打开时，真实挂载的纸页也有指针入场动效", () => {
    const view = render(<Paper value={null} />);
    expect(view.queryByRole("complementary")).toBeNull();
    fireEvent.pointerDown(document);
    view.rerender(<Paper value="首次打开" />);
    expect(view.getByRole("complementary", { name: "旁页" })).toBeTruthy();
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0]?.[1]).toMatchObject({ duration: 480, easing: "linear" });
  });

  it("快速合页再打开从当前画面继续，取消旧动画，旧完成回调不会移走新页", async () => {
    const view = render(<Paper value="资料袋" />);
    const node = view.getByRole("complementary", { name: "旁页" });
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0]?.[1]).toMatchObject({ duration: 480, easing: "linear" });
    Object.assign(active[0]!.animation, { currentTime: 160 });
    const openingFrames = animate.mock.calls[0]![0];
    const presentation = openingFrames[Math.round((160 / 480) * (openingFrames.length - 1))]!;
    view.rerender(<Paper value={null} />);
    expect(node.hasAttribute("inert")).toBe(true);
    expect(node.getAttribute("aria-hidden")).toBe("true");
    expect(active[0]?.animation.cancel).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[1]?.[0][0]?.opacity).toBeCloseTo(Number(presentation.opacity), 1);
    expect(animate.mock.calls[1]?.[0].length).toBeGreaterThan(2);
    view.rerender(<Paper value="版本历史" />);
    expect(view.getByRole("complementary", { name: "旁页" })).toBe(node);
    expect(node.hasAttribute("inert")).toBe(false);
    expect(active[1]?.animation.cancel).toHaveBeenCalledTimes(1);
    await act(async () => { active[1]?.complete(); await Promise.resolve(); });
    expect(view.getByText("版本历史")).toBeTruthy();
    view.rerender(<Paper value={null} />);
    await act(async () => { active.at(-1)?.complete(); await Promise.resolve(); });
    expect(view.queryByText("版本历史")).toBeNull();
  });

  it("键盘打开保留空间过渡，内容立即可聚焦，关闭后旧纸页立即停止交互", async () => {
    const view = render(<Paper value={null} />);
    fireEvent.keyDown(document, { key: "Enter" });
    view.rerender(<Paper value="键盘打开" />);
    const node = view.getByRole("complementary", { name: "旁页" });
    expect(animate).toHaveBeenCalledTimes(1);
    node.tabIndex = -1;
    node.focus();
    expect(document.activeElement).toBe(node);
    expect(node.hasAttribute("inert")).toBe(false);
    view.rerender(<Paper value={null} />);
    expect(node.hasAttribute("inert")).toBe(true);
    expect(animate).toHaveBeenCalledTimes(2);
    await act(async () => { active.at(-1)?.complete(); await Promise.resolve(); });
    expect(view.queryByText("键盘打开")).toBeNull();
  });

  it.each([
    { motionMode: "off" as const, reducedMotion: false },
    { motionMode: "full" as const, reducedMotion: true },
  ])("动效偏好 %j 即时切换且无过渡", preference => {
    useRoomStore.setState(preference);
    const view = render(<Paper value={null} />);
    fireEvent.keyDown(document, { key: "Enter" });
    view.rerender(<Paper value="关闭动态" />);
    expect(view.getByText("关闭动态")).toBeTruthy();
    expect(animate).not.toHaveBeenCalled();
    view.rerender(<Paper value={null} />);
    expect(view.queryByText("关闭动态")).toBeNull();
    expect(animate).not.toHaveBeenCalled();
  });

  it("Lite 保留短淡入，动效模式切换会取消正在播放的运动", () => {
    useRoomStore.setState({ motionMode: "lite" });
    const view = render(<Paper value="资料袋" />);
    expect(animate.mock.calls[0]?.[0]).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(animate.mock.calls[0]?.[1]).toMatchObject({ duration: 120 });
    act(() => useRoomStore.setState({ motionMode: "off" }));
    expect(active[0]?.animation.cancel).toHaveBeenCalledTimes(1);
    view.rerender(<Paper value={null} />);
    expect(view.queryByText("资料袋")).toBeNull();
  });
});
