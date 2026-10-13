import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { ReasoningEffort } from "@astella/shared/platform-config";
import { observedProvider, platform, safeFailure, save, type WireReceipt } from "./acceptance-common.ts";

const name = process.env.LIVE_LATENCY_PROBE_NAME;
if (!name || !/^[a-z0-9-]{1,72}$/.test(name)) throw new Error("Explicit unique LIVE_LATENCY_PROBE_NAME required");
const effortNames = (process.env.LIVE_LATENCY_EFFORTS ?? "high,medium,low,none").split(",").map(value => value.trim());
const repeats = Number(process.env.LIVE_LATENCY_REPEATS ?? "3");
const prompt = "只用一句不超过二十字的中文回答：纯电阻负载固定电压时，电阻增大，功率如何变化？给出公式。";
const baseRoute = platform("agent_turn");
const reasoning = baseRoute.modelProfile?.reasoning;
assert.ok(reasoning, "agent_turn model must declare reasoning levels for this comparison");
assert.ok(Number.isInteger(repeats) && repeats >= 2 && repeats <= 6, "repeats must be 2..6");
assert.ok(effortNames.length > 0 && effortNames.length * repeats <= 24, "probe exceeds its 24-call budget");
assert.equal(new Set(effortNames).size, effortNames.length, "efforts must be unique");
for (const value of effortNames) {
  assert.ok(reasoning.levels.includes(value as ReasoningEffort), `undeclared reasoning effort: ${value}`);
}

test("live repeated provider stream latency by declared reasoning effort", { timeout: 20 * 60_000 }, async t => {
  const batchId = randomUUID();
  const samples: Array<Record<string, unknown>> = [];
  const persist = () => save(name, {
    batchId, model: baseRoute.model, platformId: baseRoute.platformId, prompt, repeats,
    schedule: samples.map(({ repeat, effort }) => ({ repeat, effort })), samples,
    measurement: "monotonic request-to-response-headers / first byte / first SSE event / first output-text delta / first provider text callback / completion",
  });

  // Counterbalanced order limits warm-cache/order bias without sending concurrent calls.
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const order = repeat % 2 === 0 ? effortNames : [...effortNames].reverse();
    for (const effort of order) {
      const modelProfile = {
        ...baseRoute.modelProfile!,
        reasoning: { ...reasoning, default: effort as ReasoningEffort },
      };
      const route = { ...baseRoute, modelProfile };
      const wire: WireReceipt[] = [];
      const provider = observedProvider(route, `latency-${batchId}`, wire);
      const chunks: string[] = [];
      const started = performance.now();
      let firstDeltaMs: number | null = null;
      let firstNonWhitespaceDeltaMs: number | null = null;
      const sample: Record<string, unknown> = { repeat: repeat + 1, effort, status: "running" };
      samples.push(sample);
      persist();
      try {
        const result = await provider.chatCompletionStream!(
          [
            { role: "system", content: "你是准确、简洁的物理助教。" },
            { role: "user", content: prompt },
          ],
          { responseFormat: "text", maxTokens: 256, temperature: 0.2, disableThinking: false },
          AbortSignal.timeout(120_000),
          delta => {
            const elapsedMs = Math.round(performance.now() - started);
            firstDeltaMs ??= elapsedMs;
            if (delta.trim()) firstNonWhitespaceDeltaMs ??= elapsedMs;
            chunks.push(delta);
          },
        );
        sample.status = "succeeded";
        sample.text = result.content;
        sample.deltaText = chunks.join("");
        sample.firstProviderDeltaMs = firstDeltaMs;
        sample.firstNonWhitespaceDeltaMs = firstNonWhitespaceDeltaMs;
        sample.elapsedMs = Math.round(performance.now() - started);
        sample.textMatchesDeltas = chunks.join("") === result.content;
        sample.usage = result.usage ?? null;
      } catch (error) {
        sample.status = "failed";
        sample.failure = safeFailure(error);
        sample.firstProviderDeltaMs = firstDeltaMs;
        sample.firstNonWhitespaceDeltaMs = firstNonWhitespaceDeltaMs;
        sample.elapsedMs = Math.round(performance.now() - started);
      }
      sample.wire = wire;
      persist();
      t.diagnostic(JSON.stringify({ repeat: repeat + 1, effort, ...sample }));
    }
  }

  assert.ok(samples.some(sample => sample.status === "succeeded"), "all repeated provider calls failed");
});
