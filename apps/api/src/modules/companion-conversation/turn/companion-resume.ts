import { sql } from "drizzle-orm";
import { companionChatResumeRunRequestV1Schema, canResumeCompanionRun,
  type CompanionChatResumeRunResultV1 } from "@astella/shared/companion-chat-desktop-contracts";
import { sha256Utf8V1 } from "@astella/shared/content-hash";
import { withWorkspaceTransaction } from "../../../db/client.ts";
import { createJob } from "../../job/service.ts";
import { CompanionConversationError } from "./turn-service.ts";
import { reconcileCompanionSavedNotes } from "@astella/agent-host";

type Run = { id: string; conversation_id: string; user_message_id: string | null; job_id: string | null;
  generation: number; account_epoch: number; status: CompanionChatResumeRunResultV1["status"];
  error_code: string | null; last_event_seq: string; step_count: number; tool_call_count: number };

/** Resume the frozen request, not a newly invented user message. The old lease
 * is retired atomically with the replacement job so late writes stay fenced. */
export async function resumeCompanionRun(args: { workspaceId: string; userId: string; runId: string; body: unknown }): Promise<{ statusCode: number; body: CompanionChatResumeRunResultV1 }> {
  const parsed = companionChatResumeRunRequestV1Schema.omit({ runId: true }).safeParse(args.body);
  if (!parsed.success) throw new CompanionConversationError("INVALID_REQUEST", 400, "resume request invalid");
  const request = parsed.data;
  return withWorkspaceTransaction({ workspaceId: args.workspaceId, userId: args.userId }, async tx => {
    const [scope] = await tx.execute<{ conversation_id: string }>(sql`SELECT conversation_id FROM companion_turn_runs
      WHERE id=${args.runId} AND workspace_id=${args.workspaceId} AND user_id=${args.userId}`);
    if (!scope) throw new CompanionConversationError("NOT_FOUND", 404, "run not found");
    // Match the lifecycle's run -> conversation -> job -> steps lock order.
    await tx.execute(sql`SELECT id FROM companion_turn_runs WHERE conversation_id=${scope.conversation_id}
      AND (id=${args.runId} OR status IN ('accepted','running','waiting_for_confirmation','cancel_requested'))
      ORDER BY id FOR NO KEY UPDATE`);
    const [conversation] = await tx.execute<{ id: string }>(sql`SELECT id FROM companion_conversations
      WHERE id=${scope.conversation_id} AND status='active' AND workspace_id=${args.workspaceId}
        AND user_id=${args.userId} FOR UPDATE`);
    if (!conversation) throw new CompanionConversationError("NOT_FOUND", 404, "conversation unavailable");
    const [run] = await tx.execute<Run>(sql`SELECT id,conversation_id,user_message_id,job_id,generation,account_epoch,
      status,error_code,last_event_seq,step_count,tool_call_count FROM companion_turn_runs WHERE id=${args.runId}`);
    if (!run || run.generation !== request.generation)
      throw new CompanionConversationError("STALE_GENERATION", 409, "run generation changed");
    const response = (statusCode: number) => ({ statusCode, body: { version: 1 as const,
      conversationId: run.conversation_id, runId: run.id, generation: run.generation,
      status: run.status, eventCursor: Number(run.last_event_seq) } });
    if (request.reconcileOnly) {
      if (!["failed", "succeeded", "cancelled"].includes(run.status))
        throw new CompanionConversationError("RUN_ALREADY_ACTIVE", 409, "wait until the current operation settles");
      const checked = await reconcileCompanionSavedNotes(tx, { workspaceId: args.workspaceId, userId: args.userId, runId: run.id });
      for (const saved of checked.resolved) {
        const [counter] = await tx.execute<{ next_event_seq: string }>(sql`UPDATE companion_conversations
          SET next_event_seq=next_event_seq+1 WHERE id=${run.conversation_id} RETURNING next_event_seq`);
        const seq = Number(counter!.next_event_seq) - 1;
        const tool = { toolCallId: saved.toolCallId, name: saved.name, toolVersion: saved.toolVersion,
          riskClass: saved.riskClass, status: "succeeded", safeLabel: saved.receipt.kind === "created_note" ? "保存笔记" : "修改笔记", safeSummary: "已核对，笔记已经保存",
          ...(saved.receipt.kind === "created_note" ? { noteCreated: saved.receipt } : { noteEdit: saved.receipt }), occurredAt: new Date().toISOString() };
        const payload = { tool };
        await tx.execute(sql`INSERT INTO companion_stream_events
          (conversation_id,seq,workspace_id,user_id,run_id,generation,account_epoch,type,payload,expires_at)
          VALUES (${run.conversation_id},${seq},${args.workspaceId},${args.userId},${run.id},${run.generation},
            ${run.account_epoch},'agent.tool',${JSON.stringify(payload)}::jsonb,now()+interval '24 hours')`);
        run.last_event_seq = String(seq);
      }
      if (checked.resolved.length) {
        await tx.execute(sql`UPDATE companion_turn_runs SET last_event_seq=${Number(run.last_event_seq)},updated_at=now() WHERE id=${run.id}`);
        await tx.execute(sql`SELECT pg_notify('astella_companion_events_v1',${JSON.stringify({ conversationId: run.conversation_id, maxSeq: Number(run.last_event_seq) })})`);
      }
      return { statusCode: 200, body: { ...response(200).body,
        reconciledCount: checked.resolved.length, unresolvedCount: checked.unresolvedCount } };
    }
    const key = `companion-resume:${run.id}:${request.expectedEventCursor}`;
    const [replayed] = await tx.execute<{ id: string }>(sql`SELECT id FROM jobs WHERE idempotency_key=${key}
      AND workspace_id=${args.workspaceId} AND requested_by=${args.userId} AND id=${run.job_id}`);
    if (replayed) return response(200);
    if (Number(run.last_event_seq) !== request.expectedEventCursor)
      throw new CompanionConversationError("STALE_GENERATION", 409, "run changed; refresh before continuing");
    const [latest] = await tx.execute<{ generation: number }>(sql`SELECT generation FROM companion_turn_runs
      WHERE conversation_id=${run.conversation_id} ORDER BY generation DESC LIMIT 1`);
    if (latest?.generation !== run.generation)
      throw new CompanionConversationError("STALE_GENERATION", 409, "a newer request owns this conversation");
    if (!run.user_message_id || !canResumeCompanionRun({ status: run.status, errorCode: run.error_code }))
      throw new CompanionConversationError("ACTION_STALE", 409, "this run cannot be resumed");
    const [account] = await tx.execute<{ epoch: number }>(sql`SELECT epoch FROM user_companion_account_state
      WHERE user_id=${args.userId} AND global_enabled AND epoch=${run.account_epoch}`);
    if (!account) throw new CompanionConversationError("CONTEXT_STALE", 409, "companion authorization changed");
    const [step] = await tx.execute<{ id: string; runtime_checkpoint: { stateJson?: string; stateSha256?: string } | null }>(sql`
      SELECT id,runtime_checkpoint FROM companion_agent_steps WHERE run_id=${run.id} ORDER BY step_no DESC LIMIT 1`);
    let phase: string | null = null;
    if (step?.runtime_checkpoint) {
      const saved = step.runtime_checkpoint;
      try {
        if (typeof saved.stateJson !== "string" || sha256Utf8V1(saved.stateJson) !== saved.stateSha256) throw new Error();
        phase = JSON.parse(saved.stateJson).phase;
      } catch { throw new CompanionConversationError("CONTEXT_STALE", 409, "recovery checkpoint is unavailable"); }
      if (!["input", "continue", "settled"].includes(phase ?? ""))
        throw new CompanionConversationError("ACTION_STALE", 409, "recovery is waiting for another action");
    } else if (run.step_count > 0 || run.tool_call_count > 0) {
      throw new CompanionConversationError("CONTEXT_STALE", 409, "cannot safely reconstruct completed work");
    }
    if (run.job_id) {
      const [retired] = await tx.execute<{ allowed: boolean }>(sql`SELECT astella_retire_companion_resume_job_v1(${run.id},${run.job_id}) AS allowed`);
      if (!retired?.allowed) throw new CompanionConversationError("CONTEXT_STALE", 409, "prior attempt could not be retired");
    }
    const job = await createJob({ workspaceId: args.workspaceId, requestedBy: args.userId,
      type: "companion_agent", idempotencyKey: key, payload: { runId: run.id, resumeFromEventSeq: request.expectedEventCursor } });
    await tx.execute(sql`UPDATE companion_turn_runs SET status='accepted',job_id=${job.id},error_code=NULL,
      finished_at=NULL,updated_at=now() WHERE id=${run.id}`);
    if (step && phase === "input") await tx.execute(sql`UPDATE companion_agent_steps SET status='running',
      error_code=NULL,finished_at=NULL WHERE id=${step.id}`);
    const [counter] = await tx.execute<{ next_event_seq: string }>(sql`UPDATE companion_conversations
      SET next_event_seq=next_event_seq+1 WHERE id=${run.conversation_id} RETURNING next_event_seq`);
    const seq = Number(counter!.next_event_seq) - 1;
    await tx.execute(sql`INSERT INTO companion_stream_events
      (conversation_id,seq,workspace_id,user_id,run_id,generation,account_epoch,type,payload,expires_at)
      SELECT ${run.conversation_id},${seq},${args.workspaceId},${args.userId},${run.id},${run.generation},${run.account_epoch},
        'turn.accepted',jsonb_build_object('clientMessageId',client_message_id,'userMessageId',id,'status','accepted','resumed',true),'infinity'::timestamptz
      FROM companion_messages WHERE id=${run.user_message_id}`);
    await tx.execute(sql`UPDATE companion_turn_runs SET last_event_seq=${seq} WHERE id=${run.id}`);
    await tx.execute(sql`SELECT pg_notify('astella_companion_events_v1',${JSON.stringify({ conversationId: run.conversation_id, maxSeq: seq })})`);
    run.status = "accepted"; run.last_event_seq = String(seq);
    return response(202);
  });
}
