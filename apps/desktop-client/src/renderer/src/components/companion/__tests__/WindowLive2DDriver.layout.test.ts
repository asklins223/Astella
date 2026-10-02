// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WindowLive2DDriver } from "../WindowLive2DDriver";
import { WINDOW_LIVE2D_ASSETS } from "../window-live2d-contract";

vi.mock("../live2d-performance-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../live2d-performance-catalog")>();
  return { ...actual, loadWindowLive2DCatalog: vi.fn(async () => actual.EMPTY_WINDOW_LIVE2D_CATALOG) };
});

function point() {
  return { x: 0, y: 0, set(x: number, y = x) { this.x = x; this.y = y; } };
}
function modelFixture() {
  const boxes = [{ x: 200, y: 200, width: 500, height: 600 }];
  const parts = { ids: ["Part14"], parentIndices: [-1] };
  const drawableParts = [0];
  const listeners = new Map<string, () => void>();
  const write = vi.fn();
  const model = {
    anchor: point(), position: point(), scale: point(), alpha: 1,
    update: vi.fn(),
    motion: vi.fn(async () => undefined), destroy: vi.fn(),
    internalModel: {
      originalWidth: 1000, originalHeight: 1000,
      coreModel: { setParameterValueById: write, getDrawableCount: () => boxes.length, getDrawableOpacity: () => 1,
        getModel: () => ({ parts, drawables: { parentPartIndices: drawableParts } }) },
      getDrawableBounds: (index: number) => boxes[index],
      on: (event: string, listener: () => void) => listeners.set(event, listener),
      off: (event: string) => listeners.delete(event),
    },
  };
  return { model, boxes, parts, drawableParts, write, update: () => listeners.get("beforeModelUpdate")?.() };
}

let fixture: ReturnType<typeof modelFixture>;
let driver: WindowLive2DDriver;
let container: HTMLDivElement;
let size: { width: number; height: number };
let nextFixture: ReturnType<typeof modelFixture>;
let ticker: { add: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; deltaMS: number; maxFPS: number };
let resizeRenderer: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.useFakeTimers();
  fixture = modelFixture();
  nextFixture = fixture;
  size = { width: 200, height: 200 };
  ticker = { add: vi.fn(), remove: vi.fn(), start: vi.fn(), stop: vi.fn(), deltaMS: 1000 / 60, maxFPS: 0 };
  resizeRenderer = vi.fn();
  vi.spyOn(document, "baseURI", "get").mockReturnValue("https://study.test/");
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("Live2DCubismCore", {});
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true,
    json: async () => JSON.parse(readFileSync(new NodeURL(`../../../../public${new NodeURL(url).pathname}`, import.meta.url), "utf8")),
  })));
  vi.stubGlobal("PIXI", {
    Application: class {
      stage = { addChild() {}, removeChild() {} };
      renderer = { render: () => nextFixture.update(), resize: resizeRenderer };
      ticker = ticker;
      destroy() {}
    },
    live2d: { Live2DModel: { from: vi.fn(async () => nextFixture.model) } },
  });
  for (const path of WINDOW_LIVE2D_ASSETS.vendorScripts) {
    const script = document.createElement("script");
    script.dataset.windowLive2dSrc = new URL(path, document.baseURI).href;
    script.dataset.loaded = "true";
    document.head.appendChild(script);
  }
  container = document.createElement("div");
  vi.spyOn(container, "clientWidth", "get").mockImplementation(() => size.width);
  vi.spyOn(container, "clientHeight", "get").mockImplementation(() => size.height);
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "getContext", { value: () => ({ MAX_TEXTURE_IMAGE_UNITS: 1, getParameter: () => 8 }) });
  const onStatus = vi.fn();
  driver = new WindowLive2DDriver({ canvas, container, onStatus });
  await driver.init();
  expect(onStatus).toHaveBeenLastCalledWith("ready");
  expect(container.style.getPropertyValue("--companion-model-ink-left")).toBe("0.0900");
});

afterEach(() => {
  driver?.destroy();
  document.head.replaceChildren();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

function animateDrawables() {
  Object.assign(fixture.boxes[0], { x: 80, y: 100, width: 800, height: 900 });
  fixture.boxes.push({ x: 10, y: 70, width: 150, height: 200 });
}

it("advances model time only on its capped private draw clock and stops while paused", () => {
  expect(ticker.maxFPS).toBe(60);
  expect((window as unknown as { PIXI: { live2d: { Live2DModel: { from: ReturnType<typeof vi.fn> } } } }).PIXI.live2d.Live2DModel.from)
    .toHaveBeenCalledWith(expect.any(String), { autoInteract: false, autoUpdate: false });
  const [advance, , priority] = ticker.add.mock.calls[0];
  expect(priority).toBeGreaterThan(-25);
  advance();
  expect(fixture.model.update).toHaveBeenLastCalledWith(1000 / 60);
  driver.setPaused(true);
  advance();
  expect(fixture.model.update).toHaveBeenCalledTimes(1);
  driver.setPaused(false);
  advance();
  expect(fixture.model.update).toHaveBeenCalledTimes(2);
  driver.destroy();
  expect(ticker.remove).toHaveBeenCalledWith(advance);
});

it("does not rebuild the backing surface for duplicate resize signals", () => {
  window.dispatchEvent(new Event("resize"));
  expect(resizeRenderer).not.toHaveBeenCalled();
  size = { width: 300, height: 240 };
  window.dispatchEvent(new Event("resize"));
  window.dispatchEvent(new Event("resize"));
  expect(resizeRenderer).toHaveBeenCalledTimes(1);
});

it("keeps published layout edges still while the model breathes, speaks and shows a prop", async () => {
  const before = container.getAttribute("style");
  animateDrawables();
  driver.setVoiceLevel(.7);
  driver.pushToolAttention();
  vi.advanceTimersByTime(500);
  fixture.write.mockClear();
  fixture.update();
  await Promise.resolve();
  expect(fixture.write).toHaveBeenCalled();
  expect(container.getAttribute("style")).toBe(before);
  driver.setPaused(true);
  expect(container.getAttribute("style")).toBe(before);
});

it("reprojects the same shape on resize even when a motion is in progress", () => {
  animateDrawables();
  size = { width: 300, height: 240 };
  window.dispatchEvent(new Event("resize"));
  expect(container.style.getPropertyValue("--companion-model-ink-left")).toBe("0.1733");
  expect(container.style.getPropertyValue("--companion-model-ink-right")).toBe("0.8267");
  expect(container.style.getPropertyValue("--companion-model-ink-bottom")).toBe("0.9833");
});

it("takes a new layout shape when the actual model changes", async () => {
  const before = container.getAttribute("style");
  nextFixture = modelFixture();
  nextFixture.parts.ids[0] = "PartHairFront";
  Object.assign(nextFixture.boxes[0], { x: 300, y: 250, width: 400, height: 500 });
  const switching = driver.setModel("mao-pro");
  await vi.advanceTimersByTimeAsync(700);
  await switching;
  expect(fixture.model.destroy).toHaveBeenCalledOnce();
  expect(container.getAttribute("style")).not.toBe(before);
  expect(container.style.getPropertyValue("--companion-model-ink-left")).toBe("0.1000");
  expect(container.style.getPropertyValue("--companion-model-head-left")).toBe("0.1000");
});

it("keeps a separate fixed hair shape when the tail and table extend beyond it", async () => {
  nextFixture = modelFixture();
  nextFixture.parts.ids.splice(0, 1, "PartHairFront", "Tail", "Desk");
  nextFixture.parts.parentIndices.splice(0, 1, -1, -1, -1);
  nextFixture.drawableParts.splice(0, 1, 0, 1, 2);
  nextFixture.boxes.splice(0, 1,
    { x: 300, y: 200, width: 300, height: 350 },
    { x: 550, y: 550, width: 400, height: 200 },
    { x: 100, y: 650, width: 500, height: 200 });
  const switching = driver.setModel("mao-pro");
  await vi.advanceTimersByTimeAsync(700);
  await switching;
  const edge = (region: string, side: string) => Number.parseFloat(container.style.getPropertyValue(`--companion-model-${region}-${side}`));
  expect(edge("head", "left")).toBeGreaterThan(edge("ink", "left"));
  expect(edge("head", "right")).toBeLessThan(edge("ink", "right"));
  expect(edge("head", "top")).toBeLessThan(edge("head", "bottom"));
  const before = container.getAttribute("style");
  Object.assign(nextFixture.boxes[0], { x: 250, width: 400 });
  Object.assign(nextFixture.boxes[1], { x: 20, width: 1100 });
  driver.setVoiceLevel(.7);
  vi.advanceTimersByTime(500);
  nextFixture.write.mockClear();
  nextFixture.update();
  expect(nextFixture.write).toHaveBeenCalled();
  driver.setPaused(true);
  expect(container.getAttribute("style")).toBe(before);
});
