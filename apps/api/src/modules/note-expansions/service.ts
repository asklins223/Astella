import { createHash } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { ApiTransaction } from "../../db/client.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { jobs } from "@ailearn/shared/db-schema/job";
import { noteExpansionTasks, noteExpansions } from "@ailearn/shared/db-schema/note-expansions";
import { noteBlocks, noteVersions, notes } from "@ailearn/shared/db-schema/note";
import { JobStatus, JobType } from "@ailearn/shared/enums";
import { noteBlockRenderedTextV1 } from "@ailearn/shared/note-doc-schema";
import {
  confirmNoteExpansionTaskV1Schema,
  createNoteExpansionTaskV1Schema,
  noteExpansionBatchWriteResultV1Schema,
  noteExpansionDraftV1Schema,
  noteExpansionLatestTaskV1Schema,
  noteExpansionLinkV1Schema,
  noteExpansionPageV1Schema,
  noteExpansionTaskV1Schema,
  noteExpansionReviewV1Schema,
  type NoteExpansionDraftV1,
  type NoteExpansionLinkV1,
  type NoteExpansionTaskV1,
} from "@ailearn/shared/note-expansion-contracts";
import { readNoteExpansionGenerateJobPayload } from "@ailearn/shared/job-payload-contracts";
import type { z } from "zod";
import { visibleNotesCondition } from "../note/visibility.ts";
import { classifyJobFailureReason, createJob } from "../job/service.ts";
import { createNote } from "../note/service.ts";
import { isAssistantReplyForNote } from "../note/companion-source.ts";

const sourceVersions = alias(noteVersions, "source_versions");
const expandedVersions = alias(noteVersions, "expanded_versions");

export type NoteExpansionScopeV1 = { workspaceId: string; userId: string };
type StartInput = z.infer<typeof createNoteExpansionTaskV1Schema>;

export class NoteExpansionError extends Error {
  constructor(
    readonly code: "note_not_found" | "note_version_not_found" | "selection_anchor_mismatch" | "source_message_not_found" | "task_not_found" | "task_not_ready" | "task_already_confirmed" | "draft_set_changed" | "idempotency_conflict" | "save_unconfirmed" | "expansion_not_found",
    message: string,
  ) {
    super(message);
    this.name = "NoteExpansionError";
  }
}

async function requireVisibleNote(tx: ApiTransaction, scope: NoteExpansionScopeV1, noteId: string, lock = false) {
  const query = tx.select({ id: notes.id, currentVersionId: notes.currentVersionId }).from(notes).where(and(
    eq(notes.id, noteId), eq(notes.workspaceId, scope.workspaceId), visibleNotesCondition(scope.userId), isNull(notes.deletedAt),
  ));
  const [note] = lock ? await query.for("update") : await query.for("share");
  if (!note) throw new NoteExpansionError("note_not_found", "这篇笔记现在读不到，请回到笔记架核对权限。");
  return note;
}

type ExpansionRow = typeof noteExpansions.$inferSelect;
function project(
  row: ExpansionRow,
  otherNoteTitle: string,
  direction: NoteExpansionLinkV1["direction"],
  sourceNoteVersionNumber: number,
  expandedNoteVersionNumber: number,
) {
  return noteExpansionLinkV1Schema.parse({
    expansionId: row.id,
    sourceNoteId: row.sourceNoteId,
    sourceNoteVersionId: row.sourceNoteVersionId,
    sourceNoteVersionNumber,
    sourceTaskId: row.sourceTaskId,
    expandedNoteId: row.expandedNoteId,
    expandedNoteVersionId: row.expandedNoteVersionId,
    expandedNoteVersionNumber,
    sourceMessageId: row.sourceMessageId,
    conversationId: row.conversationId,
    otherNoteTitle,
    direction,
    createdAt: row.createdAt.toISOString(),
  });
}

const owned = (scope: NoteExpansionScopeV1) => and(
  eq(noteExpansions.workspaceId, scope.workspaceId),
  eq(noteExpansions.userId, scope.userId),
);

export async function listNoteExpansions(
  tx: ApiTransaction,
  scope: NoteExpansionScopeV1,
  noteId: string,
  before?: { createdAt: string; expansionId: string },
) {
  await requireVisibleNote(tx, scope, noteId);
  const cursor = before
    ? sql`(${noteExpansions.createdAt}, ${noteExpansions.id}) < (${before.createdAt}::timestamptz, ${before.expansionId}::uuid)`
    : undefined;
  const outgoing = await tx.select({ expansion: noteExpansions, title: notes.title, sourceVersionNo: sourceVersions.versionNo, expandedVersionNo: expandedVersions.versionNo }).from(noteExpansions)
    .innerJoin(notes, eq(notes.id, noteExpansions.expandedNoteId))
    .innerJoin(sourceVersions, eq(sourceVersions.id, noteExpansions.sourceNoteVersionId))
    .innerJoin(expandedVersions, eq(expandedVersions.id, noteExpansions.expandedNoteVersionId))
    .where(and(
      owned(scope), eq(noteExpansions.sourceNoteId, noteId), cursor,
      eq(notes.workspaceId, scope.workspaceId), visibleNotesCondition(scope.userId), isNull(notes.deletedAt),
    )).orderBy(desc(noteExpansions.createdAt), desc(noteExpansions.id)).limit(101);
  const incoming = await tx.select({ expansion: noteExpansions, title: notes.title, sourceVersionNo: sourceVersions.versionNo, expandedVersionNo: expandedVersions.versionNo }).from(noteExpansions)
    .innerJoin(notes, eq(notes.id, noteExpansions.sourceNoteId))
    .innerJoin(sourceVersions, eq(sourceVersions.id, noteExpansions.sourceNoteVersionId))
    .innerJoin(expandedVersions, eq(expandedVersions.id, noteExpansions.expandedNoteVersionId))
    .where(and(
      owned(scope), eq(noteExpansions.expandedNoteId, noteId), cursor,
      eq(notes.workspaceId, scope.workspaceId), visibleNotesCondition(scope.userId), isNull(notes.deletedAt),
    )).orderBy(desc(noteExpansions.createdAt), desc(noteExpansions.id)).limit(101);
  const items = [
    ...outgoing.map(({ expansion, title, sourceVersionNo, expandedVersionNo }) => project(expansion, title, "expanded_from_here", sourceVersionNo, expandedVersionNo)),
    ...incoming.map(({ expansion, title, sourceVersionNo, expandedVersionNo }) => project(expansion, title, "source_note", sourceVersionNo, expandedVersionNo)),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.expansionId.localeCompare(a.expansionId));
  const pageItems = items.slice(0, 100);
  const last = pageItems.at(-1);
  return noteExpansionPageV1Schema.parse({
    version: 1,
    items: pageItems,
    nextCursor: items.length > 100 && last ? { createdAt: last.createdAt, expansionId: last.expansionId } : null,
  });
}

async function validateFocusAnchor(tx: ApiTransaction, scope: NoteExpansionScopeV1, input: StartInput) {
  if (!input.focusAnchor) return;
  const anchor = input.focusAnchor;
  const [block] = await tx.select({ type: noteBlocks.type, content: noteBlocks.content }).from(noteBlocks).where(and(
    eq(noteBlocks.workspaceId, scope.workspaceId), eq(noteBlocks.versionId, input.noteVersionId), eq(noteBlocks.ordinal, anchor.startBlockOrdinal),
  ));
  const text = block ? noteBlockRenderedTextV1(block.type, block.content) : "";
  if (!block || anchor.endOffset > text.length || text.slice(anchor.startOffset, anchor.endOffset) !== anchor.excerpt
    || text.slice(Math.max(0, anchor.startOffset - 120), anchor.startOffset) !== anchor.prefix
    || text.slice(anchor.endOffset, anchor.endOffset + 120) !== anchor.suffix) {
    throw new NoteExpansionError("selection_anchor_mismatch", "选中的原句位置和这版笔记对不上，请重新圈选后再拓展。");
  }
}

export async function startNoteExpansionTask(scope: NoteExpansionScopeV1, noteId: string, input: StartInput) {
  await withWorkspaceTransaction(scope, async (tx) => {
    const note = await requireVisibleNote(tx, scope, noteId);
    if (note.currentVersionId !== input.noteVersionId) {
      throw new NoteExpansionError("note_version_not_found", "笔记刚刚更新了，请从当前正文重新开始拓展。");
    }
    const [version] = await tx.select({ id: noteVersions.id }).from(noteVersions).where(and(
      eq(noteVersions.id, input.noteVersionId), eq(noteVersions.noteId, noteId), eq(noteVersions.workspaceId, scope.workspaceId),
    ));
    if (!version) throw new NoteExpansionError("note_version_not_found", "这篇笔记的当前版本暂时读不到。");
    await validateFocusAnchor(tx, scope, input);
    if (input.sourceMessageId && input.conversationId) {
      const hasSourceReply = await isAssistantReplyForNote(tx, scope, {
        messageId: input.sourceMessageId,
        conversationId: input.conversationId,
        noteId,
        noteVersionId: input.noteVersionId,
      });
      if (!hasSourceReply) throw new NoteExpansionError("source_message_not_found", "伴星对话里的这条笔记引用已经变化，请从当前正文重新开始。");
    }
  });

  const job = await createJob({
    type: JobType.NOTE_EXPANSION_GENERATE,
    workspaceId: scope.workspaceId,
    requestedBy: scope.userId,
    idempotencyKey: `note-expansion:${noteId}:${input.noteVersionId}:${input.requestId}`,
    payload: {
      noteId,
      noteVersionId: input.noteVersionId,
      requestId: input.requestId,
      ...(input.focusAnchor ? { focusAnchor: input.focusAnchor } : {}),
      ...(input.sourceMessageId && input.conversationId ? { sourceMessageId: input.sourceMessageId, conversationId: input.conversationId } : {}),
    },
  });
  return withWorkspaceTransaction(scope, (tx) => getNoteExpansionTask(tx, scope, noteId, job.id));
}

async function taskForJob(
  tx: ApiTransaction,
  scope: NoteExpansionScopeV1,
  noteId: string,
  job: typeof jobs.$inferSelect,
): Promise<NoteExpansionTaskV1> {
  const input = readNoteExpansionGenerateJobPayload(job.payload);
  if (job.type !== JobType.NOTE_EXPANSION_GENERATE || input.noteId !== noteId) {
    throw new NoteExpansionError("task_not_found", "这条拓展任务不属于当前笔记。");
  }
  const [saved] = await tx.select().from(noteExpansionTasks).where(and(
    eq(noteExpansionTasks.id, job.id),
    eq(noteExpansionTasks.workspaceId, scope.workspaceId),
    eq(noteExpansionTasks.userId, scope.userId),
    eq(noteExpansionTasks.noteId, noteId),
  )).limit(1);
  let status: NoteExpansionTaskV1["status"];
  if (job.status === JobStatus.PENDING) status = "queued";
  else if (job.status === JobStatus.RUNNING) status = "running";
  else if (job.status === JobStatus.SUCCEEDED && saved) status = saved.confirmedAt ? "confirmed" : "ready";
  else status = "failed";
  return noteExpansionTaskV1Schema.parse({
    taskId: job.id,
    noteId,
    noteVersionId: input.noteVersionId,
    focusAnchor: input.focusAnchor ?? null,
    sourceMessageId: saved?.sourceMessageId ?? input.sourceMessageId ?? null,
    conversationId: saved?.conversationId ?? input.conversationId ?? null,
    status,
    drafts: saved?.drafts ?? [],
    confirmedCandidateIds: saved?.confirmedCandidateIds ?? null,
    failureReason: status === "failed" ? classifyJobFailureReason(job.lastError) ?? "unknown" : null,
    createdAt: job.scheduledAt.toISOString(),
  });
}

export async function getNoteExpansionTask(tx: ApiTransaction, scope: NoteExpansionScopeV1, noteId: string, taskId: string) {
  await requireVisibleNote(tx, scope, noteId);
  const [job] = await tx.select().from(jobs).where(and(
    eq(jobs.id, taskId),
    eq(jobs.workspaceId, scope.workspaceId),
    eq(jobs.requestedBy, scope.userId),
    eq(jobs.type, JobType.NOTE_EXPANSION_GENERATE),
    sql`${jobs.payload}->>'noteId' = ${noteId}`,
  )).limit(1);
  if (!job) throw new NoteExpansionError("task_not_found", "这条拓展任务现在读不到。");
  return taskForJob(tx, scope, noteId, job);
}

export async function getLatestNoteExpansionTask(tx: ApiTransaction, scope: NoteExpansionScopeV1, noteId: string, noteVersionId: string) {
  await requireVisibleNote(tx, scope, noteId);
  const [job] = await tx.select().from(jobs).where(and(
    eq(jobs.workspaceId, scope.workspaceId),
    eq(jobs.requestedBy, scope.userId),
    eq(jobs.type, JobType.NOTE_EXPANSION_GENERATE),
    sql`${jobs.payload}->>'noteId' = ${noteId}`,
    sql`${jobs.payload}->>'noteVersionId' = ${noteVersionId}`,
  )).orderBy(desc(jobs.scheduledAt), desc(jobs.id)).limit(1);
  return noteExpansionLatestTaskV1Schema.parse({
    version: 1,
    task: job ? await taskForJob(tx, scope, noteId, job) : null,
  });
}

export async function updateNoteExpansionTaskDrafts(
  tx: ApiTransaction,
  scope: NoteExpansionScopeV1,
  noteId: string,
  taskId: string,
  rawReview: unknown,
) {
  const review = noteExpansionReviewV1Schema.parse(rawReview);
  await requireVisibleNote(tx, scope, noteId);
  const [task] = await tx.select().from(noteExpansionTasks).where(and(
    eq(noteExpansionTasks.id, taskId), eq(noteExpansionTasks.workspaceId, scope.workspaceId),
    eq(noteExpansionTasks.userId, scope.userId), eq(noteExpansionTasks.noteId, noteId),
  )).for("update").limit(1);
  if (!task) throw new NoteExpansionError("task_not_ready", "拓展草稿还在整理，完成后才能筛选。");
  if (task.confirmedAt) throw new NoteExpansionError("task_already_confirmed", "这批草稿已经收下，不能再改写原记录。");
  const [job] = await tx.select().from(jobs).where(and(
    eq(jobs.id, taskId), eq(jobs.workspaceId, scope.workspaceId), eq(jobs.requestedBy, scope.userId),
    eq(jobs.type, JobType.NOTE_EXPANSION_GENERATE),
  )).limit(1);
  if (!job || job.status !== JobStatus.SUCCEEDED) {
    throw new NoteExpansionError("task_not_ready", "拓展草稿还在整理，完成后才能筛选。");
  }
  const currentById = new Map(task.drafts.map((draft) => [draft.candidateId, draft]));
  if (review.drafts.length !== task.drafts.length || review.drafts.some((draft) => !currentById.has(draft.candidateId))) {
    throw new NoteExpansionError("draft_set_changed", "这批草稿已更新，请重新打开后再编辑。");
  }
  const updated = task.drafts.map((draft) => {
    const edit = review.drafts.find((item) => item.candidateId === draft.candidateId)!;
    return noteExpansionDraftV1Schema.parse({
      ...draft,
      title: edit.title,
      blocks: edit.blocks,
      selected: edit.selected,
    });
  });
  await tx.update(noteExpansionTasks).set({ drafts: updated, updatedAt: sql`now()` }).where(and(
    eq(noteExpansionTasks.id, taskId), eq(noteExpansionTasks.workspaceId, scope.workspaceId), eq(noteExpansionTasks.userId, scope.userId),
  ));
  return taskForJob(tx, scope, noteId, job);
}

function bodyHash(input: {
  taskId: string;
  candidateId: string;
  sourceNoteId: string;
  sourceNoteVersionId: string;
  title: string;
  blocks: NoteExpansionDraftV1["blocks"];
}) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/**
 * 2026-09-29：`note-visibility-read-sites` 棘轮抓到的真实失权读点。
 *
 * 病：这里 `innerJoin(notes, ...)` 取 `notes.title`，而 `where` 只有 `owned(scope)`
 * （= workspace_id + user_id）。但"用户拥有这条拓展记录"**不等于**
 * "用户现在还能读到它指向的那篇笔记"——笔记可以被软删（deleted_at 置位）、
 * share_scope 可以收窄、也可以转手给别人。这三种情况下旧记录仍在，
 * title 照样读得出来。
 *
 * 同文件 `listNoteExpansions` 的两处 join 早就带了这两个判据，只有这条按
 * requestId 回查的路径漏了。
 *
 * 修法把判据直接写进 `innerJoin` 的连接条件，而不是塞在后面的 `where`：
 * 语义上"这篇笔记对我不可见"是**连不上**，不是"连上了再筛掉"；后者在行数上更贵，
 * 前者还能让 `notes` 走更少的行。
 *
 * 补上之后：目标笔记一旦不可见，这条记录连同标题一起读不出来——幂等回查返回
 * "没有这条记录"，调用方按新建处理，不会把旧标题返给用户。
 */
async function findExpansionByRequest(tx: ApiTransaction, scope: NoteExpansionScopeV1, requestId: string) {
  const [existing] = await tx.select({ expansion: noteExpansions, title: notes.title, sourceVersionNo: sourceVersions.versionNo, expandedVersionNo: expandedVersions.versionNo })
    .from(noteExpansions)
    .innerJoin(notes, and(
      eq(notes.id, noteExpansions.expandedNoteId),
      eq(notes.workspaceId, scope.workspaceId),
      visibleNotesCondition(scope.userId),
      isNull(notes.deletedAt),
    ))
    .innerJoin(sourceVersions, eq(sourceVersions.id, noteExpansions.sourceNoteVersionId))
    .innerJoin(expandedVersions, eq(expandedVersions.id, noteExpansions.expandedNoteVersionId))
    .where(and(owned(scope), eq(noteExpansions.requestId, requestId))).limit(1);
  return existing ? {
    link: project(existing.expansion, existing.title, "expanded_from_here", existing.sourceVersionNo, existing.expandedVersionNo),
    requestBodyHash: existing.expansion.requestBodyHash,
  } : null;
}

function draftBodyHash(taskId: string, noteId: string, task: typeof noteExpansionTasks.$inferSelect, draft: NoteExpansionDraftV1) {
  return bodyHash({
    taskId,
    candidateId: draft.candidateId,
    sourceNoteId: noteId,
    sourceNoteVersionId: task.noteVersionId,
    title: draft.title,
    blocks: draft.blocks,
  });
}

export async function confirmNoteExpansionTask(
  tx: ApiTransaction,
  scope: NoteExpansionScopeV1,
  noteId: string,
  taskId: string,
  rawInput: unknown,
) {
  const input = confirmNoteExpansionTaskV1Schema.parse(rawInput);
  await requireVisibleNote(tx, scope, noteId, true);
  const [task] = await tx.select().from(noteExpansionTasks).where(and(
    eq(noteExpansionTasks.id, taskId), eq(noteExpansionTasks.workspaceId, scope.workspaceId),
    eq(noteExpansionTasks.userId, scope.userId), eq(noteExpansionTasks.noteId, noteId),
  )).for("update").limit(1);
  if (!task) throw new NoteExpansionError("task_not_ready", "拓展草稿还没准备好，请等它整理完成后再收下。");
  const [job] = await tx.select().from(jobs).where(and(
    eq(jobs.id, taskId), eq(jobs.workspaceId, scope.workspaceId), eq(jobs.requestedBy, scope.userId),
    eq(jobs.type, JobType.NOTE_EXPANSION_GENERATE), eq(jobs.status, JobStatus.SUCCEEDED),
  )).limit(1);
  if (!job) throw new NoteExpansionError("task_not_ready", "拓展草稿还没准备好，请等它整理完成后再收下。");

  const requestedIds = [...input.candidateIds].sort();
  if (task.confirmedCandidateIds) {
    const confirmedIds = [...task.confirmedCandidateIds].sort();
    if (JSON.stringify(requestedIds) !== JSON.stringify(confirmedIds)) {
      throw new NoteExpansionError("task_already_confirmed", "这批草稿已经按另一组选择收下，原记录没有变化。");
    }
    const selected = task.drafts.filter((draft) => task.confirmedCandidateIds!.includes(draft.candidateId));
    const existing = await Promise.all(selected.map((draft) => findExpansionByRequest(tx, scope, draft.requestId)));
    if (existing.some((item) => !item)) throw new NoteExpansionError("save_unconfirmed", "部分拓展笔记已不在笔记架中，请重新读取这篇笔记的关联记录。");
    if (existing.some((item, index) => item?.requestBodyHash !== draftBodyHash(taskId, noteId, task, selected[index]!))) {
      throw new NoteExpansionError("idempotency_conflict", "已确认的拓展内容和这次请求不一致，请重新读取关联记录。");
    }
    return noteExpansionBatchWriteResultV1Schema.parse(existing.map((item) => item!.link));
  }

  const selected = task.drafts.filter((draft) => input.candidateIds.includes(draft.candidateId));
  const selectedIds = selected.map((draft) => draft.candidateId).sort();
  const checkedIds = task.drafts.filter((draft) => draft.selected).map((draft) => draft.candidateId).sort();
  if (JSON.stringify(selectedIds) !== JSON.stringify(requestedIds) || JSON.stringify(checkedIds) !== JSON.stringify(requestedIds)) {
    throw new NoteExpansionError("draft_set_changed", "先在草稿册里勾选想收下的内容，再确认这批笔记。");
  }

  const [sourceVersion] = await tx.select({ versionNo: noteVersions.versionNo }).from(noteVersions).where(and(
    eq(noteVersions.id, task.noteVersionId), eq(noteVersions.noteId, noteId), eq(noteVersions.workspaceId, scope.workspaceId),
  ));
  if (!sourceVersion) throw new NoteExpansionError("note_version_not_found", "拓展内容指向的原笔记版本已经不存在。");

  const links: NoteExpansionLinkV1[] = [];
  for (const draft of selected) {
    const hash = draftBodyHash(taskId, noteId, task, draft);
    const existing = await findExpansionByRequest(tx, scope, draft.requestId);
    if (existing) {
      if (existing.link.sourceNoteId !== noteId || existing.link.sourceTaskId !== taskId) {
        throw new NoteExpansionError("idempotency_conflict", "这篇草稿编号已被用于其他拓展，原笔记没有变化。");
      }
      if (existing.requestBodyHash !== hash) {
        throw new NoteExpansionError("idempotency_conflict", "这篇草稿内容和同一请求编号下的已保存内容不一致，原笔记没有变化。");
      }
      links.push(existing.link);
      continue;
    }

    const created = await createNote(tx, scope.workspaceId, scope.userId, {
      title: draft.title,
      blocks: draft.blocks.map((block) => ({ type: block.type, content: block.content })),
    });
    if (!created?.note?.id || !created.version?.id) {
      throw new NoteExpansionError("save_unconfirmed", "新笔记的保存回执不完整；这批拓展没有确认完成。");
    }
    const [row] = await tx.insert(noteExpansions).values({
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      sourceNoteId: noteId,
      sourceNoteVersionId: task.noteVersionId,
      sourceTaskId: taskId,
      expandedNoteId: created.note.id,
      expandedNoteVersionId: created.version.id,
      sourceMessageId: task.sourceMessageId,
      conversationId: task.conversationId,
      requestId: draft.requestId,
      requestBodyHash: hash,
    }).returning();
    if (!row) throw new NoteExpansionError("save_unconfirmed", "拓展笔记已经创建，但关联回执没能确认；请重新读取笔记架。");
    links.push(project(row, created.note.title, "expanded_from_here", sourceVersion.versionNo, created.version.versionNo));
  }

  await tx.update(noteExpansionTasks).set({
    confirmedCandidateIds: requestedIds,
    confirmedAt: new Date(),
    updatedAt: sql`now()`,
  }).where(and(eq(noteExpansionTasks.id, taskId), eq(noteExpansionTasks.workspaceId, scope.workspaceId)));
  return noteExpansionBatchWriteResultV1Schema.parse(links);
}
