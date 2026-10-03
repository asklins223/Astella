// @vitest-environment jsdom
import { useRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "../../../../app/room-store";
import { useSourceMotion, useSourceSheetMotion } from "../use-source-motion";

let time = 0, nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();
function advance(count = 1) {
  for (let i = 0; i < count; i++) act(() => {
    time += 16; const pending = [...frames.values()]; frames.clear(); pending.forEach(frame => frame(time));
  });
}
function Fixture({ open = false, mounted = true }: { open?: boolean; mounted?: boolean }) {
  const root = useRef<HTMLDivElement>(null), sheet = useRef<HTMLElement>(null);
  useSourceMotion(root, mounted ? "mounted" : "closed"); useSourceSheetMotion(sheet, open);
  return <>{mounted ? <div ref={root}><button type="button">收下</button><button type="button" disabled>不可用</button>
    <aside ref={sheet} aria-label="附页" inert={!open}><button type="button">关闭</button></aside></div> : null}</>;
}
beforeEach(() => {
  time = 0; nextFrame = 0; frames.clear(); useRoomStore.setState({ motionMode: "full", reducedMotion: false });
  vi.spyOn(performance, "now").mockImplementation(() => time);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useRoomStore.setState({ motionMode: "full", reducedMotion: false }); });

describe("来源物件的弹性与最新意图", () => {
  it("连续按压保持当前尺寸，松到窗口外也能回弹，卸载清理帧", () => {
    const view = render(<Fixture />), button = screen.getByRole("button", { name: "收下" }); advance(100);
    fireEvent.keyDown(button, { key: " " }); advance(4);
    const pressed = button.style.getPropertyValue("--source-press"); expect(Number(pressed)).toBeLessThan(.99);
    fireEvent.keyUp(window, { key: " " }); fireEvent.keyDown(button, { key: "Enter" });
    expect(button.style.getPropertyValue("--source-press")).toBe(pressed);
    fireEvent.pointerCancel(window); advance(100);
    expect(button.style.getPropertyValue("--source-press")).toBe(""); expect(frames.size).toBe(0);
    fireEvent.keyDown(button, { key: "Enter" }); advance(2); view.unmount();
    expect(button.style.getPropertyValue("--source-press")).toBe(""); expect(frames.size).toBe(0);
  });

  it.each([{ motionMode: "lite" as const, reducedMotion: false }, { motionMode: "off" as const, reducedMotion: false },
    { motionMode: "full" as const, reducedMotion: true }])("偏好 %j 立即解除按压", preference => {
    render(<Fixture />); advance(100); const button = screen.getByRole("button", { name: "收下" });
    fireEvent.keyDown(button, { key: "Enter" }); advance(3);
    act(() => useRoomStore.setState(preference)); expect(button.style.getPropertyValue("--source-press")).toBe("");
    advance(100); expect(frames.size).toBe(0);
    fireEvent.keyDown(button, { key: " " }); advance(2); expect(button.style.getPropertyValue("--source-press")).toBe("");
  });

  it("附页快速反向从当前位置接续，关闭语义立即生效，旧帧不遮掉新打开", () => {
    const view = render(<Fixture />); advance(100); const sheet = document.querySelector("aside")!;
    view.rerender(<Fixture open />); advance(4); const current = sheet.style.transform;
    view.rerender(<Fixture />); expect(sheet.hasAttribute("inert")).toBe(true); expect(sheet.style.transform).toBe(current);
    advance(2); const returning = sheet.style.transform;
    view.rerender(<Fixture open />); expect(sheet.style.transform).toBe(returning); expect(sheet.hasAttribute("inert")).toBe(false);
    advance(120); expect(sheet.hidden).toBe(false); expect(sheet.style.opacity).toBe("1"); expect(frames.size).toBe(0);
    view.rerender(<Fixture />); advance(120); expect(sheet.hidden).toBe(true);
  });

  it.each([{ motionMode: "off" as const, reducedMotion: false }, { motionMode: "full" as const, reducedMotion: true }])("%j 开合直接呈现且不排帧", preference => {
    useRoomStore.setState(preference); const view = render(<Fixture />), sheet = document.querySelector("aside")!;
    expect(sheet.hidden).toBe(true); view.rerender(<Fixture open />);
    expect(sheet.hidden).toBe(false); expect(sheet.style.opacity).toBe("1"); expect(sheet.style.transform).toBe("none");
    view.rerender(<Fixture />); expect(sheet.hidden).toBe(true); expect(frames.size).toBe(0);
  });

  it("Lite 附页仅淡入淡出，功能不等过渡，动态挂载的控件也能按压", () => {
    useRoomStore.setState({ motionMode: "lite" }); const view = render(<Fixture />);
    view.rerender(<Fixture open />); const sheet = document.querySelector("aside")!;
    expect(sheet.hasAttribute("inert")).toBe(false); expect(sheet.style.transform).toBe("none"); advance(120);
    expect(sheet.style.opacity).toBe("1");
    view.rerender(<Fixture mounted={false} />); act(() => useRoomStore.setState({ motionMode: "full" }));
    view.rerender(<Fixture />); const button = screen.getByRole("button", { name: "收下" });
    fireEvent.keyDown(button, { key: "Enter" }); advance(3); expect(Number(button.style.getPropertyValue("--source-press"))).toBeLessThan(1);
  });
});
