import assert from "node:assert/strict";
import { test } from "node:test";
import { modelOutputTokenLimit } from "../model-output-budget.ts";
import { OpenCodeGoProvider } from "../opencode-go.ts";
import { createGovernedProvider } from "../../governance.ts";
import type { ContextGateReceipt } from "../../context-governor.ts";

test("the wire ceiling comes from the profile, never from a per-task number", () => {
  // 声明了就用声明值：任务侧报 500 还是 24000 都不该把推理与正文的额度挤小。
  assert.equal(modelOutputTokenLimit({ maxOutputTokens: 384000 }, 16384), 384000);
  // 没声明时用这一档平台的兜底（openai_compatible 是 shared 的那一个实测值）。
  assert.equal(modelOutputTokenLimit(undefined, 16384), 16384);
  // 档案里挂着的坏值不算声明，同样落回兜底——字段合法性由配置那一层管。
  for (const invalid of [0, -1, NaN, Infinity]) {
    assert.equal(modelOutputTokenLimit({ maxOutputTokens: invalid }, 16384), 16384);
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
  assert.equal(provider.resolveOutputTokenLimit?.(), 384000);
});
