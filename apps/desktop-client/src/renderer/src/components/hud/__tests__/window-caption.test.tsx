// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowCaption } from "../window-caption";
import type { AstellaWindowFrame } from "../../../../../shared/window-frame";

type FrameListener = (frame: AstellaWindowFrame) => void;

function stubDesktop() {
  let listener: FrameListener | null = null;
  const controlWindow = vi.fn();
  Object.defineProperty(window, "astellaDesktop", {
    configurable: true,
    value: {
      platform: "win32",
      controlWindow,
      onWindowFrame: (next: FrameListener) => {
        listener = next;
        return () => { listener = null; };
      }
    }
  });
  return { controlWindow, publish: (frame: AstellaWindowFrame) => (listener as FrameListener)?.(frame) };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as Partial<Window>).astellaDesktop;
  delete document.documentElement.dataset.windowFrame;
});

describe("Windows 自绘标题按钮", () => {
  it("三个按钮都在，动作打到主进程", () => {
    const { controlWindow } = stubDesktop();
    render(<WindowCaption />);

    fireEvent.click(screen.getByRole("button", { name: "最小化" }));
    fireEvent.click(screen.getByRole("button", { name: "最大化" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    expect(controlWindow.mock.calls.map(([action]) => action)).toEqual(["minimize", "toggle-maximize", "close"]);
  });

  it("最大化之后中间那颗变成还原，形状记在文档根", () => {
    const { controlWindow, publish } = stubDesktop();
    const { container } = render(<WindowCaption />);

    expect(document.documentElement.dataset.windowFrame).toBe("floating");
    expect(container.querySelector(".window-caption")?.getAttribute("data-window-frame")).toBe("floating");

    act(() => publish("maximized"));

    expect(screen.getByRole("button", { name: "还原" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "最大化" })).toBeNull();
    expect(document.documentElement.dataset.windowFrame).toBe("maximized");

    act(() => publish("floating"));
    fireEvent.click(screen.getByRole("button", { name: "最大化" }));
    expect(controlWindow).toHaveBeenLastCalledWith("toggle-maximize");
  });

  it("退订之后不再接收形状推送", () => {
    const { publish } = stubDesktop();
    const view = render(<WindowCaption />);

    view.unmount();
    expect(() => act(() => publish("fullscreen"))).not.toThrow();
    expect(document.documentElement.dataset.windowFrame).toBe("floating");
  });
});
