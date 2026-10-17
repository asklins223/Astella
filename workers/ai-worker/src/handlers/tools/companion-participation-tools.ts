import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { readParticipationPreferences, writeParticipationPreferences, readCompanionAwareness,
  listCompanionAttention, arrangeCompanionAttention, enqueueParticipationObservation, AgentStoreError } from "@astella/agent-host";
import { companionParticipationToolWriteV1Schema, companionAttentionWriteV1Schema,
  companionPublishUtteranceV1Schema, companionFinishParticipationV1Schema,
  COMPANION_INITIATIVE_DELIVERY_TTL_HOURS } from "@astella/shared/companion-initiative-contracts";
import { canonicalJsonV1, sha256Utf8V1 } from "@astella/shared/content-hash";
import type { ProviderReasoningHandle } from "@astella/shared";
import { withWorkerWorkspaceTransaction } from "../../db.ts";
import { lockJobLease } from "../../lib/job-lease.ts";
import { assertCompanionContextSourcesCurrent } from "../context/companion-context-sources.ts";
import { isCompanionParticipationClosure, repeatsCompanionParentReply } from "../proactive/companion-participation-output.ts";
import { validateCompanionOutput, finalizeCompanionReplyText, companionAssistantMessageKind, textOfCompanionBlocks } from "../turn/companion-dialogue-content.ts";
import { insertStreamEvent, enqueueCompanionMemoryJobs, type CompanionDialogueHandlerContext, type ReadContext } from "../turn/companion-dialogue-store.ts";
import { enqueueSystemEventDelivery } from "../agent/companion-delivery-write.ts";
import type { AgentEventContext } from "./companion-read-tools.ts";
import { CompanionToolBlockedError, CompanionToolError, CompanionToolNotExecutedError, type AgentToolExecutionResult } from "./companion-tool-result.ts";

export async function executeCompanionParticipationTool(event: AgentEventContext, name: string,
  args: Record<string, unknown>, toolCallId?: string): Promise<AgentToolExecutionResult> {
  const scope = { workspaceId: event.ctx.workspaceId, userId: event.read.userId };
  if (name === "companion_finish_participation") {
    if (!event.read.initiativeInput) throw new CompanionToolBlockedError("这是内部主动考虑的结束能力，当前用户提问仍需要完整回答。");
    companionFinishParticipationV1Schema.parse(args);
    return { value: { decision: "silent", completed: true }, safeSummary: "本次考虑已结束。" };
  }
  if (name === "companion_read_participation") {
    const value = await withWorkerWorkspaceTransaction(scope, async tx => ({
      preferences: await readParticipationPreferences(tx, scope), awareness: await readCompanionAwareness(tx, scope),
      attention: await listCompanionAttention(tx, scope),
    }));
    return { value, safeSummary: "已读到相处偏好、实际情境和关注安排。" };
  }
  if (name === "companion_publish_utterance") {
    if (!toolCallId) throw new CompanionToolError("这条发言缺少实际身份。");
    const page = event.read.pageContext as { context?: { pageKind?: string; replyPurpose?: string; annotationTarget?: { requestId: string } }; selection?: unknown } | null;
    if (!page?.context?.annotationTarget && (page?.context?.replyPurpose || (page?.context?.pageKind === "note" && page.selection)))
      throw new CompanionToolNotExecutedError("这轮内容需要完整保存到笔记。请用连续最终正文交付完整解释，不逐句发布。");
    if (event.read.initiativeInput?.facts.canSpeak === false) throw new CompanionToolBlockedError("用户现在不在可参与的前台，保留这次考虑，不直接发言。");
    const parsed = companionPublishUtteranceV1Schema.parse(args);
    if (page?.context?.annotationTarget && parsed.final !== false) {
      const [saved] = await withWorkerWorkspaceTransaction(scope, tx => tx.execute<{ id: string }>(sql`SELECT id FROM note_annotations
        WHERE id=${page.context!.annotationTarget!.requestId} AND workspace_id=${scope.workspaceId}
          AND user_id=${scope.userId} AND generation_job_id=${event.ctx.id}`));
      if (!saved) throw new CompanionToolNotExecutedError("先用 companion_write_annotation 写入完整解释，再结束这轮交流。发言不能代替批注。");
    }
    if (isCompanionParticipationClosure(parsed.text))
      throw new CompanionToolNotExecutedError("执行收尾不需要发给用户。没有新内容时返回空 content 安静结束。");
    const rawText = finalizeCompanionReplyText({ text: parsed.text, factSpans: event.read.factSpans?.values ?? null, runId: event.read.runId }).text;
    const validated = validateCompanionOutput(rawText);
    if (!validated.ok) throw new CompanionToolError("这条发言未通过正文校验，请修正后再说。");
    const text = validated.text;
    if (await companionFollowupRepeatsParent(event.read, scope, text))
      throw new CompanionToolNotExecutedError("这段内容在刚完成的回答中已经说过。答后考虑只发布新的有用内容，否则安静结束。");
    event.verifyUtterance?.(text);
    const published = await withWorkerWorkspaceTransaction(scope, async tx => {
      await lockJobLease(tx, event.ctx);
      await assertCompanionContextSourcesCurrent(tx, scope, event.read.runId);
      const [already] = await tx.execute<{ message_id: string }>(sql`SELECT message_id FROM companion_run_utterances
        WHERE run_id=${event.read.runId} AND tool_call_id=${toolCallId}`);
      if (already) return { messageId: already.message_id, fresh: false };
      const [alive] = await tx.execute(sql`UPDATE companion_turn_runs SET updated_at=now()
        WHERE id=${event.read.runId} AND generation=${event.read.generation} AND status IN ('accepted','running')
          AND EXISTS(SELECT 1 FROM user_companion_account_state a WHERE a.user_id=${scope.userId}
            AND a.global_enabled AND a.epoch=${event.read.accountEpoch}) RETURNING id`);
      if (!alive) throw new CompanionToolBlockedError("用户已经接话或结束这轮，这条内容没有继续发布。");
      // 这一轮的失控形状是「把同一句再说一遍」，不是说到第几条。原来按 40 条砍，
      // 一条把意思讲完的长交流也会在半句上被拦（2026-10-13 用户决定：不设写死的输出条数）。
      const messageId = randomUUID(), blocks = [{ type: "text", text }];
      const contentSha256 = sha256Utf8V1(canonicalJsonV1(blocks));
      const spoken = await tx.execute<{ content_sha256: string }>(sql`SELECT m.content_sha256 FROM companion_run_utterances u
        JOIN companion_messages m ON m.id=u.message_id WHERE u.run_id=${event.read.runId}`);
      if (spoken.some(row => row.content_sha256 === contentSha256))
        throw new CompanionToolNotExecutedError("这句话这轮已经说过了。要说新的意思，或者收尾。");
      const [counter] = await tx.execute<{ message_seq: string; event_seq: string }>(sql`UPDATE companion_conversations
        SET next_message_seq=next_message_seq+1,next_event_seq=next_event_seq+1,last_message_at=now(),updated_at=now()
        WHERE id=${event.read.conversationId} RETURNING (next_message_seq-1)::text AS message_seq,(next_event_seq-1)::text AS event_seq`);
      // 主动发言也是 assistant 消息：下一轮若以它收尾（主动轮的常态），网关要求交回
      // 产出它的那一步的 reasoning_text（0435）。账本在本轮早些时候已按 tool_call_id
      // 存下句柄，这里原样取回挂到消息上，不另开一条通路。
      const [utteranceReasoning] = await tx.execute<{ reasoning_handles: ProviderReasoningHandle[] | null }>(sql`
        SELECT reasoning_handles FROM companion_agent_tool_calls
        WHERE run_id=${event.read.runId} AND tool_call_id=${toolCallId}`);
      const utteranceReasoningHandles = utteranceReasoning?.reasoning_handles ?? null;
      await tx.execute(sql`INSERT INTO companion_messages(id,workspace_id,user_id,conversation_id,seq,role,kind,blocks,run_id,content_sha256,reasoning)
        VALUES(${messageId},${scope.workspaceId},${scope.userId},${event.read.conversationId},${Number(counter!.message_seq)},
          'assistant',${companionAssistantMessageKind(event.read)},${JSON.stringify(blocks)}::jsonb,${event.read.runId},${contentSha256},
          ${utteranceReasoningHandles && utteranceReasoningHandles.length > 0 ? JSON.stringify(utteranceReasoningHandles) : null}::jsonb)`);
      await tx.execute(sql`INSERT INTO companion_run_utterances(workspace_id,user_id,run_id,tool_call_id,message_id)
        VALUES(${scope.workspaceId},${scope.userId},${event.read.runId},${toolCallId},${messageId})`);
      await insertStreamEvent(tx, { ...scope, conversationId: event.read.conversationId, runId: event.read.runId,
        generation: event.read.generation, accountEpoch: event.read.accountEpoch, seq: Number(counter!.event_seq),
        type: "assistant.utterance", payload: { messageId, messageSeq: Number(counter!.message_seq), text,
          proactive: Boolean(event.read.initiativeInput), deviceSessionId: event.read.initiativeInput?.deviceSessionId ?? null }, expiresAt: event.expiresAt });
      await tx.execute(sql`UPDATE companion_turn_runs SET last_event_seq=${Number(counter!.event_seq)} WHERE id=${event.read.runId}`);
      await tx.execute(sql`SELECT pg_notify('astella_companion_events_v1',${JSON.stringify({ conversationId: event.read.conversationId, maxSeq: Number(counter!.event_seq) })})`);
      if (event.read.initiativeInput && spoken.length === 0) await enqueueSystemEventDelivery(tx, { ...scope,
        systemEventId: `initiative:${messageId}`, text, ttlHours: COMPANION_INITIATIVE_DELIVERY_TTL_HOURS,
        initiative: { conversationId: event.read.conversationId, messageId, runId: event.read.runId, generation: event.read.generation,
          deviceSessionId: event.read.initiativeInput.deviceSessionId } });
      return { messageId, fresh: true };
    });
    if (published.fresh) await event.onUtterancePublished?.(published.messageId, text, rawText);
    return { value: { messageId: published.messageId, published: true }, safeSummary: "这条发言已经说出并保留在交流里。" };
  }
  const value = await withWorkerWorkspaceTransaction(scope, async tx => {
    await lockJobLease(tx, event.ctx);
    await assertCompanionContextSourcesCurrent(tx, scope, event.read.runId);
    if (name === "companion_arrange_attention") return arrangeCompanionAttention(tx, scope,
      companionAttentionWriteV1Schema.parse(args), { conversationId: event.read.conversationId, runId: event.read.runId });
    if (name === "companion_save_participation") {
      if (!event.read.userMessageId || event.read.initiativeInput)
        throw new CompanionToolBlockedError("内部关注不能替用户修改相处偏好。");
      const input = companionParticipationToolWriteV1Schema.parse(args);
      const [message] = await tx.execute<{ blocks: Array<{ type: string; text?: string }> }>(sql`SELECT blocks FROM companion_messages
        WHERE id=${event.read.userMessageId} AND conversation_id=${event.read.conversationId} AND role='user'`);
      const original = message?.blocks.filter(b => b.type === "text").map(b => b.text ?? "").join("\n") ?? "";
      if (!original.includes(input.sourceQuote)) throw new CompanionToolBlockedError("保存依据须是本轮用户的真实原话。");
      return writeParticipationPreferences(tx, scope, { ...input, source: { kind: "user_message",
        workspaceId: scope.workspaceId, messageId: event.read.userMessageId, quote: input.sourceQuote } });
    }
    throw new CompanionToolError("没有这项参与能力。");
  }).catch(error => {
    // These store guards reject before commit. Report their actual outcome so
    // the agent can read/correct a version instead of assuming an unknown write.
    if (error instanceof AgentStoreError) throw new CompanionToolNotExecutedError(error.message);
    throw error;
  });
  return { value, safeSummary: !value.changed
    ? "已核对：当前状态已经满足，无需变更；版本、依据和原有安排均未改动。"
    : name === "companion_save_participation" ? "已经记住这次明确的相处偏好。" : "关注安排已保存；触发时会结合情境重新考虑。" };
}

/** Both explicit utterances and bare final answers share the same follow-up publication boundary. */
export async function companionFollowupRepeatsParent(read: Pick<ReadContext, "initiativeInput" | "conversationId">,
  scope: { workspaceId: string; userId: string }, text: string): Promise<boolean> {
  const input = read.initiativeInput;
  if (input?.topic !== "reply.finished" || !input.parentRunId) return false;
  const replies = await withWorkerWorkspaceTransaction(scope, tx => tx.execute<{ blocks: unknown }>(sql`
    SELECT blocks FROM companion_messages WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
      AND conversation_id=${read.conversationId} AND run_id=${input.parentRunId} AND role='assistant' ORDER BY seq`));
  return repeatsCompanionParentReply(text, replies.map(reply => textOfCompanionBlocks(reply.blocks)));
}

/** Silence and already-published speech are successful outcomes of a bounded participation. */
export async function finishCompanionParticipation(ctx: CompanionDialogueHandlerContext, read: ReadContext,
  expiresAt: string): Promise<void> {
  const scope = { workspaceId: ctx.workspaceId, userId: read.userId };
  await withWorkerWorkspaceTransaction(scope, async tx => {
    await lockJobLease(tx, ctx);
    await assertCompanionContextSourcesCurrent(tx, scope, read.runId);
    const messages = await tx.execute<{ message_id: string; seq: string }>(sql`SELECT u.message_id,m.seq::text AS seq
      FROM companion_run_utterances u JOIN companion_messages m ON m.id=u.message_id
      WHERE u.run_id=${read.runId} ORDER BY m.seq`);
    const last = messages.at(-1);
    const [done] = await tx.execute(sql`UPDATE companion_turn_runs SET status='succeeded',assistant_message_id=${last?.message_id ?? null},
      finished_at=now(),updated_at=now() WHERE id=${read.runId} AND generation=${read.generation}
      AND status IN ('accepted','running') RETURNING id`);
    if (!done) return;
    const [counter] = await tx.execute<{ seq: string }>(sql`UPDATE companion_conversations SET next_event_seq=next_event_seq+1
      WHERE id=${read.conversationId} RETURNING (next_event_seq-1)::text AS seq`);
    await insertStreamEvent(tx, { ...scope, conversationId: read.conversationId, runId: read.runId, generation: read.generation,
      accountEpoch: read.accountEpoch, seq: Number(counter!.seq), type: "turn.completed",
      payload: { messageIds: messages.map(m => m.message_id), silent: !messages.length }, expiresAt });
    await tx.execute(sql`UPDATE companion_turn_runs SET last_event_seq=${Number(counter!.seq)} WHERE id=${read.runId}`);
    await tx.execute(sql`SELECT pg_notify('astella_companion_events_v1',${JSON.stringify({ conversationId: read.conversationId, maxSeq: Number(counter!.seq) })})`);
    if (last) await enqueueCompanionMemoryJobs(tx, { ...scope, runId: read.runId, conversationId: read.conversationId, messageSeq: Number(last.seq) });
    if (read.userMessageId && last && !(read.pageContext as { context?: { replyPurpose?: string } } | null)?.context?.replyPurpose) await enqueueParticipationObservation(tx, scope, { topic: "reply.finished",
      dedupeKey: `reply:${read.runId}`, conversationId: read.conversationId, parentRunId: read.runId,
      facts: { messageIds: messages.map(m => m.message_id) }, ttlMs: 120_000 });
  });
}
