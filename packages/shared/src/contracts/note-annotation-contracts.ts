import { z } from "zod";
import { noteBlockRenderedTextV1 } from "../note-doc-schema.ts";

/** Exact location in the rendered, immutable note version that the learner selected. */
export const noteAnnotationAnchorV1Schema = z.strictObject({
  noteVersionId: z.string().uuid(),
  startBlockOrdinal: z.number().int().min(0).max(100_000),
  startOffset: z.number().int().min(0).max(10_000_000),
  endBlockOrdinal: z.number().int().min(0).max(100_000),
  endOffset: z.number().int().min(0).max(10_000_000),
  excerpt: z.string().trim().min(1).max(2_000),
  prefix: z.string().max(120),
  suffix: z.string().max(120),
}).refine((anchor) => anchor.endBlockOrdinal > anchor.startBlockOrdinal
  || anchor.endBlockOrdinal === anchor.startBlockOrdinal && anchor.endOffset > anchor.startOffset,
"批注的结束位置必须在开始位置之后");
export type NoteAnnotationAnchorV1 = z.infer<typeof noteAnnotationAnchorV1Schema>;

type AnchorBlock = { readonly ordinal: number; readonly type: string; readonly content: string };

/** Range offsets belong to each block's rendered text. Paragraph boundaries use two newlines. */
export function readNoteAnchorTextV1(blocks: readonly AnchorBlock[], anchor: Pick<NoteAnnotationAnchorV1,
  "startBlockOrdinal" | "endBlockOrdinal" | "startOffset" | "endOffset">): { excerpt: string; prefix: string; suffix: string } | null {
  const selected = blocks.filter(block => block.ordinal >= anchor.startBlockOrdinal && block.ordinal <= anchor.endBlockOrdinal)
    .sort((a, b) => a.ordinal - b.ordinal);
  if (anchor.endBlockOrdinal < anchor.startBlockOrdinal || selected.length !== anchor.endBlockOrdinal - anchor.startBlockOrdinal + 1) return null;
  const texts = selected.map(block => noteBlockRenderedTextV1(block.type, block.content));
  const first = texts[0], last = texts.at(-1);
  if (first === undefined || last === undefined || anchor.startOffset < 0 || anchor.startOffset > first.length
    || anchor.endOffset < 0 || anchor.endOffset > last.length
    || selected.length === 1 && anchor.endOffset <= anchor.startOffset) return null;
  return {
    excerpt: texts.map((text, index) => text.slice(index === 0 ? anchor.startOffset : 0,
      index === texts.length - 1 ? anchor.endOffset : text.length)).join("\n\n"),
    prefix: first.slice(Math.max(0, anchor.startOffset - 120), anchor.startOffset),
    suffix: last.slice(anchor.endOffset, anchor.endOffset + 120),
  };
}

export function noteAnchorMatchesV1(blocks: readonly AnchorBlock[], anchor: NoteAnnotationAnchorV1): boolean {
  const text = readNoteAnchorTextV1(blocks, anchor);
  return text !== null && text.excerpt === anchor.excerpt && text.prefix === anchor.prefix && text.suffix === anchor.suffix;
}

/** The piece of a multi-paragraph anchor that belongs on this block. Never rewrites the saved anchor. */
export function noteAnchorBlockRangeV1(block: AnchorBlock, anchor: NoteAnnotationAnchorV1): readonly [number, number] | null {
  if (block.ordinal < anchor.startBlockOrdinal || block.ordinal > anchor.endBlockOrdinal) return null;
  const text = noteBlockRenderedTextV1(block.type, block.content);
  const start = block.ordinal === anchor.startBlockOrdinal ? anchor.startOffset : 0;
  const end = block.ordinal === anchor.endBlockOrdinal ? anchor.endOffset : text.length;
  return start < end && start >= 0 && end <= text.length ? [start, end] : null;
}

export const noteAnnotationV1Schema = z.strictObject({
  annotationId: z.string().uuid(),
  noteId: z.string().uuid(),
  anchor: noteAnnotationAnchorV1Schema,
  explanation: z.string().max(8_000),
  sourceMessageId: z.string().max(160).nullable(),
  generationJobId: z.string().uuid().nullable(),
  revision: z.number().int().min(1),
  versionState: z.enum(["current", "older"]),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type NoteAnnotationV1 = z.infer<typeof noteAnnotationV1Schema>;

export const noteAnnotationPageV1Schema = z.strictObject({
  version: z.literal(1),
  items: z.array(noteAnnotationV1Schema).max(200),
  nextCursor: z.string().uuid().nullable(),
});
export const noteAnnotationListQueryV1Schema = z.strictObject({
  noteVersionId: z.string().uuid().optional(),
  before: z.string().uuid().optional(),
});
export const createNoteAnnotationV1Schema = z.strictObject({
  anchor: noteAnnotationAnchorV1Schema,
  explanation: z.string().trim().min(1).max(8_000),
  sourceMessageId: z.string().trim().min(1).max(160).optional(),
});
export const createNoteAnnotationTaskV1Schema = z.strictObject({
  anchor: noteAnnotationAnchorV1Schema,
  requestId: z.string().uuid(),
});
export const noteAnnotationTaskV1Schema = z.strictObject({
  taskId: z.string().uuid(),
  noteId: z.string().uuid(),
  noteVersionId: z.string().uuid(),
  anchor: noteAnnotationAnchorV1Schema,
  status: z.enum(["queued", "running", "ready", "failed"]),
  annotation: noteAnnotationV1Schema.nullable(),
  failureReason: z.enum(["ai_consent_required", "ai_data_policy_denied", "unknown"]).nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type NoteAnnotationTaskV1 = z.infer<typeof noteAnnotationTaskV1Schema>;
export const noteAnnotationLatestTaskQueryV1Schema = z.strictObject({ noteVersionId: z.string().uuid() });
export const noteAnnotationLatestTaskV1Schema = z.strictObject({ version: z.literal(1), task: noteAnnotationTaskV1Schema.nullable() });
export const updateNoteAnnotationV1Schema = z.strictObject({
  expectedRevision: z.number().int().min(1),
  explanation: z.string().trim().max(8_000),
});
export const deleteNoteAnnotationV1Schema = z.strictObject({
  expectedRevision: z.number().int().min(1),
});
export const noteAnnotationCommandV1Schema = z.discriminatedUnion("kind", [
  createNoteAnnotationV1Schema.extend({ kind: z.literal("create") }),
  updateNoteAnnotationV1Schema.extend({ kind: z.literal("update"), annotationId: z.string().uuid() }),
  deleteNoteAnnotationV1Schema.extend({ kind: z.literal("remove"), annotationId: z.string().uuid() }),
]);
export const noteAnnotationWriteResultV1Schema = z.union([
  noteAnnotationV1Schema,
  // `removedArtifacts` 是**连带删掉的动态讲解页数**。带上它是为了让屏上说得清
  // 「这条批注和它那个演示一起没了」——产物与批注之间没有外键（两边靠同一段
  // 原句的锚点对上），所以「删干净了没有」必须从回执里读，不能由界面推断。
  //
  // 伴星的对话**不在这个回执里也不在这次删除里**：迁移 0323 已经 drop 了产物对
  // `companion_messages` 的外键，就是为了「聊天记录可以被清掉而不带走笔记的
  // 学习记录」；反过来说，删批注也不会删聊天。
  z.strictObject({ removed: z.literal(true), removedArtifacts: z.number().int().min(0) }),
]);
export type NoteAnnotationCommandV1 = z.infer<typeof noteAnnotationCommandV1Schema>;
