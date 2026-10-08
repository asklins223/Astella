import assert from "node:assert/strict";
import test from "node:test";
import type { AIProvider } from "../../lib/ai-provider.ts";
import {
  companionClassifierRecent,
  companionOfferCandidates,
  interpretCompanionTurn,
  type CompanionToolIntentReceipt,
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

test("自动思考分类保留历史中部纠正，不只读首尾摘要", () => {
  const content = "原话开头。" + "旧背景".repeat(400) + "这项提醒已经取消，当前只聊天。" + "后续描述".repeat(400) + "原话结束。";
  assert.equal(companionClassifierRecent([{ role: "user", content }])[0]?.content, content);
});

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

test("普通称呼的分类协议不预填对象索引，不把缺少业务身份当作查询失败",async()=>{
  let instruction="";
  const model={...provider(()=>false),chatCompletion:async(messages:Parameters<AIProvider["chatCompletion"]>[0])=>{
    instruction=String(messages[0]!.content);
    return {content:JSON.stringify(proposal(false)),usage:{}};
  }} as AIProvider;
  const result=await interpretCompanionTurn(model,[{role:"user",content:"小鱼"}],taskContext());
  assert.match(instruction,/称呼伴星、随口招呼/);
  assert.match(instruction,/不因为话题名词或昵称没对应 object 就制造歧义/);
  assert.doesNotMatch(instruction,/"objectIndex":0|"goalObjectIndex":0/);
  assert.deepEqual(result.subjects,[]);
  assert.deepEqual(result.ambiguities,[]);
  assert.equal(result.toolUse,"none");
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
  assert.match(contract, /"pendingOfferIndexes":\[\]/,
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

test("退休用途开关不能扩大分类输入、输出额度或重启来源生成", async () => {
  let calls = 0;
  const model = { ...provider(() => false), chatCompletion: async (
    messages: Parameters<AIProvider["chatCompletion"]>[0], options: Parameters<AIProvider["chatCompletion"]>[1],
  ) => {
    calls++;
    const input = JSON.parse(String(messages.at(-1)?.content));
    assert.deepEqual(Object.keys(input).sort(), ["capabilities", "current", "objects", "recent"]);
    assert.doesNotMatch(String(messages[0]?.content), /dialogueFrame|userRecords/);
    assert.equal(options?.maxTokens, 900);
    assert.equal(options?.disableThinking, true);
    return { content: JSON.stringify(proposal(false)), usage: {} };
  } } as AIProvider;
  const legacyCaller = { ...taskContext(), dialogueFrameEnabled: true };
  const result = await interpretCompanionTurn(model, [{ role: "user", content: "我还没交呢" }], legacyCaller);
  assert.equal(calls, 1);
  assert.equal(result.intent, "conversation");
  assert.equal("dialogueFrame" in result, false);
});

test("模型有效返回 uncertain 与调用失败在观测中分别记录", async () => {
  const receipts: CompanionToolIntentReceipt[] = [];
  const model = { ...provider(() => false), chatCompletion: async () => ({
    content: JSON.stringify({ ...proposal(true), toolUse: "uncertain" }), usage: {},
  }) } as AIProvider;
  const result = await interpretCompanionTurn(model, [{ role: "user", content: "把那个打开" }], {
    ...taskContext(), onReceipt: receipt => receipts.push(receipt),
  });
  assert.equal(result.status, "uncertain");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.outcome, "committed");
  assert.equal(receipts[0]?.failureClass, null);
  assert.equal(receipts[0]?.interpretationStatus, "uncertain");
});

for (const [label, failureClass, answer] of [
  ["非 JSON", "output_shape", "private-provider-prose"],
  ["错误合同", "output_shape", '{"private":"private-provider-prose"}'],
  ["传输异常", "transport", null],
] as const) {
  test(`${label}只记录类别与耗时，不重试或泄露对话和上游错误正文`, async () => {
    const receipts: CompanionToolIntentReceipt[] = [];
    let calls = 0;
    const model = { ...provider(() => false), chatCompletion: async () => {
      calls++;
      if (answer === null) throw new Error("private-provider-prose");
      return { content: answer, usage: {} };
    } } as AIProvider;
    const result = await interpretCompanionTurn(model, [{ role: "user", content: "private-user-prose" }], {
      ...taskContext(), onReceipt: receipt => receipts.push(receipt),
    });
    assert.equal(calls, 1);
    assert.equal(result.toolUse, "uncertain");
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.failureClass, failureClass);
    assert.equal(receipts[0]?.interpretationStatus, null);
    assert.equal(receipts[0]?.modelCalls, 1);
    assert.ok(receipts[0]!.elapsedMs >= 0);
    assert.deepEqual(Object.keys(receipts[0]!).sort(),
      ["elapsedMs", "failureClass", "interpretationStatus", "modelCalls", "outcome"]);
    assert.doesNotMatch(JSON.stringify(receipts), /private-provider-prose|private-user-prose/);
  });
}

test("分类超时取消在途调用，保留不确定状态且明确记录 timeout", async () => {
  const receipts: CompanionToolIntentReceipt[] = [];
  let calls = 0;
  let providerSignal: AbortSignal | undefined;
  const model = { ...provider(() => false), chatCompletion: async (_messages, _options, signal) => {
    calls++;
    providerSignal = signal;
    return new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => {
      reject(new Error("private-provider-prose"));
    }, { once: true }));
  } } as AIProvider;
  const result = await interpretCompanionTurn(model, [{ role: "user", content: "打开那篇笔记" }], {
    ...taskContext(), stepTimeoutMs: 20, onReceipt: receipt => receipts.push(receipt),
  });
  assert.equal(calls, 1);
  assert.equal(providerSignal?.aborted, true);
  assert.equal(result.toolUse, "uncertain");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.failureClass, "timeout");
  assert.equal(receipts[0]?.interpretationStatus, null);
});

test("用户取消与超时分别记录，不因为取消重发分类请求", async () => {
  const controller = new AbortController();
  const receipts: CompanionToolIntentReceipt[] = [];
  let calls = 0;
  const model = { ...provider(() => false), chatCompletion: async () => {
    calls++;
    controller.abort();
    throw new Error("private-provider-prose");
  } } as AIProvider;
  const result = await interpretCompanionTurn(model, [{ role: "user", content: "算了，先停" }], {
    ...taskContext(controller.signal), onReceipt: receipt => receipts.push(receipt),
  });
  assert.equal(calls, 1);
  assert.equal(result.toolUse, "uncertain");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.outcome, "cancelled");
  assert.equal(receipts[0]?.failureClass, "cancelled");
});
