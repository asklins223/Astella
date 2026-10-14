import { isWithinQuietHours, proactiveCadenceMs, routineCadenceBlocked } from "@astella/shared/companion-proactive-policy";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { readParticipationPreferences, readCompanionAwareness, listCompanionAttention } from "@astella/agent-host";
import { companionInitiativeInputV1Schema } from "@astella/shared/companion-initiative-contracts";
import { isCompanionDefaultParticipationOpportunity } from "@astella/shared/companion-default-participation";
import { companionInitiativePushKind } from "./companion-initiative-observation.ts";
import { sha256Utf8V1 } from "@astella/shared/content-hash";
import { withWorkerWorkspaceTransaction } from "../db.ts";
import { resolveAIGovernanceContext } from "../lib/governance.ts";
import { lockJobLease } from "../lib/job-lease.ts";
import { findFormalAnswerTarget } from "../lib/formal-answer-signal.ts";
import type { WorkerTransaction } from "../db.ts";
import type { CompanionDialogueHandlerContext } from "./companion-dialogue-store.ts";

/** Preserve a due intention while yielding to the user; no model is called during deferral. */
async function deferParticipation(tx: WorkerTransaction, ctx: CompanionDialogueHandlerContext, delayMs: number) {
  if (typeof ctx.payload.attentionKey === "string") {
    await tx.execute(sql`UPDATE companion_attention_plans SET next_review_at=now()+${delayMs}*interval '1 millisecond'
      WHERE workspace_id=${ctx.workspaceId} AND user_id=${ctx.requestedBy} AND entry_key=${ctx.payload.attentionKey}
        AND revision=${Number(ctx.payload.attentionRevision)} AND state='active' AND next_review_at IS NULL`);
  } else if (typeof ctx.payload.selfNoteKey === "string") {
    await tx.execute(sql`UPDATE companion_self_notes SET next_review_at=now()+${delayMs}*interval '1 millisecond'
      WHERE workspace_id=${ctx.workspaceId} AND user_id=${ctx.requestedBy} AND entry_key=${ctx.payload.selfNoteKey}
        AND revision=${Number(ctx.payload.selfNoteRevision)} AND NOT user_disabled AND tier<>'archived' AND next_review_at IS NULL`);
  } else if (typeof ctx.payload.observationId === "string") {
    await tx.execute(sql`INSERT INTO jobs(type,workspace_id,requested_by,payload,status,priority,resource_class,scheduled_at,idempotency_key)
      SELECT 'companion_initiative',${ctx.workspaceId},${ctx.requestedBy},${JSON.stringify(ctx.payload)}::jsonb,'pending',25,'maintenance',
        now()+${delayMs}*interval '1 millisecond',${`companion-initiative-defer:${ctx.id}`}
      FROM companion_awareness_observations WHERE id=${ctx.payload.observationId}::uuid AND workspace_id=${ctx.workspaceId}
        AND user_id=${ctx.requestedBy} AND expires_at>now()+${delayMs}*interval '1 millisecond'
      ON CONFLICT(workspace_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`);
  }
}

/** Preparation only. Model work is accepted by the existing companion_agent queue and runtime. */
export async function runCompanionInitiative(ctx: CompanionDialogueHandlerContext): Promise<void> {
  if (!ctx.requestedBy || ctx.signal.aborted) return;
  const scope = { workspaceId: ctx.workspaceId, userId: ctx.requestedBy };
  const governance = await resolveAIGovernanceContext(scope.workspaceId, scope.userId);
  if (!governance.consentOk || (governance.providerName !== "mock" && !governance.policy.sendToExternal)) return;
  await withWorkerWorkspaceTransaction(scope, async tx => {
    await lockJobLease(tx, ctx);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`companion-initiative:${scope.userId}`},0))`);
    const [account] = await tx.execute<{ epoch: number; global_enabled: boolean; intervention_level: string | null; presence: { presence?: string } | null; quiet_hours: import("@astella/shared/companion-proactive-policy").CompanionQuietHours | null }>(
      sql`SELECT epoch,global_enabled,intervention_level,presence,quiet_hours FROM user_companion_account_state WHERE user_id=${scope.userId}`);
    if (!account?.global_enabled) return;
    const [muted] = await tx.execute(sql`SELECT 1 FROM companion_room_profiles WHERE workspace_id=${scope.workspaceId}
      AND user_id=${scope.userId} AND proactive_muted`);
    if (muted || ["dnd", "offline"].includes(account.presence?.presence ?? "")
      || (account.quiet_hours && isWithinQuietHours(account.quiet_hours,new Date()))
      || await findFormalAnswerTarget(tx, scope)) { await deferParticipation(tx,ctx,60_000); return; }
    const pref = await readParticipationPreferences(tx, scope);
    const awareness = await readCompanionAwareness(tx, scope);
    const plans = await listCompanionAttention(tx, scope);
    const [selfNote] = typeof ctx.payload.selfNoteKey === "string" ? await tx.execute<{ entry_key: string; revision: number; title: string; body: string }>(sql`
      SELECT entry_key,revision,title,body FROM companion_self_notes WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
        AND entry_key=${ctx.payload.selfNoteKey} AND revision=${Number(ctx.payload.selfNoteRevision)} AND NOT user_disabled
        AND tier<>'archived' AND (expires_at IS NULL OR expires_at>now())`) : [];
    if (ctx.payload.selfNoteKey && !selfNote) return;
    const plan = typeof ctx.payload.attentionKey === "string"
      ? plans.find(p => p.key === ctx.payload.attentionKey && p.revision === Number(ctx.payload.attentionRevision)) : null;
    if (ctx.payload.attentionKey && !plan) return;
    if (plan?.preferenceRevision !== null && plan?.preferenceRevision !== undefined
      && (!pref.enabled || pref.revision !== plan.preferenceRevision)) return;
    if (plan?.selfNote) {
      const [valid] = await tx.execute(sql`SELECT 1 FROM companion_self_notes WHERE workspace_id=${scope.workspaceId}
        AND user_id=${scope.userId} AND entry_key=${plan.selfNote.key} AND revision=${plan.selfNote.revision}
        AND NOT user_disabled AND tier<>'archived' AND (expires_at IS NULL OR expires_at>now())`);
      if (!valid) return;
    }
    const [observation] = typeof ctx.payload.observationId === "string" ? await tx.execute<{
      id: string; topic: string; facts: Record<string, unknown>; device_session_id: string | null;
      conversation_id: string | null; parent_run_id: string | null;
    }>(sql`SELECT * FROM companion_awareness_observations WHERE id=${ctx.payload.observationId}::uuid
      AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId} AND expires_at>now()`) : [];
    if (ctx.payload.observationId && !observation) return;
    if (!observation && !plan && !selfNote) return;
    const applicable = observation ? plans.filter(p => p.topics.includes(observation.topic as typeof p.topics[number])
      && (p.preferenceRevision === null || (pref.enabled && p.preferenceRevision === pref.revision))) : plan ? [plan] : [];
    // Revalidate pending jobs against preference corrections, rather than trusting their old payload.
    const builtin = observation && isCompanionDefaultParticipationOpportunity(observation.topic, observation.facts);
    const preferenceBootstrap = observation?.topic === "preference.changed" && pref.enabled && Boolean(pref.markdown.trim());
    if (observation && !applicable.length && !builtin && !preferenceBootstrap) return;
    const preferredDevice = observation?.device_session_id ?? null;
    const present = awareness.sessions.find(s => (!preferredDevice || s.deviceSessionId === preferredDevice)
      && (s.context as { foreground?: boolean; unlocked?: boolean }).foreground
      && (s.context as { unlocked?: boolean }).unlocked && (s.context as { participationAllowed?: boolean }).participationAllowed !== false);
    if (awareness.sessions.some(s => s.typing || (s.context as {speaking?:boolean}).speaking)) { await deferParticipation(tx,ctx,15_000); return; }
    // A stale page or launcher does not speak later in another context.
    if (observation && observation.topic !== "preference.changed" && !present) return;
    // 她自己安排的到点：人不在这台设备前面时不要起整轮模型，也不要把这次安排吃掉。
    // 留在 due 状态等下一次唤醒（0427 的入队同样要求她在场），比出声给空房间诚实得多。
    if (!observation && !present) { await deferParticipation(tx, ctx, 60_000); return; }
    const observedPage = (observation?.facts.context as { page?: { key?: string; revision?: string | null } } | undefined)?.page;
    const presentPage = (present?.context as { page?: { key?: string; revision?: string | null } } | undefined)?.page;
    if (observation && ["page.arrived", "help.available", "result.available"].includes(observation.topic)
      && (!observedPage || observedPage.key !== presentPage?.key || observedPage.revision !== presentPage?.revision)) return;
    /**
     * 她自己新起的话题按账号里已声明的介入档位排间隔（节奏的唯一实现在 shared 的
     * proactive-policy）。用户先要过的东西——招呼、答后接续、
     * 刚落在她手上的失败与结果——不进这条闸。
     *
     * 拦在起运行之前，不是拦在她说话之前：一次「翻到一篇笔记」原本要付一整轮 Agent。
     */
    const initiativeTopic = observation?.topic ?? (selfNote ? "self_note.due" : "attention.due");
    if (companionInitiativePushKind(initiativeTopic) === "routine") {
      const level = (account.intervention_level ?? "moderate") as import("@astella/shared/companion-proactive-policy").CompanionInterventionLevelV1;
      // 上一次「她自己想起要说点什么」：既算她说出口的那一句，也算她安静结束的那一次考虑。
      // 只按发言计的话，「闲到几分钟→想一想→没什么可说」每次都重新付一整轮模型，
      // 用户感觉到的就是她隔一会儿就起一次念头，哪怕一句也没说。
      // 读数按 worker 租约能看到的当前书房计（跨书房的账号级读数要 definer 函数才能穿过 RLS，本轮没加）。
      const [lastSpoken] = await tx.execute<{ at: Date | string | null }>(sql`SELECT max(created_at) AS at FROM companion_messages
        WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId} AND role='assistant' AND kind='proactive'`);
      const recentRuns = await tx.execute<{ topic: string | null; at: Date | string }>(sql`
        SELECT input_source->>'topic' AS topic, created_at AS at FROM companion_turn_runs
        WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId} AND input_source->>'kind'='initiative'
        ORDER BY created_at DESC LIMIT 20`);
      const considered = recentRuns.filter(row => typeof row.topic === "string"
        && companionInitiativePushKind(row.topic) === "routine").map(row => new Date(row.at).getTime());
      const lastAt = Math.max(considered.length ? Math.max(...considered) : 0,
        lastSpoken?.at ? new Date(lastSpoken.at).getTime() : 0);
      const msSince = lastAt > 0 ? Date.now() - lastAt : null;
      if (routineCadenceBlocked({ interventionLevel: level, msSinceLastCue: msSince })) {
        // 到点的关注不在这一步被吃掉：等到间隔过去再唤起，她仍然记得自己要回头看什么。
        await deferParticipation(tx, ctx, Math.max(1_000, proactiveCadenceMs(level) - (msSince ?? 0) + 1_000));
        return;
      }
    }
    const hintedConversation = observation?.conversation_id ?? plan?.conversationId ?? null;
    let [conversation] = await tx.execute<{ id: string; next_generation: number }>(sql`
      SELECT id,next_generation FROM companion_conversations WHERE workspace_id=${scope.workspaceId}
        AND user_id=${scope.userId} AND status='active' AND (kind='dialogue' OR id=${hintedConversation}::uuid)
      ORDER BY (id=${hintedConversation}::uuid) DESC,coalesce(last_message_at,created_at) DESC LIMIT 1 FOR UPDATE`);
    if (!conversation) {
      const id = randomUUID();
      await tx.execute(sql`INSERT INTO companion_conversations(id,workspace_id,user_id,kind,title,title_source,status)
        VALUES(${id},${scope.workspaceId},${scope.userId},'dialogue','和伴星聊聊','placeholder','active')`);
      conversation = { id, next_generation: 1 };
    }
    const [busy] = await tx.execute(sql`SELECT 1 FROM companion_turn_runs WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
      AND status IN ('accepted','running','waiting_for_confirmation','cancel_requested')`);
    if (busy) { await deferParticipation(tx,ctx,15_000); return; }
    if (observation?.parent_run_id) {
      const [stillLatest] = await tx.execute(sql`SELECT 1 FROM companion_turn_runs p
        WHERE p.id=${observation.parent_run_id} AND p.status='succeeded' AND p.user_message_id IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM companion_messages m WHERE m.conversation_id=p.conversation_id
            AND m.role='user' AND m.created_at>p.finished_at)`);
      if (!stillLatest) return;
    }
    const context = present?.context as { page?: { context?: unknown; key?: string; revision?: string } } | undefined;
    const input = companionInitiativeInputV1Schema.parse({ version: 1, kind: "initiative", preparationJobId: ctx.id,
      observationId: observation?.id ?? null, attentionKey: plan?.key ?? null, attentionRevision: plan?.revision ?? null,
      preferenceRevision: pref.revision, parentRunId: observation ? observation.parent_run_id : plan?.parentRunId ?? null,
      deviceSessionId: (present?.deviceSessionId as string | undefined) ?? null,
      topic: initiativeTopic, intent: selfNote
        ? `接着推进自己的关注：${selfNote.title}。先展开自己的记事，按其具体下一步查阅、构思或收尾；有真实新进展才考虑分享。`
        // 同时到点的关注要完整到达：拼起来再裁尾，等于替她忘掉后半件事。
        // 装不下由上下文闸门按声明处理，不在这里静默丢内容。
        : applicable.map(p => p.intent).join("\n"),
      facts: { selfNote: selfNote ? { key: selfNote.entry_key, revision: selfNote.revision } : plan?.selfNote ?? null, observation: observation?.facts ?? null, awareness, attention: applicable, canSpeak: Boolean(present),
        currentPageKey: context?.page?.key ?? null, currentPageRevision: context?.page?.revision ?? null },
    });
    const runId = randomUUID(), jobId = randomUUID();
    const identity = sha256Utf8V1(`initiative:${ctx.id}`);
    const [prior] = await tx.execute(sql`SELECT 1 FROM companion_turn_runs WHERE idempotency_key_hash=${identity}
      AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId}`);
    if (prior) return;
    await tx.execute(sql`INSERT INTO companion_turn_runs(id,workspace_id,user_id,conversation_id,user_message_id,
        input_source,generation,status,idempotency_key_hash,request_body_hash,account_epoch,page_context,job_id)
      VALUES(${runId},${scope.workspaceId},${scope.userId},${conversation.id},NULL,${JSON.stringify(input)}::jsonb,
        ${conversation.next_generation},'accepted',${identity},${sha256Utf8V1(JSON.stringify(input))},${account.epoch},
        ${JSON.stringify(context?.page?.context ?? null)}::jsonb,${jobId})`);
    await tx.execute(sql`INSERT INTO jobs(id,type,workspace_id,requested_by,payload,status,priority,resource_class,idempotency_key)
      VALUES(${jobId},'companion_agent',${scope.workspaceId},${scope.userId},${JSON.stringify({ runId })}::jsonb,
        'pending',35,'interactive_ai',${`companion-initiative-run:${runId}`})`);
    await tx.execute(sql`UPDATE companion_conversations SET next_generation=next_generation+1,updated_at=now()
      WHERE id=${conversation.id}`);
  });
}
