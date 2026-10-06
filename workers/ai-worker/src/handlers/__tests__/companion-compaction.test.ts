import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentTurnRequest } from "@astella/shared";
import {
  foldReplayUnderSummaryCoverage,
  replayToMessages,
  withBoundedContextCompaction,
  boundedStepSender,
  applyCompactedMessages,
  type CompactionFoldReceipt,
} from "../companion-compaction.ts";
import { AIContextCompactionRequiredError, type ContextGateReceipt } from "../../lib/context-governor.ts";

/**
 * 方案 44 §5.2／§5.4：折叠与「至多一次」。
 *
 * 折叠会真的从请求里拿走消息，所以这几条判据不能只靠「函数返回了什么」来验——
 * 要看**发出去的那份请求**里还剩什么。
 */

const msg = (text: string) => ({ role: "user" as const, content: text });
const turn = (text: string): AgentTurnRequest["messages"][number] => ({ role: "assistant", content: text });

const coverage = (throughSeq: string, fromSeq: string | null = "3", hash: string | null = "a".repeat(64)) => ({
  fromSeq, throughSeq, sourceSha256: hash,
});

test("44 §5.2：只折被校验过的摘要盖住的那一段，其余原样保留", () => {
  const folded = foldReplayUnderSummaryCoverage({
    system: [],
    tail: [
      { message: msg("第一句"), seq: "1" },
      { message: turn("第二句"), seq: "2" },
      { message: msg("第三句"), seq: "3" },
      { message: turn("第四句"), seq: "4" },
    ],
    trailing: [msg("现在这个问题")],
    coverage: coverage("3"),
  });
  assert.ok(folded.receipt);
  assert.equal(folded.receipt.foldedMessageCount, 3);
  assert.equal(folded.receipt.foldedFromSeq, "1");
  assert.equal(folded.receipt.foldedThroughSeq, "3");
  assert.equal(folded.receipt.remainingFromSeq, "4");
  // 当前请求一条都不能少——静默切掉问题尾巴是不可接受的（44 §4.3）。
  const sent = replayToMessages(folded.replay);
  assert.deepEqual(sent.map(m => (typeof m.content === "string" ? m.content : "")), ["第四句", "现在这个问题"]);
});

test("44 §5.2：覆盖没经过校验时一段都不折", () => {
  const tail = [{ message: msg("很长的旧对话"), seq: "1" }];
  const folded = foldReplayUnderSummaryCoverage({
    system: [], tail, trailing: [], coverage: coverage("9", "1", null),
  });
  assert.equal(folded.receipt, null);
  assert.equal(replayToMessages(folded.replay).length, 1);
});

test("44 §5.2：没有来源 seq 的条目不折——证明不了被盖住就不能顶替", () => {
  const folded = foldReplayUnderSummaryCoverage({
    system: [],
    tail: [{ message: msg("没有 seq 的那条"), seq: null }],
    trailing: [],
    coverage: coverage("9"),
  });
  assert.equal(folded.receipt, null);
  assert.equal(replayToMessages(folded.replay).length, 1);
});

test("44 §5.2：尾部之后的一切原样保留（工具调用与结果是一对，不许剪开）", () => {
  const toolCall = { role: "assistant" as const, content: "", toolCalls: [{ id: "c1", name: "read_note", arguments: {} }] };
  const toolResult = { role: "tool" as const, content: "结果", toolCallId: "c1" };
  const folded = foldReplayUnderSummaryCoverage({
    system: [],
    tail: [{ message: msg("旧"), seq: "1" }],
    trailing: [toolCall, toolResult],
    coverage: coverage("9"),
  });
  const sent = replayToMessages(folded.replay);
  assert.equal(sent.length, 2);
  assert.equal(sent[0]?.role, "assistant");
  assert.equal(sent[1]?.role, "tool");
});

test("44 §5.2：摘要起点之前还有一段没人代表时如实记下来", () => {
  const folded = foldReplayUnderSummaryCoverage({
    system: [],
    tail: [
      { message: msg("最早"), seq: "1" },
      { message: msg("第二"), seq: "2" },
      { message: msg("第三"), seq: "3" },
      { message: msg("第四"), seq: "4" },
    ],
    trailing: [],
    // 摘要只盖 3..4，1..2 谁都没代表。
    coverage: coverage("4", "3"),
  });
  assert.equal(folded.receipt?.foldedFromSeq, "1");
  assert.equal(folded.receipt?.uncoveredBeforeSeq, "1", "别让「有摘要」冒充「全读过」");
});

test("44 §5.2：覆盖伸进回放窗口时折得动——折的是被摘要盖住的那段前缀", () => {
  const folded = foldReplayUnderSummaryCoverage({
    system: [],
    tail: [
      { message: msg("第五句"), seq: "5" },
      { message: turn("第六句"), seq: "6" },
      { message: msg("第七句"), seq: "7" },
      { message: turn("第八句"), seq: "8" },
      { message: msg("第九句"), seq: "9" },
    ],
    trailing: [msg("现在这个问题")],
    // 摘要盖 1..8：5..8 由它代表，9 与当前请求原样保留。
    coverage: coverage("8", "1"),
  });
  assert.ok(folded.receipt);
  assert.equal(folded.receipt.foldedFromSeq, "5");
  assert.equal(folded.receipt.foldedThroughSeq, "8");
  assert.equal(folded.receipt.foldedMessageCount, 4);
  assert.equal(folded.receipt.remainingFromSeq, "9");
  assert.equal(folded.receipt.uncoveredBeforeSeq, null, "折的这一段全在覆盖区间内");
  const sent = replayToMessages(folded.replay);
  assert.deepEqual(sent.map(m => (typeof m.content === "string" ? m.content : "")), ["第九句", "现在这个问题"]);
});

test("44 §5.4：覆盖完全早于回放窗口时折不动——不拿一段没盖住这里的摘要顶替原文", () => {
  const folded = foldReplayUnderSummaryCoverage({
    system: [],
    tail: [
      { message: msg("第五句"), seq: "5" },
      { message: msg("第六句"), seq: "6" },
    ],
    trailing: [msg("现在这个问题")],
    coverage: coverage("2", "1"),
  });
  assert.equal(folded.receipt, null);
  assert.deepEqual(
    replayToMessages(folded.replay).map(m => (typeof m.content === "string" ? m.content : "")),
    ["第五句", "第六句", "现在这个问题"],
  );
});

function pressureError(): AIContextCompactionRequiredError {
  return new AIContextCompactionRequiredError({
    providerId: "p", modelId: "m", operation: "companion_agent",
    budget: {} as never, measurement: {} as never, decision: {} as never,
  } as ContextGateReceipt);
}

test("44 §5.4：被闸拦下时折一次再重发，且只发两次", async () => {
  let attempts = 0;
  const sent: string[] = [];
  let available = true;
  const result = await withBoundedContextCompaction<number>({
    send: (messages) => {
      attempts += 1;
      sent.push(messages.map(m => (typeof m.content === "string" ? m.content : "")).join("|"));
      if (attempts === 1) throw pressureError();
      return Promise.resolve(attempts);
    },
    compact: () => ({
      messages: [msg("当前问题")],
      receipt: {
        foldedFromSeq: "1", foldedThroughSeq: "3", foldedMessageCount: 3,
        summarySourceSha256: "a".repeat(64), remainingFromSeq: null, uncoveredBeforeSeq: null,
      } satisfies CompactionFoldReceipt,
    }),
    hasAttempt: () => available,
    consumeAttempt: () => { available = false; },
    onCompacted: () => {},
  }, [msg("旧的1"), msg("旧的2"), msg("当前问题")]);
  assert.equal(result, 2);
  assert.equal(attempts, 2, "至多一次：发 → 折 → 重发");
  assert.equal(sent[1], "当前问题");
});

test("44 §5.4：额度已经用尽时不再折，原样把真实限制交回", async () => {
  let attempts = 0;
  await assert.rejects(withBoundedContextCompaction({
    send: () => { attempts += 1; throw pressureError(); },
    compact: () => null,
    hasAttempt: () => false,
    consumeAttempt: () => {},
  }, [msg("x")]), AIContextCompactionRequiredError);
  assert.equal(attempts, 1, "没有额度就不折，也不重发");
});

test("44 §5.4：折不动时消耗额度、原样重发，交给闸按 over_trigger_line 放行", async () => {
  let attempts = 0;
  let consumed = 0;
  const sentSizes: number[] = [];
  const recorded: Date[] = [];
  const result = await withBoundedContextCompaction<number>({
    send: (messages) => {
      attempts += 1;
      sentSizes.push(messages.length);
      if (attempts === 1) throw pressureError();
      return Promise.resolve(attempts);
    },
    compact: () => null,
    hasAttempt: () => consumed === 0,
    consumeAttempt: () => { consumed += 1; },
    cooldown: {
      decide: () => Promise.resolve({ allowed: true, reason: "first_attempt", retryAfterMs: null }),
      record: ({ at }) => { recorded.push(at); return Promise.resolve(); },
    },
  }, [msg("x")]);
  assert.equal(result, 2, "重发一次就交回，不再把「压不动」当成这一轮的失败");
  assert.deepEqual(sentSizes, [1, 1], "原样重发，不静默删内容");
  assert.equal(consumed, 1, "重发前必须消耗额度，否则闸会再拦一次");
  assert.equal(recorded.length, 1, "折不动也要记一笔，否则永远停在 first_attempt");
});

test("44 §5.4：折完先消耗额度再重发，最后用重发后的读数记一笔", async () => {
  const order: string[] = [];
  let attempts = 0;
  const result = await withBoundedContextCompaction<number>({
    send: () => {
      order.push("send");
      attempts += 1;
      if (attempts === 1) throw pressureError();
      return Promise.resolve(attempts);
    },
    compact: () => ({
      messages: [msg("当前")],
      receipt: {
        foldedFromSeq: "1", foldedThroughSeq: "2", foldedMessageCount: 2,
        summarySourceSha256: "a".repeat(64), remainingFromSeq: null, uncoveredBeforeSeq: null,
      } satisfies CompactionFoldReceipt,
    }),
    hasAttempt: () => true,
    consumeAttempt: () => { order.push("consume"); },
    onCompacted: () => { order.push("onCompacted"); },
    cooldown: {
      decide: () => Promise.resolve({ allowed: true, reason: "first_attempt", retryAfterMs: null }),
      record: () => { order.push("record"); return Promise.resolve(); },
    },
  }, [msg("旧1"), msg("当前")]);
  assert.equal(result, 2);
  assert.deepEqual(order, ["send", "consume", "onCompacted", "send", "record"]);
});

test("44 §5.4：不是压力问题的异常照原样抛出，不被当成压缩机会", async () => {
  await assert.rejects(withBoundedContextCompaction({
    send: () => Promise.reject(new Error("provider 500")),
    compact: () => null,
    hasAttempt: () => true,
    consumeAttempt: () => {},
  }, []), /provider 500/);
});

test("applyCompactedMessages 只换 messages，systemPrompt 与 tools 不动", () => {
  const request: AgentTurnRequest = {
    role: "companion_agent", systemPrompt: "协议", messages: [msg("旧")],
    tools: [{ name: "t", description: "d", parameters: {} }],
    maxTokens: 2_000, temperature: 0.4,
  };
  const next = applyCompactedMessages(request, [msg("当前")]);
  assert.equal(next.systemPrompt, "协议");
  assert.deepEqual(next.tools, request.tools);
  assert.equal(next.messages[0]?.content, "当前");
  assert.equal(request.messages[0]?.content, "旧", "不改原请求");
});

test("boundedStepSender 把折叠后的请求交给发送函数，systemPrompt 不受影响", async () => {
  let attempt = 0;
  let seenSystem = "";
  const send = boundedStepSender({
    fold: () => ({
      messages: [msg("只剩当前问题")],
      receipt: {
        foldedFromSeq: "1", foldedThroughSeq: "2", foldedMessageCount: 2,
        summarySourceSha256: "a".repeat(64), remainingFromSeq: null, uncoveredBeforeSeq: null,
      } satisfies CompactionFoldReceipt,
    }),
    hasAttempt: () => attempt === 0,
    consumeAttempt: () => { attempt += 1; },
    onCompacted: () => {},
  });
  const request: AgentTurnRequest = {
    role: "companion_agent", systemPrompt: "协议保持不变",
    messages: [msg("旧1"), msg("旧2"), msg("当前")], tools: [],
    maxTokens: 2_000, temperature: 0.4,
  };
  const sizes: number[] = [];
  const turnResult = { content: "好", toolCalls: [], finishReason: "stop", usage: null, providerRequestId: null };
  await send(request, (folded) => {
    seenSystem = folded.systemPrompt;
    sizes.push(folded.messages.length);
    if (sizes.length === 1) throw pressureError();
    return Promise.resolve(turnResult);
  });
  assert.equal(seenSystem, "协议保持不变");
  assert.deepEqual(sizes, [3, 1]);
});

// ─── 44 §5.4 后半：失败冷却 ────────────────────────────────────────────────

test("44 §5.4：冷却期内不再折，同一个失败输入不会每轮重触发", async () => {
  let folded = 0;
  let consumed = 0;
  let recorded = 0;
  const send = boundedStepSender({
    fold: () => {
      folded += 1;
      return {
        messages: [msg("只剩当前")],
        receipt: {
          foldedFromSeq: "1", foldedThroughSeq: "3", foldedMessageCount: 3,
          summarySourceSha256: "a".repeat(64), remainingFromSeq: null, uncoveredBeforeSeq: null,
        } satisfies CompactionFoldReceipt,
      };
    },
    hasAttempt: () => true,
    consumeAttempt: () => { consumed += 1; },
    onCompacted: () => {},
    cooldown: {
      decide: () => Promise.resolve({ allowed: false, reason: "within_cooldown", retryAfterMs: 30_000 }),
      record: () => { recorded += 1; return Promise.resolve(); },
    },
  });
  const sizes: number[] = [];
  const turnResult = { content: "好", toolCalls: [], finishReason: "stop", usage: null, providerRequestId: null };
  const request = { messages: [msg("旧1"), msg("旧2"), msg("当前")] };
  await send(request, (sent) => {
    sizes.push(sent.messages.length);
    if (sizes.length === 1) throw pressureError();
    return Promise.resolve(turnResult);
  });
  assert.equal(folded, 0, "冷却期内不折");
  assert.deepEqual(sizes, [3, 3], "照原样重发，让闸按 over_trigger_line 处理");
  assert.equal(consumed, 1, "冷却期内也要先消耗额度再重发");
  assert.equal(recorded, 1, "放行这一轮同样记一笔，无进展才会累积到停手");
});

test("44 §5.4：没有冷却端口时行为不变（不把新约束偷偷塞进旧路径）", async () => {
  let folded = 0;
  const send = boundedStepSender({
    fold: () => {
      folded += 1;
      return {
        messages: [msg("只剩当前")],
        receipt: {
          foldedFromSeq: "1", foldedThroughSeq: "2", foldedMessageCount: 2,
          summarySourceSha256: "a".repeat(64), remainingFromSeq: null, uncoveredBeforeSeq: null,
        } satisfies CompactionFoldReceipt,
      };
    },
    hasAttempt: () => true,
    consumeAttempt: () => {},
    onCompacted: () => {},
  });
  const sizes: number[] = [];
  const turnResult = { content: "好", toolCalls: [], finishReason: "stop", usage: null, providerRequestId: null };
  const plain = { messages: [msg("旧1"), msg("当前")] };
  await send(plain, (sent) => {
    sizes.push(sent.messages.length);
    if (sizes.length === 1) throw pressureError();
    return Promise.resolve(turnResult);
  });
  assert.equal(folded, 1);
  assert.deepEqual(sizes, [2, 1]);
});
