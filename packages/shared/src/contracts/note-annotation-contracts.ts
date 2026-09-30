import { z } from "zod";

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
}).refine((anchor) => anchor.endBlockOrdinal === anchor.startBlockOrdinal
  && anchor.endOffset > anchor.startOffset, "批注必须对应同一段中的一段原文");
export type NoteAnnotationAnchorV1 = z.infer<typeof noteAnnotationAnchorV1Schema>;

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
  failureReason: z.enum(["ai_consent_required", "unknown"]).nullable(),
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
  z.strictObject({ removed: z.literal(true) }),
]);
export type NoteAnnotationCommandV1 = z.infer<typeof noteAnnotationCommandV1Schema>;
