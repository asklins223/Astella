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
  failureReason: z.enum(["ai_consent_required", "ai_data_policy_denied", "generation_incomplete", "unknown"]).nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type NoteLearningArtifactTaskV1 = z.infer<typeof noteLearningArtifactTaskV1Schema>;
export const noteLearningArtifactTaskPageV1Schema = z.strictObject({
  version: z.literal(1),
  items: z.array(noteLearningArtifactTaskV1Schema).max(100),
});

export const noteLearningArtifactOutlineV1Schema = z.strictObject({
  // 序号（第几步），由落库时的数组顺序决定。**不设上限**：演示的要点条数由内容决定
  // （生成侧按段落读完笔记，每段产出能核对得上的要点），这里只是宽度护栏的旧残影。
  // 曾钉 `max(5)`：超 6 条的演示生成成功后读回时 ZodError → 500「做出来但拿不回来」
  // （2026-10-14 实测：8 条 outline 的 artifact GET 500）。
  index: z.number().int().min(0),
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
  // 至少 2 条（一个"演示"讲不动 1 步），**不设条数上限**：条数由内容决定，
  // 生成侧的 doc 合同（round-artifact-model.ts 的 dynamicArtifactDocV1Schema）早已
  // 只有 min、没有 max；这里跟着放开，读回与落库才说得上同一句话。
  outline: z.array(noteLearningArtifactOutlineV1Schema).min(2),
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
