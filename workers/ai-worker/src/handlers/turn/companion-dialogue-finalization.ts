import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { enqueueParticipationObservation } from "@astella/agent-host";
import { COMPANION_INITIATIVE_DELIVERY_TTL_HOURS } from "@astella/shared/companion-initiative-contracts";
import { canonicalJsonV1, sha256Utf8V1 } from "@astella/shared/content-hash";
import { COMPANION_PERSONA_V14_PROMPT_ID, COMPANION_PERSONA_V14_SHA256 } from "@astella/shared";
import { lockCompanionRunForEventWrite } from "@astella/shared/companion-lock-order";
import { logger } from "../../lib/logger.ts";
import { withWorkerWorkspaceTransaction } from "../../db.ts";
import { CompanionContextChangedError } from "../../lib/non-retryable-errors.ts";
import { lockJobLease } from "../../lib/job-lease.ts";
import { assertCompanionContextSourcesCurrent } from "../context/companion-context-sources.ts";
import { enqueueSystemEventDelivery } from "../agent/companion-delivery-write.ts";
import { buildFinalCuePayload, companionAssistantMessageKind, } from "./companion-dialogue-content.ts";
import { persistFailedPartial } from "./companion-dialogue-failure-retention.ts";
import {
  insertStreamEvent,
  recoverCompanionRunFailureSpanInTransaction,
  markCompanionRunFailed,
  enqueueCompanionMemoryJobs,
  enqueueCompanionFollowupSuggestions,
  insertCompanionFinalAssistantMessage,
  type CompanionDialogueHandlerContext,
  type ReadContext,
} from "./companion-dialogue-store.ts";
import type { ContextAssemblyResult } from "../context/companion-context-orchestrator.ts";
import type { CompanionAgentLoopResult } from "./companion-step-plan.ts";

/**
 * 阶段 3c：终态事务——assistant 消息落库、assistant.final/character.cue 事件、run 终态、
 * 题面曝光记账、主动投递、续答与记忆入队、关系状态；失败路径显式投影 failed + partial。
 *
 * 为什么搬出来（2026-10-15 神文件棘轮）：回答收尾自成一域——它只消费编排层已经定稿的
 * 文本与 agent 结果，不读上下文、不调 provider。留在原来的编排文件里，会让「改收尾事务」
 * 看起来像「改整轮编排」，两件事的验证面完全不同。纯搬运：判据、事务边界、事件布局
 * 一字未改，调用点仍在原位置（尾随 loop 之后）。
 */
export async function finalizeCompanionDialogueTurn(args: {
  ctx: CompanionDialogueHandlerContext;
  read: ReadContext;
  runId: string;
  provider: { id: string; modelId: string };
  agentResult: Extract<CompanionAgentLoopResult, { status: "completed" }>;
  assistantText: string;
  ttsRawText: string;
  voiceExpressionEnabled: boolean;
  memoryContext: ContextAssemblyResult;
  voiceSegmentsWritten: boolean;
  expiresAt: string;
  streamingDelivery: { deliveredText(): string };
  notifyCompanionEvent: (tx: { execute(q: unknown): Promise<unknown> }, seq: number) => Promise<void>;
}): Promise<void> {
  const {
    ctx, read, runId, provider, agentResult, assistantText, ttsRawText, voiceExpressionEnabled,
    memoryContext, voiceSegmentsWritten, expiresAt, streamingDelivery, notifyCompanionEvent,
  } = args;

  // ── 阶段 3c：终态事务（message + final + run succeeded） ──
  // 15b：TTS 段已在 delta 过程（流式）或 validate 后（非流式）逐个下发完毕，
  // 终态事务不再携带 segments——事件布局变为 final @ eventStart、cue @ +1、
  // character.cue @ +1。
  const assistantMessageId = randomUUID();
  // Historical emotion comes from the same model-authored expression as speech, never text keywords.
  const finalCue = !voiceExpressionEnabled
    ? buildFinalCuePayload("") : buildFinalCuePayload(ttsRawText);
  const replyEmotion = finalCue.emotion;
  // 工具带出的跳转块跟在正文之后（方案 29 §4.8）。正文仍是**第一个块**：
  // 按 `blocks[0].text` 取正文的老读法（含下一轮装配 prompt）不受影响，
  // 而 `textOfCompanionBlocks` 只认 text/code/citation，nav 不会污染模型上下文。
  const orderedRichBlocks = [...agentResult.blocks.filter(block => block.type === "citation" && block.referenceId),
    ...agentResult.blocks.filter(block => !(block.type === "citation" && block.referenceId))];
  const blocks = [
    { type: "text", text: assistantText, emotion: replyEmotion },
    // Preserve every search source before optional rich results; at most three searches yield 24 sources.
    // Reserve one block slot for the asynchronous optional follow-up suggestions.
    ...orderedRichBlocks.slice(0, 32),
  ];
  const contentSha256 = sha256Utf8V1(canonicalJsonV1(blocks));
  const textSha256 = sha256Utf8V1(assistantText);
  try {
    const published = await withWorkerWorkspaceTransaction(
      { workspaceId: ctx.workspaceId, userId: read.userId },
      async (tx) => {
        await lockCompanionRunForEventWrite(tx, read.runId);
        await lockJobLease(tx, ctx);
        await assertCompanionContextSourcesCurrent(tx, { workspaceId: ctx.workspaceId, userId: read.userId }, read.runId);
        const alive = await tx.execute<{ id: string }>(sql`
          UPDATE companion_turn_runs
          SET status = 'running', updated_at = now()
          WHERE id = ${read.runId} AND status IN ('accepted', 'running')
            AND generation = ${read.generation}
            AND (job_id IS NULL OR job_id = ${ctx.id})
            AND account_epoch = ${read.accountEpoch}
            AND EXISTS (SELECT 1 FROM user_companion_account_state a
              WHERE a.user_id = companion_turn_runs.user_id AND a.epoch = companion_turn_runs.account_epoch AND a.global_enabled)
          RETURNING id
        `);
        if (!alive[0]) {
          // 取消/接替事务已经保存当时提交的增量。晚到的完整生成不得再写消息、
          // 富块或 final：它可能包含用户停止后才生成的正文与动作。
          return;
        }

        // 事件布局：final @ eventStart，character.cue @ +1
        //（15b：TTS 段已前置于 delta 过程/validate 后，终态事务不再含 segments）。
        const eventCount = 2; // final + cue
        const counters = await tx.execute<{ next_message_seq: string; next_event_seq: string }>(sql`
          UPDATE companion_conversations
          SET next_message_seq = next_message_seq + 1,
              next_event_seq = next_event_seq + ${eventCount},
              last_message_at = now()
          WHERE id = ${read.conversationId}
          RETURNING next_message_seq, next_event_seq
        `);
        const next = counters[0];
        if (!next) throw new Error("conversation counter update returned no row");
        const messageSeq = Number(next.next_message_seq) - 1;
        const eventStart = Number(next.next_event_seq) - eventCount;

        // 主动那一轮的收尾消息也必须记成 `proactive`，和 `companion_publish_utterance`
        // 的写法一致（判据收在 `companionAssistantMessageKind` 一处）：`runCompanionInitiative`
        // 用 `max(created_at) WHERE role='assistant' AND kind='proactive'` 量主动节奏，
        // 历史/记忆/摘要也按 kind 认她主动说过的话。写死 'text' 会让她自己开口的
        // 大部分发言在这三处都不算数（2026-10-13 方案 56 遗留缺陷）。
        // reasoning 随消息一起落库的判据在 store 那个函数里（0435）。
        await insertCompanionFinalAssistantMessage(tx, {
          messageId: assistantMessageId, workspaceId: ctx.workspaceId, userId: read.userId,
          conversationId: read.conversationId, messageSeq, kind: companionAssistantMessageKind(read),
          blocks, runId: read.runId, contentSha256,
          reasoning: agentResult.status === "completed" ? agentResult.reasoning ?? null : null,
        });

        await tx.execute(sql`
          INSERT INTO companion_stream_events
            (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch, type, payload, expires_at)
          VALUES
            (${read.conversationId}, ${eventStart}, ${ctx.workspaceId}, ${read.userId},
             ${read.runId}, ${read.generation}, ${read.accountEpoch}, 'assistant.final',
             ${JSON.stringify({
               messageId: assistantMessageId,
               textLength: assistantText.length,
               textSha256,
               messageContentSha256: contentSha256,
               ...(memoryContext.memoryRefs.length > 0
                 ? { memoryRefs: memoryContext.memoryRefs }
                 : {}),
             })}, ${expiresAt})
        `);

        // §11.3 voice.segment.ready（15b：已在 delta 过程/validate 后逐个下发，
        // 终态事务不再写段事件；此处仅保留 cue）。

        // 终态回复情绪 cue：本地确定性分类器（soullink MessageReactionClassifier
        // 思路迁移）从全文分类 emotion；中性/空文本回落 explain/neutral/0.30。
        // 分类失败不可能抛错（纯函数），故无需额外兜底分支。
        await insertStreamEvent(tx, {
          conversationId: read.conversationId,
          workspaceId: ctx.workspaceId,
          userId: read.userId,
          runId: read.runId,
          generation: read.generation,
          accountEpoch: read.accountEpoch,
          seq: eventStart + 1,
          type: "character.cue",
          payload: { cue: finalCue },
          expiresAt,
        });

        // run 终态 + prompt 元数据（§9.1：promptVersion 与 hash 一起写入）
        // waiting_proposal_id 必须一并清空：run 已终结，残留的挂起指针会让"仍在
        // 等待确认"的判据在终态 run 上继续成立（续跑与回收扫描都会被它误导）。
        //
        // `AND status IN ('accepted','running')` 是**状态栅栏**，不是装饰：
        // 用户在这几步里点了取消/换了一代，整轮随后就终结了；没有这道 WHERE，
        // 一个迟到的 final 会把 cancelled 覆盖成 succeeded，用户看到的是
        // 「她答完了」而他明明已经打断了（40b §3.3「取消不得落 completed」）。
        // 命中 0 行时下面整段都要让位——所以先取回 id 再继续写事件。
        const finished = await tx.execute<{ id: string }>(sql`
          UPDATE companion_turn_runs
          SET status = 'succeeded',
              assistant_message_id = ${assistantMessageId},
              waiting_proposal_id = NULL,
              provider_id = ${provider.id},
              model_id = ${provider.modelId},
              prompt_version = ${COMPANION_PERSONA_V14_PROMPT_ID},
              prompt_hash = ${COMPANION_PERSONA_V14_SHA256},
              finished_at = now()
          WHERE id = ${read.runId}
            AND status IN ('accepted', 'running')
          RETURNING id
        `);
        if (!finished[0]) {
          // 已经被取消或换代：本轮的正文**不再交付**。
          // 不是失败——取消路径已经写过 turn.cancelled，这里再写一遍会让用户
          // 同时看到"已取消"和一条本该没发出来的回复。
          logger.info(
            { runId: read.runId, jobId: ctx.id },
            "companion final answer dropped: run left the active states",
          );
          return;
        }

        const failureSpanScope = {
          workspaceId: ctx.workspaceId,
          userId: read.userId,
          runId: read.runId,
        };
        await recoverCompanionRunFailureSpanInTransaction(tx, failureSpanScope, "transport");
        await recoverCompanionRunFailureSpanInTransaction(tx, failureSpanScope, "output");
        await recoverCompanionRunFailureSpanInTransaction(tx, failureSpanScope, "delivery");
        await recoverCompanionRunFailureSpanInTransaction(tx, failureSpanScope, "execution");
        await recoverCompanionRunFailureSpanInTransaction(tx, failureSpanScope, "state");
        if (voiceSegmentsWritten) {
          await recoverCompanionRunFailureSpanInTransaction(tx, failureSpanScope, "tts");
        }

        const [publishedBeforeFinal] = read.initiativeInput ? await tx.execute(sql`SELECT 1 FROM companion_run_utterances WHERE run_id=${read.runId} LIMIT 1`) : [];
        if (read.initiativeInput && !publishedBeforeFinal) await enqueueSystemEventDelivery(tx, {
          workspaceId: ctx.workspaceId, userId: read.userId, systemEventId: `initiative:${assistantMessageId}`,
          text: assistantText, ttlHours: COMPANION_INITIATIVE_DELIVERY_TTL_HOURS, initiative: { conversationId: read.conversationId,
            messageId: assistantMessageId, runId: read.runId, generation: read.generation, deviceSessionId: read.initiativeInput.deviceSessionId },
        });
        if (read.userMessageId && !(read.pageContext as { context?: { replyPurpose?: string } } | null)?.context?.replyPurpose) await enqueueParticipationObservation(tx, { workspaceId: ctx.workspaceId, userId: read.userId }, {
          topic: "reply.finished", dedupeKey: `reply:${read.runId}`, conversationId: read.conversationId,
          parentRunId: read.runId, facts: { messageIds: [assistantMessageId] }, ttlMs: 120_000,
        });
        // 22 方案：终态事务内异步入队记忆提取/摘要任务。
        if (read.userMessageId) await enqueueCompanionFollowupSuggestions(tx, {
          workspaceId: ctx.workspaceId,
          userId: read.userId,
          runId: read.runId,
          assistantMessageId,
        });
        await enqueueCompanionMemoryJobs(tx, {
          workspaceId: ctx.workspaceId,
          userId: read.userId,
          runId: read.runId,
          conversationId: read.conversationId,
          messageSeq,
        });

        // 终态事务：该 run 全部 event 的 expires_at 原子改为 finished_at+24h
        await tx.execute(sql`
          UPDATE companion_stream_events
          SET expires_at = ${expiresAt}
          WHERE conversation_id = ${read.conversationId} AND run_id = ${read.runId}
        `);

        // §5.4 PostgreSQL wake-up（payload 只含 conversationId/maxSeq）。
        const maxSeq = eventStart + eventCount - 1;
        await notifyCompanionEvent(tx, maxSeq);
        logger.info(
          { runId: read.runId, messageId: assistantMessageId, seq: messageSeq },
          "companion dialogue run succeeded",
        );
        return true;
      },
    );
    if (!published) return;
    // §10.5 关系状态：对话成功完成一次 turn，familiarity +0.01（上限 1）、
    // interaction_count +1、刷新 last_active_at。独立事务 + 失败静默：
    // 关系状态是弱事实，绝不影响对话主链路（迁移 0178 前该 UPDATE 无权限也安全跳过）。
    try {
      await withWorkerWorkspaceTransaction(
        { workspaceId: ctx.workspaceId, userId: read.userId },
        async (tx) => {
          await tx.execute(sql`
            INSERT INTO pet_profiles (workspace_id, user_id, familiarity, interaction_count, last_active_at)
            VALUES (${ctx.workspaceId}, ${read.userId}, 0.01, 1, now())
            ON CONFLICT (workspace_id, user_id) DO UPDATE
            SET familiarity = LEAST(pet_profiles.familiarity + 0.01, 1),
                interaction_count = pet_profiles.interaction_count + 1,
                last_active_at = now(),
                updated_at = now()
          `);
        },
      );
    } catch (err) {
      logger.debug({ runId: read.runId, err }, "companion relationship bump skipped");
    }
  } catch (err) {
    // 写阶段失败：终态事务回滚，但前面已落库的 delta 仍然存在；显式
    // 投影 failed/error，避免 job retry/dead-letter 后 run 永久停在 running。
    logger.warn({ jobId: ctx.id, runId, err }, "companion_agent write phase failed");
    await markCompanionRunFailed(read, ctx, err instanceof CompanionContextChangedError ? err.code : "INTERNAL_ERROR",
      true, err instanceof CompanionContextChangedError ? err.message : "companion response commit failed", "delivery");
    await persistFailedPartial({
      workspaceId: ctx.workspaceId,
      userId: read.userId,
      conversationId: read.conversationId,
      runId: read.runId,
      deliveredText: streamingDelivery.deliveredText(),
    });
    throw err;
  }
}
