import { getAgentCapability, validateAgentCapabilityArguments } from "@ailearn/shared/agent-capability-catalog";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { AgentScopeV1, AgentInputRefV1 } from "@ailearn/shared/agent-contracts";
import { AgentStoreError, queryRows, requireVisibleInput, type AgentSqlExecutor, type AgentRunRow } from "./store.ts";
import type { AgentOperationRow } from "./history.ts";
import { projectAgentOperation } from "./history.ts";

/** Called within the caller's fenced transaction, from either a human-selected
 * request or a model capability call. This is the sole note operation creator. */
export async function startAgentNoteOperation(tx: AgentSqlExecutor, scope: AgentScopeV1, run: AgentRunRow,
  call: { id: string; name: string; arguments: Record<string, unknown> }, ref: AgentInputRefV1) {
  const entry = getAgentCapability(call.name);
  if (entry?.executor !== "note" || entry.definition.riskClass === "read"
  || !validateAgentCapabilityArguments(call.name, call.arguments, "goal").success)
  throw new AgentStoreError(400, "unknown_capability", "这项生成能力当前不可用。");
  if (scope.workspaceId !== run.workspace_id || scope.userId !== run.user_id)
  throw new AgentStoreError(403, "scope_mismatch", "这件事不在当前空间。");
  await requireVisibleInput(tx, scope, ref);
  if (!run.inputs.some(input => input.noteId === ref.noteId && input.noteVersionId === ref.noteVersionId))
  throw new AgentStoreError(403, "input_outside_goal", "这份材料不在当前目标范围内。");

  const key = `${call.name}:${ref.noteId}:${ref.noteVersionId}`;
  // 回执统一由 agent-host 投影为 execution 与 result。
  const [existing] = await queryRows<AgentOperationRow>(tx,
    sql`SELECT * FROM agent_operations WHERE run_id=${run.id} AND revision=${run.revision} AND tool_call_id=${key}`);
  if (existing) return { ...projectToolResult(scope, run.id, existing), noteId: ref.noteId, noteVersionId: ref.noteVersionId };
  if (run.resume_from_revision) {
    const [saved] = await queryRows<AgentOperationRow>(tx, sql`SELECT * FROM agent_operations
      WHERE run_id=${run.id} AND revision<=${run.resume_from_revision} AND tool_call_id=${key}
        AND status='succeeded' AND result IS NOT NULL ORDER BY revision DESC LIMIT 1`);
    if (saved) return { ...projectToolResult(scope, run.id, saved), reused: true,
      noteId: ref.noteId, noteVersionId: ref.noteVersionId };
  }
  const [count] = await queryRows<{ n: string }>(tx, sql`SELECT count(*) AS n FROM agent_operations WHERE run_id=${run.id}`);
  if (Number(count?.n) >= 8) throw new AgentStoreError(422, "operation_budget", "这件事已到生成上限，先保留当前结果。");
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`job-quota:${scope.workspaceId}`},0))`);
  const [quota] = await queryRows<{ n: string }>(tx, sql`SELECT count(*) AS n FROM jobs WHERE workspace_id=${scope.workspaceId} AND status='pending'`);
  if (Number(quota?.n) >= 50) throw new AgentStoreError(429, "queue_busy", "队列正在处理较多内容，稍后再继续。");
  const operationId = randomUUID(), jobId = randomUUID();
  const direct = run.direct_request?.capability === call.name ? run.direct_request : null;
  const payload = { noteId: ref.noteId, noteVersionId: ref.noteVersionId, requestId: operationId,
    ...(call.name === "note_dynamic_artifact_generate" ? { sourceKind: "overview" } : {}),
    ...(direct?.capability === "note_dynamic_artifact_generate" ? { sourceKind: direct.request.sourceKind,
      ...(direct.request.selectionAnchor ? { anchor: direct.request.selectionAnchor } : {}) } : {}),
    ...(direct?.capability === "note_expansion_generate" ? {
      ...(direct.request.focusAnchor ? { focusAnchor: direct.request.focusAnchor } : {}),
      ...(direct.request.sourceMessageId ? { sourceMessageId: direct.request.sourceMessageId, conversationId: direct.request.conversationId } : {}),
    } : {}),
    userId: scope.userId, agentRunId: run.id, agentRevision: run.revision, agentGoal: run.goal.slice(0,2000) };
  await tx.execute(sql`INSERT INTO agent_operations(id,run_id,workspace_id,user_id,revision,tool_call_id,capability,job_id)
    VALUES(${operationId},${run.id},${scope.workspaceId},${scope.userId},${run.revision},${key},${call.name},${jobId})`);
  await tx.execute(sql`INSERT INTO jobs(id,type,workspace_id,requested_by,payload,status,priority,resource_class,idempotency_key)
    VALUES(${jobId},${call.name},${scope.workspaceId},${scope.userId},${JSON.stringify(payload)}::jsonb,
      'pending',70,'card_foreground',${`agent-operation:${operationId}`})`);
  return { status: "accepted", operationId, execution: { kind: "job" as const, id: jobId },
    noteId: ref.noteId, noteVersionId: ref.noteVersionId };

}
function projectToolResult(scope: AgentScopeV1, runId: string, row: AgentOperationRow) {
  const operation = projectAgentOperation(scope, runId, row);
  return { status: operation.status, operationId: operation.operationId, execution: operation.execution,
  ...(operation.result ? { result: operation.result } : {}) };
}
