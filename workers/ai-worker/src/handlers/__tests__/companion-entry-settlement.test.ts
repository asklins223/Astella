import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompanionEntrySettlement } from "../turn/companion-entry-settlement.ts";
import { companionDirectInterpretation } from "../turn/companion-entry-mode.ts";

test("settlement commits one interpretation without a routing call", async () => {
  let release!: () => void;
  const committed = new Promise<void>(resolve => { release = resolve; });
  let calls = 0, completed = false;
  const entry = createCompanionEntrySettlement({ mode: "direct_fast", requestHash: "a".repeat(64), cached: null,
    messages: [{ role: "user", content: "在吗？" }], writingAnnotation: false, requiresGrounding: false, recovered: false,
    event: {} as never,
    args: { ctx: { signal: new AbortController().signal }, read: { userText: "在吗？" }, onProviderDelta: async () => true,
      provider: { chatCompletion: async () => { throw new Error("no online router"); } } } as never,
  }, async (_event, meta) => { calls++; assert.equal((meta.route as { resourceDecision?: unknown }).resourceDecision, undefined); await committed; });
  assert.equal(entry.speculative, false);
  const first = entry.settle().then(() => { completed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false); assert.equal(calls, 1);
  const second = entry.settle(); release(); await Promise.all([first, second]);
  assert.equal(calls, 1); assert.equal(entry.workload, "casual");
});

test("a host conversation keeps its trusted occasion instead of reverting to an unclassified question", async () => {
  const cached = { ...companionDirectInterpretation("b".repeat(64)),
    intent: "conversation" as const, toolUse: "none" as const, status: "interpreted" as const };
  let persisted: unknown;
  const entry = createCompanionEntrySettlement({ mode: "direct_fast", requestHash: cached.requestHash, cached,
    messages: [{ role: "system", hostObservation: true, requestBoundary: true, content: "synthetic startup" }],
    writingAnnotation: false, requiresGrounding: true, recovered: false, event: {} as never,
    args: { ctx: { signal: new AbortController().signal }, read: { userText: "", initiativeInput: { topic: "app.started" } },
      onTurnInterpretation: async (a: { intent: string }) => { persisted = a.intent; },
      provider: { chatCompletion: async () => { throw new Error("a host occasion needs no classification"); } } } as never,
  }, async () => undefined);
  await entry.settle();
  assert.equal(persisted, "conversation");
  assert.equal(entry.attention.status, "interpreted");
  assert.equal(entry.attention.toolUse, "none");
  assert.equal(entry.workload, "casual");
});
