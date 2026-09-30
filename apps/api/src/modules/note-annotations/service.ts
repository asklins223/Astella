import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { withWorkspaceTransaction, type ApiTransaction } from "../../db/client.ts";
import { noteAnnotations } from "@ailearn/shared/db-schema/note-annotations";
import { jobs } from "@ailearn/shared/db-schema/job";
import { noteBlocks, noteVersions, notes } from "@ailearn/shared/db-schema/note";
import { JobStatus, JobType } from "@ailearn/shared/enums";
import { noteAnnotationAnchorV1Schema, noteAnnotationV1Schema, noteAnnotationTaskV1Schema, type NoteAnnotationAnchorV1, type NoteAnnotationTaskV1 } from "@ailearn/shared/note-annotation-contracts";
import { noteBlockRenderedTextV1 } from "@ailearn/shared/note-doc-schema";
import { createJob, classifyJobFailureReason } from "../job/service.ts";
import { visibleNotesCondition } from "../note/visibility.ts";
import { isAssistantReplyForNote } from "../note/companion-source.ts";

export type NoteAnnotationScopeV1 = { workspaceId: string; userId: string };

export class NoteAnnotationError extends Error {
    constructor(readonly code: "note_not_found" | "note_version_not_found" | "note_anchor_mismatch" | "source_message_not_found" | "annotation_not_found" | "task_not_found" | "stale_revision" | "save_unconfirmed", message: string) {
    super(message);
    this.name = "NoteAnnotationError";
  }
}

  // P1-1：这里**不加** `FOR SHARE`。
  //
  // 这段是个纯可见性检查——只 SELECT 出 id 与 current_version_id，缺行就抛 404，
  // 全程不写 notes。而 `FOR SHARE` 是**行级共享锁，持有到事务结束**：
  // 在协同编辑里 notes 行是被频繁写的（Hocuspocus 落盘、autosave、改 share_scope、
  // 软删），所以每一个"读一篇笔记"都会给下一次保存立一道闸。
  //
  // 去掉之后仍有的保护：可见性由 `visibleNotesCondition` 在同一条 SQL 里判完，
  // 并发改 share_scope 最多让本次读到过期的一行——而读到的 current_version_id
  // 指向的版本行本身仍然存在，调用方按那个版本读块不会越权。
  // 真正需要"读到了就不能被别人改"的地方（比如读-改-写 notes 本表）
  // 才用 `FOR UPDATE`，而这里不是那种场景。
async function requireVisibleNote(tx: ApiTransaction, scope: NoteAnnotationScopeV1, noteId: string) {
  const [note] = await tx.select({ id: notes.id, currentVersionId: notes.currentVersionId }).from(notes).where(and(
    eq(notes.id, noteId), eq(notes.workspaceId, scope.workspaceId), visibleNotesCondition(scope.userId), isNull(notes.deletedAt),
  ));
  if (!note) throw new NoteAnnotationError("note_not_found", "这篇笔记现在读不到，请回到笔记架核对权限。");
  return note;
}

type AnnotationRow = typeof noteAnnotations.$inferSelect;
function project(row: AnnotationRow, currentVersionId: string | null) {
  const anchor: NoteAnnotationAnchorV1 = {
    noteVersionId: row.noteVersionId,
    startBlockOrdinal: row.startBlockOrdinal,
    startOffset: row.startOffset,
    endBlockOrdinal: row.endBlockOrdinal,
    endOffset: row.endOffset,
    excerpt: row.excerpt,
    prefix: row.prefix,
    suffix: row.suffix,
  };
  return noteAnnotationV1Schema.parse({
    annotationId: row.id,
    noteId: row.noteId,
    anchor,
    explanation: row.explanation,
    sourceMessageId: row.sourceMessageId,
    generationJobId: row.generationJobId,
    revision: row.revision,
    versionState: row.noteVersionId === currentVersionId ? "current" : "older",
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

const owned = (scope: NoteAnnotationScopeV1, noteId: string) => and(
  eq(noteAnnotations.workspaceId, scope.workspaceId),
  eq(noteAnnotations.userId, scope.userId),
  eq(noteAnnotations.noteId, noteId),
);

export async function listNoteAnnotations(
  tx: ApiTransaction,
  scope: NoteAnnotationScopeV1,
  noteId: string,
  query: { noteVersionId?: string; before?: string },
) {
  const note = await requireVisibleNote(tx, scope, noteId);
  const [cursor] = query.before ? await tx.select().from(noteAnnotations).where(and(
    owned(scope, noteId), eq(noteAnnotations.id, query.before),
  )) : [];
  if (query.before && !cursor) throw new NoteAnnotationError("annotation_not_found", "批注位置已变化，请重新读取。");
  const rows = await tx.select().from(noteAnnotations).where(and(
    owned(scope, noteId),
    query.noteVersionId ? eq(noteAnnotations.noteVersionId, query.noteVersionId) : undefined,
    cursor ? sql`(${noteAnnotations.createdAt}, ${noteAnnotations.id}) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)` : undefined,
  )).orderBy(desc(noteAnnotations.createdAt), desc(noteAnnotations.id)).limit(101);
  const items = rows.slice(0, 100).map((row) => project(row, note.currentVersionId));
  return { version: 1 as const, items, nextCursor: rows.length > 100 ? rows[99]!.id : null };
}

export async function createNoteAnnotation(
  tx: ApiTransaction,
  scope: NoteAnnotationScopeV1,
  noteId: string,
  input: { anchor: NoteAnnotationAnchorV1; explanation: string; sourceMessageId?: string },
) {
  const note = await requireVisibleNote(tx, scope, noteId);
  const [version] = await tx.select({ id: noteVersions.id }).from(noteVersions).where(and(
    eq(noteVersions.id, input.anchor.noteVersionId),
    eq(noteVersions.noteId, noteId),
    eq(noteVersions.workspaceId, scope.workspaceId),
  ));
  if (!version) throw new NoteAnnotationError("note_version_not_found", "原句所属的笔记版本已不可用，请回到当前正文重新选中。");
  const [block] = await tx.select({ type: noteBlocks.type, content: noteBlocks.content }).from(noteBlocks).where(and(
    eq(noteBlocks.workspaceId, scope.workspaceId),
    eq(noteBlocks.versionId, input.anchor.noteVersionId),
    eq(noteBlocks.ordinal, input.anchor.startBlockOrdinal),
  ));
  const renderedText = block ? noteBlockRenderedTextV1(block.type, block.content) : "";
  const { startOffset, endOffset, excerpt, prefix, suffix } = input.anchor;
  const anchorMatches = Boolean(block)
    && endOffset <= renderedText.length
    && renderedText.slice(startOffset, endOffset) === excerpt
    && renderedText.slice(Math.max(0, startOffset - 120), startOffset) === prefix
    && renderedText.slice(endOffset, endOffset + 120) === suffix;
  if (!anchorMatches) {
    throw new NoteAnnotationError("note_anchor_mismatch", "这段原句和笔记里的显示位置对不上，请重新选择后再贴回批注。");
  }
  if (input.sourceMessageId && !(await isAssistantReplyForNote(tx, scope, {
    messageId: input.sourceMessageId,
    noteId,
    noteVersionId: input.anchor.noteVersionId,
    selectionText: input.anchor.excerpt,
  }))) {
    throw new NoteAnnotationError("source_message_not_found", "伴星回复没有带着这句原文，暂时不能贴成批注。");
  }
  const [inserted] = await tx.insert(noteAnnotations).values({
    ...scope,
    noteId,
    noteVersionId: input.anchor.noteVersionId,
    startBlockOrdinal: input.anchor.startBlockOrdinal,
    startOffset: input.anchor.startOffset,
    endBlockOrdinal: input.anchor.endBlockOrdinal,
    endOffset: input.anchor.endOffset,
    excerpt: input.anchor.excerpt,
    prefix: input.anchor.prefix,
    suffix: input.anchor.suffix,
    explanation: input.explanation,
    sourceMessageId: input.sourceMessageId ?? null,
  }).onConflictDoNothing().returning();
  if (inserted) return project(inserted, note.currentVersionId);
  if (input.sourceMessageId) {
    const [existing] = await tx.select().from(noteAnnotations).where(and(
      owned(scope, noteId), eq(noteAnnotations.sourceMessageId, input.sourceMessageId),
    ));
    if (existing) {
      const sameAnchor = existing.noteVersionId === input.anchor.noteVersionId
        && existing.startBlockOrdinal === input.anchor.startBlockOrdinal
        && existing.startOffset === input.anchor.startOffset
        && existing.endBlockOrdinal === input.anchor.endBlockOrdinal
        && existing.endOffset === input.anchor.endOffset
        && existing.excerpt === input.anchor.excerpt
        && existing.prefix === input.anchor.prefix
        && existing.suffix === input.anchor.suffix;
      if (sameAnchor && existing.explanation === input.explanation) return project(existing, note.currentVersionId);
      throw new NoteAnnotationError("save_unconfirmed", "这条伴星回复已经贴在另一个位置，没有覆盖原批注。");
    }
  }
  throw new NoteAnnotationError("save_unconfirmed", "批注保存结果暂时无法确认。重新读取后再试，不会重复保存同一条伴星回复。");
}

async function assertAnchorIsCurrent(tx: ApiTransaction, scope: NoteAnnotationScopeV1, noteId: string, anchor: NoteAnnotationAnchorV1) {
  const note = await requireVisibleNote(tx, scope, noteId);
  if (note.currentVersionId !== anchor.noteVersionId) {
    throw new NoteAnnotationError("note_version_not_found", "笔记刚刚更新了，请从当前正文重新选中这句话。旧版位置没有贴到新正文上。");
  }
  const [version] = await tx.select({ id: noteVersions.id }).from(noteVersions).where(and(
    eq(noteVersions.id, anchor.noteVersionId), eq(noteVersions.noteId, noteId), eq(noteVersions.workspaceId, scope.workspaceId),
  ));
  if (!version) throw new NoteAnnotationError("note_version_not_found", "原句所属的笔记版本已不可用，请回到当前正文重新选中。");
  const [block] = await tx.select({ type: noteBlocks.type, content: noteBlocks.content }).from(noteBlocks).where(and(
    eq(noteBlocks.workspaceId, scope.workspaceId), eq(noteBlocks.versionId, anchor.noteVersionId), eq(noteBlocks.ordinal, anchor.startBlockOrdinal),
  ));
  const renderedText = block ? noteBlockRenderedTextV1(block.type, block.content) : "";
  const matches = anchor.endBlockOrdinal === anchor.startBlockOrdinal
    && anchor.endOffset <= renderedText.length
    && renderedText.slice(anchor.startOffset, anchor.endOffset) === anchor.excerpt
    && renderedText.slice(Math.max(0, anchor.startOffset - 120), anchor.startOffset) === anchor.prefix
    && renderedText.slice(anchor.endOffset, anchor.endOffset + 120) === anchor.suffix;
  if (!matches) throw new NoteAnnotationError("note_anchor_mismatch", "这段原句和笔记里的显示位置对不上，请重新选择后再贴回批注。");
}

export async function startNoteAnnotationTask(
  scope: NoteAnnotationScopeV1,
  noteId: string,
  input: { anchor: NoteAnnotationAnchorV1; requestId: string },
): Promise<NoteAnnotationTaskV1> {
  await withWorkspaceTransaction(scope, (tx) => assertAnchorIsCurrent(tx, scope, noteId, input.anchor));
  const job = await createJob({
    type: JobType.NOTE_ANNOTATION_EXPLAIN,
    workspaceId: scope.workspaceId,
    requestedBy: scope.userId,
    idempotencyKey: `note-annotation:${noteId}:${input.anchor.noteVersionId}:${input.requestId}`,
    payload: { noteId, noteVersionId: input.anchor.noteVersionId, requestId: input.requestId, anchor: input.anchor },
  });
  return withWorkspaceTransaction(scope, (tx) => getNoteAnnotationTask(tx, scope, noteId, job.id));
}

async function taskForJob(tx: ApiTransaction, scope: NoteAnnotationScopeV1, note: { currentVersionId: string | null }, noteId: string, job: typeof jobs.$inferSelect) {
  const payloadNoteId = typeof job.payload.noteId === "string" ? job.payload.noteId : null;
  const noteVersionId = typeof job.payload.noteVersionId === "string" ? job.payload.noteVersionId : null;
  if (job.type !== JobType.NOTE_ANNOTATION_EXPLAIN || payloadNoteId !== noteId || !noteVersionId) {
    throw new NoteAnnotationError("task_not_found", "这条批注任务不属于当前笔记。");
  }
  const anchor = noteAnnotationAnchorV1Schema.safeParse(job.payload.anchor);
  if (!anchor.success || anchor.data.noteVersionId !== noteVersionId) throw new NoteAnnotationError("task_not_found", "这条批注任务的原文位置已无法读取。");
  const [saved] = await tx.select().from(noteAnnotations).where(and(
    owned(scope, noteId), eq(noteAnnotations.generationJobId, job.id), eq(noteAnnotations.noteVersionId, noteVersionId),
  )).limit(1);
  let status: NoteAnnotationTaskV1["status"];
  if (job.status === JobStatus.PENDING) status = "queued";
  else if (job.status === JobStatus.RUNNING) status = "running";
  else if (job.status === JobStatus.SUCCEEDED && saved) status = "ready";
  else status = "failed";
  return noteAnnotationTaskV1Schema.parse({
    taskId: job.id,
    noteId,
    noteVersionId,
    anchor: anchor.data,
    status,
    annotation: status === "ready" && saved ? project(saved, note.currentVersionId) : null,
    failureReason: status === "failed" ? classifyJobFailureReason(job.lastError) ?? "unknown" : null,
    createdAt: job.scheduledAt.toISOString(),
  });
}

export async function getNoteAnnotationTask(tx: ApiTransaction, scope: NoteAnnotationScopeV1, noteId: string, taskId: string) {
  const note = await requireVisibleNote(tx, scope, noteId);
  const [job] = await tx.select().from(jobs).where(and(
    eq(jobs.id, taskId), eq(jobs.workspaceId, scope.workspaceId), eq(jobs.requestedBy, scope.userId),
    eq(jobs.type, JobType.NOTE_ANNOTATION_EXPLAIN), sql`${jobs.payload}->>'noteId' = ${noteId}`,
  )).limit(1);
  if (!job) throw new NoteAnnotationError("task_not_found", "这条批注任务现在读不到。");
  return taskForJob(tx, scope, note, noteId, job);
}

export async function getLatestNoteAnnotationTask(tx: ApiTransaction, scope: NoteAnnotationScopeV1, noteId: string, noteVersionId: string) {
  const note = await requireVisibleNote(tx, scope, noteId);
  const [job] = await tx.select().from(jobs).where(and(
    eq(jobs.workspaceId, scope.workspaceId), eq(jobs.requestedBy, scope.userId), eq(jobs.type, JobType.NOTE_ANNOTATION_EXPLAIN),
    sql`${jobs.payload}->>'noteId' = ${noteId}`, sql`${jobs.payload}->>'noteVersionId' = ${noteVersionId}`,
  )).orderBy(desc(jobs.scheduledAt), desc(jobs.id)).limit(1);
  return { version: 1 as const, task: job ? await taskForJob(tx, scope, note, noteId, job) : null };
}

export async function changeNoteAnnotation(
  tx: ApiTransaction,
  scope: NoteAnnotationScopeV1,
  noteId: string,
  annotationId: string,
  input: { expectedRevision: number; explanation?: string },
) {
  const note = await requireVisibleNote(tx, scope, noteId);
  const [row] = await tx.select().from(noteAnnotations).where(and(
    owned(scope, noteId), eq(noteAnnotations.id, annotationId),
  )).for("update");
  if (!row) throw new NoteAnnotationError("annotation_not_found", "这条批注已不在这篇笔记里，请重新读取。");
  if (row.revision !== input.expectedRevision) {
    throw new NoteAnnotationError("stale_revision", "另一处已修改这条批注。请重新读取后核对。 ");
  }
  if (input.explanation === undefined) {
    await tx.delete(noteAnnotations).where(eq(noteAnnotations.id, annotationId));
    return { removed: true as const };
  }
  const [updated] = await tx.update(noteAnnotations).set({
    explanation: input.explanation,
    revision: row.revision + 1,
    updatedAt: new Date(),
  }).where(and(eq(noteAnnotations.id, annotationId), eq(noteAnnotations.revision, input.expectedRevision))).returning();
  return project(updated!, note.currentVersionId);
}
