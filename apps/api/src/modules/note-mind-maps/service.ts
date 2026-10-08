import { readSafeErrorCode } from "@astella/shared";
import { startDomainAgentRequest, agentRunForDomainExecution } from "../../agent/runtime.ts";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { jobs } from "@astella/shared/db-schema/job";
import { noteMindMaps } from "@astella/shared/db-schema/note-mind-maps";
import { noteBlocks, noteVersions, notes } from "@astella/shared/db-schema/note";
import { JobStatus, JobType } from "@astella/shared/enums";
import {
  noteMindMapLatestTaskV1Schema,
  noteMindMapTaskV1Schema,
  noteMindMapV1Schema,
  type NoteMindMapTaskV1,
} from "@astella/shared/note-mind-map-contracts";
import type { createNoteMindMapTaskV1Schema } from "@astella/shared/note-mind-map-contracts";
import type { z } from "zod";
import { visibleNotesCondition } from "../note/visibility.ts";
import { classifyJobFailureReason } from "../job/service.ts";

export type NoteMindMapScopeV1 = { workspaceId: string; userId: string };
type StartMindMapInput = z.infer<typeof createNoteMindMapTaskV1Schema>;

export class NoteMindMapError extends Error {
  constructor(readonly code: "note_not_found" | "note_version_not_found" | "task_not_found" | "mind_map_not_found", message: string) {
    super(message);
    this.name = "NoteMindMapError";
  }
}

// A read must not hold a row lock against collaborative note edits. RLS also checks visibility.
async function requireVisibleNote(tx: ApiTransaction, scope: NoteMindMapScopeV1, noteId: string) {
  const [note] = await tx.select({ id: notes.id, currentVersionId: notes.currentVersionId }).from(notes).where(and(
    eq(notes.id, noteId), eq(notes.workspaceId, scope.workspaceId), visibleNotesCondition(scope.userId), isNull(notes.deletedAt),
  ));
  if (!note) throw new NoteMindMapError("note_not_found", "这篇笔记现在读不到，请回到笔记架核对权限。");
  return note;
}

type MindMapRow = typeof noteMindMaps.$inferSelect;
function project(row: MindMapRow, currentVersionId: string | null, noteVersionNumber: number) {
  return noteMindMapV1Schema.parse({
    mindMapId: row.id,
    noteId: row.noteId,
    noteVersionId: row.noteVersionId,
    noteVersionNumber,
    title: row.title, contentHash: row.contentHash, content: row.content, coverage: row.coverage,
    generationJobId: row.generationJobId, modelId: row.modelId, promptVersion: row.promptVersion,
    versionState: row.noteVersionId === currentVersionId ? "current" : "older",
    createdAt: row.createdAt.toISOString(),
  });
}

const owned = (scope: NoteMindMapScopeV1, noteId: string) => and(
  eq(noteMindMaps.workspaceId, scope.workspaceId),
  eq(noteMindMaps.userId, scope.userId),
  eq(noteMindMaps.noteId, noteId),
);

export async function listNoteMindMaps(
  tx: ApiTransaction,
  scope: NoteMindMapScopeV1,
  noteId: string,
  before?: string,
) {
  const note = await requireVisibleNote(tx, scope, noteId);
  const [cursor] = before ? await tx.select().from(noteMindMaps).where(and(owned(scope, noteId), eq(noteMindMaps.id, before))) : [];
  if (before && !cursor) throw new NoteMindMapError("mind_map_not_found", "脑图记录位置已变化，请重新读取。");
  const rows = await tx.select({ mindMap: noteMindMaps, noteVersionNumber: noteVersions.versionNo }).from(noteMindMaps)
    .innerJoin(noteVersions, eq(noteVersions.id, noteMindMaps.noteVersionId))
    .where(and(
      owned(scope, noteId),
      cursor ? sql`(${noteMindMaps.createdAt}, ${noteMindMaps.id}) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)` : undefined,
    )).orderBy(desc(noteMindMaps.createdAt), desc(noteMindMaps.id)).limit(101);
  return {
    version: 1 as const,
    items: rows.slice(0, 100).map((row) => project(row.mindMap, note.currentVersionId, row.noteVersionNumber)),
    nextCursor: rows.length > 100 ? rows[99]!.mindMap.id : null,
  };
}

export async function startNoteMindMapTask(
  scope: NoteMindMapScopeV1,
  noteId: string,
  input: StartMindMapInput,
): Promise<NoteMindMapTaskV1> {
  await withWorkspaceTransaction(scope, async (tx) => {
    const note = await requireVisibleNote(tx, scope, noteId);
    if (note.currentVersionId !== input.noteVersionId) {
      throw new NoteMindMapError("note_version_not_found", "笔记刚刚更新了，请从当前正文重新开始脑图。");
    }
    const [version] = await tx.select({ id: noteVersions.id }).from(noteVersions).where(and(
      eq(noteVersions.id, input.noteVersionId),
      eq(noteVersions.noteId, noteId),
      eq(noteVersions.workspaceId, scope.workspaceId),
    ));
    if (!version) throw new NoteMindMapError("note_version_not_found", "这篇笔记的当前版本暂时读不到。");
  });

  const { operation } = await startDomainAgentRequest(scope, { capability: "note_mind_map_generate", noteId, request: input }, "整理这版笔记的脑图。");
  if (operation.execution.kind !== "job") throw new Error("note capability returned a different execution");
  const job = { id: operation.execution.id };
  return withWorkspaceTransaction(scope, (tx) => getNoteMindMapTask(tx, scope, noteId, job.id));
}

async function taskForJob(tx: ApiTransaction, scope: NoteMindMapScopeV1, note: { currentVersionId: string | null }, noteId: string, job: typeof jobs.$inferSelect) {
  const payloadNoteId = typeof job.payload.noteId === "string" ? job.payload.noteId : null;
  const noteVersionId = typeof job.payload.noteVersionId === "string" ? job.payload.noteVersionId : null;
  if (job.type !== JobType.NOTE_MIND_MAP_GENERATE || payloadNoteId !== noteId || !noteVersionId) {
    throw new NoteMindMapError("task_not_found", "这条脑图记录不属于当前笔记。");
  }
  const [saved] = await tx.select({ mindMap: noteMindMaps, noteVersionNumber: noteVersions.versionNo })
    .from(noteMindMaps).innerJoin(noteVersions, eq(noteVersions.id, noteMindMaps.noteVersionId))
    .where(and(
      owned(scope, noteId),
      eq(noteMindMaps.generationJobId, job.id),
      eq(noteMindMaps.noteVersionId, noteVersionId),
    )).limit(1);

  let status: NoteMindMapTaskV1["status"];
  if (job.status === JobStatus.PENDING) status = "queued";
  else if (job.status === JobStatus.RUNNING) status = "running";
  else if (job.status === JobStatus.SUCCEEDED && saved) status = "ready";
  else status = "failed";
  const failureReason = status === "failed"
    ? classifyJobFailureReason(job.lastError) ?? "unknown"
    : null;
  return noteMindMapTaskV1Schema.parse({
    taskId: job.id,
    agentRunId: await agentRunForDomainExecution(tx, scope, "job", job.id),
    noteId,
    noteVersionId,
    status,
    mindMap: status === "ready" && saved ? project(saved.mindMap, note.currentVersionId, saved.noteVersionNumber) : null,
    failureReason,
    failureMessage: status === "failed" ? mindMapFailureMessage(job.lastError) : null,
    createdAt: job.scheduledAt.toISOString(),
  });
}

export async function getNoteMindMapTask(
  tx: ApiTransaction,
  scope: NoteMindMapScopeV1,
  noteId: string,
  taskId: string,
) {
  const note = await requireVisibleNote(tx, scope, noteId);
  const [job] = await tx.select().from(jobs).where(and(
    eq(jobs.id, taskId),
    eq(jobs.workspaceId, scope.workspaceId),
    eq(jobs.requestedBy, scope.userId),
    eq(jobs.type, JobType.NOTE_MIND_MAP_GENERATE),
    sql`${jobs.payload}->>'noteId' = ${noteId}`,
  )).limit(1);
  if (!job) throw new NoteMindMapError("task_not_found", "这条脑图记录现在读不到。");
  return taskForJob(tx, scope, note, noteId, job);
}

export async function getLatestNoteMindMapTask(
  tx: ApiTransaction,
  scope: NoteMindMapScopeV1,
  noteId: string,
  noteVersionId: string,
) {
  const note = await requireVisibleNote(tx, scope, noteId);
  const [job] = await tx.select().from(jobs).where(and(
    eq(jobs.workspaceId, scope.workspaceId),
    eq(jobs.requestedBy, scope.userId),
    eq(jobs.type, JobType.NOTE_MIND_MAP_GENERATE),
    sql`${jobs.payload}->>'noteId' = ${noteId}`,
    sql`${jobs.payload}->>'noteVersionId' = ${noteVersionId}`,
  )).orderBy(desc(jobs.scheduledAt), desc(jobs.id)).limit(1);
  return noteMindMapLatestTaskV1Schema.parse({
    version: 1,
    task: job ? await taskForJob(tx, scope, note, noteId, job) : null,
  });
}

function mindMapFailureMessage(error: string | null) {
  switch (readSafeErrorCode(error)) {
    case "NOTE_MIND_MAP_BUDGET": return "这次整理已到生成预算上限，已有脑图和完成的分段保留。可以重新生成或拆分笔记。";
    case "NOTE_MIND_MAP_TOO_LONG": return "这篇笔记太长，暂时不能保证全文读取。请把内容拆成几篇再生成。";
    case "NOTE_MIND_MAP_NO_TEXT": return "还没有可读的文字。图片画面暂未读取，请补充文字说明。";
    case "NOTE_MIND_MAP_OUTPUT_INVALID": return "这次脑图的结构或原文依据没有核对通过，已有脑图保留。可以重新生成。";
    case "ai_context_overflow": return "当前模型的上下文空间不足以整理整篇笔记。请换用容量更大的模型或拆分笔记。";
    default: return null;
  }
}

export async function getNoteMindMapSource(tx: ApiTransaction, scope: NoteMindMapScopeV1, noteId: string, mindMapId: string) {
  await requireVisibleNote(tx, scope, noteId);
  const [row] = await tx.select({ map: noteMindMaps, number: noteVersions.versionNo }).from(noteMindMaps)
    .innerJoin(noteVersions, eq(noteVersions.id, noteMindMaps.noteVersionId)).where(and(owned(scope, noteId), eq(noteMindMaps.id, mindMapId))).limit(1);
  if (!row) throw new NoteMindMapError("mind_map_not_found", "这份脑图对应的原文暂时读不到。");
  const blocks = await tx.select({ ordinal: noteBlocks.ordinal, type: noteBlocks.type, content: noteBlocks.content }).from(noteBlocks)
    .where(and(eq(noteBlocks.versionId, row.map.noteVersionId), eq(noteBlocks.workspaceId, scope.workspaceId))).orderBy(noteBlocks.ordinal);
  return { noteId, noteVersionId: row.map.noteVersionId, noteVersionNumber: row.number, title: row.map.title, blocks };
}
