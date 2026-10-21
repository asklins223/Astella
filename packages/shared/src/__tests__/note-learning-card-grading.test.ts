import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gradeCardQuestionV1 } from "../learning/note-learning-card-grading.ts";

describe("note learning card objective grading", () => {
  it("grades single choice, true/false and multi choice", () => {
    assert.deepEqual(gradeCardQuestionV1({ type: "single_choice", answer: { correctOptionId: "b" }, submitted: { optionId: "b" } }), { kind: "graded", score: 100, feedback: { correct: true } });
    assert.deepEqual(gradeCardQuestionV1({ type: "true_false", answer: { correct: false }, submitted: false }), { kind: "graded", score: 100, feedback: { correct: true } });
    assert.equal(gradeCardQuestionV1({ type: "multi_choice", answer: { correctOptionIds: ["a", "b"] }, submitted: ["a"] }).kind, "graded");
    assert.equal((gradeCardQuestionV1({ type: "multi_choice", answer: { correctOptionIds: ["a", "b"] }, submitted: ["a"] }) as { score: number }).score, 50);
  });

  it("grades fill blank, ordering and matching", () => {
    assert.equal((gradeCardQuestionV1({ type: "fill_blank", answer: { blanks: [["统一度量衡"], ["赋税"]] }, submitted: ["统一度量衡", "赋税。"] }) as { score: number }).score, 100);
    assert.equal((gradeCardQuestionV1({ type: "ordering", answer: { order: ["a", "b", "c"] }, submitted: ["a", "c", "b"] }) as { score: number }).score, 33);
    assert.equal((gradeCardQuestionV1({ type: "matching", answer: { pairs: { a: "1", b: "2" } }, submitted: { a: "1", b: "x" } }) as { score: number }).score, 50);
  });

  it("scales the multi-choice penalty by all incorrect options", () => {
    const grade = (selected: string[]) => gradeCardQuestionV1({ type: "multi_choice", options: ["a", "b", "c", "d"], answer: { correctOptionIds: ["a", "b"] }, submitted: selected }) as { score: number };
    assert.equal(grade(["a", "b", "c"]).score, 50);
    assert.equal(grade(["a", "c"]).score, 0);
    assert.equal(grade(["a", "b"]).score, 100);
    assert.equal(grade(["a", "a"]).score, 50);
  });

  it("sends subjective and operation questions to the companion", () => {
    assert.deepEqual(gradeCardQuestionV1({ type: "short_answer", rubric: {}, submitted: "..." }), { kind: "needs_companion", reason: "subjective" });
    assert.deepEqual(gradeCardQuestionV1({ type: "operation", expected: {}, submitted: {} }), { kind: "needs_companion", reason: "subjective" });
  });
});

it("grades the desktop matching envelope and explicit skips without requesting semantic grading", () => {
  const match = gradeCardQuestionV1({ type: "matching", answer: { pairs: { "0": "行政", "1": "财政" } }, submitted: { pairs: { "0": "行政", "1": "财政" } } });
  assert.equal(match.kind, "graded"); assert.equal((match as { score: number }).score, 100);
  for (const type of ["short_answer", "operation", "matching"] as const) {
    const result = gradeCardQuestionV1({ type, submitted: { skipped: true } } as Parameters<typeof gradeCardQuestionV1>[0]);
    assert.equal(result.kind, "graded"); assert.equal((result as { score: number }).score, 0);
  }
});
