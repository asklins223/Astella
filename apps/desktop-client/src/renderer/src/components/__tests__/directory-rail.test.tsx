// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "../../app/room-store.ts";
import { DirectoryRail, DIRECTORY_RAIL_MODE_KEY } from "../DirectoryRail.tsx";

/** Directory motion: stable icon layout, one spring and immediate controls. */

const RAIL_EXPANDED = { left: 22, top: 84, width: 58, height: 703 };
const RAIL_COLLAPSED = { left: 22, top: 741, width: 50, height: 46 };

type Frame = Record<string, string | number>;
const animated: { element: Element; selector: string; frames: Frame[]; animation: Animation }[] = [];

function rectOf(element: Element) {
  const base = element.classList.contains("hud-rail") && !element.classList.contains("nav-morph-ghost")
    ? (document.querySelector(".desktop-app")?.classList.contains("nav-collapsed") ? RAIL_COLLAPSED : RAIL_EXPANDED)
    // 幽灵永远画的是"收起之前"那一列。
    : element.classList.contains("nav-morph-ghost")
      ? RAIL_EXPANDED
      : element.classList.contains("nav-collapse")
        ? (document.querySelector(".desktop-app")?.classList.contains("nav-collapsed")
          ? { left: 26, top: 745, width: 42, height: 38 } : { left: 34, top: 751, width: 34, height: 26 })
        : element.classList.contains("content")
          ? { left: document.querySelector(".nav-collapsed") ? 100 : 130, top: 100, width: 800, height: 600 }
        : element.classList.contains("nav-chip") ? { left: 29.5, top: 95, width: 43, height: 43 }
          : { left: 400, top: 100, width: 800, height: 600 };
  return {
    ...base,
    right: base.left + base.width,
    bottom: base.top + base.height,
    x: base.left,
    y: base.top,
  };
}

function stubPaintSurface() {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
    return rectOf(this) as unknown as DOMRect;
  };
  Element.prototype.animate = function animate(this: Element, keyframes: unknown) {
    const selector = this.classList.contains("nav-morph-ghost")
      ? "ghost"
      : this.classList.contains("hud-rail") ? "rail" : "other";
    const animation = {
      cancel() {},
      commitStyles() {},
      onfinish: null,
      oncancel: null,
      playState: "running",
    } as unknown as Animation;
    animated.push({ element: this, selector, frames: keyframes as Frame[], animation });
    return animation;
  } as unknown as typeof Element.prototype.animate;
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  animated.length = 0;
  stubPaintSurface();
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockReturnValue(0);
  window.localStorage.setItem(DIRECTORY_RAIL_MODE_KEY, "auto");
  useRoomStore.setState({ motionMode: "full", reducedMotion: false });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
  useRoomStore.setState({ surface: null });
});

describe("自动模式只在书房里收起这一列", () => {
  it("任务页开着时不再展开—收起循环：笔记详情页量到的是 30px 的正文位移", () => {
    useRoomStore.setState({ surface: "notebook" });
    render(<div className="desktop-app hud-surface"><DirectoryRail /></div>);
    advance(5_000);

    const app = document.querySelector<HTMLElement>(".desktop-app");
    expect(app?.dataset.directoryRail).toBe("expanded");
    expect(app?.classList.contains("nav-collapsed")).toBe(false);
  });

  it("回到书房仍然按原来的节奏收起，让场景露出来", () => {
    useRoomStore.setState({ surface: null });
    render(<div className="desktop-app hud-surface"><DirectoryRail /></div>);
    advance(1_000);
    expect(document.querySelector<HTMLElement>(".desktop-app")?.dataset.directoryRail).toBe("expanded");
    advance(2_000);
    expect(document.querySelector<HTMLElement>(".desktop-app")?.dataset.directoryRail).toBe("collapsed");
  });
});

describe("连续、可打断的目录形变", () => {
  it("收起的项目离开焦点路径；展开后可以立即切页并释放旧动画", () => {
    window.localStorage.setItem(DIRECTORY_RAIL_MODE_KEY, "expanded");
    useRoomStore.setState({ surface: null });
    render(<div className="desktop-app hud-surface"><DirectoryRail /></div>);
    fireEvent.click(screen.getByRole("button", { name: "收起目录" }));
    const source = document.querySelector<HTMLButtonElement>('.nav-chip[aria-label="来源"]')!;
    expect(source.tabIndex).toBe(-1);
    expect(source.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "展开目录" }));
    expect(source.tabIndex).toBe(0);
    expect(source.hasAttribute("aria-hidden")).toBe(false);
    expect(document.querySelector(".nav-morph-ghost")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "来源" }));
    expect(useRoomStore.getState().surface).toBe("source-library");
    expect(document.querySelector(".nav-morph-ghost")).toBeNull();
    expect(document.querySelector("[data-rail-morphing]")).toBeNull();
  });

  it("正文 FLIP 完成不会写回旧 transform、覆盖正在进行的切页动效", () => {
    window.localStorage.setItem(DIRECTORY_RAIL_MODE_KEY, "expanded");
    render(<div className="desktop-app hud-surface"><main className="content" style={{ transform: "scale(.98)" }} /><DirectoryRail /></div>);
    fireEvent.click(screen.getByRole("button", { name: "收起目录" }));
    const content = document.querySelector<HTMLElement>(".content")!;
    const flip = animated.find(entry => entry.element === content)!;
    content.style.transform = "translateY(5px)";
    flip.animation.onfinish?.(new Event("finish") as AnimationPlaybackEvent);
    expect(content.style.transform).toBe("translateY(5px)");
  });

  it("冻结列仍在 HUD 作用域内，保持图标居中且首帧不先横移", () => {
    window.localStorage.setItem(DIRECTORY_RAIL_MODE_KEY, "expanded");
    const style = document.createElement("style");
    style.textContent = ".hud-surface .nav-chip { display:grid; place-items:center; }";
    document.head.append(style);
    render(<div className="desktop-app hud-surface"><DirectoryRail /></div>);
    fireEvent.click(screen.getByRole("button", { name: "收起目录" }));
    const ghost = document.querySelector<HTMLElement>(".nav-morph-ghost")!;
    expect(ghost.closest(".hud-surface")).toBe(document.querySelector(".desktop-app"));
    const iconButton = ghost.querySelector<HTMLElement>(".nav-chip")!;
    expect(getComputedStyle(iconButton).placeItems).toBe("center");
    expect(Number.parseFloat(ghost.style.left) + Number.parseFloat(iconButton.style.left)).toBe(29.5);
    const iconMotion = animated.find(entry => entry.element === iconButton)!;
    expect(iconMotion.frames[0].transform).toBe("translate3d(0px, 0px, 0)");
    expect(iconMotion.frames[0].opacity).toBe(1);
    expect(screen.getByRole("button", { name: "展开目录" })).toBeTruthy();
    style.remove();
  });

  it("换向承接当前弹簧状态；旧完成回调不会清掉最新动画", () => {
    window.localStorage.setItem(DIRECTORY_RAIL_MODE_KEY, "expanded");
    render(<div className="desktop-app hud-surface"><DirectoryRail /></div>);
    fireEvent.click(screen.getByRole("button", { name: "收起目录" }));
    const original = animated.find(entry => entry.element.classList.contains("directory-rail-skin"))!;
    const initialIcon = animated.find(entry => entry.element.classList.contains("nav-chip"))!;
    const ghost = document.querySelector(".nav-morph-ghost");
    vi.mocked(performance.now).mockReturnValue(72);
    fireEvent.click(screen.getByRole("button", { name: "展开目录" }));
    expect(document.querySelectorAll(".nav-morph-ghost")).toHaveLength(1);
    expect(document.querySelector(".nav-morph-ghost")).toBe(ghost);
    const reversedIcon = animated.filter(entry => entry.element === initialIcon.element).at(-1)!;
    expect(Number(reversedIcon.frames[0].opacity)).toBeCloseTo(Number(initialIcon.frames[6].opacity), 6);
    expect(Number(reversedIcon.frames[0].opacity)).toBeGreaterThan(0);
    expect(Number(reversedIcon.frames[0].opacity)).toBeLessThan(1);
    original.animation.onfinish?.(new Event("finish") as AnimationPlaybackEvent);
    expect(document.querySelector(".nav-morph-ghost")).toBe(ghost);
    advance(1_200);
    expect(document.querySelector(".nav-morph-ghost")).toBeNull();
    expect(document.querySelector("[data-rail-morphing]")).toBeNull();
    expect(document.querySelector<HTMLElement>(".desktop-app")?.dataset.directoryRail).toBe("expanded");
  });

  it("中途切到 Off 或系统减少动态，立即释放动画并落到目标", () => {
    window.localStorage.setItem(DIRECTORY_RAIL_MODE_KEY, "expanded");
    render(<div className="desktop-app hud-surface"><DirectoryRail /></div>);
    fireEvent.click(screen.getByRole("button", { name: "收起目录" }));
    expect(document.querySelector(".nav-morph-ghost")).toBeTruthy();
    act(() => useRoomStore.setState({ reducedMotion: true }));
    expect(document.querySelector(".nav-morph-ghost")).toBeNull();
    expect(document.querySelector("[data-rail-morphing]")).toBeNull();
    expect(screen.getByRole("button", { name: "展开目录" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "展开目录" }));
    expect(document.querySelector(".nav-morph-ghost")).toBeNull();
    expect(screen.getByRole("button", { name: "收起目录" })).toBeTruthy();
  });
});
