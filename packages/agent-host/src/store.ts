import { sql, type SQL } from "drizzle-orm";
import { DomainError } from "@ailearn/shared";
import { agentRunV1Schema, type AgentRunV1, type AgentScopeV1, type AgentInputRefV1, type AgentRunHistoryV1 } from "@ailearn/shared/agent-contracts";
import type { AgentTurnRequest } from "@ailearn/shared";
import { canonicalJsonV1 } from "@ailearn/shared/content-hash";
import {
  agentHistoryRevisionWindow, archiveSupersededRunRevision, decodeAgentRunListCursor,
  encodeAgentRunListCursor, projectAgentRunHistoryV1,
  resolveAgentHistoryLimit, resolveAgentRunListLimit,
  type AgentOperationRow, type AgentRevisionRow,
} from "./history.ts";

export interface AgentSqlExecutor { execute(query: SQL): Promise<unknown> }
/**
 * `Tx` 是宿主**真实**的事务类型（worker 是 `WorkerTransaction`，API 是
 * `ApiTransaction`），默认窄端口只够现有 SQL。回调里拿到的仍是宿主当前那一段事务：
 * 这里只保留类型，不新建、不包装，也不开第二个没有围栏的事务。
 */
export interface AgentStorePorts<Tx extends AgentSqlExecutor = AgentSqlExecutor> {
  transaction<T>(scope: AgentScopeV1, action: (tx: Tx) => Promise<T>): Promise<T>;
  id(): string;
  ensureIdentity?(tx: AgentSqlExecutor, scope: AgentScopeV1): Promise<void>;
}
/**
 * 领域错误：形状与所有调用点不变（`statusCode` / `code` / `message`），
 * 只是改挂在 shared 的 `DomainError` 上，让 `asDomainError` 认得出这一族。
 */
export class AgentStoreError extends DomainError {
  constructor(statusCode: number, code: string, message: string) {
    super({ name: "AgentStoreError", statusCode, code, message });
  }
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
  revision_started_at: Date | string | null;
  created_at: Date | string; updated_at: Date | string;
}
export async function readRun(tx: AgentSqlExecutor, scope: AgentScopeV1, id: string, lock = false): Promise<AgentRunRow> {
  const [row] = await queryRows<AgentRunRow>(tx, sql`SELECT * FROM agent_runs
    WHERE id=${id} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
    ${lock ? sql`FOR UPDATE` : sql``}`);
  if (!row) throw new AgentStoreError(404, "run_not_found", "这件事现在读不到。");
  return row;
}
/** 一次读完一页目标的操作行（每目标仍按 created_at,id 保留前 100 条）。 */
export async function readRunOperations(
  tx: AgentSqlExecutor, scope: AgentScopeV1, runIds: string[],
): Promise<Map<string, AgentOperationRow[]>> {
  const grouped = new Map<string, AgentOperationRow[]>();
  if (runIds.length === 0) return grouped;
  const ids = sql.join(runIds.map(id => sql`${id}::uuid`), sql`, `);
  const rows = await queryRows<AgentOperationRow>(tx, sql`SELECT * FROM agent_operations
    WHERE run_id IN (${ids}) AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
    ORDER BY run_id,created_at,id LIMIT ${runIds.length * 100}`);
  for (const row of rows) {
    const key = row.run_id ?? runIds[0]!;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(row); else grouped.set(key, [row]);
  }
  return grouped;
}
export function projectRunFromOperations(
  scope: AgentScopeV1, run: AgentRunRow, operations: AgentOperationRow[],
): AgentRunV1 {
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
export async function projectRun(tx: AgentSqlExecutor, scope: AgentScopeV1, run: AgentRunRow): Promise<AgentRunV1> {
  const grouped = await readRunOperations(tx, scope, [run.id]);
  return projectRunFromOperations(scope, run, grouped.get(run.id) ?? []);
}
/**
 * 读一个目标的版本历史。锁住 run 行：历史由「当前版 + 多条存档」拼成，
 * 中途被一次 revise 提交就会混版。
 */
export async function readRunHistory(
  tx: AgentSqlExecutor, scope: AgentScopeV1, run: AgentRunRow,
  query: { topRevision: number; limit: number },
): Promise<AgentRunHistoryV1> {
  const includeCurrent = query.topRevision >= run.revision;
  const window = agentHistoryRevisionWindow(query.topRevision, query.limit);
  const ceiling = includeCurrent ? run.revision - 1 : window.top;
  const archivedLimit = includeCurrent ? query.limit - 1 : query.limit;
  // 窗口要有下界：只加上界时，一页里的未存档号会把更早页的存档也捞进来，
  // 同一版在两页里各出现一次。列清单写死，不用 `SELECT *`——
  // to_char 别名与原列同名，重复输出列名取哪一个由驱动决定。
  const recorded = archivedLimit > 0 && window.bottom <= ceiling ? await queryRows<AgentRevisionRow>(tx, sql`
    SELECT revision,goal,status,conversation_id,inputs,summary,error,model_calls,max_model_calls,superseded_by_revision,
      to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at,
      to_char(last_active_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_active_at,
      to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at
    FROM agent_run_revisions WHERE run_id=${run.id}
      AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
      AND revision BETWEEN ${window.bottom} AND ${ceiling} ORDER BY revision DESC LIMIT ${archivedLimit}`) : [];
  const [clock] = await queryRows<{ started_at: string | null; last_active_at: string }>(tx, sql`
    SELECT to_char(revision_started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at,
      to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_active_at
    FROM agent_runs WHERE id=${run.id} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId}`);
  const grouped = await readRunOperations(tx, scope, [run.id]);
  return projectAgentRunHistoryV1({
    scope, runId: run.id, currentRevision: run.revision, topRevision: query.topRevision, limit: query.limit,
    current: {
      scope, goal: run.goal, status: run.status, conversationId: run.conversation_id, inputs: run.inputs,
      summary: run.summary, error: run.error, modelCalls: run.model_calls, maxModelCalls: run.max_model_calls,
      startedAt: clock?.started_at ?? null, lastActiveAt: clock?.last_active_at ?? new Date(run.updated_at).toISOString(),
    },
    recorded, operations: grouped.get(run.id) ?? [],
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
export function createAgentStore<Tx extends AgentSqlExecutor = AgentSqlExecutor>(ports: AgentStorePorts<Tx>) {
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
    /**
     * 更早的历史页。默认 20、最多 50，(updated_at, id) 双字段 keyset：
     * 时间相同由 id 兜住全序，翻页途中状态更新也不会让一页凭空多一条少一条。
     * 它是**位置书签**而非快照：一页在走读期间被推进，它会移到游标之前
     * （本次读不到），但历史不删已完成成果，它仍在第一页里读得到。
     */
    list(scope: AgentScopeV1, query: { limit?: unknown; cursor?: string } = {}) {
      return ports.transaction(scope, async tx => {
        const limit = resolveAgentRunListLimit(query.limit);
        const cursor = query.cursor === undefined ? null : decodeAgentRunListCursor(query.cursor, scope);
        if (query.cursor !== undefined && !cursor)
          throw new AgentStoreError(400, "invalid_cursor", "这个位置已经读不到了，请从头再看一次。");
        const rows = await queryRows<AgentRunRow & { cursor_updated_at: string }>(tx, sql`
          SELECT *,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_updated_at
          FROM agent_runs WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
          ${cursor ? sql`AND (updated_at,id) < (${cursor.updatedAt}::timestamptz,${cursor.runId}::uuid)` : sql``}
          ORDER BY updated_at DESC,id DESC LIMIT ${limit + 1}`);
        const page = rows.slice(0, limit);
        const grouped = await readRunOperations(tx, scope, page.map(r => r.id));
        const last = page[page.length - 1];
        return {
          version: 1 as const,
          items: page.map(r => projectRunFromOperations(scope, r, grouped.get(r.id) ?? [])),
          nextCursor: rows.length > limit && last
            ? encodeAgentRunListCursor(scope, { updatedAt: last.cursor_updated_at, runId: last.id })
            : null,
        };
      });
    },
    get(scope: AgentScopeV1, id: string) { return ports.transaction(scope, async tx => projectRun(tx, scope, await readRun(tx, scope, id))); },
    /** 读一个目标的版本历史；`beforeRevision` 含边界，跨用户/跨空间与 get 一样读不到。 */
    history(scope: AgentScopeV1, id: string, query: { limit?: unknown; beforeRevision?: number } = {}) {
      return ports.transaction(scope, async tx => {
        const run = await readRun(tx, scope, id, true);
        const limit = resolveAgentHistoryLimit(query.limit);
        const before = query.beforeRevision;
        if (before !== undefined && (!Number.isInteger(before) || before < 1))
          throw new AgentStoreError(400, "invalid_cursor", "这个位置已经读不到了，请从头再看一次。");
        // 指向比当前版更新的游标是废游标（目标已经往前走了）；等于当前版按第一页读。
        if (before !== undefined && before > run.revision)
          throw new AgentStoreError(400, "invalid_cursor", "这个位置已经读不到了，请从头再看一次。");
        return readRunHistory(tx, scope, run, { topRevision: before ?? run.revision, limit });
      });
    },
    async revise(scope: AgentScopeV1, id: string, expectedRevision: number, goal: string) {
      return ports.transaction(scope, async tx => {
        const old = await readRun(tx, scope, id, true);
        // CAS 先判：失败时一行都不写，历史也不会多出一条。
        if (old.revision !== expectedRevision) throw new AgentStoreError(409, "revision_conflict", "这件事刚刚更新了，请看最新状态再修改。");
        const identity = await requireAgentAuthority(tx, scope);
        for (const input of old.inputs) await requireVisibleInput(tx, scope, input);
        await lockRunQuota(tx, scope);
        await requireRunCapacity(tx, scope, id);
        await cancelOutstanding(tx, scope, old);
        const [run] = await queryRows<AgentRunRow>(tx, sql`UPDATE agent_runs SET revision=revision+1,goal=${goal},status='queued',
          account_epoch=${identity.epoch},resume_from_revision=NULL,messages='[]',summary=NULL,error=NULL,advance_job_id=NULL,
          advance_lease_token=NULL,revision_started_at=now(),updated_at=now()
          WHERE id=${id} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId} RETURNING *`);
        if (!run) throw new AgentStoreError(409, "revision_conflict", "这件事刚刚更新了，请看最新状态再修改。");
        // 旧要求与旧结果先原样存档，再推进到新一版：同一个事务，要么都成立。
        await archiveSupersededRunRevision(tx, old, run.revision);
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
          revision_started_at=${retry ? sql`now()` : sql`revision_started_at`},
          advance_job_id=NULL,advance_lease_token=NULL,updated_at=now() WHERE id=${id}
          AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId} RETURNING *`);
        if (!run) throw new AgentStoreError(409, "revision_conflict", "请先查看这件事的最新状态。");
        // 只有「失败后换一次继续」才换版本；暂停/恢复同一版不制造新的要求。
        if (retry) await archiveSupersededRunRevision(tx, old, run.revision);
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
