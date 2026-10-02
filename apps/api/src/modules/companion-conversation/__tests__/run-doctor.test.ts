import assert from "node:assert/strict";
import { test } from "node:test";
import {
  projectCompanionRunDoctorV1,
  type CompanionRunDoctorProjectionInput,
} from "../run-doctor.ts";

function input(): CompanionRunDoctorProjectionInput {
  return {
    run: {
      id: "00000000-0000-4000-8000-000000000001",
      conversationId: "00000000-0000-4000-8000-000000000002",
      status: "running",
      generation: 2,
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
      startedAt: new Date("2026-10-01T00:00:01.000Z"),
      finishedAt: null,
      assistantMessageId: null,
      errorCode: null,
      providerId: "provider-a",
      modelId: "model-a",
      promptVersion: "companion-v1",
      permissionLevel: "guided",
      permissionSnapshot: {
        version: 1,
        level: "guided",
        offeredTools: [{ name: "companion_search_notes", toolVersion: "1", riskClass: "read" }],
      },
      budgetSnapshot: {
        maxSteps: 8,
        maxToolCallsPerStep: 4,
        maxToolCalls: 12,
        deadlineMs: 120_000,
      },
      stepCount: 1,
      toolCallCount: 0,
      agentElapsedMs: 500,
      lastEventSeq: 3,
      jobId: "00000000-0000-4000-8000-000000000003",
    },
    job: {
      id: "00000000-0000-4000-8000-000000000003",
      status: "running",
      attempts: 0,
      hasLease: true,
      scheduledAt: new Date("2026-10-01T00:00:00.000Z"),
      startedAt: new Date("2026-10-01T00:00:01.000Z"),
      finishedAt: null,
    },
    stepCounts: [{ status: "running", count: 1 }],
    toolCounts: [],
    retainedEvent: { count: 1, latestSeq: 3, latestAt: new Date("2026-10-01T00:00:02.000Z") },
  };
}

test("run doctor reports queue, capability, budget and ledger state from safe projections", () => {
  const report = projectCompanionRunDoctorV1(input());
  assert.equal(report.run.status, "running");
  assert.equal(report.executionBudget.stepsUsed, 1);
  assert.equal(report.queue.hasLease, true);
  assert.deepEqual(report.capabilities.offeredTools.map((tool) => tool.name), ["companion_search_notes"]);
  assert.equal(report.ledger.retainedEventCount, 1);
  assert.equal(report.ledger.latestRetainedEventSeq, 3);
  assert.deepEqual(report.findings, []);
});

test("run doctor identifies unknown outcomes and broken active links without exporting raw error text", () => {
  const rawPrivateError = "provider response carried private user text";
  const source = input();
  const report = projectCompanionRunDoctorV1({
    ...source,
    run: {
      ...source.run,
      status: "failed",
      errorCode: rawPrivateError,
    },
    job: {
      ...source.job!,
      hasLease: false,
    },
    toolCounts: [{ status: "outcome_unknown", count: 1 }],
    retainedEvent: { count: 0, latestSeq: null, latestAt: null },
  });
  assert.equal(report.run.failureCategory, "unknown");
  assert.ok(report.findings.some((finding) => finding.code === "run_failed"));
  assert.ok(report.findings.some((finding) => finding.code === "tool_outcome_unknown"));
  assert.equal(JSON.stringify(report).includes(rawPrivateError), false);
  assert.equal("errorCode" in report.run, false);
});

test("active run with no job, no capability snapshot or no retained event tail is called out", () => {
  const source = input();
  const report = projectCompanionRunDoctorV1({
    ...source,
    run: { ...source.run, permissionSnapshot: null },
    job: null,
    retainedEvent: { count: 1, latestSeq: 2, latestAt: new Date("2026-10-01T00:00:02.000Z") },
  });
  const codes = report.findings.map((finding) => finding.code);
  assert.ok(codes.includes("active_job_missing"));
  assert.ok(codes.includes("tool_snapshot_missing"));
  assert.ok(codes.includes("active_event_tail_missing"));
});

test("doctor exposes bounded failure span identity and recovery without private error text", () => {
  const source = input();
  const report = projectCompanionRunDoctorV1({
    ...source,
    failureSpans: [{
      failureClass: "transport",
      startedAt: "2026-10-01T00:00:00.000Z",
      lastFailureAt: "2026-10-01T00:01:00.000Z",
      failureCount: 3,
      firstRunId: source.run.id,
      lastRunId: source.run.id,
      recoveredAt: null,
      recoveryRunId: null,
    }],
  });

  assert.equal(report.failureSpans[0]?.failureCount, 3);
  assert.equal(report.failureSpans[0]?.recoveredAt, null);
  assert.ok(report.findings.some((finding) => finding.code === "open_failure_span"));
  assert.match(report.markdown, /transport：3 次/);
  assert.equal(report.markdown.includes("provider response carried private user text"), false);
});
