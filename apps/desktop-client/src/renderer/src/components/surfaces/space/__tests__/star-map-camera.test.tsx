// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnderstandingUniverse, type UnderstandingUniverseHandle } from "../understanding-universe";
import type { GraphNode } from "../understanding-universe-data";

const nodes: GraphNode[] = ["a", "b"].map(id => ({ id, entityId: id, type: "note", label: id, description: null, state: null, parentId: null, evidenceCoverage: null, metadata: {} }));
const positions = { a: { x: 0, y: 0 }, b: { x: 600, y: 400 } };
const insets = { top: 80, bottom: 80, left: 100, right: 420 };
let time = 0, sequence = 0;
const frames = new Map<number, FrameRequestCallback>();
function advance(count: number) {
  act(() => { for (let i = 0; i < count; i++) {
    time += 1000 / 60; const current = [...frames.values()]; frames.clear(); current.forEach(callback => callback(time));
  } });
}
beforeEach(() => {
  frames.clear(); time = 0; sequence = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(700);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("星图相机与返回位置", () => {
  it("200% 的短视野仍能适配整片星空，不被原来的 12% 下限截掉边缘星体", () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(720);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(405);
    const ref = createRef<UnderstandingUniverseHandle>();
    const widePositions = { a: { x: 0, y: 0 }, b: { x: 3000, y: 2000 } };
    const compactInsets = { top: 130, bottom: 145, left: 205, right: 28 };
    render(<UnderstandingUniverse ref={ref} selectedId={null} nodes={nodes} positions={widePositions} edges={[]} onSelect={() => {}} insets={compactInsets} motionMode="off" visualStyle="cosmic" />);
    act(() => ref.current!.fit());
    const camera = ref.current!.getViewport();
    expect(camera.zoom).toBeLessThan(.12);
    for (const point of Object.values(widePositions)) {
      const x = point.x * camera.zoom + camera.offsetX;
      const y = point.y * camera.zoom + camera.offsetY;
      expect(x).toBeGreaterThanOrEqual(compactInsets.left + 16);
      expect(x).toBeLessThanOrEqual(720 - compactInsets.right - 16);
      expect(y).toBeGreaterThanOrEqual(compactInsets.top + 16);
      expect(y).toBeLessThanOrEqual(405 - compactInsets.bottom - 16);
    }
    act(() => ref.current!.zoomIn());
    expect(ref.current!.getViewport().zoom).toBeGreaterThan(camera.zoom);
  });
  it("直接拖动后刷新拓扑仍留在用户的视野，Off 松手不继续滑行", () => {
    const ref = createRef<UnderstandingUniverseHandle>();
    const view = render(<UnderstandingUniverse ref={ref} selectedId={null} nodes={nodes} positions={positions} edges={[]} onSelect={() => {}} insets={insets} motionMode="off" />);
    const canvas = view.container.querySelector("canvas")!;
    canvas.setPointerCapture = vi.fn(); canvas.hasPointerCapture = () => false;
    const start = ref.current!.getViewport();
    const pointer = (type: string, x: number, y: number) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
      Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "mouse" } });
      fireEvent(canvas, event);
    };
    pointer("pointerdown", 40, 40); pointer("pointermove", 100, 80); pointer("pointerup", 100, 80);
    const moved = ref.current!.getViewport();
    expect(moved.offsetX).toBeCloseTo(start.offsetX + 60);
    expect(moved.offsetY).toBeCloseTo(start.offsetY + 40);
    view.rerender(<UnderstandingUniverse ref={ref} selectedId={null} nodes={[...nodes]} positions={{ ...positions }} edges={[]} onSelect={() => {}} insets={insets} motionMode="off" />);
    advance(100);
    expect(ref.current!.getViewport()).toEqual(moved);
  });
  it("聚焦落在详情旁边的可见空间，Off 也立即生效", () => {
    const ref = createRef<UnderstandingUniverseHandle>();
    render(<UnderstandingUniverse ref={ref} selectedId={null} nodes={nodes} positions={positions} edges={[]} onSelect={() => {}} insets={insets} motionMode="off" visualStyle="cosmic" />);
    act(() => ref.current!.focusNode("b"));
    const camera = ref.current!.getViewport();
    expect(600 * camera.zoom + camera.offsetX).toBeCloseTo(440);
    expect(400 * camera.zoom + camera.offsetY).toBeCloseTo(350);
  });
  it("连续聚焦时从当前相机接续，不跳回起点，最后落在新目标", () => {
    const ref = createRef<UnderstandingUniverseHandle>();
    render(<UnderstandingUniverse ref={ref} selectedId={null} nodes={nodes} positions={positions} edges={[]} onSelect={() => {}} insets={insets} visualStyle="cosmic" />);
    act(() => ref.current!.focusNode("a")); advance(4);
    const moving = ref.current!.getViewport();
    act(() => ref.current!.focusNode("b"));
    expect(ref.current!.getViewport()).toEqual(moving);
    advance(100);
    const camera = ref.current!.getViewport();
    expect(600 * camera.zoom + camera.offsetX).toBeCloseTo(440);
    expect(400 * camera.zoom + camera.offsetY).toBeCloseTo(350);
  });
  it("返回位置可恢复且不被后续刷新重置，无效相机不污染当前视野", () => {
    const ref = createRef<UnderstandingUniverseHandle>();
    const view = render(<UnderstandingUniverse ref={ref} selectedId={null} nodes={nodes} positions={positions} edges={[]} onSelect={() => {}} insets={insets} motionMode="off" />);
    const saved = { offsetX: 35, offsetY: 48, zoom: .7 };
    act(() => ref.current!.restoreViewport(saved));
    view.rerender(<UnderstandingUniverse ref={ref} selectedId={null} nodes={[...nodes]} positions={{ ...positions }} edges={[]} onSelect={() => {}} insets={insets} motionMode="off" />);
    expect(ref.current!.getViewport()).toEqual(saved);
    act(() => ref.current!.restoreViewport({ offsetX: NaN, offsetY: 0, zoom: 1 }));
    expect(ref.current!.getViewport()).toEqual(saved);
    const copy = ref.current!.getViewport(); copy.offsetX = 999;
    expect(ref.current!.getViewport()).toEqual(saved);
  });
});
