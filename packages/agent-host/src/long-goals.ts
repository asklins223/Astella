import { sql } from "drizzle-orm";
import { z } from "zod";
import { agentLongGoalRefV1Schema, agentRunListCursorV1Schema, type AgentScopeV1 } from "@astella/shared/agent-contracts";
import { agentLongGoalsQueryV1Schema, agentLongGoalsV1Schema, type AgentLongGoalsQueryV1 } from "@astella/shared/agent-long-goal-contracts";
import { sha256Utf8V1 } from "@astella/shared/content-hash";
import { AgentStoreError, queryRows, type AgentSqlExecutor } from "./store.ts";

const validGoal = sql`kind='goal' AND user_confirmed AND deleted_at IS NULL
  AND dismissed_at IS NULL AND archived_at IS NULL AND budget_tier<>'archived'
  AND epistemic_status NOT IN ('disputed','superseded')
  AND (valid_from IS NULL OR valid_from<=now()) AND (valid_until IS NULL OR valid_until>now())`;
const cursorSchema = agentRunListCursorV1Schema.omit({ longGoalMemoryId: true }).extend({ fingerprint: z.string().length(64) });
interface GoalRow { id: string; revision: number; content: string; applies_when: string | null; updated_at: string | Date; cursor_updated_at: string }

export async function requireAgentLongGoal(tx: AgentSqlExecutor, scope: AgentScopeV1, ref: z.infer<typeof agentLongGoalRefV1Schema>) {
  const [goal] = await queryRows<GoalRow>(tx, sql`SELECT id,revision,content,applies_when,updated_at FROM assistant_memory_items
    WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId} AND id=${ref.memoryId}
      AND revision=${ref.revision} AND scope='workspace' AND ${validGoal} FOR SHARE`);
  if (!goal) throw new AgentStoreError(409, "long_goal_changed", "长期目标的依据已改变或停用，请先核对当前目标。已做好的内容保留。");
  return goal;
}

/** The directory is bounded; complete task records remain in the paged run store. */
export async function listAgentLongGoals(tx: AgentSqlExecutor, scope: AgentScopeV1, input: AgentLongGoalsQueryV1 = {}) {
  const query = agentLongGoalsQueryV1Schema.parse(input);
  const text = (query.query ?? "").toLowerCase();
  const fingerprint = sha256Utf8V1(JSON.stringify([text, query.memoryId ?? null]));
  let cursor: z.infer<typeof cursorSchema> | null = null;
  if (query.cursor) {
    try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"))); }
    catch { throw new AgentStoreError(400, "invalid_cursor", "请从长期目标清单重新翻找。"); }
    if (cursor.workspaceId !== scope.workspaceId || cursor.userId !== scope.userId || cursor.fingerprint !== fingerprint)
      throw new AgentStoreError(400, "invalid_cursor", "这个翻页位置不属于当前目标清单。");
  }
  const rows = await queryRows<GoalRow>(tx, sql`SELECT id,revision,content,applies_when,updated_at,
    to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_updated_at
    FROM assistant_memory_items WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
      AND scope='workspace' AND ${validGoal}
      ${text ? sql`AND strpos(lower(concat_ws(' ',content,applies_when)),${text})>0` : sql``}
      ${query.memoryId ? sql`AND id=${query.memoryId}` : sql``}
      ${cursor ? sql`AND (updated_at,id)<(${cursor.updatedAt}::timestamptz,${cursor.runId}::uuid)` : sql``}
    ORDER BY updated_at DESC,id DESC LIMIT ${query.limit + 1}`);
  const goals = rows.slice(0, query.limit);
  const tasks = goals.length ? await queryRows<{ id: string; revision: number; goal: string; status: string;
    updated_at: string | Date; task_count: string | number; long_goal_ref: { memoryId: string; revision: number } }>(tx, sql`
    SELECT * FROM (SELECT id,revision,left(goal,400) AS goal,status,updated_at,long_goal_ref,
      count(*) OVER(PARTITION BY long_goal_ref->>'memoryId') AS task_count,
      row_number() OVER(PARTITION BY long_goal_ref->>'memoryId' ORDER BY updated_at DESC,id DESC) AS position
      FROM agent_runs WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
        AND long_goal_ref->>'memoryId' IN (${sql.join(goals.map(goal => sql`${goal.id}`), sql`, `)})) scoped
    WHERE position<=5 ORDER BY updated_at DESC,id DESC`) : [];
  const last = goals.at(-1);
  const nextCursor = rows.length > query.limit && last ? Buffer.from(JSON.stringify(cursorSchema.parse({
    version: 1, ...scope, updatedAt: last.cursor_updated_at, runId: last.id, fingerprint,
  })), "utf8").toString("base64url") : null;
  return agentLongGoalsV1Schema.parse({ version: 1, nextCursor, items: goals.map(goal => {
    const recent = tasks.filter(task => task.long_goal_ref.memoryId === goal.id);
    return { ref: { memoryId: goal.id, revision: goal.revision }, content: goal.content,
      appliesWhen: goal.applies_when, updatedAt: new Date(goal.updated_at).toISOString(),
      taskCount: Number(recent[0]?.task_count ?? 0),
      tasks: recent.map(task => ({ runId: task.id, revision: task.revision, goalRevision: task.long_goal_ref.revision,
        goal: task.goal, status: task.status, summary: null, updatedAt: new Date(task.updated_at).toISOString() })),
    };
  }) });
}
