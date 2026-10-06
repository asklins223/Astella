/**
 * 头像取景的几何：正方形窗口里摆一张照片——cover 缩放下限、平移夹取、绕图心旋转。
 *
 * 预览画布与导出画布共用 `drawCropScene`：导出只是请同一个函数按输出尺寸再画一遍，
 * 所以「所见即所得」不靠两处公式对齐，而是只有一处公式。
 *
 * 不变量：`scale >= coverScale` 时，任意旋转角（含旋转动画的中间角度）下图的包围盒
 * 都能盖满取景框，夹取范围因此永远不是负数——取景框里不会露出图外。
 */

export const CROP_OUTPUT_SIZE = 512;
/** 工作图（预览与导出共用）最长边上限：手机原图先进一次降采样，40MP 不进两次内存。 */
export const CROP_MAX_WORKING_EDGE = 2560;
export const CROP_MAX_ZOOM = 8;
/** 量不到布局（jsdom、首帧之前）时取景框的边长。 */
export const CROP_VIEWPORT_FALLBACK = 320;

export interface CropSource {
  readonly width: number;
  readonly height: number;
}

export interface CropTransform {
  /** 取景框边长（css px，正方形）。 */
  readonly viewport: number;
  /** 屏幕 px / 源 px。 */
  readonly scale: number;
  /** 图心相对取景框中心的位移（屏幕 px）。 */
  readonly offsetX: number;
  readonly offsetY: number;
  /** 顺时针角度；旋转动画期间是任意小数。 */
  readonly rotation: number;
}

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** 铺满取景框的最小缩放：短边对齐，长边溢出。 */
export function coverScale(source: CropSource, viewport: number): number {
  return viewport / Math.min(source.width, source.height);
}

export function clampScale(source: CropSource, viewport: number, scale: number): number {
  const min = coverScale(source, viewport);
  const max = min * CROP_MAX_ZOOM;
  return Math.min(Math.max(scale, min), max);
}

/** 当前缩放相对"刚好铺满"的倍数，滑块的读数就是这个。 */
export function cropZoom(source: CropSource, transform: CropTransform): number {
  return transform.scale / coverScale(source, transform.viewport);
}

/** 旋转后图在屏幕上的半宽 / 半高。 */
function rotatedHalfExtents(source: CropSource, scale: number, rotation: number) {
  const cos = Math.abs(Math.cos(toRadians(rotation)));
  const sin = Math.abs(Math.sin(toRadians(rotation)));
  return {
    x: (scale * (source.width * cos + source.height * sin)) / 2,
    y: (scale * (source.width * sin + source.height * cos)) / 2,
  };
}

/** 夹住位移：任何角度都不让取景框里露出图外。 */
export function clampCropOffset(source: CropSource, transform: CropTransform): CropTransform {
  const half = rotatedHalfExtents(source, transform.scale, transform.rotation);
  const limitX = Math.max(0, half.x - transform.viewport / 2);
  const limitY = Math.max(0, half.y - transform.viewport / 2);
  return {
    ...transform,
    offsetX: Math.min(Math.max(transform.offsetX, -limitX), limitX),
    offsetY: Math.min(Math.max(transform.offsetY, -limitY), limitY),
  };
}

/** 取景框里的点（相对中心）落在源图的哪个像素。 */
export function sourcePointAt(
  source: CropSource,
  transform: CropTransform,
  x: number,
  y: number,
): { readonly x: number; readonly y: number } {
  const dx = x - transform.offsetX;
  const dy = y - transform.offsetY;
  const rad = toRadians(-transform.rotation);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: (dx * cos - dy * sin) / transform.scale + source.width / 2,
    y: (dx * sin + dy * cos) / transform.scale + source.height / 2,
  };
}

/**
 * 以取景框上的某个点（相对中心）为锚缩放：锚点下的源像素保持不动。
 * 滚轮、双指、滑块都走这里，手感才是同一回事。
 */
export function zoomCropAt(
  source: CropSource,
  transform: CropTransform,
  nextScale: number,
  focusX: number,
  focusY: number,
): CropTransform {
  const scale = clampScale(source, transform.viewport, nextScale);
  const anchor = sourcePointAt(source, transform, focusX, focusY);
  const rad = toRadians(transform.rotation);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const px = (anchor.x - source.width / 2) * scale;
  const py = (anchor.y - source.height / 2) * scale;
  return clampCropOffset(source, {
    ...transform,
    scale,
    offsetX: focusX - (px * cos - py * sin),
    offsetY: focusY - (px * sin + py * cos),
  });
}

/** 滑块那一路：按"铺满的倍数"缩放，锚回取景框中心。 */
export function zoomCropTo(
  source: CropSource,
  transform: CropTransform,
  zoom: number,
  focusX = 0,
  focusY = 0,
): CropTransform {
  return zoomCropAt(source, transform, coverScale(source, transform.viewport) * zoom, focusX, focusY);
}

/** 旋转只改角度、重新夹取——旋转动画的每一帧都要过这里。 */
export function rotateCrop(source: CropSource, transform: CropTransform, rotation: number): CropTransform {
  return clampCropOffset(source, { ...transform, rotation });
}

/** 初始摆位：铺满、居中、未旋转。 */
export function initialCropTransform(source: CropSource, viewport: number): CropTransform {
  return { viewport, scale: coverScale(source, viewport), offsetX: 0, offsetY: 0, rotation: 0 };
}

/** 取景框看到的场景。`pixelRatio` = 这段 css px 要画到多少设备像素。 */
export function drawCropScene(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  source: CropSource,
  transform: CropTransform,
  pixelRatio: number,
): void {
  const { viewport } = transform;
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, viewport, viewport);
  ctx.save();
  ctx.translate(viewport / 2 + transform.offsetX, viewport / 2 + transform.offsetY);
  ctx.rotate(toRadians(transform.rotation));
  ctx.scale(transform.scale, transform.scale);
  ctx.drawImage(image, -source.width / 2, -source.height / 2, source.width, source.height);
  ctx.restore();
}

/** 导出时的绘制比例：输出画布上仍是同一个场景。 */
export function cropOutputPixelRatio(viewport: number): number {
  return CROP_OUTPUT_SIZE / viewport;
}
