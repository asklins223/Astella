import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRoundReadingPlan, suggestRoundQuestion } from "./learning-plan.ts";

const blocks = [{ ordinal: 1, type: "heading", text: "## 条件" }, { ordinal: 2, type: "heading", text: "## 步骤" }];
test("a server suggestion names saved structure without demanding a form", () => {
  assert.match(suggestRoundQuestion("笔记", blocks), /条件/);
  assert.ok(suggestRoundQuestion("", []).length > 0);
});
test("rewritten question selects its named section and keeps a finite reading route", () => {
  const plan = buildRoundReadingPlan("先学步骤", blocks);
  assert.equal(plan.steps.length, 2); assert.match(plan.steps[0].text, /步骤/);
  assert.ok(!plan.steps[0].text.includes("「条件」"));
});
test("empty or huge heading text stays inside the plan contract", () => {
  assert.equal(buildRoundReadingPlan("问题", []).steps.length, 2);
  assert.ok(buildRoundReadingPlan("问题", [{ ordinal: 1, type: "heading", text: "字".repeat(5000) }]).steps[0].text.length < 500);
});
