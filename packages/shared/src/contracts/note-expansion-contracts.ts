import { z } from "zod";
import { noteAnnotationAnchorV1Schema } from "./note-annotation-contracts.ts";

export const noteExpansionBlockV1Schema = z.strictObject({
  type: z.enum(["paragraph", "heading", "code", "list", "quote"]),
  content: z.string().trim().min(1).max(20_000),
});

export const noteExpansionReferenceV1Schema = z.strictObject({
  blockOrdinal: z.number().int().min(0).max(100_000),
  quote: z.string().trim().min(8).max(500),
});

export const noteExpansionDraftV1Schema = z.strictObject({
  candidateId: z.string().uuid(),
  requestId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  relationship: z.string().trim().min(8).max(600),
  sourceReferences: z.array(noteExpansionReferenceV1Schema).min(1).max(6),
  blocks: z.array(noteExpansionBlockV1Schema).min(1).max(100),
  selected: z.boolean(),
}).refine((draft) => draft.blocks.reduce((total, block) => total + block.content.length, 0) <= 20_000, {
  message: "拓展笔记正文不能超过 20000 个字符",
  path: ["blocks"],
});
export type NoteExpansionDraftV1 = z.infer<typeof noteExpansionDraftV1Schema>;

export const createNoteExpansionTaskV1Schema = z.strictObject({
  noteVersionId: z.string().uuid(),
  requestId: z.string().uuid(),
  focusAnchor: noteAnnotationAnchorV1Schema.optional(),
  sourceMessageId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
}).refine((input) => Boolean(input.sourceMessageId) === Boolean(input.conversationId), {
  message: "伴星来源需要同时提供回复和对话编号",
  path: ["conversationId"],
}).refine((input) => !input.focusAnchor || input.focusAnchor.noteVersionId === input.noteVersionId, {
  message: "拓展选区必须属于指定笔记版本",
  path: ["focusAnchor"],
});
export type CreateNoteExpansionTaskV1 = z.infer<typeof createNoteExpansionTaskV1Schema>;

export const noteExpansionTaskStatusV1Schema = z.enum(["queued", "running", "ready", "confirmed", "failed"]);
export const noteExpansionTaskFailureReasonV1Schema = z.enum(["ai_consent_required", "source_too_long", "unknown"]);
export const noteExpansionTaskV1Schema = z.strictObject({
  taskId: z.string().uuid(),
  noteId: z.string().uuid(),
  noteVersionId: z.string().uuid(),
  focusAnchor: noteAnnotationAnchorV1Schema.nullable(),
  sourceMessageId: z.string().uuid().nullable(),
  conversationId: z.string().uuid().nullable(),
  status: noteExpansionTaskStatusV1Schema,
  drafts: z.array(noteExpansionDraftV1Schema).max(4),
  confirmedCandidateIds: z.array(z.string().uuid()).max(4).nullable(),
  failureReason: noteExpansionTaskFailureReasonV1Schema.nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type NoteExpansionTaskV1 = z.infer<typeof noteExpansionTaskV1Schema>;
export const noteExpansionLatestTaskV1Schema = z.strictObject({ version: z.literal(1), task: noteExpansionTaskV1Schema.nullable() });
export const noteExpansionLatestTaskQueryV1Schema = z.strictObject({ noteVersionId: z.string().uuid() });

export const noteExpansionReviewV1Schema = z.strictObject({
  drafts: z.array(z.strictObject({
    candidateId: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    blocks: z.array(noteExpansionBlockV1Schema).min(1).max(100),
    selected: z.boolean(),
  }).refine((draft) => draft.blocks.reduce((total, block) => total + block.content.length, 0) <= 20_000, {
    message: "拓展笔记正文不能超过 20000 个字符",
    path: ["blocks"],
  })).min(1).max(4),
}).refine((input) => new Set(input.drafts.map((draft) => draft.candidateId)).size === input.drafts.length, {
  message: "每篇草稿只能出现一次",
  path: ["drafts"],
});
export type NoteExpansionReviewV1 = z.infer<typeof noteExpansionReviewV1Schema>;

export const confirmNoteExpansionTaskV1Schema = z.strictObject({
  candidateIds: z.array(z.string().uuid()).min(1).max(4),
}).refine((input) => new Set(input.candidateIds).size === input.candidateIds.length, {
  message: "每篇草稿只能确认一次",
  path: ["candidateIds"],
});

export const noteExpansionLinkV1Schema = z.strictObject({
  expansionId: z.string().uuid(),
  sourceNoteId: z.string().uuid(),
  sourceNoteVersionId: z.string().uuid(),
  sourceNoteVersionNumber: z.number().int().positive(),
  sourceTaskId: z.string().uuid().nullable(),
  expandedNoteId: z.string().uuid(),
  expandedNoteVersionId: z.string().uuid(),
  expandedNoteVersionNumber: z.number().int().positive(),
  sourceMessageId: z.string().uuid().nullable(),
  conversationId: z.string().uuid().nullable(),
  otherNoteTitle: z.string().min(1).max(200),
  direction: z.enum(["expanded_from_here", "source_note"]),
  createdAt: z.string().datetime({ offset: true }),
});
export type NoteExpansionLinkV1 = z.infer<typeof noteExpansionLinkV1Schema>;

export const noteExpansionPageV1Schema = z.strictObject({
  version: z.literal(1),
  items: z.array(noteExpansionLinkV1Schema).max(100),
  nextCursor: z.strictObject({ createdAt: z.string().datetime({ offset: true }), expansionId: z.string().uuid() }).nullable(),
});

export const noteExpansionListQueryV1Schema = z.strictObject({
  beforeCreatedAt: z.string().datetime({ offset: true }).optional(),
  beforeExpansionId: z.string().uuid().optional(),
}).refine((value) => Boolean(value.beforeCreatedAt) === Boolean(value.beforeExpansionId));

export const noteExpansionBatchWriteResultV1Schema = z.array(noteExpansionLinkV1Schema).min(1).max(4);
