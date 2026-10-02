import assert from "node:assert/strict";
import test from "node:test";
import {
  committedDiaryTask,
  diaryTaskAttempt,
  diaryTaskContext,
} from "../companion-daily-summary-task.ts";

test("daily diary task context freezes owner, workspace, task snapshot, and permission", () => {
  const jobSignal = new AbortController().signal;
  const job = {
    id: "job-17",
    workspaceId: "workspace-3",
    leaseToken: "lease-5",
    signal: jobSignal,
  } as unknown as Parameters<typeof diaryTaskContext>[0];
  const callerSignal = new AbortController().signal;

  const context = diaryTaskContext(job, "user-9", "diary-draft-v1", "hash-abc", callerSignal);

  assert.equal(context.workspaceId, "workspace-3");
  assert.equal(context.userId, "user-9");
  assert.deepEqual(context.inputSnapshotRef, { kind: "task", id: "job-17:diary-draft-v1", hash: "hash-abc" });
  assert.equal(context.permissionLevel, "diary_enabled_with_ai_consent");
  assert.equal(context.signal, callerSignal);
  assert.equal(diaryTaskContext(job, "user-9", "select-v1", "hash-def").signal, jobSignal);
});

test("daily diary task attempts bind the retry key and lease to the exact task", () => {
  const job = {
    id: "job-17",
    workspaceId: "workspace-3",
    leaseToken: "lease-5",
  } as unknown as Parameters<typeof diaryTaskAttempt>[0];

  const attempt = diaryTaskAttempt(job, "user-9", { id: "diary-image-v1", version: 2 });

  assert.equal(attempt.taskId, "diary-image-v1");
  assert.equal(attempt.taskVersion, 2);
  assert.match(attempt.attemptId, /^[0-9a-f-]{36}$/);
  assert.equal(attempt.leaseToken, "lease-5");
  assert.equal(attempt.idempotencyKey, "daily-diary:job-17:diary-image-v1");
  assert.equal(attempt.workspaceId, "workspace-3");
  assert.equal(attempt.userId, "user-9");
});

test("committed diary task returns a complete zero-model-call receipt", () => {
  const output = { summary: "今天完成了一次复习", selectedSourceIds: ["source-1"] };

  const receipt = committedDiaryTask(output);

  assert.equal(receipt.outcome, "committed");
  assert.equal(receipt.output, output);
  assert.deepEqual(receipt.usage, {
    modelCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    elapsedMs: 0,
    autoRetriesUsed: 0,
  });
  assert.equal(receipt.failure, null);
  assert.equal(receipt.preservedValidResult, false);
  assert.equal(receipt.resumedFromCheckpoint, false);
  assert.equal(receipt.modelCalls, 0);
});
