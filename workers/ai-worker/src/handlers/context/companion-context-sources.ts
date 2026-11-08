import { sql } from "drizzle-orm";
import { agentMemoryContextSourcesCurrent, queryRows, type AgentSqlExecutor } from "@astella/agent-host";
import { agentMemoryContextSourceV1Schema, type AgentScopeV1 } from "@astella/shared/agent-contracts";
import { logger } from "../../lib/logger.ts";
import { CompanionContextChangedError } from "../../lib/non-retryable-errors.ts";
import type { CompanionContextHandoffSnapshotV1 } from "./companion-context-handoff.ts";
import { isWithinQuietHours, type CompanionQuietHours } from "@astella/shared/companion-proactive-policy";

/**
 * 解析防御，不是业务闸：只兜「快照被塞进畸形大数组」，不承担新鲜度语义
 * （新鲜度全在 revision 比对与 visibleIds ⊆ versions 那两条）。
 *
 * 取数侧的现实上界 = resident ≤ 6（写入侧 `astella_move_companion_memory_budget_tier_v1`
 * 的 capacity 闸）+ directory ≤ 500（`retrieveActiveCompanionMemoryDirectory` 的取行页宽）。
 * 这里曾写死 32（10-05），账号第 33 条 active 记忆入库后每轮对话都撞
 * `CompanionContextChangedError`（2026-10-12 实测：safeParse too_big → CONTEXT_STALE
 * 全军覆没，而取数/校验两侧的 revision 逐条都对得上）。给到 1024：明显高于任何合法
 * 取数结果，仍足以拦下畸形载荷。
 */
const MAX_MEMORY_SOURCE_VERSIONS = 1024;

export async function assertCompanionHandoffSourcesCurrent(
  tx: AgentSqlExecutor,
  scope: AgentScopeV1,
  snapshot: Pick<CompanionContextHandoffSnapshotV1, "memoryRefs" | "memoryDirectory" | "memorySourceVersions">,
  options: {
    allowMissingIds?: ReadonlySet<string> | readonly string[];
    allowRevisions?: ReadonlyMap<string, number>;
  } = {},
): Promise<void> {
  const visibleIds = [...snapshot.memoryRefs, ...(snapshot.memoryDirectory ?? [])].map(source => source.memoryId);
  // An old snapshot with memory text but no version cannot prove freshness.
  const parsed = agentMemoryContextSourceV1Schema.array().max(MAX_MEMORY_SOURCE_VERSIONS).safeParse(snapshot.memorySourceVersions ?? []);
  if (!parsed.success || visibleIds.some(id => !parsed.data.some(source => source.memoryId === id))
    || !(await agentMemoryContextSourcesCurrent(tx, scope, parsed.data, options)))
    throw new CompanionContextChangedError();
}

/** Writes this run performed itself: their effects are the confirmed action, not user drift. */
async function memoryWritesByRun(tx: AgentSqlExecutor, scope: AgentScopeV1, runId: string) {
  const rows = await queryRows<{ name: string; id: string | null; revision: number | null }>(tx, sql`
    SELECT name, arguments->>'memoryId' AS id,
           CASE WHEN name='memory.write.revise'
             THEN ((result_payload->>'json')::jsonb->'value'->>'revision')::int END AS revision
      FROM companion_agent_tool_calls
     WHERE run_id=${runId} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
       AND status='succeeded' AND name IN ('memory.write.forget','memory.write.revise')
  `);
  const missing = rows.filter(row => row.name === "memory.write.forget" && row.id)
    .map(row => row.id as string);
  const revisions = new Map(rows.filter(row => row.name === "memory.write.revise" && row.id
    && Number.isFinite(Number(row.revision)))
    .map(row => [row.id as string, Number(row.revision)] as const));
  return { missing, revisions };
}

/** Reused at provider reservation, stream flush and final commit. The checks
 * use the host's current transaction, including row locks through its commit. */
export async function assertCompanionContextSourcesCurrent(tx: AgentSqlExecutor, scope: AgentScopeV1, runId: string): Promise<void> {
  const [run] = await queryRows<{ input_source: import("@astella/shared/companion-initiative-contracts").CompanionInitiativeInputV1 | null }>(tx,
    sql`SELECT input_source FROM companion_turn_runs WHERE id=${runId} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId}`);
  if (run?.input_source) {
    const input = run.input_source;
    const [account] = await queryRows<{ global_enabled: boolean; presence: { presence?: string } | null; quiet_hours: CompanionQuietHours | null }>(tx,
      sql`SELECT global_enabled,presence,quiet_hours FROM user_companion_account_state WHERE user_id=${scope.userId}`);
    if (!account?.global_enabled || ["dnd", "offline"].includes(account.presence?.presence ?? "")
      || (account.quiet_hours && isWithinQuietHours(account.quiet_hours, new Date()))) throw new CompanionContextChangedError();
    const [muted] = await queryRows(tx,sql`SELECT 1 FROM companion_room_profiles WHERE workspace_id=${scope.workspaceId}
      AND user_id=${scope.userId} AND proactive_muted`);
    if (muted) throw new CompanionContextChangedError();
    const [pref] = await queryRows<{ revision: number }>(tx, sql`SELECT revision FROM companion_participation_preferences WHERE user_id=${scope.userId}`);
    if ((pref?.revision ?? 0) !== input.preferenceRevision) throw new CompanionContextChangedError();
    if (input.attentionKey) {
      const [valid] = await queryRows(tx, sql`SELECT 1 FROM companion_attention_plans WHERE workspace_id=${scope.workspaceId}
        AND user_id=${scope.userId} AND entry_key=${input.attentionKey} AND revision=${input.attentionRevision}
        AND state='active' AND (expires_at IS NULL OR expires_at>now())`);
      // An agent may deliberately finish or revise its own plan; user edits are fenced by preference revision.
      if (!valid) {
        const [owned] = await queryRows(tx, sql`SELECT 1 FROM companion_attention_plans WHERE workspace_id=${scope.workspaceId}
          AND user_id=${scope.userId} AND entry_key=${input.attentionKey} AND parent_run_id=${runId}`);
        if (!owned) throw new CompanionContextChangedError();
      }
    }
    const selfNote = input.facts.selfNote as { key?: string; revision?: number } | null | undefined;
    if (selfNote?.key) {
      const [valid] = await queryRows(tx, sql`SELECT 1 FROM companion_self_notes WHERE workspace_id=${scope.workspaceId}
        AND user_id=${scope.userId} AND entry_key=${selfNote.key}
        AND (revision=${selfNote.revision ?? 0} OR EXISTS(SELECT 1 FROM companion_agent_tool_calls tc
          WHERE tc.run_id=${runId} AND tc.status='succeeded'
            AND (CASE WHEN tc.name IN ('persona.write.self_note','attention.write.schedule_wake') AND tc.result_ref IS NOT NULL
              THEN tc.result_ref::jsonb ELSE NULL END)->'selfNote'=jsonb_build_object('key',entry_key,'revision',revision)))
        AND NOT user_disabled AND tier<>'archived'
        AND (expires_at IS NULL OR expires_at>now())`);
      if (!valid) throw new CompanionContextChangedError();
    }
    if (input.facts.canSpeak === true) {
      const quietEpisodeId = input.topic === "presence.quiet"
        ? (input.facts.observation as { context?: { quietEpisodeId?: string } } | null)?.context?.quietEpisodeId : undefined;
      const [typing] = await queryRows(tx,sql`SELECT 1 FROM companion_awareness_sessions WHERE workspace_id=${scope.workspaceId}
        AND user_id=${scope.userId} AND updated_at>now()-interval '45 seconds' AND typing_until>now()`);
      if (typing) throw stale("another_session_typing", runId);
      // 心跳 15 秒一续，调度只要求决定开口时仍在 45 秒内。发布若仍用 now()-45s，
      // 排队或一次十几秒的生成就会把“当时还在”判成离开。锚到本回合更早的
      // created_at / started_at，同一条会话可以读完；离开、翻页、正在输入仍由下面的字段拦住。
      // 三分钟是绝对上限，客户端已经没了不能靠一次长回合继续开口。
      // 条件与原先的 AND 相同，只是失败时留下第一个不成立的原因。
      const [presence] = await queryRows<{ reason: string }>(tx, sql`SELECT CASE
          WHEN s.device_session_id IS NULL THEN 'session_missing'
          WHEN s.updated_at <= COALESCE((SELECT LEAST(created_at, COALESCE(started_at, created_at)) FROM companion_turn_runs
            WHERE id=${runId} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId}), now()) - interval '45 seconds' THEN 'heartbeat_before_turn'
          WHEN s.updated_at <= now() - interval '3 minutes' THEN 'heartbeat_older_than_3m'
          WHEN coalesce(s.context->>'foreground','') <> 'true' THEN 'background'
          WHEN coalesce(s.context->>'unlocked','') <> 'true' THEN 'locked'
          WHEN coalesce(s.context->>'participationAllowed','true') <> 'true' THEN 'participation_off'
          WHEN ${quietEpisodeId ?? null}::text IS NOT NULL AND s.context->>'quietEpisodeId' IS DISTINCT FROM ${quietEpisodeId ?? null}::text THEN 'quiet_episode'
          WHEN s.typing_until > now() THEN 'typing'
          WHEN ${input.facts.currentPageKey ?? null}::text IS NOT NULL AND s.context->'page'->>'key' IS DISTINCT FROM ${input.facts.currentPageKey ?? null}::text THEN 'page'
          WHEN ${input.facts.currentPageRevision ?? null}::text IS NOT NULL AND s.context->'page'->>'revision' IS DISTINCT FROM ${input.facts.currentPageRevision ?? null}::text THEN 'page_revision'
          ELSE 'present'
        END AS reason
        FROM (SELECT 1) AS probe
        LEFT JOIN companion_awareness_sessions s
          ON s.workspace_id=${scope.workspaceId} AND s.user_id=${scope.userId} AND s.device_session_id=${input.deviceSessionId}`);
      if (presence?.reason !== "present") throw stale(presence?.reason ?? "session_missing", runId);
    }
  }
  const [saved] = await queryRows<{ snapshot: CompanionContextHandoffSnapshotV1 }>(tx, sql`
    SELECT snapshot FROM companion_context_handoff_snapshots
    WHERE run_id=${runId} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
  `);
  // Budget-only callers have no prompt snapshot. The dialogue host always
  // commits its snapshot before reaching an actual provider boundary.
  if (saved) {
    const ownWrites = await memoryWritesByRun(tx, scope, runId);
    await assertCompanionHandoffSourcesCurrent(tx, scope, saved.snapshot,
      { allowMissingIds: ownWrites.missing, allowRevisions: ownWrites.revisions });
  }
}

function stale(reason: string, runId: string): CompanionContextChangedError {
  logger.warn({ runId, contextReason: reason }, "companion initiative context no longer current");
  return new CompanionContextChangedError(reason);
}
