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
/** Saving supplied prose and composing new prose are different user goals. */
export const COMPANION_NOTE_CONTENT_GUIDANCE = "用户给出要保存的正文时，以最小变更原样采用；标题只是文档名称，不是扩写主题。只有用户委托创作、扩写、改写或整理时，才按该要求生成新正文。文档使用用户要求的文体，不混入伴星的聊天口头禅、角色动作或执行说明。";

export const companionCreateNoteV1Schema = z.object({
  title: z.string().trim().min(1).max(200),
  markdown: z.string().trim().min(1).describe("实际保存的完整 Markdown 正文。" + COMPANION_NOTE_CONTENT_GUIDANCE + "独立段落用空行分隔，支持标题、列表、表格、代码与公式"),
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
  markdown: z.string().optional().describe("要插入或替换的 Markdown。replace_blocks 只填指定范围的新内容，不放范围外的正文；独立段落之间用空行分隔，单换行仍属同一段。保留原来的标题、列表、表格与代码结构"),
  preserveBlockStructure: z.boolean().optional().describe("replace_blocks默认true，核对原段落的块数、类型与属性不变。只有用户明确要求调整段落结构或格式时设false；普通改字、改数值保持true"),
  startBlock: z.number().int().nonnegative().optional().describe("起始块，复制读取结果的 blockIndex（0 起算，包含该块），不是 ordinal；只改 complete=true 的整块"),
  endBlock: z.number().int().nonnegative().optional().describe("结束块，复制读取结果的 blockIndex（包含该块）；只改一块时等于 startBlock"),
  expectedBlocks: z.array(z.string()).min(1).optional().describe("按顺序逐字复制 startBlock 至 endBlock 各块完整 content；长度必须等于 endBlock-startBlock+1，用于校验原文和版本"),
}).strict().superRefine((value, ctx) => {
  if (!value.operation.startsWith("delete") && !value.markdown?.trim()) ctx.addIssue({ code: "custom", path: ["markdown"], message: "需要新正文" });
  if (value.operation.endsWith("blocks")) {
    if (value.startBlock === undefined) ctx.addIssue({ code: "custom", path: ["startBlock"], message: "需要读取结果的起始 blockIndex（0 起算，包含）" });
    if (value.endBlock === undefined) ctx.addIssue({ code: "custom", path: ["endBlock"], message: "需要读取结果的结束 blockIndex（包含）；单块替换与 startBlock 相等" });
    if (value.startBlock !== undefined && value.endBlock !== undefined) {
      if (value.endBlock < value.startBlock) ctx.addIssue({ code: "custom", path: ["endBlock"], message: "endBlock 不能小于 startBlock" });
      else if (value.expectedBlocks?.length !== value.endBlock - value.startBlock + 1)
        ctx.addIssue({ code: "custom", path: ["expectedBlocks"], message: `范围包含 ${value.endBlock - value.startBlock + 1} 块，expectedBlocks 需要相同数量的完整原文；当前 ${value.expectedBlocks?.length ?? 0} 块` });
    }
  }
  if (value.operation.startsWith("delete") && value.markdown) ctx.addIssue({ code: "custom", path: ["markdown"], message: "删除不接收新正文" });
});
export type CompanionEditNoteV1 = z.infer<typeof companionEditNoteV1Schema>;

export const companionEditedNoteV1Schema = z.object({
  kind: z.literal("edited_note"), noteId: z.string().uuid(), noteVersionId: z.string().uuid(),
  operation: z.string(), summary: z.string().max(240), update: z.string().max(3_000_000),
}).strict();
export type CompanionEditedNoteV1 = z.infer<typeof companionEditedNoteV1Schema>;
