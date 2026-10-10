/**
 * Companion Agent 运行时单测（方案《将 AI 伴星升级为可扩展 Agent》§1/§2/§3/§4）。
 *
 * 覆盖运行时里不依赖 DB 的决策面——这些正是方案验收清单里"必须失败关闭"的部分：
 * - 工具面：每轮全给、只按权限档过滤（技能层已删，不再有"这轮选中了什么"）；
 * - 工具与权限：只读权限禁止一切写工具，guided/full 仍保留高危确认；
 * - provider 工具调用标识：越界 id/name 必须被阻止（不得进入审计表或 SSE）。
 */
import {
  boundedToolCallIdentity,
  companionStepRequiresTool,
  companionStepToolShape,
  executeCompanionAgentTurnWithToolChoiceFallback,
  steerableToolNames,
  safeArgumentsHash
} from "../companion-tool-call-ledger.ts";

import {
  FINAL_ANSWER_HOLD_CHARS,
  companionActionResultRecorded,
  actionSteerBudget,
  companionStepCorrectionMessages,
  partitionPersonaPatch,
  planStepSteer,
  planWithheldFinalStepCalls,
  stepHoldChars
} from "../companion-step-plan.ts";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  canUseCompanionAgentTool,
  COMPANION_AUTONOMOUS_TOOLS,
  getCompanionAgentTool,
  isCompanionAutonomousTool,
  resolveAllCompanionAgentTools,
  validateCompanionAgentToolArguments,
} from "@astella/shared";
import {
  classifyCompanionToolFailure as classifyRuntimeToolFailure,
  CompanionToolBlockedError as RuntimeCompanionToolBlockedError,
  CompanionToolError as RuntimeCompanionToolError,
  CompanionToolNotExecutedError as RuntimeCompanionToolNotExecutedError,
  CompanionToolUnavailableError as RuntimeCompanionToolUnavailableError,
} from "../companion-agent-runtime.ts";
import { joinVisibleSegmentsDeduped } from "../companion-visible-segments.ts";
import {
  canRetryCompanionStream,
  CompanionSpeculativeStepDiscardedError,
  runStreamingAgentStep,
} from "../companion-agent-streaming-step.ts";
import { classifyCompanionToolFailure } from "../companion-tool-outcome.ts";
import { CompanionToolUnavailableError } from "../companion-tool-result.ts";
import {
  CompanionToolBlockedError as ExecutorCompanionToolBlockedError,
  CompanionToolError as ExecutorCompanionToolError,
  CompanionToolNotExecutedError as ExecutorCompanionToolNotExecutedError,
  CompanionToolUnavailableError as ExecutorCompanionToolUnavailableError,
} from "../companion-tool-result.ts";
// 读工具族已搬到 companion-read-tools.ts（B2）。测试跟着搬——
// 继续从 runtime 那个 re-export 取，会让「哪个文件有测试」这件事说不清。
import { taskQueueToolResult, currentPageToolResult } from "../companion-read-tools.ts";
import { NOTE_SEARCH_MAX_TERMS, noteSearchTerms } from "../companion-dialogue-content.ts";
import { interpretCompanionTurn } from "../companion-tool-intent.ts";
import { MockProvider } from "../../lib/providers/mock.ts";
import { ProviderRequestError } from "../../lib/provider-request-error.ts";
import { AgentOutputError } from "../../lib/non-retryable-errors.ts";
import { CompanionStreamStoppedError } from "../companion-dialogue-stream.ts";
import type { AIProvider } from "../../lib/ai-provider.ts";
import type { AgentTurnRequest, AgentTurnResult } from "@astella/shared";

test("rate, account and authorization rejections do not repeat through a buffered fallback", () => {
  const state={emitted:false,now:10,deadline:100};
  for (const status of [401,402,403,429]) assert.equal(canRetryCompanionStream(new ProviderRequestError({provider:"real",status}),state),false);
  assert.equal(canRetryCompanionStream(new ProviderRequestError({provider:"real",status:504}),state),true);
  assert.equal(canRetryCompanionStream(new Error("empty stream"),state),true);
  assert.equal(canRetryCompanionStream(new Error("socket closed"),{...state,emitted:true}),false);
  assert.equal(canRetryCompanionStream(new Error("socket closed"),{...state,now:100}),false);
  assert.equal(canRetryCompanionStream(new AgentOutputError("output_truncated", "exhausted"),state),false);
});

function toolIntentTaskContext(signal = new AbortController().signal) {
  return {
    job: {
      id: "job-agent-runtime-test",
      workspaceId: "workspace-agent-runtime-test",
      requestedBy: "user-agent-runtime-test",
      leaseToken: "lease-agent-runtime-test",
      signal,
    },
    runId: "run-agent-runtime-test",
    userId: "user-agent-runtime-test",
    permissionLevel: "guided",
    currentActiveTransaction: () => undefined,
    verifyAttempt: async () => true,
  };
}

test("工具异常使用执行器的同一类，写操作超时以结果待核对返回", () => {
  assert.equal(classifyRuntimeToolFailure, classifyCompanionToolFailure);
  assert.equal(RuntimeCompanionToolError, ExecutorCompanionToolError);
  assert.equal(RuntimeCompanionToolBlockedError, ExecutorCompanionToolBlockedError);
  // 40b §3.2 新增的两类同样必须是**同一个构造器**：它们靠 `instanceof` 分流，
  // 复制一份的话 runtime 这一侧永远读不到新状态（`companion-tool-result.ts` 顶上
  // 那段讲的就是这件事，这里是它的清单）。
  assert.equal(RuntimeCompanionToolNotExecutedError, ExecutorCompanionToolNotExecutedError);
  assert.equal(RuntimeCompanionToolUnavailableError, ExecutorCompanionToolUnavailableError);

  assert.deepEqual(
    classifyCompanionToolFailure(new Error("database connection closed"), "reversible_low", true),
    {
      status: "outcome_unknown",
      safeSummary: "这项操作可能已经发生，但暂时没有确定回执；请先核对状态，不要重复操作。",
    },
  );
  assert.deepEqual(
    classifyCompanionToolFailure(new Error("read timed out"), "read", true),
    { status: "failed", safeSummary: "工具执行失败，请稍后再试" },
  );
  assert.deepEqual(
    classifyCompanionToolFailure(new ExecutorCompanionToolError("目标已不存在，没有改动"), "consequential", true),
    { status: "failed", safeSummary: "目标已不存在，没有改动" },
  );
  assert.deepEqual(
    classifyCompanionToolFailure(new ExecutorCompanionToolBlockedError("权限不足"), "reversible_low", true),
    { status: "blocked", safeSummary: "权限不足" },
  );
  // 2026-10-01（40b §3.2）：派发前就被拦下的调用（屏障/取消/预算在 executeTool 之前耗尽）
  // 是 `not_executed`，不是 `failed`。原来这里断言 failed，把"压根没跑"说成"跑了但失败"，
  // 模型据此重调一次就多出一条假执行；账本与 doctor 那边也是同样的读法。
  assert.equal(
    classifyCompanionToolFailure(new Error("deadline"), "irreversible", false).status,
    "not_executed",
  );
});

test("工具解析：只读权限下只有她自己的记事与身份文档可以写", () => {
  const readOnlyTools = resolveAllCompanionAgentTools("read_only");
  assert.ok(readOnlyTools.length > 0, "只读权限仍应保留读取工具");
  for (const definition of readOnlyTools) {
    // 权限档管的是用户的材料。她写给自己的记事与身份文档由声明划界（§20），
    // 不因此多拿到任何触碰用户内容的口子。
    assert.ok(definition.riskClass === "read" || isCompanionAutonomousTool(definition.name),
      `${definition.name} 不是她自己的记录，不应出现在只读权限中`);
    assert.equal(canUseCompanionAgentTool("read_only", definition).allowed, true);
  }
  assert.deepEqual(
    readOnlyTools.filter(d => d.riskClass !== "read").map(d => d.name).sort(),
    COMPANION_AUTONOMOUS_TOOLS.filter(name => getCompanionAgentTool(name)?.riskClass !== "read").sort(),
    "只读权限里的非读工具必须恰好等于声明的自主集合");
  // 计划类写工具在只读权限下必须被拒绝
  for (const name of ["companion_start_learning", "companion_pause_learning", "companion_defer_review"]) {
    const definition = getCompanionAgentTool(name);
    assert.ok(definition);
    assert.equal(canUseCompanionAgentTool("read_only", definition).allowed, false, `${name} 必须被只读权限阻止`);
    assert.equal(readOnlyTools.some((d) => d.name === name), false);
  }
});

test("工具解析：guided 自动执行可逆低风险，其余写操作一律确认", () => {
  const tools = resolveAllCompanionAgentTools("guided");
  assert.ok(tools.length > 0);
  for (const definition of tools) {
    const auth = canUseCompanionAgentTool("guided", definition);
    assert.equal(auth.allowed, true);
    // 读取永不确认；约定类写入（提醒）是用户亲口要过的、可逆且不改学习状态，
    // guided 下也直接执行；其余写操作一律先出提案。
    const autoExecutes = definition.riskClass === "read"
      || (definition.riskClass === "reversible_low" && !definition.requiresConfirmation);
    assert.equal(
      auth.requiresConfirmation,
      !autoExecutes,
      `${definition.name}（${definition.riskClass}）在 guided 下的确认要求不符`,
    );
  }
  // 图谱聚焦与提醒的建/撤是 planner+navigation 里的免确认可逆低风险工具
  for (const name of ["companion_focus_graph", "companion_schedule_reminder", "companion_cancel_reminder"]) {
    const definition = getCompanionAgentTool(name);
    assert.ok(definition, `${name} 必须存在`);
    assert.equal(canUseCompanionAgentTool("guided", definition).requiresConfirmation, false, name);
  }
  // 提醒必须是可查可撤的：只有 schedule 没有 list/cancel 的话，用户说"不用提醒了"
  // 就只能等它自己响。
  assert.ok(getCompanionAgentTool("companion_list_reminders")?.riskClass === "read");
});

test("工具解析：full 权限 = 用户预授权，但命令住在提案那条路的工具不因此失去执行处", () => {
  // 2026-09-19 对齐权限分级原设计：full 是用户的事前授权，consequential 不再
  // 逐步确认（自动跳转/自动设置）；irreversible 仍是安全底线。
  //
  // 2026-09-25 改了一条判据（#16 量的那面墙）：`companion_start_learning` 这类工具
  // **worker 侧没有直执行器**，命令本体只在 API 的提案确认里执行。full 档原先把它判成
  // "预授权 ⇒ 直执行"，于是走到 switch 的 default 抛「这一步我这边还做不了」——
  // **guided 档出提案卡能用，full 档反而失败**，权限越高越差。现在 full 档对这些工具
  // 同样出提案（免确认那一步仍欠，见 §19 那行的说明）。
  const start = getCompanionAgentTool("companion_start_learning");
  assert.ok(start);
  assert.equal(start.requiresConfirmation, true);
  assert.deepEqual(canUseCompanionAgentTool("full", start), {
    allowed: true,
    requiresConfirmation: true,
  });
  // guided 档维持逐次确认（默认档必须保守）。
  assert.deepEqual(canUseCompanionAgentTool("guided", start), {
    allowed: true,
    requiresConfirmation: true,
  });
  // 控制端点：full 档**仍然**是预授权档——worker 能自己执行的可逆低风险工具不许被
  // 顺手拖回确认档（否则这条改动就把 full 档整个抹平成 guided，而那不是要修的东西）。
  const activeness = getCompanionAgentTool("companion_set_activeness");
  assert.ok(activeness);
  assert.equal(canUseCompanionAgentTool("full", activeness).requiresConfirmation, false,
    "full 档的直执行能力被误伤：可逆低风险工具应当仍然免确认");
  const irreversible = { name: "synthetic_irreversible", riskClass: "irreversible" as const, requiresConfirmation: false };
  assert.equal(canUseCompanionAgentTool("full", irreversible).requiresConfirmation, true);
});

test("工具参数：未知工具、未知字段、类型错误全部失败关闭", () => {
  assert.equal(validateCompanionAgentToolArguments("does_not_exist", {}).success, false);
  assert.equal(validateCompanionAgentToolArguments("companion_read_context", { extra: 1 }).success, false);
  assert.equal(validateCompanionAgentToolArguments("companion_pause_learning", { runId: "not-a-uuid" }).success, false);
  assert.equal(
    validateCompanionAgentToolArguments("companion_request_hint", {
      runId: "11111111-1111-4111-8111-111111111111",
      taskId: "22222222-2222-4222-8222-222222222222",
      level: 4,
    }).success,
    false,
  );
});

test("工具调用标识：越界 id/name 被阻止（fail closed）", () => {
  assert.deepEqual(boundedToolCallIdentity({ id: "call_1", name: "companion_read_context" }), {
    id: "call_1",
    name: "companion_read_context",
  });
  // provider 返回空 id（OpenAI-compatible 解析层会把缺失 id 变成 ""）
  assert.equal(boundedToolCallIdentity({ id: "", name: "companion_read_context" }), null);
  // 超出 SSE 合同上限：toolCallId ≤200、name ≤80
  assert.equal(boundedToolCallIdentity({ id: "x".repeat(201), name: "companion_read_context" }), null);
  assert.equal(boundedToolCallIdentity({ id: "call_1", name: "n".repeat(81) }), null);
  // 非字符串
  assert.equal(boundedToolCallIdentity({ id: undefined, name: "companion_read_context" }), null);
  assert.equal(boundedToolCallIdentity({ id: "call_1", name: 42 }), null);
});

test("工具参数 hash：确定性且对异常 payload 不抛错", () => {
  assert.equal(safeArgumentsHash({ a: 1, b: 2 }), safeArgumentsHash({ b: 2, a: 1 }));
  assert.notEqual(safeArgumentsHash({ a: 1 }), safeArgumentsHash({ a: 2 }));
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.doesNotThrow(() => safeArgumentsHash(circular));
  assert.equal(safeArgumentsHash(circular).length, 64);
});

//
// runStreamingAgentStep 不依赖 DB（provider/onProviderDelta 全注入），这里锁住
// 三条路径：正常完成、交付管线"说停"（返回 false）、交付管线**抛错**（落库事务
// 异常/desync）。第三条是 2026-09-19 的修复：此前 rejection 被链尾吞掉，provider
// 会白读到流尾才在 finish() 暴露失败。另加 ④-b 的两条：工具步能带回 tool_calls、
// 分段符随本段第一个文本增量一起下发。

function streamingStubProvider(deltas: string[], toolCalls?: unknown[]): {
  provider: AIProvider;
  state: { emitted: number; aborted: boolean };
} {
  const state = { emitted: 0, aborted: false };
  const provider = {
    id: "stub",
    modelId: "stub-model",
    visionModelId: "stub-model",
    promptVersion: "test",
    chatCompletion: async () => { throw new Error("not used"); },
    executeAgentTurn: async () => { throw new Error("not used"); },
    chatCompletionStream: async (
      _messages: unknown,
      _options: unknown,
      signal: AbortSignal | undefined,
      onDelta: (delta: string) => void,
    ): Promise<{ content: string; toolCalls?: unknown[]; finishReason?: string }> => {
      const onAbort = (): void => { state.aborted = true; };
      signal?.addEventListener("abort", onAbort, { once: true });
      let content = "";
      for (const delta of deltas) {
        if (state.aborted || signal?.aborted) throw new Error("AI request aborted during stream");
        onDelta(delta);
        content += delta;
        state.emitted += 1;
        // 让 flushChain 的微任务链有机会运行——真实链路里是网络读的间隙。
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      if (state.aborted || signal?.aborted) throw new Error("AI request aborted during stream");
      return toolCalls ? { content, toolCalls, finishReason: "tool_calls" } : { content };
    },
  } as unknown as AIProvider;
  return { provider, state };
}

const STREAM_STEP_REQUEST: AgentTurnRequest = {
  role: "companion_agent",
  systemPrompt: "测试 system",
  messages: [{ role: "user" as const, content: "打个招呼" }],
  tools: [],
  maxTokens: 700,
  temperature: 0.9,
};

test("发布前保留完整复核结果：长流不吐字，也不剪掉末尾", async () => {
  const deltas = ["第一段解释。".repeat(900), "第二段解释。".repeat(900), "关键条件在全文末尾。"];
  const { provider, state } = streamingStubProvider(deltas);
  const seen: string[] = [];
  let emitted = false;
  const result = await runStreamingAgentStep({
    provider, stepRequest: STREAM_STEP_REQUEST, ctxSignal: new AbortController().signal,
    timeoutMs: 5_000, holdUntilChars: 12, separatorBefore: "\n\n", deferPublication: true,
    onTextEmitted: () => { emitted = true; },
    onProviderDelta: async text => { seen.push(text); return true; },
  });
  assert.equal(result.content, deltas.join(""));
  assert.deepEqual(seen, []);
  assert.equal(emitted, false);
  assert.equal(state.emitted, deltas.length);
  assert.equal(state.aborted, false);
});

/**
 * 放行闸（2026-10-07 投机执行）：分类器定论之前，投机那一步一个字都不能漏出去。
 * 两道闸各管一件事——gate 管"分类器同意了吗"，holdUntilChars 管"这段字值不值得发"。
 */
test("放行闸：定论前不下发，同意时把已生成的部分一次放出", async () => {
  const deltas = ["在忙", "啥呢", "——刚", "把熵讲完"];
  const { provider } = streamingStubProvider(deltas);
  const seen: string[] = [];
  let markGenerated: () => void = () => {};
  const generated = new Promise<void>(resolve => { markGenerated = resolve; });
  const stream = provider.chatCompletionStream!;
  provider.chatCompletionStream = async (...args) => {
    const result = await stream(...args);
    markGenerated();
    return result;
  };
  let settleGate: (allowed: boolean) => void = () => {};
  const gate = new Promise<boolean>((resolve) => { settleGate = resolve; });
  const running = runStreamingAgentStep({
    provider,
    stepRequest: STREAM_STEP_REQUEST as never,
    ctxSignal: new AbortController().signal,
    timeoutMs: 5_000,
    onProviderDelta: async (text: string) => { seen.push(text); return true; },
    releaseGate: () => gate,
  });
  // 闸还关着：provider 已经在吐字了，交付管线一个字符都不该看到。
  await generated;
  assert.deepEqual(seen, [], "放行闸没关住，字漏到交付管线了");
  settleGate(true);
  const result = await running;
  assert.equal(seen.join(""), "在忙啥呢——刚把熵讲完");
  assert.equal(result.content, "在忙啥呢——刚把熵讲完");
});

test("快速流式生成结束后仍等待分类；取消后晚到的放行不能再吐字", async () => {
  const seen: string[] = [];
  let settleGate: (allowed: boolean) => void = () => {};
  const gate = new Promise<boolean>(resolve => { settleGate = resolve; });
  const ctx = new AbortController();
  const provider: AIProvider = new MockProvider();
  provider.chatCompletionStream = async (_messages, _options, _signal, onDelta) => {
    onDelta("这一段必须等分类同意才能出现。");
    return {content:"这一段必须等分类同意才能出现。"};
  };
  const flight = runStreamingAgentStep({provider,stepRequest:STREAM_STEP_REQUEST,
    ctxSignal:ctx.signal,timeoutMs:5000,onProviderDelta:async text=>{seen.push(text);return true;},releaseGate:()=>gate});
  ctx.abort();
  await assert.rejects(flight);
  settleGate(true);
  await Promise.resolve();
  assert.deepEqual(seen, []);
});

test("放行闸判否：整版作废，一个字都没下发", async () => {
  // 流得比闸的判定慢，才看得出"作废时确实没漏字"：判否之后必须中断在途请求。
  const provider = {
    id: "stub", modelId: "stub-model", visionModelId: "stub-model", promptVersion: "test",
    chatCompletion: async () => { throw new Error("not used"); },
    executeAgentTurn: async () => { throw new Error("not used"); },
    chatCompletionStream: async (
      _messages: unknown, _options: unknown, signal: AbortSignal | undefined,
      onDelta: (delta: string) => void,
    ) => {
      let aborted = false;
      signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
      for (const delta of ["这句", "不该", "被看见", "第三段", "第四段"]) {
        if (aborted) throw new Error("AI request aborted during stream");
        onDelta(delta);
        await new Promise((resolve) => setTimeout(resolve, 8));
      }
      if (aborted) throw new Error("AI request aborted during stream");
      return { content: "这句不该被看见第三段第四段" };
    },
  } as unknown as AIProvider;
  const seen: string[] = [];
  const running = runStreamingAgentStep({
    provider,
    stepRequest: STREAM_STEP_REQUEST as never,
    ctxSignal: new AbortController().signal,
    timeoutMs: 5_000,
    onProviderDelta: async (text: string) => { seen.push(text); return true; },
    // 一判就是"不同意"：攒住的整版作废，在途请求也要中断掉。
    releaseGate: async () => false,
  });
  await assert.rejects(running, CompanionSpeculativeStepDiscardedError);
  assert.deepEqual(seen, [], "作废的一版不该留下任何已下发内容");
});

test("流式单步：JSON 信封被剥掉，交付管线只看到正文增量，返回完整原文", async () => {
  // json_object 模式下模型吐的是 {"reply": "…"}；流式的可见内容必须是**正文**，
  // 信封语法一个字符都不能漏给客户端（2026-09-19 实机缺主语的根因就在这条链路上）。
  const deltas = ['{"reply": "', "你好", "呀，", "今天想学点", '什么？"}'];
  const { provider, state } = streamingStubProvider(deltas);
  const seen: string[] = [];
  const result = await runStreamingAgentStep({
    provider,
    stepRequest: STREAM_STEP_REQUEST as never,
    ctxSignal: new AbortController().signal,
    timeoutMs: 5_000,
    onProviderDelta: async (delta: string) => {
      seen.push(delta);
      return true;
    },
  });
  // 返回值是**解码后的正文**（本轮回复的唯一事实来源）：下游不再按优先级从
  // 原始 JSON 里挑键——那正是"流式内容与落库正文分叉"的来源。
  assert.equal(result.content, "你好呀，今天想学点什么？");
  assert.deepEqual(result.toolCalls, []);
  assert.deepEqual(seen, ["你好", "呀，", "今天想学点", "什么？"]);
  assert.equal(state.aborted, false);
});

test("流式单步：以 `[标签]` 开头的自然回复直通，头部一个字符都不能丢", async () => {
  // 2026-09-19 收窄：头部嗅探初版只看首字符是否 `{`/`[`，于是以 `[empathetic]`
  // 这类方括号开头的正常回复也会被送进 JSON 信封解码器——解不出形状就**一个字都
  // 不下发**，那一轮会缺头（库里确有 `这么开心，是遇到什么有趣的事了吗？` /
  // `呀。今天的学习状态怎么样？` 这类落库正文）。真实信封只有 `{` / `[{` / `["`
  // 三种开头，数组里不会直接出现裸字母，所以 `[标签]` 必须走直通。
  const deltas = ["[empathetic]", "，你已经", "很努力了呀。"];
  const { provider, state } = streamingStubProvider(deltas);
  const seen: string[] = [];
  const result = await runStreamingAgentStep({
    provider,
    stepRequest: STREAM_STEP_REQUEST as never,
    ctxSignal: new AbortController().signal,
    timeoutMs: 5_000,
    onProviderDelta: async (delta: string) => {
      seen.push(delta);
      return true;
    },
  });
  // 头部原样下发（标签由下游 sanitizeCompanionVisibleText 统一剥离）。
  assert.equal(result.content, "[empathetic]，你已经很努力了呀。");
  assert.deepEqual(seen, ["[empathetic]", "，你已经", "很努力了呀。"]);
  assert.equal(state.aborted, false);
});

test("流式单步（④-b）：带工具的一步把 tool_calls 一并带回，开场白仍下发", async () => {
  // ④-b 的核心：SSE 里 delta.tool_calls 与 delta.content 并列，流式路径必须把
  // 工具调用解析出来——否则"打开复习页"这类请求会变成"她说了句我去看看，
  // 然后什么都没发生"。
  const deltas = ["好，", "这就带你过去。"];
  const { provider } = streamingStubProvider(deltas, [
    { id: "call_1", name: "companion_open_page", arguments: {} },
  ]);
  const seen: string[] = [];
  const result = await runStreamingAgentStep({
    provider,
    stepRequest: STREAM_STEP_REQUEST as never,
    ctxSignal: new AbortController().signal,
    timeoutMs: 5_000,
    onProviderDelta: async (delta: string) => {
      seen.push(delta);
      return true;
    },
  });
  assert.equal(result.content, "好，这就带你过去。");
  assert.deepEqual(result.toolCalls, [{ id: "call_1", name: "companion_open_page", arguments: {} }]);
  assert.equal(result.finishReason, "tool_calls");
  assert.deepEqual(seen, ["好，", "这就带你过去。"]);
});

test("流式单步（④-b）：分段符随本段第一个文本增量一起下发（与最终正文拼接口径一致）", async () => {
  const { provider } = streamingStubProvider(["根据你的笔记，", "今天有三张卡要复习。"]);
  const seen: string[] = [];
  await runStreamingAgentStep({
    provider,
    stepRequest: STREAM_STEP_REQUEST as never,
    ctxSignal: new AbortController().signal,
    timeoutMs: 5_000,
    separatorBefore: "\n\n",
    onProviderDelta: async (delta: string) => {
      seen.push(delta);
      return true;
    },
  });
  assert.deepEqual(seen, ["\n\n根据你的笔记，", "今天有三张卡要复习。"]);
});

test("流式单步（④-b）：本段没有文本时不下发分段符（最终正文也不会空出一段）", async () => {
  const { provider } = streamingStubProvider([], [
    { id: "call_1", name: "companion_read_context", arguments: {} },
  ]);
  const seen: string[] = [];
  await runStreamingAgentStep({
    provider,
    stepRequest: STREAM_STEP_REQUEST as never,
    ctxSignal: new AbortController().signal,
    timeoutMs: 5_000,
    separatorBefore: "\n\n",
    onProviderDelta: async (delta: string) => {
      seen.push(delta);
      return true;
    },
  });
  assert.deepEqual(seen, []);
});

test("流式单步：交付管线说停（返回 false）→ 立即中断读取，抛 CompanionStreamStoppedError", async () => {
  const deltas = ['{"reply": "', "第一段", "第二段", "第三段", "第四段", '"}'];
  const { provider, state } = streamingStubProvider(deltas);
  await assert.rejects(
    runStreamingAgentStep({
      provider,
      stepRequest: STREAM_STEP_REQUEST as never,
      ctxSignal: new AbortController().signal,
      timeoutMs: 5_000,
      onProviderDelta: async (delta: string) => delta !== "第二段",
    }),
    (error: unknown) => error instanceof CompanionStreamStoppedError,
  );
  assert.equal(state.aborted, true, "底层请求必须被中断");
  assert.ok(state.emitted < deltas.length, "不得继续消费剩余增量");
});

test("流式单步：交付管线抛错（落库异常）→ 同样立即中断，不再白读到流尾", async () => {
  const deltas = ['{"reply": "', "第一段", "第二段", "第三段", "第四段", "第五段", '"}'];
  const { provider, state } = streamingStubProvider(deltas);
  await assert.rejects(
    runStreamingAgentStep({
      provider,
      stepRequest: STREAM_STEP_REQUEST as never,
      ctxSignal: new AbortController().signal,
      timeoutMs: 5_000,
      onProviderDelta: async (delta: string) => {
        if (delta === "第二段") throw new Error("companion delta stream desync: written=1 expected=2");
        return true;
      },
    }),
    (error: unknown) => error instanceof CompanionStreamStoppedError,
  );
  // 观察项修复的核心断言：抛错路径与"说停"路径行为一致——abort 及时触发，
  // 后续增量不再进入 provider 读取循环。
  assert.equal(state.aborted, true, "底层请求必须被中断");
  assert.ok(state.emitted < deltas.length, "不得继续消费剩余增量");
});

// ─── 坍缩闸（2026-09-20）：holdUntilChars ───────────────────────────────
// 实机四条连续轮次落库 `现在是`(3)/`今天`(2)/`最近`(2)/`你`(1)，全是流式，
// 而退化闸要求 `!stepEmitted`——吐过字就永远不成立，所以一次都没拦住。
// hold 的语义就是让"这一步到底有没有下发"重新变成可成立的条件。

test("坍缩闸：整步未达阈值时一个字都不下发，onTextEmitted 不触发", async () => {
  const { provider } = streamingStubProvider(["嘿", "嘿嘿"]);
  const seen: string[] = [];
  let emitted = false;
  const result = await runStreamingAgentStep({
    provider,
    stepRequest: STREAM_STEP_REQUEST as never,
    ctxSignal: new AbortController().signal,
    timeoutMs: 5_000,
    holdUntilChars: 12,
    onTextEmitted: () => { emitted = true; },
    onProviderDelta: async (delta: string) => { seen.push(delta); return true; },
  });
  assert.deepEqual(seen, [], "短于阈值的整步不得下发任何字符");
  assert.equal(emitted, false, "stepEmitted 必须保持 false，退化闸才有重跑的机会");
  // 但正文本身不能丢——它由调用方经整段补写路径交付。
  assert.equal(result.content, "嘿嘿嘿");
});

test("声音标记不计入正文放行阈值，半句加标签仍然可修复", async () => {
  const { provider } = streamingStubProvider(["[em", "pathetic][giggles]", "嗯"]);
  const seen: string[] = [];
  let emitted = false;
  const result = await runStreamingAgentStep({ provider, stepRequest: STREAM_STEP_REQUEST,
    ctxSignal: new AbortController().signal, timeoutMs: 5000, holdUntilChars: 12,
    onTextEmitted: () => { emitted = true; }, onProviderDelta: async delta => { seen.push(delta); return true; } });
  assert.deepEqual(seen, []);
  assert.equal(emitted, false);
  assert.equal(result.content, "[empathetic][giggles]嗯");
});

test("坍缩闸：跨过阈值时把攒住的文本一次性按序放行，之后直通", async () => {
  const { provider } = streamingStubProvider(["今天", "学了", "18分钟", "，很稳啊"]);
  const seen: string[] = [];
  let emitted = false;
  const result = await runStreamingAgentStep({
    provider,
    stepRequest: STREAM_STEP_REQUEST as never,
    ctxSignal: new AbortController().signal,
    timeoutMs: 5_000,
    holdUntilChars: 8,
    onTextEmitted: () => { emitted = true; },
    onProviderDelta: async (delta: string) => { seen.push(delta); return true; },
  });
  // 已下发原文必须是最终正文的前缀——放行帧是攒住的整段，不是最后一个增量。
  assert.deepEqual(seen, ["今天学了18分钟", "，很稳啊"]);
  const finalText = typeof result.content === "string" ? result.content : "";
  assert.ok(finalText.length > 0 && finalText.startsWith(seen.join("")), "下发内容必须是最终正文的前缀");
  assert.equal(emitted, true);
});

test("坍缩闸：分段符只贴在真正放行的第一帧前面，不重复", async () => {
  const { provider } = streamingStubProvider(["第一段", "第二段", "第三段"]);
  const seen: string[] = [];
  await runStreamingAgentStep({
    provider,
    stepRequest: STREAM_STEP_REQUEST as never,
    ctxSignal: new AbortController().signal,
    timeoutMs: 5_000,
    separatorBefore: "\n\n",
    holdUntilChars: 5,
    onProviderDelta: async (delta: string) => { seen.push(delta); return true; },
  });
  assert.equal(seen[0], "\n\n第一段第二段", "放行帧是攒住的整段，不是最后一个增量");
  assert.equal(seen.filter((chunk) => chunk.includes("\n\n")).length, 1, "分隔符只能出现一次");
});

// ─── 扁平工具面（方案 29 §4.1）：能力不再被关键词路由关掉 ─────────────────
// 回归的正是那个 90.7% 的读数：`selectSkill()` 没命中 → 空工具面 → 单步，
// "读记忆 / 看系统状态 / 跳转"根本没出现在她面前。

test("扁平工具面：guided/full 档下写工具与读工具同时在列，与用户说了什么无关", () => {
  const guided = resolveAllCompanionAgentTools("guided").map((d) => d.name);
  const full = resolveAllCompanionAgentTools("full").map((d) => d.name);
  // 曾经这些只存在于特定技能里：不选中的技能 = 拿不到的能力。
  for (const name of ["companion_save_memory", "companion_open_page", "companion_start_learning"]) {
    assert.ok(guided.includes(name), `guided 必须能看到 ${name}`);
    assert.ok(full.includes(name), `full 必须能看到 ${name}`);
  }
  // 跨技能的组合现在可能了（以前一轮只能拿到一个技能的子集）。
  assert.ok(guided.includes("companion_read_context") && guided.includes("companion_search_notes"),
    "上下文与系统查询工具必须同时可用");
  // 抱怨 #5/#6 的那一面：看笔记、看数据、看队列、跳到页面，任何一轮都在。
  for (const name of [
    "companion_search_notes", "companion_read_note", "companion_open_note", "companion_open_page",
    "companion_get_learning_stats", "companion_list_task_queue", "companion_list_due_reviews",
    "companion_schedule_reminder", "companion_list_reminders", "companion_cancel_reminder",
  ]) {
    assert.ok(guided.includes(name), `guided 必须能看到 ${name}`);
  }
});

test("扁平工具面：read_only 档只剩读工具与她自己的记录（权限边界不因常开而放松）", () => {
  const readOnly = resolveAllCompanionAgentTools("read_only");
  assert.ok(readOnly.length > 0, "read_only 下仍要有读工具");
  assert.ok(readOnly.every((d) => d.riskClass === "read" || isCompanionAutonomousTool(d.name)),
    "read_only 绝不能出现触碰用户材料的写/动作工具");
});
/**
 * steer 的提示里到底该点名哪个工具。
 *
 * 实机 2026-09-22 场景 T：用户说「以后别主动催我复习」，她两步都只回"我记下了"，
 * `companion_set_boundary` 一次没调（tools=0，边界其实没改）。查下来不是模型不肯调，
 * 而是**这一支的提示根本没点名任何工具**：`steerableReadTools` 只收读类工具，
 * 而 action 那一支用的是泛指文案"调用合适的工具"——同一个文件上面 30 行就写着
 * "小模型对『你去调用工具』这种泛指不敏感，对『调用 companion_search_notes』会照做"。
 * 换到兜底模型也一样，因为要它做的仍然是"猜哪个工具"。
 */
test("steerableToolNames：lookup 点读类、action 点可逆写，consequential 永不点名", () => {
  const defs = [
    { name: "companion_search_notes", riskClass: "read" },
    { name: "companion_recall_memory", riskClass: "read" },
    { name: "companion_set_boundary", riskClass: "reversible_low" },
    { name: "companion_save_memory", riskClass: "reversible_low" },
    { name: "companion_start_learning", riskClass: "consequential" },
    { name: "companion_pause_learning", riskClass: "consequential" },
  ];
  assert.deepEqual(steerableToolNames(defs, "lookup"), ["companion_search_notes", "companion_recall_memory"]);
  assert.deepEqual(steerableToolNames(defs, "action"), ["companion_set_boundary", "companion_save_memory"]);
  // 这条是安全性质，不是风格：一句纠正性提示里出现 companion_start_learning，
  // 等于系统自己把用户没要过的学习运行推上桌。
  for (const kind of ["lookup", "action"] as const) {
    assert.ok(steerableToolNames(defs, kind).every((name) => !name.includes("learning")),
      `${kind} 那一支绝不能点名 consequential`);
  }
  assert.equal(steerableToolNames([...defs, ...defs], "lookup", 3).length, 3);
});

/**
 * 分段拼接必须保证"已下发原文是最终正文的前缀"。
 *
 * 实机 2026-09-22 场景 T：第 1 步的话被 hold 攒住没发出去、随后被 steer 掉，
 * 第 3 步真的调了 `companion_set_boundary` 并说出结论——边界改成功了，run 却
 * 判 `stream_full_text_diverged` 失败（最终正文以那句没发出去的话开头）。
 * 用户看到的是"报错"，而事情其实做完了——这是最难解释的一种失败。
 */
test("joinVisibleSegmentsDeduped：从没下发过的段不能排在已下发段前面", () => {
  const SEP = "\n\n";
  // 全下发 → 原样保留（顺序与分段符都不能动）
  assert.equal(joinVisibleSegmentsDeduped(["第一段话呀呀", "第二段话呀呀"], [true, true]).text,
    "第一段话呀呀" + SEP + "第二段话呀呀");
  // 未下发在前、已下发在后 → 丢前面那条，结果以已下发的那条开头
  const dropped = joinVisibleSegmentsDeduped(["嗯嗯，记住了喵。", "好了，这次是真的设上了喵"], [false, true]);
  assert.equal(dropped.text, "好了，这次是真的设上了喵");
  assert.deepEqual(dropped.dropped, ["嗯嗯，记住了喵。"]);
  // 夹在两个已下发段中间的未下发段同样丢
  assert.equal(joinVisibleSegmentsDeduped(
    ["第一段话呀呀", "第二段没发出去", "第三段话呀呀"], [true, false, true],
  ).text, "第一段话呀呀" + SEP + "第三段话呀呀");
  // 末尾的未下发段**必须保留**：那是 writeTail 正要补发的尾巴，丢了用户就没答案了
  assert.equal(joinVisibleSegmentsDeduped(
    ["第一段话呀呀", "第二段还没发出去"], [true, false],
  ).text, "第一段话呀呀" + SEP + "第二段还没发出去");
  // 原有的"复读去重"仍在：未下发且与前面保留段完全相同 → 丢
  assert.equal(joinVisibleSegmentsDeduped(
    ["复习入口准备好啦点前往", "复习入口准备好啦点前往"], [true, false],
  ).text, "复习入口准备好啦点前往");
});

test("内部纠正重附当前选区与问题，不能变成最新用户的另一项请求", () => {
  const currentRequest = {
    role: "user" as const,
    content: "我刚划选的原文：\n<selection_data>利息也会继续产生利息。</selection_data>\n我的问题：解释这段",
  };
  for (const alreadyDisplayed of [true, false]) {
    const messages = companionStepCorrectionMessages({ currentRequest, instruction: "核对引文。", alreadyDisplayed });
    assert.equal(messages[0].role, "system");
    assert.match(String(messages[0].content), /不是新的用户请求/);
    assert.deepEqual(messages.at(-1), currentRequest);
    assert.equal(messages.filter((message) => message.role === "user").length, 1);
  }
});

/**
 * 用户要的是一个"必须动系统才算做到"的动作时，这一步的话要**整段攒住**。
 *
 * 实机 2026-09-22 场景 T：opener「嗯，这条早就设好了喵——你不问，我一个字都不提」
 * 先落到屏幕上，之后哪怕 steer 出真的 `companion_set_boundary`，也只能在同一条消息里
 * 自相矛盾（或者干脆留下一句没兑现的承诺）。事后闸救不了已经发出去的字，
 * 所以这里改的是**发不发**：动作轮里，一步结束前不落屏。
 */
test("stepHoldChars：动作轮整段攒住，普通轮仍是 12 字阈值", () => {
  assert.equal(stepHoldChars({ userAskedForAction: false }), FINAL_ANSWER_HOLD_CHARS);
  const hold = stepHoldChars({ userAskedForAction: true });
  assert.ok(hold > 10_000, "动作轮的阈值要高到一步的正文永远达不到");
  assert.ok("嗯，这条早就设好了喵——你不问，我一个字都不提。".length < hold);
});

/**
 * 动作轮可以多补一步，普通形状不行。
 * 这条额度差是**有条件的**：只有 `stepHoldChars` 把正文整段攒住之后才成立，
 * 否则第二次 steer 是在已经落屏的假话后面再接一段。
 */
test("actionSteerBudget：动作轮两次、其他形状一次", () => {
  assert.equal(actionSteerBudget({ userAskedForAction: true }), 2);
  assert.equal(actionSteerBudget({ userAskedForAction: false }), 1);
});

/**
 * "她改了但其实没改"这一类（实机 2026-09-22 场景 U）。
 *
 * 用户只要一句口头禅，她连着调了两个工具，其中一个把活跃度"调成了「活跃」"——
 * 而活跃度**本来就是** active（库里 09-20 就是 active，revision 白 +1）。
 * 她随后自己补了一句"这个是你想要的吗"，说明这不是恶意，是工具结果给了她一个
 * "已把 X 设为 Y"的**成功摘要**，而这一轮那件事根本没发生。
 * 所以工具必须区分"改成了"和"本来就是这样"。
 */
test("partitionPersonaPatch：与当前值相同的项不算改动", () => {
  assert.deepEqual(
    partitionPersonaPatch({ activeness: "active" }, { activeness: "active" }),
    { changed: {}, unchangedKeys: ["activeness"] },
  );
  assert.deepEqual(
    partitionPersonaPatch(
      { allowNudgeLearning: true, allowPlayful: true },
      { allowNudgeLearning: false, allowPlayful: true },
    ),
    { changed: { allowNudgeLearning: false }, unchangedKeys: ["allowPlayful"] },
  );
  // 当前值缺项（boundaries 从没写过的键）算改动：不能把"没设过"读成"已经是这样"。
  assert.deepEqual(
    partitionPersonaPatch({}, { catchphrase: "就这么定了" }),
    { changed: { catchphrase: "就这么定了" }, unchangedKeys: [] },
  );
});

// 实机 2026-09-22 真人轮「我接下来的任务队列里都排着什么？」：她把清单念完了，
// 但 `list_task_queue` 此前只回文字——既不给 route，`open_page` 白名单里也没有
// "任务队列"这一页，用户想点开看一眼无路可走。队列属于某一次学习运行，
// 所以"打开那轮运行"就是它该落到的地方。
test("taskQueueToolResult：有待办时带出这一轮运行页的 route", () => {
  const runId = "3f2e1369-7595-466c-af76-6cea5ee7440f";
  const result = taskQueueToolResult([
    { task_id: "t1", sequence: 2, status: "pending", label: "过一遍公式", run_phase: "active", run_id: runId },
    { task_id: "t2", sequence: 3, status: "pending", label: "错题回看", run_phase: "active", run_id: runId },
  ]);
  assert.deepEqual(result.route, { kind: "learning_run", runId });
  assert.equal(result.safeSummary, "队列里有 2 个待办任务");
  assert.deepEqual((result.value.tasks as { taskId: string }[]).map((t) => t.taskId), ["t1", "t2"]);
});

test("taskQueueToolResult：没有待办 / 拿不到 run 时不硬造 route", () => {
  assert.equal(taskQueueToolResult([]).route, undefined);
  assert.equal(taskQueueToolResult([]).safeSummary, "当前没有排着的任务");
  assert.equal(
    taskQueueToolResult([{ task_id: "t1", sequence: 1, status: "pending",
                           label: "x", run_phase: "active", run_id: null }]).route, undefined,
    "run_id 为空就不能拼出一个跳转");
});

// ─── §9.28 双额度的账目（方案 29 §12 C1 的实机回归）───────────────────────
const steerInput = {
  stepCalls: 0, toolCallCount: 0, finalAnswerOnly: false, withinBudget: true,
  userAskedForAction: false, hasUnverifiedClaims: true,
  looksLikeUnfulfilledNarration: false, lookupClaim: false,
  actionSteerAttempts: 0, actionSteerBudget: 1, lookupClaimSteered: false,
};

test("planStepSteer：形状那一步不吃掉『说查过而没查』的额度", () => {
  // 实机 2026-09-22 真人轮：第 1 步她报了个没有出处的数字（形状），第 2 步才说
  // "搜索没搜到任何相关记忆"（假阴性）。旧实现里第 1 步那次 steer 顺手把第二条额度
  // 置真，于是第 2 步那句直接交付——而库里那 10 条活记忆都还在。
  const first = planStepSteer(steerInput);
  assert.equal(first.steer, true);
  assert.equal(first.consumeAction, true);
  assert.equal(first.consumeLookup, false, "这次不是为假阴性补的，不许花那条额度");

  const second = planStepSteer({
    ...steerInput,
    hasUnverifiedClaims: false,
    lookupClaim: true,
    actionSteerAttempts: first.consumeAction ? 1 : 0,
    lookupClaimSteered: first.consumeLookup,
  });
  assert.equal(second.steer, true, "第 2 步的假阴性必须还有额度可拦");
  assert.equal(second.consumeLookup, true);
  assert.equal(second.swapToFallback, true, "假阴性那一步要换兜底模型：同档再说一遍还是会说不查");
});

test("planStepSteer：工具真跑过 / 已是强制收尾步 → 一律不补", () => {
  assert.equal(planStepSteer({ ...steerInput, toolCallCount: 1 }).steer, false);
  assert.equal(planStepSteer({ ...steerInput, finalAnswerOnly: true }).steer, false);
  assert.equal(planStepSteer({ ...steerInput, withinBudget: false }).steer, false);
  assert.equal(planStepSteer({ ...steerInput, hasUnverifiedClaims: false }).steer, false,
    "没命中任何一类就不该白烧一步");
});

test("编辑请求只读过正文仍须推进，写入有失败或未知回执时不重复执行", () => {
  const input = { ...steerInput, userAskedForAction: true, toolCallCount: 4,
    hasUnverifiedClaims: false, actionResultRecorded: false };
  assert.equal(planStepSteer(input).steer, true);
  assert.equal(planStepSteer({ ...input, actionResultRecorded: true }).steer, false);
  const messages = [{ role: "assistant" as const, content: "", toolCalls: [{ id: "read", name: "companion_read_note", arguments: {} }] },
    { role: "tool" as const, toolCallId: "read", content: JSON.stringify({ ok: true }) }];
  assert.equal(companionActionResultRecorded(messages, ["companion_edit_note"]), false);
  for (const status of ["succeeded", "failed", "outcome_unknown", "not_executed"]) {
    assert.equal(companionActionResultRecorded([...messages,
      { role: "assistant", content: "", toolCalls: [{ id: "edit", name: "companion_edit_note", arguments: {} }] },
      { role: "tool", toolCallId: "edit", content: JSON.stringify({ status }) }], ["companion_edit_note"]), true);
  }
});

test("planStepSteer：额度用尽后不再重复补同一条", () => {
  assert.equal(planStepSteer({ ...steerInput, actionSteerAttempts: 1, actionSteerBudget: 1 }).steer, false);
  assert.equal(planStepSteer({
    ...steerInput, hasUnverifiedClaims: false, lookupClaim: true, lookupClaimSteered: true,
  }).steer, false);
});

// ─── #8 终答步 provider 违约的两条 fail-open 出口 ────────────────────────
/** 三个条件都满足：预算 4（合同上限 8）、剩余时间够、工具名都在面上。 */
const withheldStep = {
  graceAlreadyUsed: false,
  unknownToolNames: [] as string[],
  remainingMs: 60_000,
  stepBudget: 4,
};

test("planWithheldFinalStepCalls：宽限一次，且多给的是两步（跑工具 + 强制收尾）", () => {
  assert.equal(planWithheldFinalStepCalls(withheldStep), "grace");
  // 只加一步的话那一步依旧满足 `stepCount >= 步数预算`，工具仍然不在面上——
  // 白走一步、她还是要拿这句话收尾。
  assert.equal(planWithheldFinalStepCalls({ ...withheldStep, graceAlreadyUsed: true }), "deliver",
    "宽限整轮只给一次，provider 反复违约时步数上界必须是确定的");
});

test("planWithheldFinalStepCalls：预算、时限、未知工具任一不满足就按已说文本交付", () => {
  // 合同上限 8 步：6 + 2 = 8 仍在界内，7 就越界。
  assert.equal(planWithheldFinalStepCalls({ ...withheldStep, stepBudget: 6 }), "grace");
  assert.equal(planWithheldFinalStepCalls({ ...withheldStep, stepBudget: 7 }), "deliver");
  // 时间线是边界值本身：低于它宁可直接交付，也不要跑到一半被预算拦停。
  assert.equal(planWithheldFinalStepCalls({ ...withheldStep, remainingMs: 20_000 }), "grace");
  assert.equal(planWithheldFinalStepCalls({ ...withheldStep, remainingMs: 19_999 }), "deliver");
  assert.equal(planWithheldFinalStepCalls({ ...withheldStep, unknownToolNames: ["companion_x"] }), "deliver",
    "她没被给到的工具不能借宽限这一步混进来执行");
});

// ─── §12.3 笔记检索：逐词命中，不是整串子串 ──────────────────────────────
test("noteSearchTerms：实机那句检索词切成两个词", () => {
  // 她按摘要里的名字去搜《欧姆定律生成验收》，用的词是"欧姆定律 生成验收"——
  // 整串 `%…%` 在这篇笔记的标题里匹配不上，工具回了"没有找到"。
  assert.deepEqual(noteSearchTerms("欧姆定律 生成验收"), ["欧姆定律", "生成验收"]);
  assert.deepEqual(noteSearchTerms("  多个   空格\t也算一个  "), ["多个", "空格", "也算一个"]);
});

test("noteSearchTerms：剥掉 LIKE 的通配符，别让模型自己拼通配查询", () => {
  assert.deepEqual(noteSearchTerms("100% 复习_巩固"), ["100", "复习巩固"]);
});

test("noteSearchTerms：词数封顶", () => {
  const many = noteSearchTerms(Array.from({ length: 12 }, (_, i) => `词${i}`).join(" "));
  assert.equal(many.length, NOTE_SEARCH_MAX_TERMS);
  assert.equal(many[0], "词0");
});

test("noteSearchTerms：空检索词返回空数组（调用方据此短路，不许放 %% 进 SQL）", () => {
  assert.deepEqual(noteSearchTerms("   "), []);
  assert.deepEqual(noteSearchTerms("%%% ___"), []);
});

/**
 * `companion_read_current_page`（doc 37：通用读页面）。
 *
 * 这一组用例钉的不是"能不能读到"，而是**读不到的时候她说什么**。触发它的实机事故：
 * 用户问"为啥第四张学习卡这么慢"，她调了 `list_task_queue`（查 `learning_tasks`，
 * 与卡片生成那套 `card_generation_*` 表毫无关系）拿到"当前没有排着的任务"，
 * 于是把一个真而无关的读数推成"系统这边没在跑东西，慢在模型/网络"。
 * 所以这里每条否定式断言都在钉：没有页面证据时不许给出结论性说法。
 */

const GENERATING_VIEW = {
  pageId: "card_generation_progress",
  title: "把《IndexTTS 2.5 让声音跨越语言》整理成学习卡",
  statusLine: "正在编写候选 · 正在生成 · 写完一批一次给齐",
  metrics: [{ label: "进度", value: "已写出 3 / 4 张候选" }],
  items: [
    { ordinal: 1, label: "提取线索", state: "卡型 · 主动回忆" },
    { ordinal: 2, label: "重传触发", state: "卡型 · 机制解释" },
    { ordinal: 3, label: "多语言覆盖", state: "卡型 · 机制解释" },
  ],
};

function pageRow(overrides: Partial<{
  page_kind: string;
  sensitivity: string;
  readable_view: unknown;
  content_age_seconds: number;
}> = {}) {
  return {
    page_kind: "note",
    sensitivity: "normal",
    readable_view: GENERATING_VIEW,
    content_age_seconds: 7,
    ...overrides,
  };
}

test("read_current_page：这一页没登记可读内容时，说的是「读不到」而不是「没在跑」", () => {
  const empty = currentPageToolResult(null);
  assert.equal(empty.value.available, false);
  assert.equal(empty.value.reason, "no_live_page");
  assert.match(empty.safeSummary, /没有可读的内容/);
  // 上一次错就错在她把"队列里没有任务"当成了"这一屏没在跑东西"——这一行里
  // 不许出现任何关于队列/任务/系统状态的断言。
  assert.ok(!/任务|队列|没在跑|没有跑/.test(empty.safeSummary), empty.safeSummary);
});

test("read_current_page：屏上的序号与「已写出 3 / 4」原样带出，第四张能落地成条目", () => {
  const result = currentPageToolResult(pageRow());
  assert.equal(result.value.available, true);
  const items = result.value.items as Array<{ ordinal: number; label: string }>;
  assert.deepEqual(items.map((item) => item.ordinal), [1, 2, 3]);
  // 用户说的"第四张"必须能从这份数据里被说出来：屏上只有 3 条、计划 4 条。
  assert.equal(items.length, 3);
  assert.equal((result.value.metrics as Array<{ value: string }>)[0].value, "已写出 3 / 4 张候选");
  assert.equal(result.value.contentAgeSeconds, 7);
  assert.match(result.safeSummary, /正在看「/);
});

test("read_current_page：正式作答页只报条目数，题目正文由服务端丢掉", () => {
  const result = currentPageToolResult(pageRow({
    page_kind: "learning_run",
    sensitivity: "formal_assessment",
  }));
  assert.equal(result.value.available, true);
  assert.equal(result.value.items, undefined, "服务端必须丢条目正文，而不是指望客户端不发");
  assert.equal(result.value.itemsOmitted, true);
  assert.equal(result.value.itemCount, 3);
});

test("read_current_page：凭证页整块拒读，并落成 40b §3.2 的 unavailable", () => {
  // 抛错而不是返回 `available:false` 的载荷：账本、页面文案与模型必须看到
  // **同一个**运行身份。塞在 payload 里的话，账本记 succeeded、页面显示
  // 「读成功」，只有模型知道拿不到——0349 之前 not_executed 被压成 failed
  // 就是同一种病。
  assert.throws(
    () => currentPageToolResult(pageRow({ sensitivity: "credential_surface" })),
    (error: unknown) => {
      assert.ok(error instanceof CompanionToolUnavailableError);
      assert.equal(classifyCompanionToolFailure(error, "read", true).status, "unavailable");
      assert.match(error.message, /凭据/);
      return true;
    },
  );
});

test("read_current_page：落库的视图对不上合同 → unavailable，不递半份形状", () => {
  assert.throws(
    () => currentPageToolResult(pageRow({
      readable_view: { pageId: "x", title: "缺 items 上限外的字段", unexpected: "leak" },
    })),
    (error: unknown) => {
      assert.ok(error instanceof CompanionToolUnavailableError);
      assert.equal(classifyCompanionToolFailure(error, "read", true).status, "unavailable");
      assert.match(error.message, /还没有登记可读内容/);
      // 半份形状一个字都不许漏出去——这是它当初被拒的原因。
      assert.doesNotMatch(error.message, /leak/);
      return true;
    },
  );
});

test("read_current_page：`no_live_page` **不**抛 —— 那不是能力不可用", () => {
  // 40b §3.2 的 unavailable 是「所需资源或能力不可用」。根本没有页面时
  // 说"现在没有"，不是"这个能力不可用"；抛出去会让医生与页面显示错类别。
  const result = currentPageToolResult(null);
  assert.equal(result.value.available, false);
  assert.equal(result.value.reason, "no_live_page");
});

test("read_current_page：工具已注册、是读类、只读权限下也给她", () => {
  const definition = getCompanionAgentTool("companion_read_current_page");
  assert.ok(definition, "工具没进注册表");
  assert.equal(definition.riskClass, "read");
  assert.equal(definition.requiresConfirmation, false);
  assert.ok(
    resolveAllCompanionAgentTools("read_only").some((tool) => tool.name === "companion_read_current_page"),
    "只读权限下也应该能读页面",
  );
});

// ── 39d W2-4：动作通道收口（P3-alt + `tools`/`tool_choice` 那对不变量） ─────

test("required tool_choice 不受支持时，同一请求只切一次跨模型兜底", async () => {
  const request = {
    role: "companion_agent",
    systemPrompt: "测试",
    messages: [{ role: "user", content: "打开笔记" }],
    tools: [{ name: "companion_read_context", description: "读取上下文", parameters: {} }],
    toolChoice: "required",
    maxTokens: 100,
    temperature: 0.4,
  } as AgentTurnRequest;
  const signal = new AbortController().signal;
  const unsupported = new ProviderRequestError({
    provider: "openai_compatible",
    status: 400,
    providerCode: "MODEL_TOOL_CHOICE_NOT_SUPPORTED",
  });
  let primaryCalls = 0;
  let fallbackCalls = 0;
  let fallbackNotice: ProviderRequestError | undefined;
  const primary = {
    id: "openai_compatible",
    modelId: "qwen3.8-flash",
    executeAgentTurn: async (actualRequest: AgentTurnRequest, actualSignal?: AbortSignal) => {
      primaryCalls += 1;
      assert.strictEqual(actualRequest, request);
      assert.strictEqual(actualSignal, signal);
      throw unsupported;
    },
  } as unknown as AIProvider;
  const fallback = {
    id: "openai_compatible",
    modelId: "THUDM/GLM-4-9B-0414",
    executeAgentTurn: async (actualRequest: AgentTurnRequest, actualSignal?: AbortSignal) => {
      fallbackCalls += 1;
      assert.strictEqual(actualRequest, request, "fallback 必须保留 tools 与 toolChoice 原样");
      assert.equal(actualRequest.toolChoice, "required");
      assert.ok(actualRequest.tools.length > 0);
      assert.strictEqual(actualSignal, signal);
      return {
        content: null,
        toolCalls: [{ id: "call_1", name: "companion_read_context", arguments: {} }],
        finishReason: "tool_calls",
        usage: null,
        providerRequestId: null,
      } as AgentTurnResult;
    },
  } as unknown as AIProvider;

  const execution = await executeCompanionAgentTurnWithToolChoiceFallback({
    request,
    provider: primary,
    fallbackProvider: fallback,
    signal,
    executeTurn: (provider, request, callSignal) => provider.executeAgentTurn!(request, callSignal),
    onFallback: (error) => { fallbackNotice = error; },
  });

  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 1);
  assert.strictEqual(fallbackNotice, unsupported);
  assert.strictEqual(execution.provider, fallback);
  assert.equal(execution.result.toolCalls?.length, 1);
});

test("工具兜底只处理 required 能力错误，不吞其他错误或同模型配置", async () => {
  const baseRequest = {
    role: "companion_agent",
    systemPrompt: "测试",
    messages: [{ role: "user", content: "打开笔记" }],
    tools: [{ name: "companion_read_context", description: "读取上下文", parameters: {} }],
    toolChoice: "required",
    maxTokens: 100,
    temperature: 0.4,
  } as AgentTurnRequest;
  const unsupported = new ProviderRequestError({
    provider: "openai_compatible", status: 400, providerCode: "MODEL_TOOL_CHOICE_NOT_SUPPORTED",
  });
  const cases: Array<{ label: string; request: AgentTurnRequest; error: Error; fallbackModelId: string }> = [
    { label: "auto 请求", request: { ...baseRequest, toolChoice: "auto" }, error: unsupported, fallbackModelId: "other-model" },
    {
      label: "其他 provider 错误",
      request: baseRequest,
      error: new ProviderRequestError({ provider: "openai_compatible", status: 429, providerCode: "RATE_LIMITED" }),
      fallbackModelId: "other-model",
    },
    { label: "同模型", request: baseRequest, error: unsupported, fallbackModelId: "qwen3.8-flash" },
    { label: "空工具面", request: { ...baseRequest, tools: [] }, error: unsupported, fallbackModelId: "other-model" },
  ];

  for (const testCase of cases) {
    let fallbackCalls = 0;
    const primary = {
      id: "primary", modelId: "qwen3.8-flash",
      executeAgentTurn: async () => { throw testCase.error; },
    } as unknown as AIProvider;
    const fallback = {
      id: "fallback", modelId: testCase.fallbackModelId,
      executeAgentTurn: async () => {
        fallbackCalls += 1;
        return {
          content: "unexpected",
          toolCalls: [],
          finishReason: "stop",
          usage: null,
          providerRequestId: null,
        } as AgentTurnResult;
      },
    } as unknown as AIProvider;

    await assert.rejects(
      executeCompanionAgentTurnWithToolChoiceFallback({
        request: testCase.request,
        provider: primary,
        fallbackProvider: fallback,
        signal: new AbortController().signal,
        executeTurn: (provider, request, signal) => provider.executeAgentTurn!(request, signal),
      }),
      (error) => error === testCase.error,
      testCase.label,
    );
    assert.equal(fallbackCalls, 0, testCase.label);
  }
});

test("分类器不可用时不强制工具，不继承历史执行授权", async () => {
  // null 是分类未完成，不强制动作：她这一轮不必去调工具，也不因为上一轮办过事就接着办。
  // 工具面不在这条判据里（2026-10-09）——读不到判定时，她照样拿到权限档允许的全部工具。
  assert.equal(companionStepRequiresTool(null), false, "意图未知不强制工具，也不继承旧任务授权");
  assert.equal(companionStepRequiresTool(false), false, "明确说了不要工具，就别强制");
  assert.equal(companionStepRequiresTool(true), true);

  // 上面那句是判据，这一句是**"读不到真的会发生"**：provider 炸了的时候
  // `interpretCompanionTurn` 保留 uncertain（不是否认需要工具）。两头接起来才是 fail-closed。
  const broken = {
    chatCompletion: async () => {
      throw new Error("provider down");
    },
  } as unknown as AIProvider;
  const decision = await interpretCompanionTurn(broken, [{ role: "user", content: "帮我把那篇笔记打开" }], toolIntentTaskContext());
  assert.equal(decision.toolUse, "uncertain", "解释失败要留在不确定，不能悄悄判成闲聊");
  assert.equal(companionStepRequiresTool(null), false);
});

test("不变量：任何一步都不许同时出现 tools:[] 与 toolChoice:\"required\"", () => {
  const offered = [{ name: "companion_read_context", description: "读上下文", parameters: {} }];
  const step = (finalAnswerOnly: boolean, requiresTool: boolean, toolCallCount: number, tools = offered) =>
    companionStepToolShape({ tools, finalAnswerOnly, requiresTool, toolCallCount });

  // 该强制的那一格真的要强制（否则下面那条"从不违规"可以靠"从不 required"糊过去）。
  assert.equal(step(false, true, 0).toolChoice, "required");
  assert.equal(step(false, false, 0).toolChoice, "auto", "没让她做事就别逼模型编一个工具调用");
  assert.equal(step(false, true, 1).toolChoice, "auto", "已经调过工具了，第二步该让她说话");
  assert.equal(step(true, true, 0).tools.length, 0, "终答步必须收走工具面");
  assert.equal(step(true, true, 0).toolChoice, "auto", "收走工具面的那一步绝不能再要求必须调工具");

  // 穷举四个入参的全部组合——"不许同时出现"是一句对**所有**输入成立的话，
  // 只挑几个例子等于没验（P3-alt 之后 requiresTool 为真的轮次变多，这一对
  // 一旦在某个没想到的组合里成立，就是每轮 400）。
  let pairs = 0;
  for (const hasTools of [true, false]) {
    for (const finalAnswerOnly of [true, false]) {
      for (const requiresTool of [true, false]) {
        for (const toolCallCount of [0, 1]) {
          const shape = step(finalAnswerOnly, requiresTool, toolCallCount, hasTools ? offered : []);
          pairs += 1;
          assert.ok(
            !(shape.tools.length === 0 && shape.toolChoice === "required"),
            `tools:[] 配 required（hasTools=${hasTools} final=${finalAnswerOnly} requires=${requiresTool} calls=${toolCallCount}）`,
          );
        }
      }
    }
  }
  assert.equal(pairs, 16);
});

test("mock 守 provider 合同：required 必回工具调用，工具面为空则当场炸", async () => {
  // 39b §9.5：mock 以前**完全不理** `toolChoice`，所以"required 生效了"这类断言全是空转。
  const mock = new MockProvider();
  const base = {
    role: "companion_agent" as const,
    systemPrompt: "s",
    messages: [{ role: "user" as const, content: "帮我把那篇笔记打开" }],
    maxTokens: 100,
    temperature: 0.4,
  };
  const forced = await mock.executeAgentTurn({
    ...base,
    tools: [{ name: "companion_read_context", description: "读上下文", parameters: {} }],
    toolChoice: "required",
  });
  assert.equal(forced.toolCalls.length, 1, "required 这一档必须回一个工具调用");
  assert.equal(forced.content, null, "required 那一档不产正文（宁可安静几秒）");

  // 会红的那一格要**只**由 toolChoice 决定：上面那条在"没读过工具结果"时本来就会回
  // 工具调用（mock 的默认剧本），拿它当证据等于什么都没测。这一步先喂一条工具结果
  // ——没有 required 时 mock 会照实回正文收尾，有了 required 就必须继续调工具。
  const afterToolResult = await mock.executeAgentTurn({
    ...base,
    messages: [
      ...base.messages,
      // `content: ""` 而不是 null：内部 `AgentMessage` 的形状是 string|parts，
      // 这里要表达的"这一步没有正文"用空串就够，mock 也只看有没有 tool 消息。
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "companion_read_context", arguments: {} }] },
      { role: "tool", content: "已读取：{notes:[]}", toolCallId: "c1" },
    ],
    tools: [{ name: "companion_read_context", description: "读上下文", parameters: {} }],
    toolChoice: "required",
  });
  assert.equal(afterToolResult.toolCalls.length, 1,
    "required 在'已经读过一次工具结果'那一步也必须生效（否则这一档根本没被实现）");
  const autoInstead = await mock.executeAgentTurn({
    ...base,
    messages: [
      ...base.messages,
      // `content: ""` 而不是 null：内部 `AgentMessage` 的形状是 string|parts，
      // 这里要表达的"这一步没有正文"用空串就够，mock 也只看有没有 tool 消息。
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "companion_read_context", arguments: {} }] },
      // 带 `safeSummary`：mock 现在只取那一格回话（原样回显工具结果会把工具面里
      // 流通的裸 uuid 搬进正文，`internal_token_leak` 拦下、整轮终止）。
      { role: "tool", content: JSON.stringify({ value: { notes: [] }, safeSummary: "已读取：没有待读笔记" }), toolCallId: "c1" },
    ],
    tools: [{ name: "companion_read_context", description: "读上下文", parameters: {} }],
    toolChoice: "auto",
  });
  assert.equal(autoInstead.toolCalls.length, 0, "auto 那一档不该被 mock 偷偷升级成必调工具");
  // **判的是"她跟着工具结果换了话"，不是那一句的字面**——原来钉的是
  // `已读取伴星工具结果` 这个串，而它正是被移除的**原样回显**。钉字面等于
  // 把"回显工具结果"当成了 mock 的合同。
  assert.match(String(autoInstead.content), /已读取：没有待读笔记/,
    "她拿到工具结果之后说的话没跟着变：这一档是固定文案，答不出她真的读了工具");
  assert.ok(!/已读取伴星工具结果/.test(String(autoInstead.content)),
    "她把工具结果原样搬进了正文：工具面里流通的东西会从她嘴里出去");

  // 那一对的真实形状就是 400：mock 必须**跟着炸**，否则将来谁把这对拼出来，
  // 测试只会显示成"模型没听话"，归因直接归错。
  await assert.rejects(
    () => mock.executeAgentTurn({ ...base, tools: [], toolChoice: "required" }),
    /tool_choice=required 但工具面为空/,
  );

  // 分类器那一支也必须回合同形状。以前它回的是 `{"status":"mock"}`——合法 JSON、
  // 没有 needsTool 键 ⇒ 每个 mock 驱动的用例都站在"读不到"那一格上。
  const judged = await mock.chatCompletion([
    { role: "system", content: "本轮注意力解释包含 goalObjectIndex，输出完整结构合同" },
    { role: "user", content: "帮我复习光合作用" },
  ], { maxTokens: 60, temperature: 0, responseFormat: "json_object" });
  assert.equal(JSON.parse(judged.content).toolUse, "none");
  const judgedAction = await mock.chatCompletion([
    { role: "system", content: "本轮注意力解释包含 goalObjectIndex，输出完整结构合同" },
    { role: "user", content: "打开那篇笔记【mock:wants-tool】" },
  ], { maxTokens: 60, temperature: 0, responseFormat: "json_object" });
  assert.equal(JSON.parse(judgedAction.content).toolUse, "act");
  assert.equal((await interpretCompanionTurn(mock, [
    { role: "user", content: "打开那篇笔记【mock:wants-tool】" },
  ], toolIntentTaskContext())).toolUse, "act", "整条链（mock 答复 → 分类器解析）要接得上");
});

/**
 * 工具面装配守卫（2026-10-09 线上）。
 *
 * 用户说「生成一片新笔记，然后开启共享」，她回「这一轮我手上新建笔记没有入口」，
 * 下一轮又改口"入口有，我说错了"。查出来不是她撒谎：那一轮 `companion_create_note`
 * **确实没被发给她**。共享没有对应能力 ⇒ 分类器记下一条歧义 ⇒ act 被降成 uncertain
 * （agent-core/runtime/attention.ts:40）⇒ 运行时按 uncertain 把全部写类工具摘掉。
 * 一个做不到的请求否掉了做得到的那个，而她只能照自己看到的那份清单说话。
 *
 * 本仓库这份契约其实早就写在两处：`companion-agent-registry.ts` 的
 * "filtered by current permissions and data-egress policy"，以及本文件开头那句
 * "工具面：每轮全给、只按权限档过滤"。这里把它钉住，因为它是**装配形状**上的性质，
 * 单测跑不到整条循环（循环归 postgres 集成测）。
 */
test("工具面只由权限档与数据外发政策装配，不再被本轮判定摘除", () => {
  const source = readFileSync(new URL("../companion-agent-runtime.ts", import.meta.url), "utf8");
  assert.match(source,
    /const availableDefinitions = resolveAllCompanionAgentTools\(meta\.permissionLevel, event\.constraints\)/,
    "工具面必须来自那份按声明过滤的目录，不是另起一处清单");
  const assembly = /^  const definitions = ([^;]+);$/m.exec(source);
  assert.ok(assembly, "找不到工具面装配那一句（形状变了，这条判据要先跟着改）");
  assert.equal(assembly[1].trim(), "availableDefinitions",
    `工具面又被加了筛选（${assembly[1].trim()}）：能不能被她看见只该由权限档与外发政策决定，`
    + "要不要真写由 riskClass、确认门与执行侧复核决定");
});
