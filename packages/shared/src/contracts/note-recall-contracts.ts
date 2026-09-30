import { z } from "zod";

export const noteRecallSelfReportV1Schema = z.enum(["remembered", "partly", "not_yet"]);

export const noteRecallRecordV1Schema = z.strictObject({
  recallId: z.string().uuid(),
  noteId: z.string().uuid(),
  noteVersionId: z.string().uuid(),
  noteVersionNumber: z.number().int().positive(),
  sectionOrdinal: z.number().int().positive().nullable(),
  sectionTitle: z.string().max(200).nullable(),
  question: z.string().min(1).max(500),
  hint: z.string().min(1).max(1_000).optional(),
  sourceMessageId: z.string().uuid().nullable(),
  conversationId: z.string().uuid().nullable(),
  hintSourceMessageId: z.string().uuid().nullable(),
  hintConversationId: z.string().uuid().nullable(),
  answer: z.string().min(1).max(20_000).optional(),
  answerTruncated: z.boolean(),
  selfReport: noteRecallSelfReportV1Schema.nullable(),
  reflection: z.string().max(2_000).nullable(),
  state: z.enum(["waiting", "hinted", "revealed", "reported"]),
  versionState: z.enum(["current", "older"]),
  createdAt: z.string().datetime({ offset: true }),
  hintViewedAt: z.string().datetime({ offset: true }).nullable(),
  revealedAt: z.string().datetime({ offset: true }).nullable(),
  reportedAt: z.string().datetime({ offset: true }).nullable(),
});
export type NoteRecallRecordV1 = z.infer<typeof noteRecallRecordV1Schema>;

export const noteRecallPageV1Schema = z.strictObject({
  version: z.literal(1),
  items: z.array(noteRecallRecordV1Schema).max(100),
  nextCursor: z.string().uuid().nullable(),
});

export const noteRecallListQueryV1Schema = z.strictObject({ before: z.string().uuid().optional() });
export const noteRecallStartInputV1Schema = z.strictObject({
  requestId: z.string().uuid(),
  noteVersionId: z.string().uuid(),
  sourceMessageId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
}).refine((input) => Boolean(input.sourceMessageId) === Boolean(input.conversationId), {
  message: "伴星来源需要同时提供消息与对话标识",
});
export const noteRecallStartResultV1Schema = noteRecallRecordV1Schema;

export const noteRecallActionV1Schema = z.union([
  z.strictObject({
    kind: z.literal("hint"),
    sourceMessageId: z.string().uuid().optional(),
    conversationId: z.string().uuid().optional(),
  }),
  z.strictObject({ kind: z.literal("reveal") }),
  z.strictObject({
    kind: z.literal("self_report"),
    value: noteRecallSelfReportV1Schema,
    reflection: z.string().trim().max(2_000).optional(),
  }),
]).refine((input) => input.kind !== "hint" || Boolean(input.sourceMessageId) === Boolean(input.conversationId), {
  message: "伴星线索需要同时提供消息与对话标识",
});
export const noteRecallActionResultV1Schema = noteRecallRecordV1Schema;
