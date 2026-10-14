import { sql } from "drizzle-orm";
import type { ApiTransaction } from "../../../db/client.ts";
import { lockMemoryMutations } from "./memory-mutation-lock.ts";
import type { MemoryScope } from "./memory-service.ts";

/** Permanently remove derived companion artifacts while leaving conversation history and persona intact. */
export async function clearCompanionDerivedData(
  executor: ApiTransaction,
  scope: MemoryScope,
  now: Date = new Date(),
): Promise<{
  deletedDiaries: number;
  deletedDiaryEntries: number;
  deletedDiaryMemories: number;
  deletedDiaryCheckpoints: number;
  deletedMemoryUsageRecords: number;
  deletedSelfNotes: number;
  deletedSelfNoteVersions: number;
  deletedMethods: number;
}> {
  await lockMemoryMutations(executor, scope.userId);
  await executor.execute(sql`
    UPDATE user_companion_account_state SET epoch = epoch + 1
     WHERE user_id = ${scope.userId}
  `);

  const diaries = await executor.execute<{ id: string; date: string }>(sql`
    UPDATE companion_daily_summaries
       SET deleted_at = ${now.toISOString()}::timestamptz,
           delete_reason = 'user_deleted',
           hidden_at = COALESCE(hidden_at, ${now.toISOString()}::timestamptz),
           facts = '{}'::jsonb,
           blocks = '[]'::jsonb,
           summary = '',
           selection_reason = NULL,
           selected_id = NULL,
           source_event_ids = ARRAY[]::text[],
           failure_reason = NULL,
           revision = revision + 1,
           updated_at = ${now.toISOString()}::timestamptz
     WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
       AND deleted_at IS NULL
    RETURNING id, date
  `);
  const diaryRows = Array.isArray(diaries) ? diaries : [];

  const deletedDiaryEntries = await executor.execute(sql`
    DELETE FROM companion_discovery_entries
     WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
       AND source = 'diary'
    RETURNING id
  `);

  const diaryMemories = await executor.execute<{ kind: string; source_event_id: string }>(sql`
    DELETE FROM assistant_memory_items
     WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
       AND source_event_id LIKE 'daily-summary:%'
    RETURNING kind, source_event_id
  `);
  const diaryMemoryRows = Array.isArray(diaryMemories) ? diaryMemories : [];
  for (const row of diaryMemoryRows) {
    await executor.execute(sql`
      INSERT INTO assistant_memory_source_suppressions (user_id, kind, source_event_id)
      VALUES (${scope.userId}, ${row.kind}, ${row.source_event_id})
      ON CONFLICT (user_id, kind, source_event_id) DO NOTHING
    `);
  }

  // RLS is the scope boundary for this worker-private table. Avoid WHERE
  // columns here: DELETE predicates require SELECT privilege, which would
  // expose diary-checkpoint internals to the API role.
  const checkpoints = await executor.execute(sql`
    DELETE FROM companion_diary_generation_checkpoints
    RETURNING 1 AS deleted
  `);
  const memoryUsage = await executor.execute(sql`
    DELETE FROM memory_usage_log
     WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
    RETURNING id
  `);
  const noteVersions = await executor.execute(sql`
    DELETE FROM companion_self_note_versions
     WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
    RETURNING entry_key
  `);
  const notes = await executor.execute(sql`
    DELETE FROM companion_self_notes
     WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
    RETURNING entry_key
  `);
  await executor.execute(sql`
    UPDATE companion_attention_plans
       SET state = 'completed', next_review_at = NULL, self_note = 'null'::jsonb,
           revision = revision + 1, updated_at = ${now.toISOString()}::timestamptz
     WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
       AND self_note IS NOT NULL AND self_note <> 'null'::jsonb
  `);
  const methods = await executor.execute(sql`
    DELETE FROM companion_procedural_playbooks
     WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
    RETURNING id
  `);

  return {
    deletedDiaries: diaryRows.length,
    deletedDiaryEntries: Array.isArray(deletedDiaryEntries) ? deletedDiaryEntries.length : 0,
    deletedDiaryMemories: diaryMemoryRows.length,
    deletedDiaryCheckpoints: Array.isArray(checkpoints) ? checkpoints.length : 0,
    deletedMemoryUsageRecords: Array.isArray(memoryUsage) ? memoryUsage.length : 0,
    deletedSelfNotes: Array.isArray(notes) ? notes.length : 0,
    deletedSelfNoteVersions: Array.isArray(noteVersions) ? noteVersions.length : 0,
    deletedMethods: Array.isArray(methods) ? methods.length : 0,
  };
}
