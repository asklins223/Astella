/** 只绑定初始 outbox；锁顺序为 parent → card run → outbox。 */
import { sql } from "drizzle-orm";
import { AgentStoreError, queryRows, type AgentSqlExecutor } from "@astella/agent-host";
import type { AgentScopeV1 } from "@astella/shared/agent-contracts";
import { withWorkerWorkspaceTransaction, type WorkerTransaction } from "../db.ts";
import { CardGenerationProviderError } from "../card-generation-v2/governed-provider.ts";
import {
  renewV2OutboxLease,
  renewV2OutboxLeaseInTransaction,
  type PendingOutboxJob,
} from "../card-generation-v2/outbox-queue.ts";
import type { AgentExecutionBindingPorts } from "../agent/execution-context.ts";

export interface AgentCardExecutionBinding {
  operationId: string;
  agentRunId: string;
  revision: number;
  /** 目标的发起人；与制卡 run 的 user_id 逐字核对过。 */
  userId: string;
}

export interface AgentCardExecution {
  binding: AgentCardExecutionBinding | null;
}

const executionCache = new WeakMap<PendingOutboxJob, Promise<AgentCardExecution>>();

export function resolveAgentCardExecution(job: PendingOutboxJob): Promise<AgentCardExecution> {
  const cached = executionCache.get(job);
  if (cached) return cached;
  const pending = (async (): Promise<AgentCardExecution> => {
    // 受控函数只读固定绑定，成员资格与 revision 的变化交给 current 围栏。
    const rows = await withWorkerWorkspaceTransaction(
      { workspaceId: job.workspaceId, userId: null },
      tx => queryRows<{ operation_id: string; agent_run_id: string; revision: number; user_id: string }>(tx,
        sql`SELECT * FROM astella_agent_card_execution_binding(${job.id},${job.workspaceId})`),
      { isolated: true },
    );
    const row = rows[0];
    return { binding: row ? { operationId: row.operation_id, agentRunId: row.agent_run_id,
      revision: Number(row.revision), userId: row.user_id } : null };
  })();
  executionCache.set(job, pending);
  return pending;
}

/** 父围栏判定。`lock=true` 由 SQL 函数先锁 Agent run 再锁制卡 run，与取消同序；
 * `lock=false` 用于记账前那次核验。未绑定的 outbox 恒返回 true，否则普通制卡会被
 * 自己的围栏挡住。 */
export async function agentCardJobCurrent(
  tx: AgentSqlExecutor, job: PendingOutboxJob, lock: boolean,
): Promise<boolean> {
  const [row] = await queryRows<{ current: boolean }>(tx,
    sql`SELECT astella_agent_card_job_current(${job.id},${job.workspaceId},${lock}) AS current`);
  return row?.current === true;
}

/** `execution-context.ts` 用的两个端口：归属读取 + 每次调用前的围栏判定。 */
export function agentCardExecutionPorts(
  job: PendingOutboxJob, binding: AgentCardExecutionBinding,
): AgentExecutionBindingPorts {
  const scope: AgentScopeV1 = { workspaceId: job.workspaceId, userId: binding.userId };
  return {
    async bind(tx) {
      const [row] = await queryRows<{ id: string; revision: number; goal: string }>(tx,
        sql`SELECT r.id, o.revision, r.goal FROM public.agent_operations o
              JOIN public.agent_runs r ON r.id = o.run_id
            WHERE o.id = ${binding.operationId} AND o.workspace_id = ${scope.workspaceId}
              AND o.user_id = ${scope.userId} AND o.revision = r.revision`);
      if (!row || row.id !== binding.agentRunId || Number(row.revision) !== binding.revision)
        throw new AgentStoreError(409, "advance_obsolete", "这次生成已经停止或被新的要求替代。");
      return { runId: row.id, revision: Number(row.revision), goal: row.goal };
    },
    async isCurrent(tx) { return agentCardJobCurrent(tx, job, false); },
    /** 紧贴 provider 请求的最后一道租约围栏：租约没了就中止，不替没人认领的批次付钱。 */
    async assertExecutionFence() {
      if (!await renewV2OutboxLease(job.id, job.leaseToken)) {
        throw new AgentStoreError(409, "advance_obsolete", "这批学习卡的生成已经被停止。");
      }
    },
    async chargeCall(tx: AgentSqlExecutor) {
      if (!await renewV2OutboxLeaseInTransaction(tx, job)) {
        throw new AgentStoreError(409, "advance_obsolete", "这批学习卡的生成已经被停止。");
      }
    },
  };
}

/** V3 每段短事务的统一入口：先判父围栏（p_lock=true，先锁 Agent run），再跑这一段
 * 原有读写；段内原有的收尾照旧 `fenceV2OutboxLease`。 */
export function withAgentCardJobTransaction<T>(
  job: PendingOutboxJob,
  execution: AgentCardExecution,
  action: (tx: WorkerTransaction) => Promise<T>,
): Promise<T> {
  return withWorkerWorkspaceTransaction({ workspaceId: job.workspaceId, userId: null }, async (tx) => {
    if (execution.binding && !(await agentCardJobCurrent(tx, job, true))) {
      // 不可重试：父目标已被取消／修订／失去资格，再跑下去只是替一件已经不被需要的
      // 事继续花钱。领域 run 在取消时已落终态，`failV2OutboxJob` 的来源状态集合
      // 不会再把它改成 needs_attention。
      throw new CardGenerationProviderError(
        "non-retryable",
        `agent 目标已停止（run ${execution.binding?.agentRunId ?? "-"} revision ${execution.binding?.revision ?? "-"}）`,
      );
    }
    return action(tx);
  }, { isolated: true });
}
