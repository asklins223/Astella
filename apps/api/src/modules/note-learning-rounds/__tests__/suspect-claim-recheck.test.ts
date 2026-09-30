import { test } from "node:test";
import assert from "node:assert/strict";
import { roundSuspectClaimV1Schema } from "@ailearn/shared/note-learning-round-contracts";
import type { RoundTargetDraft } from "../teaching/round-target-contract.ts";
import { classifySuspectClaimEditV1, constrainTargetToSuspectRechecksV1 } from "../suspect-claim-recheck.ts";

const claim = roundSuspectClaimV1Schema.parse({
  unitIds: ["unit-index-leftmost"],
  sourceBlockOrdinal: 4,
  sourceQuote: "复合索引缺少最左列条件就无法使用索引",
  reason: "绝对化结论可能遗漏适用条件。",
});

test("只在原引用段落变更后重检；原文移位时保留待核对", () => {
  assert.equal(classifySuspectClaimEditV1({ claim,
    previousBlockText: "复合索引缺少最左列条件就无法使用索引。", currentBlockText: "复合索引缺少最左列条件就无法使用索引。" }), "unchanged");
  assert.equal(classifySuspectClaimEditV1({ claim,
    previousBlockText: "复合索引缺少最左列条件就无法使用索引。", currentBlockText: "复合索引在缺少最左列条件时通常无法使用索引。" }), "changed");
  assert.equal(classifySuspectClaimEditV1({ claim,
    previousBlockText: "复合索引缺少最左列条件就无法使用索引。",
    currentBlockText: "复合索引缺少最左列条件就无法使用索引。\n已核对来源摘录：左侧列顺序会影响可用的索引范围。" }), "changed",
  "new evidence in the same cited block is rechecked even when the old quote remains intact");
  assert.equal(classifySuspectClaimEditV1({ claim,
    previousBlockText: "前言。复合索引缺少最左列条件就无法使用索引。", currentBlockText: "新前言。复合索引缺少最左列条件就无法使用索引。" }), "uncertain",
  "quote relocation does not get fuzzy-matched to a new position");
  assert.equal(classifySuspectClaimEditV1({ claim,
    previousBlockText: "复合索引缺少最左列条件就无法使用索引。", currentBlockText: "另一段新内容。",
    currentOtherBlockTexts: ["前言。复合索引缺少最左列条件就无法使用索引。"] }), "uncertain",
  "moving the quoted claim to another block is not treated as an edit at the old ordinal");
});

test("无法精确定位或当前块消失时不自动重检", () => {
  assert.equal(classifySuspectClaimEditV1({ claim: { ...claim, sourceQuote: null, sourceBlockOrdinal: null },
    previousBlockText: null, currentBlockText: "新内容" }), "uncertain");
  assert.equal(classifySuspectClaimEditV1({ claim, previousBlockText: "没有这句", currentBlockText: "改过的内容" }), "uncertain");
  assert.equal(classifySuspectClaimEditV1({ claim, previousBlockText: "复合索引缺少最左列条件就无法使用索引。", currentBlockText: null }), "uncertain");
});

test("重检目标必须恰好是受影响 unit，不能带入安全的其他目标", () => {
  const rechecks = [{ unitId: "unit-index-leftmost", sourceBlockOrdinal: 4, sourceQuote: claim.sourceQuote!, reason: claim.reason }];
  const proposal: RoundTargetDraft = { conceptLabel: "索引条件", objectiveStatement: "解释索引使用条件", publicSummary: "索引使用条件",
    knowledgeForm: "boundary", units: [{ unitId: "unit-index-leftmost", fact: "复合索引的使用取决于查询条件。",
      criterion: "说明左侧列条件与其他适用条件", facet: "boundary", sourceBlockOrdinal: 4,
      quote: "复合索引在缺少最左列条件时通常无法使用索引。" }] };
  assert.equal(constrainTargetToSuspectRechecksV1(proposal, rechecks), proposal);
  assert.equal(constrainTargetToSuspectRechecksV1({ ...proposal, units: [...proposal.units, {
    ...proposal.units[0], unitId: "safe-unrelated-unit", sourceBlockOrdinal: 8,
  }] }, rechecks), null);
  assert.equal(constrainTargetToSuspectRechecksV1({ ...proposal, units: [{ ...proposal.units[0], sourceBlockOrdinal: 8 }] }, rechecks), null);
});
