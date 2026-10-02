import { randomUUID } from "node:crypto";
import { canonicalJsonV1, sha256Utf8V1 } from "@ailearn/shared/content-hash";
import {
  classifyThrownAsStepFailure,
  runAiTask,
  type AiAttemptToken,
  type AiStepResult,
  type AiTaskContext,
  type AiTaskDefinition,
  type AiTaskReceipt,
} from "@ailearn/shared/ai-task-kernel";
import { currentWorkerWorkspaceTransaction } from "../db.ts";
import { HandlerTimeoutError } from "../lib/handler-timeout.ts";
import { JobLeaseLostError, isJobLeaseActive, type JobLeaseContext } from "../lib/job-lease.ts";

export interface WorkerAiTaskOptions<TInput, TOutput> {
  job: JobLeaseContext;
  userId: string;
  taskId: string;
  taskVersion: number;
  idempotencyKey: string;
  inputSnapshotRef: AiTaskContext["inputSnapshotRef"];
  input: TInput;
  modelId: string;
  promptVersion: string;
  resourceClass: string;
  timeoutMs: number;
  taskDeadlineMs?: number;
  maxModelCalls?: number;
  maxAutoRetries?: number;
  currentActiveTransaction?: () => unknown;
  verifyAttempt?: (attempt: AiAttemptToken) => Promise<boolean>;
  isOutputShapeError?: (error: unknown) => boolean;
  execute: (input: TInput, signal: AbortSignal, retryIndex: number) => Promise<AiStepResult<TOutput>>;
}

export interface WorkerEmbeddingTaskOptions {
  job: JobLeaseContext;
  userId: string;
  taskId: string;
  taskVersion: number;
  idempotencyKey: string;
  inputSnapshotId: string;
  text: string;
  modelId: string;
  promptVersion: string;
  resourceClass: string;
  timeoutMs: number;
  currentActiveTransaction?: () => unknown;
  verifyAttempt?: (attempt: AiAttemptToken) => Promise<boolean>;
  embed: (text: string, signal: AbortSignal) => Promise<number[] | null>;
}

function emptyTaskReceipt<TOutput>(output: TOutput): AiTaskReceipt<TOutput> {
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

/** Run one worker model step through the public kernel while domain handlers own persistence. */
export async function runWorkerAiTask<TInput, TOutput>(
  options: WorkerAiTaskOptions<TInput, TOutput>,
): Promise<TOutput> {
  if (options.timeoutMs <= 0) throw new HandlerTimeoutError(0);
  let executionError: unknown;
  let executionFailed = false;
  const verifyAttempt = options.verifyAttempt ?? (async (attempt: AiAttemptToken) => (
    attempt.workspaceId === options.job.workspaceId
      && attempt.userId === options.userId
      && attempt.leaseToken === options.job.leaseToken
      && await isJobLeaseActive(options.job)
  ));
  const definition: AiTaskDefinition<TInput, TOutput> = {
    id: options.taskId,
    version: options.taskVersion,
    mode: "structured",
    resourceClass: options.resourceClass,
    budget: {
      maxModelCalls: options.maxModelCalls ?? 1,
      stepTimeoutMs: options.timeoutMs,
      taskDeadlineMs: options.taskDeadlineMs ?? options.timeoutMs,
      maxAutoRetries: options.maxAutoRetries ?? 0,
    },
    completion: { kind: "structured_parsed" },
    usageContext: {
      modelId: options.modelId,
      promptVersion: options.promptVersion,
      resourceClass: options.resourceClass,
    },
    prepare: async (_ctx, attempt) => {
      if (!(await verifyAttempt(attempt))) {
        throw new JobLeaseLostError(options.job.id, options.job.signal?.aborted ? "aborted" : "inactive");
      }
      return options.input;
    },
    execute: async (input, env) => {
      try {
        return await options.execute(input, env.signal, env.retryIndex);
      } catch (error) {
        executionError = error;
        executionFailed = true;
        if (options.isOutputShapeError?.(error)) {
          return {
            ok: false,
            class: "output_shape",
            message: error instanceof Error ? error.message : String(error),
          };
        }
        return classifyThrownAsStepFailure(error);
      }
    },
    // The domain handler keeps ownership of durable output and validates its
    // source version inside its existing fenced transaction.
    commit: async (_ctx, _attempt, output) => emptyTaskReceipt(output),
  };
  const ctx: AiTaskContext = {
    workspaceId: options.job.workspaceId,
    userId: options.userId,
    inputSnapshotRef: options.inputSnapshotRef,
    permissionLevel: "server",
    signal: options.job.signal,
  };
  const attempt: AiAttemptToken = {
    taskId: definition.id,
    taskVersion: definition.version,
    attemptId: randomUUID(),
    leaseToken: options.job.leaseToken,
    idempotencyKey: options.idempotencyKey,
    workspaceId: options.job.workspaceId,
    userId: options.userId,
  };
  const receipt = await runAiTask(definition, {
    ctx,
    attempt,
    currentActiveTransaction: options.currentActiveTransaction ?? currentWorkerWorkspaceTransaction,
    verifyAttempt,
  });
  if (receipt.outcome === "committed" || receipt.outcome === "resumed_and_committed") {
    if (receipt.output !== null) return receipt.output;
    throw new Error(`${options.taskId} completed without output`);
  }
  if (receipt.failure?.class === "lease_lost" || receipt.failure?.class === "cancelled") {
    throw new JobLeaseLostError(options.job.id, options.job.signal?.aborted ? "aborted" : "inactive");
  }
  if (!(await verifyAttempt(attempt))) {
    throw new JobLeaseLostError(options.job.id, options.job.signal?.aborted ? "aborted" : "inactive");
  }
  if (executionFailed) throw executionError;
  if (receipt.failure?.class === "timeout" || receipt.outcome === "budget_exhausted") {
    throw new HandlerTimeoutError(options.timeoutMs);
  }
  throw new Error(receipt.failure?.message ?? `${options.taskId} did not complete`);
}

/** Run one embedding request through the same lease, cancellation, and budget boundary. */
export async function runWorkerEmbeddingTask(
  options: WorkerEmbeddingTaskOptions,
): Promise<number[] | null> {
  const inputSnapshotHash = sha256Utf8V1(canonicalJsonV1({
    taskId: options.taskId,
    taskVersion: options.taskVersion,
    workspaceId: options.job.workspaceId,
    userId: options.userId,
    text: options.text,
    modelId: options.modelId,
    promptVersion: options.promptVersion,
  }));
  const result = await runWorkerAiTask({
    job: options.job,
    userId: options.userId,
    taskId: options.taskId,
    taskVersion: options.taskVersion,
    idempotencyKey: `${options.idempotencyKey}:${inputSnapshotHash}`,
    inputSnapshotRef: { kind: "task", id: options.inputSnapshotId, hash: inputSnapshotHash },
    input: { text: options.text },
    modelId: options.modelId,
    promptVersion: options.promptVersion,
    resourceClass: options.resourceClass,
    timeoutMs: options.timeoutMs,
    currentActiveTransaction: options.currentActiveTransaction,
    verifyAttempt: options.verifyAttempt,
    execute: async (input, signal) => ({
      ok: true,
      output: { embedding: await options.embed(input.text, signal) },
    }),
  });
  return result.embedding;
}
