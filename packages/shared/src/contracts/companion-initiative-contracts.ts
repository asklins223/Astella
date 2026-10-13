import { z } from "zod";

/** User prose is the authority. Topics and dates below are the agent's revocable execution arrangements. */
export const companionParticipationPreferencesV1Schema = z.object({
  version: z.literal(1), revision: z.number().int().nonnegative(),
  enabled: z.boolean(), markdown: z.string().max(16_000),
  updatedAt: z.string().datetime({ offset: true }).nullable(),
  source: z.object({
    kind: z.enum(["user_message", "settings"]),
    workspaceId: z.string().uuid(), messageId: z.string().uuid().nullable(),
    quote: z.string().max(20_000).nullable(),
  }).strict().nullable(),
}).strict();
export type CompanionParticipationPreferencesV1 = z.infer<typeof companionParticipationPreferencesV1Schema>;
export const EMPTY_PARTICIPATION_PREFERENCES: CompanionParticipationPreferencesV1 = {
  version: 1, revision: 0, enabled: true, markdown: "", updatedAt: null, source: null,
};
export const companionParticipationPreferencesWriteV1Schema = z.object({
  expectedRevision: z.number().int().nonnegative(), markdown: z.string().max(16_000),
  enabled: z.boolean(),
}).strict();
export const companionParticipationToolWriteV1Schema = companionParticipationPreferencesWriteV1Schema.extend({
  sourceQuote: z.string().min(1).max(2_000).describe("本轮用户要求以后怎样相处的逐字原话；不能引用历史或自己的判断"),
}).strict();

export const COMPANION_AWARENESS_TOPICS = [
  "app.started", "app.foreground", "page.arrived", "help.available", "result.available",
  "reply.finished", "preference.changed", "study.started",
] as const;
export const companionAwarenessTopicV1Schema = z.enum(COMPANION_AWARENESS_TOPICS);
export type CompanionAwarenessTopicV1 = z.infer<typeof companionAwarenessTopicV1Schema>;
export const companionAttentionWriteV1Schema = z.object({
  key: z.string().min(1).max(120), expectedRevision: z.number().int().nonnegative(),
  intent: z.string().min(1).max(4_000).describe("为什么要继续关注、下一步、何时不必继续；不是给用户创造的固定规则"),
  topics: z.array(companionAwarenessTopicV1Schema).max(8),
  nextReviewAt: z.string().datetime({ offset: true }).nullable(),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  preferenceRevision: z.number().int().nonnegative().nullable(),
  selfNote: z.object({ key: z.string().min(1).max(120), revision: z.number().int().positive() }).strict().nullable(),
  state: z.enum(["active", "completed"]),
}).strict();
export type CompanionAttentionWriteV1 = z.infer<typeof companionAttentionWriteV1Schema>;
export const companionAttentionV1Schema = companionAttentionWriteV1Schema.omit({ expectedRevision: true }).extend({
  revision: z.number().int().positive(), conversationId: z.string().uuid().nullable(),
  parentRunId: z.string().uuid().nullable(), updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type CompanionAttentionV1 = z.infer<typeof companionAttentionV1Schema>;

export const companionAwarenessContextV1Schema = z.object({
  foreground: z.boolean(), unlocked: z.boolean(), typing: z.boolean(), learning: z.boolean(),
  speaking: z.boolean().optional(), participationAllowed: z.boolean().optional(),
  conversationId: z.string().uuid().nullable(),
  page: z.object({
    key: z.string().min(1).max(240), label: z.string().min(1).max(120),
    revision: z.string().min(1).max(200).nullable(),
    context: z.record(z.unknown()).nullable(),
  }).strict().nullable(),
}).strict();
export type CompanionAwarenessContextV1 = z.infer<typeof companionAwarenessContextV1Schema>;
export const companionAwarenessObservationV1Schema = z.object({
  version: z.literal(1), id: z.string().uuid(),
  deviceSessionId: z.string().min(1).max(200), appLaunchId: z.string().uuid(),
  host: z.enum(["desktop", "browser"]),
  topic: z.enum(["app.started", "app.foreground", "page.arrived", "help.available", "result.available", "context.updated"]),
  occurredAt: z.string().datetime({ offset: true }),
  /** Monotonic elapsed duration; wall-clock changes, lock, sleep and background do not earn study time. */
  elapsedMs: z.number().int().min(0).max(45_000),
  context: companionAwarenessContextV1Schema,
  evidence: z.object({
    domain: z.enum(["notebook", "run", "settings", "library", "source", "space", "companion", "review", "study"]),
    entityId: z.string().max(200), revision: z.string().max(200),
    description: z.string().min(1).max(1_000),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (["help.available", "result.available"].includes(value.topic) && !value.evidence)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["evidence"], message: "help requires actual domain evidence" });
  if (value.topic === "page.arrived" && !value.context.page)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["context", "page"], message: "page arrival requires a readable page" });
});
export type CompanionAwarenessObservationV1 = z.infer<typeof companionAwarenessObservationV1Schema>;
export const companionAwarenessReceiptV1Schema = z.object({
  version: z.literal(1), accepted: z.boolean(), observationId: z.string().uuid(),
}).strict();
export const companionAwarenessIdentityV1Schema = z.object({
  version: z.literal(1), appLaunchId: z.string().uuid(), deviceSessionId: z.string().min(1).max(200),
  host: z.enum(["desktop", "browser"]),
}).strict();
export const companionInitiativeDeliveryRefV1Schema = z.object({
  conversationId: z.string().uuid(), messageId: z.string().uuid(), runId: z.string().uuid(),
  generation: z.number().int().positive(), deviceSessionId: z.string().max(200).nullable(),
}).strict();
export type CompanionInitiativeDeliveryRefV1 = z.infer<typeof companionInitiativeDeliveryRefV1Schema>;
export const companionInitiativeInputV1Schema = z.object({
  version: z.literal(1), kind: z.literal("initiative"),
  preparationJobId: z.string().uuid(),
  observationId: z.string().uuid().nullable(), attentionKey: z.string().max(120).nullable(),
  attentionRevision: z.number().int().positive().nullable(),
  preferenceRevision: z.number().int().nonnegative(),
  parentRunId: z.string().uuid().nullable(), deviceSessionId: z.string().max(200).nullable(),
  topic: z.string().min(1).max(80), intent: z.string().max(4_000),
  facts: z.record(z.unknown()),
}).strict();
export type CompanionInitiativeInputV1 = z.infer<typeof companionInitiativeInputV1Schema>;

/** A semantic utterance is complete, persists in history, and can be interrupted independently. */
export const companionPublishUtteranceV1Schema = z.object({
  text: z.string().min(1).max(12_000).describe("本次实际要说的一个完整意思；代码、公式和连续论证保留完整"),
  final: z.boolean().optional().describe("本轮所有话已经说完时为 true（默认）；一批分句只在最后一条标 true。仅确有查阅或新工作要继续时标 false"),
}).strict();
export const companionFinishParticipationV1Schema = z.object({
  decision: z.literal("silent").describe("没有新的有用内容，直接结束本次内部考虑，不产生用户消息"),
}).strict();
