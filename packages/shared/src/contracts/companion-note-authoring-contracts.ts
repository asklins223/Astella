import { z } from "zod";

export const companionCreateNoteV1Schema = z.object({
  title: z.string().trim().min(1).max(200),
  markdown: z.string().trim().min(20).max(12_000).describe("根据当前讨论整理的完整独立笔记，支持标题、列表、表格、代码与公式"),
  links: z.array(z.object({
    noteId: z.string().uuid(),
    noteVersionId: z.string().uuid().describe("本轮companion_read_note实际返回的version"),
    reason: z.string().trim().min(5).max(240).describe("说明这篇已有笔记与新笔记的具体关系，不能只凭标题猜测"),
  }).strict()).max(6).default([]),
}).strict();
export type CompanionCreateNoteV1 = z.infer<typeof companionCreateNoteV1Schema>;

export const companionCreatedNoteV1Schema = z.object({
  kind: z.literal("created_note"),
  noteId: z.string().uuid(), noteVersionId: z.string().uuid(), title: z.string().min(1).max(200),
  linkedNotes: z.array(z.object({ noteId: z.string().uuid(), title: z.string().max(200) }).strict()).max(6),
}).strict();
export type CompanionCreatedNoteV1 = z.infer<typeof companionCreatedNoteV1Schema>;

/** Positions and source identity come from the current paper, never model guesses. */
export const companionNoteEditingContextV1Schema = z.object({
  tail: z.object({ block: z.number().int().nonnegative(), expectedBlock: z.string().max(100_000) }).strict().optional(),
  cursor: z.object({ block: z.number().int().nonnegative(), offset: z.number().int().nonnegative(),
    coordinate: z.enum(["document", "source", "reading"]), expectedBlock: z.string().max(100_000), sourceText: z.string().max(100_000).optional() }).strict().optional(),
  selection: z.object({ startBlock: z.number().int().nonnegative(), endBlock: z.number().int().nonnegative(),
    startOffset: z.number().int().nonnegative(), endOffset: z.number().int().nonnegative(),
    excerpt: z.string().min(1).max(20_000), expectedBlocks: z.array(z.string().max(100_000)).max(100) }).strict().optional(),
}).strict();
export type CompanionNoteEditingContextV1 = z.infer<typeof companionNoteEditingContextV1Schema>;

export const companionEditNoteV1Schema = z.object({
  noteId: z.string().uuid(), noteVersionId: z.string().uuid(),
  operation: z.enum(["insert_at_cursor", "append", "replace_selection", "delete_selection", "replace_blocks", "delete_blocks"]),
  markdown: z.string().max(20_000).optional().describe("要插入或替换的新正文；表格用GFM，流程图用mermaid围栏"),
  startBlock: z.number().int().nonnegative().optional().describe("0起算，正文读取的第1块对应0"),
  endBlock: z.number().int().nonnegative().optional(),
  expectedBlocks: z.array(z.string().max(100_000)).min(1).max(100).optional().describe("逐字复制本轮实际读取的各块content，避免覆盖新改动"),
}).strict().superRefine((value, ctx) => {
  if (!value.operation.startsWith("delete") && !value.markdown?.trim()) ctx.addIssue({ code: "custom", path: ["markdown"], message: "需要新正文" });
  if (value.operation.endsWith("blocks") && (value.startBlock === undefined || value.endBlock === undefined
    || value.endBlock < value.startBlock || value.expectedBlocks?.length !== value.endBlock - value.startBlock + 1))
    ctx.addIssue({ code: "custom", path: ["expectedBlocks"], message: "需要可核对的段落范围和原文" });
  if (value.operation.startsWith("delete") && value.markdown) ctx.addIssue({ code: "custom", path: ["markdown"], message: "删除不接收新正文" });
});
export type CompanionEditNoteV1 = z.infer<typeof companionEditNoteV1Schema>;

export const companionEditedNoteV1Schema = z.object({
  kind: z.literal("edited_note"), noteId: z.string().uuid(), noteVersionId: z.string().uuid(),
  operation: z.string(), summary: z.string().max(240), update: z.string().max(3_000_000),
}).strict();
export type CompanionEditedNoteV1 = z.infer<typeof companionEditedNoteV1Schema>;
