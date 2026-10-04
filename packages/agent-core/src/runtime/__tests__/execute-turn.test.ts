import assert from "node:assert/strict";
import { test } from "node:test";
import { executeTurn } from "../execute-turn.ts";

test("a settled result prevents further model or effect steps", async () => {
  const visited: number[] = [];
  const result = await executeTurn({ now: () => 0, limits: () => ({ maxSteps: 8, deadlineAt: 100 }), budgetError: () => new Error("budget"),
    advance: async step => { visited.push(step); return step === 2 ? { kind: "settled", result: "receipt" } : { kind: "continue" }; } });
  assert.equal(result, "receipt"); assert.deepEqual(visited, [1, 2]);
});
test("resume consumes only the remaining lifetime step budget", async () => {
  let calls = 0;
  await assert.rejects(executeTurn({ now: () => 0, limits: () => ({ maxSteps: 8 - 7, deadlineAt: 100 }), budgetError: () => new Error("budget"),
    advance: async () => { calls++; return { kind: "continue" }; } }), /budget/);
  assert.equal(calls, 1);
});
test("changing the host limit can grant one recovery step without restarting", async () => {
  let maxSteps = 1;
  const result = await executeTurn({ now: () => 0, limits: () => ({ maxSteps, deadlineAt: 100 }), budgetError: () => new Error("budget"),
    advance: async step => { if (step === 1) { maxSteps++; return { kind: "continue" }; } return { kind: "settled", result: step }; } });
  assert.equal(result, 2);
});
test("abort and deadline fences prevent the next effect", async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(executeTurn({ signal: controller.signal, now: () => 0, limits: () => ({ maxSteps: 4, deadlineAt: 100 }), budgetError: () => new Error("budget"),
    advance: async () => { calls++; controller.abort(new Error("cancelled")); return { kind: "continue" }; } }), /cancelled/);
  assert.equal(calls, 1);
  await assert.rejects(executeTurn({ now: () => 100, limits: () => ({ maxSteps: 4, deadlineAt: 100 }), budgetError: () => new Error("deadline"),
    advance: async () => { throw new Error("unexpected effect"); } }), /deadline/);
});
