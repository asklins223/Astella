import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveCompanionTurnProviders } from "../companion-turn-providers.ts";
import { AIContextCompactionRequiredError } from "../../lib/context-governor.ts";
import type { AIGovernanceContext } from "../../lib/governance.ts";
import { registerFactory } from "../../lib/provider-factory.ts";
import { MockProvider } from "../../lib/providers/mock.ts";

test("主链与兜底工厂都拿到真实对话身份，同会话跨轮保持稳定", () => {
  const sessions: Array<string | undefined> = [];
  registerFactory("mock", "agent_turn", config => {
    sessions.push(config.sessionId);
    return new MockProvider();
  });
  try {
    for (const conversationId of ["conversation-one","conversation-one","conversation-two"]) {
      resolveCompanionTurnProviders({governance:governance({companionFallbackProviderName:"mock",
        companionFallbackProviderConfig:{}}), ctx, read:{...read,conversationId},
        contextGate:{compactionAvailable:()=>false},reserveCall:async()=>{}});
    }
    assert.deepEqual(sessions, ["conversation-one","conversation-one","conversation-one",
      "conversation-one","conversation-two","conversation-two"]);
  } finally {
    registerFactory("mock", "agent_turn", () => new MockProvider());
  }
});

/**
 * 方案 44 §4.3：两个 provider 槽都必须经过 `createGovernedProvider`——
 * 上下文预算闸、同意、外发政策、PII 与审计都挂在那个边界上。
 *
 * 用 mock provider 走真实工厂：这里要验的是「闸装没装上」，不是「模型答得好不好」。
 */

const policy = {
  sendToExternal: true, sendImageContent: true, piiDetection: false, auditLogging: false,
} as const;

const governance = (over: Partial<AIGovernanceContext> = {}): AIGovernanceContext => ({
  providerName: "mock",
  providerConfig: {},
  textProviderName: null, textProviderConfig: null,
  visionProviderName: null, visionProviderConfig: null,
  companionFallbackProviderName: null, companionFallbackProviderConfig: null,
  embeddingProviderName: null, embeddingProviderConfig: null,
  consentOk: true,
  policy: { ...policy },
  ...over,
});

const ctx = { workspaceId: "00000000-0000-0000-0000-000000000001", id: "job-1",
  requestedBy:"00000000-0000-0000-0000-000000000002",payload:{},leaseToken:"test",signal:new AbortController().signal };
const read = { userId: "00000000-0000-0000-0000-000000000002", runId:"run-1",conversationId:"conversation-1",
  userMessageId:"message-1",generation:1,accountEpoch:0,runStatus:"running",formalAnswerInProgress:false,
  formalAnswerTarget:null,livePageView:null,pageContext:null,groundedTutorContext:null,userText:"你好",
  recentMessages:[],residentMemories:[],memoryDirectory:[],playbookCatalog:[],organizationSurface:null,
  memoryRefs:[],hereAndNow:null,thisTurnFacts:null,factSpans:null,conversationSummary:null,
  personaProfileRevision:0,personaExamplesRevision:0,defaultExpressionVersion:"test",petProfile:null,
  nextMessageSeq:1,nextEventSeq:1 };

test("44 §4.3：主 provider 挂着上下文闸——超触发线时要求先压", async () => {
  const seen: string[] = [];
  const { provider } = resolveCompanionTurnProviders({
    governance: governance(),
    ctx, read,
    contextGate: {
      compactionAvailable: () => true,
      onDecision: (receipt) => { seen.push(receipt.decision.outcome); },
    },
    reserveCall: async () => {},
  });
  assert.ok(provider.executeAgentTurn);
  // mock 的窗口默认 128k，用一条短请求走通判定路径即可——这里验的是闸被调用了。
  await provider.executeAgentTurn({
    role: "companion_agent", systemPrompt: "短。", messages: [{ role: "user", content: "你好" }],
    tools: [], maxTokens: 1_000, temperature: 0.4,
  });
  assert.deepEqual(seen, ["send"]);
});

test("44 §4.3：两个槽都是治理包装过的（都实现了闸所依赖的 executeAgentTurn）", () => {
  const resolved = resolveCompanionTurnProviders({
    governance: governance({
      companionFallbackProviderName: "mock",
      companionFallbackProviderConfig: {},
    }),
    ctx, read,
    contextGate: { compactionAvailable: () => false },
    reserveCall: async () => {},
  });
  assert.ok(resolved.provider.getCapabilities, "能力快照要能穿透包装器（读私有 provider 配置）");
  assert.ok(resolved.fallbackProvider?.executeAgentTurn, "配了兜底槽就必须真的建出来");
  assert.equal(resolved.textProvider.providerName, "mock");
});

test("44 §4.3：没配兜底槽时是 undefined，不回落成主 provider", () => {
  const resolved = resolveCompanionTurnProviders({
    governance: governance(),
    ctx, read,
    contextGate: { compactionAvailable: () => false },
    reserveCall: async () => {},
  });
  assert.equal(resolved.fallbackProvider, undefined);
});

test("闸把这次请求判成必须压缩时，主 provider 抛的是压缩要求而不是别的错", async () => {
  // mock 的窗口默认 128k，这里真的把它压到 20k——走的是 provider 自己读能力快照的
  // 真实路径，而不是在断言里手算一个阈值。20k 减去输出预留与开销余量后，硬上限仍在
  // 触发线之上，于是这条超长请求落到「需要压缩」而不是「根本装不下」。
  const previous = process.env.MOCK_CONTEXT_WINDOW_TOKENS;
  process.env.MOCK_CONTEXT_WINDOW_TOKENS = "20000";
  try {
  const { provider } = resolveCompanionTurnProviders({
    governance: governance(),
    ctx, read,
    contextGate: { compactionAvailable: () => true },
    reserveCall: async () => {},
  });
  await assert.rejects(
    () => provider.executeAgentTurn!({
      role: "companion_agent", systemPrompt: "旧".repeat(20), messages: [{ role: "user", content: "问题".repeat(2_200) }],
      tools: [], maxTokens: 1_000, temperature: 0.4,
    }).catch((error: unknown) => {
      if (error instanceof AIContextCompactionRequiredError) throw error;
      throw new Error("expected compaction-required");
    }),
    AIContextCompactionRequiredError,
  );
  } finally {
    if (previous === undefined) delete process.env.MOCK_CONTEXT_WINDOW_TOKENS;
    else process.env.MOCK_CONTEXT_WINDOW_TOKENS = previous;
  }
});
