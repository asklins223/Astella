
import { describe, expect, it } from "vitest";
import {
  applyHomography,
  computeStageMatrix,
  homographyToCssMatrix3d,
  isConvexSceneQuad,
  isRoomSceneLayerRegistrationWithinWorld,
  projectWorldPoint,
  resolveRoomSceneLayerRegistrationRect,
  SCENE_WORLD,
  solveHomography,
  unprojectScreenPoint,
  type SceneQuad,
} from "../scene-geometry.ts";

/* 2026-10-01：这个文件原先还挂着四段 SurfaceRegistry 断言（Review / Study / Notebook /
   Search），它们测的是 `scene/scene-surfaces.ts` 与四份 `scene/*-surfaces.json` ——
   那条链随旧书房底板与 Pixi 渲染切片一起删除，无任何运行时调用方。与其留一具引用
   空模块的骨架，不如把这四段一并带走。剩下的是 `scene-geometry.ts` 本身的��何判据
   （舞台矩阵 / 房间层登记 / 单应），那一半仍由 `RoomStage` 与 manifest 消费。 */

describe("computeStageMatrix", () => {
  it("uses one centered cover matrix for the 1672×941 room world", () => {
    const matrix = computeStageMatrix(1024, 700);

    expect(matrix.scale).toBeCloseTo(0.7438894793, 9);
    expect(matrix.renderedWidth).toBeCloseTo(1243.783209, 6);
    expect(matrix.renderedHeight).toBeCloseTo(700, 9);
    expect(matrix.offsetX).toBeCloseTo(-109.891605, 6);
    expect(matrix.offsetY).toBeCloseTo(0, 9);
  });

  it("supports contain without creating a second coordinate space", () => {
    const matrix = computeStageMatrix(1024, 700, "contain");

    expect(matrix.scale).toBeCloseTo(1024 / 1672, 9);
    expect(matrix.offsetX).toBeCloseTo(0, 9);
    expect(matrix.offsetY).toBeGreaterThan(0);
  });

  it("round-trips world points through the stage matrix", () => {
    const matrix = computeStageMatrix(1440, 810);
    const worldPoint = [611.818, 673.45] as const;

    expect(unprojectScreenPoint(projectWorldPoint(worldPoint, matrix), matrix)).toEqual([
      expect.closeTo(worldPoint[0], 9),
      expect.closeTo(worldPoint[1], 9),
    ]);
  });

  it("rejects non-positive viewport dimensions", () => {
    expect(() => computeStageMatrix(0, 700)).toThrow(RangeError);
    expect(() => computeStageMatrix(1024, Number.NaN)).toThrow(RangeError);
  });
});

/**
 * 放开原生窗口比例锁之后，用户能把窗口摆成任意比例，最大化更是直接铺满屏幕。
 * 底板必须仍然是"铺满 + 等比裁切"：露出填充色条和把底图拉变形，是这次放开
 * 唯一不能出现的两种退化，所以按视口比例扫一遍钉死。
 */
describe("cover 撑满在任意窗口比例下都不露边、不变形", () => {
  // 覆盖用户真能摆出来的形状：16:9 原生、最大化常见的 16:10、21:9 带鱼、
  // 竖屏，以及比最小窗口更极端的两端。
  const viewports = [
    [1440, 810], [1280, 720], [1920, 1080], [2560, 1080], [3440, 1440],
    [2560, 1600], [1728, 1117], [1280, 1600], [900, 1600],
  ] as const;

  it("每一档视口下舞台都不小于视口，所以没有可露的边", () => {
    // 容差只吃掉浮点误差：`SCENE_WORLD.width * (height / SCENE_WORLD.height)`
    // 恰好等于宽度时，二进制浮点会差最后几个 ulp（例如 3440x1440 差 5e-13 px）。
    // 真要出现看得见的边，差的是几十上百像素，不是这一层。
    const EPSILON = 1e-9;
    for (const [width, height] of viewports) {
      const matrix = computeStageMatrix(width, height);
      expect(matrix.renderedWidth, `${width}x${height} 露出了左右边`).toBeGreaterThanOrEqual(width - EPSILON);
      expect(matrix.renderedHeight, `${width}x${height} 露出了上下边`).toBeGreaterThanOrEqual(height - EPSILON);
    }
  });

  it("每一档视口下底图都保持房间世界比例，所以不会被拉变形", () => {
    for (const [width, height] of viewports) {
      const matrix = computeStageMatrix(width, height);
      expect(matrix.renderedWidth / matrix.renderedHeight).toBeCloseTo(SCENE_WORLD.aspectRatio, 9);
    }
  });

  it("裁切量居中，多出来的部分两边各一半", () => {
    for (const [width, height] of viewports) {
      const matrix = computeStageMatrix(width, height);
      expect(matrix.offsetX).toBeCloseTo(-(matrix.renderedWidth - width) / 2, 9);
      expect(matrix.offsetY).toBeCloseTo(-(matrix.renderedHeight - height) / 2, 9);
    }
  });
});

describe("Room layer registration geometry", () => {
  it("resolves a sprite registration around its normalized anchor", () => {
    expect(resolveRoomSceneLayerRegistrationRect(
      [100, 80],
      { width: 40, height: 20 },
      [0.5, 0.25],
    )).toEqual({ x: 80, y: 75, width: 40, height: 20 });
  });

  it("allows only the explicit two-pixel world-edge bleed", () => {
    expect(isRoomSceneLayerRegistrationWithinWorld(
      [0, 0],
      { width: 1674, height: 943 },
      [0, 0],
    )).toBe(true);
    expect(isRoomSceneLayerRegistrationWithinWorld(
      [-3, 0],
      { width: 40, height: 20 },
      [0, 0],
    )).toBe(false);
    expect(isRoomSceneLayerRegistrationWithinWorld(
      [0, 0],
      { width: 40, height: 20 },
      [1.1, 0],
    )).toBe(false);
  });
});

describe("homography", () => {
  const source: SceneQuad = [[0, 0], [200, 0], [200, 100], [0, 100]];
  const destination: SceneQuad = [[5, 8], [192, -4], [205, 104], [-3, 96]];

  it("maps every source corner onto its registered destination corner", () => {
    const homography = solveHomography(source, destination);
    expect(homography).not.toBeNull();

    source.forEach((point, index) => {
      const projected = applyHomography(point, homography!);
      expect(projected?.[0]).toBeCloseTo(destination[index][0], 7);
      expect(projected?.[1]).toBeCloseTo(destination[index][1], 7);
    });
  });

  it("emits a finite CSS matrix3d", () => {
    const matrix = homographyToCssMatrix3d({ sourceSize: { width: 200, height: 100 }, destination });

    expect(matrix).toMatch(/^matrix3d\(/);
    expect(matrix).not.toMatch(/NaN|Infinity/);
  });

  it("rejects collapsed and self-intersecting quads", () => {
    const collapsed: SceneQuad = [[0, 0], [1, 0], [2, 0], [0, 0]];
    const bowTie: SceneQuad = [[0, 0], [1, 1], [1, 0], [0, 1]];

    expect(isConvexSceneQuad(collapsed)).toBe(false);
    expect(isConvexSceneQuad(bowTie)).toBe(false);
    expect(solveHomography(source, bowTie)).toBeNull();
  });
});
