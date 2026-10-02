// @vitest-environment jsdom
import { useRef } from "react";
import { createPortal } from "react-dom";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCompanionPaperPlacement } from "../use-companion-paper-placement";

let roleBox = { left: 100, right: 390, top: 530, bottom: 790, width: 290, height: 260 };
let animatedRoleBox: typeof roleBox | null = null;
function Harness({ open = true, modelVersion = 0, width = 760 }: { open?: boolean; modelVersion?: number; width?: number }) {
  const anchor = useRef<HTMLDivElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const side = useCompanionPaperPlacement(anchor, drawer, open, "left", width);
  return <div className="desktop-app">
    <main aria-label="正文窗口" />
    <div className="companion-presence"><div className="companion-visual-shell"><div className="companion-character-motion"><div className="window-live2d" key={modelVersion} /></div></div><div ref={anchor} /></div>
    {open ? createPortal(<aside ref={drawer} data-side={side} />, document.body) : null}
  </div>;
}

beforeEach(() => {
  roleBox = { left: 100, right: 390, top: 530, bottom: 790, width: 290, height: 260 };
  animatedRoleBox = null;
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return { ...(this.classList.contains("window-live2d") ? animatedRoleBox ?? roleBox : this.classList.contains("companion-visual-shell") ? roleBox : { left: 420, right: 1420, top: 80, bottom: 790, width: 1000, height: 710 }), x: 0, y: 0, toJSON: () => ({}) };
  });
  vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1440);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("follows both model edges while leaving the page and role untouched", () => {
  const view = render(<Harness open={false} />);
  const page = document.querySelector("main")!;
  const app = document.querySelector(".desktop-app")!;
  const role = document.querySelector(".window-live2d")!;
  const before = { rect: page.getBoundingClientRect(), pageStyle: page.getAttribute("style"), appStyle: app.getAttribute("style"), roleStyle: role.getAttribute("style") };
  view.rerender(<Harness />);
  const drawer = document.querySelector("aside")!;
  expect(drawer.dataset.side).toBe("right");
  expect(drawer.style.getPropertyValue("--companion-paper-x")).toBe("406px");
  expect(drawer.style.getPropertyValue("--companion-paper-w")).toBe("760px");
  roleBox = { ...roleBox, left: 1130, right: 1420 };
  act(() => { window.dispatchEvent(new Event("resize")); vi.advanceTimersByTime(32); });
  expect(drawer.dataset.side).toBe("left");
  expect(drawer.style.getPropertyValue("--companion-paper-x")).toBe("354px");
  expect(page.getBoundingClientRect()).toMatchObject({ left: before.rect.left, right: before.rect.right, top: before.rect.top, bottom: before.rect.bottom, width: before.rect.width, height: before.rect.height });
  expect(page.getAttribute("style")).toBe(before.pageStyle);
  expect(app.getAttribute("style")).toBe(before.appStyle);
  expect(role.getAttribute("style")).toBe(before.roleStyle);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("reacquires the model after a real renderer replacement", async () => {
  const view = render(<Harness />);
  expect(document.querySelector("aside")!.dataset.side).toBe("right");
  roleBox = { ...roleBox, left: 1130, right: 1420 };
  await act(async () => {
    view.rerender(<Harness modelVersion={1} />);
    await Promise.resolve();
  });
  act(() => { vi.advanceTimersByTime(32); });
  expect(document.querySelector("aside")!.dataset.side).toBe("left");
  expect(document.querySelector("aside")!.style.getPropertyValue("--companion-paper-x")).toBe("354px");
});

it("places a settings paper beside the right role before paint and follows it to the left", () => {
  roleBox = { ...roleBox, left: 1130, right: 1420 };
  const view = render(<Harness width={340} />);
  const paper = document.querySelector("aside")!;
  expect(paper.dataset.placementReady).toBe("true");
  expect(paper.dataset.side).toBe("left");
  expect(paper.style.getPropertyValue("--companion-paper-x")).toBe("774px");
  expect(paper.style.getPropertyValue("--companion-paper-w")).toBe("340px");
  expect(document.querySelector(".window-live2d")!.getAttribute("style")).toBeNull();
  expect(document.querySelector("main")!.getAttribute("style")).toBeNull();
  roleBox = { ...roleBox, left: 100, right: 390 };
  act(() => { window.dispatchEvent(new Event("resize")); vi.advanceTimersByTime(32); });
  expect(paper.dataset.side).toBe("right");
  expect(paper.style.getPropertyValue("--companion-paper-x")).toBe("406px");
  roleBox = { ...roleBox, width: 0 };
  act(() => { window.dispatchEvent(new Event("resize")); vi.advanceTimersByTime(32); });
  expect(paper.dataset.placementReady).toBeUndefined();
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([340, 760])("keeps a %ipx paper still during a pose, while following the seat itself", async (width) => {
  render(<Harness width={width} />);
  const paper = document.querySelector("aside")!;
  expect(paper.dataset.placementReady).toBe("true");
  expect(paper.style.getPropertyValue("--companion-paper-x")).toBe("406px");
  const before = paper.getAttribute("style");
  await act(async () => {
    animatedRoleBox = { left: 70, right: 430, top: 515, bottom: 795, width: 360, height: 280 };
    document.querySelector<HTMLElement>(".companion-character-motion")!.style.transform = "rotate(-8deg) scale(1.04)";
    await Promise.resolve();
    vi.advanceTimersByTime(1_300);
  });
  expect(paper.getAttribute("style")).toBe(before);
  roleBox = { ...roleBox, left: 1130, right: 1420 };
  act(() => { window.dispatchEvent(new Event("resize")); vi.advanceTimersByTime(32); });
  expect(paper.dataset.side).toBe("left");
  expect(paper.style.getPropertyValue("--companion-paper-x")).toBe(`${1130 - 16 - width}px`);
});

it.each([340, 760])("places a %ipx paper close to hair instead of clearing the tail", (width) => {
  render(<Harness width={width} />);
  const paper = document.querySelector("aside")!;
  const model = document.querySelector<HTMLElement>(".window-live2d")!;
  expect(paper.dataset.placementReady).toBe("true");
  act(() => {
    model.style.setProperty("--companion-model-head-left", ".1");
    model.style.setProperty("--companion-model-head-right", ".8");
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(32);
  });
  expect(paper.dataset.side).toBe("right");
  expect(paper.style.getPropertyValue("--companion-paper-x")).toBe("348px");
  expect(348).toBeLessThan(roleBox.right);
  roleBox = { ...roleBox, left: 1130, right: 1420 };
  act(() => { window.dispatchEvent(new Event("resize")); vi.advanceTimersByTime(32); });
  expect(paper.dataset.side).toBe("left");
  expect(paper.style.getPropertyValue("--companion-paper-x")).toBe(`${1159 - 16 - width}px`);
});

it("coalesces repeated geometry signals and stops reading after the seat settles", async () => {
  render(<Harness />);
  const reads = vi.mocked(Element.prototype.getBoundingClientRect);
  reads.mockClear();
  act(() => {
    for (let i = 0; i < 8; i++) window.dispatchEvent(new Event("resize"));
  });
  expect(reads).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(32); });
  expect(reads).toHaveBeenCalled();
  reads.mockClear();
  await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
  expect(reads).not.toHaveBeenCalled();
});
