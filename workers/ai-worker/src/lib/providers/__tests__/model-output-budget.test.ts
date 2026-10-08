import assert from "node:assert/strict";
import { test } from "node:test";
import { modelOutputTokenLimit } from "../model-output-budget.ts";
import { OpenCodeGoProvider } from "../opencode-go.ts";
import { createGovernedProvider } from "../../governance.ts";
import type { ContextGateReceipt } from "../../context-governor.ts";

test("small content targets cannot take the reasoning allowance away", () => {
  for (const requested of [500, 2000, 8000, 24000, undefined]) {
    assert.equal(modelOutputTokenLimit({ maxOutputTokens: 384000 }, requested, 16384), 384000);
  }
  assert.equal(modelOutputTokenLimit(undefined, 24000, 16384), 16384);
  for (const invalid of [0, -1, NaN, Infinity]) {
    assert.equal(modelOutputTokenLimit({ maxOutputTokens: 384000 }, invalid, 16384), undefined);
  }
});

test("governance reserves the same output budget that the provider actually sends", async () => {
  let body: Record<string, unknown> | undefined;
  let receipt: ContextGateReceipt | undefined;
  const raw = new OpenCodeGoProvider({ apiKey: "synthetic", baseUrl: "https://opencode.ai/zen/go/v1", model: "budget-test",
    modelProfile: { contextWindowTokens: 1000000, maxOutputTokens: 384000,
      reasoning: { levels: ["none", "high"], default: "high" } },
    request: async (_url, _headers, payload) => {
      body = payload as Record<string, unknown>;
      return { status: 200, statusText: "OK", body: { status: "completed", output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "{}" }] },
      ] } };
    },
  });
  const provider = createGovernedProvider(raw, { consentOk: true, policy: {
    sendToExternal: true, sendImageContent: true, piiDetection: false, auditLogging: false,
  } }, "00000000-0000-4000-8000-000000000001", undefined, { onDecision: value => { receipt = value; } });
  await provider.chatCompletion([{ role: "user", content: "Return JSON." }], { maxTokens: 2000, responseFormat: "json_object" });
  assert.equal(body?.max_output_tokens, 384000);
  assert.equal(receipt?.budget.outputReservationTokens, 384000);
  assert.deepEqual(body?.reasoning, { effort: "high" });
  assert.equal(provider.resolveOutputTokenLimit?.(2000), 384000);
});
