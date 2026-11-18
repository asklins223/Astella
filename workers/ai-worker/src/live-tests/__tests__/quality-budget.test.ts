import assert from "node:assert/strict";
import { test } from "node:test";
import { createQualityRequestBudget, QualityRequestBudgetExceeded } from "../quality-budget.ts";

test("real-model evaluation requires a finite request budget and fails closed", () => {
  for (const input of [undefined, "", "0", "1.5", "101", "NaN"]) {
    assert.throws(() => createQualityRequestBudget(input));
  }
  const budget = createQualityRequestBudget("2");
  budget.reserve(); budget.reserve();
  assert.equal(budget.used, 2);
  assert.throws(() => budget.reserve(), QualityRequestBudgetExceeded);
  assert.equal(budget.used, 2);
  assert.throws(() => createQualityRequestBudget(undefined, "LIVE_RUNTIME_MAX_REQUESTS"), /LIVE_RUNTIME_MAX_REQUESTS/);
});
