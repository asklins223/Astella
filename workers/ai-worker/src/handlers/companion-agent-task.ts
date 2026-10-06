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


/** Interactive host wiring; model/checkpoint execution lives in agent-core. */
export async function runCompanionAgentModelStep(options: CompanionAgentModelStepOptions): Promise<AgentTurnResult> {
  const taskId = "companion_agent_model_step", taskVersion = 1;
  const hash = auditHash({ request: options.request, providerId: options.provider.id, modelId: options.provider.modelId,
    promptVersion: options.provider.promptVersion, permissionLevel: options.permissionLevel });
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
