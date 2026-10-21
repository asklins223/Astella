/**
 * Star map layer two / layer three (Plan 57 hard cutover, 2026-10-19).
 *
 * Layer two is "this note's learning card and its questions"; layer three is
 * "every attempt on that card, newest first". Both read only the new chain:
 * `note_learning_cards` / `note_learning_card_questions` /
 * `note_learning_card_attempts`. Nothing here reaches into objectives, runs,
 * review schedules, or the old note rounds.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { notes } from "@astella/shared/db-schema/note";
import {
  noteLearningCardAttempts,
  noteLearningCardQuestions,
  noteLearningCards,
} from "@astella/shared/db-schema/note-learning-cards";
import { visibleNotesCondition } from "../note/visibility.ts";
import {
  deriveNoteStateAxesV3,
  type NoteDeepeningAttemptV3,
  type NoteDeepeningCardV3,
  type NoteDeepeningV3,
} from "@astella/shared/note-deepening-v3-contracts";

export interface NoteDeepeningContext {
  workspaceId: string;
  userId: string;
}

/** 笔记读不到（不存在／软删／权限遮蔽）。三种情况对外是同一个形状。 */
export class NoteNotReadableV3 extends Error {
  constructor() {
    super("note_not_readable");
  }
}

export const NOTE_DEEPENING_DEFAULT_LIMIT = 200;
export const NOTE_DEEPENING_MAX_LIMIT = 500;

export function resolveNoteDeepeningLimit(raw: unknown): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return NOTE_DEEPENING_DEFAULT_LIMIT;
  return Math.min(parsed, NOTE_DEEPENING_MAX_LIMIT);
}

function bounded<T>(rows: T[], limit: number): { page: T[]; complete: boolean } {
  if (rows.length <= limit) return { page: rows, complete: true };
  return { page: rows.slice(0, limit), complete: false };
}

export async function readNoteDeepeningV3(
  tx: ApiTransaction,
  ctx: NoteDeepeningContext,
  noteId: string,
  options: { limit?: number } = {},
): Promise<NoteDeepeningV3> {
  const limit = resolveNoteDeepeningLimit(options.limit);

  const [note] = await tx
    .select({ id: notes.id, title: notes.title, sourceId: notes.sourceId, currentVersionId: notes.currentVersionId })
    .from(notes)
    .where(and(
      eq(notes.workspaceId, ctx.workspaceId),
      eq(notes.id, noteId),
      visibleNotesCondition(ctx.userId),
      isNull(notes.deletedAt),
    ))
    .limit(1);
  if (!note) throw new NoteNotReadableV3();

  // 一篇笔记一条活卡（`note_learning_cards_active_idx` 是部分唯一索引）。
  const [cardRow] = await tx
    .select({
      cardId: noteLearningCards.id,
      status: noteLearningCards.status,
      noteVersionId: noteLearningCards.noteVersionId,
    })
    .from(noteLearningCards)
    .where(and(
      eq(noteLearningCards.workspaceId, ctx.workspaceId),
      eq(noteLearningCards.noteId, noteId),
      eq(noteLearningCards.status, "active"),
    ))
    .limit(1);

  const attemptRows = cardRow
    ? await tx
        .select({
          attemptId: noteLearningCardAttempts.id,
          status: noteLearningCardAttempts.status,
          score: noteLearningCardAttempts.score,
          stars: noteLearningCardAttempts.stars,
          completedAt: noteLearningCardAttempts.completedAt,
          startedAt: noteLearningCardAttempts.startedAt,
        })
        .from(noteLearningCardAttempts)
        .where(and(
          eq(noteLearningCardAttempts.cardId, cardRow.cardId),
          eq(noteLearningCardAttempts.workspaceId, ctx.workspaceId),
          eq(noteLearningCardAttempts.userId, ctx.userId),
        ))
        .orderBy(desc(noteLearningCardAttempts.startedAt), desc(noteLearningCardAttempts.id))
    : [];
  const page = bounded(attemptRows, limit);

  const questionRows = cardRow
    ? await tx
        .select({
          questionId: noteLearningCardQuestions.id,
          ordinal: noteLearningCardQuestions.ordinal,
          questionType: noteLearningCardQuestions.questionType,
          stem: noteLearningCardQuestions.stem,
        })
        .from(noteLearningCardQuestions)
        .where(eq(noteLearningCardQuestions.cardId, cardRow.cardId))
        .orderBy(noteLearningCardQuestions.ordinal)
    : [];

  let card: NoteDeepeningCardV3 | null = null;
  if (cardRow) {
    const completed = attemptRows.filter((row) => row.status === "completed");
    const best = completed.reduce<{ score: number | null; stars: number | null }>(
      (acc, row) => {
        if (row.stars === null) return acc;
        if (acc.stars === null || row.stars > acc.stars || (row.stars === acc.stars && (row.score ?? 0) > (acc.score ?? 0))) {
          return { score: row.score, stars: row.stars };
        }
        return acc;
      },
      { score: null, stars: null },
    );
    card = {
      cardId: cardRow.cardId,
      status: cardRow.status,
      bestStars: best.stars,
      bestScore: best.score,
      attemptCount: attemptRows.length,
      questions: questionRows.map((row) => ({
        questionId: row.questionId,
        ordinal: row.ordinal,
        questionType: row.questionType,
        stem: row.stem,
        bestStars: best.stars,
        bestScore: best.score,
      })),
    };
  }

  const attempts: NoteDeepeningAttemptV3[] = page.page.map((row) => ({
    attemptId: row.attemptId,
    status: row.status,
    score: row.score,
    stars: row.stars,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  }));

  const axes = deriveNoteStateAxesV3({
    attemptCount: attemptRows.length,
    bestStars: card?.bestStars ?? null,
    hasCard: cardRow !== undefined,
    // Card generated from an older version than the note currently shows.
    sourceUpdated: cardRow !== undefined
      && note.currentVersionId !== null
      && cardRow.noteVersionId !== note.currentVersionId,
  });

  return {
    version: 3,
    noteId: note.id,
    noteTitle: note.title,
    hasBody: Boolean(note.currentVersionId),
    sourceId: note.sourceId,
    axes,
    card,
    attempts,
    attemptsComplete: page.complete,
  };
}
