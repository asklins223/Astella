import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  companionParticipationPreferencesV1Schema, EMPTY_PARTICIPATION_PREFERENCES,
  companionAttentionV1Schema, companionAttentionWriteV1Schema,
  companionAwarenessObservationV1Schema,
  type CompanionParticipationPreferencesV1, type CompanionAttentionV1,
  type CompanionAttentionWriteV1, type CompanionAwarenessObservationV1,
} from "@astella/shared/companion-initiative-contracts";
import { toTextArrayLiteral } from "@astella/shared/pg-text-array";
import { isCompanionDefaultParticipationOpportunity, isCompanionDefaultHelpPage } from "@astella/shared/companion-default-participation";
import { AgentStoreError, queryRows, type AgentSqlExecutor } from "./store.ts";

type Scope = { workspaceId: string; userId: string };
export async function readParticipationPreferences(tx: AgentSqlExecutor, scope: Scope): Promise<CompanionParticipationPreferencesV1> {
  const [row] = await queryRows<{ revision: number; enabled: boolean; markdown: string; source: unknown; updated_at: Date | string }>(tx,
    sql`SELECT * FROM companion_participation_preferences WHERE user_id=${scope.userId}`);
  return row ? companionParticipationPreferencesV1Schema.parse({ version: 1, revision: row.revision,
    enabled: row.enabled, markdown: row.markdown, source: row.source, updatedAt: new Date(row.updated_at).toISOString() })
    : { ...EMPTY_PARTICIPATION_PREFERENCES };
}

export async function writeParticipationPreferences(tx: AgentSqlExecutor, scope: Scope, input: {
  expectedRevision: number; markdown: string; enabled: boolean;
  source: NonNullable<CompanionParticipationPreferencesV1["source"]>;
}): Promise<CompanionParticipationPreferencesV1> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`companion-participation:${scope.userId}`},0))`);
  const before = await readParticipationPreferences(tx, scope);
  if (before.revision !== input.expectedRevision)
    throw new AgentStoreError(409, "participation_stale", "相处偏好刚刚有变化，请读到最新内容再修改。");
  const after = companionParticipationPreferencesV1Schema.parse({ version: 1, revision: before.revision + 1,
    enabled: input.enabled, markdown: input.markdown, source: input.source, updatedAt: new Date().toISOString() });
  await tx.execute(sql`INSERT INTO companion_participation_preferences(user_id,revision,enabled,markdown,source,updated_at)
    VALUES(${scope.userId},${after.revision},${after.enabled},${after.markdown},${JSON.stringify(after.source)}::jsonb,now())
    ON CONFLICT(user_id) DO UPDATE SET revision=EXCLUDED.revision,enabled=EXCLUDED.enabled,
      markdown=EXCLUDED.markdown,source=EXCLUDED.source,updated_at=now()`);
  // Old plans lose authority at the revision boundary. Other workspaces use the same version fence.
  await tx.execute(sql`UPDATE companion_attention_plans SET state='completed',next_review_at=NULL,updated_at=now()
    WHERE user_id=${scope.userId} AND preference_revision IS NOT NULL AND preference_revision<>${after.revision}`);
  return after;
}

export async function listCompanionAttention(tx: AgentSqlExecutor, scope: Scope): Promise<CompanionAttentionV1[]> {
  const rows = await queryRows<Record<string, unknown>>(tx, sql`SELECT * FROM companion_attention_plans
    WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId} AND state='active'
      AND (expires_at IS NULL OR expires_at>now()) ORDER BY updated_at DESC LIMIT 20`);
  return rows.map(row => companionAttentionV1Schema.parse({ key: row.entry_key, revision: row.revision,
    intent: row.intent, topics: row.topics, nextReviewAt: isoOrNull(row.next_review_at), expiresAt: isoOrNull(row.expires_at),
    preferenceRevision: row.preference_revision, selfNote: row.self_note, state: row.state,
    conversationId: row.conversation_id, parentRunId: row.parent_run_id, updatedAt: isoOrNull(row.updated_at) }));
}
function isoOrNull(value: unknown): string | null { return value ? new Date(value as string).toISOString() : null; }

export async function arrangeCompanionAttention(tx: AgentSqlExecutor, scope: Scope, input: CompanionAttentionWriteV1,
  origin: { conversationId: string; runId: string }): Promise<CompanionAttentionV1> {
  const plan = companionAttentionWriteV1Schema.parse(input);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`companion-attention:${scope.userId}`},0))`);
  const pref = await readParticipationPreferences(tx, scope);
  if (plan.preferenceRevision !== null && (!pref.enabled || plan.preferenceRevision !== pref.revision))
    throw new AgentStoreError(409, "participation_stale", "这个安排依据的相处偏好已经变化。");
  if (plan.nextReviewAt && new Date(plan.nextReviewAt).getTime() < Date.now() + 15_000)
    throw new AgentStoreError(400, "attention_too_soon", "下次重评至少留十五秒；当前能完成的事情请在这次做完。");
  if (plan.selfNote) {
    const [note] = await queryRows(tx, sql`SELECT 1 FROM companion_self_notes WHERE workspace_id=${scope.workspaceId}
      AND user_id=${scope.userId} AND entry_key=${plan.selfNote.key} AND revision=${plan.selfNote.revision}
      AND NOT user_disabled AND tier<>'archived' AND (expires_at IS NULL OR expires_at>now())`);
    if (!note) throw new AgentStoreError(409, "self_note_stale", "引用的关注记事已经变化或停用。");
  }
  const [existing] = await queryRows<{ revision: number; state: string }>(tx, sql`SELECT revision,state FROM companion_attention_plans
    WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId} AND entry_key=${plan.key} FOR UPDATE`);
  if ((existing?.revision ?? 0) !== plan.expectedRevision)
    throw new AgentStoreError(409, "attention_stale", `这个关注安排当前版本为 ${existing?.revision ?? 0}（0 表示还不存在），这次没有写入。请核对当前安排后使用实际版本修改。`);
  if (plan.state === "active") {
    const [count] = await queryRows<{ n: number }>(tx, sql`SELECT count(*)::integer AS n FROM companion_attention_plans
      WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId} AND entry_key<>${plan.key}
        AND state='active' AND (expires_at IS NULL OR expires_at>now())`);
    if ((count?.n ?? 0) >= 20)
      throw new AgentStoreError(409, "attention_capacity", "正在关注的事情已满，请先收尾已经不需要的关注。");
  }
  const revision = (existing?.revision ?? 0) + 1;
  await tx.execute(sql`INSERT INTO companion_attention_plans(workspace_id,user_id,entry_key,revision,intent,topics,
      next_review_at,expires_at,preference_revision,self_note,state,conversation_id,parent_run_id)
    VALUES(${scope.workspaceId},${scope.userId},${plan.key},${revision},${plan.intent},${toTextArrayLiteral(plan.topics)}::text[],
      ${plan.state === "active" ? plan.nextReviewAt : null}::timestamptz,${plan.expiresAt}::timestamptz,
      ${plan.preferenceRevision},${JSON.stringify(plan.selfNote)}::jsonb,${plan.state},${origin.conversationId},${origin.runId})
    ON CONFLICT(workspace_id,user_id,entry_key) DO UPDATE SET revision=EXCLUDED.revision,intent=EXCLUDED.intent,
      topics=EXCLUDED.topics,next_review_at=EXCLUDED.next_review_at,expires_at=EXCLUDED.expires_at,
      preference_revision=EXCLUDED.preference_revision,self_note=EXCLUDED.self_note,state=EXCLUDED.state,
      conversation_id=EXCLUDED.conversation_id,parent_run_id=EXCLUDED.parent_run_id,updated_at=now()`);
  const { expectedRevision: _, ...fields } = plan;
  return { ...fields, revision, conversationId: origin.conversationId, parentRunId: origin.runId, updatedAt: new Date().toISOString() };
}

export async function enqueueParticipationObservation(tx: AgentSqlExecutor, scope: Scope, input: {
  id?: string; dedupeKey: string; topic: string; deviceSessionId?: string | null; facts: Record<string, unknown>;
  conversationId?: string | null; parentRunId?: string | null; ttlMs?: number;
}): Promise<boolean> {
  const id = input.id ?? randomUUID();
  const [inserted] = await queryRows(tx, sql`INSERT INTO companion_awareness_observations
    (id,workspace_id,user_id,dedupe_key,topic,device_session_id,facts,conversation_id,parent_run_id,expires_at)
    VALUES(${id},${scope.workspaceId},${scope.userId},${input.dedupeKey},${input.topic},${input.deviceSessionId ?? null},
      ${JSON.stringify(input.facts)}::jsonb,${input.conversationId ?? null},${input.parentRunId ?? null},
      now()+${input.ttlMs ?? 120_000}*interval '1 millisecond')
    ON CONFLICT(user_id,dedupe_key) DO NOTHING RETURNING id`);
  if (!inserted) return false;
  const pref = await readParticipationPreferences(tx, scope);
  const plans = await listCompanionAttention(tx, scope);
  const hasPlan = plans.some(plan => plan.topics.includes(input.topic as CompanionAttentionV1["topics"][number])
    && (plan.preferenceRevision === null || (pref.enabled && plan.preferenceRevision === pref.revision)));
  const bootstrap = pref.enabled && pref.markdown.trim() && ["app.started", "preference.changed", "study.started"].includes(input.topic);
  const helpful = input.topic === "help.available" || input.topic === "reply.finished";
  let builtin = isCompanionDefaultParticipationOpportunity(input.topic, input.facts);
  // A newly opened learning page is already handled by the study.started run.
  // Avoid a second model run for the same ready page while preserving later page arrivals.
  const observedContext = input.facts.context as { learning?: boolean; page?: { key?: string } } | undefined;
  if (builtin && input.topic === "page.arrived" && observedContext?.learning && input.deviceSessionId && observedContext.page?.key) {
    const [recentStudyStart] = await queryRows(tx, sql`SELECT 1 FROM companion_awareness_observations
      WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId} AND device_session_id=${input.deviceSessionId}
        AND topic='study.started' AND created_at>now()-interval '5 seconds'
        AND facts->'context'->'page'->>'key'=${observedContext.page.key} LIMIT 1`);
    if (recentStudyStart) builtin = false;
  }
  if (hasPlan || bootstrap || helpful || builtin) {
    await tx.execute(sql`INSERT INTO jobs(type,workspace_id,requested_by,payload,status,priority,resource_class,idempotency_key)
      VALUES('companion_initiative',${scope.workspaceId},${scope.userId},${JSON.stringify({ observationId: id })}::jsonb,
        'pending',25,'maintenance',${`companion-awareness:${id}`})
      ON CONFLICT(workspace_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`);
  }
  return true;
}

export async function recordCompanionAwareness(tx: AgentSqlExecutor, scope: Scope,
  raw: CompanionAwarenessObservationV1): Promise<boolean> {
  const observation = companionAwarenessObservationV1Schema.parse(raw);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`companion-awareness:${scope.userId}:${observation.deviceSessionId}`},0))`);
  const [previous] = await queryRows<{ context: CompanionAwarenessObservationV1["context"]; updated_at: Date | string; observed_at: Date | string | null }>(tx,
    sql`SELECT context,updated_at,observed_at FROM companion_awareness_sessions WHERE workspace_id=${scope.workspaceId}
      AND user_id=${scope.userId} AND device_session_id=${observation.deviceSessionId} FOR UPDATE`);
  if (previous?.observed_at && new Date(observation.occurredAt).getTime() < new Date(previous.observed_at).getTime()) return false;
  // Deduplicate before crediting time or moving the lease. Heartbeats are factual records too.
  const evidence = observation.evidence;
  const dedupeKey = observation.topic === "app.started" ? `launch:${observation.host}:${observation.appLaunchId}`
    : observation.topic === "page.arrived" && isCompanionDefaultHelpPage(observation.context.page?.key)
      ? `page:${observation.host}:${observation.appLaunchId}:${observation.deviceSessionId}:${observation.context.page!.key}:${observation.context.page!.revision ?? ""}`
    : evidence && ["help.available", "result.available"].includes(observation.topic)
      ? `fact:${scope.workspaceId}:${observation.topic}:${evidence.domain}:${evidence.entityId}:${evidence.revision}`
      : `observation:${observation.id}`;
  const accepted = await enqueueParticipationObservation(tx, scope, { id: observation.id, dedupeKey,
    topic: observation.topic, deviceSessionId: observation.deviceSessionId,
    conversationId: observation.context.conversationId, facts: { host: observation.host,
      appLaunchId: observation.appLaunchId, context: observation.context, evidence: observation.evidence ?? null },
    ttlMs: observation.topic === "app.started" ? 120_000 : 90_000 });
  if (!accepted) return false;
  const recent = previous && Date.now() - new Date(previous.updated_at).getTime() <= 45_000;
  const learningNow = (c: CompanionAwarenessObservationV1["context"]) => c.foreground && c.unlocked && c.learning;
  if (recent && learningNow(previous.context) && learningNow(observation.context) && observation.elapsedMs > 0) {
    await tx.execute(sql`INSERT INTO companion_study_spans(id,workspace_id,user_id,device_session_id,started_at,ended_at)
      VALUES(${observation.id},${scope.workspaceId},${scope.userId},${observation.deviceSessionId},
        least(now(),greatest(${previous.updated_at}::timestamptz,now()-${observation.elapsedMs}*interval '1 millisecond')),now())
      ON CONFLICT(id) DO NOTHING`);
  }
  await tx.execute(sql`INSERT INTO companion_awareness_sessions(workspace_id,user_id,device_session_id,app_launch_id,host,context,typing_until,observed_at)
    VALUES(${scope.workspaceId},${scope.userId},${observation.deviceSessionId},${observation.appLaunchId},${observation.host},
      ${JSON.stringify(observation.context)}::jsonb,CASE WHEN ${observation.context.typing} THEN now()+interval '10 seconds' ELSE NULL END,${observation.occurredAt}::timestamptz)
    ON CONFLICT(workspace_id,user_id,device_session_id) DO UPDATE SET app_launch_id=EXCLUDED.app_launch_id,
      host=EXCLUDED.host,context=EXCLUDED.context,typing_until=EXCLUDED.typing_until,observed_at=EXCLUDED.observed_at,updated_at=now()`);
  if (learningNow(observation.context) && (!recent || !learningNow(previous.context))) {
    await enqueueParticipationObservation(tx,scope,{dedupeKey:`study-start:${observation.id}`,topic:"study.started",
      deviceSessionId:observation.deviceSessionId,conversationId:observation.context.conversationId,
      facts:{context:observation.context,observedAt:new Date().toISOString()},ttlMs:90_000});
  }
  return true;
}

/** Merges overlapping devices. Long dwell is a duration fact, never evidence of fatigue or difficulty. */
export function companionStudyDurations(spans: Array<{ started_at: string | Date; ended_at: string | Date }>, now = Date.now()) {
  const sorted = spans.map(s => ({ start: Math.max(now - 4 * 3_600_000, new Date(s.started_at).getTime()), end: Math.min(now, new Date(s.ended_at).getTime()) }))
    .filter(s => s.end > s.start).sort((a, b) => a.start - b.start);
  const merged: typeof sorted = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end); else merged.push({ ...span });
  }
  let continuousStudyMs = 0, previousEnd = 0;
  for (const span of merged) {
    if (span.start - previousEnd > 5 * 60_000) continuousStudyMs = 0;
    continuousStudyMs += span.end - span.start; previousEnd = span.end;
  }
  if (now - previousEnd > 5 * 60_000) continuousStudyMs = 0;
  return { estimated: true, foregroundStudyMs: merged.reduce((sum, s) => sum + s.end - s.start, 0), continuousStudyMs,
    basis: "最近四小时可见、未锁屏的学习页面时段；重叠设备只计一次，离开五分钟后另起连续时段。不能据此判断身体是否休息。" };
}
export async function readCompanionAwareness(tx: AgentSqlExecutor, scope: Scope) {
  const sessions = await queryRows<Record<string, unknown>>(tx, sql`SELECT device_session_id,host,context,
    typing_until>now() AS typing,updated_at FROM companion_awareness_sessions
    WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId} AND updated_at>now()-interval '45 seconds'
    ORDER BY updated_at DESC`);
  const spans = await queryRows<{ started_at: Date; ended_at: Date }>(tx,
    sql`SELECT * FROM astella_companion_study_spans(${scope.userId}::uuid)`);
  return { observedAt: new Date().toISOString(), sessions: sessions.map(s => ({ deviceSessionId: s.device_session_id, host: s.host, context: s.context,
    typing: s.typing === true, updatedAt: isoOrNull(s.updated_at) })), study: companionStudyDurations(spans) };
}
