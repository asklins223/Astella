// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import sourceManifest from "../../../public/assets/learning-room/v1/manifest.json";
import {
  mediaAssetUrl,
  parseLearningRoomManifest,
} from "../learning-room-manifest.ts";

const rejectedRuntimeMedia = [
  "graph-entry-fog-v1.mp4",
  "validation-ink-bloom-v1.mp4",
  "companion-wake-v1.webm",
  "companion-confirm-v1.webm",
  "review-card-tray-v1.png",
  "review-card-stand-v2.png",
] as const;

/**
 * 已退出的独立场景渲染包不再回到运行时。它与 taskPosters 登记的任务页原图
 * 是两组素材；后者必须保留，不能借清理旧渲染包删除当前任务场景。
 */
const RETIRED_STUDY_POSTERS = [
  "posters/room-day.webp",
  "posters/room-night.webp",
  "posters/study-seat-day-v2.png",
  "posters/study-seat-night-v2.png",
  "posters/review-seat-day-v1.png",
  "posters/review-seat-night-v1.png",
  "posters/search-reference-day-v1.png",
  "posters/search-reference-night-v1.png",
  "foreground/search-foreground-day-v1.png",
  "foreground/search-foreground-night-v1.png",
  "posters/login-entry/entry-door-closed-day-v1.png",
  "posters/login-entry/entry-door-open-night-v1.png",
] as const;

describe("learning-room manifest boundary", () => {
  it("parses the richer source format and emits the flat M1 projection", () => {
    const manifest = parseLearningRoomManifest(sourceManifest);

    // 与 `LEARNING_ROOM_ASSET_BASE_PATH` 一致——它必须和 `manifest.json` 里的
    // `basePath` 一字不差，而后者跟的是 `public/assets/learning-room/v1/` 这个真实布局。
    expect(manifest.basePath).toBe("/assets/learning-room/v1");
    expect(manifest.normalized.version).toBe(1);
    // 场景 → 底板是**两层**：RoomStage 的底层只有灯塔三张；各任务页自己那张场景底板
    // 由 taskPosters 六族登记、由 hud-surface.css 的 `.task-surface--<页面族>` 铺图。
    // 2026-10-01 我把这两层合成一层（删掉分族、RoomStage 按 viewPreset 换图），各任务页
    // 因此全都没有原图。下面这两条断言就是防它再退化。
    expect(manifest.normalized.assets["homeV2Posters.day"]).toBe("posters/home-v2/lighthouse/lighthouse-day-poster-v1.png");
    expect(manifest.normalized.assets).not.toHaveProperty("seatPosters.day");
    expect(manifest.normalized.assets).not.toHaveProperty("reviewPosters.day");
    expect(manifest.normalized.assets).not.toHaveProperty("searchPosters.day");
    for (const family of ["library", "writing", "workshop", "review", "observatory", "system"] as const) {
      const pair = manifest.taskPosters[family];
      expect(pair.day.path, `${family}.day 未登记`).toMatch(/^posters\/task-scenes\//);
      expect(pair.night.path, `${family}.night 未登记`).toMatch(/^posters\/task-scenes\//);
      expect(manifest.normalized.assets[`taskPosters.${family}.day`]).toBe(pair.day.path);
      expect(manifest.normalized.assets[`taskPosters.${family}.night`]).toBe(pair.night.path);
    }
    expect(manifest.taskPosters.library.day.path).toBe("posters/task-scenes/library-day-v1.png");
    expect(manifest.taskPosters.writing.night.path).toBe("posters/task-scenes/writing-night-v1.png");
    expect(manifest.taskPosters.review.day.path).toBe("posters/task-scenes/review-day-v1.png");
    expect(manifest.taskPosters.observatory.day.path).toBe("posters/task-scenes/observatory-night-open-v3.png");
    expect(manifest.taskPosters.system.day.path).toBe("posters/task-scenes/companion-system-day-v1.png");
    expect(manifest.authPosters.day.id).toBe("STATIC-AUTH-ALCOVE-DAY-01");
    expect(manifest.authPosters.dusk.id).toBe("STATIC-AUTH-ALCOVE-DUSK-01");
    expect(manifest.registerPosters.night.id).toBe("STATIC-AUTH-REGISTER-NIGHT-01");
    expect(manifest.registerPosters.dusk.id).toBe("STATIC-AUTH-REGISTER-DUSK-01");
    expect(manifest.normalized.assets["authPosters.day"]).toBe("posters/auth-alcove/auth-alcove-day-v1.png");
    expect(manifest.normalized.assets["authPosters.dusk"]).toBe("posters/auth-alcove/auth-alcove-dusk-v1.png");
    expect(manifest.normalized.assets["authPosters.night"]).toBe("posters/auth-alcove/auth-alcove-night-v1.png");
    expect(manifest.normalized.assets["registerPosters.day"]).toBe("posters/auth-register/register-worktable-day-v1.png");
    expect(manifest.normalized.assets["registerPosters.dusk"]).toBe("posters/auth-register/register-worktable-dusk-v1.png");
    expect(manifest.normalized.assets["registerPosters.night"]).toBe("posters/auth-register/register-worktable-night-v1.png");
    expect(manifest.roomLayers).toHaveLength(39);
    expect(new Set(manifest.roomLayers.map((layer) => layer.theme))).toEqual(new Set(["day", "dusk", "night"]));
    expect(new Set(manifest.roomLayers.filter((layer) => layer.theme === "day").map((layer) => layer.depth))).toEqual(
      new Set(["D0", "D1", "D2", "D3", "D4", "D6"]),
    );
    expect(manifest.roomLayers.every((layer) => (
      layer.sourceSize.width > 0
      && layer.sourceSize.height > 0
      && layer.sha256.length === 64
      && layer.license.length > 0
      && layer.releaseApproval
    ))).toBe(true);
    expect(manifest.normalized.assets["homeV2Posters.day"]).toBe(
      "posters/home-v2/lighthouse/lighthouse-day-poster-v1.png",
    );
    expect(manifest.normalized.assets["homeV2Posters.dusk"]).toBe(
      "posters/home-v2/lighthouse/lighthouse-dusk-poster-v1.png",
    );
    expect(manifest.normalized.assets["homeV2Posters.night"]).toBe(
      "posters/home-v2/lighthouse/lighthouse-night-poster-v1.png",
    );
    for (const rejectedName of rejectedRuntimeMedia) {
      expect(Object.values(manifest.normalized.assets).some((assetPath) => assetPath.endsWith(rejectedName))).toBe(false);
    }
  });

  it("registers home and task scene originals without the retired renderer pack", () => {
    const manifest = parseLearningRoomManifest(sourceManifest);
    const registered = Object.values(manifest.normalized.assets);

    // 正控制：灯塔底板与 39 层分层素材**确实**登记在册，所以下面那条否定断言不是空转。
    expect(manifest.normalized.assets["homeV2Posters.day"]).toBe(
      "posters/home-v2/lighthouse/lighthouse-day-poster-v1.png",
    );
    expect(manifest.normalized.assets["roomLayers.0"]).toBe(
      "layers/home-v2/lighthouse/lighthouse-day-d0-v1.png",
    );
    expect(manifest.roomLayers.length).toBeGreaterThan(0);
    for (const [family, posters] of Object.entries(manifest.taskPosters)) {
      for (const theme of ["day", "night"] as const) {
        expect(manifest.normalized.assets[`taskPosters.${family}.${theme}`]).toBe(posters[theme].path);
        expect(posters[theme].path).toMatch(/^posters\/task-scenes\//);
      }
    }

    for (const retiredPath of RETIRED_STUDY_POSTERS) {
      expect(registered).not.toContain(retiredPath);
    }
    // 旧书房的其它静态资源入口整条退场，一个键都不许留在 schema 上。
    for (const retiredKey of [
      "posters.day",
      "seatPosters.day",
      "searchPosters.day",
      "reviewPosters.day",
      "searchForeground.day",
      "entryPosters.closed.day",
      "window.mask",
      "onboarding",
      "graph.poster",
      "sound.ambientDay",
      "objects.desk",
      "textures.notebook",
    ]) {
      expect(manifest.normalized.assets).not.toHaveProperty(retiredKey);
    }
  });

  it("rejects unknown source keys and traversal paths", () => {
    const withUnknown = JSON.parse(JSON.stringify(sourceManifest)) as Record<string, unknown>;
    withUnknown.unregistered = true;
    expect(() => parseLearningRoomManifest(withUnknown)).toThrow();

    const withUnknownAuthPoster = JSON.parse(JSON.stringify(sourceManifest)) as {
      authPosters: Record<string, unknown>;
    };
    withUnknownAuthPoster.authPosters.extra = true;
    expect(() => parseLearningRoomManifest(withUnknownAuthPoster)).toThrow();

    // `window.mask` 这条遍历路径的载体已随旧书房删除，改由分层素材的 `path` 承担同一判据。
    const withTraversal = JSON.parse(JSON.stringify(sourceManifest)) as {
      roomLayers: { path: string }[];
    };
    withTraversal.roomLayers[0].path = "../outside.png";
    expect(() => parseLearningRoomManifest(withTraversal)).toThrow();
  });

  it("rejects duplicate independent Room layer ids", () => {
    const withDuplicateLayers = JSON.parse(JSON.stringify(sourceManifest)) as {
      roomLayers: unknown[];
    };
    const layer = {
      assetId: "STATIC-ROOM-FOREGROUND-01",
      path: "foreground/room-foreground-day-v1.png",
      theme: "day",
      depth: "D6",
      order: 0,
      anchorId: null,
      sourceSize: { width: 1672, height: 941 },
      registration: {
        position: [0, 0],
        size: { width: 1672, height: 941 },
        anchor: [0, 0],
      },
      alphaMode: "straight-rgba",
      sha256: "0000000000000000000000000000000000000000000000000000000000000000",
      sourcePath: "posters/home-v2/lighthouse/lighthouse-day-poster-v1.png",
      promptPath: "prompts/home-v2/lighthouse/lighthouse-layer-pack-v1.md",
      license: "test-only",
      reviewStatus: "approved",
      releaseApproval: true,
    };
    withDuplicateLayers.roomLayers = [layer, { ...layer, path: "foreground/room-foreground-night-v1.png", order: 1 }];
    expect(() => parseLearningRoomManifest(withDuplicateLayers)).toThrow();
  });

  it("rejects duplicate same-band orders and out-of-range orders", () => {
    const withDuplicateOrders = JSON.parse(JSON.stringify(sourceManifest)) as {
      roomLayers: unknown[];
    };
    const layer = {
      assetId: "STATIC-ROOM-ORDER-01",
      path: "foreground/room-foreground-day-v1.png",
      theme: "day",
      depth: "D6",
      order: 4,
      anchorId: null,
      sourceSize: { width: 1672, height: 941 },
      registration: {
        position: [0, 0],
        size: { width: 1672, height: 941 },
        anchor: [0, 0],
      },
      alphaMode: "straight-rgba",
      sha256: "0000000000000000000000000000000000000000000000000000000000000000",
      sourcePath: "posters/home-v2/lighthouse/lighthouse-day-poster-v1.png",
      promptPath: "prompts/home-v2/lighthouse/lighthouse-layer-pack-v1.md",
      license: "test-only",
      reviewStatus: "approved",
      releaseApproval: true,
    };
    withDuplicateOrders.roomLayers = [layer, { ...layer, assetId: "STATIC-ROOM-ORDER-02" }];
    expect(() => parseLearningRoomManifest(withDuplicateOrders)).toThrow();

    withDuplicateOrders.roomLayers = [{ ...layer, order: 64 }];
    expect(() => parseLearningRoomManifest(withDuplicateOrders)).toThrow();
  });

  it("rejects Room layer anchors outside the registered room scene", () => {
    const withUnknownAnchor = JSON.parse(JSON.stringify(sourceManifest)) as {
      roomLayers: unknown[];
    };
    withUnknownAnchor.roomLayers = [{
      assetId: "STATIC-ROOM-ANCHOR-01",
      path: "foreground/room-foreground-day-v1.png",
      theme: "day",
      depth: "D4",
      order: 0,
      anchorId: "room.unknown",
      sourceSize: { width: 1672, height: 941 },
      registration: {
        position: [0, 0],
        size: { width: 1672, height: 941 },
        anchor: [0, 0],
      },
      alphaMode: "straight-rgba",
      sha256: "0000000000000000000000000000000000000000000000000000000000000000",
      sourcePath: "posters/home-v2/lighthouse/lighthouse-day-poster-v1.png",
      promptPath: "prompts/home-v2/lighthouse/lighthouse-layer-pack-v1.md",
      license: "test-only",
      reviewStatus: "IN_REVIEW",
      releaseApproval: false,
    }];

    expect(() => parseLearningRoomManifest(withUnknownAnchor)).toThrow();
  });

  it("rejects Room layer registrations outside the canonical world", () => {
    const withOutOfBoundsRegistration = JSON.parse(JSON.stringify(sourceManifest)) as {
      roomLayers: unknown[];
    };
    withOutOfBoundsRegistration.roomLayers = [{
      assetId: "STATIC-ROOM-OUT-OF-BOUNDS-01",
      path: "foreground/room-foreground-day-v1.png",
      theme: "day",
      depth: "D6",
      order: 0,
      anchorId: null,
      sourceSize: { width: 1672, height: 941 },
      registration: {
        position: [-3, 0],
        size: { width: 64, height: 32 },
        anchor: [0, 0],
      },
      alphaMode: "straight-rgba",
      sha256: "0000000000000000000000000000000000000000000000000000000000000000",
      sourcePath: "posters/home-v2/lighthouse/lighthouse-day-poster-v1.png",
      promptPath: "prompts/home-v2/lighthouse/lighthouse-layer-pack-v1.md",
      license: "test-only",
      reviewStatus: "IN_REVIEW",
      releaseApproval: false,
    }];

    expect(() => parseLearningRoomManifest(withOutOfBoundsRegistration)).toThrow();
  });

  it("registers Room layer paths without making them eligible by metadata alone", () => {
    const withLayer = JSON.parse(JSON.stringify(sourceManifest)) as {
      roomLayers: unknown[];
    };
    withLayer.roomLayers = [{
      assetId: "STATIC-ROOM-FOREGROUND-01",
      path: "foreground/room-foreground-day-v1.png",
      theme: "day",
      depth: "D6",
      order: 0,
      anchorId: null,
      sourceSize: { width: 1672, height: 941 },
      registration: {
        position: [0, 0],
        size: { width: 1672, height: 941 },
        anchor: [0, 0],
      },
      alphaMode: "straight-rgba",
      sha256: "0000000000000000000000000000000000000000000000000000000000000000",
      sourcePath: "posters/home-v2/lighthouse/lighthouse-day-poster-v1.png",
      promptPath: "prompts/home-v2/lighthouse/lighthouse-layer-pack-v1.md",
      license: "test-only",
      reviewStatus: "IN_REVIEW",
      releaseApproval: false,
    }];

    const manifest = parseLearningRoomManifest(withLayer);
    expect(manifest.roomLayers).toHaveLength(1);
    expect(manifest.normalized.assets["roomLayers.0"]).toBe(
      "foreground/room-foreground-day-v1.png",
    );
    expect(mediaAssetUrl(manifest, manifest.roomLayers[0].path)).toBe(
      "/assets/learning-room/v1/foreground/room-foreground-day-v1.png",
    );
  });

  it("only builds fixed same-origin asset URLs", () => {
    const manifest = parseLearningRoomManifest(sourceManifest);
    expect(mediaAssetUrl(manifest, manifest.homeV2Posters.day.path)).toBe(
      "/assets/learning-room/v1/posters/home-v2/lighthouse/lighthouse-day-poster-v1.png",
    );
    expect(mediaAssetUrl(manifest, manifest.taskPosters.writing.day.path)).toBe(
      "/assets/learning-room/v1/posters/task-scenes/writing-day-v1.png",
    );
    expect(mediaAssetUrl(manifest, manifest.taskPosters.review.night.path)).toBe(
      "/assets/learning-room/v1/posters/task-scenes/review-night-v1.png",
    );
    expect(mediaAssetUrl(manifest, manifest.authPosters.day.path)).toBe(
      "/assets/learning-room/v1/posters/auth-alcove/auth-alcove-day-v1.png",
    );
    expect(mediaAssetUrl(manifest, manifest.roomLayers[0].path)).toBe(
      "/assets/learning-room/v1/layers/home-v2/lighthouse/lighthouse-day-d0-v1.png",
    );
    expect(() => mediaAssetUrl(manifest, "https://example.com/asset.webp")).toThrow();
    expect(() => mediaAssetUrl(manifest, "unregistered.webp")).toThrow();
  });

  it("keeps every time variant on the same cropped geometry and below the texture budget", () => {
    const manifest = parseLearningRoomManifest(sourceManifest);
    const identity = (assetId: string) => assetId.replace(/-(DAY|DUSK|NIGHT)$/u, "");
    const groups = new Map<string, typeof manifest.roomLayers>();
    for (const layer of manifest.roomLayers) {
      const key = identity(layer.assetId);
      groups.set(key, [...(groups.get(key) ?? []), layer]);
    }
    for (const variants of groups.values()) {
      expect(variants).toHaveLength(3);
      expect(new Set(variants.map((layer) => JSON.stringify({
        depth: layer.depth,
        order: layer.order,
        sourceSize: layer.sourceSize,
        registration: layer.registration,
      }))).size).toBe(1);
    }
    for (const time of ["day", "dusk", "night"] as const) {
      const layers = manifest.roomLayers.filter((layer) => layer.theme === time);
      expect(layers.filter((layer) => layer.depth === "D6")).toHaveLength(2);
      expect(layers.every((layer) => layer.depth === "D0"
        || layer.sourceSize.width * layer.sourceSize.height < 1672 * 941)).toBe(true);
      const rgbaBytes = layers.reduce((sum, layer) => sum + layer.sourceSize.width * layer.sourceSize.height * 4, 0);
      expect(rgbaBytes).toBeLessThanOrEqual(48 * 1024 * 1024);
    }
  });
});
