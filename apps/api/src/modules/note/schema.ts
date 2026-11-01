import { z } from "zod";
import { MAX_SOURCE_TEXT_BYTES, TRANSFER_BASE64_MAX_CHARS, TRANSFER_MAX_BYTES } from "@astella/shared/object-transfer-contracts";

export interface NoteBlock {
  ordinal: number;
  type: "paragraph" | "heading" | "code" | "list" | "quote" | "image";
  content: string;
}

/**
 * 一块正文的字符上限 = 一份正文的字节上限。UTF-8 里字符数不会超过字节数，
 * 所以这一条不会比请求体本身更早收紧；笔记大小由传输上限那一个数说，不在这里另设一档。
 */
const NOTE_BLOCK_CONTENT_MAX_CHARS = MAX_SOURCE_TEXT_BYTES;

export const noteCreateSchema = z.object({
  // 可省略，自动从 blocks 第一个 heading/paragraph 提取
  title: z.string().max(200).optional().default(""),
  blocks: z
    .array(
      z.object({
        type: z.enum(["paragraph", "heading", "code", "list", "quote", "image"]),
        content: z.string().max(NOTE_BLOCK_CONTENT_MAX_CHARS),
      }),
    )
    .optional()
    .default([]),
});

export type NoteCreateInput = z.output<typeof noteCreateSchema>;

/** 一条 yjs 增量的原始字节上限（base64 解码之后）：与文件传输同一个 100 MB。 */
export const NOTE_DOC_UPDATE_MAX_BYTES = TRANSFER_MAX_BYTES;
/** 上送那条 base64 的字符上限：由上面的字节上限推出来，不再各写一个乘数。 */
export const NOTE_DOC_UPDATE_BASE64_MAX_CHARS = TRANSFER_BASE64_MAX_CHARS;

/**
 * 正文增量上送（批次 4.3）。
 *
 * 只收 base64 的 yjs update，不收"整篇正文"：整篇写入在并发下会复制块（4.0 实测），
 * 而且那正是"后写覆盖前写且无从恢复"这个原始缺陷的形状。
 *
 * 这里**不用 `.base64()`**：zod 的 base64 是一条带分组的正则，几 MB 的输入会让
 * `RegExp.test` 直接抛 `RangeError: Maximum call stack size exceeded`（实测 500），
 * 而链上 `.base64()` 又先于 `.max()` 执行，长度挡不住它。合法性改由路由做
 * "解码后再编码回去"的往返检查（要求规范化的带 padding base64），尺寸按字节判。
 */
export const noteDocUpdateRequestV1Schema = z.object({
  update: z.string().min(1).max(NOTE_DOC_UPDATE_BASE64_MAX_CHARS),
});
