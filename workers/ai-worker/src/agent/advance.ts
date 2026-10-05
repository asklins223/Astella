import { sql } from "drizzle-orm";
import { executeTurn, executeAgentStep, runAgentModelStep, declaredAgentRequestStep } from "@ailearn/agent-core";
import { createAgentAdvanceStore, AgentStoreError, projectRun } from "@ailearn/agent-host";
import { agentGoalDeliveryManifest } from "@ailearn/shared/agent-capabilities";
import { getAgentCapability } from "@ailearn/shared/agent-capability-catalog";
import { agentTurnResultSchema } from "@ailearn/shared";
import { sha256Utf8V1 } from "@ailearn/shared/content-hash";
import type { JobPayload } from "../handlers/index.ts";
import { buildAgentGoalRequest } from "./goal-context.ts";
import { withWorkerWorkspaceTransaction, db } from "../db.ts";
import { createProvider, type AIProvider } from "../lib/ai-provider.ts";
import { createGovernedProvider, resolveAIGovernanceContext, resolveProviderForTask } from "../lib/governance.ts";
import { randomUUID } from "node:crypto";
import { currentWorkerWorkspaceTransaction } from "../db.ts";
import { isJobLeaseActive } from "../lib/job-lease.ts";
import { HandlerTimeoutError } from "../lib/handler-timeout.ts";
import { agentStorePorts } from "./store.ts";
import { invokeNoteCapability } from "./note-capabilities.ts";
import { invokeCardGenerationCapability } from "./card-capabilities.ts";
import { invokeMethodCapability } from "./method-capabilities.ts";
import { invokeBasicCapability } from "./basic-capabilities.ts";
import { invokeExternalCapability } from "./external-capabilities.ts";
import { resolveCompanionAgentBudget } from "../lib/handler-timeout-config.ts";

/**
 * 能力名 → 适配器。**按 manifest 归属**而不是按前缀猜：名字写错时落到
 * `unknown_capability`，不会因为恰好长得像某一类而被送进另一个适配器。
 * 分发端口由项目唯一目录声明，运行时只绑定实际执行器。
 */
function capabilityInvoker(name: string, signal: AbortSignal) {
  if (name === agentGoalDeliveryManifest.definition.name) return (store: Parameters<typeof invokeBasicCapability>[0], call: Parameters<typeof invokeBasicCapability>[1]) =>
    store.invoke(async () => ({ status: "proposed", kind: "goal_delivery", delivery: agentGoalDeliveryManifest.argumentSchema.parse(call.arguments) }));
  const entry = getAgentCapability(name);
  if (!entry?.surfaces.includes("goal")) return null;
  const executors = { note: invokeNoteCapability, card: invokeCardGenerationCapability,
    method: invokeMethodCapability, basic: invokeBasicCapability,
    external: (store: Parameters<typeof invokeExternalCapability>[0], call: Parameters<typeof invokeExternalCapability>[1]) => invokeExternalCapability(store, call, signal) };
  return entry.executor in executors ? executors[entry.executor as keyof typeof executors] : null;
}


export async function runAgentAdvance(job: JobPayload) {
  const runId = String(job.payload.runId ?? ""), revision = Number(job.payload.revision);
  if (!/^[a-f0-9-]{36}$/i.test(runId) || !Number.isSafeInteger(revision) || revision < 1) throw new Error("invalid agent advance payload");
  const store = createAgentAdvanceStore(agentStorePorts, job, runId, revision);
  const acquired = await store.acquire();
  if (!acquired) return;
  if (acquired.status === "paused") { await store.release(false); return; }
  let needsAdvance = false;
  try {
    let provider: AIProvider | null = null;
    if (!acquired.direct_request) {
    const governance = await resolveAIGovernanceContext(job.workspaceId, job.requestedBy);
    const selected = resolveProviderForTask(governance, "companion_agent");
    provider = createGovernedProvider(createProvider(selected.providerName, selected.providerConfig), governance, job.workspaceId,
      { userId: store.scope.userId, operation: "agent_goal", jobId: job.id, dataCategories: ["note_content", "user_answer"] });
    if (!provider.executeAgentTurn) throw new AgentStoreError(422, "capability_unavailable", "当前模型不能执行持续目标。");
    }
    const deadlineAt = Date.now() + resolveCompanionAgentBudget("agent_run_advance").loopDeadlineMs;
    await executeTurn({ signal: job.signal, now: Date.now,
      limits: () => ({ maxSteps: 3, deadlineAt }), budgetError: () => new AgentStoreError(422, "slice_exhausted", "本次处理时段已结束。"),
      advance: async () => {
        const run = await store.read();
        const projection = await store.invoke((tx, current) => projectRun(tx, store.scope, current));
        if (projection.operations.some(o => ["accepted","running","outcome_unknown"].includes(o.status))) {
          await store.invoke(async tx => { await tx.execute(sql`UPDATE agent_runs SET status='waiting',updated_at=now() WHERE id=${runId}`); });
          return { kind: "settled", result: undefined };
        }
        const declared = run.direct_request ? declaredAgentRequestStep({ runId, revision, goal: run.goal,
          directRequest: run.direct_request, messages: run.messages, operations: projection.operations }) : null;
        const outcome = await executeAgentStep({
          signal: job.signal,
          context: { prepare: () => declared ? Promise.resolve(declared.request) : buildAgentGoalRequest(store, run) },
          state: {
            // Fingerprint the exact JSON snapshot, which includes fractional model temperatures.
            prepare: async request => { const prepared = await store.step(request, sha256Utf8V1(JSON.stringify(request)), declared ? "declared_request" : "model");
              return { checkpoint: prepared.step, request: prepared.step.context_snapshot, response: prepared.response }; },
            saveResponse: store.saveResponse, apply: store.applyStep,
          },
          model: { execute: async (request, step) => {
            if (declared) return declared.response;
            if (!provider?.executeAgentTurn) throw new AgentStoreError(422, "capability_unavailable", "当前模型不能执行持续目标。");
            return runAgentModelStep({
            request, resourceClass: "maintenance", timeoutMs: Math.max(1, Math.min(60000, deadlineAt-Date.now())),
            context: { ...store.scope, permissionLevel: "server", signal: job.signal,
              inputSnapshotRef: { kind: "task", id: step.id, hash: step.request_hash } },
            attempt: { ...store.scope, taskId: "agent_goal_step", taskVersion: 1, attemptId: randomUUID(),
              leaseToken: job.leaseToken, idempotencyKey: `agent-step:${runId}:${revision}:${step.id}` },
            model: { modelId: provider.modelId, promptVersion: `${provider.promptVersion}:agent-goal-v1`,
              execute: async (input, signal) => agentTurnResultSchema.parse(await provider.executeAgentTurn!(input, signal)) },
            currentActiveTransaction: currentWorkerWorkspaceTransaction,
            verifyAttempt: async () => isJobLeaseActive(job),
            errors: { inactive: () => new AgentStoreError(409, "advance_obsolete", "当前执行已经停止。"),
              timeout: () => new HandlerTimeoutError(Math.max(1, deadlineAt-Date.now())) },
          }); } },
          capabilities: { maxCalls: 4, invoke: async (call, allowed) => {
            try {
              if (!allowed) throw new AgentStoreError(422, "step_tool_budget", "本步执行上限已到，请在下一步继续。");
              const invoke = capabilityInvoker(call.name, job.signal ?? new AbortController().signal);
              if (!invoke) throw new AgentStoreError(400, "unknown_capability", "当前没有这项能力。");
              return await invoke(store, call);
            } catch (error) {
              if (error instanceof AgentStoreError && error.code === "advance_obsolete") throw error;
              return { status: "failed", error: error instanceof AgentStoreError ? error.message : "这一步没有执行，请核对参数与材料。" };
            }
          } },
        });
        if (outcome === "settled") return { kind: "settled", result: undefined };
        needsAdvance = true;
        return { kind: "continue" };
      },
    });
    needsAdvance = false;
  } catch (error) {
    if(error instanceof AgentStoreError && error.code==="long_goal_changed") {
      needsAdvance = false;
      await store.pauseForChangedLongGoal(error.message);
      return;
    }
    if (error instanceof AgentStoreError && error.code === "slice_exhausted") needsAdvance = true;
    else if (error instanceof AgentStoreError && error.code === "advance_obsolete") return;
    else throw error;
  } finally { await store.release(needsAdvance); }
}

let lastRecovery = 0;
export async function tickAgentRecovery() {
  if (Date.now()-lastRecovery < 30000) return;
  lastRecovery = Date.now();
  await db.execute(sql`SELECT ailearn_enqueue_agent_recovery()`);
}
export async function markAgentAdvanceFailed(job: JobPayload) {
  if (!job.requestedBy || typeof job.payload.runId !== "string") return;
  await withWorkerWorkspaceTransaction({ workspaceId: job.workspaceId, userId: job.requestedBy }, tx => tx.execute(sql`
    UPDATE agent_runs SET status='failed',error='这次没有继续完成，已做好的内容保留。',advance_job_id=NULL,advance_lease_token=NULL,updated_at=now()
    WHERE id=${job.payload.runId} AND workspace_id=${job.workspaceId} AND user_id=${job.requestedBy}
    AND revision=${Number(job.payload.revision)} AND status IN ('queued','running','waiting')
    AND (advance_job_id=${job.id} OR advance_job_id IS NULL)`));
}
