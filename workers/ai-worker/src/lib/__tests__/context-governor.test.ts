import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderCapability } from "@ailearn/shared";
import { createGovernedProvider, type WorkspaceAIPolicy } from "../governance.ts";
import { AIContextCompactionRequiredError, AIContextOverflowError, REGISTERED_FALLBACK_CAPABILITY } from "../context-governor.ts";
import { isNonRetryableError } from "../non-retryable-errors.ts";
import type { AIProvider } from "../ai-provider.ts";

const workspaceId = "00000000-0000-0000-0000-000000000001";
const policy: WorkspaceAIPolicy = {
  sendToExternal: true, sendImageContent: true, piiDetection: false, auditLogging: false,
};

const capability = (over: Partial<ProviderCapability> = {}): ProviderCapability => ({
  providerId: "openai_compatible",
  modelId: "test-model",
  visionModelId: "test-model",
  toolMode: "native_tools",
  contextWindowTokens: 1_000_000,
  reservedOutputTokens: 16_384,
  maxInputTokens: 1_000_000 - 16_384,
  maxOutputTokens: 16_384,
  fingerprint: "fp",
  ...over,
});

interface Harness {
  provider: AIProvider;
  sent: { agent: number; chat: number; stream: number };
}

function makeProvider(snapshot: ProviderCapability | null = capability()): Harness {
  const sent = { agent: 0, chat: 0, stream: 0 };
  const provider: AIProvider = {
    id: "openai_compatible",
    modelId: "test-model",
    visionModelId: "test-model",
    promptVersion: "test-v1",
    async chatCompletion() {
      sent.chat += 1;
      return { content: "ok", usage: {} };
    },
    async chatCompletionStream() {
      sent.stream += 1;
      return { content: "ok" };
    },
    async executeAgentTurn() {
      sent.agent += 1;
      return { content: "ok", toolCalls: [], finishReason: "stop", usage: null, providerRequestId: null };
    },
    ...(snapshot ? { getCapabilities: () => snapshot } : {}),
  };
  return { provider, sent };
}

const bigTool = {
  name: "companion_read_note",
  description: "读取笔记正文".repeat(200),
  parameters: { type: "object", properties: { noteId: { type: "string", description: "笔记标识".repeat(50) } } },
};

test("超硬上限时三条调用面都拒绝，并且不重试", async () => {
  for (const surface of ["agent", "chat", "stream"] as const) {
    const { provider, sent } = makeProvider(capability({
      contextWindowTokens: 4_000, maxOutputTokens: 1_000, maxInputTokens: 3_000, reservedOutputTokens: 1_000,
    }));
    const governed = createGovernedProvider(provider, { consentOk: true, policy }, workspaceId);
    const run = surface === "agent"
      ? () => governed.executeAgentTurn!({
        role: "companion_agent", systemPrompt: "短。", messages: [{ role: "user", content: "问题".repeat(4_000) }],
        tools: [], maxTokens: 1_000, temperature: 0.4,
      })
      : surface === "chat"
        ? () => governed.chatCompletion([{ role: "user", content: "问题".repeat(4_000) }], { maxTokens: 1_000 })
        : () => governed.chatCompletionStream!([{ role: "user", content: "问题".repeat(4_000) }], { maxTokens: 1_000 }, undefined, () => {});

    await assert.rejects(run, AIContextOverflowError);
    assert.equal(sent[surface], 0, `${surface} 面不该把超限请求发出去`);
    // 重投只会再撞一次同一条上限。
    assert.equal(isNonRetryableError(new AIContextOverflowError({
      providerId: "p", modelId: "m", operation: "op",
      budget: {} as never, measurement: {} as never, decision: {} as never,
    })), true);
  }
});

test("system 很短但工具 schema 很大时也能触发治理（不是只测 system）", async () => {
  const { provider, sent } = makeProvider(capability({
    contextWindowTokens: 4_000, maxOutputTokens: 500, maxInputTokens: 3_500, reservedOutputTokens: 500,
  }));
  const governed = createGovernedProvider(provider, { consentOk: true, policy }, workspaceId);
  const base = {
    role: "companion_agent" as const, systemPrompt: "短。", messages: [{ role: "user" as const, content: "你好" }],
    maxTokens: 1_000, temperature: 0.4,
  };
  await governed.executeAgentTurn!({ ...base, tools: [] });
  assert.equal(sent.agent, 1);
  await assert.rejects(
    () => governed.executeAgentTurn!({ ...base, tools: [bigTool] }),
    AIContextOverflowError,
  );
  assert.equal(sent.agent, 1);
});

test("超触发线但未超硬上限时按有效上下文继续发送（触发线不是硬拒绝线）", async () => {
  const receipts: { outcome: string; inputTokens: number }[] = [];
  const { provider, sent } = makeProvider(capability({
    contextWindowTokens: 20_000, maxOutputTokens: 1_000, maxInputTokens: 19_000, reservedOutputTokens: 1_000,
  }));
  const governed = createGovernedProvider(provider, { consentOk: true, policy }, workspaceId, undefined, {
    onDecision: (receipt) => receipts.push({ outcome: receipt.decision.outcome, inputTokens: receipt.measurement.inputTokens }),
  });
  await governed.chatCompletion([{ role: "user", content: "问题".repeat(7_000) }], { maxTokens: 1_000 });
  assert.equal(sent.chat, 1);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.outcome, "send");
  assert.ok(receipts[0]!.inputTokens > 0);
});

test("压缩端口可用且超触发线时要求先做一次有界压缩，而不是判失败", async () => {
  const outcomes: string[] = [];
  const { provider, sent } = makeProvider(capability({
    contextWindowTokens: 20_000, maxOutputTokens: 1_000, maxInputTokens: 19_000, reservedOutputTokens: 1_000,
  }));
  const governed = createGovernedProvider(provider, { consentOk: true, policy }, workspaceId, undefined, {
    compactionAvailable: () => true,
    onDecision: (receipt) => outcomes.push(receipt.decision.outcome),
  });
  // 压缩要求由工作上下文所有者接手：捕获 → 有界压缩 → 重新装配 → 重发。
  // 本层不代劳，也不把它混进「装不下」的终态。
  await assert.rejects(
    () => governed.chatCompletion([{ role: "user", content: "问题".repeat(7_000) }], { maxTokens: 1_000 }),
    AIContextCompactionRequiredError,
  );
  assert.deepEqual(outcomes, ["compact"]);
  assert.equal(sent.chat, 0);
});

test("provider 不声明能力时退回登记的保守能力，而不是把调用打死", async () => {
  const { provider, sent } = makeProvider(null);
  const governed = createGovernedProvider(provider, { consentOk: true, policy }, workspaceId);
  await governed.chatCompletion([{ role: "user", content: "你好" }], {});
  assert.equal(sent.chat, 1);
  // 能力形状不完整（只有 providerId）同样退回登记值。
  const partial = makeProvider({ providerId: "openai_compatible" } as unknown as ProviderCapability);
  const governedPartial = createGovernedProvider(partial.provider, { consentOk: true, policy }, workspaceId);
  await governedPartial.chatCompletion([{ role: "user", content: "你好" }], {});
  assert.equal(partial.sent.chat, 1);
  assert.ok(REGISTERED_FALLBACK_CAPABILITY.contextWindowTokens > 0);
});

test("请求声明的输出上限未被下发时，预算改用保守输出预留", async () => {
  const budgets: { outputReservationTokens: number; hardInputTokens: number }[] = [];
  const { provider } = makeProvider(capability({ outputLimitEnforced: false }));
  const governed = createGovernedProvider(provider, { consentOk: true, policy }, workspaceId, undefined, {
    onDecision: (receipt) => budgets.push({
      outputReservationTokens: receipt.budget.outputReservationTokens,
      hardInputTokens: receipt.budget.hardInputTokens,
    }),
  });
  await governed.chatCompletion([{ role: "user", content: "你好" }], { maxTokens: 1_000 });
  assert.equal(budgets[0]!.outputReservationTokens, 16_384);
  assert.equal(budgets[0]!.hardInputTokens, 1_000_000 - 16_384 - 2_048);
});

test("多模态图片按保守地板计量，不被记成零成本", async () => {
  const measured: number[] = [];
  const { provider } = makeProvider();
  const governed = createGovernedProvider(provider, { consentOk: true, policy }, workspaceId, undefined, {
    onDecision: (receipt) => measured.push(receipt.measurement.inputTokens),
  });
  await governed.chatCompletion([{ role: "user", content: "看看这张图" }], {});
  await governed.chatCompletion([{ role: "user", content: [
    { type: "text", text: "看看这张图" },
    { type: "image_url", image_url: { url: "https://example.test/a.png" } },
  ] }], {});
  assert.equal(measured.length, 2);
  assert.ok(measured[1]! > measured[0]!);
});

test("治理门先于上下文闸：同意缺失时不会因为预算检查而放行", async () => {
  const { provider, sent } = makeProvider(capability({
    contextWindowTokens: 4_000, maxOutputTokens: 1_000, maxInputTokens: 3_000, reservedOutputTokens: 1_000,
  }));
  const governed = createGovernedProvider(provider, { consentOk: false, policy }, workspaceId);
  await assert.rejects(
    () => governed.chatCompletion([{ role: "user", content: "问题".repeat(4_000) }], { maxTokens: 1_000 }),
    (error: unknown) => error instanceof AIContextOverflowError === false,
  );
  assert.equal(sent.chat, 0);
});
