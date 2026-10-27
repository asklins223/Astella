import { and, eq, isNull, sql } from "drizzle-orm";
import { notes } from "@astella/shared/db-schema/note";
import type { ApiTransaction, WorkspaceTransactionContext } from "../../db/client.ts";
import { visibleNotesCondition } from "./visibility.ts";

/** Compact revision clocks only; never reads blocks, rendered HTML, map JSON or question bodies. */
export async function readNoteCacheVersions(tx: ApiTransaction, scope: WorkspaceTransactionContext, noteId: string) {
  const [note] = await tx.select({ id: notes.id, currentVersionId: notes.currentVersionId, updatedAt: notes.updatedAt })
    .from(notes).where(and(eq(notes.id, noteId), eq(notes.workspaceId, scope.workspaceId), isNull(notes.deletedAt), visibleNotesCondition(scope.userId))).limit(1);
  if (!note) return null;
  const rows = await tx.execute<{ overviews: string; mindMaps: string; expansions: string; learning: string; annotations: string }>(sql`
    SELECT
      (SELECT concat(count(*), ':', max(created_at)) FROM note_overviews WHERE workspace_id=${scope.workspaceId}::uuid AND user_id=${scope.userId}::uuid AND note_id=${noteId}::uuid) AS overviews,
      (SELECT concat(count(*), ':', max(created_at)) FROM note_mind_maps WHERE workspace_id=${scope.workspaceId}::uuid AND user_id=${scope.userId}::uuid AND note_id=${noteId}::uuid) AS "mindMaps",
      (SELECT concat(count(*), ':', max(created_at)) FROM note_expansions WHERE workspace_id=${scope.workspaceId}::uuid AND user_id=${scope.userId}::uuid AND source_note_id=${noteId}::uuid) AS expansions,
      concat(
        (SELECT concat(count(*), ':', max(updated_at)) FROM note_learning_cards WHERE workspace_id=${scope.workspaceId}::uuid AND note_id=${noteId}::uuid), ':',
        (SELECT concat(count(*), ':', max(a.started_at), ':', max(a.completed_at), ':',
          count(*) filter (where a.status='in_progress'), ':', count(*) filter (where a.status='grading'), ':',
          count(*) filter (where a.status='completed'), ':', count(*) filter (where a.status='grading_failed'))
          FROM note_learning_card_attempts a JOIN note_learning_cards c ON c.id=a.card_id
          WHERE a.workspace_id=${scope.workspaceId}::uuid AND a.user_id=${scope.userId}::uuid AND c.note_id=${noteId}::uuid)) AS learning,
      (SELECT concat(count(*), ':', max(updated_at)) FROM note_annotations WHERE workspace_id=${scope.workspaceId}::uuid AND user_id=${scope.userId}::uuid AND note_id=${noteId}::uuid) AS annotations`);
  return { version: 1, noteId, currentVersionId: note.currentVersionId,
    tokens: { note: `${note.currentVersionId}:${note.updatedAt.toISOString()}`, ...rows[0] } };
}
