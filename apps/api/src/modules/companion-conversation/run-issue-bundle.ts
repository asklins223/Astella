import { and, asc, desc, eq, gt } from "drizzle-orm";
import {
  COMPANION_AGENT_DEADLINE_MS,
  COMPANION_AGENT_MAX_STEPS,
  COMPANION_AGENT_MAX_TOOL_CALLS,
  COMPANION_AGENT_MAX_TOOL_CALLS_PER_STEP,
  companionAgentBudgetSnapshotV1Schema,
  companionRunIssueBundleV1Schema,
  type CompanionRunListV1,
  type CompanionRunIssueBundleV1,
} from "@astella/shared";
import {
  companionAgentSteps,
  companionAgentToolCalls,
  companionStreamEvents,
  companionTurnRuns,
} from "@astella/shared/db-schema";
import type { ApiTransaction } from "../../db/client.ts";
import type { CompanionRunDoctorScope } from "./run-doctor.ts";

const KNOWN_EVENT_TYPES = new Set<string>([
  "turn.accepted", "assistant.status", "agent.tool", "assistant.delta", "assistant.final",
  "character.cue", "action.proposed", "action.decision", "action.expired", "voice.segment.ready",
  "turn.cancelled", "error", "proactive.delivery", "proactive.delivery.updated",
]);

type BundleFile = CompanionRunIssueBundleV1["files"][number];
type BundleRunFile = Extract<BundleFile, { path: "run.json" }>;
type BundleExecutionFile = Extract<BundleFile, { path: "execution.json" }>;

export interface CompanionRunIssueBundleProjectionInput {
  run: {
    status: CompanionRunListV1["items"][number]["status"];
    generation: number;
    assistantMessagePersisted: boolean;
    errorCode: string | null;
    providerId: string | null;
    modelId: string | null;
    promptVersion: string | null;
    leakGateVersion: string | null;
    permissionLevel: BundleRunFile["content"]["run"]["permissionLevel"];
    budgetSnapshot: unknown;
    stepCount: number;
    toolCallCount: number;
    agentElapsedMs: number;
    lastEventSeq: number;
  };
  steps: BundleExecutionFile["content"]["steps"];
  toolCalls: BundleExecutionFile["content"]["tools"];
  /** Newest first, as returned by the bounded database query. */
  events: Array<{ seq: number; type: string }>;
}

function safeTechnicalId(value: string | null, pattern: RegExp): string | null {
  return value && pattern.test(value) ? value : null;
}

function failureCategory(
  status: string,
  errorCode: string | null,
): BundleRunFile["content"]["run"]["failureCategory"] {
  if (status !== "failed") return "none";
  if (errorCode === "ACTION_STALE") return "stale_context";
  if (errorCode === "INTERNAL_ERROR") return "internal";
  return "unknown";
}

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function projectCompanionRunIssueBundleV1(
  input: CompanionRunIssueBundleProjectionInput,
): CompanionRunIssueBundleV1 {
  const { run } = input;
  const budgetResult = companionAgentBudgetSnapshotV1Schema.safeParse(run.budgetSnapshot);
  const budget = budgetResult.success ? budgetResult.data : {
    maxSteps: COMPANION_AGENT_MAX_STEPS,
    maxToolCallsPerStep: COMPANION_AGENT_MAX_TOOL_CALLS_PER_STEP,
    maxToolCalls: COMPANION_AGENT_MAX_TOOL_CALLS,
    deadlineMs: COMPANION_AGENT_DEADLINE_MS,
  };
  const retainedEvents = input.events.slice(0, 201);
  const eventTypes = retainedEvents
    .map((event) => event.type)
    .filter((type) => KNOWN_EVENT_TYPES.has(type))
    .slice(0, 200);
  const eventTailComplete = retainedEvents.length <= 200
    && eventTypes.length === retainedEvents.length
    && (run.lastEventSeq === 0 || retainedEvents[0]?.seq === run.lastEventSeq);
  const assistantFinalEventSeen = eventTypes.includes("assistant.final");
  const voiceSegmentsPrepared = eventTypes.filter((type) => type === "voice.segment.ready").length;
  const safeTools = input.toolCalls.flatMap((tool) => {
    const name = safeTechnicalId(tool.name, /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/);
    if (!name) return [];
    return [{
      name,
      toolVersion: safeTechnicalId(tool.toolVersion, /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,39}$/) ?? "unknown",
      riskClass: tool.riskClass,
      status: tool.status,
    }];
  });
  const output = {
    version: 1 as const,
    redactionProfile: "companion_issue_bundle_v1" as const,
    files: [
      {
        path: "run.json" as const,
        content: {
          version: 1 as const,
          run: {
            status: run.status,
            generation: run.generation,
            failureCategory: failureCategory(run.status, run.errorCode),
            providerId: safeTechnicalId(run.providerId, /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/),
            modelId: safeTechnicalId(run.modelId, /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/),
            promptVersion: safeTechnicalId(run.promptVersion, /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/),
            leakGateVersion: safeTechnicalId(run.leakGateVersion, /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/),
            permissionLevel: run.permissionLevel,
            assistantMessagePersisted: run.assistantMessagePersisted,
          },
          usage: {
            maxSteps: budget.maxSteps,
            stepsUsed: safeCount(run.stepCount),
            maxToolCallsPerStep: budget.maxToolCallsPerStep,
            maxToolCalls: budget.maxToolCalls,
            toolCallsUsed: safeCount(run.toolCallCount),
            deadlineMs: budget.deadlineMs,
            elapsedMs: safeCount(run.agentElapsedMs),
          },
        },
      },
      {
        path: "execution.json" as const,
        content: { version: 1 as const, steps: input.steps.slice(0, 16), tools: safeTools.slice(0, 64) },
      },
      {
        path: "timeline.json" as const,
        content: { version: 1 as const, eventTailComplete, eventTypes },
      },
      {
        path: "delivery.json" as const,
        content: {
          version: 1 as const,
          assistantMessagePersisted: run.assistantMessagePersisted,
          assistantFinalEventSeen,
          voiceSegmentsPrepared,
          playbackReceipt: "not_recorded" as const,
        },
      },
    ],
  };
  return companionRunIssueBundleV1Schema.parse(output);
}

/**
 * Creates the exact allowlisted JSON bundle files. This path never selects
 * messages, prompt snapshots, raw tool arguments/results, or recovery handles.
 */
export async function loadCompanionRunIssueBundleV1(
  tx: ApiTransaction,
  scope: CompanionRunDoctorScope,
  runId: string,
  now = new Date(),
): Promise<CompanionRunIssueBundleV1 | null> {
  const runRows = await tx.select({
    id: companionTurnRuns.id,
    workspaceId: companionTurnRuns.workspaceId,
    userId: companionTurnRuns.userId,
    status: companionTurnRuns.status,
    generation: companionTurnRuns.generation,
    assistantMessageId: companionTurnRuns.assistantMessageId,
    errorCode: companionTurnRuns.errorCode,
    providerId: companionTurnRuns.providerId,
    modelId: companionTurnRuns.modelId,
    promptVersion: companionTurnRuns.promptVersion,
    leakGateVersion: companionTurnRuns.leakGateVersion,
    permissionLevel: companionTurnRuns.permissionLevel,
    budgetSnapshot: companionTurnRuns.budgetSnapshot,
    stepCount: companionTurnRuns.stepCount,
    toolCallCount: companionTurnRuns.toolCallCount,
    agentElapsedMs: companionTurnRuns.agentElapsedMs,
    lastEventSeq: companionTurnRuns.lastEventSeq,
  }).from(companionTurnRuns).where(and(
    eq(companionTurnRuns.id, runId),
    eq(companionTurnRuns.workspaceId, scope.workspaceId),
    eq(companionTurnRuns.userId, scope.userId),
  )).limit(1);
  const run = runRows[0];
  if (!run) return null;

  const [steps, toolCalls, events] = await Promise.all([
    tx.select({
      stepNo: companionAgentSteps.stepNo,
      kind: companionAgentSteps.kind,
      status: companionAgentSteps.status,
    }).from(companionAgentSteps).where(and(
      eq(companionAgentSteps.runId, runId),
      eq(companionAgentSteps.workspaceId, scope.workspaceId),
      eq(companionAgentSteps.userId, scope.userId),
    )).orderBy(asc(companionAgentSteps.stepNo)).limit(16),
    tx.select({
      name: companionAgentToolCalls.name,
      toolVersion: companionAgentToolCalls.toolVersion,
      riskClass: companionAgentToolCalls.riskClass,
      status: companionAgentToolCalls.status,
    }).from(companionAgentToolCalls).where(and(
      eq(companionAgentToolCalls.runId, runId),
      eq(companionAgentToolCalls.workspaceId, scope.workspaceId),
      eq(companionAgentToolCalls.userId, scope.userId),
    )).orderBy(asc(companionAgentToolCalls.createdAt)).limit(64),
    tx.select({
      seq: companionStreamEvents.seq,
      type: companionStreamEvents.type,
    }).from(companionStreamEvents).where(and(
      eq(companionStreamEvents.runId, runId),
      eq(companionStreamEvents.workspaceId, scope.workspaceId),
      eq(companionStreamEvents.userId, scope.userId),
      gt(companionStreamEvents.expiresAt, now),
    )).orderBy(desc(companionStreamEvents.seq)).limit(201),
  ]);

  return projectCompanionRunIssueBundleV1({
    run: {
      status: run.status,
      generation: run.generation,
      assistantMessagePersisted: run.assistantMessageId !== null,
      errorCode: run.errorCode,
      providerId: run.providerId,
      modelId: run.modelId,
      promptVersion: run.promptVersion,
      leakGateVersion: run.leakGateVersion,
      permissionLevel: run.permissionLevel,
      budgetSnapshot: run.budgetSnapshot,
      stepCount: run.stepCount,
      toolCallCount: run.toolCallCount,
      agentElapsedMs: run.agentElapsedMs,
      lastEventSeq: run.lastEventSeq,
    },
    steps: steps.map((step) => ({ ordinal: step.stepNo, kind: step.kind, status: step.status })),
    toolCalls,
    events,
  });
}
