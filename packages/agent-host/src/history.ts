import { sql, type SQL } from "drizzle-orm";
import {
  AGENT_RUN_HISTORY_DEFAULT_LIMIT, AGENT_RUN_HISTORY_MAX_LIMIT,
  AGENT_RUN_LIST_DEFAULT_LIMIT, AGENT_RUN_LIST_MAX_LIMIT,
  agentOperationResultV1Schema, agentOperationV1Schema,
  agentRunHistoryV1Schema, agentRunRevisionV1Schema,
  agentRunListCursorV1Schema,
  type AgentArtifactRefV1, type AgentExecutionRefV1, type AgentOperationResultV1, type AgentOperationV1,
  type AgentRunHistoryV1, type AgentRunRevisionV1, type AgentScopeV1,
} from "@astella/shared/agent-contracts";

/** 目标历史的策略层：游标编解码、页长、历史项形状。取数与事务边界在 store.ts。 */

/** agent_run_revisions 的写入只需要一个能执行 SQL 的句柄。 */
export interface AgentHistoryExecutor { execute(query: SQL): Promise<unknown> }

/** agent_operations 一行；执行体三列互斥（XOR 由 0373 的 CHECK 保证）。 */
export interface AgentOperationRow {
  id: string; revision: number; capability: string;
  job_id: string | null; card_generation_run_id: string | null; card_generation_outbox_id: string | null;
  status: string; last_event_seq: string | number; result: unknown; error: string | null;
  run_id?: string; created_at?: string | Date;
}

/** 三列 → 一次执行体；三列全空不是一种执行体（由 CHECK 挡住，这里不猜）。 */
export function agentExecutionRefFromRow(row: AgentOperationRow): AgentExecutionRefV1 {
  if (row.job_id) return { kind: "job", id: row.job_id };
  if (row.card_generation_run_id) return { kind: "card_generation", id: row.card_generation_run_id };
  throw new Error(`agent operation ${row.id} has no execution reference`);
}

/**
 * 结果列只有一种形状（0373 已把存量裸引用包成结果）；读不出来就是没有结果，
 * 不兜底旧格式——兜底会让"库里有值"和"值合法"变成两件事。
 */
function parseStoredResult(raw: unknown): AgentOperationResultV1 | null {
  const parsed = agentOperationResultV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** 唯一的「操作行 → 公共形状」投影：列表、历史、事件消费三处共用。 */
export function projectAgentOperation(scope: AgentScopeV1, runId: string, row: AgentOperationRow): AgentOperationV1 {
  return agentOperationV1Schema.parse({
    operationId: row.id, runId, revision: Number(row.revision), scope, capability: row.capability,
    execution: agentExecutionRefFromRow(row), status: row.status, lastEventSeq: Number(row.last_event_seq),
    result: parseStoredResult(row.result), error: row.error,
  });
}

/** 只有 artifact 结果进 run.artifacts；零推荐是正常收口，不是可打开的产物。 */
export function agentOperationArtifacts(operations: readonly AgentOperationRow[]): AgentArtifactRefV1[] {
  return operations.flatMap(row => {
    const result = parseStoredResult(row.result);
    return result?.kind === "artifact" ? [result.artifact] : [];
  });
}

export interface AgentRevisionRow {
  revision: number;
  goal: string; status: string;
  conversation_id: string | null;
  inputs: unknown; summary: string | null; error: string | null;
  model_calls: number; max_model_calls: number;
  started_at: string | null; last_active_at: string; recorded_at: string;
  superseded_by_revision: number | null;
  long_goal_ref?:AgentRunRevisionV1["longGoal"];
}

/** 存档所需的旧版本快照；由 store.ts 从锁内读出的行直接给出。 */
export interface SupersededRunSnapshot {
  id: string; workspace_id: string; user_id: string; revision: number;
  goal: string; status: string; resume_from_revision: number | null;
  conversation_id: string | null; account_epoch: number;
  inputs: unknown; summary: string | null; error: string | null;
  model_calls: number; max_model_calls: number;
  revision_started_at: string | Date | null; updated_at: string | Date;
  long_goal_ref?:AgentRunRevisionV1["longGoal"];
}

function clampLimit(raw: unknown, fallback: number, max: number): number {
  const value = typeof raw === "string" ? Number(raw.trim()) : typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

/**
 * HTTP 层已把 1..50 写死并对越界值报 400；这里仍收口，让直接调用 store 的
 * 伴星工具路径也拿不到一个能拖垮查询的 limit。
 */
export function resolveAgentRunListLimit(raw: unknown): number {
  return clampLimit(raw, AGENT_RUN_LIST_DEFAULT_LIMIT, AGENT_RUN_LIST_MAX_LIMIT);
}
export function resolveAgentHistoryLimit(raw: unknown): number {
  return clampLimit(raw, AGENT_RUN_HISTORY_DEFAULT_LIMIT, AGENT_RUN_HISTORY_MAX_LIMIT);
}

/**
 * 游标是位置书签，不是授权凭据：形状完整、作用域与会话一致、位置字段合法，
 * 三者缺一就整体作废报 400——悄悄退回第一页会让调用方把漏掉的页当成不存在。
 *
 * 不签 HMAC：查询本身已按会话身份收窄，伪造游标最多改变自己行内的翻页顺序；
 * 而按进程密钥签名会让多进程部署里换一台实例就把合法游标判成非法。
 */
export function encodeAgentRunListCursor(
  scope: AgentScopeV1,
  position: { updatedAt: string; runId: string; longGoalMemoryId?: string },
): string {
  const payload = agentRunListCursorV1Schema.parse({
    version: 1, workspaceId: scope.workspaceId, userId: scope.userId,
    updatedAt: position.updatedAt, runId: position.runId, longGoalMemoryId: position.longGoalMemoryId,
  });
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeAgentRunListCursor(
  raw: string,
  scope: AgentScopeV1,
): { updatedAt: string; runId: string; longGoalMemoryId?: string } | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch { return null; }
  const parsed = agentRunListCursorV1Schema.safeParse(decoded);
  if (!parsed.success) return null;
  // 不采信游标自带的 workspace/user：必须与本次会话的那一个逐字相同。
  if (parsed.data.workspaceId !== scope.workspaceId || parsed.data.userId !== scope.userId) return null;
  return { updatedAt: parsed.data.updatedAt, runId: parsed.data.runId,
    ...(parsed.data.longGoalMemoryId ? {longGoalMemoryId: parsed.data.longGoalMemoryId} : {}) };
}

/** 时间由 SQL 层 to_char 定形（微秒）；JS Date 只剩毫秒，回读会与游标边界对不齐。 */
export function isoTimestamp(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/** 历史项只带它自己那一版的 operation 与 artifact；新版成果不回填旧版。 */
export function projectAgentRunRevisionV1(args: {
  scope: AgentScopeV1; runId: string; revision: number; goal: string; status: string;
  conversationId: string | null; inputs: unknown; summary: string | null; error: string | null;
  modelCalls: number; maxModelCalls: number; startedAt: string | null; lastActiveAt: string;
  recordedAt: string | null; supersededByRevision: number | null;
  operations: AgentOperationRow[];
  longGoal?:AgentRunRevisionV1["longGoal"];
}): AgentRunRevisionV1 {
  const own = args.operations.filter(row => Number(row.revision) === args.revision);
  return agentRunRevisionV1Schema.parse({
    version: 1, runId: args.runId, revision: args.revision, goal: args.goal, status: args.status,
    conversationId: args.conversationId, inputs: args.inputs,
    longGoal:args.longGoal??null,
    operations: own.map(row => projectAgentOperation(args.scope, args.runId, row)),
    artifacts: agentOperationArtifacts(own),
    summary: args.summary, error: args.error,
    modelCalls: Number(args.modelCalls), maxModelCalls: Number(args.maxModelCalls),
    startedAt: args.startedAt, lastActiveAt: args.lastActiveAt,
    recordedAt: args.recordedAt, supersededByRevision: args.supersededByRevision,
  });
}

/**
 * 一页覆盖的 revision 号区间 [bottom, top]，至多 limit 个号。
 * 缺省名单只在这个区间里点名：不做 `1..currentRevision` 的无界遍历，
 * 否则一个 revision 很大的目标会让单次响应随历史线性膨胀。
 * 取数侧必须用同一对上下界，否则更早页的存档会漏进本页，造成跨页重复。
 */
export function agentHistoryRevisionWindow(topRevision: number, limit: number) {
  return { top: topRevision, bottom: Math.max(1, topRevision - limit + 1) };
}

export function projectAgentRunHistoryV1(args: {
  scope: AgentScopeV1; runId: string; currentRevision: number;
  /** 本页顶部 revision：首页是当前版，之后是 beforeRevision。 */
  topRevision: number; limit: number;
  /** 当前版快照；只有 topRevision === currentRevision 时才会进本页。 */
  current: {
    scope: AgentScopeV1; goal: string; status: string; conversationId: string | null;
    inputs: unknown; longGoal?:AgentRunRevisionV1["longGoal"];summary: string | null; error: string | null;
    modelCalls: number; maxModelCalls: number; startedAt: string | null; lastActiveAt: string;
  };
  /** 本页范围内的已存档版本，revision 倒序。 */
  recorded: AgentRevisionRow[];
  operations: AgentOperationRow[];
}): AgentRunHistoryV1 {
  const includeCurrent = args.topRevision >= args.currentRevision;
  const items = [
    ...(includeCurrent ? [projectAgentRunRevisionV1({
      ...args.current, runId: args.runId, revision: args.currentRevision,
      recordedAt: null, supersededByRevision: null, operations: args.operations,
    })] : []),
    ...args.recorded.map(row => projectAgentRunRevisionV1({
      scope: args.scope, runId: args.runId, revision: row.revision, goal: row.goal, status: row.status,
      conversationId: row.conversation_id, inputs: row.inputs, longGoal:row.long_goal_ref,summary: row.summary, error: row.error,
      modelCalls: row.model_calls, maxModelCalls: row.max_model_calls,
      startedAt: row.started_at, lastActiveAt: row.last_active_at,
      recordedAt: row.recorded_at, supersededByRevision: row.superseded_by_revision,
      operations: args.operations,
    })),
  ].sort((a, b) => b.revision - a.revision);

  const window = agentHistoryRevisionWindow(args.topRevision, args.limit);
  const present = new Set(items.map(item => item.revision));
  const unrecorded: number[] = [];
  for (let revision = window.bottom; revision <= window.top; revision += 1) {
    if (revision !== args.currentRevision && !present.has(revision)) unrecorded.push(revision);
  }
  return agentRunHistoryV1Schema.parse({
    version: 1, runId: args.runId, currentRevision: args.currentRevision, items,
    nextBeforeRevision: window.bottom > 1 ? window.bottom - 1 : null,
    unrecordedRevisions: unrecorded,
  });
}

/**
 * 把被替换掉的那一版原样存档。必须与推进 revision 同事务：回滚时存档一起消失，
 * 「CAS 失败 / 后续抛错」就永远不会留下一条没有对应新版本的凭据。
 * 冲突即忽略：行锁已串行化同一目标上的并发修订，这里只让重试保持幂等。
 */
export async function archiveSupersededRunRevision(
  tx: AgentHistoryExecutor,
  snapshot: SupersededRunSnapshot,
  supersededByRevision: number,
): Promise<void> {
  await tx.execute(sql`INSERT INTO agent_run_revisions
    (run_id,workspace_id,user_id,revision,goal,status,resume_from_revision,conversation_id,account_epoch,
      inputs,summary,error,model_calls,max_model_calls,started_at,last_active_at,recorded_at,superseded_by_revision,long_goal_ref)
    VALUES(${snapshot.id},${snapshot.workspace_id},${snapshot.user_id},${snapshot.revision},
      ${snapshot.goal},${snapshot.status},${snapshot.resume_from_revision},${snapshot.conversation_id},
      ${snapshot.account_epoch},${JSON.stringify(snapshot.inputs ?? [])}::jsonb,${snapshot.summary},
      ${snapshot.error},${snapshot.model_calls},${snapshot.max_model_calls},${snapshot.revision_started_at},
      ${snapshot.updated_at},now(),${supersededByRevision},${snapshot.long_goal_ref?JSON.stringify(snapshot.long_goal_ref):null}::jsonb)
    ON CONFLICT (run_id,revision) DO NOTHING`);
}
