/**
 * 伴星 agent 的**事件与步进持久化**（2026-09-30 拆出，B2）。
 *
 * ## 为什么拆
 *
 * `companion-agent-runtime.ts` 混着四类东西：步进规划（已搬进
 * `companion-step-plan.ts`）、读工具（`companion-read-tools.ts`）、
 * **本文件这一族**、以及工具执行与提案创建。
 *
 * 这一族只做一件事：把「这一步发生了什么」写进 `companion_agent_events` /
 * `companion_agent_steps` / run 元数据，并把当前进度读回来。
 * 它不决定跑哪一步（那是 step-plan）、不解析工具参数（那是 read-tools）。
 *
 * 分开的理由是**事务边界**：这一族的每个函数都自带一个
 * `withWorkerWorkspaceTransaction`，所以"它什么时候开事务"是读代码时最先要问的事。
 * 混在一个 3000 行文件里，那个答案要翻很久。
 *
 * ## 这一段是**照搬**的
 *
 * SQL、事务边界、字段一个字没改。调用点在 `companion-agent-runtime.ts`，
 * 从这里 import。
 */

import { sql } from "drizzle-orm";
import { COMPANION_AGENT_CONTRACT_VERSION, type CompanionAgentPermissionLevel } from "@ailearn/shared";
import { randomUUID } from "node:crypto";
import { withWorkerWorkspaceTransaction } from "../db.ts";
import { insertStreamEvent } from "./companion-dialogue-store.ts";
import {
  companionAgentSettingsV1Schema,
  type CompanionAgentBudgetSnapshotV1,
} from "@ailearn/shared";
import type { AgentEventContext } from "./companion-read-tools.ts";

export interface AgentRunMeta {
  permissionLevel: CompanionAgentPermissionLevel;
  stepCount: number;
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

export async function readRunMeta(args: AgentEventContext): Promise<AgentRunMeta> {
  return withWorkerWorkspaceTransaction(
    { workspaceId: args.ctx.workspaceId, userId: args.read.userId },
    async (tx) => {
      const rows = await tx.execute<{
        permission_level: CompanionAgentPermissionLevel | null;
        step_count: number;
        tool_call_count: number;
        agent_settings: unknown;
        account_epoch: number;
        global_enabled: boolean;
        agent_elapsed_ms: number;
      }>(sql`
        SELECT r.permission_level,
               GREATEST(r.step_count, (
                 SELECT COUNT(*)::int FROM companion_agent_steps s WHERE s.run_id = r.id
               )) AS step_count,
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
        WHERE r.id = ${args.read.runId}
        LIMIT 1
      `);
      const row = rows[0];
      const settings = companionAgentSettingsV1Schema.safeParse(row?.agent_settings);
      return {
        permissionLevel: row?.permission_level
          ?? (settings.success ? settings.data.permissionLevel : DEFAULT_SETTINGS.permissionLevel),
        stepCount: Number(row?.step_count ?? 0),
        toolCallCount: Number(row?.tool_call_count ?? 0),
        // 已消耗执行时间跨确认续跑累计（不是每次尝试重置）。
        elapsedMs: Number(row?.agent_elapsed_ms ?? 0),
        currentAccountEpoch: Number(row?.account_epoch ?? 0),
        globalEnabled: row?.global_enabled !== false,
      };
    },
  );
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
            error_code = ${errorCode ?? null}, finished_at = now()
        WHERE id = ${stepId} AND run_id = ${event.read.runId}
      `);
    },
  );
}
