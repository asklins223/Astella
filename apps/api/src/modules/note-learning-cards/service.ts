import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { noteLearningCardAnswers, noteLearningCardAttempts, noteLearningCardQuestions, noteLearningCards } from "@astella/shared/db-schema/note-learning-cards";
import { noteVersions, notes } from "@astella/shared/db-schema/note";
import { jobs } from "@astella/shared/db-schema/job";
import { JobResourceClass, JobStatus, JobType } from "@astella/shared/enums";
import { visibleNotesCondition } from "../note/visibility.ts";
import {
  noteLearningCardScoreV1,
  noteLearningCardStarsV1,
  isNoteLearningCardSkipV1,
  type NoteLearningCardAttemptV1,
  type NoteLearningCardQuestionGroundingV1,
  type NoteLearningCardV1,
  type NoteLearningCardVersionV1,
} from "@astella/shared/note-learning-card-contracts";

export type NoteLearningCardScopeV1 = { workspaceId: string; userId: string };

export class NoteLearningCardError extends Error {
  constructor(
    readonly code:
      | "note_not_found"
      | "card_not_found"
      | "attempt_not_found"
      | "attempt_not_in_progress"
      | "question_not_found"
      | "no_card"
      | "card_not_ready",
    message: string,
  ) {
    super(message);
    this.name = "NoteLearningCardError";
  }
}

type CardRow = typeof noteLearningCards.$inferSelect;
type QuestionRow = typeof noteLearningCardQuestions.$inferSelect;
type AttemptRow = typeof noteLearningCardAttempts.$inferSelect;

async function requireVisibleNote(tx: ApiTransaction, scope: NoteLearningCardScopeV1, noteId: string) {
  const [note] = await tx.select({ id: notes.id, currentVersionId: notes.currentVersionId })
    .from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.workspaceId, scope.workspaceId), visibleNotesCondition(scope.userId), isNull(notes.deletedAt)));
  if (!note) throw new NoteLearningCardError("note_not_found", "这篇笔记现在读不到，请回到笔记架核对权限。");
  return note;
}

function questionView(row: QuestionRow) {
  const answer = row.answer && typeof row.answer === "object" ? row.answer as Record<string, unknown> : null;
  const blanks = answer && Array.isArray(answer.blanks) ? answer.blanks : null;
  const rightOptions = answer && Array.isArray(answer.rightOptions)
    ? answer.rightOptions.filter((item): item is string => typeof item === "string")
    : null;
  return {
    questionId: row.id,
    ordinal: row.ordinal,
    type: row.questionType,
    stem: row.stem,
    options: row.options ?? null,
    rightOptions,
    blankCount: blanks ? blanks.length : null,
    grounding: row.grounding,
    operationArtifactId: row.operationArtifactId,
  };
}

async function readableCard(tx: ApiTransaction, scope: NoteLearningCardScopeV1, cardId: string) {
  const [card] = await tx.select().from(noteLearningCards).where(and(eq(noteLearningCards.id, cardId), eq(noteLearningCards.workspaceId, scope.workspaceId))).limit(1).for("update");
  if (!card) throw new NoteLearningCardError("card_not_found", "这张学习卡现在读不到。");
  await requireVisibleNote(tx, scope, card.noteId);
  return card;
}

async function cardVersions(tx: ApiTransaction, scope: NoteLearningCardScopeV1, noteId: string): Promise<NoteLearningCardVersionV1[]> {
  const rows = await tx.select({ cardId: noteLearningCards.id, noteVersionId: noteLearningCards.noteVersionId, versionNo: noteVersions.versionNo,
    status: noteLearningCards.status, createdAt: noteLearningCards.createdAt }).from(noteLearningCards)
    .innerJoin(noteVersions, eq(noteVersions.id, noteLearningCards.noteVersionId))
    .where(and(eq(noteLearningCards.workspaceId, scope.workspaceId), eq(noteLearningCards.noteId, noteId),
      sql`EXISTS (SELECT 1 FROM note_learning_card_questions q WHERE q.card_id = ${noteLearningCards.id})`))
    .orderBy(desc(noteVersions.versionNo));
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

export async function readNoteLearningCard(
  tx: ApiTransaction,
  scope: NoteLearningCardScopeV1,
  noteId: string,
  cardId?: string,
): Promise<{ card: NoteLearningCardV1 | null; generating: boolean; generationFailure?: string; versions: NoteLearningCardVersionV1[] }> {
  await requireVisibleNote(tx, scope, noteId);
  const [card] = await tx.select().from(noteLearningCards)
    .where(and(
      eq(noteLearningCards.workspaceId, scope.workspaceId),
      eq(noteLearningCards.noteId, noteId),
      cardId ? eq(noteLearningCards.id, cardId) : eq(noteLearningCards.status, "active"),
    ))
    .limit(1);
  if (!card) return { card: null, generating: false, versions: await cardVersions(tx, scope, noteId) };
  const questions = await tx.select().from(noteLearningCardQuestions)
    .where(eq(noteLearningCardQuestions.cardId, card.id))
    .orderBy(noteLearningCardQuestions.ordinal);
  // The card row is written before generation fills it. A row without questions
  // is scaffolding, not a usable card; the contract requires at least one question.
  if (questions.length === 0) {
    return { card: null, ...await cardGenerationState(tx, scope.workspaceId, card.id), versions: await cardVersions(tx, scope, noteId) };
  }
  const attempts = await tx.select().from(noteLearningCardAttempts)
    .where(and(eq(noteLearningCardAttempts.cardId, card.id), eq(noteLearningCardAttempts.userId, scope.userId)))
    .orderBy(desc(noteLearningCardAttempts.startedAt))
    .limit(1);
  // Best stars belong to the version, not to a truncated recent-history page.
  const [statistics] = await tx.select({
    bestScore: sql<number | null>`max(${noteLearningCardAttempts.score})`,
    completedAttemptCount: sql<number>`count(*)::int`,
  }).from(noteLearningCardAttempts).where(and(
    eq(noteLearningCardAttempts.cardId, card.id), eq(noteLearningCardAttempts.workspaceId, scope.workspaceId),
    eq(noteLearningCardAttempts.userId, scope.userId), eq(noteLearningCardAttempts.status, "completed"),
  ));
  const bestScore = statistics?.bestScore ?? null;
  const last = attempts[0] ?? null;
  return {
    generating: false,
    versions: await cardVersions(tx, scope, noteId),
    card: {
      cardId: card.id,
      noteId: card.noteId,
      noteVersionId: card.noteVersionId,
      status: card.status,
      questions: questions.map(questionView),
      omittedQuestionCount: card.omittedQuestionCount ?? 0,
      bestScore,
      bestStars: bestScore === null ? null : noteLearningCardStarsV1(bestScore),
      completedAttemptCount: Number(statistics?.completedAttemptCount ?? 0),
      lastAttempt: last ? {
        attemptId: last.id,
        status: last.status,
        score: last.score,
        stars: last.stars,
        completedAt: last.completedAt?.toISOString() ?? null,
      } : null,
      createdAt: card.createdAt.toISOString(),
      updatedAt: card.updatedAt.toISOString(),
    },
  };
}

async function hasInFlightCardGeneration(tx: ApiTransaction, workspaceId: string, cardId: string): Promise<boolean> {
  return (await cardGenerationState(tx, workspaceId, cardId)).generating;
}

async function cardGenerationState(tx: ApiTransaction, workspaceId: string, cardId: string): Promise<{ generating: boolean; generationFailure?: string }> {
  const [row] = await tx.select({ status: jobs.status, lastError: jobs.lastError }).from(jobs)
    .where(and(
      eq(jobs.workspaceId, workspaceId),
      eq(jobs.type, JobType.NOTE_LEARNING_CARD_GENERATE),
      sql`${jobs.payload}->>'cardId' = ${cardId}`,
    )).orderBy(desc(jobs.scheduledAt)).limit(1);
  if (row?.status === JobStatus.PENDING || row?.status === JobStatus.RUNNING) return { generating: true };
  if (row?.status !== JobStatus.DEAD) return { generating: false };
  // Report the failure category, never raw model output, SQL or provider details.
  const error = row.lastError ?? "";
  const reason = /质量闸门|缺少题目|学习卡结果|原文依据/u.test(error) ? "题目没有通过原文、答案或题型校验，这次没有收录题目。"
    : /没有可用于出题的正文/u.test(error) ? "这篇笔记还没有可用于出题的正文，请先补充并保存。"
      : /consent|AI_CONSENT/iu.test(error) ? "需要先在设置中启用 AI，再生成学习卡。"
        : /timeout|超时/iu.test(error) ? "出题服务这次等待超时，原文仍在，可以再试一次。"
          : "出题服务这次没有完成，原文仍在，可以再试一次。";
  return { generating: false, generationFailure: reason };
}

/** Create the empty card row before the generation job fills questions. Idempotent per note version. */
export async function ensureNoteLearningCardRow(
  tx: ApiTransaction,
  scope: NoteLearningCardScopeV1,
  noteId: string,
  noteVersionId: string,
): Promise<{ cardId: string; created: boolean; generating?: boolean }> {
  await requireVisibleNote(tx, scope, noteId);
  if (!await noteVersionExists(tx, scope.workspaceId, noteId, noteVersionId)) {
    throw new NoteLearningCardError("card_not_ready", "这篇笔记的版本已不可用，请重新读取笔记。");
  }
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`note-card:${scope.workspaceId}:${noteId}`}, 0))`);
  const [existing] = await tx.select({ id: noteLearningCards.id, status: noteLearningCards.status })
    .from(noteLearningCards)
    .where(and(
      eq(noteLearningCards.workspaceId, scope.workspaceId),
      eq(noteLearningCards.noteId, noteId),
      eq(noteLearningCards.noteVersionId, noteVersionId),
    )).limit(1);
  if (existing) {
    const [questionCount] = await tx.select({ n: sql<number>`count(*)::int` }).from(noteLearningCardQuestions)
      .where(eq(noteLearningCardQuestions.cardId, existing.id));
    if (Number(questionCount?.n ?? 0) > 0) {
      if (existing.status !== "active") {
        await tx.update(noteLearningCards).set({ status: "stale", updatedAt: new Date() })
          .where(and(eq(noteLearningCards.workspaceId, scope.workspaceId), eq(noteLearningCards.noteId, noteId), eq(noteLearningCards.status, "active")));
        await tx.update(noteLearningCards).set({ status: "active", updatedAt: new Date() })
          .where(eq(noteLearningCards.id, existing.id));
      }
      return { cardId: existing.id, created: false };
    }
    // A previous generation died before it wrote any question. Keep the shell
    // while its job is still in flight; otherwise drop it so this call can retry.
    if (await hasInFlightCardGeneration(tx, scope.workspaceId, existing.id)) {
      return { cardId: existing.id, created: false, generating: true };
    }
    await tx.delete(noteLearningCards).where(eq(noteLearningCards.id, existing.id));
  }
  await tx.update(noteLearningCards).set({ status: "stale", updatedAt: new Date() })
    .where(and(eq(noteLearningCards.workspaceId, scope.workspaceId), eq(noteLearningCards.noteId, noteId), eq(noteLearningCards.status, "active")));
  const [created] = await tx.insert(noteLearningCards).values({
    workspaceId: scope.workspaceId, noteId, noteVersionId, status: "active",
  }).returning({ id: noteLearningCards.id });
  return { cardId: created.id, created: true };
}

export async function startNoteLearningCardAttempt(
  tx: ApiTransaction,
  scope: NoteLearningCardScopeV1,
  cardId: string,
): Promise<{ attemptId: string; cardId: string }> {
  const card = await readableCard(tx, scope, cardId);
  const [questionCount] = await tx.select({ n: sql<number>`count(*)::int` }).from(noteLearningCardQuestions)
    .where(eq(noteLearningCardQuestions.cardId, card.id));
  if (Number(questionCount?.n ?? 0) === 0) throw new NoteLearningCardError("card_not_ready", "这张学习卡的题目还没出好。");
  const [unfinished] = await tx.select({ id: noteLearningCardAttempts.id }).from(noteLearningCardAttempts).where(and(
    eq(noteLearningCardAttempts.cardId, card.id), eq(noteLearningCardAttempts.userId, scope.userId), eq(noteLearningCardAttempts.status, "in_progress"),
  )).limit(1);
  if (unfinished) return { attemptId: unfinished.id, cardId: card.id };
  const [attempt] = await tx.insert(noteLearningCardAttempts).values({
    cardId: card.id,
    workspaceId: scope.workspaceId,
    userId: scope.userId,
  }).returning({ id: noteLearningCardAttempts.id });
  return { attemptId: attempt.id, cardId: card.id };
}

export async function saveNoteLearningCardAnswer(
  tx: ApiTransaction,
  scope: NoteLearningCardScopeV1,
  cardId: string,
  attemptId: string,
  questionId: string,
  answer: unknown,
  usedHint = false,
): Promise<{ answerId: string }> {
  await readableCard(tx, scope, cardId);
  const [attempt] = await tx.select().from(noteLearningCardAttempts)
    .where(and(
      eq(noteLearningCardAttempts.id, attemptId),
      eq(noteLearningCardAttempts.cardId, cardId),
      eq(noteLearningCardAttempts.workspaceId, scope.workspaceId),
      eq(noteLearningCardAttempts.userId, scope.userId),
    )).limit(1).for("update");
  if (!attempt) throw new NoteLearningCardError("attempt_not_found", "这次作答现在读不到。");
  if (attempt.status !== "in_progress") throw new NoteLearningCardError("attempt_not_in_progress", "这次作答已经提交，不能再改。");
  const [question] = await tx.select().from(noteLearningCardQuestions)
    .where(and(eq(noteLearningCardQuestions.id, questionId), eq(noteLearningCardQuestions.cardId, cardId)))
    .limit(1);
  if (!question) throw new NoteLearningCardError("question_not_found", "这道题现在读不到。");
  const [inserted] = await tx.insert(noteLearningCardAnswers).values({
    attemptId,
    questionId,
    answer,
    groundingSnapshot: question.grounding,
    usedHint,
  }).onConflictDoUpdate({
    target: [noteLearningCardAnswers.attemptId, noteLearningCardAnswers.questionId],
    set: { answer, groundingSnapshot: question.grounding, usedHint },
  }).returning({ id: noteLearningCardAnswers.id });
  return { answerId: inserted.id };
}

/**
 * Complete an attempt from already-graded answers. The generation/batch pipeline
 * writes per-question scores first; this function only aggregates and freezes the
 * card-level stars. It never invents a score for an ungraded question.
 */
export async function completeNoteLearningCardAttempt(
  tx: ApiTransaction,
  scope: NoteLearningCardScopeV1,
  cardId: string,
  attemptId: string,
): Promise<{ attemptId: string; score: number; stars: number }> {
  const [attempt] = await tx.select().from(noteLearningCardAttempts)
    .where(and(
      eq(noteLearningCardAttempts.id, attemptId),
      eq(noteLearningCardAttempts.cardId, cardId),
      eq(noteLearningCardAttempts.workspaceId, scope.workspaceId),
      eq(noteLearningCardAttempts.userId, scope.userId),
    )).limit(1);
  if (!attempt) throw new NoteLearningCardError("attempt_not_found", "这次作答现在读不到。");
  if (attempt.status !== "in_progress" && attempt.status !== "grading") {
    throw new NoteLearningCardError("attempt_not_in_progress", "这次作答已经结束。");
  }
  const questions = await tx.select({ id: noteLearningCardQuestions.id })
    .from(noteLearningCardQuestions).where(eq(noteLearningCardQuestions.cardId, cardId));
  const answers = await tx.select({ questionId: noteLearningCardAnswers.questionId, score: noteLearningCardAnswers.score })
    .from(noteLearningCardAnswers).where(eq(noteLearningCardAnswers.attemptId, attemptId));
  const byQuestion = new Map(answers.map((answer) => [answer.questionId, answer.score]));
  const scores = questions.map((question) => byQuestion.get(question.id));
  if (scores.some((score) => score === null || score === undefined)) {
    throw new NoteLearningCardError("card_not_ready", "还有题目没批完，这次先不结算。");
  }
  const score = noteLearningCardScoreV1(scores as number[]);
  const stars = noteLearningCardStarsV1(score);
  await tx.update(noteLearningCardAttempts)
    .set({ status: "completed", score, stars, completedAt: new Date() })
    .where(eq(noteLearningCardAttempts.id, attemptId));
  return { attemptId, score, stars };
}

export async function listNoteLearningCardAttempts(
  tx: ApiTransaction,
  scope: NoteLearningCardScopeV1,
  cardId: string,
): Promise<NoteLearningCardAttemptV1[]> {
  const [card] = await tx.select({ noteId: noteLearningCards.noteId }).from(noteLearningCards)
    .where(and(eq(noteLearningCards.id, cardId), eq(noteLearningCards.workspaceId, scope.workspaceId))).limit(1);
  if (!card) throw new NoteLearningCardError("card_not_found", "这张学习卡现在读不到。");
  await requireVisibleNote(tx, scope, card.noteId);
  const rows = await tx.select().from(noteLearningCardAttempts)
    .where(and(eq(noteLearningCardAttempts.cardId, cardId), eq(noteLearningCardAttempts.workspaceId, scope.workspaceId), eq(noteLearningCardAttempts.userId, scope.userId)))
    .orderBy(sql`CASE WHEN ${noteLearningCardAttempts.status} IN ('in_progress','grading','grading_failed') THEN 0 ELSE 1 END`, desc(sql`coalesce(${noteLearningCardAttempts.completedAt}, ${noteLearningCardAttempts.startedAt})`))
    .limit(50);
  const answers = rows.length ? await tx.select().from(noteLearningCardAnswers)
    .where(inArray(noteLearningCardAnswers.attemptId, rows.map((row) => row.id))) : [];
  const questions = await loadNoteLearningCardQuestions(tx, cardId);
  const byId = new Map(questions.map((question) => [question.id, question]));
  return rows.map((row) => ({
    attemptId: row.id,
    status: row.status,
    score: row.score,
    stars: row.stars,
    summary: row.summary,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    answers: answers.filter((answer) => answer.attemptId === row.id).map((answer) => ({
      questionId: answer.questionId,
      answer: answer.answer,
      score: row.status === "completed" ? answer.score : null,
      feedback: row.status === "completed" ? answer.feedback : null,
      skipped: isNoteLearningCardSkipV1(answer.answer),
      referenceAnswer: row.status === "completed" ? byId.get(answer.questionId)?.answer ?? null : null,
      rubric: row.status === "completed" ? byId.get(answer.questionId)?.rubric ?? null : null,
      grounding: answer.groundingSnapshot,
    })),
  }));
}

/** Lock the attempt so retrying submission cannot enqueue duplicate grading. */
export async function queueNoteLearningCardAttempt(tx: ApiTransaction, scope: NoteLearningCardScopeV1, cardId: string, attemptId: string, summaryOnly = false, requestKey?: string) {
  await readableCard(tx, scope, cardId);
  const [attempt] = await tx.select().from(noteLearningCardAttempts).where(and(
    eq(noteLearningCardAttempts.id, attemptId), eq(noteLearningCardAttempts.cardId, cardId),
    eq(noteLearningCardAttempts.workspaceId, scope.workspaceId), eq(noteLearningCardAttempts.userId, scope.userId),
  )).limit(1).for("update");
  if (!attempt) throw new NoteLearningCardError("attempt_not_found", "这次作答现在读不到。");
  if (summaryOnly && attempt.status === "completed") {
    const summary = attempt.summary as { text?: unknown } | null;
    const idempotencyKey = requestKey ? `note-card-summary:${scope.userId}:${attemptId}:${requestKey}` : undefined;
    if (idempotencyKey) {
      const [existing] = await tx.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.workspaceId, scope.workspaceId), eq(jobs.idempotencyKey, idempotencyKey))).limit(1);
      if (existing) return { attemptId, grading: false, jobId: existing.id };
    }
    const [pending] = await tx.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.workspaceId, scope.workspaceId), eq(jobs.type, JobType.NOTE_LEARNING_CARD_GRADE),
      inArray(jobs.status, [JobStatus.PENDING, JobStatus.RUNNING]), sql`${jobs.payload}->>'attemptId' = ${attemptId}`)).limit(1);
    if (pending) return { attemptId, grading: false, jobId: pending.id };
    await tx.update(noteLearningCardAttempts).set({ summary: { ...(typeof summary?.text === "string" ? { text: summary.text } : {}), status: "pending" } }).where(eq(noteLearningCardAttempts.id, attemptId));
    const [job] = await tx.insert(jobs).values({ workspaceId: scope.workspaceId, requestedBy: scope.userId, type: JobType.NOTE_LEARNING_CARD_GRADE,
      payload: { cardId, attemptId, summaryOnly: true }, resourceClass: JobResourceClass.CARD_FOREGROUND, idempotencyKey }).returning({ id: jobs.id });
    return { attemptId, grading: false, jobId: job.id };
  }
  if (summaryOnly) throw new NoteLearningCardError("card_not_ready", "请先完成批改，再生成总评。");
  if (attempt.status === "completed" || attempt.status === "grading") return { attemptId, grading: attempt.status === "grading" };
  if (attempt.status !== "in_progress" && attempt.status !== "grading_failed") throw new NoteLearningCardError("attempt_not_in_progress", "这次作答已经结束。");
  const questions = await loadNoteLearningCardQuestions(tx, cardId);
  const answers = await tx.select({ questionId: noteLearningCardAnswers.questionId }).from(noteLearningCardAnswers)
    .where(eq(noteLearningCardAnswers.attemptId, attemptId));
  if (!questions.length || questions.some((question) => !answers.some((answer) => answer.questionId === question.id))) {
    throw new NoteLearningCardError("card_not_ready", "还有题目没有保存，请保存作答或明确跳过后再交卷。");
  }
  await tx.update(noteLearningCardAttempts).set({ status: "grading" }).where(eq(noteLearningCardAttempts.id, attemptId));
  const [job] = await tx.insert(jobs).values({
    workspaceId: scope.workspaceId, requestedBy: scope.userId, type: JobType.NOTE_LEARNING_CARD_GRADE,
    payload: { cardId, attemptId }, resourceClass: JobResourceClass.CARD_FOREGROUND,
  }).returning({ id: jobs.id });
  return { attemptId, grading: true, jobId: job.id };
}

/** True when a note version still exists; used before writing a card. */
export async function noteVersionExists(tx: ApiTransaction, workspaceId: string, noteId: string, noteVersionId: string): Promise<boolean> {
  const [row] = await tx.select({ id: noteVersions.id }).from(noteVersions)
    .where(and(eq(noteVersions.id, noteVersionId), eq(noteVersions.noteId, noteId), eq(noteVersions.workspaceId, workspaceId)));
  return Boolean(row);
}

/** Load question rows for the grading pipeline. */
export async function loadNoteLearningCardQuestions(tx: ApiTransaction, cardId: string): Promise<QuestionRow[]> {
  return tx.select().from(noteLearningCardQuestions)
    .where(eq(noteLearningCardQuestions.cardId, cardId))
    .orderBy(noteLearningCardQuestions.ordinal);
}

/** The grading pipeline updates one answer's score/feedback. */
export async function gradeNoteLearningCardAnswer(
  tx: ApiTransaction,
  attemptId: string,
  questionId: string,
  score: number,
  feedback: unknown,
): Promise<void> {
  await tx.update(noteLearningCardAnswers)
    .set({ score, feedback, gradedAt: new Date() })
    .where(and(eq(noteLearningCardAnswers.attemptId, attemptId), eq(noteLearningCardAnswers.questionId, questionId)));
}

/** Used by the operation-question host to keep the answer's grounding snapshot. */
export function groundingSnapshot(question: QuestionRow): NoteLearningCardQuestionGroundingV1 {
  return question.grounding;
}

/** Unused row helpers are kept out of the public surface. */
export type { CardRow, QuestionRow, AttemptRow };
