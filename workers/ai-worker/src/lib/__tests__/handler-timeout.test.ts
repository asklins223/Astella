import assert from "node:assert/strict";
import test from "node:test";
import { runWithAbortTimeout, runWithAbortBudget, HandlerTimeoutError } from "../handler-timeout.ts";

test("uncapped agent task does not turn Infinity into Node's one-millisecond timer", async () => {
  assert.equal(await runWithAbortTimeout(async () => "done", Infinity), "done");
  assert.equal(await runWithAbortBudget(async () => "done", undefined, Infinity), "done");
});

test("uncapped child still follows parent cancellation and cleans up its signal", async () => {
  const parent = new AbortController();
  let child: AbortSignal | undefined;
  const task = runWithAbortBudget(signal => {
    child = signal;
    return new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }, parent.signal, Infinity);
  await Promise.resolve();
  parent.abort(new Error("stopped by user"));
  await assert.rejects(task, /stopped by user/);
  assert.equal(child?.aborted, true);
});

test("an explicit service timeout aborts the child and reports timeout", async () => {
  let child: AbortSignal | undefined;
  await assert.rejects(runWithAbortBudget(signal => {
    child = signal;
    return new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }, undefined, 5), HandlerTimeoutError);
  assert.equal(child?.aborted, true);
});

test("long configured deadlines re-arm Node timers instead of overflowing", async context => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const duration = 28 * 24 * 60 * 60_000;
  let child: AbortSignal | undefined;
  const task = runWithAbortBudget(signal => {
    child = signal;
    return new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }, undefined, duration);
  const rejection = assert.rejects(task, HandlerTimeoutError);
  await Promise.resolve();
  context.mock.timers.tick(2_147_483_647);
  assert.equal(child?.aborted, false);
  context.mock.timers.tick(duration - 2_147_483_647);
  await rejection;
  assert.equal(child?.aborted, true);
});
