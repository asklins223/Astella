import type { PDFPageProxy } from "pdfjs-dist/types/src/display/api";
import type { ImportDocumentImage } from "./source-document-images";
import { pdfItemsToMarkdown, type PdfTextItem } from "./source-pdf-text";

type Matrix = [number, number, number, number, number, number];
type Pixels = { width: number; height: number; kind?: number; data?: Uint8Array | Uint8ClampedArray; bitmap?: ImageBitmap };
export type PositionedPdfImage = { top: number; left: number; markdown: string };
const identity = (): Matrix => [1, 0, 0, 1, 0, 0];
const multiply = (a: Matrix, b: Matrix): Matrix => [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];

/** pdf.js 的三种原始像素布局；每行的一位灰度有独立字节填充。 */
export function pdfImageRgba(image: Pixels): Uint8ClampedArray<ArrayBuffer> {
  const { width, height, data, kind } = image;
  if (!data) throw new Error("图片像素不可用");
  const output = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const pixel = y * width + x, offset = pixel * 4;
    if (kind === 1) {
      const byte = data[y * Math.ceil(width / 8) + (x >> 3)];
      output[offset] = output[offset + 1] = output[offset + 2] = byte & (128 >> (x & 7)) ? 255 : 0;
      output[offset + 3] = 255;
    } else if (kind === 2) {
      output[offset] = data[pixel * 3]; output[offset + 1] = data[pixel * 3 + 1]; output[offset + 2] = data[pixel * 3 + 2]; output[offset + 3] = 255;
    } else if (kind === 3) output.set(data.subarray(offset, offset + 4), offset);
    else throw new Error("图片像素格式不支持");
  }
  return output;
}

async function imagePng(image: Pixels, crop?: { x: number; y: number; w: number; h: number }): Promise<Uint8Array> {
  if (!image.width || !image.height || image.width * image.height > 40_000_000) throw new Error("图片尺寸超过 4000 万像素");
  const canvas = new OffscreenCanvas(image.width, image.height), context = canvas.getContext("2d");
  if (!context) throw new Error("图片转换不可用");
  if (image.bitmap) context.drawImage(image.bitmap, 0, 0);
  else context.putImageData(new ImageData(pdfImageRgba(image), image.width, image.height), 0, 0);
  let target = canvas;
  if (crop) {
    target = new OffscreenCanvas(crop.w, crop.h);
    target.getContext("2d")!.drawImage(canvas, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
  }
  return new Uint8Array(await (await target.convertToBlob({ type: "image/png" })).arrayBuffer());
}

function getImage(page: PDFPageProxy, id: string): Promise<Pixels> {
  const objects = id.startsWith("g_") ? page.commonObjs : page.objs;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("图片解码超时")), 10_000);
    try { objects.get(id, (image: Pixels | null) => { clearTimeout(timeout); image ? resolve(image) : reject(new Error("图片像素不可用")); }); }
    catch (error) { clearTimeout(timeout); reject(error); }
  });
}

/** 只读取实际绘制的图像；重复绘制保留位置，上传端按内容去重。 */
export async function extractPdfPageImages(page: PDFPageProxy, ops: Record<string, number>, importImage: ImportDocumentImage): Promise<PositionedPdfImage[]> {
  const list = await page.getOperatorList(), stack: Matrix[] = [], images: PositionedPdfImage[] = [];
  let matrix = identity(), ordinal = 0;
  const add = async (load: () => Promise<Pixels>, transform = matrix, crop?: { x: number; y: number; w: number; h: number }) => {
    const label = `PDF 第 ${page.pageNumber} 页图片 ${++ordinal}`;
    let markdown = `[${label}未能导入]`;
    try {
      const src = await importImage(await imagePng(await load(), crop), "image/png", label);
      if (src) markdown = `![${label}](${src})`;
    } catch (failure) { markdown = `[${label}未能导入：${failure instanceof Error ? failure.message : "无法解码"}]`; }
    const ys = [transform[5], transform[1] + transform[5], transform[3] + transform[5], transform[1] + transform[3] + transform[5]];
    images.push({ top: Math.max(...ys), left: transform[4], markdown });
  };
  for (let index = 0; index < list.fnArray.length; index++) {
    const op = list.fnArray[index], args = list.argsArray[index];
    if (op === ops.save) stack.push([...matrix]);
    else if (op === ops.restore) matrix = stack.pop() ?? identity();
    else if (op === ops.transform) matrix = multiply(matrix, args as Matrix);
    else if (op === ops.paintFormXObjectBegin) { stack.push([...matrix]); if (args[0]) matrix = multiply(matrix, args[0]); }
    else if (op === ops.paintFormXObjectEnd) matrix = stack.pop() ?? identity();
    else if (op === ops.paintImageXObject) await add(() => getImage(page, args[0]));
    else if (op === ops.paintInlineImageXObject) await add(async () => args[0]);
    else if (op === ops.paintImageXObjectRepeat) {
      const [id, scaleX, scaleY, positions] = args;
      for (let p = 0; p < positions.length; p += 2) await add(() => getImage(page, id), multiply(matrix, [scaleX, 0, 0, scaleY, positions[p], positions[p + 1]]));
    } else if (op === ops.paintInlineImageXObjectGroup) {
      for (const entry of args[1]) await add(async () => args[0], multiply(matrix, entry.transform), entry);
    } else if (op === ops.paintImageMaskXObject || op === ops.paintImageMaskXObjectGroup || op === ops.paintImageMaskXObjectRepeat) {
      images.push({ top: matrix[5], left: matrix[4], markdown: "[PDF 图像掩膜未能独立导入，可在原文件中查看]" });
    }
  }
  return images;
}

/** 在图像顶边处分开文字段落；文字与图片都保持所在页的阅读顺序。 */
export function pdfPageMarkdown(items: readonly PdfTextItem[], images: readonly PositionedPdfImage[]): string {
  if (!images.length) return pdfItemsToMarkdown(items);
  const remaining = [...images].sort((a, b) => b.top - a.top || a.left - b.left), parts: string[] = [];
  let text: PdfTextItem[] = [];
  for (const item of items) {
    while (remaining.length && remaining[0].top >= item.transform[5]) {
      if (text.length) { parts.push(pdfItemsToMarkdown(text)); text = []; }
      parts.push(remaining.shift()!.markdown);
    }
    text.push(item);
  }
  if (text.length) parts.push(pdfItemsToMarkdown(text));
  parts.push(...remaining.map(image => image.markdown));
  return parts.filter(Boolean).join("\n\n");
}
