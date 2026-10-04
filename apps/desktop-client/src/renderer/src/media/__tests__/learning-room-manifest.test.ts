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
    // 39 张分层图**不在仓库里**（.gitignore 挡住 layers/home-v2/），所以 2026-10-04 起
    // manifest 不再登记它们：登记了却取不到文件，`validate:room-layers` 会让全新 clone
    // 的 `npm run build` 永远失败，CI 上任何桌面端构建／打包都出不来。
    // 这些层至今没有任何运行时代码读取（RoomStage 只画 homeV2Posters 三张底板），
    // 文件本身仍留在本地；要接分层渲染时，把文件和登记一起加回来。
    // 分层的结构校验没有因此消失——下面那组用合成 fixture 的用例仍然逐条守着
    // path 越界、重复 order、未知 anchor、越界 registration、缺 alpha。
    expect(manifest.roomLayers).toEqual([]);
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

    // 正控制：灯塔底板与各任务场景**确实**登记在册，所以下面那条否定断言不是空转。
    expect(manifest.normalized.assets["homeV2Posters.day"]).toBe(
      "posters/home-v2/lighthouse/lighthouse-day-poster-v1.png",
    );
    // 分层素材自 2026-10-04 起不再登记（文件不在仓库里，见上面那条注释），
    // 所以 manifest 里不该再留下任何 layers/ 入口。
    expect(manifest.normalized.assets["roomLayers.0"]).toBeUndefined();
    expect(registered.some((assetPath) => assetPath.startsWith("layers/"))).toBe(false);
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
    // 真实 manifest 自 2026-10-04 起不再登记分层，所以这里自己塞一条进去再把它写坏——
    // 判据要守的是「path 越界必须被拒」，不是某一张特定的分层图。
    const withTraversal = JSON.parse(JSON.stringify(sourceManifest)) as {
      roomLayers: { path: string }[];
    };
    withTraversal.roomLayers = [{ path: "posters/home-v2/lighthouse/lighthouse-day-poster-v1.png" }];
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
    // 分层素材的同源 URL 由上一条用例的合成 manifest 覆盖；真实 manifest 里
    // 自 2026-10-04 起没有分层可解析，所以这里不再引用 roomLayers[0]。
    expect(() => mediaAssetUrl(manifest, "https://example.com/asset.webp")).toThrow();
    expect(() => mediaAssetUrl(manifest, "unregistered.webp")).toThrow();
  });

  // 原先这里有一条「每个分层资产的 day/dusk/night 三态共用同一裁切几何、且单时段
  // 纹理预算 ≤ 48MB」的用例，遍历的是真实 manifest 的 39 条 roomLayers。
  // 2026-10-04 起这些图不再登记（文件不在仓库里），那条用例已经没有对象可遍历——
  // 留着只会变成「循环体一次都不执行」的假绿。它验的是**素材数据**的内在一致，
  // 不是 schema 或代码行为，所以没有等价物可以改写成合成 fixture。
  // 分层素材重新入库并登记时，把它和那批图一起加回来。
});
