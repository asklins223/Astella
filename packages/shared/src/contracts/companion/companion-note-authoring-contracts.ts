import { z } from "zod";
import { noteAnnotationAnchorV1Schema, noteAnnotationV1Schema } from "../note/note-annotation-contracts.ts";

/** The host binds the exact saved quote and operation identity before the agent starts writing. */
export const companionAnnotationTargetV1Schema = z.object({
  requestId: z.string().uuid(),
  anchor: noteAnnotationAnchorV1Schema,
}).strict();
export const companionWriteAnnotationV1Schema = z.object({
  markdown: z.string().trim().min(1).describe("独立、完整的原句解释正文，可包含例子、公式、列表或代码；不写聊天前言和执行状态"),
  final: z.boolean().optional().describe("这次解释写完即已交付时为 true（默认），无需再调模型确认。仅用户还有未完成的其他工作时为 false"),
}).strict();
export const companionWrittenAnnotationV1Schema = z.object({
  kind: z.literal("written_annotation"),
  requestId: z.string().uuid(),
  annotation: noteAnnotationV1Schema,
}).strict();
export type CompanionWrittenAnnotationV1 = z.infer<typeof companionWrittenAnnotationV1Schema>;

/**
 * 内容篇幅由模型窗口与笔记存储/更新的字节合同决定，不在这里再加一份 agent 专用的
 * 字符或条数配额——链接也同理：一篇新笔记引用几篇已有笔记由内容决定
 * （以前 links/linkedNotes 各封顶 6 条，第七个链接会让整次建笔记失败）。
 */
export const companionCreateNoteV1Schema = z.object({
  title: z.string().trim().min(1).max(200),
  markdown: z.string().trim().min(1).describe("根据当前讨论整理的完整独立笔记，支持标题、列表、表格、代码与公式"),
  links: z.array(z.object({
    noteId: z.string().uuid(),
    noteVersionId: z.string().uuid().describe("本轮notes.read.read实际返回的version"),
    reason: z.string().trim().min(5).max(240).describe("说明这篇已有笔记与新笔记的具体关系，不能只凭标题猜测"),
  }).strict()).default([]),
}).strict();
export type CompanionCreateNoteV1 = z.infer<typeof companionCreateNoteV1Schema>;

export const companionCreatedNoteV1Schema = z.object({
  kind: z.literal("created_note"),
  noteId: z.string().uuid(), noteVersionId: z.string().uuid(), title: z.string().min(1).max(200),
  linkedNotes: z.array(z.object({ noteId: z.string().uuid(), title: z.string().max(200) }).strict()),
}).strict();
export type CompanionCreatedNoteV1 = z.infer<typeof companionCreatedNoteV1Schema>;

/** Positions and source identity come from the current paper, never model guesses. */
export const companionNoteEditingContextV1Schema = z.object({
  tail: z.object({ block: z.number().int().nonnegative(), expectedBlock: z.string() }).strict().optional(),
  cursor: z.object({ block: z.number().int().nonnegative(), offset: z.number().int().nonnegative(),
    coordinate: z.enum(["document", "source", "reading"]), expectedBlock: z.string(), sourceText: z.string().optional() }).strict().optional(),
  selection: z.object({ startBlock: z.number().int().nonnegative(), endBlock: z.number().int().nonnegative(),
    startOffset: z.number().int().nonnegative(), endOffset: z.number().int().nonnegative(),
    excerpt: z.string().min(1), expectedBlocks: z.array(z.string()) }).strict().optional(),
}).strict();
export type CompanionNoteEditingContextV1 = z.infer<typeof companionNoteEditingContextV1Schema>;

export const companionEditNoteV1Schema = z.object({
  noteId: z.string().uuid(), noteVersionId: z.string().uuid(),
  operation: z.enum(["insert_at_cursor", "append", "replace_selection", "delete_selection", "replace_blocks", "delete_blocks"]),
  markdown: z.string().optional().describe("要插入或替换的新正文；只改措辞或数值时保留原来的标题、列表、表格与代码结构；表格用GFM，流程图用mermaid围栏"),
  preserveBlockStructure: z.boolean().optional().describe("replace_blocks默认true，核对原段落的块数、类型与属性不变。只有用户明确要求调整段落结构或格式时设false；普通改字、改数值保持true"),
  startBlock: z.number().int().nonnegative().optional().describe("复制读取结果首块的blockIndex（0起算），不要传ordinal；只改complete=true的整块"),
  endBlock: z.number().int().nonnegative().optional().describe("复制读取结果末块的blockIndex（包含该块）"),
  expectedBlocks: z.array(z.string()).min(1).optional().describe("逐字复制本轮实际读取的各块content，避免覆盖新改动"),
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
