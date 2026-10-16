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
import { retireSupersededLaunchGreetings } from "./launch-greeting-supersession.ts";

type Scope = { workspaceId: string; userId: string };

/** 心跳新鲜度：只给 study span 记账用（`elapsedMs` 只有落在同一次心跳里才对得上账）。 */
const AWARENESS_HEARTBEAT_MS = 45_000;

/**
 * 一次学习**时段**的边界。与 `companionStudyDurations` 的合并口径同一条：
 * 「离开五分钟后另起连续时段」——同一段学习里的每心跳一次都算还在继续，不是新的开始。
 *
 * 这条常量以前没有名字：`study.started` 的判据拿的是 45 秒（心跳新鲜度），
 * 而真实心跳间隔是 59 秒，于是每一次心跳都被当成「又开始学了」，同一件事连着
 * 模型跑两轮、给用户连着推两条一模一样的主动提示（2026-10-14 实测 05:12:15 与
 * 05:13:14 各一条「好，学起来了。我不打扰，就露个面…」）。两个用途现在各自有名字。
 */
const STUDY_SESSION_GAP_MS = 5 * 60_000;

/** 这一份上下文是否「正在学」：前台 + 未锁屏 + 宿主报告的学习页。 */
export function isAwarenessLearning(context: Pick<CompanionAwarenessObservationV1["context"], "foreground" | "unlocked" | "learning">): boolean {
  return context.foreground && context.unlocked && context.learning;
}

/**
 * 上一次心跳里那段学习还没结束吗？是 → 这一次不算「开始」。
 *
 * 只看两件事：上次看见的是不是在学，以及那次心跳离现在有多远。中间隔多久都不改判
 * 「同一段」，除非超过时段边界（那时确实又开始了一段）。
 */
export function isStudySessionContinuing(
  previous: { context: CompanionAwarenessObservationV1["context"]; updated_at: Date | string } | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!previous) return false;
  if (!isAwarenessLearning(previous.context)) return false;
  return now - new Date(previous.updated_at).getTime() <= STUDY_SESSION_GAP_MS;
}

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
}): Promise<{ changed: boolean; preferences: CompanionParticipationPreferencesV1 }> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`companion-participation:${scope.userId}`},0))`);
  const before = await readParticipationPreferences(tx, scope);
  if (before.revision !== input.expectedRevision)
    throw new AgentStoreError(409, "participation_stale", "相处偏好刚刚有变化，请读到最新内容再修改。");
  const after = companionParticipationPreferencesV1Schema.parse({ version: 1, revision: before.revision + 1,
    enabled: input.enabled, markdown: input.markdown, source: input.source, updatedAt: new Date().toISOString() });
  // Replaying the same authoritative write must not retire valid attention plans.
  // A new source still creates a revision even when its prose is unchanged.
  if (before.enabled === after.enabled && before.markdown === after.markdown
    && before.source && before.source.kind === after.source!.kind && before.source.workspaceId === after.source!.workspaceId
    && before.source.messageId === after.source!.messageId && before.source.quote === after.source!.quote)
    return { changed: false, preferences: before };
  await tx.execute(sql`INSERT INTO companion_participation_preferences(user_id,revision,enabled,markdown,source,updated_at)
    VALUES(${scope.userId},${after.revision},${after.enabled},${after.markdown},${JSON.stringify(after.source)}::jsonb,now())
    ON CONFLICT(user_id) DO UPDATE SET revision=EXCLUDED.revision,enabled=EXCLUDED.enabled,
      markdown=EXCLUDED.markdown,source=EXCLUDED.source,updated_at=now()`);
  // Old plans lose authority at the revision boundary. Other workspaces use the same version fence.
  await tx.execute(sql`UPDATE companion_attention_plans SET state='completed',next_review_at=NULL,updated_at=now()
    WHERE user_id=${scope.userId} AND preference_revision IS NOT NULL AND preference_revision<>${after.revision}`);
  return { changed: true, preferences: after };
}

export async function listCompanionAttention(tx: AgentSqlExecutor, scope: Scope): Promise<CompanionAttentionV1[]> {
  // 读她自己排的关注，不按条数截：截了就是替她忘掉排在后面的那件。
  const rows = await queryRows<Record<string, unknown>>(tx, sql`SELECT * FROM companion_attention_plans
    WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId} AND state='active'
      AND (expires_at IS NULL OR expires_at>now()) ORDER BY updated_at DESC`);
  return rows.map(attentionFromRow);
}
function attentionFromRow(row: Record<string, unknown>): CompanionAttentionV1 {
  return companionAttentionV1Schema.parse({ key: row.entry_key, revision: row.revision,
    intent: row.intent, topics: row.topics, nextReviewAt: isoOrNull(row.next_review_at), expiresAt: isoOrNull(row.expires_at),
    preferenceRevision: row.preference_revision, selfNote: row.self_note, state: row.state,
    conversationId: row.conversation_id, parentRunId: row.parent_run_id, updatedAt: isoOrNull(row.updated_at) });
}
function isoOrNull(value: unknown): string | null { return value ? new Date(value as string).toISOString() : null; }

export async function arrangeCompanionAttention(tx: AgentSqlExecutor, scope: Scope, input: CompanionAttentionWriteV1,
  origin: { conversationId: string; runId: string }): Promise<{ changed: boolean; attention: CompanionAttentionV1 }> {
  const parsed = companionAttentionWriteV1Schema.parse(input);
  const plan = { ...parsed, topics: [...new Set(parsed.topics)],
    nextReviewAt: parsed.state === "active" ? isoOrNull(parsed.nextReviewAt) : null,
    expiresAt: isoOrNull(parsed.expiresAt) };
  // Same order as preference writes, which retire plans while holding this lock.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`companion-participation:${scope.userId}`},0))`);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`companion-attention:${scope.userId}`},0))`);
  const pref = await readParticipationPreferences(tx, scope);
  if (plan.preferenceRevision !== null && (!pref.enabled || plan.preferenceRevision !== pref.revision))
    throw new AgentStoreError(409, "participation_stale", "这个安排依据的相处偏好已经变化。");
  // 重评时间只要求「在将来」：过去或此刻的时刻由她在这轮自己处理完，不需要一个写死的秒数闸门。
  if (plan.nextReviewAt && new Date(plan.nextReviewAt).getTime() <= Date.now())
    throw new AgentStoreError(400, "attention_not_future", "重评时间要留在将来；此刻就能做完的事在这轮就做，或者把这条关注标为完成。");
  if (plan.state === "active" && plan.expiresAt && new Date(plan.expiresAt).getTime() <= Date.now())
    throw new AgentStoreError(400, "attention_expired", "这条关注已经过期，不能保存为活跃安排。请核对有效期，或者标为完成。");
  if (plan.nextReviewAt && plan.expiresAt && Date.parse(plan.nextReviewAt) >= Date.parse(plan.expiresAt))
    throw new AgentStoreError(400, "attention_after_expiry", "重评时间须早于关注的有效期结束，否则到时这条关注已经失效。");
  // 不再限制「同时在关注几件事」（2026-10-13 用户决定：Agent 不设硬上限）。
  // 换成一条真实的正确性要求：活跃关注必须唤得起——有事件或有重评时间，
  // 否则它就是一条谁也到不了的僵尸安排，只会堆在那里。
  if (plan.state === "active" && !plan.topics.length && !plan.nextReviewAt)
    throw new AgentStoreError(400, "attention_unreachable", "这条安排既没有订阅事件，也没有重评时间，她不会有机会看到它。给出其中一项，或者直接标为完成。");
  if (plan.selfNote) {
    const [note] = await queryRows(tx, sql`SELECT 1 FROM companion_self_notes WHERE workspace_id=${scope.workspaceId}
      AND user_id=${scope.userId} AND entry_key=${plan.selfNote.key} AND revision=${plan.selfNote.revision}
      AND NOT user_disabled AND tier<>'archived' AND (expires_at IS NULL OR expires_at>now())`);
    if (!note) throw new AgentStoreError(409, "self_note_stale", "引用的关注记事已经变化或停用。");
  }
  const [row] = await queryRows<Record<string, unknown>>(tx, sql`SELECT * FROM companion_attention_plans
    WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId} AND entry_key=${plan.key} FOR UPDATE`);
  const existing = row ? attentionFromRow(row) : null;
  if ((existing?.revision ?? 0) !== plan.expectedRevision)
    throw new AgentStoreError(409, "attention_stale", `这个关注安排当前版本为 ${existing?.revision ?? 0}（0 表示还不存在），这次没有写入。请核对当前安排后使用实际版本修改。`);
  // Check authority and CAS before accepting a no-op. Keep the original origin
  // and timestamp: verifying an arrangement is not a new arrangement.
  if (existing && existing.intent === plan.intent && existing.state === plan.state
    && existing.nextReviewAt === plan.nextReviewAt && existing.expiresAt === plan.expiresAt
    && existing.preferenceRevision === plan.preferenceRevision
    && existing.selfNote?.key === plan.selfNote?.key && existing.selfNote?.revision === plan.selfNote?.revision
    && existing.topics.length === plan.topics.length && existing.topics.every(topic => plan.topics.includes(topic)))
    return { changed: false, attention: existing };
  const revision = (existing?.revision ?? 0) + 1;
  const [saved] = await queryRows<Record<string, unknown>>(tx, sql`INSERT INTO companion_attention_plans(workspace_id,user_id,entry_key,revision,intent,topics,
      next_review_at,expires_at,preference_revision,self_note,state,conversation_id,parent_run_id)
    VALUES(${scope.workspaceId},${scope.userId},${plan.key},${revision},${plan.intent},${toTextArrayLiteral(plan.topics)}::text[],
      ${plan.state === "active" ? plan.nextReviewAt : null}::timestamptz,${plan.expiresAt}::timestamptz,
      ${plan.preferenceRevision},${JSON.stringify(plan.selfNote)}::jsonb,${plan.state},${origin.conversationId},${origin.runId})
    ON CONFLICT(workspace_id,user_id,entry_key) DO UPDATE SET revision=EXCLUDED.revision,intent=EXCLUDED.intent,
      topics=EXCLUDED.topics,next_review_at=EXCLUDED.next_review_at,expires_at=EXCLUDED.expires_at,
      preference_revision=EXCLUDED.preference_revision,self_note=EXCLUDED.self_note,state=EXCLUDED.state,
      conversation_id=EXCLUDED.conversation_id,parent_run_id=EXCLUDED.parent_run_id,updated_at=now() RETURNING *`);
  return { changed: true, attention: attentionFromRow(saved!) };
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
  // 一次「到达」的身份是**这次启动里的那个页面**，不是它的版本号，也不是哪块 webContents 报的：
  // 原来 revision 在键里，他改一次笔记、或者渲染层重载换了 deviceSessionId，同一段内容就再要一整轮
  // 模型。正文版本仍然在 prep 里核对（旧页面不能在新版本上开口），只是不再拿它当重复计数的依据。
  const dedupeKey = observation.topic === "app.started" ? `launch:${observation.host}:${observation.appLaunchId}`
    : observation.topic === "page.arrived" && isCompanionDefaultHelpPage(observation.context.page?.key)
      ? `page:${observation.host}:${observation.appLaunchId}:${observation.context.page!.key}`
    : evidence && ["help.available", "result.available"].includes(observation.topic)
      ? `fact:${scope.workspaceId}:${observation.topic}:${evidence.domain}:${evidence.entityId}:${evidence.revision}`
      : `observation:${observation.id}`;
  const accepted = await enqueueParticipationObservation(tx, scope, { id: observation.id, dedupeKey,
    topic: observation.topic, deviceSessionId: observation.deviceSessionId,
    conversationId: observation.context.conversationId, facts: { host: observation.host,
      appLaunchId: observation.appLaunchId, context: observation.context, evidence: observation.evidence ?? null },
    ttlMs: observation.topic === "app.started" ? 120_000 : 90_000 });
  if (!accepted) return false;
  /**
   * 一次**真实启动**成立时，把上一次还没被看见的启动问候收掉（2026-10-16）。
   *
   * 问候生成在启动后十几秒；上次启动若先关了窗口，它下一次才被认领——用户看到的是
   * 「上一次启动的问候」，而这次启动自己的问候紧接着也会到（真窗口实测两条相差十几秒）。
   * 只在这一条观察真的入库（`accepted`）时收：同一次启动的重复上报不该动别人的问候。
   */
  if (observation.topic === "app.started") {
    await retireSupersededLaunchGreetings(tx, scope);
  }
  const recent = previous && Date.now() - new Date(previous.updated_at).getTime() <= AWARENESS_HEARTBEAT_MS;
  const learningNow = isAwarenessLearning;
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
  // 同一段学习里的每一声心跳都不再算「又开始」；判据只问上次看见的是不是还在学、
  // 而那次心跳离现在有多远（见 STUDY_SESSION_GAP_MS 的注释）。
  if (learningNow(observation.context) && !isStudySessionContinuing(previous)) {
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
    if (span.start - previousEnd > STUDY_SESSION_GAP_MS) continuousStudyMs = 0;
    continuousStudyMs += span.end - span.start; previousEnd = span.end;
  }
  if (now - previousEnd > STUDY_SESSION_GAP_MS) continuousStudyMs = 0;
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
