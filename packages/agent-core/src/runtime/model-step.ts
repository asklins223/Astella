import type { AgentTurnRequest, AgentTurnResult } from "@ailearn/shared";
import { classifyThrownAsStepFailure, runAiTask, type AiAttemptToken, type AiTaskCheckpointPort,
  type AiTaskContext, type AiTaskDefinition, type AiTaskReceipt } from "@ailearn/shared/ai-task-kernel";

export interface AgentModelStepPorts {
  context: AiTaskContext;
  attempt: AiAttemptToken;
  request: AgentTurnRequest;
  model: { modelId: string; promptVersion: string; execute(request: AgentTurnRequest, signal: AbortSignal): Promise<AgentTurnResult> };
  timeoutMs: number;
  resourceClass: string;
  currentActiveTransaction: () => unknown;
  verifyAttempt: (attempt: AiAttemptToken) => Promise<boolean>;
  checkpoint?: AiTaskCheckpointPort<AgentTurnResult>;
  errors: { inactive(): Error; timeout(): Error };
}

/** One model boundary for interactive and background hosts, backed by the 41a kernel. */
export async function runAgentModelStep(ports: AgentModelStepPorts): Promise<AgentTurnResult> {
  if (ports.timeoutMs <= 0) throw ports.errors.timeout();
  let originalError: unknown;
  let threw = false;
  const definition: AiTaskDefinition<AgentTurnRequest, AgentTurnResult> = {
    id: ports.attempt.taskId, version: ports.attempt.taskVersion, mode: "structured", resourceClass: ports.resourceClass,
    budget: { maxModelCalls: 1, stepTimeoutMs: ports.timeoutMs, taskDeadlineMs: ports.timeoutMs, maxAutoRetries: 0 },
    completion: { kind: "structured_parsed" },
    usageContext: { modelId: ports.model.modelId, promptVersion: ports.model.promptVersion, resourceClass: ports.resourceClass },
    prepare: async () => { if (!(await ports.verifyAttempt(ports.attempt))) throw ports.errors.inactive(); return ports.request; },
    execute: async (request, env) => {
      try {
        const output = await ports.model.execute(request, env.signal);
        return { ok: true, output, promptTokens: output.usage?.promptTokens ?? undefined, completionTokens: output.usage?.completionTokens ?? undefined };
      } catch (error) { originalError = error; threw = true; return classifyThrownAsStepFailure(error); }
    },
    commit: async (_ctx, _attempt, output): Promise<AiTaskReceipt<AgentTurnResult>> => ({
      outcome: "committed", output, usage: { modelCalls: 0, promptTokens: 0, completionTokens: 0, elapsedMs: 0, autoRetriesUsed: 0 },
      failure: null, preservedValidResult: false, resumedFromCheckpoint: false, modelCalls: 0,
    }),
  };
  const receipt = await runAiTask(definition, { ctx: ports.context, attempt: ports.attempt,
    currentActiveTransaction: ports.currentActiveTransaction, verifyAttempt: ports.verifyAttempt, checkpoint: ports.checkpoint });
  if ((receipt.outcome === "committed" || receipt.outcome === "resumed_and_committed") && receipt.output) return receipt.output;
  if (threw) throw originalError;
  if (["lease_lost", "cancelled"].includes(receipt.failure?.class ?? "")) throw ports.errors.inactive();
  if (receipt.failure?.class === "timeout" || receipt.outcome === "budget_exhausted") throw ports.errors.timeout();
  throw new Error(receipt.failure?.message ?? "agent model step completed without an output");
}
