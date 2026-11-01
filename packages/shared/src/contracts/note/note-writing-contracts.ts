import { z } from "zod";
import { MAX_SOURCE_TEXT_BYTES, TRANSFER_BASE64_MAX_CHARS } from "../desktop/object-transfer-contracts.ts";

/**
 * 笔记写入/导出的形状上限。数字全部由 `TRANSFER_MAX_BYTES`（100 MB）推出来：
 * markdown 与图片说明按字符（UTF-8 下字符数不超过字节数），base64 与 HTML 按展开后的
 * 字符上界。过去这里是 4M / 8M / 16M 三个自估的数字，症状是"一篇大笔记在库里好好的，
 * 导出时那一发 IPC 直接被 schema 拒掉"。
 */
export const noteWritingActionSchema = z.object({
  action: z.enum(["folder", "open", "read", "save", "assets", "image", "export", "clipboard"]),
  src: z.string().max(4096).optional(),
  path: z.string().max(4096).optional(), revision: z.number().optional(), title: z.string().max(300).optional(),
  markdown: z.string().max(MAX_SOURCE_TEXT_BYTES).optional(), html: z.string().max(TRANSFER_BASE64_MAX_CHARS).optional(),
  format: z.enum(["md", "html", "pdf", "docx"]).optional(),
  images: z.array(z.object({ src: z.string().max(MAX_SOURCE_TEXT_BYTES), mime: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]), base64: z.string().max(TRANSFER_BASE64_MAX_CHARS) })).max(100).optional(),
});
export type NoteWritingAction = z.infer<typeof noteWritingActionSchema>;
export const noteWritingResultSchema = z.object({
  canceled: z.boolean().optional(), path: z.string().optional(), markdown: z.string().optional(), revision: z.number().optional(),
  entries: z.array(z.object({ path: z.string(), name: z.string() })).optional(),
  mime: z.string().optional(), base64: z.string().optional(), warnings: z.array(z.string()).optional(),
});
export type NoteWritingResult = z.infer<typeof noteWritingResultSchema>;
