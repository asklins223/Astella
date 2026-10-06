import { startDomainAgentRequest, agentRunForDomainExecution } from "../../agent/runtime.ts";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { jobs } from "@astella/shared/db-schema/job";
import { noteOverviews } from "@astella/shared/db-schema/note-overviews";
import { noteVersions, notes } from "@astella/shared/db-schema/note";
import { JobStatus, JobType } from "@astella/shared/enums";
import {
  noteOverviewLatestTaskV1Schema,
  noteOverviewTaskV1Schema,
  noteOverviewV1Schema,
  type NoteOverviewTaskV1,
} from "@astella/shared/note-overview-contracts";
import type { createNoteOverviewTaskV1Schema } from "@astella/shared/note-overview-contracts";
import type { z } from "zod";
import { visibleNotesCondition } from "../note/visibility.ts";
import { classifyJobFailureReason } from "../job/service.ts";

export type NoteOverviewScopeV1 = { workspaceId: string; userId: string };
type StartOverviewInput = z.infer<typeof createNoteOverviewTaskV1Schema>;

export class NoteOverviewError extends Error {
  constructor(readonly code: "note_not_found" | "note_version_not_found" | "task_not_found" | "overview_not_found", message: string) {
    super(message);
    this.name = "NoteOverviewError";
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
async function requireVisibleNote(tx: ApiTransaction, scope: NoteOverviewScopeV1, noteId: string) {
  const [note] = await tx.select({ id: notes.id, currentVersionId: notes.currentVersionId }).from(notes).where(and(
    eq(notes.id, noteId), eq(notes.workspaceId, scope.workspaceId), visibleNotesCondition(scope.userId), isNull(notes.deletedAt),
  ));
  if (!note) throw new NoteOverviewError("note_not_found", "这篇笔记现在读不到，请回到笔记架核对权限。");
  return note;
}

type OverviewRow = typeof noteOverviews.$inferSelect;
function project(row: OverviewRow, currentVersionId: string | null, noteVersionNumber: number) {
  return noteOverviewV1Schema.parse({
    overviewId: row.id,
    noteId: row.noteId,
    noteVersionId: row.noteVersionId,
    noteVersionNumber,
    body: row.body,
    points: row.overviewPoints ?? null,
    references: row.sourceReferences,
    coverage: row.coverage ?? null,
    generationJobId: row.generationJobId,
    sourceMessageId: row.sourceMessageId,
    conversationId: row.conversationId,
    versionState: row.noteVersionId === currentVersionId ? "current" : "older",
    createdAt: row.createdAt.toISOString(),
  });
}

const owned = (scope: NoteOverviewScopeV1, noteId: string) => and(
  eq(noteOverviews.workspaceId, scope.workspaceId),
  eq(noteOverviews.userId, scope.userId),
  eq(noteOverviews.noteId, noteId),
);

export async function listNoteOverviews(
  tx: ApiTransaction,
  scope: NoteOverviewScopeV1,
  noteId: string,
  before?: string,
) {
  const note = await requireVisibleNote(tx, scope, noteId);
  const [cursor] = before ? await tx.select().from(noteOverviews).where(and(owned(scope, noteId), eq(noteOverviews.id, before))) : [];
  if (before && !cursor) throw new NoteOverviewError("overview_not_found", "速看记录位置已变化，请重新读取。");
  const rows = await tx.select({ overview: noteOverviews, noteVersionNumber: noteVersions.versionNo }).from(noteOverviews)
    .innerJoin(noteVersions, eq(noteVersions.id, noteOverviews.noteVersionId))
    .where(and(
      owned(scope, noteId),
      cursor ? sql`(${noteOverviews.createdAt}, ${noteOverviews.id}) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)` : undefined,
    )).orderBy(desc(noteOverviews.createdAt), desc(noteOverviews.id)).limit(101);
  return {
    version: 1 as const,
    items: rows.slice(0, 100).map((row) => project(row.overview, note.currentVersionId, row.noteVersionNumber)),
    nextCursor: rows.length > 100 ? rows[99]!.overview.id : null,
  };
}

export async function startNoteOverviewTask(
  scope: NoteOverviewScopeV1,
  noteId: string,
  input: StartOverviewInput,
): Promise<NoteOverviewTaskV1> {
  await withWorkspaceTransaction(scope, async (tx) => {
    const note = await requireVisibleNote(tx, scope, noteId);
    if (note.currentVersionId !== input.noteVersionId) {
      throw new NoteOverviewError("note_version_not_found", "笔记刚刚更新了，请从当前正文重新开始速看。");
    }
    const [version] = await tx.select({ id: noteVersions.id }).from(noteVersions).where(and(
      eq(noteVersions.id, input.noteVersionId),
      eq(noteVersions.noteId, noteId),
      eq(noteVersions.workspaceId, scope.workspaceId),
    ));
    if (!version) throw new NoteOverviewError("note_version_not_found", "这篇笔记的当前版本暂时读不到。");
  });

  const { operation } = await startDomainAgentRequest(scope, { capability: "note_overview_generate", noteId, request: input }, "整理这版笔记的速看。");
  if (operation.execution.kind !== "job") throw new Error("note capability returned a different execution");
  const job = { id: operation.execution.id };
  return withWorkspaceTransaction(scope, (tx) => getNoteOverviewTask(tx, scope, noteId, job.id));
}

async function taskForJob(tx: ApiTransaction, scope: NoteOverviewScopeV1, note: { currentVersionId: string | null }, noteId: string, job: typeof jobs.$inferSelect) {
  const payloadNoteId = typeof job.payload.noteId === "string" ? job.payload.noteId : null;
  const noteVersionId = typeof job.payload.noteVersionId === "string" ? job.payload.noteVersionId : null;
  if (job.type !== JobType.NOTE_OVERVIEW_GENERATE || payloadNoteId !== noteId || !noteVersionId) {
    throw new NoteOverviewError("task_not_found", "这条速看记录不属于当前笔记。");
  }
  const [saved] = await tx.select({ overview: noteOverviews, noteVersionNumber: noteVersions.versionNo })
    .from(noteOverviews).innerJoin(noteVersions, eq(noteVersions.id, noteOverviews.noteVersionId))
    .where(and(
      owned(scope, noteId),
      eq(noteOverviews.generationJobId, job.id),
      eq(noteOverviews.noteVersionId, noteVersionId),
    )).limit(1);

  let status: NoteOverviewTaskV1["status"];
  if (job.status === JobStatus.PENDING) status = "queued";
  else if (job.status === JobStatus.RUNNING) status = "running";
  else if (job.status === JobStatus.SUCCEEDED && saved) status = "ready";
  else status = "failed";
  const failureReason = status === "failed"
    ? classifyJobFailureReason(job.lastError) ?? "unknown"
    : null;
  return noteOverviewTaskV1Schema.parse({
    taskId: job.id,
    agentRunId: await agentRunForDomainExecution(tx, scope, "job", job.id),
    noteId,
    noteVersionId,
    status,
    overview: status === "ready" && saved ? project(saved.overview, note.currentVersionId, saved.noteVersionNumber) : null,
    failureReason,
    createdAt: job.scheduledAt.toISOString(),
  });
}

export async function getNoteOverviewTask(
  tx: ApiTransaction,
  scope: NoteOverviewScopeV1,
  noteId: string,
  taskId: string,
) {
  const note = await requireVisibleNote(tx, scope, noteId);
  const [job] = await tx.select().from(jobs).where(and(
    eq(jobs.id, taskId),
    eq(jobs.workspaceId, scope.workspaceId),
    eq(jobs.requestedBy, scope.userId),
    eq(jobs.type, JobType.NOTE_OVERVIEW_GENERATE),
    sql`${jobs.payload}->>'noteId' = ${noteId}`,
  )).limit(1);
  if (!job) throw new NoteOverviewError("task_not_found", "这条速看记录现在读不到。");
  return taskForJob(tx, scope, note, noteId, job);
}

export async function getLatestNoteOverviewTask(
  tx: ApiTransaction,
  scope: NoteOverviewScopeV1,
  noteId: string,
  noteVersionId: string,
) {
  const note = await requireVisibleNote(tx, scope, noteId);
  const [job] = await tx.select().from(jobs).where(and(
    eq(jobs.workspaceId, scope.workspaceId),
    eq(jobs.requestedBy, scope.userId),
    eq(jobs.type, JobType.NOTE_OVERVIEW_GENERATE),
    sql`${jobs.payload}->>'noteId' = ${noteId}`,
    sql`${jobs.payload}->>'noteVersionId' = ${noteVersionId}`,
  )).orderBy(desc(jobs.scheduledAt), desc(jobs.id)).limit(1);
  return noteOverviewLatestTaskV1Schema.parse({
    version: 1,
    task: job ? await taskForJob(tx, scope, note, noteId, job) : null,
  });
}
