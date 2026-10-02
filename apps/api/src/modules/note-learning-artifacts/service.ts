import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { jobs } from "@ailearn/shared/db-schema/job";
import { noteLearningArtifacts } from "@ailearn/shared/db-schema/note-learning-artifacts";
import { noteBlocks, noteVersions, notes } from "@ailearn/shared/db-schema/note";
import { noteAnchorMatchesV1 } from "@ailearn/shared/note-annotation-contracts";
import { JobStatus, JobType } from "@ailearn/shared/enums";
import { readNoteDynamicArtifactGenerateJobPayload } from "@ailearn/shared/job-payload-contracts";
import {
  createNoteDynamicArtifactTaskV1Schema,
  noteLearningArtifactPageV1Schema,
  noteLearningArtifactTaskPageV1Schema,
  noteLearningArtifactTaskV1Schema,
  noteLearningArtifactV1Schema,
  type NoteLearningArtifactTaskV1,
} from "@ailearn/shared/note-learning-artifact-contracts";
import type { z } from "zod";
import { visibleNotesCondition } from "../note/visibility.ts";
import { classifyJobFailureReason, createJob } from "../job/service.ts";

export type NoteLearningArtifactScopeV1 = { workspaceId: string; userId: string };
type StartInput = z.infer<typeof createNoteDynamicArtifactTaskV1Schema>;

export class NoteLearningArtifactError extends Error {
  constructor(readonly code: "note_not_found" | "note_version_not_found" | "selection_anchor_mismatch" | "task_not_found" | "artifact_not_found", message: string) {
    super(message);
    this.name = "NoteLearningArtifactError";
  }
}

// P1-1：纯可见性检查，不加 `FOR SHARE`——理由同 note-recalls 那处：
// 它只 SELECT、从不写 notes，而共享锁会持有到事务结束，在协同编辑里给下一次保存立闸。
// 有一处**刻意保留**了这个锁并写了理由：`note-learning-rounds/reflection-service.ts:13`
// 的注释说它要与「笔记删除 / 取消共享」串行——那是有意的，不在本次范围内动。
async function requireVisibleNote(tx: ApiTransaction, scope: NoteLearningArtifactScopeV1, noteId: string) {
  const [note] = await tx.select({ id: notes.id, currentVersionId: notes.currentVersionId }).from(notes).where(and(
    eq(notes.id, noteId), eq(notes.workspaceId, scope.workspaceId), visibleNotesCondition(scope.userId), isNull(notes.deletedAt),
  ));
  if (!note) throw new NoteLearningArtifactError("note_not_found", "这篇笔记现在读不到，请回到笔记架核对权限。");
  return note;
}

type ArtifactRow = typeof noteLearningArtifacts.$inferSelect;
function projectArtifact(row: ArtifactRow, currentVersionId: string | null, noteVersionNumber: number) {
  return noteLearningArtifactV1Schema.parse({
    artifactId: row.id,
    noteId: row.noteId,
    noteVersionId: row.noteVersionId,
    noteVersionNumber,
    generationJobId: row.generationJobId,
    sourceMessageId: row.sourceMessageId,
    conversationId: row.conversationId,
    sourceKind: row.sourceKind,
    selectionText: row.selectionText,
    selectionAnchor: row.selectionAnchor,
    sourceContentHash: row.sourceContentHash,
    generatorRef: row.generatorRef,
    title: row.title,
    subject: row.subject,
    caution: row.caution,
    outline: row.outline,
    versionState: row.noteVersionId === currentVersionId ? "current" : "older",
    createdAt: row.createdAt.toISOString(),
  });
}

const owned = (scope: NoteLearningArtifactScopeV1, noteId: string) => and(
  eq(noteLearningArtifacts.workspaceId, scope.workspaceId),
  eq(noteLearningArtifacts.userId, scope.userId),
  eq(noteLearningArtifacts.noteId, noteId),
);

export async function listNoteLearningArtifacts(tx: ApiTransaction, scope: NoteLearningArtifactScopeV1, noteId: string, before?: string) {
  const note = await requireVisibleNote(tx, scope, noteId);
  const [cursor] = before ? await tx.select().from(noteLearningArtifacts).where(and(owned(scope, noteId), eq(noteLearningArtifacts.id, before))) : [];
  if (before && !cursor) throw new NoteLearningArtifactError("artifact_not_found", "互动演示记录位置已变化，请重新读取。");
  const rows = await tx.select({ artifact: noteLearningArtifacts, noteVersionNumber: noteVersions.versionNo })
    .from(noteLearningArtifacts)
    .innerJoin(noteVersions, eq(noteVersions.id, noteLearningArtifacts.noteVersionId))
    .where(and(
      owned(scope, noteId),
      cursor ? sql`(${noteLearningArtifacts.createdAt}, ${noteLearningArtifacts.id}) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)` : undefined,
    ))
    .orderBy(desc(noteLearningArtifacts.createdAt), desc(noteLearningArtifacts.id))
    .limit(101);
  return noteLearningArtifactPageV1Schema.parse({
    version: 1,
    items: rows.slice(0, 100).map((row) => projectArtifact(row.artifact, note.currentVersionId, row.noteVersionNumber)),
    nextCursor: rows.length > 100 ? rows[99]!.artifact.id : null,
  });
}

export async function startNoteLearningArtifactTask(scope: NoteLearningArtifactScopeV1, noteId: string, input: StartInput) {
  await withWorkspaceTransaction(scope, async (tx) => {
    const note = await requireVisibleNote(tx, scope, noteId);
    if (note.currentVersionId !== input.noteVersionId) {
      throw new NoteLearningArtifactError("note_version_not_found", "笔记刚刚更新了，请从当前正文重新开始互动演示。");
    }
    const [version] = await tx.select({ id: noteVersions.id }).from(noteVersions).where(and(
      eq(noteVersions.id, input.noteVersionId), eq(noteVersions.noteId, noteId), eq(noteVersions.workspaceId, scope.workspaceId),
    ));
    if (!version) throw new NoteLearningArtifactError("note_version_not_found", "这篇笔记的当前版本暂时读不到。");
    if (input.sourceKind === "annotation") {
      const anchor = input.selectionAnchor!;
      const blocks = await tx.select({ ordinal: noteBlocks.ordinal, type: noteBlocks.type, content: noteBlocks.content }).from(noteBlocks).where(and(
        eq(noteBlocks.workspaceId, scope.workspaceId), eq(noteBlocks.versionId, input.noteVersionId),
        sql`${noteBlocks.ordinal} BETWEEN ${anchor.startBlockOrdinal} AND ${anchor.endBlockOrdinal}`,
      ));
      if (!noteAnchorMatchesV1(blocks, anchor)) {
        throw new NoteLearningArtifactError("selection_anchor_mismatch", "选中的原句位置和这版笔记对不上，请重新圈选后再做演示。");
      }
    }
  });

  const job = await createJob({
    type: JobType.NOTE_DYNAMIC_ARTIFACT_GENERATE,
    workspaceId: scope.workspaceId,
    requestedBy: scope.userId,
    idempotencyKey: `note-dynamic-artifact:${noteId}:${input.noteVersionId}:${input.requestId}`,
    payload: {
      noteId,
      noteVersionId: input.noteVersionId,
      requestId: input.requestId,
      sourceKind: input.sourceKind,
      ...(input.selectionAnchor ? { anchor: input.selectionAnchor } : {}),
    },
  });
  return withWorkspaceTransaction(scope, (tx) => getNoteLearningArtifactTask(tx, scope, noteId, job.id));
}

async function projectTask(tx: ApiTransaction, scope: NoteLearningArtifactScopeV1, note: { currentVersionId: string | null }, noteId: string, job: typeof jobs.$inferSelect): Promise<NoteLearningArtifactTaskV1> {
  const input = readNoteDynamicArtifactGenerateJobPayload(job.payload);
  if (job.type !== JobType.NOTE_DYNAMIC_ARTIFACT_GENERATE || input.noteId !== noteId) {
    throw new NoteLearningArtifactError("task_not_found", "这条互动演示任务不属于当前笔记。");
  }
  const [saved] = await tx.select({ artifact: noteLearningArtifacts, noteVersionNumber: noteVersions.versionNo })
    .from(noteLearningArtifacts)
    .innerJoin(noteVersions, eq(noteVersions.id, noteLearningArtifacts.noteVersionId))
    .where(and(
      owned(scope, noteId),
      eq(noteLearningArtifacts.generationJobId, job.id),
      eq(noteLearningArtifacts.noteVersionId, input.noteVersionId),
    )).limit(1);

  let status: NoteLearningArtifactTaskV1["status"];
  if (job.status === JobStatus.PENDING) status = "queued";
  else if (job.status === JobStatus.RUNNING) status = "running";
  else if (job.status === JobStatus.SUCCEEDED && saved) status = "ready";
  else status = "failed";
  return noteLearningArtifactTaskV1Schema.parse({
    taskId: job.id,
    noteId,
    noteVersionId: input.noteVersionId,
    sourceKind: input.sourceKind,
    selectionAnchor: input.anchor ?? null,
    status,
    artifact: status === "ready" && saved ? projectArtifact(saved.artifact, note.currentVersionId, saved.noteVersionNumber) : null,
    failureReason: status === "failed" ? classifyJobFailureReason(job.lastError) ?? "unknown" : null,
    createdAt: job.scheduledAt.toISOString(),
  });
}

export async function listNoteLearningArtifactTasks(
  tx: ApiTransaction,
  scope: NoteLearningArtifactScopeV1,
  noteId: string,
  noteVersionId: string,
) {
  const note = await requireVisibleNote(tx, scope, noteId);
  const rows = await tx.select().from(jobs).where(and(
    eq(jobs.workspaceId, scope.workspaceId),
    eq(jobs.requestedBy, scope.userId),
    eq(jobs.type, JobType.NOTE_DYNAMIC_ARTIFACT_GENERATE),
    sql`${jobs.payload}->>'noteId' = ${noteId}`,
    sql`${jobs.payload}->>'noteVersionId' = ${noteVersionId}`,
  )).orderBy(desc(jobs.scheduledAt), desc(jobs.id)).limit(100);
  const items = [];
  for (const job of rows) items.push(await projectTask(tx, scope, note, noteId, job));
  return noteLearningArtifactTaskPageV1Schema.parse({ version: 1, items });
}

export async function getNoteLearningArtifactTask(tx: ApiTransaction, scope: NoteLearningArtifactScopeV1, noteId: string, taskId: string) {
  const note = await requireVisibleNote(tx, scope, noteId);
  const [job] = await tx.select().from(jobs).where(and(
    eq(jobs.id, taskId),
    eq(jobs.workspaceId, scope.workspaceId),
    eq(jobs.requestedBy, scope.userId),
    eq(jobs.type, JobType.NOTE_DYNAMIC_ARTIFACT_GENERATE),
    sql`${jobs.payload}->>'noteId' = ${noteId}`,
  )).limit(1);
  if (!job) throw new NoteLearningArtifactError("task_not_found", "这条互动演示任务现在读不到。");
  return projectTask(tx, scope, note, noteId, job);
}
