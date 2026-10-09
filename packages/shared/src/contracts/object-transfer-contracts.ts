import { z } from "zod";

export const OBJECT_TRANSFER_HEADER = "X-Astella-Object-Transfer";
export const OBJECT_TRANSFER_MAX_BYTES = 256 * 1024 * 1024;
/**
 * 一份文本来源正文的上限，只有这一个源。
 *
 * 客户端拦一次、`source_text` 用途拦一次、直传回退的那发 POST 拦一次、worker 回读再验一次；
 * 这四个数过去各写各的，改一处就会让另外三处对不上——症状是"界面说收下了，来源永远停在正在解析"。
 */
export const MAX_SOURCE_TEXT_BYTES = 10 * 1024 * 1024;
/**
 * `markdown_import_image` 是导入 Markdown 时随正文一起带进来的图片（本地相对路径或外链
 * 抓回来的字节）。它单独成一个用途而不是复用 `note_image`，是因为那条硬要求一篇**已存在**
 * 的笔记（API 侧按 noteId 校验归属，回执才登记得了资产）——而导入的图此刻还没有笔记。
 */
export const objectTransferPurposeSchema = z.enum(["note_image", "companion_image", "avatar", "source_text", "markdown_import", "markdown_import_image"]);
export type ObjectTransferPurpose = z.infer<typeof objectTransferPurposeSchema>;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const httpsUrl = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
});
export const objectTransferRequestSchema = z.object({
  purpose: objectTransferPurposeSchema,
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(100),
  byteLength: z.number().int().positive().max(50 * 1024 * 1024),
  sha256,
  noteId: z.string().uuid().optional(),
  source: z.object({ type: z.enum(["text", "markdown", "code", "url"]).optional(), title: z.string().max(500).optional(), url: z.string().url().optional(), force: z.boolean().optional() }).strict().optional(),
}).strict();
export type ObjectTransferRequest = z.infer<typeof objectTransferRequestSchema>;
export const objectTransferUploadSchema = z.object({
  version: z.literal(1),
  transferId: z.string().uuid(),
  url: httpsUrl,
  method: z.literal("PUT"),
  headers: z.record(z.string()),
  expiresAt: z.string().datetime(),
}).strict();
export const objectTransferDownloadSchema = z.object({
  version: z.literal(1),
  kind: z.literal("object_download"),
  url: httpsUrl,
  contentType: z.string().min(1).max(100),
  byteLength: z.number().int().nonnegative().max(OBJECT_TRANSFER_MAX_BYTES),
  sha256: sha256.optional(),
  expiresAt: z.string().datetime(),
}).strict();
export type ObjectTransferDownload = z.infer<typeof objectTransferDownloadSchema>;
export const objectTransferConfigurationSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["local", "remote"]),
  origins: z.array(httpsUrl).max(4),
}).strict();
