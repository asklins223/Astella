import { z } from "zod";

export const OBJECT_TRANSFER_HEADER = "X-Astella-Object-Transfer";
/**
 * 一次上传 / 下载的字节上限，全仓库只有这一个数：100 MB。
 *
 * 用户 2026-11-01 的决定是「不要限制大小，要限就限一个足够大的」。过去这条链上每
 * 一个环节各写一个数（正文 10 MB、图片 5 MB、头像 10 MB、伴星文件 20 MB、multipart
 * 全局 10 MB、WS 单帧 256 KB、nginx 25 MB、iOS 3 M 字符……），收口点越多，越先撞上的
 * 那一个决定的就是用户实际能传多大——而界面上一句"太大了"背后往往是另一处的数字。
 *
 * 所以这里是**下限口径**：任何一处已经比它更宽的（对象导出的 256 MB）保持更宽，
 * 任何一处比它小的都必须引用这一个，新增上传/下载口不要再写数字。
 */
export const TRANSFER_MAX_BYTES = 100 * 1024 * 1024;
/**
 * 同一个上限换成 base64 之后的字符上界：4/3 膨胀 + padding 与换行余量。
 *
 * 走 JSON body / data URL / IPC 的那些口判的是**字符数**，引用这一个而不是各自
 * `* 4` 或写死一个千位分隔的数字——判据与字节上限对不上时，症状是"客户端说收下了、
 * 服务端 413"，或者反过来（2026-10-31 实测到的 iOS 3 M 字符 vs 服务端 2 MiB 就是这一类）。
 */
export const TRANSFER_BASE64_MAX_CHARS = Math.ceil(TRANSFER_MAX_BYTES / 3) * 4 + 64;
/**
 * 一次**批量**动作在本机捏住的总量：单份上限 × 4。
 *
 * 用在 zip 导入、整文件夹导入、一次导出的图片总量这一类"很多份"的口子上。它不是
 * 某一份文件的上限（那一个就是 100 MB），倍数写在一处，改的人看得见它是内存与往返，
 * 而不是内容大小——过去这几个数字是 120 MB / 50 MB / 80 M 字符各写各的，比单份上限
 * 还小，症状是一篇 100 MB 里能存的笔记在批量那一步被拦下。
 */
export const TRANSFER_BATCH_MAX_BYTES = 4 * TRANSFER_MAX_BYTES;
export const TRANSFER_BATCH_BASE64_MAX_CHARS = Math.ceil(TRANSFER_BATCH_MAX_BYTES / 3) * 4 + 64;
export const OBJECT_TRANSFER_MAX_BYTES = 256 * 1024 * 1024;
/**
 * 一份文本来源正文的上限，只有这一个源。
 *
 * 客户端拦一次、`source_text` 用途拦一次、直传回退的那发 POST 拦一次、worker 回读再验一次；
 * 这四个数过去各写各的，改一处就会让另外三处对不上——症状是"界面说收下了，来源永远停在正在解析"。
 */
export const MAX_SOURCE_TEXT_BYTES = TRANSFER_MAX_BYTES;
/**
 * `markdown_import_image` 是导入 Markdown 时随正文一起带进来的图片（本地相对路径或外链
 * 抓回来的字节）。它单独成一个用途而不是复用 `note_image`，是因为那条硬要求一篇**已存在**
 * 的笔记（API 侧按 noteId 校验归属，回执才登记得了资产）——而导入的图此刻还没有笔记。
 */
export const objectTransferPurposeSchema = z.enum(["note_image", "companion_image", "companion_file", "avatar", "source_text", "markdown_import", "markdown_import_image"]);
export type ObjectTransferPurpose = z.infer<typeof objectTransferPurposeSchema>;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const httpsUrl = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
});
export const objectTransferRequestSchema = z.object({
  purpose: objectTransferPurposeSchema,
  storagePreference: z.enum(["primary", "backup"]).optional(),
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(100),
  byteLength: z.number().int().positive().max(TRANSFER_MAX_BYTES),
  sha256,
  noteId: z.string().uuid().optional(),
  source: z.object({ type: z.enum(["text", "markdown", "code", "url"]).optional(), title: z.string().max(500).optional(), url: z.string().url().optional(), origin: z.string().max(500).optional(), force: z.boolean().optional() }).strict().optional(),
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
