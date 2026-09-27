/**
 * 制卡简化链（V3）的**真模型** provider（39d W7-1 欠口；39 §8.6）。
 *
 * 端口还是 `tasks.ts` 那一条：`complete({ prompt, input, signal })` ⇒
 * `{ text, promptTokens, completionTokens }`。确定性那一版（`deterministic.ts`）与
 * 这一版实现同一个端口，所以两条路共用同一段 execute、同一次合同解析、同一份程序
 * 校验——不是"测试走捷径、生产走另一条"。
 *
 * 三件刻意不做的事：
 *
 * - **不重试、不组超时**。这四发的重试与单步/整任务上界都归公共任务内核
 *   （`handler.ts` 的 `runV3TaskOnKernel`）。V2 那层的 `chatJson` 自带 2 次退避重试
 *   与 per-job 调用预算，复用它就会变成"内核对 V2 层再重试一次"＝一次合同形状
 *   失败最多放大成 3×2 发。一条判据不留两个来源。
 * - **不解析 JSON**。交回 `content` 原文，"什么算不合合同"由 `tasks.ts` 的合同解析
 *   唯一负责（两处解析就会有两套失败类别）。
 * - **不改写 signal**。内核给的那份已经合成过调用方 abort 与单步超时，这里原样透传，
 *   底层 HTTP 才真被中止。
 *
 * 采样取值与 V2 同方向：结构化 JSON 任务用 `responseFormat: "json_object"`、
 * `disableThinking: true`（V2 的实机记录：thinking 模型长 reasoning 会撑到单调用超时
 * 或 content 偶发为空），温度取 0——这一版要的是可复算，不是方差。
 */
import type { ChatMessage, ChatOptions, ChatResult } from "@ailearn/shared";
import type { AIProvider } from "../lib/ai-provider.ts";
import type {
  CardCandidateRewriteV3TaskInput,
  CardContentCheckV3TaskInput,
  CardGenerateV3TaskInput,
  CardGenerationV3ProviderPort,
} from "./tasks.ts";
import type { CardGenerationSimplifiedProviders } from "./handler.ts";

/**
 * 这一版真正依赖的那一小片 `AIProvider`。
 *
 * 写成窄接口而不是收整个 `AIProvider`，是为了让"真模型那条路今天被完整跑过一遍"
 * 这件事可以在不花钱、不起 HTTP 的前提下成立：测试交一份记录过响应的 transport，
 * 走的就是生产这一份 `complete` 实现（同一行 `chatCompletion` 调用、同一份 options）。
 */
export interface CardGenerationV3ChatTransport {
  readonly modelId: string;
  chatCompletion(
    messages: ChatMessage[],
    options: ChatOptions,
    signal?: AbortSignal,
  ): Promise<ChatResult>;
}

function chatCompletionPort<TInput>(
  transport: CardGenerationV3ChatTransport,
): CardGenerationV3ProviderPort<TInput> {
  const options: ChatOptions = {
    temperature: 0,
    responseFormat: "json_object",
    disableThinking: true,
  };
  return {
    modelId: transport.modelId,
    async complete({ prompt, signal }) {
      const messages: ChatMessage[] = [{ role: "user", content: prompt }];
      const result = await transport.chatCompletion(messages, options, signal);
      return {
        text: result.content,
        promptTokens: result.usage?.promptTokens ?? undefined,
        completionTokens: result.usage?.completionTokens ?? undefined,
      };
    },
  };
}

export function createCardGenerationV3LlmProviders(input: {
  transport: CardGenerationV3ChatTransport;
}): CardGenerationSimplifiedProviders {
  return {
    generate: chatCompletionPort<CardGenerateV3TaskInput>(input.transport),
    check: chatCompletionPort<CardContentCheckV3TaskInput>(input.transport),
    rewrite: chatCompletionPort<CardCandidateRewriteV3TaskInput>(input.transport),
  };
}

/** `AIProvider` 结构上就满足那片窄接口；这一行只是把"整接口实现"与"这一版需要的"接起来。 */
export function asCardGenerationV3Transport(provider: AIProvider): CardGenerationV3ChatTransport {
  return provider;
}
