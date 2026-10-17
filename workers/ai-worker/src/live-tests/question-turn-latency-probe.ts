/**
 * 问题轮首字延迟探针（2026-10-13）。
 *
 * 背景：桌面真实问题轮的真账是「分类器 ~2.5s → 主步隐藏 ~20s → 正文 0.3s 流完」，
 * 而同一模型的直连小请求首字只要 1.5–2.5s，13K 输入的生产前缀实测也只花 ~2s
 * （`prefix-cache-probe` 的 E/F 组，缓存命中 15%→98.7% 对耗时几乎无影响）。
 * 所以要回答的是：主步隐藏的那 20s 是什么——思考长度、工具面、还是上下文体量。
 *
 * 本探针只用合成素材，复刻生产装配形状：
 *   systemPrompt = composeAgentContext(turn / execution / attention)（与 runtime 同步）
 *   历史 = buildCompanionPersonaMessages 出品的原生多轮（去掉 system）
 *   工具面 = resolveAllCompanionAgentTools("full", …)
 * 变体之间只改一个因素（工具面 / 上下文 / 思考档），逐次记录
 * 响应头、首个 SSE 事件、首个文本增量、首个 final 阶段增量与 reasoning token 数。
 *
 * 运行（从 workers/ai-worker）：
 *   REAL_MODEL_BATCH=1 LIVE_QTL_NAME=<unique-name> node --import tsx src/live-tests/question-turn-latency-probe.ts
 * 矩阵由 LIVE_QTL_REPEATS（默认 3）与 LIVE_QTL_EFFORTS（默认 high,medium,low,none）控制。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import process from "node:process";
import { AgentRole, type AgentTurnRequest } from "@astella/shared";
import type { ReasoningEffort } from "@astella/shared/platform-config";
import { resolveAllCompanionAgentTools } from "@astella/shared/companion-agent-registry";
import { collectAgentCapabilitySceneGuidance } from "@astella/shared/agent-capability-catalog";
import { composeAgentContext } from "@astella/agent-core";
import type { ChatMessage } from "@astella/shared";
import { buildAgentTurnMessages } from "../lib/providers/json-response.ts";
import { observedProvider, platform, safeFailure, save, type WireReceipt } from "./acceptance-common.ts";
import { buildCompanionPersonaMessages } from "../handlers/turn/companion-dialogue-content.ts";
import { companionStepRuntimePolicy } from "../handlers/turn/companion-step-plan.ts";
import { companionResponseStrategy } from "../handlers/turn/companion-response-strategy.ts";
import { companionContextAssemblyCapacity } from "../handlers/context/companion-context-receipts.ts";

const name = process.env.LIVE_QTL_NAME;
if (!name || !/^[a-z0-9-]{1,72}$/.test(name)) throw new Error("Explicit unique LIVE_QTL_NAME required");
const repeats = Number(process.env.LIVE_QTL_REPEATS ?? "3");
const effortNames = (process.env.LIVE_QTL_EFFORTS ?? "high,medium,low,none").split(",").map(v => v.trim());
assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 4, "repeats must be 1..4");
assert.ok(effortNames.length * repeats + 3 <= 20, "probe exceeds its 20-call budget");
const baseRoute = platform("agent_turn");
const declaredReasoning = baseRoute.modelProfile?.reasoning;
assert.ok(declaredReasoning, "agent_turn model must declare reasoning levels");
for (const value of effortNames) {
  assert.ok(declaredReasoning.levels.includes(value as ReasoningEffort), `undeclared reasoning effort: ${value}`);
}

/** 与审计同一组问题：一句话题面。第 3 题是桌面实测 23.4s 首字的那一题。 */
const QUESTIONS = [
  "请用一句话解释为什么白天的天空呈蓝色，并提到瑞利散射。",
  "请用两句话说明冰块为什么能浮在水面上。",
  "请用一句话解释月亮为什么有时白天也能看见。",
] as const;
const question = QUESTIONS[2];

const SYNTHETIC_HISTORY = Array.from({ length: 8 }, (_, i) => ({
  role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
  text: `合成历史第 ${i + 1} 句：她在讲复习与笔记，内容逐轮不变，用来把时间线撑到真实长度。`,
  createdAt: new Date(Date.parse("2026-10-13T02:00:00.000Z") - (8 - i) * 90_000).toISOString(),
  ...(i % 2 === 0 ? { replyStatus: "succeeded" } : {}),
}));

/** 生产形状的 turn 层：真实装配器 + 合成账号资料（与 prefix-cache-probe E 组同源）。 */
function personaTurn(): { turnPolicy: string; history: AgentTurnRequest["messages"] } {
  const messages = buildCompanionPersonaMessages({
    userText: question,
    recentMessages: SYNTHETIC_HISTORY,
    pageContext: { kind: "note", title: "合成笔记：复数的几何意义", selectedText: "把一个量按等比反复缩小。" },
    hereAndNow: "现在：10:00 周一（上午）\n用户正在学习「复数的几何意义」，正在做：读第 2 段",
    residentMemories: [],
    memoryDirectory: Array.from({ length: 6 }, (_, i) => ({
      memoryId: `11111111-1111-4111-8111-11111111111${i}`,
      kind: "preference",
      title: `合成偏好 ${i}：解释先给例子再给定义。`,
      appliesWhen: "解释新概念时",
      validFrom: "2026-09-01T00:00:00.000Z",
      validUntil: null,
      revision: i + 1,
      epistemicStatus: null,
    })),
    selfNotes: `<companion_self_notes>${Array.from({ length: 6 }, (_, i) =>
      `合成记事 ${i}：她自己的记事，跨轮逐字不变，长度按真实 self_notes 块等比撑出来。`).join("\n")}</companion_self_notes>`,
    methodCatalog: `<method_catalog>${Array.from({ length: 4 }, (_, i) =>
      `合成方法 ${i}：用户确认过的合作方法，跨轮逐字不变。`).join("\n")}</method_catalog>`,
    conversationClock: { observedAt: "2026-10-13T02:00:00.000Z", timezone: "Asia/Shanghai", currentMessageCreatedAt: "2026-10-13T02:00:00.000Z" },
  });
  const turnPolicy = String(messages[0]?.content ?? "");
  const history = messages.slice(1) as AgentTurnRequest["messages"];
  return { turnPolicy, history };
}

/** 生产形状的问题轮请求；变体只改 tools / attention / 上下文。 */
function stepRequest(variant: "production" | "no-tools" | "bare"): AgentTurnRequest {
  const tools = variant === "no-tools" || variant === "bare"
    ? []
    : resolveAllCompanionAgentTools("full", { visionEnabled: false, webSearchEnabled: true })
      .map(({ name, description, parameters }) => ({ name, description, parameters }));
  if (variant === "bare") {
    return {
      role: AgentRole.COMPANION_AGENT,
      systemPrompt: "你是准确、简洁的物理助教。",
      messages: [{ role: "user", content: question }],
      tools: [],
      toolChoice: "auto",
      disableThinking: false,
      maxTokens: 384_000,
      temperature: 0.3,
    };
  }
  const { turnPolicy, history } = personaTurn();
  const execution = [
    companionStepRuntimePolicy({
      permissionLevel: "full",
      toolCount: tools.length,
      stepBudget: Infinity,
      finalAnswerOnly: false,
      attentionIntent: "question",
      sceneGuidance: collectAgentCapabilitySceneGuidance(tools.map(tool => tool.name), "full"),
    }),
    companionResponseStrategy({ intent: "question", toolUse: "none" }).guidance,
  ].filter(Boolean).join("\n");
  const attentionData = {
    version: 1, status: "interpreted", intent: "question", toolUse: "none",
    subjects: [], ambiguities: [], candidateOperations: [], pendingOfferIndexes: [],
    goalRelation: "new", goalReference: null, requestHash: "synthetic",
    voiceStyle: { decision: "none" },
  };
  const attention = "本轮注意力解释仅是待核对的数据，不授予执行权限。歧义影响真实资料读取或操作目标时先核对对象，不猜测修改；闲聊话题和称呼不要求业务对象身份。reference 为 null 不代表已经查询过或查询失败，不把内部分类和对象匹配过程念给用户。voiceStyle 是独立的本轮声音语义结果：apply 时宿主把 instruction 直接交给 TTS，none 时不切换，clarify 时先向用户问清楚。\n<current_turn_interpretation_data>"
    + JSON.stringify(attentionData).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e") + "</current_turn_interpretation_data>";
  const contents = [turnPolicy, execution, attention];
  const sources = new Map([
    ["turn", { scope: { kind: "policy" as const }, content: turnPolicy }],
    ["execution", { scope: { kind: "policy" as const }, content: execution }],
    ["attention", { scope: { kind: "request" as const }, content: attention }],
  ]);
  const plan = [...sources.keys()].map(id => ({ id, authority: id === "attention" ? "data" as const : "policy" as const, required: true }));
  return {
    role: AgentRole.COMPANION_AGENT,
    systemPrompt: composeAgentContext({ maxCharacters: companionContextAssemblyCapacity(contents), sources: plan }, sources).systemPrompt,
    messages: history,
    tools,
    toolChoice: "auto",
    disableThinking: false,
    maxTokens: 384_000,
    temperature: 0.3,
  };
}

test("production-shaped question turn first-token latency", { timeout: 30 * 60_000 }, async t => {
  const samples: Array<Record<string, unknown>> = [];
  const persist = () => save(name, {
    model: baseRoute.model, platformId: baseRoute.platformId, question,
    measurement: "monotonic request-to-headers / first SSE event / first output-text delta / first final-phase delta / completion; reasoning tokens from usage",
    samples,
  });

  const run = async (label: string, variant: "production" | "no-tools" | "bare", effort: ReasoningEffort | null, repeat: number) => {
    const modelProfile = effort === null
      ? baseRoute.modelProfile!
      : { ...baseRoute.modelProfile!, reasoning: { ...declaredReasoning, default: effort } };
    const route = { ...baseRoute, modelProfile };
    const wire: WireReceipt[] = [];
    const provider = observedProvider(route, `qtl-${name}-${samples.length}`, wire);
    const request = stepRequest(variant);
    const chunks: string[] = [];
    const started = performance.now();
    let firstDeltaMs: number | null = null;
    const sample: Record<string, unknown> = {
      label, variant, effort, repeat,
      systemChars: request.systemPrompt.length,
      toolCount: request.tools.length,
      messageCount: request.messages.length,
      status: "running",
    };
    samples.push(sample);
    persist();
    try {
      const result = await provider.chatCompletionStream!(
        buildAgentTurnMessages(request.systemPrompt, request.messages) as ChatMessage[],
        {
          maxTokens: request.maxTokens,
          temperature: request.temperature,
          disableThinking: request.disableThinking,
          responseFormat: "text",
          nativeAgentRequest: request,
          tools: request.tools,
          toolChoice: request.toolChoice,
        },
        AbortSignal.timeout(300_000),
        delta => {
          firstDeltaMs ??= Math.round(performance.now() - started);
          chunks.push(delta);
        },
      );
      sample.status = "succeeded";
      sample.firstDeltaMs = firstDeltaMs;
      sample.elapsedMs = Math.round(performance.now() - started);
      sample.answerChars = result.content.length;
      sample.toolCallCount = result.toolCalls?.length ?? 0;
      sample.answer = result.content;
    } catch (error) {
      sample.status = "failed";
      sample.failure = safeFailure(error);
      sample.firstDeltaMs = firstDeltaMs;
      sample.elapsedMs = Math.round(performance.now() - started);
    }
    sample.wire = wire;
    persist();
    t.diagnostic(JSON.stringify({ label, effort, status: sample.status,
      first: sample.firstDeltaMs, ms: sample.elapsedMs,
      reasoning: wire[0]?.reasoningTokens, out: wire[0]?.outputTokens, in: wire[0]?.inputTokens }));
  };

  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    await run(`production-${repeat}`, "production", null, repeat);
  }
  for (const effort of effortNames) {
    await run(`production-effort-${effort}`, "production", effort as ReasoningEffort, 0);
  }
  await run("production-no-tools", "no-tools", null, 0);
  await run("bare", "bare", null, 0);

  assert.ok(samples.some(sample => sample.status === "succeeded"), "all probe calls failed");
});
