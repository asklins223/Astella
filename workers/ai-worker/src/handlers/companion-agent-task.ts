import { randomUUID } from "node:crypto";
import type { AgentTurnRequest, AgentTurnResult } from "@ailearn/shared";
import {
  classifyThrownAsStepFailure,
  runAiTask,
  type AiAttemptToken,
  type AiTaskCheckpointPort,
  type AiTaskContext,
  type AiTaskDefinition,
  type AiTaskReceipt,
} from "@ailearn/shared/ai-task-kernel";
import { auditHash } from "./companion-tool-call-ledger.ts";
import { HandlerTimeoutError } from "../lib/handler-timeout.ts";
import { JobLeaseLostError, type JobLeaseContext } from "../lib/job-lease.ts";
import type { AIProvider } from "../lib/ai-provider.ts";

const TASK_ID = "companion_agent_model_step";
const TASK_VERSION = 1;

export interface CompanionAgentModelStepOptions {
  job: JobLeaseContext;
  runId: string;
  stepId: string;
  userId: string;
  permissionLevel: string;
  request: AgentTurnRequest;
  provider: AIProvider;
  signal?: AbortSignal;
  timeoutMs: number;
  currentActiveTransaction: () => unknown;
  verifyAttempt: (attempt: AiAttemptToken) => Promise<boolean>;
  checkpoint?: AiTaskCheckpointPort<AgentTurnResult>;
  execute: (signal: AbortSignal) => Promise<AgentTurnResult>;
}

function committedModelStep(output: AgentTurnResult): AiTaskReceipt<AgentTurnResult> {
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

/** Run one already-parsed companion agent model step through the shared task boundary. */
export async function runCompanionAgentModelStep(
  options: CompanionAgentModelStepOptions,
): Promise<AgentTurnResult> {
  if (options.timeoutMs <= 0) throw new HandlerTimeoutError(0);
  const inputSnapshotHash = auditHash({
    request: options.request,
    providerId: options.provider.id,
    modelId: options.provider.modelId,
    promptVersion: options.provider.promptVersion,
    permissionLevel: options.permissionLevel,
  });
  let executionError: unknown;
  let executionFailed = false;
  const definition: AiTaskDefinition<Record<string, never>, AgentTurnResult> = {
    id: TASK_ID,
    version: TASK_VERSION,
    mode: "structured",
    resourceClass: "interactive_ai",
    budget: {
      maxModelCalls: 1,
      stepTimeoutMs: options.timeoutMs,
      taskDeadlineMs: options.timeoutMs,
      // Streaming fallback, truncation retry, and repair ladders remain explicit
      // caller decisions; the shared kernel must not add hidden calls here.
      maxAutoRetries: 0,
    },
    completion: { kind: "structured_parsed" },
    usageContext: {
      modelId: options.provider.modelId,
      promptVersion: `${options.provider.promptVersion}:companion-agent-step-v${TASK_VERSION}`,
      resourceClass: "interactive_ai",
    },
    prepare: async () => {
      if (!(await options.verifyAttempt(attempt))) {
        throw new JobLeaseLostError(
          options.job.id,
          (options.signal ?? options.job.signal)?.aborted ? "aborted" : "inactive",
        );
      }
      return {};
    },
    execute: async (_input, env) => {
      try {
        const output = await options.execute(env.signal);
        return {
          ok: true,
          output,
          promptTokens: output.usage?.promptTokens ?? undefined,
          completionTokens: output.usage?.completionTokens ?? undefined,
        };
      } catch (error) {
        executionError = error;
        executionFailed = true;
        return classifyThrownAsStepFailure(error);
      }
    },
    // The runtime persists step and tool ledger state after this candidate is
    // returned; this commit boundary has no additional business-side effect.
    commit: async (_ctx: AiTaskContext, _attempt: AiAttemptToken, output) => committedModelStep(output),
  };
  const ctx: AiTaskContext = {
    workspaceId: options.job.workspaceId,
    userId: options.userId,
    inputSnapshotRef: {
      kind: "task",
      id: `${options.runId}:${options.stepId}:${TASK_ID}`,
      hash: inputSnapshotHash,
    },
    permissionLevel: options.permissionLevel,
    signal: options.signal ?? options.job.signal,
  };
  const attempt: AiAttemptToken = {
    taskId: definition.id,
    taskVersion: definition.version,
    attemptId: randomUUID(),
    leaseToken: options.job.leaseToken,
    idempotencyKey: `companion:${options.runId}:${options.stepId}:${inputSnapshotHash}`,
    workspaceId: options.job.workspaceId,
    userId: options.userId,
  };

  const receipt = await runAiTask(definition, {
    ctx,
    attempt,
    currentActiveTransaction: options.currentActiveTransaction,
    verifyAttempt: options.verifyAttempt,
    checkpoint: options.checkpoint,
  });
  if (receipt.outcome === "committed" || receipt.outcome === "resumed_and_committed") {
    if (receipt.output) return receipt.output;
    throw new Error("companion agent model step completed without an output");
  }
  if (executionFailed) throw executionError;
  if (receipt.failure?.class === "lease_lost") {
    throw new JobLeaseLostError(options.job.id, (options.signal ?? options.job.signal)?.aborted ? "aborted" : "inactive");
  }
  if (receipt.failure?.class === "cancelled") {
    throw new JobLeaseLostError(options.job.id, (options.signal ?? options.job.signal)?.aborted ? "aborted" : "inactive");
  }
  if (receipt.failure?.class === "timeout" || receipt.outcome === "budget_exhausted") {
    throw new HandlerTimeoutError(options.timeoutMs);
  }
  throw new Error(receipt.failure?.message ?? "companion agent model step did not complete");
}
