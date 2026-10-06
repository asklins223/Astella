import { sql } from "drizzle-orm";
import type { AgentMemoryContextSourceV1, AgentScopeV1 } from "@astella/shared/agent-contracts";
import { queryRows, type AgentSqlExecutor } from "./store.ts";

/** A committed prompt is reproducible, but never permission to reuse a memory
 * that was corrected, withdrawn, archived or expired after that snapshot. */
export async function agentMemoryContextSourcesCurrent(
  tx: AgentSqlExecutor,
  scope: AgentScopeV1,
  sources: readonly AgentMemoryContextSourceV1[],
): Promise<boolean> {
  if (!sources.length) return true;
  const rows = await queryRows<{ id: string; revision: number }>(tx, sql`
    SELECT id,revision FROM assistant_memory_items
    WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
      AND id IN (${sql.join(sources.map(source => sql`${source.memoryId}`), sql`, `)})
      AND deleted_at IS NULL AND dismissed_at IS NULL AND archived_at IS NULL
      AND (valid_from IS NULL OR valid_from<=now())
      AND (valid_until IS NULL OR valid_until>now())
    ORDER BY id FOR SHARE
  `);
  const current = new Map(rows.map(row => [row.id, Number(row.revision)]));
  return sources.every(source => current.get(source.memoryId) === source.revision);
}
