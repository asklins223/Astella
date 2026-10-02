import assert from "node:assert/strict";
import { test } from "node:test";
import {
  companionAgentCapabilitySnapshotV1Schema,
  companionRunDoctorV1Schema,
} from "../index.ts";

const capability = {
  version: 1 as const,
  level: "read_only" as const,
  offeredTools: [{ name: "companion_search_notes", toolVersion: "1", riskClass: "read" as const }],
};

const report = {
  version: 1 as const,
  run: {
    id: "00000000-0000-4000-8000-000000000001",
    conversationId: "00000000-0000-4000-8000-000000000002",
    status: "running" as const,
    generation: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    startedAt: "2026-10-01T00:00:01.000Z",
    finishedAt: null,
    assistantMessagePersisted: false,
    failureCategory: "none" as const,
    providerId: "provider-a",
    modelId: "model-a",
    promptVersion: "companion-v1",
    permissionLevel: "read_only" as const,
  },
  executionBudget: {
    maxSteps: 8,
    stepsUsed: 1,
    maxToolCallsPerStep: 4,
    maxToolCalls: 12,
    toolCallsUsed: 0,
    deadlineMs: 120_000,
    elapsedMs: 500,
  },
  queue: {
    jobId: "00000000-0000-4000-8000-000000000003",
    status: "running" as const,
    attempts: 0,
    hasLease: true,
    scheduledAt: "2026-10-01T00:00:00.000Z",
    startedAt: "2026-10-01T00:00:01.000Z",
    finishedAt: null,
  },
  capabilities: { snapshotPresent: true, permissionLevel: "read_only" as const, offeredTools: capability.offeredTools },
  ledger: {
    stepCounts: [{ status: "running" as const, count: 1 }],
    toolCounts: [],
    unknownToolOutcomeCount: 0,
    pendingToolCount: 0,
    retainedEventCount: 1,
    latestRetainedEventSeq: 3,
    latestRetainedEventAt: "2026-10-01T00:00:02.000Z",
  },
  findings: [],
  failureSpans: [],
  markdown: "# 伴星运行诊断",
};

test("capability snapshot carries only the permission and offered tool identities", () => {
  assert.deepEqual(companionAgentCapabilitySnapshotV1Schema.parse(capability), capability);
  assert.equal(companionAgentCapabilitySnapshotV1Schema.safeParse({
    ...capability,
    offeredTools: [{ ...capability.offeredTools[0], arguments: { note: "private" } }],
  }).success, false);
});

test("run doctor wire contract is strict and rejects private prompt, checkpoint and tool payload fields", () => {
  assert.deepEqual(companionRunDoctorV1Schema.parse(report), report);
  for (const patch of [
    { run: { ...report.run, pageContext: "private" } },
    { ledger: { ...report.ledger, checkpoint: { answer: "private" } } },
    { queue: { ...report.queue, payload: { prompt: "private" } } },
  ]) {
    assert.equal(companionRunDoctorV1Schema.safeParse({ ...report, ...patch }).success, false);
  }
});
