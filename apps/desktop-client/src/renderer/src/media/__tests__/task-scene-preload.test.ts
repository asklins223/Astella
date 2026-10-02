// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import sourceManifest from "../../../public/assets/learning-room/v1/manifest.json";
import { mediaAssetUrl, parseLearningRoomManifest } from "../learning-room-manifest";

const manifest = parseLearningRoomManifest(sourceManifest);
let sequence = 0;
let idle: Map<number, () => void>;
let images: Array<{ src: string; decoding: string; resolve: () => void; reject: () => void }>;

beforeEach(() => {
  vi.resetModules();
  idle = new Map();
  images = [];
  vi.stubGlobal("requestIdleCallback", vi.fn((callback: () => void) => {
    const id = ++sequence;
    idle.set(id, callback);
    return id;
  }));
  vi.stubGlobal("cancelIdleCallback", vi.fn((id: number) => idle.delete(id)));
  vi.stubGlobal("Image", class {
    src = "";
    decoding = "";
    decode() {
      return new Promise<void>((resolve, reject) => {
        images.push({ src: this.src, decoding: this.decoding, resolve, reject: () => reject(new Error("decode failed")) });
      });
    }
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

function runIdle() {
  const [id, callback] = idle.entries().next().value!;
  idle.delete(id);
  callback();
}
async function flushDecode() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

it("warms only the current theme, serially in idle time, and cancels the pending next plate", async () => {
  const { scheduleTaskScenePreload } = await import("../task-scene-preload");
  const cancel = scheduleTaskScenePreload(manifest, "day");
  expect(images).toHaveLength(0);
  expect(idle.size).toBe(1);
  runIdle();
  expect(images).toHaveLength(1);
  expect(images[0].decoding).toBe("async");
  expect(images[0].src).toBe(mediaAssetUrl(manifest, manifest.taskPosters.library.day.path));
  expect(idle.size).toBe(0);
  images[0].resolve();
  await flushDecode();
  expect(idle.size).toBe(1);
  cancel();
  expect(idle.size).toBe(0);
  expect(images).toHaveLength(1);
});

it("reuses an in-flight decode across remounts and never continues a cancelled run", async () => {
  const { scheduleTaskScenePreload } = await import("../task-scene-preload");
  const cancelFirst = scheduleTaskScenePreload(manifest, "night");
  runIdle();
  cancelFirst();
  const cancelSecond = scheduleTaskScenePreload(manifest, "night");
  runIdle();
  expect(images).toHaveLength(1);
  images[0].resolve();
  await flushDecode();
  expect(idle.size).toBe(1);
  cancelSecond();
  expect(idle.size).toBe(0);
});

it("a failed decode does not block later plates or poison the cache", async () => {
  const { scheduleTaskScenePreload } = await import("../task-scene-preload");
  const cancelFirst = scheduleTaskScenePreload(manifest, "day");
  runIdle();
  images[0].reject();
  await flushDecode();
  expect(idle.size).toBe(1);
  cancelFirst();
  const cancelSecond = scheduleTaskScenePreload(manifest, "day");
  runIdle();
  expect(images).toHaveLength(2);
  expect(images[1].src).toBe(images[0].src);
  cancelSecond();
});
