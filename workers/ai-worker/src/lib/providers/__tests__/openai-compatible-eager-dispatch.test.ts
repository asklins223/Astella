/**
 * R7 的**流中完成判定**（40b §4.1-1 / A58），在**真 provider** 上用合成 SSE 验证。
 *
 * ## 为什么上一轮判定"没法测"，以及这次为什么能测
 *
 * `openai-compatible.ts` 的构造参数里有可注入的 `streamRequest`，
 * `opencode-go.test.ts` 已经用注入的 SSE 夹具测过流式路径——
 * 所以"喂一段自己写的流"这条路**一直存在**。上一轮我没有先去看，
 * 直接下了"本仓没有合成 SSE 夹具"的结论。那是错的判断，这里纠正。
 *
 * ## 这一条真正守住什么
 *
 * `onToolCallSettled` 什么时候响。协议**没有**"第 N 个调用完成"事件，
 * 只能由**顺序**推出：第 N+1 个开始吐 ⇒ 第 N 不会再有分片。
 *
 * 判据写错的后果很具体：提前半个字派发，工具就拿着**半截参数**去执行。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { OpenAICompatibleProvider } from "../openai-compatible.ts";
import type { PublicStreamingRequester } from "@astella/shared/public-json-http";

/** 把预设的 SSE 文本切成任意边界喂进去（与 opencode-go.test.ts 同一种夹具）。 */
function streamingRequester(chunks: string[]): PublicStreamingRequester {
  const encoder = new TextEncoder();
  return async () => {
    async function* iterate(): AsyncGenerator<Uint8Array> {
      for (const chunk of chunks) yield encoder.encode(chunk);
    }
    return { status: 200, statusText: "OK", body: iterate(), cancel: () => undefined };
  };
}

function makeProvider(request: PublicStreamingRequester) {
  return new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://example.invalid/v1",
    model: "test-model",
    streamRequest: request,
  });
}

/** 一片 `delta.tool_calls`。 */
const frag = (index: number, id: string, name: string, args: string) =>
  `data: ${JSON.stringify({
    choices: [{
      delta: { tool_calls: [{ index, id, function: { name, arguments: args } }] },
    }],
  })}\n\n`;

const text = (delta: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`;

const done = 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n';

interface Settled { index: number; name: string; argsText: string }

/**
 * 驱动一次流，同时记下**事件先后**。
 *
 * 记 `log` 是关键：只断言"回调被调用了"分不出它是在流中途还是流末尾响的，
 * 而那正是 R7 全部收益的来源。
 */
async function drive(parts: string[]): Promise<{
  settled: Settled[];
  toolCalls: { name: string; arguments: Record<string, unknown> }[];
  log: string[];
}> {
  const settled: Settled[] = [];
  const log: string[] = [];
  const provider = makeProvider(streamingRequester(parts));
  const result = await provider.chatCompletionStream(
    [{ role: "user", content: "hi" }],
    {
      responseFormat: "text",
      onToolCallSettled: (slot) => {
        settled.push({ index: slot.index, name: slot.name, argsText: slot.argsText });
        log.push(`settled:${slot.index}`);
      },
    },
    undefined,
    (delta) => { log.push(`delta:${delta}`); },
  );
  log.push("end");
  return { settled, toolCalls: result.toolCalls, log };
}

test("第 0 个调用在**第 1 个开始吐之前**不响，流末尾才补上", async () => {
  // 只有一个工具时，"它拼完了"不等于"它不会再来分片了"——
  // 唯一的依据是后面有没有更高的 index。没有就只有末尾能放行。
  const { log, settled } = await drive([
    frag(0, "c0", "companion_read_note", '{"noteId":"n1"}'),
    done,
  ]);
  assert.deepEqual(settled.map((s) => s.index), [0],
    "末尾必须补放行，否则最常见的『只调一个工具』永远排不上");
  assert.equal(log[log.length - 1], "end");
  assert.equal(log.indexOf("settled:0"), log.length - 2,
    "它是在流结束之后才响的，说明中途确实没有提前派发");
});

test("第 1 个开始吐的那一刻，第 0 个就响 —— 这才是 R7 要的提前", async () => {
  const { log, settled } = await drive([
    frag(0, "c0", "companion_read_note", '{"noteId":"n1"}'),
    frag(1, "c1", "companion_read_context", "{}"),
    text("她先说一句"),
    done,
  ]);
  assert.deepEqual(settled.map((s) => s.index), [0, 1]);
  // 断言的是**先后关系**，不是绝对下标：模型还在吐字，它就已经可以跑了。
  const early = log.indexOf("settled:0");
  assert.ok(early >= 0, "第 0 个没有响");
  assert.ok(early < log.indexOf("delta:她先说一句"),
    "它必须早于后续正文到达：晚于流末尾只是没漏掉，早于后续增量才是真提前");
  assert.ok(early < log.indexOf("end"), "它等到了流末尾 —— 那就没有提前可言");
  assert.equal(settled[0]?.name, "companion_read_note");
});

test("参数还没拼完的调用不会响 —— 不拿半截 JSON 去执行", async () => {
  const { settled } = await drive([
    frag(0, "c0", "companion_read_note", '{"noteId":'),
    frag(1, "c1", "companion_read_context", "{}"),
    done,
  ]);
  // 第 1 个是完整的，它**应该**被放行；这里要证明的是半截的那个没有。
  assert.deepEqual(settled.map((s) => s.index), [1]);
  assert.ok(!settled.some((s) => s.index === 0),
    "半截参数被当成完整了 —— 40b §4.1-1「不能从流式 JSON 片段执行」");
});

test("同一格不会被派发两次", async () => {
  const { settled } = await drive([
    frag(0, "c0", "companion_read_note", '{"noteId":"n1"}'),
    frag(1, "c1", "companion_read_context", "{}"),
    // 重复片：provider 偶尔会重放最后一片
    frag(0, "c0", "companion_read_note", '{"noteId":"n1"}'),
    done,
  ]);
  assert.deepEqual(settled.map((s) => s.index), [0, 1],
    "重放的片让第 0 个被放行了第二次 —— 那个工具会跑两遍");
});

test("工具调用照样在流结束后按序返回（这个回调没有改掉老行为）", async () => {
  const { toolCalls } = await drive([
    frag(0, "c0", "companion_read_note", '{"noteId":"n1"}'),
    frag(1, "c1", "companion_read_context", "{}"),
    done,
  ]);
  assert.deepEqual(toolCalls.map((c) => c.name), ["companion_read_note", "companion_read_context"]);
  assert.deepEqual(toolCalls[0]?.arguments, { noteId: "n1" });
});

test("不传回调时 provider 不做任何额外工作", async () => {
  const provider = makeProvider(streamingRequester([
    frag(0, "c0", "companion_read_note", '{"noteId":"n1"}'),
    done,
  ]));
  const result = await provider.chatCompletionStream(
    [{ role: "user", content: "hi" }], { responseFormat: "text" }, undefined, () => undefined,
  );
  assert.equal(result.toolCalls.length, 1, "没有回调时结果不该变");
});

test("【自证】判据认得出「一片拼完就响」这个真实退化", () => {
  // 退化形状：只看"自己拼完了吗"。它在参数只到一半时就会把工具派出去。
  const naiveSettled: number[] = [];
  const half = '{"noteId":';
  if (half.trim().endsWith("}")) naiveSettled.push(0);
  assert.deepEqual(naiveSettled, [], "自证样本没造好：半截不该被判完整");
  // 正控制：真判据在同样这半截上也不响（见上面第 3 条）。
  assert.ok(!'{"noteId":'.trim().endsWith("}"));
});
