import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { logger } from "../../lib/logger.ts";
import { upsertSearchProjection } from "../../lib/search-index-upsert.ts";
import { learningObjectivesV2, learningObjectiveRevisionsV2, learningObjectiveOriginsV2 } from "@astella/shared/db-schema/card-generation-v2";
import { notes } from "@astella/shared/db-schema/note";

export function objectiveSearchTitle(revision: { conceptLabel?: string | null; publicSummary?: string | null } | undefined): string {
  return revision?.conceptLabel ?? revision?.publicSummary?.slice(0, 80) ?? "未命名目标";
}

/** 当前修订的公开投影；答案、判分点、学习支持及私有笔记标题不进入共用索引。 */
export async function refreshObjectiveSearchProjections(tx: ApiTransaction, workspaceId: string, ids: readonly string[]): Promise<void> {
  const objectiveIds = [...new Set(ids)];
  if (objectiveIds.length === 0) return;
  // 投影失败不能中断保存；读取和写入一起放在 savepoint，避免失败污染业务事务。
  try {
    await tx.transaction(async (sp) => {
      const rows = await sp.select({
        objectiveId: learningObjectivesV2.objectiveId,
        lifecycle: learningObjectivesV2.lifecycle,
        conceptLabel: learningObjectiveRevisionsV2.conceptLabel,
        publicSummary: learningObjectiveRevisionsV2.publicSummary,
      }).from(learningObjectivesV2).leftJoin(learningObjectiveRevisionsV2, and(
        eq(learningObjectiveRevisionsV2.workspaceId, workspaceId),
        eq(learningObjectiveRevisionsV2.objectiveRevisionId, learningObjectivesV2.currentObjectiveRevisionId),
      )).where(and(eq(learningObjectivesV2.workspaceId, workspaceId), inArray(learningObjectivesV2.objectiveId, objectiveIds)));
      if (rows.length === 0) return;
      const origins = await sp.select({ objectiveId: learningObjectiveOriginsV2.objectiveId, title: notes.title })
        .from(learningObjectiveOriginsV2).innerJoin(notes, and(
          eq(notes.id, learningObjectiveOriginsV2.noteId), eq(notes.workspaceId, workspaceId),
          eq(notes.shareScope, "shared"), isNull(notes.deletedAt),
        )).where(and(eq(learningObjectiveOriginsV2.workspaceId, workspaceId), inArray(learningObjectiveOriginsV2.objectiveId, objectiveIds)))
        .orderBy(asc(notes.id));
      const titles = new Map<string, Set<string>>();
      for (const origin of origins) {
        const values = titles.get(origin.objectiveId) ?? new Set<string>();
        if (origin.title) values.add(origin.title);
        titles.set(origin.objectiveId, values);
      }
      for (const row of rows) await upsertSearchProjection(sp, {
        workspaceId, objectType: "objective", objectId: row.objectiveId, title: objectiveSearchTitle(row),
        body: [row.publicSummary ?? "", ...(titles.get(row.objectiveId) ?? [])].filter(Boolean).join("\n"),
        metadata: { objectiveId: row.objectiveId, lifecycle: row.lifecycle },
      });
    });
  } catch (err) {
    logger.error({ err, workspaceId, objectiveIds }, "objective search projection failed — run reindex to compensate");
  }
}

/** 笔记改名、撤回共享或回收时，更新包含其公开标题的目标文档。 */
export async function refreshNoteObjectiveSearchProjections(tx: ApiTransaction, workspaceId: string, noteId: string): Promise<void> {
  try {
    await tx.transaction(async (sp) => {
      const rows = await sp.select({ objectiveId: learningObjectiveOriginsV2.objectiveId }).from(learningObjectiveOriginsV2)
        .where(and(eq(learningObjectiveOriginsV2.workspaceId, workspaceId), eq(learningObjectiveOriginsV2.noteId, noteId)));
      await refreshObjectiveSearchProjections(sp, workspaceId, rows.map(row => row.objectiveId));
    });
  } catch (err) {
    logger.error({ err, workspaceId, noteId }, "note origin search projection failed — run reindex to compensate");
  }
}
