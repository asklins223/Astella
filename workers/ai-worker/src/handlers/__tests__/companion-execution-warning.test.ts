import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldWarnCompanionModelCalls } from "../agent/companion-execution-policy.ts";

test("long runs produce periodic, configurable call-count warnings", () => {
  assert.equal(shouldWarnCompanionModelCalls(49, {}), false);
  assert.equal(shouldWarnCompanionModelCalls(50, {}), true);
  assert.equal(shouldWarnCompanionModelCalls(100, {}), true);
  assert.equal(shouldWarnCompanionModelCalls(3, { WORKER_COMPANION_CALL_WARNING_INTERVAL: "3" }), true);
  assert.equal(shouldWarnCompanionModelCalls(50, { WORKER_COMPANION_CALL_WARNING_INTERVAL: "bad" }), true);
});
