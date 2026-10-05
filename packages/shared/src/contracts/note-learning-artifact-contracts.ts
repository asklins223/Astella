import { z } from "zod";
import { noteAnnotationAnchorV1Schema } from "./note-annotation-contracts.ts";

export const createNoteDynamicArtifactTaskV1Schema = z.strictObject({
  noteVersionId: z.string().uuid(),
  requestId: z.string().uuid(),
  sourceKind: z.enum(["overview", "annotation"]),
  selectionAnchor: noteAnnotationAnchorV1Schema.optional(),
}).refine((input) => input.sourceKind === "annotation"
  ? Boolean(input.selectionAnchor && input.selectionAnchor.noteVersionId === input.noteVersionId)
  : input.selectionAnchor === undefined, {
  message: "局部讲解需要与原句一致的位置，速览不能附带选区",
  path: ["selectionAnchor"],
});

export const noteLearningArtifactTaskStatusV1Schema = z.enum(["queued", "running", "ready", "failed"]);
export const noteLearningArtifactTaskV1Schema = z.strictObject({
  taskId: z.string().uuid(),
  agentRunId: z.string().uuid().optional(),
  noteId: z.string().uuid(),
  noteVersionId: z.string().uuid(),
  sourceKind: z.enum(["overview", "annotation"]),
  selectionAnchor: noteAnnotationAnchorV1Schema.nullable(),
  status: noteLearningArtifactTaskStatusV1Schema,
  artifact: z.lazy(() => noteLearningArtifactV1Schema).nullable(),
  failureReason: z.enum(["ai_consent_required", "ai_data_policy_denied", "unknown"]).nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type NoteLearningArtifactTaskV1 = z.infer<typeof noteLearningArtifactTaskV1Schema>;
export const noteLearningArtifactTaskPageV1Schema = z.strictObject({
  version: z.literal(1),
  items: z.array(noteLearningArtifactTaskV1Schema).max(100),
});

export const noteLearningArtifactOutlineV1Schema = z.strictObject({
  index: z.number().int().min(0).max(5),
  title: z.string().min(1).max(24),
  narration: z.string().min(1).max(200),
  sectionLabel: z.string().min(1).max(200),
  quote: z.string().min(1).max(160),
});

export const noteLearningArtifactV1Schema = z.strictObject({
  artifactId: z.string().uuid(),
  noteId: z.string().uuid(),
  noteVersionId: z.string().uuid(),
  noteVersionNumber: z.number().int().positive(),
  generationJobId: z.string().uuid().nullable(),
  sourceMessageId: z.string().uuid().nullable(),
  conversationId: z.string().uuid().nullable(),
  sourceKind: z.enum(["overview", "annotation"]),
  selectionText: z.string().nullable(),
  selectionAnchor: noteAnnotationAnchorV1Schema.nullable(),
  sourceContentHash: z.string().min(8).max(128),
  generatorRef: z.string().min(1).max(200),
  title: z.string().min(1).max(40),
  subject: z.string().min(1).max(60),
  caution: z.string().min(1).max(120),
  outline: z.array(noteLearningArtifactOutlineV1Schema).min(2).max(6),
  versionState: z.enum(["current", "older"]),
  createdAt: z.string().datetime({ offset: true }),
});
export type NoteLearningArtifactV1 = z.infer<typeof noteLearningArtifactV1Schema>;
export type CreateNoteDynamicArtifactTaskV1 = z.infer<typeof createNoteDynamicArtifactTaskV1Schema>;

export const noteLearningArtifactPageV1Schema = z.strictObject({
  version: z.literal(1),
  items: z.array(noteLearningArtifactV1Schema).max(100),
  nextCursor: z.string().uuid().nullable(),
});
export const noteLearningArtifactListQueryV1Schema = z.strictObject({ before: z.string().uuid().optional() });
export const noteLearningArtifactWriteResultV1Schema = noteLearningArtifactV1Schema;

export const noteLearningArtifactTaskListQueryV1Schema = z.strictObject({ noteVersionId: z.string().uuid() });
