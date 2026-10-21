import assert from "node:assert/strict";
import { test } from "node:test";
import { assessNoteLearningCard, summarizeGradedCard, type CardAssessmentQuestion } from "../note/note-learning-card-assessment.ts";
import { validateNoteLearningCardGeneration, type GeneratedCardQuestion } from "../note/note-learning-card-validation.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const grounding = { note: [{ blockOrdinal: 0, quote: "电压为6V。" }] };
const objective: CardAssessmentQuestion = { id: id(1), questionType: "true_false", stem: "电压是否为6V？", answer: { correct: true }, options: null, rubric: null, grounding };
const subjective: CardAssessmentQuestion = { ...objective, id: id(2), questionType: "short_answer", rubric: [{ points: 1, keyword: "6V" }] };
const summary = (text: string, ids = [id(1)]) => ({ items: ids.map(questionId => ({ questionId, observation: text })), nextStep: "结合原文的电阻条件，再核对一次计算过程。" });
test("all-objective cards request a whole-card summary while the host keeps ownership of scores", async () => {
  let calls = 0;
  const result = await assessNoteLearningCard([objective], [{ questionId: id(1), answer: true }], async input => {
    calls++; assert.equal(input.subjective.length, 0); assert.equal((input.questions[0] as { score: number }).score, 100);
    assert.equal((input.questions[0] as { questionNumber: number }).questionNumber, 1);
    return JSON.stringify({ results: [], summary: summary("电压答得准确，下次结合电阻继续练习。") });
  });
  assert.equal(calls, 1); assert.equal(result.score, 100); assert.match(result.summary!, /电压/);
});
test("summary failure and summary-only retry preserve the completed score", async () => {
  const result = await assessNoteLearningCard([objective], [{ questionId: id(1), answer: false }], async () => { throw new Error("offline"); });
  assert.equal(result.score, 0); assert.equal(result.summary, null);
  assert.ok(await summarizeGradedCard([objective], [{ questionId: id(1), answer: false, score: 0 }], async input => {
    assert.equal(input.subjective.length, 0); assert.equal((input.questions[0] as { score: number }).score, 0);
    return JSON.stringify({ results: [], summary: summary("回看电压的原文，再试一次。") });
  }));
});
test("the host assigns summary labels and rejects invented, missing or renumbered references without losing grades", async () => {
  const third = { ...objective, id: id(3) }, fourth = { ...objective, id: id(4) };
  const questions = [objective, subjective, third, fourth];
  const answers = questions.map(q => ({ questionId: q.id, answer: q.questionType === "short_answer" ? { text: "6V" } : true }));
  const valid = summary("原文电压值与作答一致。", questions.map(q => q.id));
  const ask = (value: unknown) => async () => JSON.stringify({ results: [{ questionId: id(2), score: 100, feedback: "电压解释正确。" }], summary: value });
  const good = await assessNoteLearningCard(questions, answers, ask(valid));
  assert.match(good.summary!, /第4题：原文电压值/); assert.equal(good.score, 100);
  for (const invalid of [
    { ...valid, items: valid.items.slice(0, 3) },
    { ...valid, items: valid.items.map((item, i) => i === 3 ? { ...item, questionId: id(9) } : item) },
    { ...valid, items: valid.items.map((item, i) => i === 3 ? { ...item, observation: "第3题的电压判断正确。" } : item) },
  ]) { const result = await assessNoteLearningCard(questions, answers, ask(invalid)); assert.equal(result.summary, null); assert.equal(result.score, 100); }
});
test("missing, duplicate and invented subjective identities cannot produce completed zero-point answers", async () => {
  for (const results of [[], [{ questionId: id(9), score: 90, feedback: "正确" }], [{ questionId: id(2), score: 90, feedback: "正确" }, { questionId: id(2), score: 90, feedback: "正确" }]]) {
    await assert.rejects(assessNoteLearningCard([subjective], [{ questionId: id(2), answer: { text: "6V" } }], async () => JSON.stringify({ results, summary: "这次回答正确，可以继续练习。" })), /逐一对应/);
  }
});
test("valid subjective scores survive a missing summary; skips stay in the denominator", async () => {
  const result = await assessNoteLearningCard([objective, subjective], [{ questionId: id(1), answer: { skipped: true } }, { questionId: id(2), answer: { text: "6V" } }], async () => JSON.stringify({ results: [{ questionId: id(2), score: 80, feedback: "电压正确，单位还可说明。" }] }));
  assert.equal(result.score, 40); assert.equal(result.summary, null); assert.equal(result.results[0]!.feedback.kind, "skipped");
});
const lines = [{ ordinal: 0, text: "电压为6V。电阻为3Ω，电流为2A。" }];
const candidates: GeneratedCardQuestion[] = [
  { type: "single_choice", stem: "电压是多少？", options: ["6V", "3V"], answer: { correctOptionId: "0" }, grounding },
  { type: "true_false", stem: "电阻是否为3Ω？", answer: { correct: true }, grounding },
  { type: "short_answer", stem: "电流是多少？", rubric: [{ points: 1, keyword: "2A" }], grounding },
  { type: "multi_choice", stem: "哪些数值符合原文？", options: ["6V", "3Ω", "4A"], answer: { correctOptionIds: ["0", "1"] }, grounding },
];
test("generation checks frozen quotations, answer shapes, duplicates and source provenance", () => {
  assert.equal(validateNoteLearningCardGeneration(candidates, lines, 4).length, 4);
  const changed = (patch: Partial<GeneratedCardQuestion>) => [{ ...candidates[0]!, ...patch }, ...candidates.slice(1)];
  for (const passage of [{ blockOrdinal: 9, quote: "电压为6V。" }, { blockOrdinal: 0, quote: "电压为9V。" }]) {
    assert.throws(() => validateNoteLearningCardGeneration(changed({ grounding: { note: [passage] } }), lines, 4), /对应段落/);
  }
  assert.throws(() => validateNoteLearningCardGeneration(changed({ answer: { correctOptionId: "9" } }), lines, 4), /可判分/);
  assert.throws(() => validateNoteLearningCardGeneration(changed({ stem: candidates[1]!.stem }), lines, 4), /repeats/);
  const extension = { kind: "web", title: "外部资料", quote: "补充文段", relation: "补充", url: "https://example.com" };
  assert.throws(() => validateNoteLearningCardGeneration(changed({ grounding: { ...grounding, extension } }), lines, 4), /拓展来源未核对/);
  assert.equal(validateNoteLearningCardGeneration(changed({ grounding: { ...grounding, extension: { ...extension, kind: "ai_generated" } } }), lines, 4).length, 4);
});
