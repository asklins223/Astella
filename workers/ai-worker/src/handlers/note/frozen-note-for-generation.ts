import { and, eq, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import * as schema from "@astella/shared/db-schema";
import { noteVisibleSqlText } from "@astella/shared/note-visibility";
import { withJobTransaction } from "../../lib/job-lease.ts";
import type { JobPayload } from "../index.ts";

const visibleNoteCondition = sql.raw(noteVisibleSqlText(
  "notes",
  "NULLIF(current_setting('app.user_id', true), '')::uuid",
));

export type FrozenNoteBlockV1 = { ordinal: number; type: string; content: string };

/** Read the frozen note version + its blocks under the job's workspace/user scope. */
export async function readFrozenNoteForGeneration(
  job: JobPayload,
  input: { noteId: string; noteVersionId: string },
): Promise<{ frozen: {
  noteId: string;
  currentVersionId: string | null;
  shareScope: string;
  createdBy: string;
  versionId: string;
  versionNo: number;
  contentHash: string;
}; blocks: FrozenNoteBlockV1[] }> {
  if (!job.requestedBy) throw new Error("生成任务缺少发起人");
  return withJobTransaction(job, async (tx) => {
    const [frozen] = await tx.select({
      noteId: schema.notes.id,
      currentVersionId: schema.notes.currentVersionId,
      shareScope: schema.notes.shareScope,
      createdBy: schema.notes.createdBy,
      versionId: schema.noteVersions.id,
      versionNo: schema.noteVersions.versionNo,
      contentHash: schema.noteVersions.contentHash,
    }).from(schema.notes).innerJoin(schema.noteVersions, and(
      eq(schema.noteVersions.id, input.noteVersionId),
      eq(schema.noteVersions.noteId, schema.notes.id),
      eq(schema.noteVersions.workspaceId, job.workspaceId),
    )).where(and(
      eq(schema.notes.id, input.noteId),
      eq(schema.notes.workspaceId, job.workspaceId),
      isNull(schema.notes.deletedAt),
      visibleNoteCondition,
    )).limit(1);
    if (!frozen) throw new Error("学习卡对应的笔记版本已不可用");
    const blocks = await tx.select({
      ordinal: schema.noteBlocks.ordinal,
      type: schema.noteBlocks.type,
      content: schema.noteBlocks.content,
    }).from(schema.noteBlocks).where(and(
      eq(schema.noteBlocks.workspaceId, job.workspaceId),
      eq(schema.noteBlocks.versionId, frozen.versionId),
    )).orderBy(schema.noteBlocks.ordinal);
    return { frozen, blocks };
  });
}
