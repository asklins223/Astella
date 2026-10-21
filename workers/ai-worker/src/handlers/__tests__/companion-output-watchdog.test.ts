import assert from "node:assert/strict";
import { test } from "node:test";
import { watchCompanionOutput, executeWatchedCompanionTurn } from "../agent/companion-output-watchdog.ts";
import type { AIProvider } from "../../lib/ai-provider.ts";
import type { AgentTurnRequest, AgentTurnResult } from "@astella/shared";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
test("first output and idle expiry abort the provider with distinct reasons", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  try {
    for (const first of [true, false]) {
      let signal: AbortSignal | undefined, activity = () => {};
      const output = watchCompanionOutput((s, a) => { signal = s; activity = a; return new Promise(() => {}); },
        new AbortController().signal, { firstOutputMs: 100, idleMs: 40 });
      const rejected = assert.rejects(output, { code: first ? "provider_first_output_timeout" : "provider_idle_timeout" });
      await flush();
      if (!first) { t.mock.timers.tick(90); activity(); t.mock.timers.tick(39); assert.equal(signal?.aborted, false); t.mock.timers.tick(1); }
      else t.mock.timers.tick(100);
      await rejected; assert.equal(signal?.aborted, true);
    }
  } finally { t.mock.timers.reset(); }
});
test("continuous real output can exceed the first-output interval without a task lifetime cap", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  try {
    let activity = () => {}, finish: (value: string) => void = () => {};
    const output = watchCompanionOutput((_s, a) => { activity = a; return new Promise<string>(resolve => { finish = resolve; }); },
      new AbortController().signal, { firstOutputMs: 100, idleMs: 40 });
    await flush();
    for (let i = 0; i < 30; i++) { t.mock.timers.tick(30); activity(); }
    finish("done"); assert.equal(await output, "done");
    activity(); t.mock.timers.tick(1000); // late callbacks cannot arm an orphan timer
  } finally { t.mock.timers.reset(); }
});
test("parent cancellation wins even when an uncooperative provider returns later", async () => {
  const parent = new AbortController(); let signal: AbortSignal | undefined;
  let finish: (value: string) => void = () => {};
  const output = watchCompanionOutput(s => { signal = s; return new Promise<string>(resolve => { finish = resolve; }); }, parent.signal);
  await flush(); const rejection = assert.rejects(output, /topic changed/);
  parent.abort(new Error("topic changed")); finish("old answer"); await rejection;
  assert.equal(signal?.aborted, true);
});

test("buffered native output keeps a healthy long attempt alive and cancellation still fences its late result", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  try {
    let activity: (() => void) | undefined, signal: AbortSignal | undefined;
    let finish: (result: AgentTurnResult) => void = () => {};
    const provider = { executeAgentTurn: (_request: AgentTurnRequest, observed: AbortSignal,
      observation?: { onOutputActivity?: () => void }) => {
      signal = observed; activity = observation?.onOutputActivity;
      return new Promise<AgentTurnResult>(resolve => { finish = resolve; });
    } } as AIProvider;
    const parent = new AbortController();
    const result = executeWatchedCompanionTurn(provider, {} as AgentTurnRequest, parent.signal);
    const rejected = assert.rejects(result, /new topic/);
    await flush();
    activity?.();
    for (let i = 0; i < 10; i++) { t.mock.timers.tick(30_000); activity?.(); }
    assert.equal(signal?.aborted, false);
    parent.abort(new Error("new topic")); finish({ content: "late", toolCalls: [], finishReason: "stop", usage: null, providerRequestId: null });
    await rejected; assert.equal(signal?.aborted, true);
  } finally { t.mock.timers.reset(); }
});
