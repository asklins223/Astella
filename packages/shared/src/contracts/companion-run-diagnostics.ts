import { z } from "zod";
import {
  companionAgentPermissionLevelSchema,
  companionAgentRiskClassSchema,
  companionAgentStepKindSchema,
  companionAgentStepStatusSchema,
  companionAgentToolStatusSchema,
} from "./companion-agent-contracts.ts";
import { companionContentBlockV1Schema } from "./companion-conversation-contracts.ts";

const companionRunStatusSchema = z.enum([
  "accepted",
  "running",
  "waiting_for_confirmation",
  "succeeded",
  "cancel_requested",
  "cancelled",
  "failed",
  "superseded",
]);

export const companionRunFailureClassV1Schema = z.enum([
  "transport",
  "output",
  "tool",
  "delivery",
  "tts",
  "execution",
  "state",
]);

export type CompanionRunFailureClassV1 = z.infer<typeof companionRunFailureClassV1Schema>;

export const companionRunListQueryV1Schema = z.object({
  conversationId: z.string().uuid().optional(),
  status: companionRunStatusSchema.optional(),
  beforeCreatedAt: z.string().datetime().optional(),
  beforeId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict().refine(
  (query) => (query.beforeCreatedAt === undefined) === (query.beforeId === undefined),
  { message: "beforeCreatedAt and beforeId must be supplied together" },
);

export type CompanionRunListQueryV1 = z.infer<typeof companionRunListQueryV1Schema>;

export const companionRunListV1Schema = z.object({
  version: z.literal(1),
  items: z.array(z.object({
    id: z.string().uuid(),
    conversationId: z.string().uuid(),
    status: companionRunStatusSchema,
    generation: z.number().int().positive(),
    createdAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    assistantMessagePersisted: z.boolean(),
    failureCategory: z.enum(["none", "stale_context", "internal", "unknown"]),
    providerId: z.string().max(120).nullable(),
    modelId: z.string().max(160).nullable(),
    promptVersion: z.string().max(200).nullable(),
    stepCount: z.number().int().nonnegative(),
    toolCallCount: z.number().int().nonnegative(),
    agentElapsedMs: z.number().int().nonnegative(),
  }).strict()).max(50),
  nextCursor: z.object({
    beforeCreatedAt: z.string().datetime(),
    beforeId: z.string().uuid(),
  }).strict().nullable(),
}).strict();

export type CompanionRunListV1 = z.infer<typeof companionRunListV1Schema>;

export const companionRunJobStatusV1Schema = z.enum(["pending", "running", "succeeded", "failed", "dead"]);

export const companionRunDoctorFindingCodeV1Schema = z.enum([
  "run_failed",
  "success_without_message",
  "active_job_missing",
  "active_job_terminal",
  "running_job_without_lease",
  "tool_outcome_unknown",
  "terminal_run_open_tool",
  "tool_snapshot_missing",
  "active_event_tail_missing",
  "open_failure_span",
]);

export const companionRunDoctorV1Schema = z.object({
  version: z.literal(1),
  run: z.object({
    id: z.string().uuid(),
    conversationId: z.string().uuid(),
    status: companionRunStatusSchema,
    generation: z.number().int().positive(),
    createdAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    assistantMessagePersisted: z.boolean(),
    failureCategory: z.enum(["none", "stale_context", "internal", "unknown"]),
    providerId: z.string().max(120).nullable(),
    modelId: z.string().max(160).nullable(),
    promptVersion: z.string().max(200).nullable(),
    permissionLevel: companionAgentPermissionLevelSchema.nullable(),
  }).strict(),
  executionBudget: z.object({
    maxSteps: z.number().int().positive(),
    stepsUsed: z.number().int().nonnegative(),
    maxToolCallsPerStep: z.number().int().positive(),
    maxToolCalls: z.number().int().positive(),
    toolCallsUsed: z.number().int().nonnegative(),
    deadlineMs: z.number().int().positive(),
    elapsedMs: z.number().int().nonnegative(),
  }).strict(),
  queue: z.object({
    jobId: z.string().uuid().nullable(),
    status: companionRunJobStatusV1Schema.nullable(),
    attempts: z.number().int().nonnegative().nullable(),
    hasLease: z.boolean().nullable(),
    scheduledAt: z.string().datetime().nullable(),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
  }).strict(),
  capabilities: z.object({
    snapshotPresent: z.boolean(),
    permissionLevel: companionAgentPermissionLevelSchema.nullable(),
    offeredTools: z.array(z.object({
      name: z.string().regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/).max(80),
      toolVersion: z.string().min(1).max(40),
      riskClass: companionAgentRiskClassSchema,
    }).strict()).max(64),
  }).strict(),
  ledger: z.object({
    stepCounts: z.array(z.object({ status: companionAgentStepStatusSchema, count: z.number().int().nonnegative() }).strict()),
    toolCounts: z.array(z.object({ status: companionAgentToolStatusSchema, count: z.number().int().nonnegative() }).strict()),
    unknownToolOutcomeCount: z.number().int().nonnegative(),
    pendingToolCount: z.number().int().nonnegative(),
    retainedEventCount: z.number().int().nonnegative(),
    latestRetainedEventSeq: z.number().int().nonnegative().nullable(),
    latestRetainedEventAt: z.string().datetime().nullable(),
  }).strict(),
  failureSpans: z.array(z.object({
    failureClass: companionRunFailureClassV1Schema,
    startedAt: z.string().datetime(),
    lastFailureAt: z.string().datetime(),
    failureCount: z.number().int().min(1).max(1_000_000_000),
    firstRunId: z.string().uuid().nullable(),
    lastRunId: z.string().uuid().nullable(),
    recoveredAt: z.string().datetime().nullable(),
    recoveryRunId: z.string().uuid().nullable(),
  }).strict()).max(7),
  findings: z.array(z.object({
    code: companionRunDoctorFindingCodeV1Schema,
    severity: z.enum(["info", "warning", "error"]),
    message: z.string().min(1).max(240),
  }).strict()).max(32),
  markdown: z.string().max(3_000),
}).strict();

export type CompanionRunDoctorV1 = z.infer<typeof companionRunDoctorV1Schema>;

const replayPromptMessageV1Schema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  text: z.string().max(16_000),
  imageContentOmitted: z.number().int().nonnegative(),
  truncated: z.boolean(),
}).strict();

const replayContextWatermarkV1Schema = z.object({
  throughMessageSeq: z.string().regex(/^\d{1,20}$/),
  throughEventSeq: z.string().regex(/^\d{1,20}$/),
  historyStartSeq: z.string().regex(/^\d{1,20}$/),
  clippedMessageCount: z.number().int().nonnegative(),
}).strict();

export const companionTurnReplayV1Schema = z.object({
  version: z.literal(1),
  run: z.object({
    id: z.string().uuid(),
    conversationId: z.string().uuid(),
    status: companionRunStatusSchema,
    generation: z.number().int().positive(),
    createdAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    providerId: z.string().max(120).nullable(),
    modelId: z.string().max(160).nullable(),
    promptVersion: z.string().max(200).nullable(),
    promptHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    leakGateVersion: z.string().max(120).nullable(),
    stepCount: z.number().int().nonnegative(),
    toolCallCount: z.number().int().nonnegative(),
    agentElapsedMs: z.number().int().nonnegative(),
  }).strict(),
  context: z.object({
    snapshotStatus: z.enum(["available", "not_retained", "over_limit", "invalid_snapshot"]),
    snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    snapshotVersion: z.number().int().positive().nullable(),
    watermark: replayContextWatermarkV1Schema.nullable(),
    currentRequest: z.object({
      messageId: z.string().uuid(),
      messageSeq: z.string().regex(/^\d{1,20}$/),
      contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict().nullable(),
    pageSnapshotSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    summaryCoverage: z.object({
      fromSeq: z.string().regex(/^\d{1,20}$/).nullable(),
      throughSeq: z.string().regex(/^\d{1,20}$/).nullable(),
      sourceSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    }).strict().nullable(),
    memoryRefs: z.array(z.object({
      memoryId: z.string().uuid(),
      kind: z.string().min(1).max(64),
      content: z.string().max(80),
    }).strict()).max(3),
    promptMessages: z.array(replayPromptMessageV1Schema).max(64),
    promptMessagesTruncated: z.boolean(),
    actionLedger: z.object({
      completed: z.array(z.object({ receiptId: z.string().max(200), toolCallId: z.string().max(200), name: z.string().max(80), safeSummary: z.string().max(240).nullable() }).strict()).max(64),
      unresolved: z.array(z.object({ receiptId: z.string().max(200), toolCallId: z.string().max(200), name: z.string().max(80), status: z.string().max(40), safeSummary: z.string().max(240).nullable() }).strict()).max(64),
      notCompleted: z.array(z.object({ receiptId: z.string().max(200), toolCallId: z.string().max(200), name: z.string().max(80), status: z.string().max(40), safeSummary: z.string().max(240).nullable() }).strict()).max(64),
    }).strict(),
  }).strict(),
  messages: z.array(z.object({
    id: z.string().uuid(),
    seq: z.number().int().positive(),
    role: z.enum(["user", "assistant", "system"]),
    kind: z.enum(["text", "voice_transcript", "proactive", "action", "result", "error", "cancelled"]),
    blocks: z.array(companionContentBlockV1Schema).max(32),
    imageBlocksOmitted: z.number().int().nonnegative(),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string().datetime(),
  }).strict()).max(2),
  steps: z.array(z.object({
    stepNo: z.number().int().positive(),
    kind: z.string().min(1).max(60),
    status: companionAgentStepStatusSchema,
    requestHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    resultHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
  }).strict()).max(16),
  toolCalls: z.array(z.object({
    toolCallId: z.string().min(1).max(200),
    name: z.string().min(1).max(80),
    toolVersion: z.string().min(1).max(40),
    riskClass: companionAgentRiskClassSchema,
    status: companionAgentToolStatusSchema,
    proposalId: z.string().uuid().nullable(),
    argumentsSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    safeSummary: z.string().max(240).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }).strict()).max(64),
  timeline: z.object({
    eventTailComplete: z.boolean(),
    events: z.array(z.object({
      seq: z.number().int().positive(),
      type: z.enum([
        "turn.accepted", "assistant.status", "agent.tool", "assistant.delta", "assistant.final",
        "character.cue", "action.proposed", "action.decision", "action.expired", "voice.segment.ready",
        "turn.cancelled", "error",
        "proactive.delivery", "proactive.delivery.updated",
      ]),
      occurredAt: z.string().datetime(),
    }).strict()).max(200),
  }).strict(),
  delivery: z.object({
    assistantMessagePersisted: z.boolean(),
    assistantFinalEventSeen: z.boolean(),
    voiceSegmentsPrepared: z.number().int().nonnegative(),
    playbackReceipt: z.literal("not_recorded"),
  }).strict(),
}).strict();

export type CompanionTurnReplayV1 = z.infer<typeof companionTurnReplayV1Schema>;

const issueBundleEventTypeV1Schema = z.enum([
  "turn.accepted", "assistant.status", "agent.tool", "assistant.delta", "assistant.final",
  "character.cue", "action.proposed", "action.decision", "action.expired", "voice.segment.ready",
  "turn.cancelled", "error", "proactive.delivery", "proactive.delivery.updated",
]);

export const companionRunIssueBundleV1Schema = z.object({
  version: z.literal(1),
  redactionProfile: z.literal("companion_issue_bundle_v1"),
  files: z.array(z.discriminatedUnion("path", [
    z.object({
      path: z.literal("run.json"),
      content: z.object({
        version: z.literal(1),
        run: z.object({
          status: companionRunStatusSchema,
          generation: z.number().int().positive(),
          failureCategory: z.enum(["none", "stale_context", "internal", "unknown"]),
          providerId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/).nullable(),
          modelId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/).nullable(),
          promptVersion: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/).nullable(),
          leakGateVersion: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/).nullable(),
          permissionLevel: companionAgentPermissionLevelSchema.nullable(),
          assistantMessagePersisted: z.boolean(),
        }).strict(),
        usage: z.object({
          maxSteps: z.number().int().positive(),
          stepsUsed: z.number().int().nonnegative(),
          maxToolCallsPerStep: z.number().int().positive(),
          maxToolCalls: z.number().int().positive(),
          toolCallsUsed: z.number().int().nonnegative(),
          deadlineMs: z.number().int().positive(),
          elapsedMs: z.number().int().nonnegative(),
        }).strict(),
      }).strict(),
    }).strict(),
    z.object({
      path: z.literal("execution.json"),
      content: z.object({
        version: z.literal(1),
        steps: z.array(z.object({
          ordinal: z.number().int().positive(),
          kind: companionAgentStepKindSchema,
          status: companionAgentStepStatusSchema,
        }).strict()).max(16),
        tools: z.array(z.object({
          name: z.string().regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/).max(80),
          toolVersion: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,39}$/),
          riskClass: companionAgentRiskClassSchema,
          status: companionAgentToolStatusSchema,
        }).strict()).max(64),
      }).strict(),
    }).strict(),
    z.object({
      path: z.literal("timeline.json"),
      content: z.object({
        version: z.literal(1),
        eventTailComplete: z.boolean(),
        eventTypes: z.array(issueBundleEventTypeV1Schema).max(200),
      }).strict(),
    }).strict(),
    z.object({
      path: z.literal("delivery.json"),
      content: z.object({
        version: z.literal(1),
        assistantMessagePersisted: z.boolean(),
        assistantFinalEventSeen: z.boolean(),
        voiceSegmentsPrepared: z.number().int().nonnegative(),
        playbackReceipt: z.literal("not_recorded"),
      }).strict(),
    }).strict(),
  ])).length(4),
}).strict().superRefine((bundle, context) => {
  const paths = bundle.files.map((file) => file.path).sort();
  const expected = ["delivery.json", "execution.json", "run.json", "timeline.json"];
  if (paths.some((path, index) => path !== expected[index])) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["files"], message: "bundle must include each allowlisted file once" });
  }
});

export type CompanionRunIssueBundleV1 = z.infer<typeof companionRunIssueBundleV1Schema>;

const handoffReplayContentPartV1Schema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
  z.object({
    type: z.literal("image_url"),
    image_url: z.object({ url: z.string() }).passthrough(),
  }).passthrough(),
]);

/** Worker snapshot input accepted by the private replay projector; never an HTTP response type. */
export const companionHandoffReplaySourceV1Schema = z.object({
  version: z.literal(1),
  runId: z.string().uuid(),
  conversationId: z.string().uuid(),
  watermark: replayContextWatermarkV1Schema,
  currentRequest: z.object({
    messageId: z.string().uuid(),
    messageSeq: z.string().regex(/^\d{1,20}$/),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  pageSnapshotSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  summaryCoverage: z.object({
    fromSeq: z.string().regex(/^\d{1,20}$/).nullable(),
    throughSeq: z.string().regex(/^\d{1,20}$/).nullable(),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  }).strict().nullable(),
  memoryRefs: z.array(z.object({
    memoryId: z.string().uuid(),
    kind: z.string().min(1).max(64),
    content: z.string().max(80),
  }).strict()).max(3),
  actionLedger: z.object({
    completed: z.array(z.object({ receiptId: z.string(), toolCallId: z.string(), name: z.string(), safeSummary: z.string().nullable() }).passthrough()).max(64),
    unresolved: z.array(z.object({ receiptId: z.string(), toolCallId: z.string(), name: z.string(), status: z.string(), safeSummary: z.string().nullable() }).passthrough()).max(64),
    notCompleted: z.array(z.object({ receiptId: z.string(), toolCallId: z.string(), name: z.string(), status: z.string(), safeSummary: z.string().nullable() }).passthrough()).max(64),
  }).strict(),
  modelMessages: z.array(z.object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.union([z.string(), z.array(handoffReplayContentPartV1Schema)]),
  }).passthrough()).max(128),
}).passthrough();

export type CompanionHandoffReplaySourceV1 = z.infer<typeof companionHandoffReplaySourceV1Schema>;
