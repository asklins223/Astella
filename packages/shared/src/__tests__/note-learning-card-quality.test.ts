import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cardQuestionMixIssuesV1,
  isCardQuestionStemV1,
  validateCardQuestionCandidatesV1,
  type CardQuestionCandidateV1,
} from "../learning/note-learning-card-quality.ts";

const quote = { note: [{ blockOrdinal: 2, quote: "秦统一后统一度量衡。" }] };

describe("note learning card question quality", () => {
  it("accepts interrogative stems and operation instructions", () => {
    assert.equal(isCardQuestionStemV1("single_choice", "秦统一后为什么先统一度量衡？"), true);
    assert.equal(isCardQuestionStemV1("operation", "把四项措施拖到对应的治理目标下。"), true);
    assert.equal(isCardQuestionStemV1("short_answer", "秦统一后统一度量衡。"), false);
    assert.equal(isCardQuestionStemV1("short_answer", "请回忆原文关于度量衡的内容。"), false);
    assert.equal(isCardQuestionStemV1("true_false", "这一项措施是秦朝推行的，对吗？"), true);
    assert.equal(isCardQuestionStemV1("operation", "请将这些步骤按目标顺序排列。"), true);
    assert.equal(isCardQuestionStemV1("short_answer", "What changed after unification?"), true);
  });

  it("rejects ungrounded or extension-less questions", () => {
    const candidates: CardQuestionCandidateV1[] = [
      { type: "single_choice", stem: "秦统一后为什么先统一度量衡？", grounding: quote },
      { type: "short_answer", stem: "统一度量衡带来了什么好处？", grounding: { note: [] } },
      { type: "short_answer", stem: "统一度量衡与赋税有什么关系？", grounding: { ...quote, extension: { kind: "web", title: "秦制", quote: "", relation: "补充" } } },
      { type: "short_answer", stem: "统一度量衡与赋税有什么关系？", grounding: { ...quote, extension: { kind: "web", title: "秦制", quote: "文段", relation: "补充" } } },
    ];
    const result = validateCardQuestionCandidatesV1(candidates);
    assert.equal(result.accepted.length, 1);
    assert.deepEqual(result.rejected.map((item) => item.reason), ["missing_grounding", "missing_extension_excerpt", "web_extension_without_url"]);
  });

  it("requires a mixed card", () => {
    const base: CardQuestionCandidateV1 = { type: "single_choice", stem: "秦统一后为什么先统一度量衡？", grounding: quote };
    assert.equal(cardQuestionMixIssuesV1([base, base, base, base]).includes("card needs at least 3 question types"), true);
    assert.deepEqual(cardQuestionMixIssuesV1([
      base,
      { ...base, type: "short_answer", stem: "统一度量衡带来了什么好处？" },
      { ...base, type: "true_false", stem: "秦统一后是否统一了度量衡？" },
      { ...base, type: "fill_blank", stem: "秦统一后统一了____？" },
    ]), []);
  });
});
