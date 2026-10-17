import assert from "node:assert/strict";
import test from "node:test";
import { repairDegenerateCompanionAnswer, type CompanionAnswerRepairInput } from "../agent/companion-answer-repair.ts";
import type { AgentTurnRequest, AgentTurnResult } from "@astella/shared";

const HALF = "今天已经学了1";           // 说了一半的句子：结构上没说完
const WHOLE = "今天已经学了18分钟啦";   // 实机退化形态：只多几个字，但说完了

function answer(content: string, toolCalls: unknown[] = []): AgentTurnResult {
  return { content, toolCalls, finishReason: toolCalls.length ? "tool_calls" : "stop",
    blocks: [], memoryRefs: [], usage: { promptTokens: 1, completionTokens: 1 },
    providerRequestId: null, providerCallIds: [], providerModelIds: [] } as unknown as AgentTurnResult;
}

function repairCase(over: Partial<CompanionAnswerRepairInput> = {}): CompanionAnswerRepairInput {
  return {
    result: answer(HALF), calls: [], stepRequest: { messages: [], tools: [] } as unknown as AgentTurnRequest,
    stepEmitted: false, alreadyRetried: false, deadlineAt: Date.now() + 60_000, stepCount: 1,
    runId: "11111111-1111-4111-8111-111111111111",
    fallbackProvider: { id: "fallback", modelId: "other-model", executeAgentTurn: async () => answer(WHOLE) } as never,
    ctxSignal: new AbortController().signal, isTruncated: text => text.trim().endsWith("1"),
    invokeProvider: async () => answer(WHOLE),
    ...over,
  };
}

test("半截话换另一个模型重跑一次，结构补全就算值", async () => {
  let runs = 0;
  const outcome = await repairDegenerateCompanionAnswer(repairCase({
    invokeProvider: async () => { runs++; return answer(WHOLE); },
  }));
  assert.equal(runs, 1, "降级阶梯只换模型重跑，不多跑");
  assert.equal(outcome.retried, true);
  assert.equal(outcome.result.content, WHOLE);
});

test("重跑带回工具调用就弃用，那是要走工具循环的信号", async () => {
  const outcome = await repairDegenerateCompanionAnswer(repairCase({
    invokeProvider: async () => answer("我先看看你的笔记。", [{ id: "call-1", name: "companion_read_note", arguments: {} }]),
  }));
  assert.equal(outcome.retried, true, "确实跑过这一次");
  assert.equal(outcome.result.content, HALF, "没有把带工具调用的那一版当成终答");
});

test("重跑还是半截、也没更长时不换掉原来那一版", async () => {
  const outcome = await repairDegenerateCompanionAnswer(repairCase({
    invokeProvider: async () => answer("学了1"),
  }));
  assert.equal(outcome.result.content, HALF);
});

for (const [name, over] of [
  ["正文结构已经说完了", { result: answer(WHOLE) }],
  ["这一步的字已经真的下发给用户", { stepEmitted: true }],
  ["本轮已经重跑过一次", { alreadyRetried: true }],
  ["这一步已经要调工具了", { calls: [{ id: "call-1", name: "companion_read_note", arguments: {} }] }],
  ["执行时间已经到线", { deadlineAt: Date.now() - 1 }],
  ["没有可换的另一个模型", { fallbackProvider: null }],
] as Array<[string, Partial<CompanionAnswerRepairInput>]>) {
  test(`不该重跑的形状：${name}`, async () => {
    let runs = 0;
    const outcome = await repairDegenerateCompanionAnswer(repairCase({
      invokeProvider: async () => { runs++; return answer(WHOLE); }, ...over,
    }));
    assert.equal(runs, 0, `${name}：一次模型调用都不该花`);
    assert.equal(outcome.retried, false);
    assert.equal(outcome.result.content, over.result ? over.result.content : HALF);
  });
}

test("重跑抛错不毁掉这一步已有的答案", async () => {
  const outcome = await repairDegenerateCompanionAnswer(repairCase({
    invokeProvider: async () => { throw new Error("上游挂了"); },
  }));
  assert.equal(outcome.result.content, HALF, "留痕后照原样交回，不把已生成的半截话换成错误");
});
