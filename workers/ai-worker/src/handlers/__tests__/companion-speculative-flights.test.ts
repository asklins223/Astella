/**
 * 投机两条飞地的出发条件与二选一（2026-10-13 从运行时搬到这里，测试跟着判据走）。
 *
 * 这里锁的是**编排**：谁有资格出发、留在哪一版、都不合时一律不留。
 * 请求形状本身（温度/工具面/指引是否与真实第一步同形）由
 * `companion-speculative-first-step.test.ts` 管，作废不漏字由
 * `companion-agent-runtime.test.ts` 与那条集成用例管。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentTurnInterpretationV1 } from "@astella/shared/agent-contracts";
import type { AIProvider } from "../../lib/ai-provider.ts";
import { startCompanionSpeculativeFirstSteps } from "../companion-speculative-flights.ts";

const interpretation = (overrides: Record<string, unknown>): AgentTurnInterpretationV1 => ({
  intent: "conversation", toolUse: "none", subjects: [], ambiguities: [], candidateOperations: [],
  goalRelation: "unrelated", voiceStyle: { decision: "none", instruction: null }, pendingOfferIndexes: [],
  ...overrides,
}) as unknown as AgentTurnInterpretationV1;

const TOOLS = [
  { name: "companion_search_notes", description: "检索笔记", parameters: { type: "object" } },
  { name: "agent_web_search", description: "联网搜索", parameters: { type: "object" } },
];

/** 记下发出去的每一步形状，并把正文一次说完的 provider。 */
function recordingProvider(options: { streamToolCalls?: boolean } = {}) {
  const sent: { disableThinking: boolean | undefined, tools: string[] }[] = [];
  const provider = {
    id: "stub", modelId: "stub-model", visionModelId: "stub-model", promptVersion: "test",
    chatCompletion: async () => { throw new Error("not used"); },
    executeAgentTurn: async () => { throw new Error("not used"); },
    ...(options.streamToolCalls ? { chatCompletionStreamToolCalls: true } : {}),
    chatCompletionStream: async (
      _messages: unknown, options2: { nativeAgentRequest?: { disableThinking?: boolean, tools: { name: string }[] } },
      _signal: AbortSignal | undefined, onDelta: (text: string) => void,
    ) => {
      const request = options2.nativeAgentRequest!;
      sent.push({ disableThinking: request.disableThinking, tools: request.tools.map(tool => tool.name) });
      onDelta("这一版的第一步已经把话说完了。");
      return { content: "这一版的第一步已经把话说完了。", toolCalls: [], finishReason: "stop" };
    },
  } as unknown as AIProvider;
  return { provider, sent };
}

const start = (args: Parameters<typeof startCompanionSpeculativeFirstSteps>[0]) =>
  startCompanionSpeculativeFirstSteps(args);

function baseArgs(provider: AIProvider, attention: AgentTurnInterpretationV1) {
  return {
    provider,
    ctxSignal: new AbortController().signal,
    onProviderDelta: async () => true,
    attention: Promise.resolve(attention),
    cachedInterpretation: null,
    turnPolicy: "本轮的执行说明。",
    permissionLevel: "guided",
    stepBudget: 20,
    messages: [{ role: "user" as const, content: "为什么傍晚的天是红的？" }],
    deadlineAt: Date.now() + 60_000,
    availableTools: TOOLS,
    webSearchAllowed: true,
    toolCallCount: 0,
  };
}

test("没有可留的版本时两条都不出发：已有权威解释、或这一轮不能流式", async () => {
  for (const variant of [
    { cachedInterpretation: interpretation({}) },
    { onProviderDelta: undefined },
  ] as const) {
    const { provider, sent } = recordingProvider({ streamToolCalls: true });
    const flights = start({ ...baseArgs(provider, interpretation({})), ...variant } as never);
    assert.deepEqual(sent, [], `${JSON.stringify(Object.keys(variant))} 这一支不该出发`);
    assert.equal(await flights.settle({
      attention: interpretation({ intent: "conversation" }), runId: "r1",
      deadlineAt: Date.now() + 60_000, handlerStartedAtMs: Date.now(),
    }), null);
  }
});

test("提问版还要 provider 声明流式解析工具、本轮零工具回执，闲聊版不受这两条限制", async () => {
  const withoutFlag = recordingProvider();
  start(baseArgs(withoutFlag.provider, interpretation({})));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(withoutFlag.sent.length, 1, "只发闲聊版那一条");
  assert.equal(withoutFlag.sent[0]!.disableThinking, true);

  const withFlag = recordingProvider({ streamToolCalls: true });
  start({ ...baseArgs(withFlag.provider, interpretation({})), toolCallCount: 2 });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(withFlag.sent.length, 1, "续跑的第一步工具面不同，提问版不出发");
});

test("解释留下提问版时返回的是那条请求，工具面按这一轮能不能搜索现算", async () => {
  const allowed = recordingProvider({ streamToolCalls: true });
  const flights = start(baseArgs(allowed.provider, interpretation({ intent: "question" })));
  const kept = await flights.settle({
    attention: interpretation({ intent: "question" }), runId: "r1",
    deadlineAt: Date.now() + 60_000, handlerStartedAtMs: Date.now(),
  });
  assert.ok(kept);
  assert.equal(kept.result.content, "这一版的第一步已经把话说完了。");
  assert.equal(allowed.sent.some(step => step.disableThinking === false && step.tools.includes("agent_web_search")), true);

  const blocked = recordingProvider({ streamToolCalls: true });
  const blockedFlights = start({ ...baseArgs(blocked.provider, interpretation({ intent: "question" })), webSearchAllowed: false });
  const blockedKept = await blockedFlights.settle({
    attention: interpretation({ intent: "question" }), runId: "r1",
    deadlineAt: Date.now() + 60_000, handlerStartedAtMs: Date.now(),
  });
  assert.ok(blockedKept);
  assert.equal(blocked.sent.filter(step => step.disableThinking === false)[0]!.tools.includes("agent_web_search"), false);
});

test("解释带来指称或歧义时两版都不留，正式第一步照原路径重打", async () => {
  const { provider, sent } = recordingProvider({ streamToolCalls: true });
  const flights = start(baseArgs(provider, interpretation({})));
  const settled = await flights.settle({
    attention: interpretation({ intent: "question", subjects: [{ description: "那篇笔记", objectIndex: 0 }] }),
    runId: "r1", deadlineAt: Date.now() + 60_000, handlerStartedAtMs: Date.now(),
  });
  assert.equal(settled, null);
  assert.equal(sent.length, 2, "两条都发过、也都没留下");
});
