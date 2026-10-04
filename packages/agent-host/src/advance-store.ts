import { sql } from "drizzle-orm";
import { reduceOperationReceipt } from "@ailearn/agent-core";
import { agentOperationV1Schema, type AgentScopeV1 } from "@ailearn/shared/agent-contracts";
import { agentTurnResultSchema, type AgentTurnRequest, type AgentTurnResult } from "@ailearn/shared";
import { AgentStoreError, enqueueAdvance, projectRun, queryRows, readRun, requireVisibleInput,
  type AgentRunRow, type AgentSqlExecutor, type AgentStorePorts } from "./store.ts";

export interface AgentAdvanceLease { id: string; workspaceId: string; requestedBy: string | null; leaseToken: string; signal?: AbortSignal }
export interface AgentStepRow { id: string; ordinal: number; context_snapshot: AgentTurnRequest; request_hash: string; response: AgentTurnResult | null; applied: boolean }

export function createAgentAdvanceStore(ports: AgentStorePorts, lease: AgentAdvanceLease, runId: string, revision: number) {
  if (!lease.requestedBy) throw new AgentStoreError(403, "missing_actor", "目标缺少发起人。");
  const scope: AgentScopeV1 = { workspaceId: lease.workspaceId, userId: lease.requestedBy };
  async function fence(tx: AgentSqlExecutor, run: AgentRunRow, receiptsOnly = false) {
    lease.signal?.throwIfAborted();
    const [row] = await queryRows(tx, sql`SELECT j.id FROM jobs j JOIN user_companion_account_state a ON a.id=${run.identity_id}
      WHERE j.id=${lease.id} AND j.workspace_id=${scope.workspaceId} AND j.requested_by=${scope.userId}
      AND j.status='running' AND j.lease_token=${lease.leaseToken} AND a.user_id=${scope.userId}
      AND a.global_enabled AND a.epoch=${run.account_epoch} AND a.agent_settings->>'permissionLevel'<>'read_only'`);
    if (!row || run.revision !== revision || ["cancelled","completed","failed"].includes(run.status)
      || (run.status === "paused" && !receiptsOnly)
      || run.advance_job_id !== lease.id || run.advance_lease_token !== lease.leaseToken)
      throw new AgentStoreError(409, "advance_obsolete", "当前执行已停止或被新的要求替代。");
    for (const input of run.inputs) await requireVisibleInput(tx, scope, input);
  }
  return {
    scope,
    async acquire() {
      return ports.transaction(scope, async tx => {
        const run = await readRun(tx, scope, runId, true);
        if (run.revision !== revision || ["cancelled","completed","failed"].includes(run.status)) return null;
        if (run.advance_job_id && run.advance_job_id !== lease.id) {
          const [active] = await queryRows(tx, sql`SELECT id FROM jobs WHERE id=${run.advance_job_id}
            AND status='running' AND lease_token=${run.advance_lease_token}`);
          if (active) return null;
        }
        run.advance_job_id = lease.id; run.advance_lease_token = lease.leaseToken;
        await fence(tx, run, run.status === "paused");
        await tx.execute(sql`UPDATE agent_runs SET status=${run.status === "paused" ? "paused" : "running"},advance_job_id=${lease.id},
          advance_lease_token=${lease.leaseToken},updated_at=now() WHERE id=${run.id}`);
        await consumeEvents(tx, scope, run);
        return readRun(tx, scope, run.id);
      });
    },
    read() { return ports.transaction(scope, tx => readRun(tx, scope, runId)); },
    async step(request: AgentTurnRequest, hash: string) {
      return ports.transaction(scope, async tx => {
        const run = await readRun(tx, scope, runId, true); await fence(tx, run);
        const [cached] = await queryRows<AgentStepRow>(tx, sql`SELECT * FROM agent_run_steps
          WHERE run_id=${runId} AND revision=${revision} AND applied=false ORDER BY ordinal LIMIT 1`);
        if (cached?.response) return { step: cached, response: agentTurnResultSchema.parse(cached.response) };
        if (run.model_calls >= run.max_model_calls) throw new AgentStoreError(422, "budget_exhausted", "这件事的本轮预算用完了，已做好的内容保留。");
        const [step] = cached ? [cached] : await queryRows<AgentStepRow>(tx, sql`INSERT INTO agent_run_steps
          (run_id,workspace_id,user_id,revision,ordinal,context_snapshot,request_hash)
          VALUES(${runId},${scope.workspaceId},${scope.userId},${revision},
            (SELECT coalesce(max(ordinal),0)+1 FROM agent_run_steps WHERE run_id=${runId} AND revision=${revision}),
            ${JSON.stringify(request)}::jsonb,${hash}) RETURNING *`);
        await tx.execute(sql`UPDATE agent_runs SET model_calls=model_calls+1,updated_at=now() WHERE id=${runId}`);
        return { step, response: null };
      });
    },
    async saveResponse(step: AgentStepRow, response: AgentTurnResult) {
      await ports.transaction(scope, async tx => {
        const run = await readRun(tx, scope, runId, true); await fence(tx, run);
        await tx.execute(sql`UPDATE agent_run_steps SET response=${JSON.stringify(response)}::jsonb WHERE id=${step.id}
          AND run_id=${runId} AND revision=${revision} AND response IS NULL`);
      });
    },
    async applyStep(step: AgentStepRow, response: AgentTurnResult, results: AgentTurnRequest["messages"]) {
      return ports.transaction(scope, async tx => {
        const run = await readRun(tx, scope, runId, true); await fence(tx, run);
        const [unapplied] = await queryRows(tx, sql`UPDATE agent_run_steps SET applied=true
          WHERE id=${step.id} AND run_id=${runId} AND revision=${revision} AND applied=false RETURNING id`);
        if (!unapplied) return "continue" as const;
        const messages = [...run.messages, { role: "assistant" as const, content: response.content ?? "",
          ...(response.toolCalls.length ? { toolCalls: response.toolCalls } : {}),
          ...(response.reasoning ? { reasoning: response.reasoning } : {}) }, ...results];
        await tx.execute(sql`UPDATE agent_runs SET messages=${JSON.stringify(messages)}::jsonb,updated_at=now() WHERE id=${runId}`);
        await consumeEvents(tx, scope, run);
        const projection = await projectRun(tx, scope, await readRun(tx, scope, runId));
        const waiting = projection.operations.some(o => ["accepted","running","outcome_unknown"].includes(o.status));
        const failed = projection.operations.some(o => o.status === "failed" || o.status === "cancelled");
        const settled = response.toolCalls.length === 0;
        const status = waiting ? "waiting" : settled ? failed ? "failed" : "completed" : "running";
        await tx.execute(sql`UPDATE agent_runs SET status=${status},summary=${settled ? (response.content ?? "").slice(0,12000) : run.summary},
          error=${status === "failed" ? "有一部分没做成，已完成的产物保留。" : null},updated_at=now() WHERE id=${runId}`);
        return waiting || settled ? "settled" as const : "continue" as const;
      });
    },
    async invoke<T>(action: (tx: AgentSqlExecutor, run: AgentRunRow) => Promise<T>) {
      return ports.transaction(scope, async tx => { const run = await readRun(tx, scope, runId, true); await fence(tx, run); return action(tx, run); });
    },
    async release(needsAdvance: boolean) {
      await ports.transaction(scope, async tx => {
        const run = await readRun(tx, scope, runId, true);
        if (run.revision !== revision || run.advance_job_id !== lease.id || run.advance_lease_token !== lease.leaseToken) return;
        await tx.execute(sql`UPDATE agent_runs SET advance_job_id=NULL,advance_lease_token=NULL,updated_at=now() WHERE id=${runId}`);
        const [pending] = await queryRows(tx, sql`SELECT seq FROM agent_run_events WHERE run_id=${runId} AND revision=${revision}
          AND processed_at IS NULL AND job_status IN ('succeeded','failed','dead') LIMIT 1`);
        if ((["queued","running","waiting"].includes(run.status) && (needsAdvance || pending))
          || (run.status === "paused" && pending))
          await enqueueAdvance(tx, scope, runId, revision, `agent-handoff:${runId}:${revision}:${lease.id}`);
      });
    },
  };
}

async function consumeEvents(tx: AgentSqlExecutor, scope: AgentScopeV1, run: AgentRunRow) {
  const events = await queryRows<{ seq: string; operation_id: string; job_status: string; revision: number }>(tx,
    sql`SELECT * FROM agent_run_events WHERE run_id=${run.id} AND processed_at IS NULL ORDER BY seq LIMIT 100 FOR UPDATE`);
  for (const event of events) {
    if (event.revision === run.revision) {
      const [op] = await queryRows<{ id: string; job_id: string; capability: string; status: string; revision: number; last_event_seq: string; artifact: unknown; error: string | null }>(tx,
        sql`SELECT * FROM agent_operations WHERE id=${event.operation_id} AND run_id=${run.id}`);
      const current = agentOperationV1Schema.parse({ operationId: op.id, runId: run.id, revision: op.revision, scope,
        jobId: op.job_id, capability: op.capability, status: op.status, lastEventSeq: Number(op.last_event_seq), artifact: op.artifact, error: op.error });
      const [artifact] = await queryRows<{ artifact: unknown }>(tx, sql`SELECT jsonb_build_object('kind','note_overview','id',id,
        'jobId',generation_job_id,'noteId',note_id,'noteVersionId',note_version_id) AS artifact FROM note_overviews WHERE generation_job_id=${op.job_id}
        AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
        UNION ALL SELECT jsonb_build_object('kind','note_dynamic_artifact','id',id,'jobId',generation_job_id,'noteId',note_id,'noteVersionId',note_version_id)
        FROM note_learning_artifacts WHERE generation_job_id=${op.job_id} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId} LIMIT 1`);
      const status = artifact ? "succeeded" : event.job_status === "running" ? "running"
        : event.job_status === "succeeded" ? "outcome_unknown" : ["dead","failed"].includes(event.job_status) ? "failed" : "accepted";
      const reduced = reduceOperationReceipt(current, { ...current, seq: Number(event.seq), status,
        artifact: artifact ? current.artifact ?? agentOperationV1Schema.shape.artifact.parse(artifact.artifact) : null,
        authoritative: true, error: status === "failed" ? "这部分生成没有完成，请核对材料和设置后再试。"
          : status === "outcome_unknown" ? "任务已结束，但产物回执暂时读不到，先不重复生成。" : null });
      if (reduced.accepted) {
        const next = reduced.operation;
        await tx.execute(sql`UPDATE agent_operations SET status=${next.status},last_event_seq=${next.lastEventSeq},
          artifact=${JSON.stringify(next.artifact)}::jsonb,error=${next.error},
          receipt_checks=receipt_checks+${next.status === "outcome_unknown" ? 1 : 0},updated_at=now() WHERE id=${op.id}`);
      }
    }
    await tx.execute(sql`UPDATE agent_run_events SET processed_at=now() WHERE seq=${event.seq}`);
  }
}
