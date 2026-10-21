/**
 * Star-map deepening contract (Plan 57, 2026-10-19).
 *
 * The map's product unit is now: source → note → the questions of that note's
 * learning card. The old objective/run/review chain is gone, so this contract
 * carries only facts the new chain actually writes: question stems, question
 * types, and per-question best stars from completed attempts.
 *
 * Three axes stay separate on purpose — none of them is a score, and no
 * "mastery percentage" field exists anywhere in this schema.
 */
import { z } from "zod";

export const notePerformanceAxisV3Schema = z.enum([
  "no_record_yet",
  "met_once",
  "assisted_once",
  "used_independently",
  "repeated_over_time",
]);
export type NotePerformanceAxisV3 = z.infer<typeof notePerformanceAxisV3Schema>;

export const noteNextStepAxisV3Schema = z.enum([
  "nothing_to_do",
  "can_continue",
]);
export type NoteNextStepAxisV3 = z.infer<typeof noteNextStepAxisV3Schema>;

export const noteApplicabilityAxisV3Schema = z.enum([
  "basis_holds",
  "basis_updated",
]);
export type NoteApplicabilityAxisV3 = z.infer<typeof noteApplicabilityAxisV3Schema>;

export const noteStateAxesV3Schema = z.strictObject({
  performance: notePerformanceAxisV3Schema,
  nextStep: noteNextStepAxisV3Schema,
  applicability: noteApplicabilityAxisV3Schema,
});
export type NoteStateAxesV3 = z.infer<typeof noteStateAxesV3Schema>;

export const noteLearningQuestionTypeV1Schema = z.enum([
  "single_choice",
  "multi_choice",
  "true_false",
  "fill_blank",
  "short_answer",
  "ordering",
  "matching",
  "operation",
]);
export type NoteLearningQuestionTypeV1 = z.infer<typeof noteLearningQuestionTypeV1Schema>;

/** One question of the note's card, with this user's best result. */
export const noteDeepeningQuestionV3Schema = z.strictObject({
  questionId: z.string().uuid(),
  ordinal: z.number().int().min(0),
  questionType: noteLearningQuestionTypeV1Schema,
  stem: z.string().min(1).max(2000),
  bestStars: z.number().int().min(0).max(5).nullable(),
  bestScore: z.number().int().min(0).max(100).nullable(),
});
export type NoteDeepeningQuestionV3 = z.infer<typeof noteDeepeningQuestionV3Schema>;

/** One completed (or grading) attempt on this card. */
export const noteDeepeningAttemptV3Schema = z.strictObject({
  attemptId: z.string().uuid(),
  status: z.enum(["in_progress", "grading", "completed", "grading_failed", "abandoned"]),
  score: z.number().int().min(0).max(100).nullable(),
  stars: z.number().int().min(0).max(5).nullable(),
  completedAt: z.string().datetime({ offset: true }).nullable(),
});
export type NoteDeepeningAttemptV3 = z.infer<typeof noteDeepeningAttemptV3Schema>;

/**
 * One note's card: the questions the star map may draw as small stars, plus
 * the whole-paper result. `null` means this note has no card yet — an honest
 * "nothing here", never a synthesized one.
 */
export const noteDeepeningCardV3Schema = z.strictObject({
  cardId: z.string().uuid(),
  status: z.enum(["active", "stale", "archived"]),
  bestStars: z.number().int().min(0).max(5).nullable(),
  bestScore: z.number().int().min(0).max(100).nullable(),
  attemptCount: z.number().int().min(0),
  questions: z.array(noteDeepeningQuestionV3Schema).max(8),
});
export type NoteDeepeningCardV3 = z.infer<typeof noteDeepeningCardV3Schema>;

export const noteDeepeningV3Schema = z.strictObject({
  version: z.literal(3),
  noteId: z.string().uuid(),
  noteTitle: z.string().min(1).max(500),
  hasBody: z.boolean(),
  sourceId: z.string().uuid().nullable(),
  axes: noteStateAxesV3Schema,
  card: noteDeepeningCardV3Schema.nullable(),
  attempts: z.array(noteDeepeningAttemptV3Schema).max(200),
  attemptsComplete: z.boolean(),
});
export type NoteDeepeningV3 = z.infer<typeof noteDeepeningV3Schema>;

/** Input facts for the pure axis projection. */
export interface NoteAxisFactsV3 {
  readonly attemptCount: number;
  readonly bestStars: number | null;
  readonly hasCard: boolean;
  readonly sourceUpdated: boolean;
}

export function deriveNoteStateAxesV3(facts: NoteAxisFactsV3): NoteStateAxesV3 {
  const best = facts.bestStars;
  const performance: NotePerformanceAxisV3 = best === null
    ? "no_record_yet"
    : best >= 4
      ? "used_independently"
      : best >= 1
        ? "met_once"
        : "assisted_once";
  return {
    performance,
    nextStep: facts.hasCard ? "can_continue" : "nothing_to_do",
    applicability: facts.sourceUpdated ? "basis_updated" : "basis_holds",
  };
}
