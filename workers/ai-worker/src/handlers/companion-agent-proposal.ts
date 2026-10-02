/**
 * 伴星 agent 的**提案创建**（2026-09-30 拆出，B2）。
 *
 * ## 这一族是什么
 *
 * 把「她想调这个工具」翻译成一条**等待用户确认**的提案，并落库。
 * 它不执行任何工具——执行在 `companion-tool-execution.ts`。
 *
 * ## 为什么先拆它（而不是账本）
 *
 * `companion-agent-runtime.ts` 里账本与提案是**互相调用**的：
 * 账本在拒绝一次调用时会去建一条提案。于是同时搬两个族会做出一个环
 * （runtime → ledger → proposal → runtime），而环上无论怎么分 import 都编译不过。
 *
 * 提案这一族**不反向依赖** runtime——它要的东西分别在 `companion-read-tools.ts`、
 * `companion-tool-execution.ts`、`companion-agent-events.ts` 里，方向都是单向的。
 * 所以先搬它，环就不成立。账本留到下一刀。
 *
 * ## 这一段是**照搬**的
 *
 * payload 形状、事务边界一个字没改。
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  proposedLearningActionPayloadV1Schema,
  startRunOriginV2,
  type CompanionAgentToolDefinitionV1,
} from "@ailearn/shared";
import { canonicalJsonV1, sha256Utf8V1 } from "@ailearn/shared/content-hash";
import { withWorkerWorkspaceTransaction } from "../db.ts";
import { insertStreamEvent } from "./companion-dialogue-store.ts";
import type { AgentEventContext } from "./companion-read-tools.ts";
import { CompanionToolError } from "./companion-tool-result.ts";

export async function buildActionPayload(
  event: AgentEventContext,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  // `noteId`/`runId` **必填**（2026-09-26，W2-1 判据 1 转绿；39b C1 的处方落地）：
  // consequential 写工具必须能指名对象——伴星入口是语境锚定的"学眼前这一篇"，
  // noteId/runId 从页面上下文与 <this_turn_facts> 的回填拿；服务端不再"挑最近一条"
  // （挑错用户看不出为什么——C1 的原诉）。resume 的 runId 在执行侧还有一道
  // workspace+user 归属校验（learning-action-bridge 的 getRunPublicView）。
  if (toolName === "companion_resume_learning") {
    const runId = typeof args.runId === "string" && args.runId.length > 0 ? args.runId : null;
    if (!runId) return null;
    return { kind: "resume_learning_run", runId };
  }
  if (toolName === "companion_start_learning") {
    const noteId = typeof args.noteId === "string" && args.noteId.length > 0 ? args.noteId : null;
    if (!noteId) return null;
    const rows = await withWorkerWorkspaceTransaction(
      { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
      (tx) => tx.execute(sql`
        SELECT o.objective_id, c.card_id
        FROM learning_objectives_v2 o
        -- LEFT JOIN：没有卡的目标也是可开的（39d W4-2 已放开页面那一侧的主行动）。
        -- 原来这里是 INNER JOIN 且「row.card_id 为空就 return null」⇒ 她说「开始学习」
        -- 对一个无卡目标报"当前不可用"，而同一篇笔记上那颗「开始学习」点得动。
        LEFT JOIN learning_cards_v2 c ON c.objective_id = o.objective_id
          AND c.workspace_id = o.workspace_id AND c.lifecycle = 'active'
        WHERE o.workspace_id = ${event.ctx.workspaceId}
          -- learning_objectives_v2 没有 user_id 列（迁移 0135/0175）：此前这一条
          -- 谓词让整条 SQL 在计划期就报 "column o.user_id does not exist"，
          -- companion_start_learning 永远不可用。归属边界是 workspace + RLS。
          AND o.lifecycle = 'active'
          AND EXISTS (
            SELECT 1 FROM learning_objective_origins_v2 g
            WHERE g.objective_id = o.objective_id
              AND g.workspace_id = o.workspace_id
              AND g.note_id = ${noteId}::uuid
          )
        ORDER BY o.updated_at DESC, o.objective_id LIMIT 1
      `),
    );
    const row = rows[0] as { objective_id?: string; card_id?: string | null } | undefined;
    if (!row?.objective_id) return null;
    return {
      kind: "start_learning_run_v2",
      request: {
        originV2: startRunOriginV2({ objectiveId: row.objective_id, cardId: row.card_id }),
        goal: "stabilize",
        idempotencyKey: `companion-agent:${event.read.runId}`,
        requestedTimeBudgetSeconds: 180,
      },
    };
  }
  const map: Record<string, Record<string, unknown>> = {
    companion_pause_learning: { kind: "pause_learning_run", runId: args.runId },
    companion_request_hint: { kind: "request_hint_level", runId: args.runId, taskId: args.taskId, level: args.level },
    companion_switch_task_variant: { kind: "switch_task_variant", runId: args.runId, taskId: args.taskId, alternativeId: args.alternativeId, reason: args.reason },
    companion_defer_review: { kind: "defer_review", scheduleId: args.scheduleId, scheduleGeneration: args.scheduleGeneration, deferredUntil: args.deferredUntil, reasonCode: args.reasonCode },
    // 工具参数叫 `objectiveId`，网关载荷的字段名仍是 `keyPointId`（内部提案合同的既有
    // 名字，本轮不改）——改名发生在这一行，读的人一眼能看出是同一个值换了个边界名。
    companion_focus_graph: { kind: "focus_graph_node", keyPointId: args.objectiveId, lens: args.lens },
    // auto-set / auto-fill：guided 档提案确认后由 API decision 分支执行
    // （learning-action-bridge decideCompanionProposal 的 save_memory /
    // set_pet_activeness 分支）；full 档不经提案、由 executeDirectTool 直执行。
    companion_save_memory: {
      kind: "save_memory",
      memoryKind: args.kind,
      content: args.content,
      sourceQuote: args.sourceQuote ?? null,
      appliesWhen: args.appliesWhen ?? null,
      validUntil: args.validUntil ?? null,
    },
    companion_revise_memory: {
      kind: "revise_memory",
      memoryId: args.memoryId,
      expectedRevision: args.expectedRevision,
      content: args.content,
      ...(args.appliesWhen !== undefined ? { appliesWhen: args.appliesWhen } : {}),
      ...(args.validFrom !== undefined ? { validFrom: args.validFrom } : {}),
      ...(args.validUntil !== undefined ? { validUntil: args.validUntil } : {}),
    },
    companion_set_activeness: { kind: "set_pet_activeness", activeness: args.activeness },
  };
  return map[toolName] ?? null;
}

export async function createAgentProposal(
  event: AgentEventContext,
  definition: CompanionAgentToolDefinitionV1,
  call: { id: string; arguments: Record<string, unknown> },
  payload: Record<string, unknown>,
): Promise<{ proposalId: string; safeSummary: string }> {
  const parsedPayload = proposedLearningActionPayloadV1Schema.safeParse(payload);
  if (!parsedPayload.success) throw new CompanionToolError("这次要记的内容没通过校验，先没有写入");
  const proposalId = randomUUID();
  const payloadSha256 = sha256Utf8V1(canonicalJsonV1(parsedPayload.data));
  const title = `执行${definition.description.slice(0, 30)}`;
  const targetSummary = definition.description.slice(0, 160);
  const impactSummary = "该操作会改变学习或伴星状态";
  await withWorkerWorkspaceTransaction(
    { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
    async (tx) => {
      const pending = await tx.execute<{ id: string }>(sql`
        SELECT id FROM companion_action_proposals
        WHERE conversation_id = ${event.read.conversationId} AND status = 'pending'
        LIMIT 1
      `);
      if (pending[0]) throw new CompanionToolError("还有一件等你确认的事没处理完，先处理那件");
      const counters = await tx.execute<{ next_event_seq: string }>(sql`
        UPDATE companion_conversations
        SET next_event_seq = next_event_seq + 1
        WHERE id = ${event.read.conversationId}
        RETURNING next_event_seq
      `);
      const eventSeq = Number(counters[0]?.next_event_seq ?? 1) - 1;
      // Cancel/cancel-requested/superseded fence. The run may have been
      // cancelled by the user while this tool call was in flight; without this
      // conditional the UPDATE below would resurrect a terminal run as
      // waiting_for_confirmation, undo the user's cancel and wedge the
      // conversation behind the active-run partial unique index. Zero updated
      // rows aborts the transaction, so no proposal/event is committed either.
      const fenced = await tx.execute<{ id: string }>(sql`
        UPDATE companion_turn_runs
        SET status = 'waiting_for_confirmation', waiting_proposal_id = ${proposalId},
            last_event_seq = ${eventSeq}, updated_at = now()
        WHERE id = ${event.read.runId}
          AND status IN ('accepted', 'running')
        RETURNING id
      `);
      if (!fenced[0]) throw new CompanionToolError("这一轮已经不在进行中了");
      await tx.execute(sql`
        INSERT INTO companion_action_proposals
          (id, workspace_id, user_id, conversation_id, source_message_id, source_generation,
           payload, payload_sha256, title, target_summary, impact_summary, status,
           idempotency_key_hash, expires_at, origin, agent_run_id, agent_tool_call_id,
           agent_tool_version, risk_class)
        VALUES
          (${proposalId}, ${event.ctx.workspaceId}, ${event.read.userId}, ${event.read.conversationId},
           ${event.read.userMessageId}, ${event.read.generation}, ${JSON.stringify(parsedPayload.data)},
           ${payloadSha256}, ${title}, ${targetSummary}, ${impactSummary}, 'pending',
           ${sha256Utf8V1(`agent:${event.read.runId}:${call.id}`)}, now() + interval '5 minutes',
           'agent_tool', ${event.read.runId}, ${call.id},
           ${definition.toolVersion}, ${definition.riskClass})
      `);
      await insertStreamEvent(tx, {
        conversationId: event.read.conversationId,
        workspaceId: event.ctx.workspaceId,
        userId: event.read.userId,
        runId: event.read.runId,
        generation: event.read.generation,
        accountEpoch: event.read.accountEpoch,
        seq: eventSeq,
        type: "action.proposed",
        payload: {
          proposal: {
            version: 1,
            id: proposalId,
            workspaceId: event.ctx.workspaceId,
            conversationId: event.read.conversationId,
            sourceMessageId: event.read.userMessageId,
            sourceGeneration: event.read.generation,
            kind: parsedPayload.data,
            payloadSha256,
            title,
            targetSummary,
            impactSummary,
            status: "pending",
            origin: "agent_tool",
            agentToolCallId: call.id,
          },
        },
        expiresAt: event.expiresAt,
      });
      await tx.execute(sql`
        UPDATE companion_agent_tool_calls
        SET status = 'waiting_confirmation', proposal_id = ${proposalId}, updated_at = now()
        WHERE run_id = ${event.read.runId} AND tool_call_id = ${call.id}
      `);
      await tx.execute(sql`
        SELECT pg_notify('ailearn_companion_events_v1',
          ${JSON.stringify({ conversationId: event.read.conversationId, maxSeq: eventSeq })})
      `);
    },
  );
  return { proposalId, safeSummary: "等待你确认后继续" };
}
