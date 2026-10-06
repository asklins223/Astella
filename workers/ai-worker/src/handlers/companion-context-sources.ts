import { sql } from "drizzle-orm";
import { agentMemoryContextSourcesCurrent, queryRows, type AgentSqlExecutor } from "@astella/agent-host";
import { agentMemoryContextSourceV1Schema, type AgentScopeV1 } from "@astella/shared/agent-contracts";
import { CompanionContextChangedError } from "../lib/non-retryable-errors.ts";
import type { CompanionContextHandoffSnapshotV1 } from "./companion-context-handoff.ts";

export async function assertCompanionHandoffSourcesCurrent(
  tx: AgentSqlExecutor,
  scope: AgentScopeV1,
  snapshot: Pick<CompanionContextHandoffSnapshotV1, "memoryRefs" | "memoryDirectory" | "memorySourceVersions">,
): Promise<void> {
  const visibleIds = [...snapshot.memoryRefs, ...(snapshot.memoryDirectory ?? [])].map(source => source.memoryId);
  // An old snapshot with memory text but no version cannot prove freshness.
  const parsed = agentMemoryContextSourceV1Schema.array().max(32).safeParse(snapshot.memorySourceVersions ?? []);
  if (!parsed.success || visibleIds.some(id => !parsed.data.some(source => source.memoryId === id))
    || !(await agentMemoryContextSourcesCurrent(tx, scope, parsed.data)))
    throw new CompanionContextChangedError();
}

/** Reused at provider reservation, stream flush and final commit. The checks
 * use the host's current transaction, including row locks through its commit. */
export async function assertCompanionContextSourcesCurrent(tx: AgentSqlExecutor, scope: AgentScopeV1, runId: string): Promise<void> {
  const [saved] = await queryRows<{ snapshot: CompanionContextHandoffSnapshotV1 }>(tx, sql`
    SELECT snapshot FROM companion_context_handoff_snapshots
    WHERE run_id=${runId} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
  `);
  // Budget-only callers have no prompt snapshot. The dialogue host always
  // commits its snapshot before reaching an actual provider boundary.
  if (saved) await assertCompanionHandoffSourcesCurrent(tx, scope, saved.snapshot);
}
