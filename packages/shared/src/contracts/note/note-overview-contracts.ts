import { z } from "zod";

/** A saved quick overview bound to the exact note version it read. */
export const noteOverviewV1Schema = z.strictObject({
  overviewId: z.string().uuid(),
  noteId: z.string().uuid(),
  noteVersionId: z.string().uuid(),
  noteVersionNumber: z.number().int().positive(),
  body: z.string().min(1),
  points: z.array(z.strictObject({
    explanation: z.string().min(8),
    blockOrdinal: z.number().int().min(0).max(100_000),
    quote: z.string().min(8),
  })).min(1).nullable().optional(),
  references: z.array(z.strictObject({
    blockOrdinal: z.number().int().min(0).max(100_000),
    quote: z.string().min(8),
  })),
  coverage: z.strictObject({
    totalBlocks: z.number().int().nonnegative().max(100_000),
    textBlocksRead: z.number().int().nonnegative().max(100_000),
    imageBlocksNotRead: z.number().int().nonnegative().max(100_000),
    /**
     * 因为"引用核不回原文"而被逐条剔除的要点数。放开长度与条数之后，一条核不上的
     * 引用不再让整份速看失败——它只是不出现；这个数让"少给了几条"是可见的，
     * 而不是无声的（0419 同一轮）。旧行没有这一格，所以是可选的。
     */
    pointsDropped: z.number().int().nonnegative().optional(),
  }).nullable(),
  generationJobId: z.string().uuid().nullable(),
  sourceMessageId: z.string().uuid().nullable(),
  conversationId: z.string().uuid().nullable(),
  versionState: z.enum(["current", "older"]),
  createdAt: z.string().datetime({ offset: true }),
});
export const noteOverviewPageV1Schema = z.strictObject({
  version: z.literal(1),
  items: z.array(noteOverviewV1Schema).max(100),
  nextCursor: z.string().uuid().nullable(),
});

export const noteOverviewListQueryV1Schema = z.strictObject({
  before: z.string().uuid().optional(),
});

export const createNoteOverviewTaskV1Schema = z.strictObject({
  noteVersionId: z.string().uuid(),
  requestId: z.string().uuid(),
});

export const noteOverviewTaskStatusV1Schema = z.enum(["queued", "running", "ready", "failed"]);
export const noteOverviewTaskFailureReasonV1Schema = z.enum(["ai_consent_required", "ai_data_policy_denied", "generation_incomplete", "unknown"]);
export const noteOverviewTaskV1Schema = z.strictObject({
  taskId: z.string().uuid(),
  agentRunId: z.string().uuid().optional(),
  noteId: z.string().uuid(),
  noteVersionId: z.string().uuid(),
  status: noteOverviewTaskStatusV1Schema,
  overview: noteOverviewV1Schema.nullable(),
  failureReason: noteOverviewTaskFailureReasonV1Schema.nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export const noteOverviewLatestTaskV1Schema = z.strictObject({
  version: z.literal(1),
  task: noteOverviewTaskV1Schema.nullable(),
});
export const noteOverviewLatestTaskQueryV1Schema = z.strictObject({
  noteVersionId: z.string().uuid(),
});

export type NoteOverviewV1 = z.infer<typeof noteOverviewV1Schema>;
export type NoteOverviewTaskV1 = z.infer<typeof noteOverviewTaskV1Schema>;
