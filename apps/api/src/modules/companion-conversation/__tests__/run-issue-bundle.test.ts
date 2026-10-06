import assert from "node:assert/strict";
import { test } from "node:test";
import { companionRunIssueBundleV1Schema } from "@astella/shared";
import { projectCompanionRunIssueBundleV1 } from "../run-issue-bundle.ts";

test("external issue bundle contains only allowlisted, deidentified run evidence", () => {
  const report = projectCompanionRunIssueBundleV1({
    run: {
      status: "failed",
      generation: 3,
      assistantMessagePersisted: false,
      errorCode: "provider error with a private request",
      providerId: "https://user:secret@provider.example",
      modelId: "model-a",
      promptVersion: "companion-v1",
      leakGateVersion: "gate-v1",
      permissionLevel: "guided",
      budgetSnapshot: {
        version: 1,
        maxSteps: 8,
        maxToolCallsPerStep: 4,
        maxToolCalls: 12,
        deadlineMs: 120_000,
      },
      stepCount: 2,
      toolCallCount: 1,
      agentElapsedMs: 4300,
      lastEventSeq: 12,
    },
    steps: [
      { ordinal: 1, kind: "model", status: "succeeded" },
      { ordinal: 2, kind: "tool", status: "failed" },
    ],
    toolCalls: [{ name: "companion_search_notes", toolVersion: "1", riskClass: "read", status: "failed" }],
    events: [
      { seq: 12, type: "error" },
      { seq: 11, type: "agent.tool" },
      { seq: 10, type: "turn.accepted" },
    ],
  });
  const runFile = report.files.find((file) => file.path === "run.json");
  const executionFile = report.files.find((file) => file.path === "execution.json");
  const timelineFile = report.files.find((file) => file.path === "timeline.json");
  assert.ok(runFile && executionFile && timelineFile);
  assert.equal(runFile.content.run.failureCategory, "unknown");
  assert.equal(runFile.content.run.providerId, null);
  assert.equal(runFile.content.usage.elapsedMs, 4300);
  assert.deepEqual(timelineFile.content.eventTypes, ["error", "agent.tool", "turn.accepted"]);
  assert.equal(JSON.stringify(report).includes("provider error with a private request"), false);
  assert.equal(JSON.stringify(report).includes("secret"), false);
  assert.equal(JSON.stringify(report).includes("userId"), false);
  assert.equal(JSON.stringify(report).includes("arguments"), false);
  assert.equal("arguments" in executionFile.content.tools[0]!, false);

  const firstFile = report.files[0]!;
  assert.equal(companionRunIssueBundleV1Schema.safeParse({
    ...report,
    files: report.files.map((file) => file === firstFile
      ? { ...file, content: { ...file.content, userId: "private-user" } }
      : file),
  }).success, false);
  assert.equal(companionRunIssueBundleV1Schema.safeParse({
    ...report,
    files: [report.files[0], report.files[1], report.files[2], report.files[0]],
  }).success, false);
});
