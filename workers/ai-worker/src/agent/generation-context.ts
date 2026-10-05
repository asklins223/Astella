import { sql } from "drizzle-orm";
import { queryRows, AgentStoreError } from "@ailearn/agent-host";
import type { JobPayload } from "../handlers/index.ts";
import { loadAgentExecutionContext } from "./execution-context.ts";

/** note job 的绑定与围栏端口；页面发起的生成不计入 Agent 预算。 */
export async function loadAgentGenerationContext(job: JobPayload) {
  if (!job.requestedBy) throw new AgentStoreError(403, "missing_actor", "任务缺少发起人。");
  const scope = { workspaceId: job.workspaceId, userId: job.requestedBy };
  return loadAgentExecutionContext(scope, {
    async bind(tx) {
      const [run] = await queryRows<{ id: string; goal: string; revision: number }>(tx, sql`
        SELECT r.id,r.goal,r.revision FROM agent_operations o JOIN agent_runs r ON r.id=o.run_id
        WHERE o.job_id=${job.id} AND o.workspace_id=${scope.workspaceId} AND o.user_id=${scope.userId} AND o.revision=r.revision`);
      if (job.payload.agentRunId && (!run || run.id !== job.payload.agentRunId || run.revision !== Number(job.payload.agentRevision)))
        throw new AgentStoreError(409, "advance_obsolete", "这次生成已经被新的要求替代。");
      return run ? { runId: run.id, revision: run.revision, goal: run.goal } : null;
    },
    async isCurrent(tx) {
      const [allowed] = await queryRows<{ allowed: boolean }>(tx,
        sql`SELECT ailearn_agent_job_current(${job.id},${scope.workspaceId},${scope.userId},false) AS allowed`);
      return allowed?.allowed === true;
    },
    // note job 的租约由队列内核在 handler 入口核过（`assertJobLease`），模型调用
    // 在同一把租约下进行；父围栏那一道已经足够，不在这里再叠一层形状不同的检查。
    async assertExecutionFence() {},
  }, job.signal);
}
