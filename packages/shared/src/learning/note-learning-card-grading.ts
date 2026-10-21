import { isNoteLearningCardSkipV1, type NoteLearningCardQuestionTypeV1 } from "../contracts/learning/note-learning-card-contracts.ts";

export type CardQuestionGradingInputV1 =
  | { type: "single_choice"; answer: { correctOptionId: string } | null; submitted: unknown }
  | { type: "multi_choice"; answer: { correctOptionIds: string[] } | null; options?: readonly string[]; submitted: unknown }
  | { type: "true_false"; answer: { correct: boolean } | null; submitted: unknown }
  | { type: "fill_blank"; answer: { blanks: string[][] } | null; submitted: unknown }
  | { type: "ordering"; answer: { order: string[] } | null; submitted: unknown }
  | { type: "matching"; answer: { pairs: Record<string, string> } | null; submitted: unknown }
  | { type: "short_answer"; rubric: unknown; submitted: unknown }
  | { type: "operation"; expected: unknown; submitted: unknown };

export type CardQuestionGradingResultV1 =
  | { kind: "graded"; score: number; feedback: { correct: boolean; detail?: string } }
  | { kind: "needs_companion"; reason: "subjective" }
  | { kind: "invalid_answer" };

/**
 * Objective questions are graded here, deterministically. Short answers and
 * operation questions whose checks need semantics return `needs_companion` and
 * are graded by the companion (rubric / host check) before the card is completed.
 */
export function gradeCardQuestionV1(input: CardQuestionGradingInputV1): CardQuestionGradingResultV1 {
  if (isNoteLearningCardSkipV1(input.submitted)) return { kind: "graded", score: 0, feedback: { correct: false, detail: "本题已跳过。" } };
  switch (input.type) {
    case "single_choice": {
      const selected = readString(input.submitted, "optionId");
      if (!selected || !input.answer) return { kind: "invalid_answer" };
      const correct = selected === input.answer.correctOptionId;
      return { kind: "graded", score: correct ? 100 : 0, feedback: { correct } };
    }
    case "multi_choice": {
      const selected = readStringArray(input.submitted, "optionIds");
      if (!selected || !input.answer) return { kind: "invalid_answer" };
      const correctSet = new Set(input.answer.correctOptionIds);
      const selectedSet = new Set(selected);
      const correct = [...selectedSet].filter((id) => correctSet.has(id)).length;
      const wrong = [...selectedSet].filter((id) => !correctSet.has(id)).length;
      const incorrectCount = Math.max(1, (input.options?.length ?? correctSet.size + 1) - correctSet.size);
      const score = Math.round(Math.max(0, Math.min(1, correct / Math.max(1, correctSet.size) - wrong / incorrectCount)) * 100);
      return { kind: "graded", score, feedback: { correct: score === 100 } };
    }
    case "true_false": {
      const value = readBoolean(input.submitted);
      if (value === null || !input.answer) return { kind: "invalid_answer" };
      const correct = value === input.answer.correct;
      return { kind: "graded", score: correct ? 100 : 0, feedback: { correct } };
    }
    case "fill_blank": {
      const submitted = readStringArray(input.submitted, "values");
      if (!submitted || !input.answer) return { kind: "invalid_answer" };
      const total = input.answer.blanks.length;
      const hits = input.answer.blanks.reduce((sum, accepted, index) => {
        const value = normalize(submitted[index] ?? "");
        return sum + (accepted.some((candidate) => normalize(candidate) === value) ? 1 : 0);
      }, 0);
      const score = Math.round((hits / Math.max(1, total)) * 100);
      return { kind: "graded", score, feedback: { correct: score === 100 } };
    }
    case "ordering": {
      const submitted = readStringArray(input.submitted, "order");
      if (!submitted || !input.answer) return { kind: "invalid_answer" };
      const hits = input.answer.order.filter((id, index) => submitted[index] === id).length;
      const score = Math.round((hits / Math.max(1, input.answer.order.length)) * 100);
      return { kind: "graded", score, feedback: { correct: score === 100 } };
    }
    case "matching": {
      const submitted = input.submitted && typeof input.submitted === "object" && "pairs" in input.submitted ? (input.submitted as { pairs: unknown }).pairs : input.submitted;
      const pairs = readRecord(submitted);
      if (!pairs || !input.answer) return { kind: "invalid_answer" };
      const entries = Object.entries(input.answer.pairs);
      const hits = entries.filter(([left, right]) => pairs[left] === right).length;
      const score = Math.round((hits / Math.max(1, entries.length)) * 100);
      return { kind: "graded", score, feedback: { correct: score === 100 } };
    }
    case "short_answer":
      return { kind: "needs_companion", reason: "subjective" };
    case "operation":
      return { kind: "needs_companion", reason: "subjective" };
  }
}

export function cardQuestionTypeNeedsCompanionV1(type: NoteLearningCardQuestionTypeV1): boolean {
  return type === "short_answer" || type === "operation";
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/[。．.]$/u, "");
}

function readString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.trim() ? candidate : null;
}

function readStringArray(value: unknown, key?: string): string[] | null {
  const candidate = key && value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : value;
  if (!Array.isArray(candidate)) return null;
  const items = candidate.filter((item): item is string => typeof item === "string");
  return items.length === candidate.length ? items : null;
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value && typeof value === "object" && typeof (value as { value?: unknown }).value === "boolean") {
    return (value as { value: boolean }).value;
  }
  return null;
}

function readRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== "string") return null;
    out[key] = item;
  }
  return out;
}
