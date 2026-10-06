import { randomUUID } from "node:crypto";
import type {
  AiAttemptToken,
  AiTaskContext,
  AiTaskDefinition,
  AiTaskReceipt,
} from "@astella/shared/ai-task-kernel";
import type { JobPayload } from "./index.ts";

export function diaryTaskContext(
  job: JobPayload,
  userId: string,
  taskId: string,
  hash: string,
  signal?: AbortSignal,
): AiTaskContext {
  return {
    workspaceId: job.workspaceId,
    userId,
    inputSnapshotRef: { kind: "task", id: `${job.id}:${taskId}`, hash },
    permissionLevel: "diary_enabled_with_ai_consent",
    signal: signal ?? job.signal,
  };
}

export function diaryTaskAttempt(
  job: JobPayload,
  userId: string,
  definition: Pick<AiTaskDefinition<unknown, unknown>, "id" | "version">,
): AiAttemptToken {
  return {
    taskId: definition.id,
    taskVersion: definition.version,
    attemptId: randomUUID(),
    leaseToken: job.leaseToken,
    idempotencyKey: `daily-diary:${job.id}:${definition.id}`,
    workspaceId: job.workspaceId,
    userId,
  };
}

export function committedDiaryTask<T>(output: T): AiTaskReceipt<T> {
  return {
    outcome: "committed",
    output,
    usage: { modelCalls: 0, promptTokens: 0, completionTokens: 0, elapsedMs: 0, autoRetriesUsed: 0 },
    failure: null,
    preservedValidResult: false,
    resumedFromCheckpoint: false,
    modelCalls: 0,
  };
}
