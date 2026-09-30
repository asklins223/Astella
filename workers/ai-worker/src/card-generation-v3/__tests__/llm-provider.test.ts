/**
 * 简化链真模型那一版的端口（`llm-provider.ts`）的单测——不碰数据库、不发网络。
 *
 * 要钉的四件都是"这一层不该做什么"：不多发一发（重试归内核）、不吞错（同一个小对象
 * 交回去，内核才能按 transport/timeout/output_shape 分类）、不组超时（内核那份 signal
 * 原样透传到底层 HTTP）、不解析 JSON（"什么算不合合同"只有 `tasks.ts` 一个答案）。
 *
 * **没有在这里量到的一件事**（写清比留白好）：整条链跑在真 transport 上的端到端读数。
 * 那要在集测里带假 transport 认领一条真 job，登记在 39d §19 与 w71 设计件的欠口里；
 * 今天这里只证到端口本身。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCardGenerationV3LlmProviders,
  type CardGenerationV3ChatTransport,
} from "../llm-provider.ts";
import type { ChatMessage, ChatOptions, ChatResult } from "@ailearn/shared";

interface Recorded {
  messages: ChatMessage[];
  options: ChatOptions;
  signal: AbortSignal | undefined;
}

function fakeTransport(responses: Array<ChatResult | Error>): {
  transport: CardGenerationV3ChatTransport;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  return {
    calls,
    transport: {
      modelId: "fake-v3-model",
      async chatCompletion(messages, options, signal): Promise<ChatResult> {
        calls.push({ messages, options, signal });
        const next = responses[calls.length - 1];
        if (!next) throw new Error(`测试桩：没有第 ${calls.length} 发的响应`);
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
}

test("一次 complete 恰好一发 chatCompletion，且把内核给的 signal 原样透传", async () => {
  const fake = fakeTransport([{ content: "{}", usage: {} }]);
  const port = createCardGenerationV3LlmProviders({ transport: fake.transport }).generate;
  const controller = new AbortController();
  await port.complete({ prompt: "提示词正文", input: {} as never, signal: controller.signal });
  assert.equal(fake.calls.length, 1, "这一层不许自己再补一发：重试与单步超时都归公共任务内核");
  assert.equal(fake.calls[0]?.signal, controller.signal,
    "内核那份已经合成过（调用方 abort × 单步超时）；这里再起一层就会把上界改写成两个来源");
  assert.deepEqual(fake.calls[0]?.messages, [{ role: "user", content: "提示词正文" }],
    "任务定义组好的那份提示原样发出去，不在端口里再拼一层系统角色");
  assert.deepEqual(
    { ...fake.calls[0]?.options },
    { temperature: 0, responseFormat: "json_object", disableThinking: true, maxTokens: 8000 },
    "采样取值与输出预算都要说死：第四发真模型就是被平台默认那一档 max_tokens 截断的"
    + "（报 `Unterminated string in JSON`、没有 zod 路径）",
  );
});

test("transport 抛错时交回的是同一个错误对象：不吞、不包装、不重试", async () => {
  const boom = new Error("provider 503");
  const fake = fakeTransport([boom]);
  const port = createCardGenerationV3LlmProviders({ transport: fake.transport }).check;
  await assert.rejects(() => port.complete({ prompt: "p", input: {} as never }),
    (error: unknown) => error === boom);
  assert.equal(fake.calls.length, 1, "错误在这一层不被重试，因此失败类别由内核一个人定");
});

test("用量交回上层记账：provider 没回传 usage 时是 undefined，不是 0", async () => {
  const withUsage = fakeTransport([{ content: "{}", usage: { promptTokens: 11, completionTokens: 7 } }]);
  const recorded = await createCardGenerationV3LlmProviders({ transport: withUsage.transport })
    .generate.complete({ prompt: "p", input: {} as never });
  assert.deepEqual({ text: recorded.text, prompt: recorded.promptTokens, completion: recorded.completionTokens },
    { text: "{}", prompt: 11, completion: 7 }, "token 要能进 §16.28 那本账，不能在这一层丢掉");
  const withoutUsage = fakeTransport([{ content: "{}", usage: {} }]);
  const bare = await createCardGenerationV3LlmProviders({ transport: withoutUsage.transport })
    .generate.complete({ prompt: "p", input: {} as never });
  assert.equal(bare.promptTokens, undefined,
    "0 与「没回传」是两件事：成本下界不完整时不许被读成一次免费调用");
});

test("端口不解析 JSON：合同解析只有 tasks.ts 一个地方", async () => {
  const fake = fakeTransport([{ content: "这不是 JSON，但端口不许在这里判", usage: {} }]);
  const result = await createCardGenerationV3LlmProviders({ transport: fake.transport })
    .rewrite.complete({ prompt: "p", input: {} as never });
  assert.equal(result.text, "这不是 JSON，但端口不许在这里判",
    "两处解析就会有两套「什么算不合合同」，失败类别随之分叉");
});
