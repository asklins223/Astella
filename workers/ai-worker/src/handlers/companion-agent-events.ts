/**
 * 伴星 agent 的**事件与步进持久化**（2026-09-30 拆出，B2）。
 *
 * ## 为什么拆
 *
 * `companion-agent-runtime.ts` 混着四类东西：步进规划（已搬进
 * `companion-step-plan.ts`）、读工具（`companion-read-tools.ts`）、
 * **本文件这一族**、以及工具执行与提案创建。
 *
 * 这一族负责把「这一步发生了什么」写进 `companion_agent_events` /
 * `companion_agent_steps` / run 元数据，并把当前进度读回来；Agent 模型输出的
 * 恢复检查点也落在同一条受 RLS 保护的 step 行里，步骤收尾后立即清空。
 * 它不决定跑哪一步（那是 step-plan）、不解析工具参数（那是 read-tools）。
 *
 * 分开的理由是**事务边界**：这一族的每个函数都自带一个
 * `withWorkerWorkspaceTransaction`，所以"它什么时候开事务"是读代码时最先要问的事。
 * 混在一个 3000 行文件里，那个答案要翻很久。
 *
 * ## 原有事件/步进链路
 *
 * 原事件与步进 SQL 从 `companion-agent-runtime.ts` 搬入时保持不变；检查点端口是
 * 后续新增的恢复能力。调用点仍在 `companion-agent-runtime.ts`。
 */

import { sql } from "drizzle-orm";
import {
  agentTurnResultSchema,
  companionAgentSettingsV1Schema,
  COMPANION_AGENT_CONTRACT_VERSION,
  COMPANION_AGENT_MAX_MODEL_CALLS,
  type AgentTurnResult,
  type CompanionAgentBudgetSnapshotV1,
  type CompanionAgentPermissionLevel,
} from "@ailearn/shared";
import type {
  AiCheckpointEntry,
  AiCheckpointKey,
  AiTaskCheckpointPort,
} from "@ailearn/shared/ai-task-kernel";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withWorkerWorkspaceTransaction } from "../db.ts";
import { insertStreamEvent } from "./companion-dialogue-store.ts";
import { lockJobLease } from "../lib/job-lease.ts";
import { CompanionAgentBudgetExceededError } from "../lib/non-retryable-errors.ts";
import type { AgentEventContext } from "./companion-read-tools.ts";
import { assertCompanionContextSourcesCurrent } from "./companion-context-sources.ts";
import { agentTurnInterpretationV1Schema, type AgentTurnInterpretationV1, type AgentAttentionObjectV1 } from "@ailearn/shared/agent-contracts";

const persistedAgentStepCheckpointSchema = agentTurnResultSchema;

/** Reserve at the provider boundary; checkpoint reads and denied external policy consume no calls. */
export async function reserveCompanionProviderCall(event: {
  ctx: AgentEventContext["ctx"];
  read: Pick<AgentEventContext["read"], "userId" | "runId" | "accountEpoch" | "generation">;
}): Promise<void> {
  if (event.ctx.requestedBy !== event.read.userId) throw new CompanionAgentBudgetExceededError("companion initiating user changed");
  await withWorkerWorkspaceTransaction({ workspaceId: event.ctx.workspaceId, userId: event.read.userId }, async tx => {
    await lockJobLease(tx, event.ctx);
    await assertCompanionContextSourcesCurrent(tx, { workspaceId: event.ctx.workspaceId, userId: event.read.userId }, event.read.runId);
    const rows = await tx.execute(sql`UPDATE companion_turn_runs r
      SET model_call_count=model_call_count+1,updated_at=now()
      FROM user_companion_account_state a
      WHERE r.id=${event.read.runId} AND r.workspace_id=${event.ctx.workspaceId}
        AND r.user_id=${event.read.userId}
        AND EXISTS (SELECT 1 FROM jobs j WHERE j.id=${event.ctx.id}
          AND j.type='companion_agent' AND j.payload->>'runId'=r.id::text)
        AND r.account_epoch=${event.read.accountEpoch} AND r.generation=${event.read.generation}
        AND r.status IN ('accepted','running','waiting_for_confirmation')
        AND a.user_id=r.user_id AND a.global_enabled AND a.epoch=r.account_epoch
        AND r.model_call_count<${COMPANION_AGENT_MAX_MODEL_CALLS}
      RETURNING r.model_call_count`);
    if (!rows.length) throw new CompanionAgentBudgetExceededError("companion provider budget exhausted or turn obsolete");
  });
}

const storedAgentStepCheckpointEnvelopeSchema = z.object({
  key: z.object({
    taskId: z.string().min(1),
    taskVersion: z.number().int().positive(),
    inputSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    workspaceId: z.string().min(1),
    userId: z.string().nullable(),
  }).strict(),
  entry: z.object({
    output: persistedAgentStepCheckpointSchema,
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
  }).strict(),
}).strict();

/** Decode only a structurally valid checkpoint for the exact task/input/scope identity. */
export function decodeCompanionAgentStepCheckpoint(
  value: unknown,
  expectedKey: AiCheckpointKey,
): AiCheckpointEntry<AgentTurnResult> | null {
  let decodedValue = value;
  if (typeof decodedValue === "string") {
    try {
      decodedValue = JSON.parse(decodedValue) as unknown;
    } catch {
      return null;
    }
  }
  const parsed = storedAgentStepCheckpointEnvelopeSchema.safeParse(decodedValue);
  if (!parsed.success) return null;
  const { key, entry } = parsed.data;
  if (
    key.taskId !== expectedKey.taskId
    || key.taskVersion !== expectedKey.taskVersion
    || key.inputSnapshotHash !== expectedKey.inputSnapshotHash
    || key.workspaceId !== expectedKey.workspaceId
    || key.userId !== expectedKey.userId
  ) {
    return null;
  }
  return entry;
}

export interface AgentRunMeta {
  turnInterpretation?: AgentTurnInterpretationV1;
  relatedGoals?: AgentAttentionObjectV1[];
  permissionLevel: CompanionAgentPermissionLevel;
  stepCount: number;
  /** 未完成的唯一模型步骤；可在 lease reclaim 后用检查点继续。 */
  runningStepNo: number | null;
  toolCallCount: number;
  /** 该 run 已消耗的 Agent 执行时间（毫秒，跨确认续跑累计）。 */
  elapsedMs: number;
  currentAccountEpoch: number;
  globalEnabled: boolean;
}

export const DEFAULT_SETTINGS = {
  version: COMPANION_AGENT_CONTRACT_VERSION,
  permissionLevel: "guided" as const,
};

export async function readRunMeta(args: {
  ctx: Pick<AgentEventContext["ctx"], "workspaceId">;
  read: Pick<AgentEventContext["read"], "userId" | "runId">;
}): Promise<AgentRunMeta> {
  return withWorkerWorkspaceTransaction(
    { workspaceId: args.ctx.workspaceId, userId: args.read.userId },
    async (tx) => {
      const rows = await tx.execute<{
        permission_level: CompanionAgentPermissionLevel | null;
        step_count: number;
        running_step_no: number | null;
        tool_call_count: number;
        agent_settings: unknown;
        account_epoch: number;
        global_enabled: boolean;
        agent_elapsed_ms: number;
        turn_interpretation: unknown;
        related_goals: Array<{ id: string; revision: number }>;
      }>(sql`
        SELECT r.permission_level, r.turn_interpretation,
               COALESCE((SELECT jsonb_agg(jsonb_build_object('id',g.id,'revision',g.revision))
                 FROM (SELECT id,revision FROM agent_runs
                   WHERE conversation_id=r.conversation_id AND workspace_id=r.workspace_id AND user_id=r.user_id
                   ORDER BY updated_at DESC,id LIMIT 8) g), '[]'::jsonb) AS related_goals,
               GREATEST(r.step_count, (
                 SELECT COUNT(*)::int FROM companion_agent_steps s WHERE s.run_id = r.id
               )) AS step_count,
               (
                 SELECT MIN(s.step_no)::int
                 FROM companion_agent_steps s
                 WHERE s.run_id = r.id AND s.status = 'running'
               ) AS running_step_no,
               GREATEST(r.tool_call_count, (
                 SELECT COUNT(*)::int FROM companion_agent_tool_calls tc WHERE tc.run_id = r.id
               )) AS tool_call_count,
               COALESCE(r.agent_elapsed_ms, 0) AS agent_elapsed_ms,
               -- 默认设置只有 DEFAULT_SETTINGS 一个来源：内联字面量曾与 loop 层的
               -- fallback 各写一份，任一处改动即漂移。
               COALESCE(s.agent_settings, ${JSON.stringify(DEFAULT_SETTINGS)}::jsonb) AS agent_settings,
               COALESCE(s.epoch, 0) AS account_epoch,
               COALESCE(s.global_enabled, true) AS global_enabled
        FROM companion_turn_runs r
        LEFT JOIN user_companion_account_state s ON s.user_id = r.user_id
        WHERE r.id = ${args.read.runId} AND r.workspace_id=${args.ctx.workspaceId} AND r.user_id=${args.read.userId}
        LIMIT 1
      `);
      const row = rows[0];
      const settings = companionAgentSettingsV1Schema.safeParse(row?.agent_settings);
      const attention = agentTurnInterpretationV1Schema.safeParse(row?.turn_interpretation);
      return {
        ...(attention.success ? { turnInterpretation: attention.data } : {}),
        relatedGoals: (row?.related_goals ?? []).map(goal => ({ kind: "agent_run" as const, id: goal.id, revision: goal.revision })),
        permissionLevel: row?.permission_level
          ?? (settings.success ? settings.data.permissionLevel : DEFAULT_SETTINGS.permissionLevel),
        stepCount: Number(row?.step_count ?? 0),
        runningStepNo: row?.running_step_no == null ? null : Number(row.running_step_no),
        toolCallCount: Number(row?.tool_call_count ?? 0),
        // 已消耗执行时间跨确认续跑累计（不是每次尝试重置）。
        elapsedMs: Number(row?.agent_elapsed_ms ?? 0),
        currentAccountEpoch: Number(row?.account_epoch ?? 0),
        globalEnabled: row?.global_enabled !== false,
      };
    },
  );
}

/** Re-enter the unfinished logical step instead of skipping past its checkpoint after reclaim. */
export function resolveAgentStepCountForResume(meta: Pick<AgentRunMeta, "stepCount" | "runningStepNo">): number {
  if (meta.runningStepNo === null) return meta.stepCount;
  return Math.min(meta.stepCount, Math.max(0, meta.runningStepNo - 1));
}

export async function appendAgentEvent(
  event: AgentEventContext,
  type: "agent.tool",
  payload: Record<string, unknown>,
): Promise<void> {
  await withWorkerWorkspaceTransaction(
    { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
    async (tx) => {
      const counters = await tx.execute<{ next_event_seq: string }>(sql`
        UPDATE companion_conversations
        SET next_event_seq = next_event_seq + 1
        WHERE id = ${event.read.conversationId}
        RETURNING next_event_seq
      `);
      // 计数器 UPDATE 返回 0 行（会话并发删除 / RLS 异常）时必须失败：静默兜底
      // seq=0 会写入乱序事件并把 last_event_seq/ NOTIFY 一起回退到 0。
      const nextEventSeq = counters[0]?.next_event_seq;
      if (nextEventSeq === undefined) {
        throw new Error("conversation event counter update returned no row");
      }
      const seq = Number(nextEventSeq) - 1;
      await insertStreamEvent(tx, {
        conversationId: event.read.conversationId,
        workspaceId: event.ctx.workspaceId,
        userId: event.read.userId,
        runId: event.read.runId,
        generation: event.read.generation,
        accountEpoch: event.read.accountEpoch,
        seq,
        type,
        payload,
        expiresAt: event.expiresAt,
      });
      await tx.execute(sql`
        UPDATE companion_turn_runs
        SET last_event_seq = ${seq}, updated_at = now()
        WHERE id = ${event.read.runId}
      `);
      await tx.execute(sql`
        SELECT pg_notify('ailearn_companion_events_v1',
          ${JSON.stringify({ conversationId: event.read.conversationId, maxSeq: seq })})
      `);
    },
  );
}

export async function updateRunMeta(
  event: AgentEventContext,
  patch: {
    permissionLevel?: CompanionAgentPermissionLevel;
    permissionSnapshot?: unknown;
    turnInterpretation?: AgentTurnInterpretationV1;
    budgetSnapshot?: CompanionAgentBudgetSnapshotV1;
    providerCapabilityFingerprint?: string;
    stepCount?: number;
    toolCallCount?: number;
    elapsedMsDelta?: number;
    status?: "running" | "waiting_for_confirmation";
    waitingProposalId?: string | null;
  },
): Promise<void> {
  const fields = [
    patch.permissionLevel === undefined ? null : sql`permission_level = ${patch.permissionLevel}`,
    patch.permissionSnapshot === undefined ? null : sql`permission_snapshot = ${JSON.stringify(patch.permissionSnapshot)}`,
    patch.turnInterpretation === undefined ? null : sql`turn_interpretation = ${JSON.stringify(agentTurnInterpretationV1Schema.parse(patch.turnInterpretation))}::jsonb`,
    patch.budgetSnapshot === undefined ? null : sql`budget_snapshot = ${JSON.stringify(patch.budgetSnapshot)}`,
    patch.providerCapabilityFingerprint === undefined ? null : sql`provider_capability_fingerprint = ${patch.providerCapabilityFingerprint}`,
    patch.stepCount === undefined ? null : sql`step_count = ${patch.stepCount}`,
    patch.toolCallCount === undefined ? null : sql`tool_call_count = ${patch.toolCallCount}`,
    // 累加而非覆盖：同一次 run 跨确认续跑共享 120s 执行预算（见 readRunMeta）。
    patch.elapsedMsDelta === undefined ? null : sql`agent_elapsed_ms = agent_elapsed_ms + ${patch.elapsedMsDelta}`,
    patch.status === undefined ? null : sql`status = ${patch.status}`,
    patch.waitingProposalId === undefined ? null : sql`waiting_proposal_id = ${patch.waitingProposalId}`,
  ].filter((field): field is NonNullable<typeof field> => field !== null);
  if (fields.length === 0) return;
  await withWorkerWorkspaceTransaction(
    { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
    async (tx) => {
      await tx.execute(sql`
        UPDATE companion_turn_runs
        SET ${sql.join(fields, sql`, `)}, updated_at = now()
        WHERE id = ${event.read.runId}
          AND status IN ('accepted', 'running', 'waiting_for_confirmation')
      `);
    },
  );
}

export async function persistStep(
  event: AgentEventContext,
  stepNo: number,
  requestHash: string,
): Promise<string> {
  return withWorkerWorkspaceTransaction(
    { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
    async (tx) => {
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO companion_agent_steps
          (id, workspace_id, user_id, conversation_id, run_id, step_no, kind, status,
           request_hash)
        VALUES
          (${randomUUID()}, ${event.ctx.workspaceId}, ${event.read.userId},
           ${event.read.conversationId}, ${event.read.runId}, ${stepNo}, 'model', 'running',
           ${requestHash})
        ON CONFLICT (run_id, step_no) DO NOTHING
        RETURNING id
      `);
      if (inserted[0]) return inserted[0].id;
      // A concurrent attempt (lease reaped then re-claimed) already fenced this
      // step number. Reuse the recorded row so tool calls keep a valid step
      // reference; returning a never-inserted id would violate the
      // companion_agent_tool_calls.step_id foreign key and fail the whole run.
      const existing = await tx.execute<{ id: string }>(sql`
        SELECT id FROM companion_agent_steps
        WHERE run_id = ${event.read.runId} AND step_no = ${stepNo}
        LIMIT 1
      `);
      const stepId = existing[0]?.id;
      if (!stepId) throw new Error("companion agent step fence could not be resolved");
      return stepId;
    },
  );
}

/**
 * Store a model result only while its agent step is still running. The step's
 * RLS scope and run cascade protect private content; finishStep clears the
 * payload once the tool/result ledger has taken over recovery responsibility.
 */
export function createCompanionAgentStepCheckpointPort(
  event: AgentEventContext,
  stepId: string,
): AiTaskCheckpointPort<AgentTurnResult> {
  return {
    load: async (key) => withWorkerWorkspaceTransaction(
      { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
      async (tx) => {
        await lockJobLease(tx, event.ctx);
        const rows = await tx.execute<{ status: string; checkpoint: unknown }>(sql`
          SELECT status, checkpoint
          FROM companion_agent_steps
          WHERE id = ${stepId}
            AND run_id = ${event.read.runId}
            AND workspace_id = ${event.ctx.workspaceId}
            AND user_id = ${event.read.userId}
          LIMIT 1
          FOR UPDATE
        `);
        const row = rows[0];
        if (!row || row.status !== "running" || row.checkpoint == null) return null;
        const entry = decodeCompanionAgentStepCheckpoint(row.checkpoint, key);
        if (entry) return entry;
        // A stale or malformed checkpoint must not linger or be mistaken for
        // the current prompt if this step is retried with changed inputs.
        await tx.execute(sql`
          UPDATE companion_agent_steps
          SET checkpoint = NULL
          WHERE id = ${stepId} AND run_id = ${event.read.runId} AND status = 'running'
        `);
        return null;
      },
    ),
    save: async (key, entry) => {
      const stored = storedAgentStepCheckpointEnvelopeSchema.parse({ key, entry });
      await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx) => {
          await lockJobLease(tx, event.ctx);
          const rows = await tx.execute<{ id: string }>(sql`
            UPDATE companion_agent_steps
            SET checkpoint = ${JSON.stringify(stored)}::jsonb
            WHERE id = ${stepId}
              AND run_id = ${event.read.runId}
              AND workspace_id = ${event.ctx.workspaceId}
              AND user_id = ${event.read.userId}
              AND status = 'running'
            RETURNING id
          `);
          if (!rows[0]) {
            throw new Error("companion agent checkpoint lost its running step");
          }
        },
      );
    },
  };
}

export async function finishStep(
  event: AgentEventContext,
  stepId: string,
  status: "succeeded" | "waiting" | "failed" | "cancelled",
  resultHash?: string,
  errorCode?: string,
): Promise<void> {
  await withWorkerWorkspaceTransaction(
    { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
    async (tx) => {
      await tx.execute(sql`
        UPDATE companion_agent_steps
        SET status = ${status}, result_hash = ${resultHash ?? null},
            error_code = ${errorCode ?? null}, finished_at = now(), checkpoint = NULL
        WHERE id = ${stepId} AND run_id = ${event.read.runId}
      `);
    },
  );
}
