/**
 * 思考下发通道（2026-10-13）：节流、分块、序号、预算与「失败只关自己」。
 *
 * 这一条通道存在的全部理由：让她在想的字真的能看见，同时**一个字都不进**正文与
 * 朗读。所以这里锁的三件事是——
 * 1. 写库次数由节流决定（思考的到达速率是正文的百倍，不攒块会打满连接池）；
 * 2. 序号连续且拼接不重不漏（屏幕只看尾部，但尾部也得是她真的想过的字）；
 * 3. 任何失败、超预算、run 已终态都只让这条通道停下，绝不往上抛。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompanionThinkingDelivery } from "../turn/companion-thinking-stream.ts";

const read = { userId: "u1", runId: "r1", conversationId: "c1", generation: 1, accountEpoch: 0 };

test("输出边界刷出已收到的思考，后续思考仍能继续且不移动到先前正文之后", async () => {
  const ordered: string[] = [];
  const { delivery } = harness({ flushChars: 800, flushIntervalMs: 10_000,
    write: async chunks => { ordered.push(...chunks.map(chunk => chunk.text)); return true; } });
  delivery.onReasoningDelta("先读原文。");
  await delivery.flush(); ordered.push("工具读取");
  delivery.onReasoningDelta("已有结论。");
  await delivery.flush(); ordered.push("第一段正文");
  delivery.onReasoningDelta("再比较另一处。");
  await delivery.flush(); ordered.push("第二段正文");
  await delivery.finish();
  assert.deepEqual(ordered, ["先读原文。", "工具读取", "已有结论。", "第一段正文", "再比较另一处。", "第二段正文"]);
});

test("默认完整下发思考，超过旧 60000 字上限也不丢后续内容", async () => {
  const { delivery, written } = harness();
  const text = "完整保留思考。".repeat(10_000);
  delivery.onReasoningDelta(text);
  await delivery.finish();
  assert.equal(written(), text);
});

function harness(options: {
  flushChars?: number;
  flushIntervalMs?: number;
  turnBudgetChars?: number;
  write?: (chunks: readonly { index: number; text: string }[]) => Promise<boolean>;
} = {}) {
  const writes: { index: number; text: string }[][] = [];
  const delivery = createCompanionThinkingDelivery({
    ctx: { workspaceId: "w1" },
    read,
    expiresAt: "2026-10-13T00:00:00.000Z",
    notifyCompanionEvent: async () => undefined,
    flushChars: options.flushChars,
    flushIntervalMs: options.flushIntervalMs,
    turnBudgetChars: options.turnBudgetChars,
    write: options.write ?? (async (chunks) => { writes.push([...chunks]); return true; }),
  });
  return { delivery, writes, chunks: () => writes.flat(), written: () => writes.flat().map((chunk) => chunk.text).join("") };
}

test("没攒够一块不落库，攒够就一次写下整块，收尾把剩的补齐", async () => {
  const { delivery, chunks, written } = harness({ flushChars: 800, flushIntervalMs: 10_000 });
  delivery.onReasoningDelta("甲".repeat(500));
  assert.deepEqual(chunks(), [], "500 字没到阈值，不该有写入");

  delivery.onReasoningDelta("乙".repeat(400));
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(chunks().length, 1, "过阈值那一次把当时攒着的 900 字一次写出去");
  assert.equal(chunks()[0]!.text.length, 900);

  delivery.onReasoningDelta("丙".repeat(100));
  await delivery.finish();
  assert.equal(chunks().length, 2, "finish 补上压在窗口里的尾巴");
  assert.equal(written(), "甲".repeat(500) + "乙".repeat(400) + "丙".repeat(100));
  assert.deepEqual(chunks().map((chunk) => chunk.index), [0, 1]);
});

test("单块不超过合同上限 2000，长思考切成多块且拼接不重不漏", async () => {
  const { delivery, chunks } = harness({ flushChars: 100 });
  const all = "想".repeat(5_500);
  delivery.onReasoningDelta(all);
  await delivery.finish();
  const list = chunks();
  assert.ok(list.every((chunk) => chunk.text.length <= 2_000), JSON.stringify(list.map(c => c.text.length)));
  assert.equal(list.map((chunk) => chunk.text).join(""), all);
  assert.deepEqual(list.map((chunk) => chunk.index), list.map((_, i) => i));
});

test("低频的思考靠时间兜住，不等攒满一整块", async () => {
  const { delivery, written } = harness({ flushChars: 800, flushIntervalMs: 10 });
  delivery.onReasoningDelta("一句很短的犹豫");
  await new Promise((resolve) => setTimeout(resolve, 40));
  await delivery.finish();
  assert.equal(written(), "一句很短的犹豫");
});

test("一轮有总量预算：超出之后不再往外写，也不影响收尾", async () => {
  const { delivery, written } = harness({ flushChars: 100, turnBudgetChars: 1_000 });
  for (let i = 0; i < 30; i++) delivery.onReasoningDelta("多".repeat(200));
  await delivery.finish();
  const text = written();
  assert.ok(text.length > 0 && text.length <= 1_200, `实际写了 ${text.length} 字`);
  assert.equal(delivery.emittedChars() <= 1_200, true);
});

test("落库失败只让这条通道停下：finish 不抛、后续增量不再写", async () => {
  let attempts = 0;
  const { delivery, chunks } = harness({
    flushChars: 10,
    write: async () => { attempts += 1; throw new Error("fence lost"); },
  });
  delivery.onReasoningDelta("第一段思考");
  await delivery.finish();
  assert.equal(attempts, 1, "失败的写入只发生一次");
  delivery.onReasoningDelta("第二段思考");
  await delivery.finish();
  assert.equal(attempts, 1, "关掉之后不再尝试");
  assert.deepEqual(chunks(), []);
});

test("run 已不是这一轮（返回 false）时同样自己停下", async () => {
  let calls = 0;
  const { delivery } = harness({ flushChars: 1, write: async () => { calls += 1; return false; } });
  delivery.onReasoningDelta("甲");
  await delivery.finish();
  delivery.onReasoningDelta("乙");
  await delivery.finish();
  assert.equal(calls, 1);
});

test("空增量与已经关掉的通道都不产生写入", async () => {
  const { delivery, chunks } = harness({ flushChars: 1 });
  delivery.onReasoningDelta("");
  await delivery.finish();
  assert.deepEqual(chunks(), []);
});
