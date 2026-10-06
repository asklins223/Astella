import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { noteBlocks, noteVersions, notes } from "@astella/shared/db-schema/note";
import { noteRecallRecords } from "@astella/shared/db-schema/note-recalls";
import { assistantReplyTextForNote } from "../note/companion-source.ts";
import { noteBlockRenderedTextV1 } from "@astella/shared/note-doc-schema";
import {
  noteRecallActionResultV1Schema,
  noteRecallPageV1Schema,
  noteRecallRecordV1Schema,
  noteRecallStartResultV1Schema,
} from "@astella/shared/note-recall-contracts";
import { visibleNotesCondition } from "../note/visibility.ts";
import { groundedRecallExcerpt, nextRecallExcerpt, recallExcerptCandidates } from "./recall-excerpt.ts";
import { deterministicRecallPrompt } from "./recall-prompt.ts";

export type NoteRecallScopeV1 = { workspaceId: string; userId: string };

export class NoteRecallError extends Error {
  constructor(readonly code: "note_not_found" | "note_version_not_found" | "recall_not_found" | "note_empty" | "not_revealed" | "already_reported" | "already_hinted" | "already_revealed" | "source_message_not_found" | "invalid_recall_question" | "invalid_recall_hint" | "request_conflict", message: string) {
    super(message);
    this.name = "NoteRecallError";
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
async function requireVisibleNote(tx: ApiTransaction, scope: NoteRecallScopeV1, noteId: string) {
  const [note] = await tx.select({ id: notes.id, currentVersionId: notes.currentVersionId })
    .from(notes).where(and(
      eq(notes.id, noteId), eq(notes.workspaceId, scope.workspaceId), visibleNotesCondition(scope.userId), isNull(notes.deletedAt),
    ));
  if (!note) throw new NoteRecallError("note_not_found", "这篇笔记现在读不到，请回到笔记架核对权限。");
  return note;
}

type RecallRow = typeof noteRecallRecords.$inferSelect;
function project(row: RecallRow, currentVersionId: string | null, noteVersionNumber: number) {
  const state = row.selfReport !== null ? "reported" : row.revealedAt ? "revealed" : row.hintViewedAt ? "hinted" : "waiting";
  const view = noteRecallRecordV1Schema.parse({
    recallId: row.id,
    noteId: row.noteId,
    noteVersionId: row.noteVersionId,
    noteVersionNumber,
    sectionOrdinal: row.sectionOrdinal,
    sectionTitle: row.sectionTitle,
    question: row.question,
    ...(row.hintViewedAt && row.hintSnapshot !== null ? { hint: row.hintSnapshot } : {}),
    sourceMessageId: row.sourceMessageId,
    conversationId: row.conversationId,
    hintSourceMessageId: row.hintSourceMessageId,
    hintConversationId: row.hintConversationId,
    ...(row.revealedAt ? { answer: row.answerSnapshot } : {}),
    answerTruncated: row.answerTruncated,
    selfReport: row.selfReport,
    reflection: row.reflection,
    state,
    versionState: row.noteVersionId === currentVersionId ? "current" : "older",
    createdAt: row.createdAt.toISOString(),
    hintViewedAt: row.hintViewedAt?.toISOString() ?? null,
    revealedAt: row.revealedAt?.toISOString() ?? null,
    reportedAt: row.reportedAt?.toISOString() ?? null,
  });
  return view;
}

const owned = (scope: NoteRecallScopeV1, noteId: string) => and(
  eq(noteRecallRecords.workspaceId, scope.workspaceId),
  eq(noteRecallRecords.userId, scope.userId),
  eq(noteRecallRecords.noteId, noteId),
);

export async function listNoteRecallRecords(tx: ApiTransaction, scope: NoteRecallScopeV1, noteId: string, before?: string) {
  const note = await requireVisibleNote(tx, scope, noteId);
  const [cursor] = before
    ? await tx.select().from(noteRecallRecords).where(and(owned(scope, noteId), eq(noteRecallRecords.id, before)))
    : [];
  if (before && !cursor) throw new NoteRecallError("recall_not_found", "回想记录位置已变化，请重新读取。");
  const rows = await tx.select({ record: noteRecallRecords, versionNumber: noteVersions.versionNo })
    .from(noteRecallRecords)
    .innerJoin(noteVersions, eq(noteVersions.id, noteRecallRecords.noteVersionId))
    .where(and(
      owned(scope, noteId),
      cursor ? sql`(${noteRecallRecords.createdAt}, ${noteRecallRecords.id}) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)` : undefined,
    )).orderBy(desc(noteRecallRecords.createdAt), desc(noteRecallRecords.id)).limit(101);
  return noteRecallPageV1Schema.parse({
    version: 1,
    items: rows.slice(0, 100).map((row) => project(row.record, note.currentVersionId, row.versionNumber)),
    nextCursor: rows.length > 100 ? rows[99]!.record.id : null,
  });
}

export async function createNoteRecallRecord(
  tx: ApiTransaction,
  scope: NoteRecallScopeV1,
  noteId: string,
  input: { requestId: string; noteVersionId: string; sourceMessageId?: string; conversationId?: string },
) {
  const note = await requireVisibleNote(tx, scope, noteId);
  const [existing] = await tx.select().from(noteRecallRecords).where(and(
    eq(noteRecallRecords.workspaceId, scope.workspaceId),
    eq(noteRecallRecords.userId, scope.userId),
    eq(noteRecallRecords.requestId, input.requestId),
  ));
  if (existing) {
    if (existing.noteId !== noteId || existing.noteVersionId !== input.noteVersionId
      || existing.sourceMessageId !== (input.sourceMessageId ?? null)
      || existing.conversationId !== (input.conversationId ?? null)) {
      throw new NoteRecallError("request_conflict", "这次回想已经对应另一份问题，原记录没有被覆盖。");
    }
    const [version] = await tx.select({ versionNo: noteVersions.versionNo }).from(noteVersions).where(eq(noteVersions.id, existing.noteVersionId));
    if (!version) throw new NoteRecallError("note_version_not_found", "原来的笔记版本已经不可用。");
    return noteRecallStartResultV1Schema.parse(project(existing, note.currentVersionId, version.versionNo));
  }
  if (!note.currentVersionId || note.currentVersionId !== input.noteVersionId) {
    throw new NoteRecallError("note_version_not_found", "笔记刚刚更新了；请从当前正文重新开始回想。旧内容没有被贴到新版本上。");
  }

  const [version] = await tx.select({ versionNo: noteVersions.versionNo }).from(noteVersions).where(and(
    eq(noteVersions.id, input.noteVersionId), eq(noteVersions.noteId, noteId), eq(noteVersions.workspaceId, scope.workspaceId),
  ));
  if (!version) throw new NoteRecallError("note_version_not_found", "这篇笔记的当前版本暂时读不到。");
  const blocks = await tx.select({ ordinal: noteBlocks.ordinal, type: noteBlocks.type, content: noteBlocks.content })
    .from(noteBlocks).where(and(eq(noteBlocks.workspaceId, scope.workspaceId), eq(noteBlocks.versionId, input.noteVersionId)))
    .orderBy(noteBlocks.ordinal);
  const readableBlocks = blocks.map((block) => ({
    ...block,
    text: noteBlockRenderedTextV1(block.type, block.content).trim(),
  })).filter((block) => block.type !== "image" && block.text.length > 0);
  if (readableBlocks.length === 0) throw new NoteRecallError("note_empty", "这篇笔记目前没有可以对照的文字。");
  const candidates = recallExcerptCandidates(readableBlocks);

  let question: string;
  let sectionOrdinal: number | null = null;
  let sectionTitle: string | null = null;
  let answer: string;
  let answerTruncated = false;
  if (input.sourceMessageId && input.conversationId) {
    const sourceQuestion = await assistantReplyTextForNote(tx, scope, {
      messageId: input.sourceMessageId,
      noteId,
      noteVersionId: input.noteVersionId,
      conversationId: input.conversationId,
      selectionText: null,
    });
    if (!sourceQuestion) throw new NoteRecallError("source_message_not_found", "这道回想题没有对应到当前笔记里的伴星回复，请重新问一次。");
    const questionEnd = sourceQuestion.search(/[？?]/u);
    if (questionEnd < 0) throw new NoteRecallError("invalid_recall_question", "伴星刚才没有留下清楚的问题；可以让她再试一次。");
    question = sourceQuestion.slice(0, questionEnd + 1)
      .replace(/^(?:回想问题|想一想|我问你|问题)[：:\s]*/u, "")
      .trim();
    if (question.length < 5 || question.length > 500) {
      throw new NoteRecallError("invalid_recall_question", "伴星刚才的问题太短或太长；可以让她再试一次。");
    }
    const basis = groundedRecallExcerpt(candidates, question);
    if (!basis) throw new NoteRecallError("invalid_recall_question", "这道问题还没有对应到明确的原文片段。可以换一道，或请伴星围绕一小段再问。");
    sectionOrdinal = basis.ordinal + 1;
    sectionTitle = basis.title;
    answer = basis.text;
    answerTruncated = basis.truncated;
  } else {
    const previous = await tx.select({ sectionOrdinal: noteRecallRecords.sectionOrdinal })
      .from(noteRecallRecords).where(and(owned(scope, noteId), eq(noteRecallRecords.noteVersionId, input.noteVersionId)))
      .orderBy(desc(noteRecallRecords.createdAt), desc(noteRecallRecords.id)).limit(100);
    const basis = nextRecallExcerpt(candidates, previous.flatMap(row => row.sectionOrdinal === null ? [] : [row.sectionOrdinal - 1]));
    if (!basis) throw new NoteRecallError("note_empty", "这篇笔记目前没有足够清楚、可以对照的文字片段。");
    sectionTitle = basis.title;
    sectionOrdinal = basis.ordinal + 1;
    question = deterministicRecallPrompt(basis).question;
    answer = basis.text;
    answerTruncated = basis.truncated;
  }

  const answerSnapshot = answer.slice(0, 20_000);
  const [inserted] = await tx.insert(noteRecallRecords).values({
    ...scope,
    noteId,
    noteVersionId: input.noteVersionId,
    sourceMessageId: input.sourceMessageId ?? null,
    conversationId: input.conversationId ?? null,
    requestId: input.requestId,
    sectionOrdinal,
    sectionTitle,
    question,
    hintSnapshot: null,
    hintSourceMessageId: null,
    hintConversationId: null,
    answerSnapshot,
    answerTruncated,
  }).onConflictDoNothing().returning();
  if (inserted) return noteRecallStartResultV1Schema.parse(project(inserted, note.currentVersionId, version.versionNo));

  // A second request can pass the idempotency pre-read while the first insert is still
  // in flight. The unique key makes the write safe; read the winner and return its exact
  // snapshot instead of surfacing a 500 or generating a second question.
  const [raced] = await tx.select().from(noteRecallRecords).where(and(
    eq(noteRecallRecords.workspaceId, scope.workspaceId),
    eq(noteRecallRecords.userId, scope.userId),
    eq(noteRecallRecords.requestId, input.requestId),
  ));
  if (raced?.noteId === noteId && raced.noteVersionId === input.noteVersionId
    && raced.sourceMessageId === (input.sourceMessageId ?? null)
    && raced.conversationId === (input.conversationId ?? null)) {
    const [racedVersion] = await tx.select({ versionNo: noteVersions.versionNo }).from(noteVersions)
      .where(eq(noteVersions.id, raced.noteVersionId));
    if (racedVersion) return noteRecallStartResultV1Schema.parse(project(raced, note.currentVersionId, racedVersion.versionNo));
  }
  throw new NoteRecallError("request_conflict", "这次回想记录暂时无法确认，请重新读取记录后再试。");
}

export async function actOnNoteRecallRecord(
  tx: ApiTransaction,
  scope: NoteRecallScopeV1,
  noteId: string,
  recallId: string,
  action: { kind: "hint"; sourceMessageId?: string; conversationId?: string }
    | { kind: "reveal" }
    | { kind: "self_report"; value: "remembered" | "partly" | "not_yet"; reflection?: string },
) {
  const note = await requireVisibleNote(tx, scope, noteId);
  const [row] = await tx.select().from(noteRecallRecords).where(and(
    eq(noteRecallRecords.id, recallId), owned(scope, noteId),
  )).for("update");
  if (!row) throw new NoteRecallError("recall_not_found", "这条回想记录现在读不到。");
  const [version] = await tx.select({ versionNo: noteVersions.versionNo }).from(noteVersions).where(eq(noteVersions.id, row.noteVersionId));
  if (!version) throw new NoteRecallError("note_version_not_found", "这条回想对应的笔记版本已经不可用。");

  if (action.kind === "hint") {
    if (row.revealedAt) throw new NoteRecallError("already_revealed", "原文已经翻开；下次回想时再看线索。");
    if (Boolean(action.sourceMessageId) !== Boolean(action.conversationId)) {
      throw new NoteRecallError("invalid_recall_hint", "伴星线索缺少可核对的消息来源。");
    }
    const fromCompanion = Boolean(action.sourceMessageId && action.conversationId);
    const hint = fromCompanion
      ? await assistantReplyTextForNote(tx, scope, {
          messageId: action.sourceMessageId!,
          noteId,
          noteVersionId: row.noteVersionId,
          conversationId: action.conversationId!,
          selectionText: null,
        })
      : row.hintSnapshot ?? deterministicRecallPrompt({ text: row.answerSnapshot, title: row.sectionTitle }).hint;
    if (!hint) throw new NoteRecallError("source_message_not_found", "这条线索没有对应到原笔记里的伴星回复，请重新问一次。");
    const trimmedHint = hint.trim();
    if (trimmedHint.length < 3 || trimmedHint.length > 1_000) {
      throw new NoteRecallError("invalid_recall_hint", "伴星刚才的线索没有说清楚；可以让她再试一次。");
    }
    if (row.hintViewedAt) {
      if (row.hintSourceMessageId !== (action.sourceMessageId ?? null)
        || row.hintConversationId !== (action.conversationId ?? null)
        || row.hintSnapshot !== trimmedHint) {
        throw new NoteRecallError("already_hinted", "这次回想已经留下一条线索；新线索请从伴星回复处另存。");
      }
      return noteRecallActionResultV1Schema.parse(project(row, note.currentVersionId, version.versionNo));
    }
    const [updated] = await tx.update(noteRecallRecords).set({
      hintViewedAt: new Date(),
      hintSnapshot: trimmedHint,
      hintSourceMessageId: action.sourceMessageId ?? null,
      hintConversationId: action.conversationId ?? null,
    }).where(eq(noteRecallRecords.id, row.id)).returning();
    return noteRecallActionResultV1Schema.parse(project(updated!, note.currentVersionId, version.versionNo));
  }
  if (action.kind === "reveal" && !row.revealedAt) {
    const [updated] = await tx.update(noteRecallRecords).set({ revealedAt: new Date() })
      .where(eq(noteRecallRecords.id, row.id)).returning();
    return noteRecallActionResultV1Schema.parse(project(updated!, note.currentVersionId, version.versionNo));
  }
  if (action.kind === "self_report") {
    if (!row.revealedAt) throw new NoteRecallError("not_revealed", "先翻开原文对照，再记下刚才想起多少。");
    if (row.selfReport !== null) {
      if (row.selfReport !== action.value || (action.reflection !== undefined && row.reflection !== action.reflection)) {
        throw new NoteRecallError("already_reported", "这次回想已经留下了自我记录；下一次可以重新来一遍。");
      }
      return noteRecallActionResultV1Schema.parse(project(row, note.currentVersionId, version.versionNo));
    }
    const [updated] = await tx.update(noteRecallRecords).set({
      selfReport: action.value,
      reflection: action.reflection ?? null,
      reportedAt: new Date(),
    }).where(eq(noteRecallRecords.id, row.id)).returning();
    return noteRecallActionResultV1Schema.parse(project(updated!, note.currentVersionId, version.versionNo));
  }
  return noteRecallActionResultV1Schema.parse(project(row, note.currentVersionId, version.versionNo));
}
