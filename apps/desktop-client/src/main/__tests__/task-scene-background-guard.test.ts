import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveRoomIntent, type RoomIntent } from "../../renderer/src/app/room-machine";
import { parseLearningRoomManifest } from "../../renderer/src/media/learning-room-manifest";
import sourceManifest from "../../renderer/public/assets/learning-room/v1/manifest.json";

const assetRoot = resolve("src/renderer/public/assets/learning-room/v1");
const css = readFileSync("src/renderer/src/components/hud/hud-surface.css", "utf8");
const sceneStart = css.indexOf("/* Task scene plates");
const sceneEnd = css.indexOf("/* End task scene plates. */");
const manifest = parseLearningRoomManifest(sourceManifest);
// 主进程的 typecheck 没有浏览器全局；这个 DOM 只属于样式回归夹具。
const { JSDOM } = createRequire(import.meta.url)("jsdom");
const { window } = new JSDOM("<!doctype html><html><head></head><body></body></html>");
const { document } = window;
const getComputedStyle = window.getComputedStyle.bind(window);
const style = document.createElement("style");

// 独立固定的审查基准，不从被验的 CSS 反推期望值。覆盖全部十五种任务路由。
const scenes: readonly (readonly [RoomIntent, keyof typeof manifest.taskPosters, string])[] = [
  ["open-sources", "library", "library"],
  ["open-source", "library", "library"],
  ["search", "library", "library"],
  ["open-notes", "writing", "writing"],
  ["open-notebook", "writing", "writing"],
  ["continue", "workshop", "workshop"],
  ["open-resumable", "workshop", "workshop"],
  ["open-card-generation", "workshop", "workshop"],
  ["open-objectives", "workshop", "workshop"],
  ["open-objective", "workshop", "workshop"],
  ["review", "review", "review"],
  ["validate", "review", "review"],
  ["graph", "observatory", "observatory-night-open-v3"],
  ["open-companion-center", "observatory", "observatory-night-open-v3"],
  ["open-settings", "system", "companion-system"],
];

beforeAll(() => {
  expect(sceneStart).toBeGreaterThan(-1);
  expect(sceneEnd).toBeGreaterThan(sceneStart);
  style.textContent = css.slice(sceneStart, sceneEnd);
  document.head.append(style);
});
afterEach(() => document.body.replaceChildren());
afterAll(() => style.remove());

describe("task scene background regression", () => {
  for (const [intent, family, filename] of scenes) {
    it.each(["day", "night"] as const)(`${intent} keeps its original %s scene`, (theme) => {
      const { surface } = resolveRoomIntent(intent);
      const root = document.createElement("div");
      root.className = "desktop-app hud-surface";
      root.dataset.theme = theme;
      const host = document.createElement("section");
      host.className = `task-surface task-surface--spatial task-surface--${surface}`;
      root.append(host);
      document.body.append(root);

      const expectedFile = family === "observatory" ? `${filename}.png` : `${filename}-${theme}-v1.png`;
      const expectedPath = `posters/task-scenes/${expectedFile}`;
      expect(host.isConnected).toBe(true);
      expect(getComputedStyle(host).backgroundImage).toBe(`url("${manifest.basePath}/${expectedPath}")`);
      expect(manifest.taskPosters[family][theme].path).toBe(expectedPath);
      expect(manifest.normalized.assets[`taskPosters.${family}.${theme}`]).toBe(expectedPath);
    });
  }

  it("ships the eleven original PNGs plus the candidate tabletop with registered hashes", () => {
    const posters = Object.values(manifest.taskPosters).flatMap((pair) => [pair.day, pair.night]);
    const paths = new Set(posters.map((poster) => poster.path));
    expect(paths.size).toBe(12);
    for (const poster of posters) {
      const bytes = readFileSync(resolve(assetRoot, poster.path));
      expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(bytes.readUInt32BE(16)).toBe(poster.width);
      expect(bytes.readUInt32BE(20)).toBe(poster.height);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(poster.sha256);
    }
  });

  it("keeps the homepage outside the task scene selector", () => {
    const home = document.createElement("div");
    home.className = "desktop-app hud-surface";
    home.dataset.theme = "night";
    document.body.append(home);
    expect(home.isConnected).toBe(true);
    expect(getComputedStyle(home).backgroundImage).toBe("");
    expect(manifest.homeV2Posters.night.path).toBe("posters/home-v2/lighthouse/lighthouse-night-poster-v1.png");
  });

  it.each(["day", "night"] as const)("the review desk uses its new tabletop in %s mode", theme => {
    const reviewStyle = document.createElement("style");
    const reviewCss = readFileSync("src/renderer/src/components/surfaces/review/candidate-review.css", "utf8");
    reviewStyle.textContent = reviewCss.slice(0, reviewCss.indexOf(".desktop-app.hud-surface.page-13"));
    document.head.append(reviewStyle);
    const root = document.createElement("div"); root.className = "desktop-app hud-surface"; root.dataset.theme = theme;
    const host = document.createElement("section"); host.className = "task-surface task-surface--card-generation";
    const desk = document.createElement("div"); desk.className = "candidate-review-table";
    host.append(desk); root.append(host); document.body.append(root);
    try {
      expect(host.isConnected).toBe(true);
      expect(getComputedStyle(host).backgroundImage).toContain("candidate-card-table-day-v2.png");
      expect(manifest.normalized.assets[`taskPosters.candidateReview.${theme}`]).toBe("posters/task-scenes/candidate-card-table-day-v2.png");
      desk.remove();
      expect(getComputedStyle(host).backgroundImage).toContain(`workshop-${theme}-v1.png`);
    } finally { reviewStyle.remove(); }
  });
});
