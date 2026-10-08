import assert from "node:assert/strict";
import { test } from "node:test";
import { runWithLeaseHeartbeat } from "../lease-heartbeat.ts";

test("a long operation renews serially and preserves its signal after success", async () => {
  let renewals = 0, concurrent = 0, maxConcurrent = 0;
  let operationSignal!: AbortSignal;
  let finish!: (result: string) => void;
  const result = await runWithLeaseHeartbeat({
    signal: new AbortController().signal, intervalMs: 2,
    renew: async () => {
      renewals++; concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(resolve => setTimeout(resolve, 2)); concurrent--;
      if (renewals === 3) finish("saved");
    },
    operation: async signal => {
      operationSignal = signal;
      return new Promise<string>(resolve => { finish = resolve; });
    },
  });
  assert.equal(result, "saved");
  assert.ok(renewals > 2);
  assert.equal(maxConcurrent, 1);
  assert.equal(operationSignal.aborted, false);
  const count = renewals;
  await new Promise(resolve => setTimeout(resolve, 8));
  assert.equal(renewals, count);
});

test("losing a lease aborts the operation and stops further renewals", async () => {
  let renewals = 0;
  const lost = new Error("lease lost");
  let signal!: AbortSignal;
  await assert.rejects(runWithLeaseHeartbeat({
    signal: new AbortController().signal, intervalMs: 1,
    renew: async () => { if (++renewals === 2) throw lost; },
    operation: async s => { signal = s; return new Promise(() => {}); },
  }), error => error === lost);
  assert.equal(signal.aborted, true);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(renewals, 2);
});

test("parent cancellation interrupts an operation and initial renewal", async () => {
  for (const initial of [true, false]) {
    const parent = new AbortController();
    const cancelled = new Error("cancelled");
    const run = runWithLeaseHeartbeat({
      signal: parent.signal, intervalMs: 1,
      renew: async () => initial ? new Promise<void>(() => {}) : undefined,
      operation: async () => new Promise(() => {}),
    });
    setTimeout(() => parent.abort(cancelled), 2);
    await assert.rejects(run, error => error === cancelled);
  }
});

test("a late operation cannot turn lease loss into success", async () => {
  let finish!: (value: string) => void, renewals = 0;
  const lost = new Error("lease lost");
  const run = runWithLeaseHeartbeat({ signal: new AbortController().signal, intervalMs: 1,
    renew: async () => { if (++renewals === 2) throw lost; },
    operation: () => new Promise<string>(resolve => { finish = resolve; }),
  });
  await assert.rejects(run, error => error === lost);
  finish("late saved");
});

test("ordinary handler failures are not reported as late lease failures", async () => {
  const failure = new Error("ordinary failure");
  let late = 0;
  await assert.rejects(runWithLeaseHeartbeat({ signal: new AbortController().signal, intervalMs: 10,
    renew: async () => {}, operation: async () => { throw failure; },
    onLateError: () => { late++; },
  }), error => error === failure);
  await Promise.resolve();
  assert.equal(late, 0);
});
