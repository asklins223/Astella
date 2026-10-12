import assert from "node:assert/strict";
import test from "node:test";
import { executeTurn } from "@astella/agent-core";
import { companionAgentBudgetSnapshotV1Schema } from "@astella/shared";
import { companionExecutionPolicy } from "../companion-execution-policy.ts";
import { companionStepRuntimePolicy } from "../companion-step-plan.ts";

test("default agent completes a task beyond the old step and call ceilings", async () => {
  const policy = companionExecutionPolicy({});
  assert.equal(policy.maxSteps, null);
  assert.equal(policy.maxToolCalls, null);
  assert.equal(policy.maxModelCalls, null);
  assert.equal(policy.maxToolCallsPerStep, null);
  assert.equal(policy.maxWebSearchCalls, null);
  assert.ok(companionAgentBudgetSnapshotV1Schema.safeParse(policy).success);
  let calls = 0;
  const result = await executeTurn({ now: () => 1, limits: () => ({ maxSteps: policy.maxSteps ?? Infinity, deadlineAt: 100 }),
    budgetError: () => new Error("budget"), advance: async step => {
      calls += 3;
      return step === 20 ? { kind: "settled", result: "saved and verified" } : { kind: "continue" };
    } });
  assert.equal(result, "saved and verified");
  assert.equal(calls, 60);
  assert.doesNotMatch(companionStepRuntimePolicy({ permissionLevel: "full", toolCount: 2, stepBudget: Infinity,
    finalAnswerOnly: false, attentionIntent: "task" }), /最多.*步|Infinity|这是最后一步/);
});

test("explicit operator count limits remain configurable and serializable", () => {
  const policy = companionExecutionPolicy({ WORKER_COMPANION_MAX_STEPS: "45", WORKER_COMPANION_MAX_TOOL_CALLS: "100",
    WORKER_COMPANION_MAX_MODEL_CALLS: "60", WORKER_COMPANION_MAX_TOOL_CALLS_PER_STEP: "10" });
  assert.equal(policy.maxSteps, 45);
  assert.ok(companionAgentBudgetSnapshotV1Schema.safeParse(policy).success);
  assert.throws(() => companionExecutionPolicy({ WORKER_COMPANION_MAX_STEPS: "-1" }));
});

test("unlimited count policy still obeys deadline and immediate cancellation", async () => {
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(executeTurn({ signal: stopped.signal, now: () => 1, limits: () => ({ maxSteps: Infinity, deadlineAt: 100 }),
    budgetError: () => new Error("budget"), advance: async () => { throw new Error("must not execute"); } }), /abort/i);
  await assert.rejects(executeTurn({ now: () => 100, limits: () => ({ maxSteps: Infinity, deadlineAt: 100 }),
    budgetError: () => new Error("deadline"), advance: async () => { throw new Error("must not execute"); } }), /deadline/);
});
