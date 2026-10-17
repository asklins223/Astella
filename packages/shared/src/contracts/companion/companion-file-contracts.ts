import { z } from "zod";

/**
 * 伴星对话附件——**文件**块的站内地址合同（2026-10-15 移动端全量重构扩展 A）。
 *
 * 与图片同一条 `/api/uploads/` 前缀约定（见 source-image-contracts 的前缀说明），
 * 但对象键形状不同、登记闸门不同：文件不进 `note_image_assets`，下载闸按
 * `{workspaceId}/companion-files/{uploaderId}/{file}` 路径段做租户与上传者隔离。
 *
 * 文件正文（text 字段）由**客户端本机抽取**（iOS PDFKit / Android pdfbox；docx
 * 为 zip+XML 抽正文），随回合上送；解析在本机完成；用户发送时原件上传为私有附件，抽取正文随回合提供给伴星。
 */

/** 对话文件 MIME 白名单：PDF / DOCX / 纯文本 / Markdown。 */
export const COMPANION_FILE_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
] as const;
export type CompanionFileMimeType = (typeof COMPANION_FILE_MIME_TYPES)[number];

/** 对话文件原始字节上限（20 MiB）。 */
export const COMPANION_FILE_MAX_BYTES = 20 * 1024 * 1024;

/** 客户端本机抽取正文上限（服务端只透传给模型上下文，不再加工）。 */
export const COMPANION_FILE_TEXT_MAX_CHARS = 100_000;

const UUID_SEGMENT = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const FILE_NAME_SEGMENT = "[A-Za-z0-9._\\-]{1,120}";
const COMPANION_FILE_EXTENSION_SEGMENT = "pdf|docx|txt|md";
/** 与 API 下载路由接受的形状一致：{workspaceId}/companion-files/{uploaderId}/{name}.{ext}。 */
const COMPANION_FILE_OBJECT_KEY_PATTERN = new RegExp(
  `^${UUID_SEGMENT}/companion-files/${UUID_SEGMENT}/${FILE_NAME_SEGMENT}\\.(?:${COMPANION_FILE_EXTENSION_SEGMENT})$`,
);

/** 与 source-image-contracts 同一个前缀常量语义：`/api/uploads/` 由 Web 边缘转发到 API 根。 */
export const COMPANION_FILE_UPLOAD_PREFIX = "/api/uploads/";

/** 从一段 URL 取出站内文件 objectKey；外链与形状不符的一律 null。 */
export function companionFileObjectKeyFromUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed.startsWith(COMPANION_FILE_UPLOAD_PREFIX)) return null;
  const objectKey = trimmed.slice(COMPANION_FILE_UPLOAD_PREFIX.length);
  return COMPANION_FILE_OBJECT_KEY_PATTERN.test(objectKey) ? objectKey : null;
}

/** 反向：由 objectKey 拼出站内地址（服务端上传回执用）。 */
export function companionFileUrlFromObjectKey(objectKey: string): string {
  return `${COMPANION_FILE_UPLOAD_PREFIX}${objectKey}`;
}

/** 下载路由只收这些扩展（与 MIME 白名单互为表里）。 */
export function companionFileExtensionForMimeType(mime: CompanionFileMimeType): string {
  switch (mime) {
    case "application/pdf": return "pdf";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": return "docx";
    case "text/plain": return "txt";
    case "text/markdown": return "md";
  }
}

/**
 * 对话回合里的**用户文件块**。
 *
 * 与图片块同理：`url` 的校验复用渲染/服务端同一份函数——"合同收得下"与
 * "下载得到"必须是同一件事。`text` 是客户端本机抽取的正文（不是模型生成），
 * 伴星据此回答；原件经 url 留档可查。
 */
export const companionFileBlockV1Schema = z.object({
  type: z.literal("file"),
  /** 站内上传回执地址；服务端在建轮时复核 workspace 段后原样落库。 */
  url: z.string().max(2_000).refine(
    (value) => companionFileObjectKeyFromUrl(value) !== null,
    { message: "only site-internal /api/uploads/ file urls are accepted" },
  ),
  /** 原始文件名（展示与上下文标注用）。 */
  name: z.string().min(1).max(200),
  /** 声明 MIME；与上传时校验的白名单一致。 */
  mime: z.enum(COMPANION_FILE_MIME_TYPES),
  /** 原始字节数（客户端本地文件大小，展示用）。 */
  byteLength: z.number().int().positive().max(COMPANION_FILE_MAX_BYTES),
  /** 客户端本机抽取的正文。 */
  text: z.string().min(1).max(COMPANION_FILE_TEXT_MAX_CHARS),
}).strict();
export type CompanionFileBlockV1 = z.infer<typeof companionFileBlockV1Schema>;
