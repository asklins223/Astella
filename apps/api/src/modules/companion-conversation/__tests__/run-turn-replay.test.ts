import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJsonV1, sha256Utf8V1 } from "@astella/shared/content-hash";
import {
  projectCompanionTurnReplayV1,
  type CompanionTurnReplayProjectionInput,
} from "../run-turn-replay.ts";

const runId = "00000000-0000-4000-8000-000000000001";
const conversationId = "00000000-0000-4000-8000-000000000002";
const userMessageId = "00000000-0000-4000-8000-000000000003";
const assistantMessageId = "00000000-0000-4000-8000-000000000004";
const now = new Date("2026-10-01T00:00:00.000Z");

function replayInput(): CompanionTurnReplayProjectionInput {
  const snapshot = {
    version: 1,
    runId,
    conversationId,
    watermark: {
      throughMessageSeq: "8",
      throughEventSeq: "21",
      historyStartSeq: "2",
      clippedMessageCount: 1,
    },
    currentRequest: {
      messageId: userMessageId,
      messageSeq: "8",
      contentSha256: sha256Utf8V1("Explain this picture."),
    },
    authorization: { contextGrantId: null, permissionLevel: "guided", permissionSnapshot: { private: true } },
    runState: { status: "running", cancelRequestedAt: null },
    pageSnapshotSha256: "b".repeat(64),
    summaryCoverage: { fromSeq: "1", throughSeq: "5", sourceSha256: "c".repeat(64) },
    historyTail: [{ seq: "7", role: "user", text: "private history", contentSha256: "d".repeat(64) }],
    actionLedger: {
      completed: [{ receiptId: "receipt-1", toolCallId: "tool-call-1", name: "companion_search_notes", safeSummary: "Found one note." }],
      unresolved: [],
      notCompleted: [],
    },
    proposals: [{ id: "private-proposal", status: "pending", reasoningHandle: "provider-secret" }],
    memoryRefs: [{ memoryId: "00000000-0000-4000-8000-000000000005", kind: "preference", content: "prefers concise explanations" }],
    modelMessages: [
      { role: "system" as const, content: "Use the safe persona." },
      { role: "user" as const, content: [
        { type: "text" as const, text: "Explain this picture." },
        { type: "image_url" as const, image_url: { url: "data:image/png;base64,very-private-image-bytes" } },
      ] },
    ],
  };
  return {
    run: {
      id: runId,
      workspaceId: "00000000-0000-4000-8000-000000000006",
      userId: "00000000-0000-4000-8000-000000000007",
      conversationId,
      userMessageId,
      assistantMessageId,
      status: "succeeded",
      generation: 2,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      providerId: "provider-a",
      modelId: "model-a",
      promptVersion: "companion-v1",
      promptHash: "e".repeat(64),
      leakGateVersion: "gate-v1",
      stepCount: 1,
      toolCallCount: 1,
      agentElapsedMs: 1234,
      lastEventSeq: 21,
    },
    handoff: {
      snapshot,
      snapshotSha256: sha256Utf8V1(canonicalJsonV1(snapshot)),
      snapshotVersion: 1,
      snapshotBytes: 2048,
    },
    messages: [
      {
        id: userMessageId,
        seq: 8,
        role: "user",
        kind: "text",
        blocks: [
          { type: "text", text: "Explain this picture." },
          { type: "image", url: "/api/uploads/private-image", label: "private image", alt: "private image" },
        ],
        contentSha256: "f".repeat(64),
        createdAt: now,
      },
      {
        id: assistantMessageId,
        seq: 9,
        role: "assistant",
        kind: "result",
        blocks: [{ type: "text", text: "It shows a garden." }],
        contentSha256: "1".repeat(64),
        createdAt: now,
      },
    ],
    steps: [{
      stepNo: 1,
      kind: "model",
      status: "succeeded",
      requestHash: "2".repeat(64),
      resultHash: "3".repeat(64),
      startedAt: now,
      finishedAt: now,
    }],
    toolCalls: [{
      toolCallId: "tool-call-1",
      name: "companion_search_notes",
      toolVersion: "1",
      riskClass: "read",
      status: "succeeded",
      proposalId: null,
      argumentsSha256: "4".repeat(64),
      resultSafeSummary: "Found one note.",
      createdAt: now,
      updatedAt: now,
    }],
    events: [
      { seq: 21, type: "assistant.final", createdAt: now },
      { seq: 20, type: "voice.segment.ready", createdAt: now },
    ],
  };
}

test("private turn replay verifies its exact input and omits image bytes and private execution payloads", () => {
  const report = projectCompanionTurnReplayV1(replayInput());
  assert.equal(report.context.snapshotStatus, "available");
  assert.equal(report.context.promptMessages[1]?.text, "Explain this picture.");
  assert.equal(report.context.promptMessages[1]?.imageContentOmitted, 1);
  assert.equal(report.messages[0]?.imageBlocksOmitted, 1);
  assert.equal(report.delivery.assistantMessagePersisted, true);
  assert.equal(report.delivery.assistantFinalEventSeen, true);
  assert.equal(report.delivery.voiceSegmentsPrepared, 1);
  const json = JSON.stringify(report);
  for (const privateValue of [
    "very-private-image-bytes",
    "provider-secret",
    "private history",
    "permissionSnapshot",
    "reasoningHandles",
    "arguments\":",
    "resultRef",
  ]) assert.equal(json.includes(privateValue), false, privateValue);
  assert.equal("arguments" in report.toolCalls[0]!, false);
  assert.equal("reasoningHandles" in report.toolCalls[0]!, false);
});

test("private turn replay withholds invalid or oversized handoff input and flags incomplete event tails", () => {
  const input = replayInput();
  const invalid = projectCompanionTurnReplayV1({
    ...input,
    handoff: { ...input.handoff!, snapshotSha256: "0".repeat(64) },
    events: input.events.slice(1),
  });
  assert.equal(invalid.context.snapshotStatus, "invalid_snapshot");
  assert.deepEqual(invalid.context.promptMessages, []);
  assert.equal(invalid.timeline.eventTailComplete, false);

  const misboundSnapshot = { ...input.handoff!.snapshot as Record<string, unknown> };
  misboundSnapshot.currentRequest = {
    ...(misboundSnapshot.currentRequest as Record<string, unknown>),
    messageId: assistantMessageId,
  };
  const misbound = projectCompanionTurnReplayV1({
    ...input,
    handoff: {
      ...input.handoff!,
      snapshot: misboundSnapshot,
      snapshotSha256: sha256Utf8V1(canonicalJsonV1(misboundSnapshot)),
    },
  });
  assert.equal(misbound.context.snapshotStatus, "invalid_snapshot");
  assert.deepEqual(misbound.context.promptMessages, []);

  const oversized = projectCompanionTurnReplayV1({
    ...input,
    handoff: { ...input.handoff!, snapshot: null, snapshotBytes: 524_289 },
  });
  assert.equal(oversized.context.snapshotStatus, "over_limit");
  assert.deepEqual(oversized.context.promptMessages, []);
});

test("private turn replay bounds prompt text and reports truncation", () => {
  const input = replayInput();
  const snapshot = { ...input.handoff!.snapshot as Record<string, unknown> };
  snapshot.modelMessages = [{ role: "user", content: "x".repeat(60_000) }];
  const handoff = {
    ...input.handoff!,
    snapshot,
    snapshotSha256: sha256Utf8V1(canonicalJsonV1(snapshot)),
  };
  const report = projectCompanionTurnReplayV1({ ...input, handoff });
  assert.equal(report.context.promptMessages[0]?.text.length, 16_000);
  assert.equal(report.context.promptMessages[0]?.truncated, true);
  assert.equal(report.context.promptMessagesTruncated, true);
});
