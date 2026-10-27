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
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  proposedLearningActionPayloadV1Schema,
  type CompanionAgentToolDefinitionV1,
} from "@astella/shared";
import { canonicalJsonV1, sha256Utf8V1 } from "@astella/shared/content-hash";
import { lockCompanionRunForEventWrite } from "@astella/shared/companion-lock-order";
import { withWorkerWorkspaceTransaction } from "../../db.ts";
import { insertStreamEvent } from "../turn/companion-dialogue-store.ts";
import type { AgentEventContext } from "../tools/companion-read-tools.ts";
import { CompanionToolError } from "../tools/companion-tool-result.ts";
import { readCompanionMemoryWriteSource } from "../memory/companion-memory-write-source.ts";
import { describeAgentProposal } from "./companion-proposal-copy.ts";
import { lockJobLease } from "../../lib/job-lease.ts";

export async function createAgentProposal(
  event: AgentEventContext,
  definition: CompanionAgentToolDefinitionV1,
  call: { id: string; arguments: Record<string, unknown> },
  payload: Record<string, unknown>,
): Promise<{ proposalId: string; safeSummary: string }> {
  if (!event.read.userMessageId || event.read.initiativeInput) throw new CompanionToolError("主动参与不能替用户发起业务确认。");
  const parsedPayload = proposedLearningActionPayloadV1Schema.safeParse(payload);
  if (!parsedPayload.success) throw new CompanionToolError("这次要记的内容没通过校验，先没有写入");
  const proposalId = randomUUID();
  const proposalMessageId = randomUUID();
  const payloadSha256 = sha256Utf8V1(canonicalJsonV1(parsedPayload.data));
  // 这三行是**给用户看**的（提案卡），文案来自 payload 而不是工具描述：
  // 描述是写给模型的行为约束，截断后上屏等于让用户在决定要不要按下去的那一刻
  // 读一屏「什么时候不该调这个工具」。判据与来由见 `companion-proposal-copy.ts`。
  const { title, targetSummary, impactSummary } = describeAgentProposal(parsedPayload.data, definition.name);
  await withWorkerWorkspaceTransaction(
    { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
    async (tx) => {
      // 锁序规约：先 run 行、后会话计数器（见 @astella/shared/companion-lock-order）。
      // 本事务先拿计数器、再用围栏 UPDATE 碰 run 行——原来 run 行锁是计数器之后才拿，
      // 与「先锁 run 再拿计数器」的流式路径并发即 AB-BA
      // （2026-10-14 dev 库实测两例死锁）。围栏的 status 条件不受影响：
      // FOR NO KEY UPDATE 只加锁，不改这一行的任何值。
      await lockCompanionRunForEventWrite(tx, event.read.runId);
      await lockJobLease(tx, event.ctx);
      if (parsedPayload.data.kind === "save_memory") {
        const memory = parsedPayload.data;
        await readCompanionMemoryWriteSource(tx, event, {
          kind: memory.memoryKind, content: memory.content, sourceQuote: memory.sourceQuote,
          appliesWhen: memory.appliesWhen, validUntil: memory.validUntil,
        });
      }
      const pending = await tx.execute<{ id: string }>(sql`
        SELECT id FROM companion_action_proposals
        WHERE conversation_id = ${event.read.conversationId} AND status = 'pending'
        LIMIT 1
      `);
      if (pending[0]) throw new CompanionToolError("还有一件等你确认的事没处理完，先处理那件");
      const counters = await tx.execute<{ next_event_seq: string; next_message_seq: string }>(sql`
        UPDATE companion_conversations
        SET next_event_seq = next_event_seq + 1,
            next_message_seq = next_message_seq + 1, last_message_at = now()
        WHERE id = ${event.read.conversationId}
        RETURNING next_event_seq, next_message_seq
      `);
      const eventSeq = Number(counters[0]?.next_event_seq ?? 1) - 1;
      const messageSeq = Number(counters[0]?.next_message_seq ?? 1) - 1;
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
          AND workspace_id=${event.ctx.workspaceId} AND user_id=${event.read.userId}
          AND cancel_requested_at IS NULL
          AND EXISTS(SELECT 1 FROM user_companion_account_state a WHERE a.user_id=companion_turn_runs.user_id
            AND a.global_enabled AND a.epoch=companion_turn_runs.account_epoch)
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
           ${sha256Utf8V1(`agent:${event.read.runId}:${call.id}`)},
           CASE WHEN ${parsedPayload.data.kind}='agent_tool_review' THEN NULL ELSE now() + interval '5 minutes' END,
           'agent_tool', ${event.read.runId}, ${call.id},
           ${definition.toolVersion}, ${definition.riskClass})
      `);
      // 这张卡还要在**历史里留一条可读的记录**（方案 50 §12.1、§16 第 2 步）。
      // 只有 `action.proposed` 事件的话，本轮就没有任何伴星正文：确认卡没人点、
      // 五分钟后被回收时 run 直接落 `failed / ACTION_EXPIRED`，而 `assistant_message_id`
      // 一直是 NULL——用户回头看到的是自己那句话之后一片空白，连"她当时想做什么"
      // 都查不到。菜单那条路（learning-action-bridge 的 createCompanionProposalInTransaction）
      // 从一开始就写这种消息，这里是把 agent 工具那条补齐：形状与 §3.3 一致
      // （一个 text 块 + 恰好一个 action_ref 块），文案全部来自提案自己的三行，
      // 不另外编一句话。
      // 记的是**她准备改的那件事**，以及**依据的是用户哪句原话**——两个值都来自提案
      // 自己的 payload，不另编一句话。原话那一行要紧：历史里只剩"记住一条偏好"时，
      // 用户过几天看不出这条是从哪一句来的，也就没法定要不要撤回。
      const sourceQuote = parsedPayload.data.kind === "agent_tool_review" && typeof parsedPayload.data.arguments.sourceQuote === "string"
        ? parsedPayload.data.arguments.sourceQuote : "sourceQuote" in parsedPayload.data
          && typeof parsedPayload.data.sourceQuote === "string" ? parsedPayload.data.sourceQuote : null;
      const noticeText = [
        title,
        targetSummary,
        ...(sourceQuote ? [`依据你的原话：「${sourceQuote}」`] : []),
        impactSummary,
      ].join("\n");
      const noticeBlocks = [
        { type: "text", text: noticeText },
        { type: "action_ref", proposalId },
      ];
      await tx.execute(sql`
        INSERT INTO companion_messages
          (id, workspace_id, user_id, conversation_id, seq, role, kind, blocks,
           run_id, action_ref, content_sha256)
        VALUES
          (${proposalMessageId}, ${event.ctx.workspaceId}, ${event.read.userId},
           ${event.read.conversationId}, ${messageSeq}, 'assistant', 'action',
           ${JSON.stringify(noticeBlocks)}, ${event.read.runId}, ${proposalId}::uuid,
           ${sha256Utf8V1(canonicalJsonV1(noticeBlocks))})
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
      const recovery = event.prepareConfirmation?.(proposalId);
      if (recovery) {
        const [saved] = await tx.execute(sql`UPDATE companion_agent_steps
          SET status='waiting',runtime_checkpoint=${JSON.stringify(recovery.checkpoint)}::jsonb,
            checkpoint=NULL,compaction_checkpoint=NULL,finished_at=now()
          WHERE id=${recovery.stepId} AND run_id=${event.read.runId} AND status='running' RETURNING id`);
        if (!saved) throw new CompanionToolError("这一步状态已经变化，确认卡没有发布。");
      }
      await tx.execute(sql`
        SELECT pg_notify('astella_companion_events_v1',
          ${JSON.stringify({ conversationId: event.read.conversationId, maxSeq: eventSeq })})
      `);
    },
  );
  return { proposalId, safeSummary: "等待你确认后继续" };
}
