import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentContextReceipt } from "@astella/agent-core";
import {
  createCompanionContextReceipts,
  COMPANION_CONTEXT_SYSTEM_MAX_CHARACTERS,
} from "../companion-context-receipts.ts";

const receipt = (id: string, status: AgentContextReceipt["status"], characters = 10): AgentContextReceipt => ({
  id, authority: "data", characters, status,
});

test("44 §3.3：装配回执随预算一起落库，budget_omitted 不再只进日志", () => {
  const receipts = createCompanionContextReceipts();
  receipts.recordAssembly([
    receipt("resident_memory", "included", 120),
    receipt("memory_directory", "included", 80),
    receipt("page_context", "budget_omitted", 400),
  ]);
  const patch = receipts.runMetaPatch();
  assert.ok(patch.contextAssemblyReceipt);
  assert.equal(patch.contextAssemblyReceipt.maxCharacters, COMPANION_CONTEXT_SYSTEM_MAX_CHARACTERS);
  assert.equal(patch.contextAssemblyReceipt.omittedCount, 1);
  assert.deepEqual(patch.contextAssemblyReceipt.omitted.map((entry) => entry.id), ["page_context"]);
  assert.deepEqual([...receipts.admittedSources()].sort(), ["memory_directory", "resident_memory"]);
});

test("44 §3.3：重新装配会替换上一次的回执与准入集合，不累积", () => {
  const receipts = createCompanionContextReceipts();
  receipts.recordAssembly([receipt("a", "included"), receipt("b", "included")]);
  receipts.recordAssembly([receipt("c", "included")]);
  assert.deepEqual([...receipts.admittedSources()], ["c"]);
  assert.deepEqual(receipts.runMetaPatch().contextAssemblyReceipt?.included.map((entry) => entry.id), ["c"]);
});

test("44 §4：压力闸回执在真正发生判定后才进 run meta", () => {
  const receipts = createCompanionContextReceipts();
  // 还没发过任何请求：两列都不该被写出来（空壳行只会让人以为「判过但没问题」）。
  assert.deepEqual(receipts.runMetaPatch(), {});

  const measured: Parameters<NonNullable<typeof receipts.pressureGate.onDecision>>[0] = {
    providerId: "openai_compatible",
    modelId: "qwen3.8-flash",
    operation: "companion_agent",
    budget: {
      version: 1,
      contextWindowTokens: 1_000_000,
      outputReservationTokens: 4_096,
      providerInputLimitTokens: null,
      inputLimitSource: "none",
      overheadTokens: 2_048,
      hardInputTokens: 993_856,
      triggerTokens: 795_084,
      targetTokens: 596_313,
      triggerRatio: 0.8,
      targetRatio: 0.6,
      confidence: "declared",
      provenance: [{ field: "C", source: "provider_capability" }],
    },
    measurement: {
      version: 1,
      inputTokens: 12_345,
      method: "heuristic",
      parts: { system: 8_000, messages: 3_000, tools: 1_000, multimodal: 0 },
      unmeasured: [],
      errorMarginTokens: 512,
      measurementVersion: "v1",
    },
    decision: {
      version: 1,
      outcome: "send",
      reason: "within_budget",
      inputTokens: 12_345,
      hardInputTokens: 993_856,
      triggerTokens: 795_084,
      targetTokens: 596_313,
      detail: null,
    },
  };
  receipts.pressureGate.onDecision!(measured);

  const patch = receipts.runMetaPatch();
  assert.ok(patch.contextPressure);
  assert.equal(patch.contextPressure.modelId, "qwen3.8-flash");
  assert.equal(patch.contextPressure.hardInputTokens, 993_856);
  assert.equal(patch.contextPressure.outcome, "send");
  // 只有装配回执、没有判定时，判定那列不出现。
  assert.equal(patch.contextAssemblyReceipt, undefined);

  // A delayed classifier must not overwrite the answer's already measured request.
  receipts.pressureGate.onDecision!({
    ...measured,modelId:"classifier",operation:"companion_agent:chat_completion",
  });
  assert.equal(receipts.runMetaPatch().contextPressure?.modelId, "qwen3.8-flash");
});

test("落库的那一份不含任何请求内容", () => {
  const receipts = createCompanionContextReceipts();
  receipts.recordAssembly([receipt("here_and_now", "included", 12)]);
  assert.equal(JSON.stringify(receipts.runMetaPatch()).includes("今天聊"), false);
});
