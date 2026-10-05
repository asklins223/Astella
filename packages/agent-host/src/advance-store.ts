import { sql } from "drizzle-orm";
import { reduceOperationReceipt, validateAgentGoalDelivery } from "@ailearn/agent-core";
import { AGENT_GOAL_DELIVERY_CAPABILITY, type AgentOperationStatusV1, type AgentScopeV1 } from "@ailearn/shared/agent-contracts";
import { agentTurnResultSchema, type AgentTurnRequest, type AgentTurnResult } from "@ailearn/shared";
import { readOperationResultReceipt } from "./operation-receipt.ts";
import { projectAgentOperation, type AgentOperationRow } from "./history.ts";
import { requireAgentLongGoal } from "./long-goals.ts";
import { AgentStoreError, enqueueAdvance, projectRun, queryRows, readRun, requireVisibleInput,
  type AgentRunRow, type AgentSqlExecutor, type AgentStorePorts } from "./store.ts";

export interface AgentAdvanceLease { id: string; workspaceId: string; requestedBy: string | null; leaseToken: string; signal?: AbortSignal }
export interface AgentStepRow { id: string; ordinal: number; context_snapshot: AgentTurnRequest; request_hash: string; response: AgentTurnResult | null; applied: boolean }

/**
 * 工厂返回值的具名形状。`Tx` 保留 ports 里的真实事务类型，`invoke` 回调拿到的就是
 * 它；用 `ReturnType<typeof createAgentAdvanceStore>` 会退回默认窄口，擦掉事务类型，
 * 所以调用者要显式用它。
 */
export type AgentAdvanceStore<Tx extends AgentSqlExecutor = AgentSqlExecutor> =
  ReturnType<typeof createAgentAdvanceStore<Tx>>;

export function createAgentAdvanceStore<Tx extends AgentSqlExecutor = AgentSqlExecutor>(
  ports: AgentStorePorts<Tx>, lease: AgentAdvanceLease, runId: string, revision: number,
) {
  if (!lease.requestedBy) throw new AgentStoreError(403, "missing_actor", "目标缺少发起人。");
  const scope: AgentScopeV1 = { workspaceId: lease.workspaceId, userId: lease.requestedBy };
  async function fence(tx: AgentSqlExecutor, run: AgentRunRow, receiptsOnly = false) {
    lease.signal?.throwIfAborted();
    const [row] = await queryRows(tx, sql`SELECT j.id FROM jobs j JOIN user_companion_account_state a ON a.id=${run.identity_id}
      WHERE j.id=${lease.id} AND j.workspace_id=${scope.workspaceId} AND j.requested_by=${scope.userId}
      AND j.status='running' AND j.lease_token=${lease.leaseToken} AND a.user_id=${scope.userId}
      AND public.ailearn_agent_run_authorized(${run.id})`);
    if (!row || run.revision !== revision || ["cancelled","completed","failed"].includes(run.status)
      || (run.status === "paused" && !receiptsOnly)
      || run.advance_job_id !== lease.id || run.advance_lease_token !== lease.leaseToken)
      throw new AgentStoreError(409, "advance_obsolete", "当前执行已停止或被新的要求替代。");
    for (const input of run.inputs) await requireVisibleInput(tx, scope, input);
    if (!receiptsOnly && run.long_goal_ref) await requireAgentLongGoal(tx, scope, run.long_goal_ref);
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
        await fence(tx, run, true);
        await tx.execute(sql`UPDATE agent_runs SET status=${run.status === "paused" ? "paused" : "running"},advance_job_id=${lease.id},
          advance_lease_token=${lease.leaseToken},updated_at=now() WHERE id=${run.id}`);
        await consumeEvents(tx, scope, run);
        return readRun(tx, scope, run.id);
      });
    },
    read() { return ports.transaction(scope, tx => readRun(tx, scope, runId)); },
    async step(request: AgentTurnRequest, hash: string, executionKind: "model" | "declared_request" = "model") {
      return ports.transaction(scope, async tx => {
        const run = await readRun(tx, scope, runId, true); await fence(tx, run);
        const [cached] = await queryRows<AgentStepRow>(tx, sql`SELECT * FROM agent_run_steps
          WHERE run_id=${runId} AND revision=${revision} AND applied=false ORDER BY ordinal LIMIT 1`);
        if (cached?.response) return { step: cached, response: agentTurnResultSchema.parse(cached.response) };
        if (executionKind === "model" && run.model_calls >= run.max_model_calls) throw new AgentStoreError(422, "budget_exhausted", "这件事的本轮预算用完了，已做好的内容保留。");
        const [step] = cached ? [cached] : await queryRows<AgentStepRow>(tx, sql`INSERT INTO agent_run_steps
          (run_id,workspace_id,user_id,revision,ordinal,context_snapshot,request_hash,execution_kind)
          VALUES(${runId},${scope.workspaceId},${scope.userId},${revision},
            (SELECT coalesce(max(ordinal),0)+1 FROM agent_run_steps WHERE run_id=${runId} AND revision=${revision}),
            ${JSON.stringify(request)}::jsonb,${hash},${executionKind}) RETURNING *`);
        if (executionKind === "model") await tx.execute(sql`UPDATE agent_runs SET model_calls=model_calls+1,updated_at=now() WHERE id=${runId}`);
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
        await consumeEvents(tx, scope, run);
        const projection = await projectRun(tx, scope, await readRun(tx, scope, runId));
        const waiting = projection.operations.some(o => ["accepted","running","outcome_unknown"].includes(o.status));
        const declarations = response.toolCalls.filter(call => call.name === AGENT_GOAL_DELIVERY_CAPABILITY);
        const validation = declarations.length === 1
          ? validateAgentGoalDelivery(messages, projection.operations, declarations[0]!.id)
          : { delivery: null, error: declarations.length > 1 ? "每步只能提交一份交付说明。" : null };
        for (const message of messages) {
          if (message.role !== "tool" || !declarations.some(call => call.id === message.toolCallId)) continue;
          message.content = JSON.stringify(validation.delivery
            ? { status: "succeeded", kind: "goal_delivery", delivery: validation.delivery }
            : { status: "failed", error: validation.error });
        }
        const unansweredTwice = response.toolCalls.length === 0 && run.messages
          .filter(message => message.role === "assistant").slice(-1).some(message => !message.toolCalls?.length);
        const delivery = validation.delivery;
        const status = delivery ? delivery.outcome === "needs_input" ? "paused" : delivery.outcome === "completed" ? "completed" : "failed"
          : waiting ? "waiting" : unansweredTwice ? "failed" : "running";
        const error = status === "paused" ? "需要补充或确认后再继续，已完成的内容保留。"
          : status === "failed" ? unansweredTwice ? "这次没有取得可核验的交付，已有成果保留。" : "有一部分没做成，已完成的产物保留。" : null;
        await tx.execute(sql`UPDATE agent_runs SET status=${status},messages=${JSON.stringify(messages)}::jsonb,
          summary=${delivery?.summary ?? run.summary},error=${error},updated_at=now() WHERE id=${runId}`);
        return waiting || delivery || unansweredTwice ? "settled" as const : "continue" as const;
      });
    },
    async invoke<T>(action: (tx: Tx, run: AgentRunRow) => Promise<T>) {
      return ports.transaction(scope, async tx => { const run = await readRun(tx, scope, runId, true); await fence(tx, run); return action(tx, run); });
    },
    async pauseForChangedLongGoal(reason: string) {
      await ports.transaction(scope, async tx => {
        const run = await readRun(tx, scope, runId, true);
        await fence(tx, run, true);
        await tx.execute(sql`UPDATE agent_runs SET status='paused',error=${reason},updated_at=now() WHERE id=${runId}`);
      });
    },
    async release(needsAdvance: boolean) {
      await ports.transaction(scope, async tx => {
        const run = await readRun(tx, scope, runId, true);
        if (run.revision !== revision || run.advance_job_id !== lease.id || run.advance_lease_token !== lease.leaseToken) return;
        await tx.execute(sql`UPDATE agent_runs SET advance_job_id=NULL,advance_lease_token=NULL,updated_at=now() WHERE id=${runId}`);
        const [pending] = await queryRows(tx, sql`SELECT seq FROM agent_run_events WHERE run_id=${runId} AND revision=${revision}
          AND processed_at IS NULL AND execution_status IN ('succeeded','failed','dead') LIMIT 1`);
        if ((["queued","running","waiting"].includes(run.status) && (needsAdvance || pending))
          || (run.status === "paused" && pending))
          await enqueueAdvance(tx, scope, runId, revision, `agent-handoff:${runId}:${revision}:${lease.id}`);
      });
    },
  };
}

/** 领域事实不足以定性时，执行体状态决定落哪一档。 */
function executionStatusFor(raw: string): AgentOperationStatusV1 {
  if (raw === "running") return "running";
  if (["dead", "failed", "cancelled"].includes(raw)) return "failed";
  if (raw === "succeeded") return "outcome_unknown";
  return "accepted";
}

async function consumeEvents(tx: AgentSqlExecutor, scope: AgentScopeV1, run: AgentRunRow) {
  const events = await queryRows<{ seq: string; operation_id: string; execution_status: string; revision: number }>(tx,
    sql`SELECT * FROM agent_run_events WHERE run_id=${run.id} AND processed_at IS NULL ORDER BY seq LIMIT 100 FOR UPDATE`);
  for (const event of events) {
    if (event.revision === run.revision) {
      const [op] = await queryRows<AgentOperationRow>(tx,
        sql`SELECT * FROM agent_operations WHERE id=${event.operation_id} AND run_id=${run.id}`);
      if (op) {
        const current = projectAgentOperation(scope, run.id, op);
        // 读不到领域事实就停在 outcome_unknown，即使执行体报了结束。
        const receipt = await readOperationResultReceipt(tx, {
          capability: current.capability, execution: current.execution, scope, inputs: run.inputs,
        });
        const status = receipt.kind === "result" ? "succeeded"
          : receipt.kind === "failed" ? "failed"
          : executionStatusFor(event.execution_status);
        const reduced = reduceOperationReceipt(current, { ...current, seq: Number(event.seq), status,
          result: receipt.kind === "result" ? current.result ?? receipt.result : null,
          authoritative: true, error: status === "failed" ? "这部分生成没有完成，请核对材料和设置后再试。"
            : status === "outcome_unknown" ? "任务已结束，但成果回执暂时读不到，先不重复生成。" : null });
        if (reduced.accepted) {
          const next = reduced.operation;
          // 直接传值：JSON.stringify(null) 是 JSON 字面量而不是 SQL NULL。
          await tx.execute(sql`UPDATE agent_operations SET status=${next.status},last_event_seq=${next.lastEventSeq},
            result=${next.result === null ? null : JSON.stringify(next.result)}::jsonb,error=${next.error},
            receipt_checks=receipt_checks+${next.status === "outcome_unknown" ? 1 : 0},updated_at=now() WHERE id=${op.id}`);
        }
      }
    }
    await tx.execute(sql`UPDATE agent_run_events SET processed_at=now() WHERE seq=${event.seq}`);
  }
}
