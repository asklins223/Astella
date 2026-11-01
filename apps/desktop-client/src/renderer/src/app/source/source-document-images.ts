import { SOURCE_IMAGE_MAX_BYTES, SOURCE_IMAGE_MIME_TYPES } from "@astella/shared/source-image-contracts";
import { TRANSFER_BATCH_MAX_BYTES } from "@astella/shared/object-transfer-contracts";
import { createRequestMeta, getCurrentWorkspaceEpoch, gatewayErrorMessage, unwrapGatewayResult } from "../client/desktop-client";

export type ImportDocumentImage = (bytes: Uint8Array, mime: string, label: string) => Promise<string | null>;
/** 界面上说的 MB 与判据用的字节是同一处推出来的，不再手写数字。 */
const MEGABYTES = (bytes: number) => Math.round(bytes / 1024 / 1024);
const MAX_IMAGES = 600;
/**
 * 一次文档导入里图片的**累计**字节上限：`TRANSFER_BATCH_MAX_BYTES`（单份 100 MB × 4）。
 *
 * 它守的是"这一轮导入要在本机攒多少字节"，不是某一张文件能不能传——单张那一格是
 * `SOURCE_IMAGE_MAX_BYTES`，与传输上限同一个数。
 */
const MAX_TOTAL_BYTES = TRANSFER_BATCH_MAX_BYTES;

/** 一份文档内按内容去重；固定导入开始时的空间纪元，切空间后不再继续上传。 */
export function createDocumentImageImporter() {
  const epoch = getCurrentWorkspaceEpoch(), meta = createRequestMeta(epoch);
  const located = new Map<string, Promise<string | null>>();
  const warnings: string[] = [];
  let attempts = 0, totalBytes = 0, uploaded = 0;
  const warn = (label: string, reason: string) => {
    if (warnings.length < 20) warnings.push(`${label}：${reason}`);
    return null;
  };
  const importImage: ImportDocumentImage = async (bytes, mime, label) => {
    if (epoch !== getCurrentWorkspaceEpoch()) throw new Error("空间已经切换，请在当前空间重新导入文档。");
    if (!(SOURCE_IMAGE_MIME_TYPES as readonly string[]).includes(mime)) return warn(label, "图片格式不支持，请另存为 PNG、JPEG、GIF 或 WebP。");
    if (!bytes.length || bytes.length > SOURCE_IMAGE_MAX_BYTES) return warn(label, `图片为空或超过 ${MEGABYTES(SOURCE_IMAGE_MAX_BYTES)} MB，请压缩后重新导入。`);
    const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
    const key = `${mime}:${Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("")}`;
    const existing = located.get(key);
    if (existing) return existing;
    if (++attempts > MAX_IMAGES || totalBytes + bytes.length > MAX_TOTAL_BYTES) return warn(label, `文档图片超过单次 ${MAX_IMAGES} 张或累计 ${MEGABYTES(MAX_TOTAL_BYTES)} MB 上限，请拆分文档。`);
    totalBytes += bytes.length;
    const pending = (async () => {
      try {
        // 分片转二进制字符串，避免大图片展开参数时超过调用栈上限。
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        const extension = mime === "image/jpeg" ? "jpg" : mime.slice(6);
        const result = unwrapGatewayResult(await window.astella.source.uploadImage({ meta: { ...meta, requestId: crypto.randomUUID() },
          request: { version: 1, fileName: `${label.slice(0, 180)}.${extension}`, mimeType: mime as typeof SOURCE_IMAGE_MIME_TYPES[number], bytesBase64: btoa(binary) } }));
        if (epoch !== getCurrentWorkspaceEpoch()) throw new Error("空间已经切换，请重新导入文档。");
        uploaded += 1;
        return result.url;
      } catch (error) { return warn(label, gatewayErrorMessage(error)); }
    })();
    located.set(key, pending);
    return pending;
  };
  return { importImage, warnings, get uploaded() { return uploaded; } };
}
