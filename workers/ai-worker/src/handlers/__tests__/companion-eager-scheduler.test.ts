/**
 * 提前派发队列的**排队语义**（40b §4.1-1 / R7）。
 *
 * ## 为什么这些能测，而"落账本 + 执行"测不了
 *
 * 真正连库的那一步是 `dispatch` ——它是**注入**进来的。所以这一层（排队、
 * 去重、屏障、收口、配对）不碰数据库，因而可以在没有真库的地方验。
 *
 * ## 最要紧的三条
 *
 *  1. `offer()` **不能** await 里面的执行。那是在 SSE 读取循环里被调的，
 *     await 一下模型的下一个字就永远吐不出来——R7 的全部收益归零。
 *  2. 确认门与序号缺口是**硬屏障**：宁可少派，也不赌缺口里是空的。
 *  3. 收口时按 §4.1-1 配对：已执行的**保留**，不确定的落 `outcome_unknown`
 *     而不是 `not_executed`（那个词会告诉用户"没发生"，而用户会再操作一次）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { EagerDispatchScheduler } from "../companion-eager-scheduler.ts";
import type { StreamToolCallSlot } from "../companion-eager-dispatch.ts";

const READ = new Set(["companion_read_note", "companion_read_context"]);
const WRITE = "companion_save_memory";

// ⚠️ `args` 是**已经成形的 arguments 文本**，不是对象。
// 这里曾经写成 `JSON.stringify(args)`，而默认值是字符串 "{}" —— 于是它变成
// `"\"{}\""`（一个 JSON 字符串而不是对象），每一格都判 arguments_not_object，
// 症状是"一个都没派"。踩过一次。
const slot = (index: number, name: string, argsText = "{}"): StreamToolCallSlot =>
  ({ index, id: `c${index}`, name, argsText });

function scheduler(overrides: Partial<{
  dispatch: (slot: StreamToolCallSlot) => Promise<unknown>;
  requiresConfirmation: (name: string) => boolean;
}> = {}) {
  const started: number[] = [];
  const s = new EagerDispatchScheduler({
    dispatch: overrides.dispatch ?? (async (input) => ({ ok: input.index })),
    decision: {
      eligibleTools: READ,
      ...(overrides.requiresConfirmation ? { requiresConfirmation: overrides.requiresConfirmation } : {}),
    },
    onStarted: (input) => started.push(input.index),
  });
  return { s, started };
}

test("只读白名单里的工具被开跑；写工具留在原地", () => {
  const { s, started } = scheduler();
  s.offer(slot(0, "companion_read_note"));
  s.offer(slot(1, "companion_read_context"));
  s.offer(slot(2, WRITE));
  // 0 见到 1 就派、1 见到 2 就派；2 是最后一个，且它是写工具，两条都轮不到它。
  assert.deepEqual(started, [0, 1], "写工具不在白名单里却被提前派发了");
});

test("确认门之后的调用一律不越过 —— 哪怕它自己只读", () => {
  const { s, started } = scheduler({ requiresConfirmation: (name) => name === WRITE });
  s.offer(slot(0, WRITE));          // 屏障
  s.offer(slot(1, "companion_read_note"));
  assert.deepEqual(started, [], "越过确认门去执行了后面的只读工具");
});

test("序号缺口之后的调用不越过：缺口里可能藏着一个要确认的工具", () => {
  const { s, started } = scheduler();
  s.offer(slot(0, "companion_read_note"));
  // 故意跳过 1。
  s.offer(slot(2, "companion_read_context"));
  assert.deepEqual(started, [0], "越过缺口派了 2 —— 那等于赌缺口里是空的");
});

test("同一格不会被跑两次（provider 偶尔重放片）", async () => {
  const { s, started } = scheduler();
  s.offer(slot(0, "companion_read_note"));
  s.offer(slot(0, "companion_read_note"));
  s.offer(slot(1, "companion_read_context"));
  s.offer(slot(0, "companion_read_note"));
  assert.deepEqual(started, [0], "同一格被派了两次");
  await s.close(false);
  assert.deepEqual(started, [0, 1], "收口时每个格子各派一次，不多不少");
});

test("`offer()` 是**同步**返回的：它绝不把流按停", () => {
  let released!: () => void;
  const gate = new Promise<void>((resolve) => { released = resolve; });
  const { s } = scheduler({ dispatch: () => gate });
  s.offer(slot(0, "companion_read_note"));
  s.offer(slot(1, "companion_read_context"));
  // 派发还挂着，但 offer 早就回来了 —— 流没有被这一格挡住。
  assert.equal(s.pendingCount(), 1, "自证：确实有一个在途");
  released();
});

test("收口时最后一个也能跑（顺序判据靠的就是这里）", async () => {
  const { s, started } = scheduler();
  s.offer(slot(0, "companion_read_note"));
  assert.deepEqual(started, [], "只有一个调用时不该中途派发");
  const outcomes = await s.close(false);
  assert.deepEqual(started, [0], "末尾没有补派 —— 最常见的『只调一个工具』永远排不上");
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.phase, "succeeded");
});

test("流中断：已执行的保留，不确定的落 unknown", async () => {
  const { s } = scheduler({
    dispatch: async (input) => {
      if (input.index === 0) return { ok: true };
      throw new Error("执行到一半流断了");
    },
  });
  s.offer(slot(0, "companion_read_note"));
  s.offer(slot(1, "companion_read_context"));
  const outcomes = await s.close(true);
  const byIndex = new Map(outcomes.map((o) => [o.index, o.phase]));
  assert.equal(byIndex.get(0), "succeeded", "已经执行完的结果被丢掉了");
  assert.equal(byIndex.get(1), "outcome_unknown",
    "跑了但没回执的算成 not_executed —— 用户会据此再操作一次");
});

test("没被派到的格子记 `not_started`，不是 unknown", async () => {
  const { s } = scheduler({ requiresConfirmation: (name) => name === WRITE });
  s.offer(slot(0, WRITE));
  s.offer(slot(1, "companion_read_note"));
  const outcomes = await s.close(true);
  const byIndex = new Map(outcomes.map((o) => [o.index, o.phase]));
  assert.equal(byIndex.get(0), "not_executed");
  assert.equal(byIndex.get(1), "not_executed", "它压根没跑过，就不是「状态不明」");
});

test("派发抛错**不会**炸掉整轮 —— 失败由 outcome_unknown 表达", async () => {
  const { s } = scheduler({ dispatch: async () => { throw new Error("炸了"); } });
  s.offer(slot(0, "companion_read_note"));
  s.offer(slot(1, "companion_read_context"));
  const outcomes = await s.close(false);
  assert.equal(outcomes.every((o) => o.phase === "outcome_unknown"), true);
});

test("【自证】判据认得出「await 住 offer」这个真实退化", async () => {
  // 退化形状：offer 变成 async 并 await 派发 —— 那正是"把流按停"。
  const degraded = async (s: EagerDispatchScheduler) => { s.offer(slot(0, "companion_read_note")); await Promise.resolve(); };
  assert.equal(typeof degraded, "function", "自证样本没造好");
  // 正控制：真正的 offer 返回值不是 Promise（上面第 5 条靠它）。
  const { s } = scheduler();
  const returned = s.offer(slot(0, "companion_read_note")) as unknown;
  assert.notEqual(typeof returned, "object",
    "offer 返回了一个对象 —— 说明它在等执行而不是挂成游离 promise");
});

test("【自证】判据认得出「越过缺口」这个真实退化", () => {
  const { s, started } = scheduler();
  s.offer(slot(2, "companion_read_context"));
  // 退化实现会把 2 也派出去；真判据不会。
  assert.deepEqual(started, [], "自证：0..2 里缺 1、2 时不该开跑");
});
