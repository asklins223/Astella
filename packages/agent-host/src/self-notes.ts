import { sql } from "drizzle-orm";
import { COMPANION_SELF_NOTE_BUDGET, companionSelfNoteWriteV1Schema, companionSelfNoteControlV1Schema,
  type CompanionSelfNoteV1, type CompanionSelfNoteWriteV1 } from "@astella/shared";
import type { AgentScopeV1 } from "@astella/shared/agent-contracts";
import { AgentStoreError, queryRows, type AgentSqlExecutor } from "./store.ts";

interface NoteRow { user_disabled: boolean; entry_key: string; revision: number; title: string; body: string;
  tier: CompanionSelfNoteV1["tier"]; next_review_at: Date | string | null;
  expires_at: Date | string | null; reason: string; updated_at: Date | string }
const iso = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();
export function projectCompanionSelfNote(row: NoteRow): CompanionSelfNoteV1 {
  return { userDisabled: row.user_disabled, key: row.entry_key, revision: Number(row.revision), title: row.title, body: row.body,
    tier: row.tier, nextReviewAt: iso(row.next_review_at), expiresAt: iso(row.expires_at),
    reason: row.reason, updatedAt: iso(row.updated_at)! };
}
export async function listCompanionSelfNotes(tx: AgentSqlExecutor, scope: AgentScopeV1,
  options: { key?: string; includeArchived?: boolean; offset?: number; limit?: number; lock?: boolean } = {}): Promise<CompanionSelfNoteV1[]> {
  const rows = await queryRows<NoteRow>(tx, sql`SELECT * FROM companion_self_notes
    WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
      ${options.key ? sql`AND entry_key=${options.key}` : sql``}
      ${options.includeArchived ? sql`` : sql`AND NOT user_disabled AND tier <> 'archived' AND (expires_at IS NULL OR expires_at>now())`}
    ORDER BY CASE tier WHEN 'resident' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,updated_at DESC,entry_key
    LIMIT ${Math.min(100, Math.max(1, options.limit ?? 28))} OFFSET ${Math.max(0, options.offset ?? 0)}
    ${options.lock ? sql`FOR UPDATE` : sql``}`);
  return rows.map(projectCompanionSelfNote);
}
export async function lockCompanionSelfNotes(tx: AgentSqlExecutor, scope: AgentScopeV1): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
    ${`companion-self-notes:${scope.workspaceId}:${scope.userId}`},0))`);
}
export async function writeCompanionSelfNote(tx: AgentSqlExecutor, scope: AgentScopeV1,
  raw: CompanionSelfNoteWriteV1, userCorrection = false): Promise<CompanionSelfNoteV1> {
  const input = companionSelfNoteWriteV1Schema.parse(raw);
  await lockCompanionSelfNotes(tx, scope);
  const [current] = await listCompanionSelfNotes(tx, scope, { key: input.key, includeArchived: true, lock: true });
  if ((current?.revision ?? 0) !== input.expectedRevision)
    throw new AgentStoreError(409, "self_note_revision_conflict", "这条自己的记事已有新版本，先读最新内容再修订。");
  if (current?.userDisabled && !userCorrection)
    throw new AgentStoreError(422, "self_note_disabled", "用户已停用这条自己的记事，不能自主恢复。");
  const now = Date.now();
  const nextReviewAt = input.nextReviewAt === undefined ? current?.nextReviewAt ?? null : input.nextReviewAt;
  const expiresAt = input.expiresAt === undefined ? current?.expiresAt ?? null : input.expiresAt;
  if (input.tier !== "archived" && input.nextReviewAt !== undefined && nextReviewAt && (Date.parse(nextReviewAt) < now + 60_000 || (expiresAt && Date.parse(nextReviewAt) >= Date.parse(expiresAt))))
    throw new AgentStoreError(422, "self_note_wake_time", "重评时间需在一分钟之后，并早于有效期结束。");
  // 容量管的是"这一层会不会多出一条"，不是"改过这条没有"。改写一条本来就过期的记事
  // 仍然过期，不占新位子——按 tier 变过没有来判会把用户的纠正误判成装满。
  const counted = (expiresAt: string | null, disabled: boolean) =>
    (expiresAt === null || Date.parse(expiresAt) > now) && !disabled;
  const wasCountedHere = current !== undefined && current.tier === input.tier && counted(current.expiresAt, current.userDisabled);
  if (input.tier !== "archived" && (!current || (counted(expiresAt, false) && !wasCountedHere))) {
    const [count] = await queryRows<{ count: number }>(tx, sql`SELECT count(*)::int AS count FROM companion_self_notes
      WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId} AND tier=${input.tier}
        AND entry_key<>${input.key} AND NOT user_disabled AND (expires_at IS NULL OR expires_at>now())`);
    if (Number(count?.count ?? 0) >= COMPANION_SELF_NOTE_BUDGET[input.tier])
      throw new AgentStoreError(422, "self_note_capacity", "这一层已经装满，请先消化、降层或归档自己的其他记事。");
  }
  const body = { title: input.title, body: input.body, tier: input.tier,
    nextReviewAt: input.tier === "archived" ? null : nextReviewAt, expiresAt, reason: input.reason };
  if (current && Object.entries(body).every(([key,value]) => current[key as keyof CompanionSelfNoteV1] === value)) return current;
  const [row] = await queryRows<NoteRow>(tx, sql`INSERT INTO companion_self_notes
    (workspace_id,user_id,entry_key,title,body,tier,next_review_at,expires_at,reason)
    VALUES(${scope.workspaceId},${scope.userId},${input.key},${body.title},${body.body},${body.tier},
      ${body.nextReviewAt}::timestamptz,${body.expiresAt}::timestamptz,${body.reason})
    ON CONFLICT(workspace_id,user_id,entry_key) DO UPDATE SET title=EXCLUDED.title,body=EXCLUDED.body,
      tier=EXCLUDED.tier,next_review_at=EXCLUDED.next_review_at,expires_at=EXCLUDED.expires_at,
      reason=EXCLUDED.reason,revision=companion_self_notes.revision+1,updated_at=now()
    RETURNING *`);
  if (!row) throw new Error("Self note write produced no row");
  return projectCompanionSelfNote(row);
}

/** User correction is post-hoc; disabling is durable and cannot be undone by the model. */
export async function controlCompanionSelfNote(tx: AgentSqlExecutor, scope: AgentScopeV1,
  raw: { key: string; expectedRevision: number; action: "disable" | "restore" }): Promise<CompanionSelfNoteV1> {
  const input = companionSelfNoteControlV1Schema.parse(raw);
  await lockCompanionSelfNotes(tx, scope);
  const [current] = await listCompanionSelfNotes(tx, scope, { key: input.key, includeArchived: true, lock: true });
  if (!current || current.revision !== input.expectedRevision)
    throw new AgentStoreError(409, "self_note_revision_conflict", "记事已有新版本，请重新读取。");
  if (input.action === "restore") {
    const [{ count }] = await queryRows<{ count: number }>(tx, sql`SELECT count(*)::int AS count FROM companion_self_notes
      WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId} AND tier='active'
        AND entry_key<>${input.key} AND NOT user_disabled AND (expires_at IS NULL OR expires_at>now())`);
    if (count >= COMPANION_SELF_NOTE_BUDGET.active)
      throw new AgentStoreError(422, "self_note_capacity", "活跃记事已满，可以先停用另一条。");
  }
  const [row] = await queryRows<NoteRow>(tx, sql`UPDATE companion_self_notes SET user_disabled=${input.action === "disable"},
    tier=${input.action === "disable" ? "archived" : "active"},next_review_at=NULL,
    expires_at=CASE WHEN ${input.action === "restore"} THEN NULL ELSE expires_at END,revision=revision+1,updated_at=now(),
    reason=${input.action === "disable" ? "用户停用，不再自主恢复。" : "用户恢复，后续由伴星自行整理。"}
    WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId} AND entry_key=${input.key} RETURNING *`);
  if (!row) throw new Error("Self note control produced no row");
  return projectCompanionSelfNote(row);
}
