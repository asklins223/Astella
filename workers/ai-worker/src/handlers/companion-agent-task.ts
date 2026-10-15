import { randomUUID } from "node:crypto";
import type { AgentTurnRequest, AgentTurnResult } from "@astella/shared";
import type { AiAttemptToken, AiTaskCheckpointPort } from "@astella/shared/ai-task-kernel";
import { runAgentModelStep } from "@astella/agent-core";
import { auditHash } from "./companion-tool-call-ledger.ts";
import { HandlerTimeoutError } from "../lib/handler-timeout.ts";
import { JobLeaseLostError, type JobLeaseContext } from "../lib/job-lease.ts";
import type { AIProvider } from "../lib/ai-provider.ts";

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

export function companionAgentModelInputHash(options: Pick<CompanionAgentModelStepOptions, "request" | "provider" | "permissionLevel">) {
  return auditHash({ request: options.request, providerId: options.provider.id, modelId: options.provider.modelId,
    promptVersion: options.provider.promptVersion, permissionLevel: options.permissionLevel });
}


/** Interactive host wiring; model/checkpoint execution lives in agent-core. */
export async function runCompanionAgentModelStep(options: CompanionAgentModelStepOptions): Promise<AgentTurnResult> {
  const taskId = "companion_agent_model_step", taskVersion = 1;
  const hash = companionAgentModelInputHash(options);
  const signal = options.signal ?? options.job.signal;
  return runAgentModelStep({
    request: options.request, timeoutMs: options.timeoutMs, resourceClass: "interactive_ai",
    context: { workspaceId: options.job.workspaceId, userId: options.userId, permissionLevel: options.permissionLevel,
      inputSnapshotRef: { kind: "task", id: `${options.runId}:${options.stepId}:${taskId}`, hash }, signal },
    attempt: { taskId, taskVersion, attemptId: randomUUID(), leaseToken: options.job.leaseToken,
      idempotencyKey: `companion:${options.runId}:${options.stepId}:${hash}`, workspaceId: options.job.workspaceId, userId: options.userId },
    model: { modelId: options.provider.modelId, promptVersion: `${options.provider.promptVersion}:companion-agent-step-v${taskVersion}`,
      execute: (_request, modelSignal) => options.execute(modelSignal) },
    currentActiveTransaction: options.currentActiveTransaction, verifyAttempt: options.verifyAttempt, checkpoint: options.checkpoint,
    errors: { inactive: () => new JobLeaseLostError(options.job.id, signal?.aborted ? "aborted" : "inactive"),
      timeout: () => new HandlerTimeoutError(options.timeoutMs) },
  });
}

/**
 * 按步装配模型调用的收口（2026-10-15 从 companion-agent-runtime.ts 迁入装配）：
 * 把宿主的预算判据、租约复检与上下文新鲜度接进 runCompanionAgentModelStep。
 * 纯搬运——判据、租约复核与检查点端口一字未改；stepId 与 deadlineAt 都是循环内的
 * 可变状态，用访问器接进来，所有权仍在运行时。
 */
export function createCompanionModelStepRunner(deps: {
  job: JobLeaseContext;
  read: { runId: string; userId: string };
  event: AgentEventContext;
  permissionLevel: string;
  deadlineAt: () => number;
  getStepId: () => string;
}) {
  return (
    provider: AIProvider,
    request: AgentTurnRequest,
    signal: AbortSignal,
    execute: (taskSignal: AbortSignal) => Promise<AgentTurnResult>,
    timeoutMs = resolveProviderCallTimeout("companion_agent"),
  ): Promise<AgentTurnResult> => {
    const taskTimeoutMs = Math.min(timeoutMs, deps.deadlineAt() - Date.now());
    if (taskTimeoutMs <= 0) {
      throw new CompanionAgentBudgetExceededError("companion agent deadline exceeded before model step");
    }
    return runCompanionAgentModelStep({
      job: deps.job,
      runId: deps.read.runId,
      stepId: deps.getStepId(),
      userId: deps.read.userId,
      permissionLevel: deps.permissionLevel,
      request,
      provider,
      signal,
      timeoutMs: taskTimeoutMs,
      currentActiveTransaction: currentWorkerWorkspaceTransaction,
      verifyAttempt: async attempt => {
        if (!(await isJobLeaseActive({ ...deps.job, leaseToken: attempt.leaseToken }))) return false;
        await withWorkerWorkspaceTransaction({ workspaceId: deps.job.workspaceId, userId: deps.read.userId },
          tx => assertCompanionContextSourcesCurrent(tx, { workspaceId: deps.job.workspaceId, userId: deps.read.userId }, deps.read.runId));
        return true;
      },
      checkpoint: createCompanionAgentStepCheckpointPort(deps.event, deps.getStepId()),
      execute,
    });
  };
}

import { CompanionAgentBudgetExceededError } from "../lib/non-retryable-errors.ts";
import { createCompanionAgentStepCheckpointPort } from "./companion-agent-events.ts";
import { resolveProviderCallTimeout } from "../lib/handler-timeout-config.ts";
import { withWorkerWorkspaceTransaction, currentWorkerWorkspaceTransaction } from "../db.ts";
import { assertCompanionContextSourcesCurrent } from "./companion-context-sources.ts";
import { isJobLeaseActive } from "../lib/job-lease.ts";
import type { AgentEventContext } from "./companion-read-tools.ts";
