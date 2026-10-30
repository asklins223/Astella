import assert from "node:assert/strict";
import { after, test } from "node:test";
import { watchCompanionOutput, executeWatchedCompanionTurn, companionOutputWatchdogPolicy } from "../agent/companion-output-watchdog.ts";
import type { AIProvider } from "../../lib/ai-provider.ts";
import type { AgentTurnRequest, AgentTurnResult } from "@astella/shared";
import { AgentRole } from "@astella/shared";
import { createGovernedProvider } from "../../lib/governance.ts";
import { recoverCompanionStreamFailure } from "../agent/companion-stream-recovery.ts";

import { closeDatabase } from "../../db.ts";

after(closeDatabase);

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
test("cold-start output budget is independent from idle progress and remains configurable", () => {
  const keys = ["COMPANION_PROVIDER_FIRST_OUTPUT_TIMEOUT_MS", "COMPANION_PROVIDER_IDLE_TIMEOUT_MS", "COMPANION_CASUAL_PROVIDER_FIRST_OUTPUT_TIMEOUT_MS", "COMPANION_PROVIDER_FIRST_MEANINGFUL_OUTPUT_TIMEOUT_MS"] as const;
  const previous = keys.map(key => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    assert.deepEqual(companionOutputWatchdogPolicy(), { firstOutputMs: 12_000, idleMs: 45_000, firstMeaningfulOutputMs: Infinity });
    assert.deepEqual(companionOutputWatchdogPolicy("casual"), { firstOutputMs: 5_000, idleMs: 45_000, firstMeaningfulOutputMs: Infinity });
    assert.deepEqual(companionOutputWatchdogPolicy("casual", "recovery"), { firstOutputMs: 12_000, idleMs: 45_000, firstMeaningfulOutputMs: Infinity });
    process.env.COMPANION_PROVIDER_FIRST_OUTPUT_TIMEOUT_MS = "90000";
    process.env.COMPANION_PROVIDER_IDLE_TIMEOUT_MS = "30000";
    assert.deepEqual(companionOutputWatchdogPolicy(), { firstOutputMs: 90_000, idleMs: 30_000, firstMeaningfulOutputMs: Infinity });
    process.env.COMPANION_CASUAL_PROVIDER_FIRST_OUTPUT_TIMEOUT_MS = "2500";
    assert.deepEqual(companionOutputWatchdogPolicy("casual"), { firstOutputMs: 2_500, idleMs: 30_000, firstMeaningfulOutputMs: Infinity });
    assert.deepEqual(companionOutputWatchdogPolicy("casual", "recovery"), { firstOutputMs: 90_000, idleMs: 30_000, firstMeaningfulOutputMs: Infinity });
    delete process.env.COMPANION_CASUAL_PROVIDER_FIRST_OUTPUT_TIMEOUT_MS;
    process.env.COMPANION_PROVIDER_FIRST_OUTPUT_TIMEOUT_MS = "0";
    assert.equal(companionOutputWatchdogPolicy("casual").firstOutputMs, Infinity);
    process.env.COMPANION_PROVIDER_FIRST_MEANINGFUL_OUTPUT_TIMEOUT_MS = "0";
    assert.equal(companionOutputWatchdogPolicy().firstMeaningfulOutputMs, Infinity);
    process.env.COMPANION_PROVIDER_FIRST_MEANINGFUL_OUTPUT_TIMEOUT_MS = "120000";
    assert.equal(companionOutputWatchdogPolicy().firstMeaningfulOutputMs, 120_000);
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});
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
test("a stalled casual primary can recover on a model whose first output takes more than five seconds", { timeout: 5_000 }, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const parent = new AbortController();
  let finish = (_result: AgentTurnResult) => {};
  t.after(() => parent.abort(new Error("fixture cleanup")));
  try {
    const result: AgentTurnResult = { content: "recovered", toolCalls: [], finishReason: "stop", usage: null, providerRequestId: null };
    const primary = { id: "primary", modelId: "primary" } as AIProvider;
    const fallback = { id: "fallback", modelId: "reasoning-only", visionModelId: "", promptVersion: "test",
      chatCompletion: async () => ({ content: "recovered", usage: {} }),
      executeAgentTurn: async () => result, chatCompletionStream: async () => ({ content: "recovered" }) } as AIProvider;
    let current = primary, fallbackSignal: AbortSignal | undefined;
    let primaryStarted!: () => void, fallbackStarted = false;
    const started = new Promise<void>(resolve => { primaryStarted = resolve; });
    const attempt = () => watchCompanionOutput<AgentTurnResult>((signal) => new Promise(resolve => {
      if (current === fallback) { fallbackSignal = signal; finish = resolve; fallbackStarted = true; }
      else primaryStarted();
    }), parent.signal, companionOutputWatchdogPolicy("casual", current === primary ? "primary" : "recovery"));
    const pending = attempt().catch(error => recoverCompanionStreamFailure({ error,
      stepProvider: primary, fallbackProvider: fallback, fitsFallback: async () => true,
      useFallback: provider => { current = provider; }, canRetryStream: () => true,
      attemptStream: attempt, runBuffered: attempt, stepCount: 1, runId: "synthetic",
    }));
    const observed = pending.then(value => ({ value }), error => ({ error }));
    await started;
    t.mock.timers.tick(5_000);
    // The recovery crosses several promise boundaries. Observe the actual
    // fallback start; a missing start must fail, never await an unresolved
    // promise while the only deadlines are on a paused fake clock.
    for (let index = 0; index < 10 && !fallbackStarted; index++) await flush();
    assert.equal(fallbackStarted, true, "the first-output timeout must start fallback recovery");
    t.mock.timers.tick(7_000);
    assert.equal(fallbackSignal?.aborted, false, "the fallback needs its own normal startup allowance");
    finish(result);
    assert.deepEqual(await observed, { value: result });
  } finally { parent.abort(new Error("fixture cleanup")); finish({ content: "cleanup", toolCalls: [], finishReason: "stop", usage: null, providerRequestId: null }); t.mock.timers.reset(); }
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

test("continuous reasoning alone cannot postpone usable output forever", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  let finish!: (value: string) => void;
  try {
    let activity: (kind?: "text" | "tool" | "reasoning") => void = () => {};
    let signal!: AbortSignal;
    const output = watchCompanionOutput((s, a) => {
      signal = s; activity = a; return new Promise<string>(resolve => { finish = resolve; });
    }, new AbortController().signal, { firstOutputMs: 30, idleMs: 30, firstMeaningfulOutputMs: 60 });
    const observed = output.then(value => ({ value }), error => ({ error }));
    await flush();
    for (let i = 0; i < 3; i++) { activity("reasoning"); t.mock.timers.tick(20); await flush(); }
    const aborted = signal.aborted;
    finish("late");
    const result = await observed;
    assert.equal(aborted, true);
    assert.ok("error" in result);
    assert.equal(result.error.code, "provider_progress_timeout");
  } finally { finish?.("cleanup"); t.mock.timers.reset(); }
});

test("real answer or tool output clears the reasoning-only timer without capping the task", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  try {
    for (const kind of ["text", "tool"] as const) {
      let activity: (kind?: "text" | "tool" | "reasoning") => void = () => {}, finish!: (value: string) => void;
      let signal!: AbortSignal;
      const output = watchCompanionOutput((s, a) => {
        signal = s; activity = a; return new Promise<string>(resolve => { finish = resolve; });
      }, new AbortController().signal, { firstOutputMs: 30, idleMs: 30, firstMeaningfulOutputMs: 60 });
      await flush(); activity("reasoning"); t.mock.timers.tick(20); activity(kind);
      for (let i = 0; i < 30; i++) { t.mock.timers.tick(20); activity("reasoning"); }
      assert.equal(signal.aborted, false);
      finish("done"); assert.equal(await output, "done");
    }
  } finally { t.mock.timers.reset(); }
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

test("the production governance boundary preserves progress on a buffered native call", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  try {
    let activity: (() => void) | undefined;
    let finish!: (result: AgentTurnResult) => void;
    let requestSignal: AbortSignal | undefined;
    const provider = createGovernedProvider({ id: "synthetic", modelId: "synthetic", promptVersion: "synthetic", visionModelId: "",
      chatCompletion: async () => ({ content: "", usage: {} }),
      executeAgentTurn: async (_request, signal, observation) => {
        requestSignal = signal; activity = observation?.onOutputActivity;
        return new Promise(resolve => { finish = resolve; });
      },
    }, { consentOk: true, policy: { sendToExternal: true, piiDetection: false,
      sendImageContent: false, auditLogging: false } }, "synthetic-workspace");
    const pending = executeWatchedCompanionTurn(provider, { role: AgentRole.COMPANION_AGENT,
      systemPrompt: "synthetic", messages: [{ role: "user", content: "synthetic" }],
      tools: [], maxTokens: 100, temperature: 0.2 }, new AbortController().signal);
    // Observe rejection immediately to keep a regression from leaking a promise.
    const result = pending.then(value => ({ value }), error => ({ error }));
    await flush();
    for (let i = 0; i < 10; i++) { activity?.(); t.mock.timers.tick(10_000); await flush(); }
    assert.equal(requestSignal?.aborted, false, "real progress must survive the first-output deadline through governance");
    finish({ content: "done", toolCalls: [], finishReason: "stop", usage: null, providerRequestId: null });
    assert.equal("value" in await result, true);
  } finally { t.mock.timers.reset(); }
});
