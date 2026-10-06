/**
 * 取景框几何的纯数契约：铺满、夹取、绕点缩放、绕心旋转。
 *
 * 这些数就是「取景框里不会露出图外」与「滚轮缩放时鼠标下的像素不动」两句话的
 * 全部依据；预览与导出共用 drawCropScene，所以这里验的也就是导出结果的几何。
 */
import { describe, expect, it, vi } from "vitest";
import {
  CROP_MAX_ZOOM,
  CROP_OUTPUT_SIZE,
  clampCropOffset,
  clampScale,
  coverScale,
  cropOutputPixelRatio,
  cropZoom,
  drawCropScene,
  initialCropTransform,
  rotateCrop,
  sourcePointAt,
  zoomCropAt,
  zoomCropTo,
  type CropSource,
  type CropTransform,
} from "../avatar-crop-geometry";

const SOURCE: CropSource = { width: 800, height: 600 };
const VIEWPORT = 300;

describe("cover 缩放", () => {
  it("铺满以短边为准：800×600 图在 300 的框里从 0.5 起步", () => {
    expect(coverScale(SOURCE, VIEWPORT)).toBe(300 / 600);
  });

  it("缩放下限是铺满、上限是它的 CROP_MAX_ZOOM 倍", () => {
    const min = coverScale(SOURCE, VIEWPORT);
    expect(clampScale(SOURCE, VIEWPORT, min / 2)).toBe(min);
    expect(clampScale(SOURCE, VIEWPORT, min * 100)).toBe(min * CROP_MAX_ZOOM);
    expect(clampScale(SOURCE, VIEWPORT, min * 2)).toBe(min * 2);
  });
});

describe("平移夹取", () => {
  it("刚铺满：短边锁死、长边留 ±50 的取景余量", () => {
    const clamped = clampCropOffset(SOURCE, { ...initialCropTransform(SOURCE, VIEWPORT), offsetX: 999, offsetY: 999 });
    expect(clamped.offsetX).toBeCloseTo(50);
    expect(clamped.offsetY).toBeCloseTo(0);
  });

  it("放大一档余量同步变大：scale=1 时水平 ±250、垂直 ±150", () => {
    const clamped = clampCropOffset(SOURCE, {
      viewport: VIEWPORT, scale: 1, offsetX: 999, offsetY: 999, rotation: 0,
    });
    expect(clamped.offsetX).toBe(250);
    expect(clamped.offsetY).toBe(150);
  });

  it("旋转 90° 后余量跟着换轴：水平的两个方向都夹回 0，垂直留 ±50", () => {
    const rotated = rotateCrop(SOURCE, {
      viewport: VIEWPORT, scale: 0.5, offsetX: 100, offsetY: 100, rotation: 0,
    }, 90);
    expect(rotated.offsetX).toBeCloseTo(0);
    expect(rotated.offsetY).toBeCloseTo(50);
  });
});

describe("绕点缩放", () => {
  it("锚点下的源像素保持不动", () => {
    const start = initialCropTransform(SOURCE, VIEWPORT);
    const anchorBefore = sourcePointAt(SOURCE, start, 60, 40);
    const zoomed = zoomCropAt(SOURCE, start, 0.9, 60, 40);
    const anchorAfter = sourcePointAt(SOURCE, zoomed, 60, 40);
    expect(anchorAfter.x).toBeCloseTo(anchorBefore.x);
    expect(anchorAfter.y).toBeCloseTo(anchorBefore.y);
  });

  it("缩放到下限之外时按铺满收住，且照常夹取", () => {
    const zoomed = zoomCropAt(SOURCE, initialCropTransform(SOURCE, VIEWPORT), 0.01, 200, 0);
    expect(zoomed.scale).toBeCloseTo(coverScale(SOURCE, VIEWPORT));
    expect(Math.abs(zoomed.offsetX)).toBeLessThanOrEqual(250 + 1e-9);
  });

  it("滑块走 zoomCropTo：倍率进、倍率出", () => {
    const zoomed = zoomCropTo(SOURCE, initialCropTransform(SOURCE, VIEWPORT), 2);
    expect(cropZoom(SOURCE, zoomed)).toBeCloseTo(2);
  });
});

describe("取景框坐标 ↔ 源像素", () => {
  it("原点不动、旋转把轴换过来", () => {
    const upright: CropTransform = { viewport: VIEWPORT, scale: 0.5, offsetX: 0, offsetY: 0, rotation: 0 };
    const center = sourcePointAt(SOURCE, upright, 0, 0);
    expect(center.x).toBeCloseTo(400, 6);
    expect(center.y).toBeCloseTo(300, 6);
    // 正下方 100px 处：顺时针 90° 后那里是源图的右侧。
    const turned = { ...upright, rotation: 90 };
    const point = sourcePointAt(SOURCE, turned, 0, 100);
    expect(point.x).toBeCloseTo(600, 6);
    expect(point.y).toBeCloseTo(300, 6);
  });
});

describe("drawCropScene 的调用合同（预览与导出共用之处）", () => {
  it("先按 pixelRatio 定比例，再走与预览同一串变换", () => {
    const ctx = {
      setTransform: vi.fn(), clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(),
      translate: vi.fn(), rotate: vi.fn(), scale: vi.fn(), drawImage: vi.fn(),
    };
    const transform: CropTransform = { viewport: 300, scale: 0.5, offsetX: 12, offsetY: -8, rotation: 90 };
    drawCropScene(ctx as unknown as CanvasRenderingContext2D, "IMAGE" as unknown as CanvasImageSource, SOURCE, transform, 2);

    expect(ctx.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 300, 300);
    expect(ctx.translate).toHaveBeenCalledWith(162, 142);
    expect(ctx.rotate).toHaveBeenCalledWith(Math.PI / 2);
    expect(ctx.scale).toHaveBeenCalledWith(0.5, 0.5);
    expect(ctx.drawImage).toHaveBeenCalledWith("IMAGE", -400, -300, 800, 600);
    expect(ctx.restore).toHaveBeenCalledTimes(1);
  });

  it("导出的 pixelRatio 把取景框铺满输出画布", () => {
    expect(cropOutputPixelRatio(300)).toBe(CROP_OUTPUT_SIZE / 300);
  });
});
