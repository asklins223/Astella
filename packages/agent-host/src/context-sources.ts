import { sql } from "drizzle-orm";
import type { AgentMemoryContextSourceV1, AgentScopeV1 } from "@astella/shared/agent-contracts";
import { queryRows, type AgentSqlExecutor } from "./store.ts";

/**
 * A committed prompt is reproducible, but never permission to reuse a memory
 * that was corrected, withdrawn, archived or expired after that snapshot.
 *
 * A revision bump on its own is not a fence: background maintenance (memory
 * extraction/merge) and her own writes refine rows continuously, and treating
 * that as "the user changed the context" killed otherwise healthy turns. What
 * fences a turn is content the *user* rewrote, or a row that stopped being
 * usable (deleted / dismissed / archived / expired).
 */
export async function agentMemoryContextSourcesCurrent(
  tx: AgentSqlExecutor,
  scope: AgentScopeV1,
  sources: readonly AgentMemoryContextSourceV1[],
  options: {
    allowMissingIds?: ReadonlySet<string> | readonly string[];
    /** Exact revisions this run wrote itself; any later revision still fences. */
    allowRevisions?: ReadonlyMap<string, number>;
  } = {},
): Promise<boolean> {
  if (!sources.length) return true;
  const rows = await queryRows<{ id: string; revision: number; author_type: string | null }>(tx, sql`
    SELECT id,revision,author_type FROM assistant_memory_items
    WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
      AND id IN (${sql.join(sources.map(source => sql`${source.memoryId}`), sql`, `)})
      AND deleted_at IS NULL AND dismissed_at IS NULL AND archived_at IS NULL
      AND (valid_from IS NULL OR valid_from<=now())
      AND (valid_until IS NULL OR valid_until>now())
    ORDER BY id FOR SHARE
  `);
  const current = new Map(rows.map(row => [row.id, { revision: Number(row.revision), author: row.author_type }]));
  // A memory this run itself forgot is gone by design; counting its absence as
  // user drift would kill the very turn that did what the person confirmed.
  const allowedMissing = new Set(options.allowMissingIds ?? []);
  return sources.every(source => {
    const row = current.get(source.memoryId);
    if (!row) return allowedMissing.has(source.memoryId);
    if (row.revision === source.revision) return true;
    // A revision this same run produced is its own confirmed write, not drift.
    if (options.allowRevisions?.get(source.memoryId) === row.revision) return true;
    // Only known non-user authorship is tolerated; unknown stays strict.
    return ["extractor", "maintenance", "companion"].includes(String(row.author));
  });
}
