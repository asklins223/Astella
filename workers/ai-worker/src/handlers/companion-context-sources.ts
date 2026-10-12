import { sql } from "drizzle-orm";
import { agentMemoryContextSourcesCurrent, queryRows, type AgentSqlExecutor } from "@astella/agent-host";
import { agentMemoryContextSourceV1Schema, type AgentScopeV1 } from "@astella/shared/agent-contracts";
import { CompanionContextChangedError } from "../lib/non-retryable-errors.ts";
import type { CompanionContextHandoffSnapshotV1 } from "./companion-context-handoff.ts";

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
): Promise<void> {
  const visibleIds = [...snapshot.memoryRefs, ...(snapshot.memoryDirectory ?? [])].map(source => source.memoryId);
  // An old snapshot with memory text but no version cannot prove freshness.
  const parsed = agentMemoryContextSourceV1Schema.array().max(MAX_MEMORY_SOURCE_VERSIONS).safeParse(snapshot.memorySourceVersions ?? []);
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
