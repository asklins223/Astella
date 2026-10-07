import assert from "node:assert/strict";
import test from "node:test";
import type { AIProvider } from "../../lib/ai-provider.ts";
import {
  companionClassifierRecent,
  companionOfferCandidates,
  interpretCompanionTurn,
} from "../companion-tool-intent.ts";

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

const WINDOW: Parameters<typeof companionClassifierRecent>[0] = [
  { role: "system", content: "系统块不占索引" },
  { role: "user", content: "m0" },
  { role: "assistant", content: "m1" },
  { role: "user", content: "m2" },
  { role: "assistant", content: "m3" },
  { role: "user", content: "m4" },
  { role: "assistant", content: "m5" },
  { role: "user", content: "m6" },
];

test("分类器窗口的索引按「去掉 system 之后」给，与运行时 messages 同一个空间", () => {
  const recent = companionClassifierRecent(WINDOW);
  assert.deepEqual(recent.map((item) => item.index), [2, 3, 4, 5, 6],
    "窗口是最近 5 条，且 system 不参与编号——索引要是另一套，接线迟早对不上");
  assert.deepEqual(recent.map((item) => item.content), ["m2", "m3", "m4", "m5", "m6"]);
  assert.deepEqual(companionOfferCandidates(WINDOW), [3, 5],
    "只有她的消息能被指为待收的账；用户当前那句不是");
});

test("待收的账只认宿主给过的索引，越界的直接丢", async () => {
  let sent = "";
  let contract = "";
  const model = {
    ...provider(() => false),
    chatCompletion: async (messages: Parameters<AIProvider["chatCompletion"]>[0]) => {
      sent = String(messages.at(-1)?.content ?? "");
      contract = String(messages[0]?.content ?? "");
      return {
        content: JSON.stringify({ ...proposal(false), pendingOfferIndexes: [5, 99, 5] }),
        usage: {},
      };
    },
  } as AIProvider;
  const result = await interpretCompanionTurn(model, WINDOW, taskContext());
  assert.deepEqual(result.pendingOfferIndexes, [5], "99 不存在，重复的 5 只算一次");
  assert.match(sent, /"index":5/, "模型必须真的看见它被允许引用的那个编号");
  assert.match(contract, /"pendingOfferIndexes":\[0\]/,
    "字段没写进输出合同就会被 strict 解析判成非法输出，整轮解释退化成 uncertain");
  assert.match(contract, /只引用 recent 给过的 index/, "不发明身份——这条和 objects 用的是同一套约束");
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
