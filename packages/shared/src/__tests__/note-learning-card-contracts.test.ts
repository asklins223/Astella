import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bestNoteLearningCardResultV1,
  noteLearningCardScoreV1,
  noteLearningCardStarsV1,
  noteLearningCardV1Schema,
} from "../contracts/learning/note-learning-card-contracts.ts";

describe("note learning card stars", () => {
  it("maps the agreed score bands", () => {
    assert.equal(noteLearningCardStarsV1(100), 5);
    assert.equal(noteLearningCardStarsV1(90), 5);
    assert.equal(noteLearningCardStarsV1(89), 4);
    assert.equal(noteLearningCardStarsV1(75), 4);
    assert.equal(noteLearningCardStarsV1(74), 3);
    assert.equal(noteLearningCardStarsV1(60), 3);
    assert.equal(noteLearningCardStarsV1(59), 2);
    assert.equal(noteLearningCardStarsV1(40), 2);
    assert.equal(noteLearningCardStarsV1(39), 1);
    assert.equal(noteLearningCardStarsV1(1), 1);
    assert.equal(noteLearningCardStarsV1(0), 0);
  });

  it("averages question scores equally", () => {
    assert.equal(noteLearningCardScoreV1([100, 80, 60]), 80);
    assert.equal(noteLearningCardScoreV1([100, 0]), 50);
    assert.equal(noteLearningCardScoreV1([]), 0);
  });

  it("keeps the best attempt only", () => {
    assert.deepEqual(bestNoteLearningCardResultV1([
      { score: 45, stars: 2, completedAt: "2026-10-19T00:00:00.000Z" },
      { score: 82, stars: 4, completedAt: "2026-10-19T01:00:00.000Z" },
    ]), { score: 82, stars: 4 });
    assert.deepEqual(bestNoteLearningCardResultV1([
      { score: 82, stars: 4, completedAt: "2026-10-19T00:00:00.000Z" },
      { score: 45, stars: 2, completedAt: "2026-10-19T01:00:00.000Z" },
    ]), { score: 82, stars: 4 });
  });

  it("does not count an unfinished attempt", () => {
    assert.deepEqual(bestNoteLearningCardResultV1([
      { score: null, stars: null, completedAt: null },
      { score: 0, stars: 0, completedAt: "2026-10-19T00:00:00.000Z" },
    ]), { score: 0, stars: 0 });
  });
});

it("validates generation counts and distinguishes an explicit skip from a false answer", async () => {
  const { noteLearningCardGenerationOptionsV1Schema, isNoteLearningCardSkipV1 } = await import("../contracts/learning/note-learning-card-contracts.ts");
  const { readNoteLearningCardGenerateJobPayload } = await import("../contracts/agent/job-payload-contracts.ts");
  assert.equal(noteLearningCardGenerationOptionsV1Schema.parse({}).questionCount, 6);
  assert.equal(noteLearningCardGenerationOptionsV1Schema.safeParse({ questionCount: 5 }).success, false);
  assert.equal(isNoteLearningCardSkipV1(false), false);
  assert.equal(isNoteLearningCardSkipV1({ skipped: true, draft: { text: "保留草稿" } }), true);
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const payload = { cardId: id, noteId: id, noteVersionId: id, cardGenerationId: id };
  assert.equal(readNoteLearningCardGenerateJobPayload(payload).questionCount, 6);
  assert.equal(readNoteLearningCardGenerateJobPayload({ ...payload, questionCount: 8 }).questionCount, 8);
  assert.throws(() => readNoteLearningCardGenerateJobPayload({ ...payload, questionCount: 5 }), /questionCount/);
});

it("exposes the discarded-question count additively, defaulting to zero", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const card = {
    cardId: id, noteId: id, noteVersionId: id, status: "active" as const,
    questions: [{
      questionId: id, ordinal: 0, type: "true_false" as const, stem: "是否如此？",
      options: null, rightOptions: null, blankCount: null, operationArtifactId: null,
      grounding: { note: [{ blockOrdinal: 0, quote: "原文依据。" }] },
    }],
    bestScore: null, bestStars: null, lastAttempt: null,
    createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z",
  };
  assert.equal(noteLearningCardV1Schema.parse(card).omittedQuestionCount, 0);
  assert.equal(noteLearningCardV1Schema.parse({ ...card, omittedQuestionCount: 3 }).omittedQuestionCount, 3);
  assert.equal(noteLearningCardV1Schema.safeParse({ ...card, omittedQuestionCount: -1 }).success, false);
});
