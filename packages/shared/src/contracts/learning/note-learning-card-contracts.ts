import { z } from "zod";

/**
 * Plan 57: a note owns exactly one learning card per saved version.
 * A card contains multiple questions; every question has one fixed type.
 */
export const NOTE_LEARNING_CARD_QUESTION_TYPES = [
  "single_choice",
  "multi_choice",
  "true_false",
  "fill_blank",
  "short_answer",
  "ordering",
  "matching",
  "operation",
] as const;
export type NoteLearningCardQuestionTypeV1 = (typeof NOTE_LEARNING_CARD_QUESTION_TYPES)[number];

export const NOTE_LEARNING_CARD_STATUSES = ["active", "stale", "archived"] as const;
export type NoteLearningCardStatusV1 = (typeof NOTE_LEARNING_CARD_STATUSES)[number];

export const NOTE_LEARNING_CARD_ATTEMPT_STATUSES = [
  "in_progress",
  "grading",
  "completed",
  "grading_failed",
  "abandoned",
] as const;
export type NoteLearningCardAttemptStatusV1 = (typeof NOTE_LEARNING_CARD_ATTEMPT_STATUSES)[number];

export const noteLearningCardQuestionGroundingV1Schema = z.strictObject({
  note: z
    .array(
      z.strictObject({
        blockOrdinal: z.number().int().min(0),
        quote: z.string().trim().min(1).max(4000),
      }),
    )
    .min(1)
    .max(3),
  extension: z
    .strictObject({
      kind: z.enum(["existing_source", "ai_generated", "web"]),
      title: z.string().trim().min(1).max(500),
      quote: z.string().trim().min(1).max(6000),
      relation: z.string().trim().min(1).max(1000),
      url: z.string().url().max(2000).optional(),
    })
    .nullable()
    .optional(),
});
export type NoteLearningCardQuestionGroundingV1 = z.infer<
  typeof noteLearningCardQuestionGroundingV1Schema
>;

export const noteLearningCardQuestionV1Schema = z.strictObject({
  questionId: z.string().uuid(),
  ordinal: z.number().int().min(0),
  type: z.enum(NOTE_LEARNING_CARD_QUESTION_TYPES),
  stem: z.string().trim().min(4).max(2000),
  options: z.array(z.string().trim().min(1).max(1000)).max(12).nullable(),
  /** Matching right-hand choices; never the correct pairing. */
  rightOptions: z.array(z.string().trim().min(1).max(1000)).max(12).nullable(),
  /** Number of blanks for fill_blank; never the accepted answers. */
  blankCount: z.number().int().min(1).max(12).nullable(),
  grounding: noteLearningCardQuestionGroundingV1Schema,
  operationArtifactId: z.string().uuid().nullable(),

});
export type NoteLearningCardQuestionV1 = z.infer<typeof noteLearningCardQuestionV1Schema>;

export const noteLearningCardV1Schema = z.strictObject({
  cardId: z.string().uuid(),
  noteId: z.string().uuid(),
  noteVersionId: z.string().uuid(),
  status: z.enum(NOTE_LEARNING_CARD_STATUSES),
  questions: z.array(noteLearningCardQuestionV1Schema).min(1).max(8),
  /**
   * Plan 57: generated questions that failed validation (or were duplicates) and
   * were not included. Additive field; absent in older payloads means 0.
   */
  omittedQuestionCount: z.number().int().min(0).default(0),
  bestScore: z.number().int().min(0).max(100).nullable(),
  bestStars: z.number().int().min(0).max(5).nullable(),
  completedAttemptCount: z.number().int().min(0).optional(),
  lastAttempt: z
    .strictObject({
      attemptId: z.string().uuid(),
      status: z.enum(NOTE_LEARNING_CARD_ATTEMPT_STATUSES),
      score: z.number().int().min(0).max(100).nullable(),
      stars: z.number().int().min(0).max(5).nullable(),
      completedAt: z.string().datetime({ offset: true }).nullable(),
    })
    .nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type NoteLearningCardV1 = z.infer<typeof noteLearningCardV1Schema>;

export type NoteLearningCardVersionV1 = { cardId: string; noteVersionId: string; versionNo: number; status: NoteLearningCardStatusV1; createdAt: string };

export const noteLearningCardGenerationOptionsV1Schema = z.strictObject({
  questionCount: z.union([z.literal(4), z.literal(6), z.literal(8)]).default(6),
});
export type NoteLearningCardGenerationOptionsV1 = z.infer<typeof noteLearningCardGenerationOptionsV1Schema>;

/** An explicit skip is an answer receipt, distinct from an incorrect response. */
export function isNoteLearningCardSkipV1(answer: unknown): boolean {
  return Boolean(answer && typeof answer === "object" && !Array.isArray(answer)
    && (answer as { skipped?: unknown }).skipped === true);
}

export interface NoteLearningCardAttemptAnswerV1 {
  questionId: string;
  answer: unknown;
  score: number | null;
  feedback: unknown;
  skipped: boolean;
  /** Only included after the attempt is completed. */
  referenceAnswer: unknown;
  rubric: unknown;
  grounding: NoteLearningCardQuestionGroundingV1;
}

export interface NoteLearningCardAttemptV1 {
  attemptId: string;
  status: NoteLearningCardAttemptStatusV1;
  score: number | null;
  stars: number | null;
  summary: unknown;
  startedAt: string;
  completedAt: string | null;
  answers: NoteLearningCardAttemptAnswerV1[];
}

export const NOTE_LEARNING_CARD_STAR_THRESHOLDS = [
  { min: 90, stars: 5 },
  { min: 75, stars: 4 },
  { min: 60, stars: 3 },
  { min: 40, stars: 2 },
  { min: 1, stars: 1 },
  { min: 0, stars: 0 },
] as const;

/** Card score is an equal-weight average of question scores, rounded to an integer. */
export function noteLearningCardScoreV1(questionScores: readonly number[]): number {
  if (!questionScores.length) return 0;
  const total = questionScores.reduce((sum, score) => sum + clampScore(score), 0);
  return Math.round(total / questionScores.length);
}

export function noteLearningCardStarsV1(score: number): number {
  const normalized = clampScore(score);
  return NOTE_LEARNING_CARD_STAR_THRESHOLDS.find((band) => normalized >= band.min)?.stars ?? 0;
}

export function bestNoteLearningCardResultV1(
  attempts: readonly { score: number | null; stars: number | null; completedAt: string | null }[],
): { score: number; stars: number } | null {
  let best: { score: number; stars: number } | null = null;
  for (const attempt of attempts) {
    if (attempt.score === null) continue;
    const score = clampScore(attempt.score);
    const stars = attempt.stars === null ? noteLearningCardStarsV1(score) : clampStars(attempt.stars);
    if (!best || stars > best.stars || stars === best.stars && score > best.score) best = { score, stars };
  }
  return best;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function clampStars(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(5, Math.round(value)));
}
