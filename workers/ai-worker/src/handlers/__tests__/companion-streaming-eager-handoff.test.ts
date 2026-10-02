/**
 * provider → 流式步骤 这条转接（40b §4.1-1 / R7）。
 *
 * ## 这一层为什么值得单独钉
 *
 * `runStreamingAgentStep` 是"provider 的流"与"运行时"之间那一层。R7 的判据全在
 * provider 那边（见 `openai-compatible-eager-dispatch.test.ts`），但**没有任何东西**
 * 把那些"已完整"的格子送到运行时去——中间缺的就是这一跳。
 *
 * 这一层自己不做派发（那要落账本、要连库），只**转发**。少转发一跳与多转发一跳，
 * 在真机上都表现为"提前派发好像没生效"，所以它值得一条判据。
 *
 * ## 最要紧的那条：转发**不许被 await**
 *
 * 回调是在 SSE 读取循环里被调的。那里 `await` 一下，整条流就停在那里等数据库——
 * 模型的下一个字永远吐不出来，而 R7 的全部意义就是"生成继续、工具并行"。
 * 一旦有人顺手写上 `await`，症状是**整个伴星变卡**，而且没有报错。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { runStreamingAgentStep } from "../companion-agent-streaming-step.ts";
import type { AIProvider } from "../../lib/ai-provider.ts";

// 形状取自 companion-agent-runtime.test.ts 里那份（它已经跑通了这条链）。
const STEP_REQUEST = {
  role: "companion_agent",
  systemPrompt: "测试 system",
  messages: [{ role: "user" as const, content: "打个招呼" }],
  tools: [],
  maxTokens: 700,
  temperature: 0.9,
} as never;

/**
 * 一个会**逐格吐工具调用**的 provider。
 *
 * 它自己按 `onToolCallSettled` 的存在与否决定报不报，所以顺带就验了
 * 「调用方不要时，provider 不多做事」。
 */
function toolStreamingProvider(fragments: { index: number; id: string; name: string; args: string }[]): AIProvider {
  return {
    id: "stub",
    modelId: "stub-model",
    visionModelId: "stub-model",
    promptVersion: "test",
    chatCompletion: async () => { throw new Error("not used"); },
    executeAgentTurn: async () => { throw new Error("not used"); },
    chatCompletionStream: async (
      _messages: unknown,
      options: { onToolCallSettled?: (slot: { index: number; id: string; name: string; argsText: string }) => void },
      _signal: AbortSignal | undefined,
      onDelta: (delta: string) => void,
    ) => {
      let max = -1;
      for (const fragment of fragments) {
        if (fragment.index > max) max = fragment.index;
        options.onToolCallSettled?.({
          index: fragment.index,
          id: fragment.id,
          name: fragment.name,
          argsText: fragment.args,
        });
      }
      onDelta("答完了");
      return { content: "答完了", toolCalls: fragments, finishReason: "tool_calls" };
    },
  } as unknown as AIProvider;
}

async function run(
  provider: AIProvider,
  onToolCallSettled?: (slot: { index: number; id: string; name: string; argsText: string }) => void,
) {
  return runStreamingAgentStep({
    provider,
    stepRequest: STEP_REQUEST,
    ctxSignal: new AbortController().signal,
    timeoutMs: 5_000,
    onProviderDelta: async () => true,
    ...(onToolCallSettled ? { onToolCallSettled } : {}),
  } as never);
}

test("provider 判定的每一格都原样转到了运行时那一侧", async () => {
  const seen: number[] = [];
  await run(
    toolStreamingProvider([
      { index: 0, id: "c0", name: "companion_read_note", args: '{"noteId":"n1"}' },
      { index: 1, id: "c1", name: "companion_read_context", args: "{}" },
    ]),
    (slot) => seen.push(slot.index),
  );
  assert.deepEqual(seen, [0, 1], "有一格没有转出去 —— 那就是提前派发看起来没生效");
});

test("不传这个回调时，流照常跑完（默认关闭的姿态）", async () => {
  const result = await run(toolStreamingProvider([
    { index: 0, id: "c0", name: "companion_read_note", args: "{}" },
  ]));
  assert.equal(result.content, "答完了");
});

/** 读步骤源码并**剥掉注释**——否则这条判据会读到自己写的说明。 */
function stepSourceWithoutComments(): string {
  return readFileSync(resolve(import.meta.dirname, "..", "companion-agent-streaming-step.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

test("转发**不许被 await** —— 那里停一下，整条流就按在那儿等数据库", () => {
  const code = stepSourceWithoutComments();
  const awaited = /await\s*\(?\s*args\.onToolCallSettled/.test(code);
  assert.equal(awaited, false,
    "转发那里出现了 await：流会在那里停住，伴星变卡而且不报错。");
  // 正控制：转发本身必须在（否则上面那条是恒真的）
  assert.ok(code.includes("args.onToolCallSettled"), "转发那行不见了 —— 第 1 条就成��恒真");
});

test("【自证】判据认得出「顺手写个 await」这个真实退化", () => {
  const degraded = "onToolCallSettled: async (slot) => { await args.onToolCallSettled(slot) }";
  assert.ok(/await\s*\(?\s*args\.onToolCallSettled/.test(degraded),
    "自证样本没造好：退化形状本该被上面那条判据逮住");
  const code = stepSourceWithoutComments();
  assert.ok(!/await\s*\(?\s*args\.onToolCallSettled/.test(code),
    "自证：当前确实没有 await，所以判据今天是绿的");
});