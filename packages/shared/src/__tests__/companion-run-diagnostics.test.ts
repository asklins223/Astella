import assert from "node:assert/strict";
import { test } from "node:test";
import {
  companionAgentCapabilitySnapshotV1Schema,
  companionRunDoctorGrowthV1Schema,
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
  growth: null,
  markdown: "# 伴星运行诊断",
};

/** §12.2：成长闭环那一格只交事实，不交模型的隐藏推理，也不交用户原话。 */
const growth = {
  reflection: {
    id: "00000000-0000-4000-8000-00000000000a",
    createdAt: "2026-10-10T00:00:00.000Z",
    decision: "committed",
    decisionSummary: "提了一版自我描述",
    strategyVersion: "reflection-v1",
    inputFromSeq: 1,
    inputToSeq: 29,
    baselinePersonaRevision: 0,
    pendingPersonaRevision: 1,
    droppedCount: 2,
    jobId: "00000000-0000-4000-8000-00000000000b",
    jobStatus: "succeeded" as const,
  },
  persona: {
    currentRevision: 0, pendingRevision: 1, pendingAuthor: "assistant_reflection", pinnedThisRun: 0,
  },
  context: { personaIncluded: true, methodCandidatesIncluded: false, receiptPresent: true, candidateCount: 1 },
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

test("成长闭环那一格带出回顾、人格与装配三段事实，且同样 strict", () => {
  assert.deepEqual(companionRunDoctorGrowthV1Schema.parse(growth), growth);
  assert.equal(companionRunDoctorGrowthV1Schema.safeParse({
    ...growth,
    reflection: { ...growth.reflection, rawModelOutput: "用户原话与隐藏推理都不该在这里" },
  }).success, false);
  assert.equal(companionRunDoctorGrowthV1Schema.safeParse({
    ...growth,
    persona: { ...growth.persona, profileText: "整段人格正文不属于诊断" },
  }).success, false);
  // 三格各自可缺省：读不到就是 null，不投影成「一切正常」。
  assert.equal(companionRunDoctorGrowthV1Schema.parse({ reflection: null, persona: null, context: null }).reflection, null);
});
