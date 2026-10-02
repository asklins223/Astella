import assert from "node:assert/strict";
import test from "node:test";
import type { AIProvider } from "../../lib/ai-provider.ts";
import { companionNeedsTool } from "../companion-tool-intent.ts";

function taskContext(signal = new AbortController().signal) {
  return {
    job: {
      id: "job-tool-intent-test",
      workspaceId: "workspace-tool-intent-test",
      requestedBy: "user-tool-intent-test",
      leaseToken: "lease-tool-intent-test",
      signal,
    },
    runId: "run-tool-intent-test",
    userId: "user-tool-intent-test",
    permissionLevel: "guided",
    currentActiveTransaction: () => undefined,
    verifyAttempt: async () => true,
  };
}

function provider(decide: (input: string) => boolean): AIProvider {
  return {
    id: "test",
    modelId: "test",
    visionModelId: "test",
    promptVersion: "test",
    chatCompletion: async (messages) => ({
      content: JSON.stringify({ needsTool: decide(String(messages.at(-1)?.content ?? "")) }),
      usage: {},
    }),
  } as AIProvider;
}

test("语义判断把简称文章的插图请求交给工具，不依赖固定措辞", async () => {
  const model = provider((input) => input.includes("插图") && input.includes("IndexTTS"));
  const result = await companionNeedsTool(model, [
    { role: "user", content: "给我看看 IndexTTS 2.5 文章的插图" },
  ], taskContext());
  assert.equal(result, true);
});

test("分类步骤只发一次模型调用，并在调用前后核对租约", async () => {
  let modelCalls = 0;
  let leaseChecks = 0;
  let transactionReads = 0;
  const model = {
    ...provider(() => true),
    chatCompletion: async (_messages, _options, signal) => {
      modelCalls += 1;
      assert.ok(signal instanceof AbortSignal, "内核应给 provider 传入受控取消信号");
      return { content: JSON.stringify({ needsTool: true }), usage: {} };
    },
  } as AIProvider;
  assert.equal(await companionNeedsTool(model, [
    { role: "user", content: "打开那篇笔记" },
  ], {
    ...taskContext(),
    currentActiveTransaction: () => {
      transactionReads += 1;
      return undefined;
    },
    verifyAttempt: async () => {
      leaseChecks += 1;
      return true;
    },
  }), true);
  assert.equal(modelCalls, 1);
  assert.equal(leaseChecks, 2, "模型调用前及提交边界都核对同一租约");
  assert.equal(transactionReads, 1, "模型出网前必须经过事务外检查");
});

test("闲聊可以直接回复；无效结构化输出不会假装判断成功", async () => {
  const direct = provider(() => false);
  assert.equal(await companionNeedsTool(direct, [{ role: "user", content: "你是谁？" }], taskContext()), false);
  const invalid = { ...direct, chatCompletion: async () => ({ content: "{}", usage: {} }) } as AIProvider;
  assert.equal(await companionNeedsTool(invalid, [{ role: "user", content: "那篇的图呢？" }], taskContext()), null);
});

test("租约在模型调用前失效时不发请求，并把失效交给任务运行时", async () => {
  let calls = 0;
  const model = {
    ...provider(() => true),
    chatCompletion: async () => {
      calls += 1;
      return { content: JSON.stringify({ needsTool: true }), usage: {} };
    },
  } as AIProvider;
  await assert.rejects(
    companionNeedsTool(model, [{ role: "user", content: "打开那篇笔记" }], {
      ...taskContext(),
      verifyAttempt: async () => false,
    }),
    /no longer owns its lease/,
  );
  assert.equal(calls, 0);
});

test("整轮预算耗尽时不再启动分类模型调用", async () => {
  let calls = 0;
  const model = {
    ...provider(() => true),
    chatCompletion: async () => {
      calls += 1;
      return { content: JSON.stringify({ needsTool: true }), usage: {} };
    },
  } as AIProvider;
  assert.equal(await companionNeedsTool(model, [{ role: "user", content: "打开那篇笔记" }], {
    ...taskContext(),
    stepTimeoutMs: 0,
  }), null, "读数用尽时按未知处理，后续工具策略仍 fail closed");
  assert.equal(calls, 0);
});
