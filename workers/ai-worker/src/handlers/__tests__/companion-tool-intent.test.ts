import assert from "node:assert/strict";
import test from "node:test";
import type { AIProvider } from "../../lib/ai-provider.ts";
import { interpretCompanionTurn } from "../companion-tool-intent.ts";

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

const proposal = (action: boolean) => ({ intent: action ? "task" : "conversation", toolUse: action ? "act" : "none",
  subjects: [], goalRelation: action ? "new" : "unrelated", candidateOperations: [], ambiguities: [] });

function provider(decide: (input: string) => boolean): AIProvider {
  return {
    id: "test",
    modelId: "test",
    visionModelId: "test",
    promptVersion: "test",
    chatCompletion: async (messages) => ({
      content: JSON.stringify(proposal(decide(String(messages.at(-1)?.content ?? "")))),
      usage: {},
    }),
  } as AIProvider;
}

test("语义判断把简称文章的插图请求交给工具，不依赖固定措辞", async () => {
  const model = provider((input) => input.includes("插图") && input.includes("IndexTTS"));
  const result = await interpretCompanionTurn(model, [
    { role: "user", content: "给我看看 IndexTTS 2.5 文章的插图" },
  ], taskContext());
  assert.equal(result.toolUse, "act");
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
      return { content: JSON.stringify(proposal(true)), usage: {} };
    },
  } as AIProvider;
  assert.equal((await interpretCompanionTurn(model, [
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
  })).toolUse, "act");
  assert.equal(modelCalls, 1);
  assert.equal(leaseChecks, 2, "模型调用前及提交边界都核对同一租约");
  assert.equal(transactionReads, 1, "模型出网前必须经过事务外检查");
});

test("闲聊可以直接回复；无效结构化输出不会假装判断成功", async () => {
  const direct = provider(() => false);
  assert.equal((await interpretCompanionTurn(direct, [{ role: "user", content: "你是谁？" }], taskContext())).toolUse, "none");
  const invalid = { ...direct, chatCompletion: async () => ({ content: "{}", usage: {} }) } as AIProvider;
  assert.equal((await interpretCompanionTurn(invalid, [{ role: "user", content: "那篇的图呢？" }], taskContext())).toolUse, "uncertain");
});

test("租约在模型调用前失效时不发请求，并把失效交给任务运行时", async () => {
  let calls = 0;
  const model = {
    ...provider(() => true),
    chatCompletion: async () => {
      calls += 1;
      return { content: JSON.stringify(proposal(true)), usage: {} };
    },
  } as AIProvider;
  await assert.rejects(
    interpretCompanionTurn(model, [{ role: "user", content: "打开那篇笔记" }], {
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
      return { content: JSON.stringify(proposal(true)), usage: {} };
    },
  } as AIProvider;
  assert.equal((await interpretCompanionTurn(model, [{ role: "user", content: "打开那篇笔记" }], {
    ...taskContext(),
    stepTimeoutMs: 0,
  })).toolUse, "uncertain", "读数用尽时按未知处理，后续工具策略仍 fail closed");
  assert.equal(calls, 0);
});
