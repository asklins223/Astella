import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentTurnRequest } from "@astella/shared";
import { createGovernedProvider, type AIGovernanceContext } from "../../lib/governance.ts";
import { createProvider } from "../../lib/ai-provider.ts";
import { boundedStepSender, foldReplayUnderSummaryCoverage, replayToMessages } from "../companion-compaction.ts";

/**
 * 方案 44 §4.3／§5.4：把**真的闸**与**真的折叠**串起来跑一次。
 *
 * 为什么要这条：`context-governor` 的单测验的是闸，`companion-compaction` 的单测验的是
 * 折叠，两边各自都绿。中间那句「闸说该压 → 折 → 重发」没有任何测试真的走过。
 * 而那一段正是 §4.3 声称的「一次实际请求默认最多进行一次压缩尝试」——它可以整条断掉
 * （比如闸抛的错误类型和折叠捕获的不一致）而两边单测照样全绿。
 *
 * 这里不 mock 闸也不 mock 折叠：用真实的 `createGovernedProvider` + 真实的闸选项 +
 * 真实的 `boundedStepSender` + 真实的折叠规则，只把 provider 换成 mock（不花钱、不起 HTTP）。
 */

const workspaceId = "00000000-0000-0000-0000-000000000001";
const userId = "00000000-0000-0000-0000-000000000002";

const governance: AIGovernanceContext = {
  providerName: "mock", providerConfig: {},
  textProviderName: null, textProviderConfig: null,
  visionProviderName: null, visionProviderConfig: null,
  companionFallbackProviderName: null, companionFallbackProviderConfig: null,
  embeddingProviderName: null, embeddingProviderConfig: null,
  consentOk: true,
  policy: { sendToExternal: true, sendImageContent: true, piiDetection: false, auditLogging: false },
};

const longContent = "问题".repeat(6_400);

test("44 §5.4：闸拦下 → 折一次 → 重发；被折掉的消息真的没有再发出去", async () => {
  const previous = process.env.MOCK_CONTEXT_WINDOW_TOKENS;
  // 把窗口压到「触发线以上、硬上限以下」，于是这次请求是**该压**而不是**装不下**。
  process.env.MOCK_CONTEXT_WINDOW_TOKENS = "20000";
  try {
    let attemptAvailable = true;
    const folded: string[] = [];
    const governed = createGovernedProvider(
      createProvider("mock", {}),
      governance, workspaceId,
      { userId, operation: "companion_agent" },
      { compactionAvailable: () => attemptAvailable },
    );

    const send = boundedStepSender({
      // 折叠规则是真的：只折被一份**校验过的**摘要盖住的那一条。
      fold: (messages) => {
        const result = foldReplayUnderSummaryCoverage({
          system: [],
          tail: [{ message: messages[0]!, seq: "1" }],
          trailing: messages.slice(1),
          coverage: { fromSeq: "1", throughSeq: "1", sourceSha256: "a".repeat(64) },
        });
        return result.receipt
          ? { messages: replayToMessages(result.replay), receipt: result.receipt }
          : null;
      },
      hasAttempt: () => attemptAvailable,
      consumeAttempt: () => { attemptAvailable = false; },
      onCompacted: () => { folded.push("folded"); },
    });

    const request: AgentTurnRequest = {
      role: "companion_agent",
      systemPrompt: "短。",
      messages: [
        { role: "user", content: longContent },
        { role: "user", content: "现在这个问题" },
      ],
      tools: [], toolChoice: "auto", maxTokens: 1_000, temperature: 0.4,
    };

    const sizes: number[] = [];
    await send(request, async (foldedRequest) => {
      sizes.push(foldedRequest.messages.length);
      const result = await governed.executeAgentTurn!(foldedRequest, AbortSignal.timeout(30_000));
      return result;
    });

    // 第一次发出去之前就被闸拦下（闸在真实 provider 包装器里），所以 provider 只被调用一次。
    assert.equal(sizes.length, 2, "发一次、被压一次、重发一次");
    assert.deepEqual(sizes, [2, 1], "重发的那次只剩当前请求——被摘要盖住的那段没有再发出去");
    assert.deepEqual(folded, ["folded"]);
  } finally {
    if (previous === undefined) delete process.env.MOCK_CONTEXT_WINDOW_TOKENS;
    else process.env.MOCK_CONTEXT_WINDOW_TOKENS = previous;
  }
});

test("44 §5.4：压缩额度用尽后不再折，第二次仍超线就带着有效上下文继续", async () => {
  const previous = process.env.MOCK_CONTEXT_WINDOW_TOKENS;
  process.env.MOCK_CONTEXT_WINDOW_TOKENS = "20000";
  try {
    let attemptAvailable = false; // 一开始就没有额度（例如这一轮已经折过一次）
    let folds = 0;
    const governed = createGovernedProvider(
      createProvider("mock", {}),
      governance, workspaceId,
      { userId, operation: "companion_agent" },
      { compactionAvailable: () => attemptAvailable },
    );
    const send = boundedStepSender({
      fold: (messages) => {
        folds += 1;
        return {
          messages: messages.slice(1),
          receipt: {
            foldedFromSeq: "1", foldedThroughSeq: "1", foldedMessageCount: 1,
            summarySourceSha256: "a".repeat(64), remainingFromSeq: null, uncoveredBeforeSeq: null,
          },
        };
      },
      hasAttempt: () => attemptAvailable,
      consumeAttempt: () => { attemptAvailable = false; },
      onCompacted: () => { attemptAvailable = false; },
    });

    const request: AgentTurnRequest = {
      role: "companion_agent", systemPrompt: "短。",
      messages: [{ role: "user", content: longContent }, { role: "user", content: "现在这个问题" }],
      tools: [], toolChoice: "auto", maxTokens: 1_000, temperature: 0.4,
    };
    const sizes: number[] = [];
    await send(request, async (foldedRequest) => {
      sizes.push(foldedRequest.messages.length);
      return governed.executeAgentTurn!(foldedRequest, AbortSignal.timeout(30_000));
    });
    assert.equal(folds, 0, "没有额度就不折");
    assert.deepEqual(sizes, [2], "超触发线但未超硬上限 → 原样发出，闸记 over_trigger_line");
  } finally {
    if (previous === undefined) delete process.env.MOCK_CONTEXT_WINDOW_TOKENS;
    else process.env.MOCK_CONTEXT_WINDOW_TOKENS = previous;
  }
});

test("44 §5.4：闸要求压缩但没有可折内容时不失败——消耗额度后原样发出，闸记「额度已用尽」", async () => {
  const previous = process.env.MOCK_CONTEXT_WINDOW_TOKENS;
  process.env.MOCK_CONTEXT_WINDOW_TOKENS = "20000";
  try {
    let attemptAvailable = true;
    const decisions: string[] = [];
    const governed = createGovernedProvider(
      createProvider("mock", {}),
      governance, workspaceId,
      { userId, operation: "companion_agent" },
      {
        compactionAvailable: () => attemptAvailable,
        onDecision: (receipt) => { decisions.push(`${receipt.decision.outcome}:${receipt.decision.reason}`); },
      },
    );
    const send = boundedStepSender({
      // 折不动：覆盖区间与回放尾部不相交（这正是现状——读侧锚点保证的形态）。
      fold: () => null,
      hasAttempt: () => attemptAvailable,
      consumeAttempt: () => { attemptAvailable = false; },
      onCompacted: () => { throw new Error("折不动不该走到这里"); },
    });
    const request: AgentTurnRequest = {
      role: "companion_agent", systemPrompt: "短。",
      messages: [{ role: "user", content: longContent }, { role: "user", content: "现在这个问题" }],
      tools: [], toolChoice: "auto", maxTokens: 1_000, temperature: 0.4,
    };
    const sent: number[] = [];
    await send(request, async (foldedRequest) => {
      sent.push(foldedRequest.messages.length);
      return governed.executeAgentTurn!(foldedRequest, AbortSignal.timeout(30_000));
    });
    assert.deepEqual(sent, [2, 2], "发一次 → 被拦 → 原样重发一次");
    assert.deepEqual(decisions, ["compact:over_trigger_line", "send:compaction_budget_spent"]);
  } finally {
    if (previous === undefined) delete process.env.MOCK_CONTEXT_WINDOW_TOKENS;
    else process.env.MOCK_CONTEXT_WINDOW_TOKENS = previous;
  }
});
