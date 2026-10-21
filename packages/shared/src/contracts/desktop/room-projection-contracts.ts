/**
 * Renderer-safe RoomProjection adapter contract.
 *
 * Plan 57 之后首页只说这个空间里真实存在的笔记与来源：没有目标、复习、
 * 学习运行或制卡批次。读不到的部分如实报告为不可用，不编一个零。
 */
import { z } from "zod";

const uuidSchema = z.string().uuid();
const isoTimestampSchema = z.string().datetime({ offset: true });
const nonEmptyStringSchema = z.string().min(1).max(1000).refine(
  (value) => !/[\u0000-\u001f\u007f]/.test(value),
  "control characters are not allowed",
);

export const roomSectionStatusV1Schema = z.enum(["loading", "data", "empty", "error"]);
export type RoomSectionStatusV1 = z.infer<typeof roomSectionStatusV1Schema>;

export const roomSectionErrorReasonV1Schema = z.enum([
  "upstream_unavailable",
  "unsupported_contract",
  "permission_denied",
  "stale_workspace",
  "route_not_available",
]);

const roomSectionErrorSchema = z.strictObject({
  state: z.literal("error"),
  reason: roomSectionErrorReasonV1Schema,
  retryable: z.boolean(),
});

function roomSectionSchema<TSchema extends z.ZodTypeAny>(dataSchema: TSchema) {
  return z.discriminatedUnion("state", [
    z.strictObject({ state: z.literal("loading") }),
    z.strictObject({ state: z.literal("data"), data: dataSchema }),
    z.strictObject({ state: z.literal("empty") }),
    roomSectionErrorSchema,
  ]);
}

export const roomSectionStateV1Schema = z.strictObject({ state: roomSectionStatusV1Schema });

export const roomProjectionModeV1Schema = z.enum(["first_use", "notes"]);
export type RoomProjectionModeV1 = z.infer<typeof roomProjectionModeV1Schema>;

export const roomActivityV1Schema = z.strictObject({
  activityId: uuidSchema,
  kind: nonEmptyStringSchema,
  occurredAt: isoTimestampSchema,
});

export const roomRecentNoteV1Schema = z.strictObject({
  noteId: uuidSchema,
  noteVersionId: uuidSchema,
  title: nonEmptyStringSchema,
});

const roomRecentActivitySummaryDataSchema = z.strictObject({
  items: z.array(roomActivityV1Schema).max(20),
});

export const roomCaptureCapabilityV1Schema = z.strictObject({
  state: z.enum(["enabled", "disabled", "unavailable"]),
  reason: z.enum(["capability_denied", "feature_unavailable", "native_unavailable", "projection_unavailable"]).optional(),
});

const roomSectionStatesV1Schema = z.strictObject({
  recentActivitySummary: roomSectionStateV1Schema,
});

export const roomProjectionV1Schema = z.strictObject({
  version: z.literal(1),
  workspaceEpoch: z.number().int().nonnegative(),
  snapshotAt: isoTimestampSchema,
  dashboardRevision: nonEmptyStringSchema,
  mode: roomProjectionModeV1Schema,
  recentNote: roomRecentNoteV1Schema.nullable(),
  recentActivitySummary: roomSectionSchema(roomRecentActivitySummaryDataSchema),
  captureCapability: roomCaptureCapabilityV1Schema,
  sectionStates: roomSectionStatesV1Schema,
  degradation: z.strictObject({
    unavailableSections: z.array(nonEmptyStringSchema).max(20),
    retryable: z.boolean(),
  }).nullable(),
}).superRefine((value, context) => {
  if (value.sectionStates.recentActivitySummary.state !== value.recentActivitySummary.state) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sectionStates", "recentActivitySummary"], message: "section state mismatch" });
  }
});
export type RoomProjectionV1 = z.infer<typeof roomProjectionV1Schema>;
