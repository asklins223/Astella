import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentTurnResult } from "@astella/shared";
import type { AIProvider } from "../../lib/ai-provider.ts";
import { ProviderRequestError } from "../../lib/provider-request-error.ts";
import { AgentOutputError } from "../../lib/non-retryable-errors.ts";
import { CompanionOutputTimeoutError } from "../agent/companion-output-watchdog.ts";
import { CompanionDegenerateLoopError } from "../agent/companion-agent-streaming-step.ts";
import { recoverCompanionStreamFailure } from "../agent/companion-stream-recovery.ts";

const provider = { id: "primary", modelId: "primary", executeAgentTurn: async () => ({}) } as unknown as AIProvider;
const alternate = { id: "alternate", modelId: "alternate", executeAgentTurn: async () => ({}) } as unknown as AIProvider;

/** A complete result shape, so the stub satisfies the real return type. */
const turnResult = (content: string): AgentTurnResult => ({
  content, toolCalls: [], finishReason: "stop",
  usage: null, providerRequestId: null,
});

function harness(overrides: Partial<Parameters<typeof recoverCompanionStreamFailure>[0]> = {}) {
  const calls: string[] = [];
  const input = {
    error: new Error("boom") as unknown,
    runBuffered: async (attempts?: number) => { calls.push(`buffered:${attempts ?? "default"}`); return turnResult("ok"); },
    attemptStream: async () => { calls.push("stream"); return turnResult("streamed"); },
    canRetryStream: () => true,
    stepProvider: provider,
    fallbackProvider: alternate as AIProvider | null | undefined,
    fitsFallback: async () => true,
    useFallback: (next: AIProvider) => { calls.push(`fallback:${next.id}`); },
    stepCount: 1,
    runId: "run",
    ...overrides,
  };
  return { calls, input };
}

test("a looping reply retries once on the alternate model instead of failing the turn", async () => {
  const { calls, input } = harness({ error: new CompanionDegenerateLoopError("loop") });
  const result = await recoverCompanionStreamFailure(input);
  assert.equal(result.content, "ok");
  assert.deepEqual(calls, ["fallback:alternate", "buffered:1"]);
});

test("a loop that repeats again on the retry gives up honestly", async () => {
  const { input } = harness({
    error: new CompanionDegenerateLoopError("loop"),
    runBuffered: async () => turnResult("记住了，十点以后不打扰你，有事留到明天。".repeat(100)),
  });
  await assert.rejects(recoverCompanionStreamFailure(input),
    (error: unknown) => error instanceof AgentOutputError && error.code === "no_progress");
});

test("a first-output timeout switches to the alternate when it fits", async () => {
  const { calls, input } = harness({
    error: new CompanionOutputTimeoutError("provider_first_output_timeout"),
  });
  await recoverCompanionStreamFailure(input);
  assert.deepEqual(calls, ["fallback:alternate", "buffered:1"]);
});

test("a first-output timeout with no fitting alternate retries once, not the full stack", async () => {
  const { calls, input } = harness({
    error: new CompanionOutputTimeoutError("provider_first_output_timeout"),
    fitsFallback: async () => false,
  });
  await recoverCompanionStreamFailure(input);
  assert.deepEqual(calls, ["buffered:1"]);
});

test("a transient 5xx retries the stream before falling back to buffered", async () => {
  const { calls, input } = harness({ error: new ProviderRequestError({ provider: "primary", status: 503 }) });
  const result = await recoverCompanionStreamFailure(input);
  assert.equal(result.content, "streamed");
  assert.deepEqual(calls, ["stream"]);
});

test("a non-transient failure goes straight to the buffered turn", async () => {
  const { calls, input } = harness({ error: new ProviderRequestError({ provider: "primary", status: 400 }) });
  await recoverCompanionStreamFailure(input);
  assert.deepEqual(calls, ["buffered:default"]);
});

test("an error that cannot be retried is rethrown untouched", async () => {
  const original = new Error("contract");
  const { input } = harness({ error: original, canRetryStream: () => false });
  await assert.rejects(recoverCompanionStreamFailure(input), (error: unknown) => error === original);
});
