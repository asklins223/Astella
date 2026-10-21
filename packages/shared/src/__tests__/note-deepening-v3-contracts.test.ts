/**
 * Star-map deepening contract tests (Plan 57).
 *
 * The axes stay three separate named facts, and the only number in the whole
 * read is the attempt's own score/stars — there is no synthesized mastery
 * percentage.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveNoteStateAxesV3,
  noteDeepeningV3Schema,
  type NoteDeepeningV3,
} from "../contracts/note/note-deepening-v3-contracts.ts";

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const CARD_ID = "22222222-2222-4222-8222-222222222222";
const QUESTION_A = "33333333-3333-4333-8333-333333333333";
const ATTEMPT_A = "44444444-4444-4444-8444-444444444444";

function deepening(overrides: Partial<NoteDeepeningV3> = {}): NoteDeepeningV3 {
  return {
    version: 3,
    noteId: NOTE_ID,
    noteTitle: "一份笔记",
    hasBody: true,
    sourceId: null,
    axes: deriveNoteStateAxesV3({ attemptCount: 1, bestStars: 4, hasCard: true, sourceUpdated: false }),
    card: {
      cardId: CARD_ID,
      status: "active",
      bestStars: 4,
      bestScore: 88,
      attemptCount: 1,
      questions: [{
        questionId: QUESTION_A,
        ordinal: 0,
        questionType: "short_answer",
        stem: "为什么答案是它？",
        bestStars: 4,
        bestScore: 88,
      }],
    },
    attempts: [{
      attemptId: ATTEMPT_A,
      status: "completed",
      score: 88,
      stars: 4,
      completedAt: "2026-10-19T01:00:00.000Z",
    }],
    attemptsComplete: true,
    ...overrides,
  };
}

test("完整的一份展开可以通过合同", () => {
  const parsed = noteDeepeningV3Schema.parse(deepening());
  assert.equal(parsed.card?.questions.length, 1);
  assert.equal(parsed.attempts.length, 1);
});

test("三轴是三个具名事实，多写一个总分就解析失败", () => {
  const fixture = deepening();
  const parsed = noteDeepeningV3Schema.safeParse({ ...fixture, masteryScore: 73 });
  assert.equal(parsed.success, false);
});

test("没有学习卡时 card 为 null，而不是编一张空卡", () => {
  const parsed = noteDeepeningV3Schema.parse(deepening({
    card: null,
    attempts: [],
    axes: deriveNoteStateAxesV3({ attemptCount: 0, bestStars: null, hasCard: false, sourceUpdated: false }),
  }));
  assert.equal(parsed.card, null);
  assert.equal(parsed.axes.performance, "no_record_yet");
  assert.equal(parsed.axes.nextStep, "nothing_to_do");
});

test("星级与分数有硬边界", () => {
  assert.equal(noteDeepeningV3Schema.safeParse(deepening({ attempts: [{
    attemptId: ATTEMPT_A, status: "completed", score: 101, stars: 4, completedAt: null,
  }] })).success, false);
  assert.equal(noteDeepeningV3Schema.safeParse(deepening({ attempts: [{
    attemptId: ATTEMPT_A, status: "completed", score: 50, stars: 6, completedAt: null,
  }] })).success, false);
});

test("正文改过时轴三只说材料状态，不改写练习表现", () => {
  const stale = deriveNoteStateAxesV3({ attemptCount: 1, bestStars: 5, hasCard: true, sourceUpdated: true });
  assert.equal(stale.applicability, "basis_updated");
  assert.equal(stale.performance, "used_independently");
});
