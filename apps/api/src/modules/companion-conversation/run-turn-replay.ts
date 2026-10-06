import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  companionContentBlockV1Schema,
  companionHandoffReplaySourceV1Schema,
  companionTurnReplayV1Schema,
  type CompanionContentBlockV1,
  type CompanionTurnReplayV1,
} from "@astella/shared";
import { canonicalJsonV1, sha256Utf8V1 } from "@astella/shared/content-hash";
import {
  companionAgentSteps,
  companionAgentToolCalls,
  companionMessages,
  companionStreamEvents,
  companionTurnRuns,
} from "@astella/shared/db-schema";
import type { ApiTransaction } from "../../db/client.ts";
import type { CompanionRunDoctorScope } from "./run-doctor.ts";

const MAX_HANDOFF_BYTES = 524_288;
const MAX_PROMPT_MESSAGES = 64;
const MAX_PROMPT_MESSAGE_CHARS = 16_000;
const MAX_PROMPT_TOTAL_CHARS = 48_000;
const KNOWN_EVENT_TYPES = new Set<CompanionTurnReplayV1["timeline"]["events"][number]["type"]>([
  "turn.accepted", "assistant.status", "agent.tool", "assistant.delta", "assistant.final",
  "character.cue", "action.proposed", "action.decision", "action.expired", "voice.segment.ready",
  "turn.cancelled", "error", "proactive.delivery", "proactive.delivery.updated",
]);

type ReplayRunRow = {
  id: string;
  workspaceId: string;
  userId: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string | null;
  status: CompanionTurnReplayV1["run"]["status"];
  generation: number;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  providerId: string | null;
  modelId: string | null;
  promptVersion: string | null;
  promptHash: string | null;
  leakGateVersion: string | null;
  stepCount: number;
  toolCallCount: number;
  agentElapsedMs: number;
  lastEventSeq: number;
};

export interface CompanionTurnReplayProjectionInput {
  run: ReplayRunRow;
  handoff: {
    snapshot: unknown | null;
    snapshotSha256: string;
    snapshotVersion: number;
    snapshotBytes: number;
  } | null;
  messages: Array<{
    id: string;
    seq: number;
    role: "user" | "assistant" | "system";
    kind: CompanionTurnReplayV1["messages"][number]["kind"];
    blocks: unknown;
    contentSha256: string;
    createdAt: Date;
  }>;
  steps: Array<{
    stepNo: number;
    kind: string;
    status: CompanionTurnReplayV1["steps"][number]["status"];
    requestHash: string | null;
    resultHash: string | null;
    startedAt: Date;
    finishedAt: Date | null;
  }>;
  toolCalls: Array<{
    toolCallId: string;
    name: string;
    toolVersion: string;
    riskClass: CompanionTurnReplayV1["toolCalls"][number]["riskClass"];
    status: CompanionTurnReplayV1["toolCalls"][number]["status"];
    proposalId: string | null;
    argumentsSha256: string | null;
    resultSafeSummary: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>;
  /** Newest first, as returned by the bounded database query. */
  events: Array<{
    seq: number;
    type: string;
    createdAt: Date;
  }>;
}

function iso(value: Date | null | undefined): string | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

function clipped(value: string | null | undefined, max: number): string | null {
  return value == null ? null : value.slice(0, max);
}

function hashOrNull(value: string | null | undefined): string | null {
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

function safeInt(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function storedUserText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks.map((block) => (
    block && typeof block === "object" && (block as { type?: unknown }).type === "text"
      ? String((block as { text?: unknown }).text ?? "")
      : ""
  )).join("");
}

function resolveHandoff(input: CompanionTurnReplayProjectionInput) {
  const handoff = input.handoff;
  if (!handoff) return { status: "not_retained" as const, source: null, sha256: null, version: null };
  if (handoff.snapshotBytes > MAX_HANDOFF_BYTES || handoff.snapshot === null) {
    return { status: "over_limit" as const, source: null, sha256: hashOrNull(handoff.snapshotSha256), version: handoff.snapshotVersion };
  }
  try {
    const parsed = companionHandoffReplaySourceV1Schema.safeParse(handoff.snapshot);
    if (!parsed.success || parsed.data.runId !== input.run.id || parsed.data.conversationId !== input.run.conversationId) {
      return { status: "invalid_snapshot" as const, source: null, sha256: null, version: null };
    }
    const userMessage = input.messages.find((message) => message.id === input.run.userMessageId);
    if (
      parsed.data.currentRequest.messageId !== input.run.userMessageId
      || !userMessage
      || parsed.data.currentRequest.messageSeq !== String(userMessage.seq)
      || parsed.data.currentRequest.contentSha256 !== sha256Utf8V1(storedUserText(userMessage.blocks))
    ) {
      return { status: "invalid_snapshot" as const, source: null, sha256: null, version: null };
    }
    if (
      !/^[a-f0-9]{64}$/.test(handoff.snapshotSha256)
      || sha256Utf8V1(canonicalJsonV1(handoff.snapshot)) !== handoff.snapshotSha256
      || handoff.snapshotVersion !== parsed.data.version
    ) {
      return { status: "invalid_snapshot" as const, source: null, sha256: null, version: null };
    }
    return {
      status: "available" as const,
      source: parsed.data,
      sha256: handoff.snapshotSha256,
      version: parsed.data.version,
    };
  } catch {
    return { status: "invalid_snapshot" as const, source: null, sha256: null, version: null };
  }
}

function promptMessages(source: ReturnType<typeof resolveHandoff>["source"]) {
  if (!source) return { messages: [] as CompanionTurnReplayV1["context"]["promptMessages"], truncated: false };
  const messages: CompanionTurnReplayV1["context"]["promptMessages"] = [];
  let remainingChars = MAX_PROMPT_TOTAL_CHARS;
  let truncated = source.modelMessages.length > MAX_PROMPT_MESSAGES;
  for (const message of source.modelMessages.slice(0, MAX_PROMPT_MESSAGES)) {
    let imageContentOmitted = 0;
    const text = typeof message.content === "string"
      ? message.content
      : message.content.map((part) => {
        if (part.type === "image_url") {
          imageContentOmitted += 1;
          return "";
        }
        return part.text;
      }).join("");
    const charLimit = Math.min(MAX_PROMPT_MESSAGE_CHARS, remainingChars);
    const safeText = text.slice(0, charLimit);
    const messageTruncated = safeText.length < text.length;
    messages.push({
      role: message.role,
      text: safeText,
      imageContentOmitted,
      truncated: messageTruncated,
    });
    remainingChars -= safeText.length;
    truncated ||= messageTruncated;
    if (remainingChars === 0 && messages.length < source.modelMessages.length) truncated = true;
  }
  return { messages, truncated };
}

function safeMessageBlocks(blocks: unknown): { blocks: CompanionContentBlockV1[]; imageBlocksOmitted: number } {
  if (!Array.isArray(blocks)) return { blocks: [], imageBlocksOmitted: 0 };
  const safeBlocks: CompanionContentBlockV1[] = [];
  let imageBlocksOmitted = 0;
  for (const block of blocks) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "image") {
      imageBlocksOmitted += 1;
      continue;
    }
    const parsed = companionContentBlockV1Schema.safeParse(block);
    if (parsed.success && safeBlocks.length < 32) safeBlocks.push(parsed.data);
  }
  return { blocks: safeBlocks, imageBlocksOmitted };
}

function projectLedger(source: NonNullable<ReturnType<typeof resolveHandoff>["source"]>) {
  const entries = <T extends { receiptId: string; toolCallId: string; name: string; safeSummary: string | null }>(items: readonly T[]) =>
    items.slice(0, 64).map((item) => ({
      receiptId: item.receiptId.slice(0, 200),
      toolCallId: item.toolCallId.slice(0, 200),
      name: item.name.slice(0, 80),
      safeSummary: clipped(item.safeSummary, 240),
    }));
  return {
    completed: entries(source.actionLedger.completed),
    unresolved: source.actionLedger.unresolved.slice(0, 64).map((item) => ({
      receiptId: item.receiptId.slice(0, 200),
      toolCallId: item.toolCallId.slice(0, 200),
      name: item.name.slice(0, 80),
      status: item.status.slice(0, 40),
      safeSummary: clipped(item.safeSummary, 240),
    })),
    notCompleted: source.actionLedger.notCompleted.slice(0, 64).map((item) => ({
      receiptId: item.receiptId.slice(0, 200),
      toolCallId: item.toolCallId.slice(0, 200),
      name: item.name.slice(0, 80),
      status: item.status.slice(0, 40),
      safeSummary: clipped(item.safeSummary, 240),
    })),
  };
}

export function projectCompanionTurnReplayV1(input: CompanionTurnReplayProjectionInput): CompanionTurnReplayV1 {
  const handoff = resolveHandoff(input);
  const prompt = promptMessages(handoff.source);
  const safeMessages = input.messages
    .filter((message) => message.id === input.run.userMessageId || message.id === input.run.assistantMessageId)
    .sort((a, b) => a.seq - b.seq)
    .slice(0, 2)
    .map((message) => ({
      id: message.id,
      seq: message.seq,
      role: message.role,
      kind: message.kind,
      ...safeMessageBlocks(message.blocks),
      contentSha256: message.contentSha256,
      createdAt: iso(message.createdAt) ?? new Date(0).toISOString(),
    }));
  const steps = input.steps.slice(0, 16).map((step) => ({
    stepNo: step.stepNo,
    kind: step.kind.slice(0, 60),
    status: step.status,
    requestHash: hashOrNull(step.requestHash),
    resultHash: hashOrNull(step.resultHash),
    startedAt: iso(step.startedAt) ?? new Date(0).toISOString(),
    finishedAt: iso(step.finishedAt),
  }));
  const toolCalls = input.toolCalls.slice(0, 64).map((tool) => ({
    toolCallId: tool.toolCallId.slice(0, 200),
    name: tool.name.slice(0, 80),
    toolVersion: tool.toolVersion.slice(0, 40),
    riskClass: tool.riskClass,
    status: tool.status,
    proposalId: tool.proposalId,
    argumentsSha256: hashOrNull(tool.argumentsSha256),
    safeSummary: clipped(tool.resultSafeSummary, 240),
    createdAt: iso(tool.createdAt) ?? new Date(0).toISOString(),
    updatedAt: iso(tool.updatedAt) ?? new Date(0).toISOString(),
  }));
  const retainedEvents = input.events.slice(0, 201);
  const knownEvents = retainedEvents.filter((event) => KNOWN_EVENT_TYPES.has(event.type as never));
  const eventTailComplete = retainedEvents.length <= 200
    && knownEvents.length === retainedEvents.length
    && (input.run.lastEventSeq === 0 || retainedEvents[0]?.seq === input.run.lastEventSeq);
  const timelineEvents = knownEvents.slice(0, 200).reverse().map((event) => ({
    seq: event.seq,
    type: event.type as CompanionTurnReplayV1["timeline"]["events"][number]["type"],
    occurredAt: iso(event.createdAt) ?? new Date(0).toISOString(),
  }));
  const assistantFinalEventSeen = knownEvents.some((event) => event.type === "assistant.final");
  const voiceSegmentsPrepared = knownEvents.filter((event) => event.type === "voice.segment.ready").length;
  const source = handoff.source;
  return companionTurnReplayV1Schema.parse({
    version: 1,
    run: {
      id: input.run.id,
      conversationId: input.run.conversationId,
      status: input.run.status,
      generation: input.run.generation,
      createdAt: iso(input.run.createdAt) ?? new Date(0).toISOString(),
      startedAt: iso(input.run.startedAt),
      finishedAt: iso(input.run.finishedAt),
      providerId: clipped(input.run.providerId, 120),
      modelId: clipped(input.run.modelId, 160),
      promptVersion: clipped(input.run.promptVersion, 200),
      promptHash: hashOrNull(input.run.promptHash),
      leakGateVersion: clipped(input.run.leakGateVersion, 120),
      stepCount: safeInt(input.run.stepCount),
      toolCallCount: safeInt(input.run.toolCallCount),
      agentElapsedMs: safeInt(input.run.agentElapsedMs),
    },
    context: {
      snapshotStatus: handoff.status,
      snapshotSha256: handoff.sha256,
      snapshotVersion: handoff.version,
      watermark: source?.watermark ?? null,
      currentRequest: source?.currentRequest ?? null,
      pageSnapshotSha256: source?.pageSnapshotSha256 ?? null,
      summaryCoverage: source?.summaryCoverage ?? null,
      memoryRefs: source?.memoryRefs ?? [],
      promptMessages: prompt.messages,
      promptMessagesTruncated: prompt.truncated,
      actionLedger: source ? projectLedger(source) : { completed: [], unresolved: [], notCompleted: [] },
    },
    messages: safeMessages,
    steps,
    toolCalls,
    timeline: { eventTailComplete, events: timelineEvents },
    delivery: {
      assistantMessagePersisted: input.run.assistantMessageId !== null,
      assistantFinalEventSeen,
      voiceSegmentsPrepared,
      playbackReceipt: "not_recorded",
    },
  });
}

/** Owner-scoped replay projection. Exact model input is read only through the private SQL function. */
export async function loadCompanionTurnReplayV1(
  tx: ApiTransaction,
  scope: CompanionRunDoctorScope,
  runId: string,
  now = new Date(),
): Promise<CompanionTurnReplayV1 | null> {
  const runRows = await tx.select({
    id: companionTurnRuns.id,
    workspaceId: companionTurnRuns.workspaceId,
    userId: companionTurnRuns.userId,
    conversationId: companionTurnRuns.conversationId,
    userMessageId: companionTurnRuns.userMessageId,
    assistantMessageId: companionTurnRuns.assistantMessageId,
    status: companionTurnRuns.status,
    generation: companionTurnRuns.generation,
    createdAt: companionTurnRuns.createdAt,
    startedAt: companionTurnRuns.startedAt,
    finishedAt: companionTurnRuns.finishedAt,
    providerId: companionTurnRuns.providerId,
    modelId: companionTurnRuns.modelId,
    promptVersion: companionTurnRuns.promptVersion,
    promptHash: companionTurnRuns.promptHash,
    leakGateVersion: companionTurnRuns.leakGateVersion,
    stepCount: companionTurnRuns.stepCount,
    toolCallCount: companionTurnRuns.toolCallCount,
    agentElapsedMs: companionTurnRuns.agentElapsedMs,
    lastEventSeq: companionTurnRuns.lastEventSeq,
  }).from(companionTurnRuns).where(and(
    eq(companionTurnRuns.id, runId),
    eq(companionTurnRuns.workspaceId, scope.workspaceId),
    eq(companionTurnRuns.userId, scope.userId),
  )).limit(1);
  const run = runRows[0] as ReplayRunRow | undefined;
  if (!run) return null;

  const handoffRows = await tx.execute(sql`
    SELECT snapshot, snapshot_sha256, snapshot_version, snapshot_bytes
    FROM public.astella_read_companion_turn_handoff_snapshot_v1(${runId}::uuid)
    LIMIT 1
  `) as unknown as Array<Record<string, unknown>>;
  const handoffRow = handoffRows[0];
  const handoff = handoffRow ? {
    snapshot: (handoffRow.snapshot ?? null) as unknown | null,
    snapshotSha256: String(handoffRow.snapshot_sha256 ?? ""),
    snapshotVersion: safeInt(handoffRow.snapshot_version),
    snapshotBytes: safeInt(handoffRow.snapshot_bytes),
  } : null;
  const messageIds = [run.userMessageId, run.assistantMessageId].filter((id): id is string => id !== null);
  const [messages, steps, toolCalls, events] = await Promise.all([
    tx.select({
      id: companionMessages.id,
      seq: companionMessages.seq,
      role: companionMessages.role,
      kind: companionMessages.kind,
      blocks: companionMessages.blocks,
      contentSha256: companionMessages.contentSha256,
      createdAt: companionMessages.createdAt,
    }).from(companionMessages).where(and(
      eq(companionMessages.workspaceId, scope.workspaceId),
      eq(companionMessages.userId, scope.userId),
      eq(companionMessages.conversationId, run.conversationId),
      inArray(companionMessages.id, messageIds),
    )).orderBy(asc(companionMessages.seq)),
    tx.select({
      stepNo: companionAgentSteps.stepNo,
      kind: companionAgentSteps.kind,
      status: companionAgentSteps.status,
      requestHash: companionAgentSteps.requestHash,
      resultHash: companionAgentSteps.resultHash,
      startedAt: companionAgentSteps.startedAt,
      finishedAt: companionAgentSteps.finishedAt,
    }).from(companionAgentSteps).where(and(
      eq(companionAgentSteps.runId, runId),
      eq(companionAgentSteps.workspaceId, scope.workspaceId),
      eq(companionAgentSteps.userId, scope.userId),
    )).orderBy(asc(companionAgentSteps.stepNo)).limit(16),
    tx.select({
      toolCallId: companionAgentToolCalls.toolCallId,
      name: companionAgentToolCalls.name,
      toolVersion: companionAgentToolCalls.toolVersion,
      riskClass: companionAgentToolCalls.riskClass,
      status: companionAgentToolCalls.status,
      proposalId: companionAgentToolCalls.proposalId,
      argumentsSha256: companionAgentToolCalls.argumentsSha256,
      resultSafeSummary: companionAgentToolCalls.resultSafeSummary,
      createdAt: companionAgentToolCalls.createdAt,
      updatedAt: companionAgentToolCalls.updatedAt,
    }).from(companionAgentToolCalls).where(and(
      eq(companionAgentToolCalls.runId, runId),
      eq(companionAgentToolCalls.workspaceId, scope.workspaceId),
      eq(companionAgentToolCalls.userId, scope.userId),
    )).orderBy(asc(companionAgentToolCalls.createdAt)).limit(64),
    tx.select({
      seq: companionStreamEvents.seq,
      type: companionStreamEvents.type,
      createdAt: companionStreamEvents.createdAt,
    }).from(companionStreamEvents).where(and(
      eq(companionStreamEvents.runId, runId),
      eq(companionStreamEvents.workspaceId, scope.workspaceId),
      eq(companionStreamEvents.userId, scope.userId),
      gt(companionStreamEvents.expiresAt, now),
    )).orderBy(desc(companionStreamEvents.seq)).limit(201),
  ]);

  return projectCompanionTurnReplayV1({ run, handoff, messages, steps, toolCalls, events });
}
