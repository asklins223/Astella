import { sql, type SQL } from "drizzle-orm";
import { agentRunV1Schema, type AgentRunV1, type AgentScopeV1, type AgentInputRefV1 } from "@ailearn/shared/agent-contracts";
import type { AgentTurnRequest } from "@ailearn/shared";
import { canonicalJsonV1 } from "@ailearn/shared/content-hash";

export interface AgentSqlExecutor { execute(query: SQL): Promise<unknown> }
export interface AgentStorePorts {
  transaction<T>(scope: AgentScopeV1, action: (tx: AgentSqlExecutor) => Promise<T>): Promise<T>;
  id(): string;
  ensureIdentity?(tx: AgentSqlExecutor, scope: AgentScopeV1): Promise<void>;
}
export class AgentStoreError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}
export async function queryRows<T>(tx: AgentSqlExecutor, query: SQL): Promise<T[]> {
  const result = await tx.execute(query);
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result && Array.isArray(result.rows)) return result.rows as T[];
  throw new Error("Agent SQL port did not return rows");
}
export interface AgentRunRow {
  id: string; workspace_id: string; user_id: string; identity_id: string; account_epoch: number;
  revision: number; resume_from_revision: number | null; goal: string; status: AgentRunV1["status"]; inputs: AgentInputRefV1[];
  conversation_id: string | null; messages: AgentTurnRequest["messages"];
  summary: string | null; error: string | null; model_calls: number; max_model_calls: number;
  advance_job_id: string | null; advance_lease_token: string | null;
  created_at: Date | string; updated_at: Date | string;
}
export async function readRun(tx: AgentSqlExecutor, scope: AgentScopeV1, id: string, lock = false): Promise<AgentRunRow> {
  const [row] = await queryRows<AgentRunRow>(tx, sql`SELECT * FROM agent_runs
    WHERE id=${id} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
    ${lock ? sql`FOR UPDATE` : sql``}`);
  if (!row) throw new AgentStoreError(404, "run_not_found", "这件事现在读不到。");
  return row;
}
export async function projectRun(tx: AgentSqlExecutor, scope: AgentScopeV1, run: AgentRunRow): Promise<AgentRunV1> {
  const operations = await queryRows<{
    id: string; revision: number; capability: string; job_id: string;
    status: string; last_event_seq: string | number; artifact: unknown; error: string | null;
  }>(tx, sql`SELECT * FROM agent_operations WHERE run_id=${run.id}
    AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId} ORDER BY created_at,id LIMIT 100`);
  const iso = (d: Date | string) => new Date(d).toISOString();
  return agentRunV1Schema.parse({
    version: 1, runId: run.id, identityId: run.identity_id, revision: run.revision, goal: run.goal,
    status: run.status, conversationId: run.conversation_id, inputs: run.inputs,
    operations: operations.filter(o => o.revision === run.revision).map(o => ({
      operationId: o.id, runId: run.id, revision: o.revision, scope, capability: o.capability, jobId: o.job_id,
      status: o.status, lastEventSeq: Number(o.last_event_seq), artifact: o.artifact, error: o.error,
    })),
    artifacts: operations.flatMap(o => o.artifact ? [o.artifact] : []),
    summary: run.summary, error: run.error, modelCalls: run.model_calls, maxModelCalls: run.max_model_calls,
    createdAt: iso(run.created_at), updatedAt: iso(run.updated_at),
  });
}
export async function enqueueAdvance(tx: AgentSqlExecutor, scope: AgentScopeV1, runId: string, revision: number, key: string) {
  await tx.execute(sql`INSERT INTO jobs(type,workspace_id,requested_by,payload,status,priority,resource_class,idempotency_key)
    VALUES('agent_run_advance',${scope.workspaceId},${scope.userId},
      ${JSON.stringify({ runId, revision })}::jsonb,'pending',60,'maintenance',${key})
    ON CONFLICT(workspace_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`);
}
export async function requireVisibleInput(tx: AgentSqlExecutor, scope: AgentScopeV1, input: AgentInputRefV1) {
  const [row] = await queryRows<{ id: string }>(tx, sql`SELECT v.id FROM note_versions v JOIN notes n
    ON n.id=v.note_id AND n.workspace_id=v.workspace_id
    WHERE n.workspace_id=${scope.workspaceId} AND n.id=${input.noteId} AND v.id=${input.noteVersionId}
    AND n.deleted_at IS NULL AND (n.share_scope='shared' OR n.created_by=${scope.userId})`);
  if (!row) throw new AgentStoreError(404, "input_not_found", "这版笔记现在读不到，请重新选择材料。");
}
async function requireAgentAuthority(tx: AgentSqlExecutor, scope: AgentScopeV1) {
  const [identity] = await queryRows<{ id: string; epoch: number; global_enabled: boolean; agent_settings: { permissionLevel?: string } }>(tx,
    sql`SELECT id,epoch,global_enabled,agent_settings FROM user_companion_account_state WHERE user_id=${scope.userId}`);
  if (!identity?.global_enabled) throw new AgentStoreError(403, "agent_disabled", "伴星当前已关闭。");
  if (identity.agent_settings.permissionLevel === "read_only") throw new AgentStoreError(403, "read_only", "当前权限仅允许查看。");
  return identity;
}
async function lockRunQuota(tx: AgentSqlExecutor, scope: AgentScopeV1) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-quota:${scope.workspaceId}:${scope.userId}`},0))`);
}
async function requireRunCapacity(tx: AgentSqlExecutor, scope: AgentScopeV1, currentRunId?: string) {
  const [count] = await queryRows<{ n: string }>(tx, sql`SELECT count(*) AS n FROM agent_runs WHERE workspace_id=${scope.workspaceId}
    AND user_id=${scope.userId} AND status IN ('queued','running','waiting','paused')
    AND ${currentRunId ? sql`id<>${currentRunId}` : sql`TRUE`}`);
  if (Number(count?.n) >= 5) throw new AgentStoreError(429, "run_limit", "先完成或停止一件手边的事，再开始新的目标。");
}
export function createAgentStore(ports: AgentStorePorts) {
  return {
    async create(scope: AgentScopeV1, input: { requestId: string; goal: string; inputs: AgentInputRefV1[]; conversationId?: string }) {
      return ports.transaction(scope, async tx => {
        const [account] = await queryRows(tx, sql`SELECT id FROM user_companion_account_state WHERE user_id=${scope.userId}`);
        if (!account) {
          if (!ports.ensureIdentity) throw new AgentStoreError(403, "identity_not_ready", "请先打开伴星，建立当前账号的伴星身份。");
          await ports.ensureIdentity(tx, scope);
        }
        const identity = await requireAgentAuthority(tx, scope);
        for (const ref of input.inputs) await requireVisibleInput(tx, scope, ref);
        if (input.conversationId) {
          const [conversation] = await queryRows(tx, sql`SELECT id FROM companion_conversations WHERE id=${input.conversationId}
            AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId}`);
          if (!conversation) throw new AgentStoreError(404, "conversation_not_found", "这段对话现在读不到。");
        }
        await lockRunQuota(tx, scope);
        const [existing] = await queryRows<AgentRunRow>(tx, sql`SELECT * FROM agent_runs
          WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId} AND request_id=${input.requestId}`);
        if (existing) {
          if (existing.goal !== input.goal || existing.conversation_id !== (input.conversationId ?? null)
            || canonicalJsonV1(existing.inputs) !== canonicalJsonV1(input.inputs))
            throw new AgentStoreError(409, "request_conflict", "这次请求已有另一份要求，请重新提交。");
          return projectRun(tx, scope, existing);
        }
        await requireRunCapacity(tx, scope);
        const [run] = await queryRows<AgentRunRow>(tx, sql`INSERT INTO agent_runs(workspace_id,user_id,identity_id,account_epoch,
          request_id,conversation_id,goal,inputs) VALUES(${scope.workspaceId},${scope.userId},${identity.id},${identity.epoch},
          ${input.requestId},${input.conversationId ?? null},${input.goal},${JSON.stringify(input.inputs)}::jsonb) RETURNING *`);
        await enqueueAdvance(tx, scope, run.id, run.revision, `agent-start:${run.id}:1`);
        return projectRun(tx, scope, run);
      });
    },
    list(scope: AgentScopeV1) {
      return ports.transaction(scope, async tx => {
        const runs = await queryRows<AgentRunRow>(tx, sql`SELECT * FROM agent_runs WHERE workspace_id=${scope.workspaceId}
          AND user_id=${scope.userId} ORDER BY updated_at DESC,id LIMIT 20`);
        return { version: 1 as const, items: await Promise.all(runs.map(r => projectRun(tx, scope, r))) };
      });
    },
    get(scope: AgentScopeV1, id: string) { return ports.transaction(scope, async tx => projectRun(tx, scope, await readRun(tx, scope, id))); },
    async revise(scope: AgentScopeV1, id: string, expectedRevision: number, goal: string) {
      return ports.transaction(scope, async tx => {
        const old = await readRun(tx, scope, id, true);
        if (old.revision !== expectedRevision) throw new AgentStoreError(409, "revision_conflict", "这件事刚刚更新了，请看最新状态再修改。");
        const identity = await requireAgentAuthority(tx, scope);
        for (const input of old.inputs) await requireVisibleInput(tx, scope, input);
        await lockRunQuota(tx, scope);
        await requireRunCapacity(tx, scope, id);
        await cancelOutstanding(tx, scope, old);
        const [run] = await queryRows<AgentRunRow>(tx, sql`UPDATE agent_runs SET revision=revision+1,goal=${goal},status='queued',
          account_epoch=${identity.epoch},resume_from_revision=NULL,messages='[]',summary=NULL,error=NULL,advance_job_id=NULL,advance_lease_token=NULL,updated_at=now()
          WHERE id=${id} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId} RETURNING *`);
        await enqueueAdvance(tx, scope, id, run.revision, `agent-revise:${id}:${run.revision}`);
        return projectRun(tx, scope, run);
      });
    },
    async control(scope: AgentScopeV1, id: string, expectedRevision: number, action: "cancel" | "pause" | "resume") {
      return ports.transaction(scope, async tx => {
        const old = await readRun(tx, scope, id, true);
        if (old.revision !== expectedRevision) throw new AgentStoreError(409, "revision_conflict", "请先查看这件事的最新状态。");
        if (action === "resume" && old.status !== "paused" && old.status !== "failed") return projectRun(tx, scope, old);
        if (action === "resume") {
          const identity = await requireAgentAuthority(tx, scope);
          if (identity.id !== old.identity_id || identity.epoch !== old.account_epoch)
            throw new AgentStoreError(409, "account_changed", "伴星设置已经改变，请修改要求后重新继续。");
          await lockRunQuota(tx, scope);
          await requireRunCapacity(tx, scope, id);
        }
        if (action !== "resume" && ["completed","cancelled"].includes(old.status)) return projectRun(tx, scope, old);
        const retry = action === "resume" && old.status === "failed";
        if (action === "cancel" || retry) await cancelOutstanding(tx, scope, old);
        const status = action === "cancel" ? "cancelled" : action === "pause" ? "paused" : "queued";
        const [run] = await queryRows<AgentRunRow>(tx, sql`UPDATE agent_runs SET status=${status},error=NULL,
          revision=revision+${retry ? 1 : 0},messages=${retry ? "[]" : JSON.stringify(old.messages)}::jsonb,
          resume_from_revision=${retry ? old.revision : old.resume_from_revision},
          summary=${retry ? null : old.summary},
          advance_job_id=NULL,advance_lease_token=NULL,updated_at=now() WHERE id=${id}
          AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId} RETURNING *`);
        if (action === "resume") await enqueueAdvance(tx, scope, id, run.revision, `agent-resume:${id}:${run.revision}:${ports.id()}`);
        return projectRun(tx, scope, run);
      });
    },
  };
}
async function cancelOutstanding(tx: AgentSqlExecutor, scope: AgentScopeV1, run: AgentRunRow) {
  if (scope.workspaceId !== run.workspace_id || scope.userId !== run.user_id) throw new AgentStoreError(403, "scope_mismatch", "这件事不在当前空间。");
  await tx.execute(sql`SELECT ailearn_cancel_agent_operations(${run.id},${run.revision})`);
}
