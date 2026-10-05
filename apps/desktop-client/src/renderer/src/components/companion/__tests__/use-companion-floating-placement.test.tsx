// @vitest-environment jsdom
import { useRef } from "react";
import { createPortal } from "react-dom";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCompanionFloatingPlacement } from "../use-companion-floating-placement";
import { useCompanionSeatBudget } from "../use-companion-seat-budget";

let roleBox = { left: 1150, right: 1410, top: 420, bottom: 780, width: 260, height: 360 };
let animatedRoleBox: typeof roleBox | null = null;
let hudBox: typeof roleBox | null = null;
const bodyBox = { left: 80, right: 1010, top: 100, bottom: 750, width: 930, height: 650 };
function Harness({ papers = false, open = true, input = false, active = true, home = true, controls = true, height = 180, bounded = false }: { papers?: boolean; open?: boolean; input?: boolean; active?: boolean; home?: boolean; controls?: boolean; height?: number; bounded?: boolean }) {
  const anchor = useRef<HTMLDivElement>(null);
  const floating = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const { side, controlsSide } = useCompanionFloatingPlacement(anchor, floating, head, active);
  useCompanionSeatBudget(anchor, true, 1, "dialogue", home ? "room" : "notes");
  return <div className="desktop-app">
    <main aria-label="正文窗口" />
    <div className="companion-presence" data-surface={home ? "room" : "notes"}><div className="companion-scene-anchor"><div className="companion-visual-shell"><div className="companion-character-motion"><div className="window-live2d" /></div></div><div ref={anchor} className="companion-hud" data-controls-side={controlsSide} data-layout-width="260" data-layout-height="360">{controls ? <div className="companion-hud__controls" data-layout-width="44" data-layout-height="179"><button aria-label="气泡轻聊" /></div> : null}</div></div></div>
    {createPortal(<div ref={floating} data-side={side}><div ref={head}>{open ? input
      ? <section className="companion-hud__composer" data-layout-height="124"><textarea aria-label="轻聊输入" /></section>
      : <p data-layout-height={height} data-bounded-height={bounded || undefined}>这是真实高度的回复区域</p> : null}</div><div className="companion-hud__papers">{papers ? <article>额外的卡片内容</article> : null}</div></div>, document.body)}
  </div>;
}

beforeEach(() => {
  roleBox = { left: 1150, right: 1410, top: 420, bottom: 780, width: 260, height: 360 };
  animatedRoleBox = null;
  hudBox = null;
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return { ...(this.classList.contains("window-live2d") ? animatedRoleBox ?? roleBox : this.classList.contains("companion-visual-shell") ? roleBox : this.classList.contains("companion-hud") ? hudBox ?? roleBox : this.tagName === "MAIN" ? bodyBox : { left: 0, right: 20, top: 0, bottom: 20, width: 20, height: 20 }), x: 0, y: 0, toJSON: () => ({}) };
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return Number(this.dataset.layoutWidth) || 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    const naturalHeight = Number(this.dataset.layoutHeight) || 0;
    const cap = Number.parseFloat(this.closest<HTMLElement>("[data-side]")?.style.getPropertyValue("--companion-head-max-h") ?? "");
    return this.dataset.boundedHeight && this.style.maxHeight !== "none" && Number.isFinite(cap) ? Math.min(naturalHeight, cap) : naturalHeight;
  });
  // Animated overflow is intentionally much taller than the layout boxes.
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(680);
  vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1440);
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(810);
});

it("positions a newly opened compact input before an observer or animation frame runs", () => {
  const view = render(<Harness open={false} />);
  const floating = document.querySelector<HTMLElement>("[data-side]")!;
  expect(floating.style.getPropertyValue("--companion-head-max-h")).toBe("0px");
  view.rerender(<Harness input />);
  expect(screenInput()).toBeTruthy();
  expect(floating.style.getPropertyValue("--companion-head-w")).toBe("280px");
  expect(floating.style.getPropertyValue("--companion-head-max-h")).toBe("124px");
  expect(floating.style.getPropertyValue("--companion-head-x")).toBe("1140px");
  expect(floating.style.getPropertyValue("--companion-head-y")).toBe("280px");
  expect(floating.dataset.placementReady).toBe("true");
  expect(floating.dataset.headDock).toBe("above");
});

it("reopens at the current role position without reusing the last input's coordinates", () => {
  const view = render(<Harness input />);
  const floating = document.querySelector<HTMLElement>("[data-side]")!;
  view.rerender(<Harness open={false} input />);
  roleBox = { left: 20, right: 280, top: 420, bottom: 780, width: 260, height: 360 };
  view.rerender(<Harness input />);
  expect(floating.dataset.side).toBe("right");
  expect(floating.style.getPropertyValue("--companion-head-x")).toBe("14px");
  expect(floating.style.getPropertyValue("--companion-head-y")).toBe("280px");
});

it("uses stable layout height rather than animated scroll overflow and hides a missing anchor", () => {
  const view = render(<Harness />);
  const floating = document.querySelector<HTMLElement>("[data-side]")!;
  expect(floating.style.getPropertyValue("--companion-head-max-h")).toBe("180px");
  expect(floating.style.getPropertyValue("--companion-head-y")).toBe("224px");
  roleBox = { ...roleBox, width: 0, height: 0 };
  view.rerender(<Harness />);
  expect(floating.dataset.placementReady).toBeUndefined();
});

it("grows for a task with more results and shrinks again without reusing the old flex cap", () => {
  const view = render(<Harness height={120} bounded />);
  const floating = document.querySelector<HTMLElement>("[data-side]")!;
  expect(floating.style.getPropertyValue("--companion-head-max-h")).toBe("120px");
  view.rerender(<Harness height={310} bounded />);
  expect(floating.style.getPropertyValue("--companion-head-max-h")).toBe("310px");
  expect(floating.style.getPropertyValue("--companion-head-y")).toBe("94px");
  view.rerender(<Harness height={160} bounded />);
  expect(floating.style.getPropertyValue("--companion-head-max-h")).toBe("160px");
  expect(floating.style.getPropertyValue("--companion-head-y")).toBe("244px");
});

function screenInput() { return document.querySelector("textarea[aria-label='轻聊输入']"); }
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("coalesces seat and bubble measurements without polling or observing its own app styles", async () => {
  render(<Harness home={false} input />);
  await act(async () => { await vi.advanceTimersByTimeAsync(64); });
  const reads = vi.mocked(Element.prototype.getBoundingClientRect);
  reads.mockClear();
  act(() => {
    for (let i = 0; i < 8; i++) window.dispatchEvent(new Event("resize"));
  });
  expect(reads).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(64); });
  expect(reads).toHaveBeenCalled();
  reads.mockClear();
  await act(async () => {
    document.querySelector<HTMLElement>(".desktop-app")!.style.setProperty("--unrelated", "1");
    await vi.advanceTimersByTimeAsync(1_500);
  });
  expect(reads).not.toHaveBeenCalled();
});

it("keeps controls on the inward side while floating bubbles are blocked", () => {
  const view = render(<Harness active={false} />);
  const controls = document.querySelector<HTMLElement>("[data-controls-side]")!;
  const floating = document.querySelector<HTMLElement>("[data-side]")!;
  expect(controls.dataset.controlsSide).toBe("left");
  expect(floating.dataset.placementReady).toBeUndefined();
  roleBox = { left: 20, right: 280, top: 420, bottom: 780, width: 260, height: 360 };
  act(() => { window.dispatchEvent(new Event("resize")); vi.advanceTimersByTime(32); });
  expect(controls.dataset.controlsSide).toBe("right");
  expect(floating.dataset.placementReady).toBeUndefined();
  view.rerender(<Harness input />);
  expect(controls.dataset.controlsSide).toBe("right");
  expect(floating.dataset.side).toBe("right");
  expect(floating.dataset.placementReady).toBe("true");
});

function controlsBounds() {
  const hud = document.querySelector<HTMLElement>(".companion-hud")!;
  const box = hud.getBoundingClientRect();
  const scaleX = box.width / hud.offsetWidth;
  const scaleY = box.height / hud.offsetHeight;
  const left = box.left + Number.parseFloat(hud.style.getPropertyValue("--companion-controls-x")) * scaleX;
  const centerY = box.top + Number.parseFloat(hud.style.getPropertyValue("--companion-controls-y")) * scaleY;
  return { left, right: left + 44 * scaleX, top: centerY - 179 * scaleY / 2, bottom: centerY + 179 * scaleY / 2 };
}

it("keeps the whole control column outside either protected edge", () => {
  const view = render(<Harness active={false} />);
  expect(document.querySelector("button[aria-label='气泡轻聊']")).toBeTruthy();
  expect(controlsBounds().right).toBeLessThanOrEqual(roleBox.left - 8);
  roleBox = { left: 20, right: 280, top: 420, bottom: 780, width: 260, height: 360 };
  view.rerender(<Harness active={false} />);
  expect(document.querySelector<HTMLElement>(".companion-hud")!.dataset.controlsSide).toBe("right");
  expect(controlsBounds().left).toBeGreaterThanOrEqual(roleBox.right + 8);
});

it("follows enlarged model edges independently of HUD scale and keeps the column in the window", () => {
  hudBox = { left: 1000, right: 1325, top: 420, bottom: 870, width: 325, height: 450 };
  roleBox = { left: 960, right: 1380, top: 370, bottom: 790, width: 420, height: 420 };
  const view = render(<Harness />);
  expect(controlsBounds().right).toBeLessThanOrEqual(roleBox.left - 8);
  roleBox = { ...roleBox, top: 640, bottom: 1060 };
  view.rerender(<Harness />);
  expect(controlsBounds().right).toBeLessThanOrEqual(roleBox.left - 8);
  expect(controlsBounds().bottom).toBeLessThanOrEqual(810 - 11);
  expect(controlsBounds().top).toBeGreaterThanOrEqual(12);
});

it("uses visible task bounds for close controls and releases the unused seat on both sides", () => {
  const view = render(<Harness home={false} />);
  const hud = document.querySelector<HTMLElement>(".companion-hud")!;
  expect(document.querySelector("button[aria-label='气泡轻聊']")).toBeTruthy();
  expect(hud.dataset.controlsSide).toBe("left");
  const visual = document.querySelector<HTMLElement>(".window-live2d")!;
  const app = document.querySelector<HTMLElement>(".desktop-app")!;
  expect(controlsBounds().right).toBe(roleBox.left - 8);
  expect(app.style.getPropertyValue("--companion-seat-right")).toBe("354px");
  act(() => {
    visual.style.setProperty("--companion-model-ink-left", ".2");
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(32);
  });
  expect(controlsBounds().right).toBe(roleBox.left + 52 - 8);
  expect(app.style.getPropertyValue("--companion-seat-right")).toBe("302px");
  roleBox = { left: 20, right: 280, top: 420, bottom: 780, width: 260, height: 360 };
  view.rerender(<Harness home={false} />);
  act(() => { window.dispatchEvent(new Event("resize")); vi.advanceTimersByTime(32); });
  expect(hud.dataset.controlsSide).toBe("right");
  expect(controlsBounds().left).toBe(roleBox.right + 8);
  expect(app.style.getPropertyValue("--companion-seat-left")).toBe("344px");
  view.rerender(<Harness />);
  expect(controlsBounds().left).toBeGreaterThanOrEqual(roleBox.right + 8);
});

it("uses the real model container and ink edge, follows the role, and writes only to its overlay", () => {
  const view = render(<Harness />);
  const main = document.querySelector("main")!;
  const app = document.querySelector(".desktop-app")!;
  const visual = document.querySelector<HTMLElement>(".window-live2d")!;
  const floating = document.querySelector<HTMLElement>("[data-side]")!;
  const before = { main: main.getBoundingClientRect(), appStyle: app.getAttribute("style"), mainStyle: main.getAttribute("style") };
  act(() => { visual.style.setProperty("--companion-model-ink-top", ".32"); window.dispatchEvent(new Event("resize")); vi.advanceTimersByTime(32); });
  expect(floating.style.getPropertyValue("--companion-head-y")).toBe("339px");
  expect(floating.dataset.placementReady).toBe("true");
  view.rerender(<Harness papers />);
  act(() => { window.dispatchEvent(new Event("resize")); vi.advanceTimersByTime(32); });
  expect(main.getBoundingClientRect()).toMatchObject({ width: before.main.width, height: before.main.height, left: before.main.left, top: before.main.top, right: before.main.right, bottom: before.main.bottom });
  expect(app.getAttribute("style")).toBe(before.appStyle);
  expect(main.getAttribute("style")).toBe(before.mainStyle);
  roleBox = { left: 20, right: 280, top: 420, bottom: 780, width: 260, height: 360 };
  act(() => { window.dispatchEvent(new Event("resize")); vi.advanceTimersByTime(32); });
  expect(floating.dataset.side).toBe("right");
  expect(Number.parseFloat(floating.style.getPropertyValue("--companion-papers-x"))).toBeGreaterThan(roleBox.right);
});

it("starts task seat measurements after leaving home and clears them on return", () => {
  const view = render(<Harness />);
  const app = document.querySelector<HTMLElement>(".desktop-app")!;
  expect(document.querySelector(".window-live2d")).toBeTruthy();
  expect(app.style.getPropertyValue("--companion-seat-right")).toBe("");
  view.rerender(<Harness home={false} />);
  expect(app.style.getPropertyValue("--companion-seat-right")).toBe("354px");
  view.rerender(<Harness />);
  expect(app.style.getPropertyValue("--companion-seat-right")).toBe("");
});

it("keeps the control seat reserved while history temporarily removes the icons", () => {
  const view = render(<Harness home={false} />);
  const app = document.querySelector<HTMLElement>(".desktop-app")!;
  expect(document.querySelector("button[aria-label='气泡轻聊']")).toBeTruthy();
  expect(app.style.getPropertyValue("--companion-seat-right")).toBe("354px");
  view.rerender(<Harness home={false} controls={false} />);
  act(() => { window.dispatchEvent(new Event("resize")); vi.advanceTimersByTime(32); });
  expect(document.querySelector("button[aria-label='气泡轻聊']")).toBeNull();
  expect(app.style.getPropertyValue("--companion-seat-right")).toBe("354px");
  view.rerender(<Harness home={false} />);
  act(() => { window.dispatchEvent(new Event("resize")); vi.advanceTimersByTime(32); });
  expect(app.style.getPropertyValue("--companion-seat-right")).toBe("354px");
});

it("keeps input, rich papers, buttons and the task seat still during a character pose, then follows a real seat move", async () => {
  const view = render(<Harness home={false} input papers />);
  const floating = document.querySelector<HTMLElement>("[data-side]")!;
  const hud = document.querySelector<HTMLElement>(".companion-hud")!;
  const app = document.querySelector<HTMLElement>(".desktop-app")!;
  expect(screenInput()).toBeTruthy();
  expect(floating.dataset.placementReady).toBe("true");
  expect(app.style.getPropertyValue("--companion-seat-right")).toBe("354px");
  const before = { floating: floating.getAttribute("style"), hud: hud.getAttribute("style"), app: app.getAttribute("style"), controls: controlsBounds() };
  await act(async () => {
    animatedRoleBox = { left: 1105, right: 1455, top: 382, bottom: 804, width: 350, height: 422 };
    document.querySelector<HTMLElement>(".companion-character-motion")!.style.transform = "translateY(-8px) rotate(6deg) scale(1.06)";
    await Promise.resolve();
    vi.advanceTimersByTime(1_300);
  });
  expect(floating.getAttribute("style")).toBe(before.floating);
  expect(hud.getAttribute("style")).toBe(before.hud);
  expect(app.getAttribute("style")).toBe(before.app);
  expect(controlsBounds()).toEqual(before.controls);

  roleBox = { left: 20, right: 280, top: 420, bottom: 780, width: 260, height: 360 };
  view.rerender(<Harness home={false} input papers />);
  act(() => { window.dispatchEvent(new Event("resize")); vi.advanceTimersByTime(32); });
  expect(hud.dataset.controlsSide).toBe("right");
  expect(controlsBounds().left).toBe(288);
  expect(floating.dataset.side).toBe("right");
  expect(floating.style.getPropertyValue("--companion-head-x")).toBe("14px");
  expect(app.style.getPropertyValue("--companion-seat-left")).toBe("344px");
});

it.each(["left", "right"] as const)("brings the %s seat controls inside tail/desk bounds while protecting hair", (side) => {
  if (side === "left") roleBox = { left: 20, right: 280, top: 420, bottom: 780, width: 260, height: 360 };
  render(<Harness home={false} input />);
  const model = document.querySelector<HTMLElement>(".window-live2d")!;
  const app = document.querySelector<HTMLElement>(".desktop-app")!;
  const floating = document.querySelector<HTMLElement>("[data-side]")!;
  const originalControls = controlsBounds();
  expect(screenInput()).toBeTruthy();
  expect(floating.dataset.placementReady).toBe("true");
  act(() => {
    for (const [edge, value] of Object.entries({ left: .15, right: .65, top: .15, bottom: .65 }))
      model.style.setProperty(`--companion-model-head-${edge}`, `${value}`);
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(32);
  });
  const protectedLeft = roleBox.left + roleBox.width * .15;
  const protectedRight = roleBox.left + roleBox.width * .65;
  const closeControls = controlsBounds();
  if (side === "left") {
    expect(closeControls.left).toBe(protectedRight + 8);
    expect(closeControls.left).toBeLessThan(roleBox.right);
    expect(app.style.getPropertyValue("--companion-seat-left")).toBe("253px");
  } else {
    expect(closeControls.right).toBe(protectedLeft - 8);
    expect(closeControls.right).toBeGreaterThan(roleBox.left);
    expect(app.style.getPropertyValue("--companion-seat-right")).toBe("315px");
  }
  expect(closeControls.top).toBe(originalControls.top);
  expect(closeControls.bottom).toBe(originalControls.bottom);
  expect(Number.parseFloat(floating.style.getPropertyValue("--companion-head-y")) + 124)
    .toBeLessThanOrEqual(roleBox.top + roleBox.height * .15 - 16);
});
