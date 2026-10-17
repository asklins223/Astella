import { sql } from "drizzle-orm";
import { readJobPayloadString } from "@astella/shared";
import { lockCompanionRunForEventWrite } from "@astella/shared/companion-lock-order";
import { createProvider } from "../../lib/ai-provider.ts";
import {
  createGovernedProvider,
  resolveAIGovernanceContext,
  resolveProviderForTask,
} from "../../lib/governance.ts";
import { assertJobLease, lockJobLease, withJobTransaction } from "../../lib/job-lease.ts";
import { logger } from "../../lib/logger.ts";
import { reserveCompanionFollowupProviderCall } from "../agent/companion-agent-events.ts";
import { textOfCompanionBlocks } from "../turn/companion-dialogue-content.ts";
import { generateCompanionFollowupPrompts } from "../proactive/companion-followup-suggestions.ts";
import { insertStreamEvent } from "../turn/companion-dialogue-store.ts";
import type { JobPayload } from ".././index.ts";

interface FollowupContext {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  generation: number;
  accountEpoch: number;
  userText: string;
  assistantText: string;
}

function companionJobContext(job: JobPayload) {
  return {
    id: job.id,
    workspaceId: job.workspaceId,
    requestedBy: job.requestedBy,
    payload: job.payload,
    leaseToken: job.leaseToken,
    signal: job.signal ?? new AbortController().signal,
  };
}

/** Best-effort post-turn generation: the answer has already reached its terminal state. */
export async function runCompanionFollowupSuggestions(job: JobPayload): Promise<void> {
  const runId = readJobPayloadString(job.payload, "runId");
  const payloadUserId = readJobPayloadString(job.payload, "userId");
  const assistantMessageId = readJobPayloadString(job.payload, "assistantMessageId");
  const userId = job.requestedBy;
  if (!runId || !payloadUserId || !assistantMessageId || !userId || payloadUserId !== userId) {
    throw new Error("companion_followup_suggestions payload is incomplete or actor-mismatched");
  }
  await assertJobLease(job);

  const context = await withJobTransaction(job, async (tx) => {
    const rows = await tx.execute<{
      conversation_id: string;
      user_message_id: string;
      assistant_message_id: string;
      generation: number;
      account_epoch: number;
      user_blocks: unknown;
      assistant_blocks: unknown;
      follow_up_prompts: unknown;
    }>(sql`
      SELECT r.conversation_id, r.user_message_id, r.assistant_message_id,
             r.generation, r.account_epoch, u.blocks AS user_blocks, a.blocks AS assistant_blocks,
             a.follow_up_prompts
      FROM companion_turn_runs r
      JOIN companion_messages u ON u.id = r.user_message_id AND u.role = 'user'
      JOIN companion_messages a ON a.id = r.assistant_message_id AND a.role = 'assistant'
      WHERE r.id = ${runId} AND r.workspace_id = ${job.workspaceId} AND r.user_id = ${userId}
        AND r.status = 'succeeded' AND r.assistant_message_id = ${assistantMessageId}
        AND NOT EXISTS (
          SELECT 1 FROM companion_stream_events e
          WHERE e.run_id = r.id AND e.type = 'assistant.followups.ready'
            AND e.payload->>'messageId' = a.id::text
        )
    `);
    const row = rows[0];
    if (!row) return null;
    const assistantBlocks = Array.isArray(row.assistant_blocks) ? row.assistant_blocks : [];
    if ((Array.isArray(row.follow_up_prompts) && row.follow_up_prompts.length > 0)
      || assistantBlocks.some((block) => block && typeof block === "object"
      && (block as { type?: unknown }).type === "follow_up_suggestions")) return null;
    return {
      conversationId: row.conversation_id,
      userMessageId: row.user_message_id,
      assistantMessageId: row.assistant_message_id,
      generation: row.generation,
      accountEpoch: row.account_epoch,
      userText: textOfCompanionBlocks(row.user_blocks),
      assistantText: textOfCompanionBlocks(row.assistant_blocks),
    } satisfies FollowupContext;
  });
  if (!context || !context.userText.trim() || !context.assistantText.trim()) return;

  const governance = await resolveAIGovernanceContext(job.workspaceId, userId);
  let prompts: string[];
  if (!governance.consentOk || (governance.providerName !== "mock" && !governance.policy.sendToExternal)) {
    logger.info({ jobId: job.id, runId }, "companion follow-ups skipped because current AI consent does not allow generation");
    prompts = [];
  } else {
    const textProvider = resolveProviderForTask(governance, "companion_agent");
    const callContext = companionJobContext(job);
    const read = {
      userId,
      runId,
      accountEpoch: context.accountEpoch,
      generation: context.generation,
    };
    const provider = createGovernedProvider(
      createProvider(textProvider.providerName, {
        ...textProvider.providerConfig,
        sessionId: context.conversationId,
      }),
      governance,
      job.workspaceId,
      {
        userId,
        operation: "companion_followup_suggestions",
        jobId: job.id,
        dataCategories: ["user_answer", "note_content"],
        reserveCall: () => reserveCompanionFollowupProviderCall({
          ctx: callContext,
          read,
          assistantMessageId: context.assistantMessageId,
        }),
      },
    );
    try {
      prompts = await generateCompanionFollowupPrompts({
        provider,
        userText: context.userText,
        assistantText: context.assistantText,
        signal: job.signal ?? new AbortController().signal,
      });
    } catch (error) {
      if (job.signal?.aborted) throw error;
      logger.info({
        jobId: job.id,
        runId,
        errorName: error instanceof Error ? error.name : "unknown",
      }, "companion follow-up suggestions unavailable; keeping completed reply unchanged");
      prompts = [];
    }
  }
  await withJobTransaction(job, async (tx) => {
    await lockJobLease(tx, job);
    // 锁序规约：先 run 行、后会话计数器（见 @astella/shared/companion-lock-order）。
    // 本事务末尾要 `UPDATE companion_turn_runs SET last_event_seq`，而计数器在中间；
    // 原来 run 行锁是最后才拿，与「先锁 run 再拿计数器」的流式路径并发即 AB-BA
    // （2026-10-14 dev 库实测两例死锁）。
    await lockCompanionRunForEventWrite(tx, runId);
    const rows = await tx.execute<{ blocks: unknown; follow_up_prompts: unknown; content_sha256: string }>(sql`
      SELECT m.blocks, m.follow_up_prompts, m.content_sha256
      FROM companion_messages m
      JOIN companion_turn_runs r ON r.assistant_message_id = m.id
      WHERE m.id = ${context.assistantMessageId} AND m.conversation_id = ${context.conversationId}
        AND m.workspace_id = ${job.workspaceId} AND m.user_id = ${userId}
        AND m.role = 'assistant' AND r.id = ${runId} AND r.status = 'succeeded'
      FOR UPDATE OF m
    `);
    const currentBlocks = rows[0]?.blocks;
    if (!Array.isArray(currentBlocks) || currentBlocks.some((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "follow_up_suggestions")) return;
    if (Array.isArray(rows[0].follow_up_prompts) && rows[0].follow_up_prompts.length > 0) return;

    const contentSha256 = rows[0].content_sha256;
    if (prompts.length > 0) {
      await tx.execute(sql`
        UPDATE companion_messages
        SET follow_up_prompts = ${JSON.stringify(prompts)}::jsonb
        WHERE id = ${context.assistantMessageId} AND workspace_id = ${job.workspaceId}
          AND user_id = ${userId} AND role = 'assistant'
          AND follow_up_prompts = '[]'::jsonb
      `);
    }

    const counters = await tx.execute<{ next_event_seq: string }>(sql`
      UPDATE companion_conversations
      SET next_event_seq = next_event_seq + 1
      WHERE id = ${context.conversationId} AND workspace_id = ${job.workspaceId} AND user_id = ${userId}
      RETURNING next_event_seq
    `);
    const nextEventSeq = Number(counters[0]?.next_event_seq);
    if (!Number.isSafeInteger(nextEventSeq) || nextEventSeq < 2) {
      throw new Error("companion follow-up event counter update returned no row");
    }
    const seq = nextEventSeq - 1;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    await insertStreamEvent(tx, {
      conversationId: context.conversationId,
      workspaceId: job.workspaceId,
      userId,
      runId,
      generation: context.generation,
      accountEpoch: context.accountEpoch,
      seq,
      type: "assistant.followups.ready",
      payload: {
        messageId: context.assistantMessageId,
        messageContentSha256: contentSha256,
        followUpPrompts: prompts,
      },
      expiresAt,
    });
    await tx.execute(sql`
      UPDATE companion_turn_runs SET last_event_seq = ${seq}, updated_at = now()
      WHERE id = ${runId} AND generation = ${context.generation}
    `);
    await tx.execute(sql`
      SELECT pg_notify('astella_companion_events_v1',
        ${JSON.stringify({ conversationId: context.conversationId, maxSeq: seq })})
    `);
  });
}
