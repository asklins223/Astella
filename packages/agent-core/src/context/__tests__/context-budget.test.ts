import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveContextBudget, evaluateContextPressure, AgentContextBudgetError,
  CONTEXT_TRIGGER_RATIO, CONTEXT_TARGET_RATIO, CONTEXT_OVERHEAD_TOKENS,
  CONSERVATIVE_DEFAULT_OUTPUT_TOKENS, REGISTERED_FALLBACK_CONTEXT_WINDOW_TOKENS,
} from "../context-budget.ts";
import type { ProviderCapability } from "@astella/shared";

const capability = (over: Partial<ProviderCapability> = {}): ProviderCapability => ({
  providerId: "openai_compatible",
  modelId: "qwen3.8-flash",
  visionModelId: "qwen3.8-flash",
  toolMode: "native_tools",
  contextWindowTokens: 1_000_000,
  reservedOutputTokens: 131_072,
  maxInputTokens: 1_000_000 - 131_072,
  maxOutputTokens: 131_072,
  fingerprint: "fp",
  ...over,
});

test("预算口径：80% 只作用于触发线，不先对硬上限乘一次 0.8", () => {
  const budget = resolveContextBudget({
    capability: capability(), requestedOutputTokens: 2_000, outputLimitEnforced: true,
  });
  const expectedHard = 1_000_000 - 2_000 - CONTEXT_OVERHEAD_TOKENS;
  assert.equal(budget.hardInputTokens, expectedHard);
  assert.equal(budget.triggerTokens, Math.floor(expectedHard * CONTEXT_TRIGGER_RATIO));
  assert.equal(budget.targetTokens, Math.floor(expectedHard * CONTEXT_TARGET_RATIO));
  // 「先乘 0.8 再乘 0.8」的错误口径会得到 hard*0.64；这里必须等于 hard*0.8。
  assert.equal(budget.triggerTokens, Math.floor(expectedHard * 0.8));
  assert.notEqual(budget.triggerTokens, Math.floor(expectedHard * 0.64));
});

test("请求声明的输出上限被 provider 忽略时，不能拿它假定输出很小", () => {
  const forced = resolveContextBudget({
    capability: capability(), requestedOutputTokens: 2_000, outputLimitEnforced: true,
  });
  const ignored = resolveContextBudget({
    capability: capability(), requestedOutputTokens: 2_000, outputLimitEnforced: false,
  });
  assert.equal(forced.outputReservationTokens, 2_000);
  assert.equal(ignored.outputReservationTokens, 131_072);
  assert.ok(ignored.hardInputTokens < forced.hardInputTokens);
  assert.ok(ignored.provenance.some(entry => entry.field === "O"
    && entry.source === "conservative_default_output_not_enforced"));
});

test("请求未声明输出上限且平台也没声明时，退回登记的保守输出预留", () => {
  const budget = resolveContextBudget({
    registeredCapability: { contextWindowTokens: 128_000, reservedOutputTokens: 4_096, maxOutputTokens: 4_096 },
  });
  assert.equal(budget.confidence, "registered_default");
  assert.equal(budget.outputReservationTokens, 4_096);
  const unknown = resolveContextBudget({ capability: capability({ maxOutputTokens: undefined as never }) });
  assert.equal(unknown.outputReservationTokens, CONSERVATIVE_DEFAULT_OUTPUT_TOKENS);
});

test("派生输入上限不会与「窗口 − 输出」重复扣减", () => {
  const budget = resolveContextBudget({
    capability: capability(), requestedOutputTokens: 2_000, outputLimitEnforced: true,
  });
  // maxInputTokens = C − maxOutput（派生）由 C − O 单独表达，不取 min 也不额外扣。
  assert.equal(budget.providerInputLimitTokens, null);
  assert.equal(budget.inputLimitSource, "none");
  assert.equal(budget.hardInputTokens, 1_000_000 - 2_000 - CONTEXT_OVERHEAD_TOKENS);
  assert.ok(budget.hardInputTokens > 1_000_000 - 131_072 - CONTEXT_OVERHEAD_TOKENS);
});

test("供应商独立的输入硬上限会真正收紧硬上限", () => {
  const budget = resolveContextBudget({
    capability: capability({ inputHardLimitTokens: 300_000 }),
    requestedOutputTokens: 2_000,
    outputLimitEnforced: true,
  });
  assert.equal(budget.inputLimitSource, "independent");
  assert.equal(budget.hardInputTokens, 300_000 - CONTEXT_OVERHEAD_TOKENS);
});

test("能力不可获知且没有登记兜底时如实失败，不沿用与本路由无关的护栏", () => {
  assert.throws(
    () => resolveContextBudget({}),
    (error: unknown) => error instanceof AgentContextBudgetError && error.code === "budget_unresolved",
  );
  const fallback = resolveContextBudget({
    registeredCapability: {
      contextWindowTokens: REGISTERED_FALLBACK_CONTEXT_WINDOW_TOKENS,
      reservedOutputTokens: 4_096,
      maxOutputTokens: 4_096,
    },
  });
  assert.equal(fallback.contextWindowTokens, REGISTERED_FALLBACK_CONTEXT_WINDOW_TOKENS);
  assert.ok(fallback.provenance.some(entry => entry.source === "registered_default"));
});

test("比例越界与非法余量被拒", () => {
  assert.throws(() => resolveContextBudget({ capability: capability(), triggerRatio: 1.5 }),
    (error: unknown) => error instanceof AgentContextBudgetError && error.code === "invalid_budget_input");
  assert.throws(() => resolveContextBudget({ capability: capability(), overheadTokens: -1 }),
    (error: unknown) => error instanceof AgentContextBudgetError && error.code === "invalid_budget_input");
});

test("压力判定：触发线内直接发送；超线且有压缩端口时先压缩不发送", () => {
  const budget = resolveContextBudget({
    capability: capability({ contextWindowTokens: 10_000, maxOutputTokens: 1_000, maxInputTokens: 9_000, reservedOutputTokens: 1_000 }),
    requestedOutputTokens: 1_000, outputLimitEnforced: true, overheadTokens: 0,
  });
  assert.equal(budget.hardInputTokens, 9_000);
  assert.equal(budget.triggerTokens, 7_200);
  assert.equal(evaluateContextPressure({ budget, inputTokens: 7_200 }).outcome, "send");
  const compact = evaluateContextPressure({ budget, inputTokens: 8_000, compactionAvailable: true });
  assert.equal(compact.outcome, "compact");
  assert.equal(compact.reason, "over_trigger_line");
});

test("压缩额度用尽时带着有效上下文继续，不把触发线当硬拒绝线", () => {
  const budget = resolveContextBudget({
    capability: capability({ contextWindowTokens: 10_000, maxOutputTokens: 1_000, maxInputTokens: 9_000, reservedOutputTokens: 1_000 }),
    requestedOutputTokens: 1_000, outputLimitEnforced: true, overheadTokens: 0,
  });
  const spent = evaluateContextPressure({ budget, inputTokens: 8_000, compactionAvailable: false });
  assert.equal(spent.outcome, "send");
  assert.equal(spent.reason, "compaction_budget_spent");
  const noPort = evaluateContextPressure({ budget, inputTokens: 8_000 });
  assert.equal(noPort.outcome, "send");
  assert.equal(noPort.reason, "over_trigger_line");
});

test("必要内容自身超限时先报 required_content_overflows，不先试注定失败的压缩", () => {
  const budget = resolveContextBudget({
    capability: capability({ contextWindowTokens: 10_000, maxOutputTokens: 1_000, maxInputTokens: 9_000, reservedOutputTokens: 1_000 }),
    requestedOutputTokens: 1_000, outputLimitEnforced: true, overheadTokens: 0,
  });
  const decision = evaluateContextPressure({
    budget, inputTokens: 12_000, compactionAvailable: true, requiredContentOverflows: true,
  });
  assert.equal(decision.outcome, "reject");
  assert.equal(decision.reason, "required_content_overflows");
  assert.match(decision.detail ?? "", /分段|缩小/);
});

test("超硬上限且压缩装不下时拒绝，并给出可行动的真实限制", () => {
  const budget = resolveContextBudget({
    capability: capability({ contextWindowTokens: 10_000, maxOutputTokens: 1_000, maxInputTokens: 9_000, reservedOutputTokens: 1_000 }),
    requestedOutputTokens: 1_000, outputLimitEnforced: true, overheadTokens: 0,
  });
  const decision = evaluateContextPressure({ budget, inputTokens: 9_500, compactionAvailable: false });
  assert.equal(decision.outcome, "reject");
  assert.equal(decision.reason, "over_hard_limit");
  assert.match(decision.detail ?? "", /9000/);
});

test("超硬上限但有摘要压缩路径时先压缩，耗尽后仍超限才拒绝", () => {
  const budget = resolveContextBudget({ capability: capability(), requestedOutputTokens: 1000 });
  const inputTokens = budget.hardInputTokens + 10000;
  assert.equal(evaluateContextPressure({ budget, inputTokens, compactionAvailable: true }).outcome, "compact");
  assert.equal(evaluateContextPressure({ budget, inputTokens, compactionAvailable: false }).outcome, "reject");
});
