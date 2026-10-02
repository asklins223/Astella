
import { describe, expect, it } from "vitest";
import {
  applyHomography,
  computeStageMatrix,
  homographyToCssMatrix3d,
  isConvexSceneQuad,
  isRoomSceneLayerRegistrationWithinWorld,
  projectWorldPoint,
  resolveRoomSceneLayerRegistrationRect,
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
