import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { platform, observedProvider, root, type WireReceipt } from "./acceptance-common.ts";
import { noteLearningCardReviewMessages, validateNoteLearningCardReview } from "../handlers/note/note-learning-card-review.ts";
import { initiativeSpeechReviewMessages, parseInitiativeSpeechReview } from "../handlers/proactive/companion-initiative-speech-review.ts";
import type { GeneratedCardQuestion } from "../handlers/note/note-learning-card-validation.ts";

// Controlled synthetic facts, sent only to the currently configured real model.
const dir = `${root}outputs/audits/plan57-58-completion-2026-10-21`;
mkdirSync(dir, { recursive: true });
const wire: WireReceipt[] = [], records: unknown[] = [];
const provider = observedProvider(platform("note_generation"), "p57-semantic-acceptance", wire);
const disableReviewThinking = process.env.PLAN57_REVIEW_DISABLE_THINKING === "1";
const lines = [{ ordinal: 0, text: "电压为6V，电阻为3Ω。温度不变的欧姆导体满足I=U/R，因此电流为2A。实验顺序为断开电源、连接电路、核对连接、接通电源。" }];
const grounding = { note: [{ blockOrdinal: 0, quote: lines[0]!.text }] };
const questions: GeneratedCardQuestion[] = [
  { type: "single_choice", stem: "实验中的电压是多少？", options: ["6V", "3V", "9V"], answer: { correctOptionId: "0" }, grounding },
  { type: "true_false", stem: "实验中的电阻是否为3Ω？", answer: { correct: true }, grounding },
  { type: "short_answer", stem: "根据欧姆定律，如何求出实验中的电流？", rubric: [{ points: 1, keyword: "I=U/R=6/3=2A" }], grounding },
  { type: "ordering", stem: "实验操作应该如何排序？", options: ["核对连接", "断开电源", "接通电源", "连接电路"], answer: { order: ["1", "3", "0", "2"] }, grounding },
];
const save = () => writeFileSync(`${dir}/semantic-live-${stamp}.json`, JSON.stringify({ synthetic: true, disableReviewThinking, records, wire }, null, 2));
const stamp = Date.now();
try {
  for (const name of ["correct", "wrong-answer-and-duplicate"] as const) {
    const card = structuredClone(questions);
    if (name !== "correct") {
      card[0]!.answer = { correctOptionId: "1" };
      card[1] = { ...card[1]!, stem: "实验中的电压是否为6V？" };
      card[2]!.rubric = [{ points: 1, keyword: "I=U/R=3A" }];
    }
    const start = Date.now();
    const result = await provider.chatCompletion(noteLearningCardReviewMessages(card, lines, []), { responseFormat: "json_object", temperature: 0,
      ...(disableReviewThinking ? { disableThinking: true } : {}) }, AbortSignal.timeout(120_000));
    let accepted = false, failure: string | null = null;
    try {
      const review = validateNoteLearningCardReview(result.content, card, lines);
      accepted = review.issues.length === 0 && review.duplicateGroups.length === 0;
      failure = [
        ...review.issues.map((issue) => issue.detail),
        ...review.duplicateGroups.map((group) => `第${group.questionNumbers.join("、")}题重复考查：${group.reason}`),
      ].join("；") || null;
    } catch (error) { failure = String(error); }
    records.push({ name, elapsedMs: Date.now() - start, accepted, result: result.content, failure }); save();
    assert.equal(accepted, name === "correct", name);
    if (name !== "correct") { assert.match(failure!, /第1题/); assert.match(failure!, /第3题/); assert.match(failure!, /重复考查/); }
  }
  for (const [candidate, previous, decision] of [
    ["问你个事，你觉得打字速度快慢和脑子转得快慢是一回事吗？", "问你个事儿，你觉得打字速度快慢和脑子转得快慢是一回事吗？", "repeat"],
    ["原文的电压应为9V，电阻仍为3Ω。", "原文的电压为6V，电阻为3Ω。", "publish"],
    ["我总觉得背东西出声和默念是不太一样的，你平时会出声吗？", "我老觉得背东西出声和默念不是一路货，你平时会出声吗？", "repeat"],
  ]) {
    const start = Date.now();
    const result = await provider.chatCompletion(initiativeSpeechReviewMessages(candidate!, { previous: [{ id: "synthetic", text: previous! }], unfinished: null }), { responseFormat: "json_object", temperature: 0, disableThinking: true }, AbortSignal.timeout(60_000));
    const verdict = parseInitiativeSpeechReview(result.content);
    records.push({ candidate, previous, expected: decision, verdict, elapsedMs: Date.now() - start }); save();
    assert.equal(verdict === null, decision === "publish");
  }
  const result = await provider.chatCompletion(initiativeSpeechReviewMessages("郡县制那三句我准备好了，你哪天想听就喊我，不急。", {
    previous: [], unfinished: { status: "failed", text: "请根据笔记，用三句话解释郡县制和分封制的区别。" },
  }), { responseFormat: "json_object", temperature: 0, disableThinking: true }, AbortSignal.timeout(60_000));
  const verdict = parseInitiativeSpeechReview(result.content);
  records.push({ name: "failed-request-deferral", verdict }); save(); assert.match(verdict!, /failed_request_replay/);
  console.log(`Passed independent card review and four initiative content cases. Evidence: ${dir}/semantic-live-${stamp}.json`);
} finally { save(); }
