import assert from "node:assert/strict";
import { test } from "node:test";
import {
  generateReviewedNoteLearningCard,
  hostDuplicateQuestionGroups,
  noteLearningCardReviewMessages,
  validateNoteLearningCardReview,
} from "../note/note-learning-card-review.ts";
import type { GeneratedCardQuestion } from "../note/note-learning-card-validation.ts";
import { NoteOverviewOutputError } from "../../lib/non-retryable-errors.ts";

const lines = [{ ordinal: 0, text: "电压为6V，电阻为3Ω，电流为2A，电功率为12W。实验先断开电源，再连接电路，最后接通电源。" }];
const grounding = { note: [{ blockOrdinal: 0, quote: lines[0]!.text }] };
const four: GeneratedCardQuestion[] = [
  { type: "single_choice", stem: "电压是多少？", options: ["6V", "3V"], answer: { correctOptionId: "0" }, grounding },
  { type: "true_false", stem: "电阻是否为3Ω？", answer: { correct: true }, grounding },
  { type: "short_answer", stem: "电流是多少？", rubric: [{ points: 1, keyword: "2A" }], grounding },
  { type: "fill_blank", stem: "电功率是多少（____）？", answer: { blanks: [["12W"]] }, grounding },
];
/** Five questions give one discard of headroom while still leaving 4 valid questions. */
const five: GeneratedCardQuestion[] = [...four, { type: "multi_choice", stem: "哪些数值符合原文？", options: ["6V", "3Ω", "4A"], answer: { correctOptionIds: ["0", "1"] }, grounding }];

function reviewFor(card: readonly GeneratedCardQuestion[], knowledgePoints?: readonly string[]) {
  return {
    questions: card.map((question, index) => ({
      questionNumber: index + 1,
      answerSupported: true,
      unambiguous: true,
      knowledgePoint: knowledgePoints?.[index] ?? question.stem,
      reason: `独立解答第${index + 1}题，答案与对应物理量数值一致。`,
      evidence: grounding.note,
      solution: question.type === "single_choice" ? { optionIds: ["0"] }
        : question.type === "multi_choice" ? { optionIds: ["0", "1"] }
          : question.type === "true_false" ? { correct: true } : null,
    })),
    duplicateGroups: [] as { questionNumbers: number[]; reason: string }[],
  };
}
const json = (value: unknown) => JSON.stringify(value);

test("review returns per-question semantic issues instead of one aggregated throw", () => {
  const review = reviewFor(four);
  review.questions[0]!.answerSupported = false;
  review.questions[0]!.reason = "实际电压为6V，给定答案却是3V，无法成立。";
  review.questions[2]!.evidence = [{ blockOrdinal: 0, quote: "电流为9A" }];
  const result = validateNoteLearningCardReview(json(review), four, lines);
  assert.deepEqual(result.issues.map((issue) => issue.questionNumber), [1, 3]);
  assert.ok(result.issues[0]!.checks.includes("answer_unsupported"));
  assert.ok(result.issues[1]!.checks.includes("evidence_missing"));
  assert.match(result.issues[0]!.detail, /第1题/);
  assert.match(result.issues[0]!.detail, /3V/);
  assert.deepEqual(result.duplicateGroups, []);
  assert.deepEqual(validateNoteLearningCardReview(json(reviewFor(four)), four, lines), { issues: [], duplicateGroups: [] });
});

test("structural review problems stay retryable errors: invalid JSON, incomplete coverage and invalid duplicate identities", () => {
  for (const raw of ["{}", "not json"]) assert.throws(() => validateNoteLearningCardReview(raw, four, lines));
  const missing = reviewFor(four); missing.questions.pop();
  assert.throws(() => validateNoteLearningCardReview(json(missing), four, lines));
  const renumbered = reviewFor(four); renumbered.questions[1]!.questionNumber = 1;
  assert.throws(() => validateNoteLearningCardReview(json(renumbered), four, lines), /逐一覆盖/);
  const inventedGroup = reviewFor(four); inventedGroup.duplicateGroups.push({ questionNumbers: [1, 9], reason: "同一事实重复提问" });
  assert.throws(() => validateNoteLearningCardReview(json(inventedGroup), four, lines), /题号无效/);
});

test("objective review solves without seeing the supplied key, and host comparison catches one-based option confusion", () => {
  const incorrect = structuredClone(four); incorrect[0]!.answer = { correctOptionId: "1" };
  const request = JSON.parse(String(noteLearningCardReviewMessages(incorrect, lines, [])[1]!.content));
  assert.equal(request.questions[0].answer, undefined);
  assert.deepEqual(request.questions[0].options, [{ optionId: "0", text: "6V" }, { optionId: "1", text: "3V" }]);
  const result = validateNoteLearningCardReview(json(reviewFor(four)), incorrect, lines);
  assert.deepEqual(result.issues.map((issue) => issue.questionNumber), [1]);
  assert.ok(result.issues[0]!.checks.includes("answer_mismatch"));
});

test("host duplicate check treats same-quote + same/nearly-equal knowledge point as one question", () => {
  const points = five.map((question) => question.stem);
  points[1] = "电阻的具体数值";
  points[3] = "电阻的具体数值";
  const groups = hostDuplicateQuestionGroups(five, five.map((_, index) => ({ questionNumber: index + 1, knowledgePoint: points[index]! })));
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]!.questionNumbers, [2, 4]);
  assert.equal(groups[0]!.origin, "host");
  // Same quote but genuinely different knowledge points must not be discarded.
  assert.deepEqual(hostDuplicateQuestionGroups(five, five.map((question, index) => ({ questionNumber: index + 1, knowledgePoint: `${question.stem}${index}` }))), []);
  // Near-identical wording (one containing the other) still counts as the same point.
  const nearly = hostDuplicateQuestionGroups(five, five.map((_, index) => ({ questionNumber: index + 1, knowledgePoint: index === 0 ? "电阻的具体数值" : index === 1 ? "电阻的具体数值是多少" : `其他考点${index}` })));
  assert.deepEqual(nearly[0]!.questionNumbers, [1, 2]);
  // An essentially identical sub-sentence quote also matches.
  const subQuote = five.map((question, index) => index === 2 ? { ...question, grounding: { note: [{ blockOrdinal: 0, quote: "实验先断开电源，再连接电路" }] } }
    : index === 3 ? { ...question, grounding: { note: [{ blockOrdinal: 0, quote: "实验先断开电源，再连接电路，最后接通电源" }] } } : question);
  const subGroups = hostDuplicateQuestionGroups(subQuote, five.map((_, index) => ({ questionNumber: index + 1, knowledgePoint: index === 2 || index === 3 ? "实验步骤的先后顺序" : `其他考点${index}` })));
  assert.deepEqual(subGroups[0]!.questionNumbers, [3, 4]);
});

test("a first-attempt generation failure is retried once with a correction naming the failed question", async () => {
  let generations = 0, reviews = 0;
  const result = await generateReviewedNoteLearningCard({ lines, sources: [], count: 4,
    generate: async (correction, attempt) => {
      generations++;
      if (attempt === 0) {
        const bad = structuredClone(four);
        bad[1]!.grounding = { note: [{ blockOrdinal: 0, quote: "电阻为9Ω" }] };
        return bad;
      }
      assert.match(correction!, /第 2 题引文与保存版本的对应段落不符/);
      assert.match(correction!, /电阻为9Ω/);
      return four;
    },
    review: async () => { reviews++; return json(reviewFor(four)); },
  });
  assert.deepEqual(result.questions, four);
  assert.equal(result.omittedCount, 0);
  assert.equal(generations, 2);
  assert.equal(reviews, 1);
});

test("after the retry, still-invalid questions are discarded and reported per question", async () => {
  let generations = 0, reviews = 0;
  const broken = () => {
    const card = structuredClone(five);
    card[1]!.grounding = { note: [{ blockOrdinal: 0, quote: "电阻为9Ω" }] };
    return card;
  };
  const result = await generateReviewedNoteLearningCard({ lines, sources: [], count: 5,
    generate: async () => { generations++; return broken(); },
    review: async (card) => { reviews++; return json(reviewFor(card)); },
  });
  assert.deepEqual(result.questions.map((question) => question.stem), five.filter((_, index) => index !== 1).map((question) => question.stem));
  assert.equal(result.omittedCount, 1);
  assert.equal(result.omitted[0]!.questionNumber, 2);
  assert.ok(result.omitted[0]!.checks.includes("note_quote_mismatch"));
  assert.match(result.omitted[0]!.detail, /第 2 题引文与保存版本的对应段落不符/);
  assert.equal(result.omitted[0]!.excerpt, "电阻为9Ω");
  assert.equal(generations, 2);
  assert.equal(reviews, 1);
});

test("a semantic review failure is retried once, then only the failing question is discarded (2 generations / 2 reviews)", async () => {
  let generations = 0, reviews = 0;
  const result = await generateReviewedNoteLearningCard({ lines, sources: [], count: 5,
    generate: async (correction, attempt) => {
      generations++;
      if (attempt === 1) assert.match(correction!, /第1题/);
      return five;
    },
    review: async (card) => {
      reviews++;
      const review = reviewFor(card);
      review.questions[0]!.answerSupported = false;
      review.questions[0]!.reason = "这道题的给定答案错误，实际应选择6V。";
      return json(review);
    },
  });
  assert.deepEqual(result.questions, five.slice(1));
  assert.equal(result.omittedCount, 1);
  assert.equal(result.omitted[0]!.questionNumber, 1);
  assert.ok(result.omitted[0]!.checks.includes("answer_unsupported"));
  assert.equal(generations, 2);
  assert.equal(reviews, 2);
});

test("after the retry, one question per duplicate group is discarded and the earliest is kept", async () => {
  let generations = 0, reviews = 0;
  const result = await generateReviewedNoteLearningCard({ lines, sources: [], count: 5,
    generate: async () => { generations++; return five; },
    review: async (card) => {
      reviews++;
      const review = reviewFor(card);
      review.duplicateGroups.push({ questionNumbers: [2, 5], reason: "两题实际都在问同一个电阻值事实" });
      return json(review);
    },
  });
  assert.deepEqual(result.questions.map((question) => question.stem), five.filter((_, index) => index !== 4).map((question) => question.stem));
  assert.equal(result.omittedCount, 1);
  assert.equal(result.omitted[0]!.questionNumber, 5);
  assert.ok(result.omitted[0]!.checks.includes("review_duplicate"));
  assert.match(result.omitted[0]!.detail, /第 5 题与第 2 题重复/);
  assert.equal(generations, 2);
  assert.equal(reviews, 2);
});

test("the host duplicate check discards a same-quote/same-fact pair the review missed", async () => {
  const knowledgePoints = five.map((question) => question.stem);
  knowledgePoints[1] = "电阻的具体数值";
  knowledgePoints[3] = "电阻的具体数值";
  let reviews = 0;
  const result = await generateReviewedNoteLearningCard({ lines, sources: [], count: 5,
    generate: async () => five,
    review: async (card) => { reviews++; return json(reviewFor(card, knowledgePoints)); },
  });
  assert.equal(reviews, 2);
  assert.equal(result.omittedCount, 1);
  assert.equal(result.omitted[0]!.questionNumber, 4);
  assert.ok(result.omitted[0]!.checks.includes("host_duplicate"));
  assert.match(result.omitted[0]!.detail, /第 4 题与第 2 题重复/);
  assert.equal(result.questions.length, 4);
});

test("fewer than four valid questions after the retry fails the whole card with diagnosable detail", async () => {
  const broken = () => {
    const card = structuredClone(five);
    card[0]!.grounding = { note: [{ blockOrdinal: 0, quote: "电压为9V" }] };
    card[1]!.answer = { correct: "是" };
    return card;
  };
  let reviews = 0;
  await assert.rejects(generateReviewedNoteLearningCard({ lines, sources: [], count: 5,
    generate: async () => broken(),
    review: async () => { reviews++; return json(reviewFor(five)); },
  }), (error: Error) => /有效题 3 道/.test(error.message)
    && /第 1 题引文与保存版本的对应段落不符/.test(error.message)
    && /电压为9V/.test(error.message)
    && /第 2 题缺少可判分的答案/.test(error.message));
  assert.equal(reviews, 0);
});

test("a review that discards too many questions also fails the card instead of persisting a stub", async () => {
  await assert.rejects(generateReviewedNoteLearningCard({ lines, sources: [], count: 5,
    generate: async () => five,
    review: async (card) => {
      const review = reviewFor(card);
      for (const question of review.questions.slice(0, 2)) { question.answerSupported = false; question.reason = "这道题没有足够的原文支撑。"; }
      return json(review);
    },
  }), /有效题 3 道/);
});

test("provider/network errors are not converted into content retries", async () => {
  let generations = 0, reviews = 0;
  await assert.rejects(generateReviewedNoteLearningCard({ lines, sources: [], count: 4,
    generate: async () => { generations++; throw new Error("provider unavailable"); },
    review: async () => { reviews++; return json(reviewFor(four)); },
  }), /provider unavailable/);
  assert.equal(generations, 1);
  assert.equal(reviews, 0);
});

test("shape failures retry once without spending a review; a structural review failure is retried too", async () => {
  let generations = 0, reviews = 0;
  await generateReviewedNoteLearningCard({ lines, sources: [], count: 4,
    generate: async (_correction, attempt) => {
      generations++;
      if (attempt === 0) throw new NoteOverviewOutputError("学习卡结果缺少题目、答案或原文依据：questions: Required");
      return four;
    },
    review: async () => { reviews++; return json(reviewFor(four)); },
  });
  assert.equal(generations, 2);
  assert.equal(reviews, 1);
  reviews = 0;
  const result = await generateReviewedNoteLearningCard({ lines, sources: [], count: 4,
    generate: async () => four,
    review: async () => { reviews++; return reviews === 1 ? "{}" : json(reviewFor(four)); },
  });
  assert.equal(result.questions.length, 4);
  assert.equal(reviews, 2);
});
