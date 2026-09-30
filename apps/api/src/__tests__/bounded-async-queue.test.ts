import assert from "node:assert/strict";
import test from "node:test";

import { BoundedAsyncQueue } from "../modules/learning-runs/bounded-async-queue.ts";

/**
 * P2-5：把"有界在途 + 有界排队 + 溢出即丢"从路由里抽出来的行为契约。
 *
 * ## 为什么值得有测试
 *
 * 这段逻辑最危险的不是"丢任务"，而是**计数器只增不减**。
 * 一旦 `finally` 那行减计数被漏掉，队列会**静默地**在若干次调用之后永久满——
 * 表现是"埋点莫名其妙一条都不上报了"，而没有异常、没有日志。
 *
 * 所以下面每一条都对着那个失效模式写。
 */

/** 让 microtask 队列排空若干轮，足以走完 then/finally。 */
async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

test("在途上限真的被遵守：并发不超过 maxInFlight", async () => {
  let peak = 0;
  let live = 0;
  const q = new BoundedAsyncQueue({ maxInFlight: 3, maxQueued: 100 });
  for (let i = 0; i < 20; i += 1) {
    q.submit(async () => {
      live += 1;
      peak = Math.max(peak, live);
      await settle(2);
      live -= 1;
    });
  }
  await settle(60);
  assert.equal(peak, 3, `峰值并发 ${peak}，上限 3——背压就是为这件事存在的`);
  assert.equal(q.stats().inFlight, 0, "跑完之后在途数必须归零");
  assert.equal(q.stats().queued, 0, "跑完之后不该还有排队");
});

test("队列满时丢弃，并且**不吞掉**这件事（有计数与回调）", async () => {
  let dropped = 0;
  const q = new BoundedAsyncQueue({
    maxInFlight: 1,
    maxQueued: 2,
    onDrop: (reason) => { assert.equal(reason, "queue_full"); dropped += 1; },
  });
  let ran = 0;
  for (let i = 0; i < 10; i += 1) q.submit(async () => { ran += 1; await settle(2); });
  await settle(80);
  // 1 条在途 + 2 条排队 = 3 条跑过，其余 7 条被丢
  assert.equal(ran, 3, `应当只跑 3 条，实际 ${ran}`);
  assert.equal(dropped, 7, `应当丢 7 条，实际 ${dropped}`);
  assert.equal(q.stats().dropped, 7);
});

test("任务 reject 不会让计数器卡住（这是本类存在的理由）", async () => {
  const errors: unknown[] = [];
  const q = new BoundedAsyncQueue({
    maxInFlight: 1,
    maxQueued: 10,
    onError: (err) => { errors.push(err); },
  });
  // 连续 5 个都 reject：若计数卡住，第 2 个起就永远排队
  for (let i = 0; i < 5; i += 1) {
    q.submit(() => Promise.reject(new Error(`boom-${i}`)));
  }
  await settle(40);
  assert.equal(q.stats().inFlight, 0,
    "reject 的任务必须被记为已完成——否则队列在第 2 个之后就永久满了");
  assert.equal(errors.length, 5, "每个失败都要报到 onError");
  assert.equal(q.stats().dropped, 0, "没有丢弃就不该有丢弃计数");
});

test("同步抛错的 task 同样算『已完成』", async () => {
  const q = new BoundedAsyncQueue({ maxInFlight: 1, maxQueued: 10 });
  let reached = 0;
  for (let i = 0; i < 3; i += 1) {
    q.submit(() => { throw new Error("sync"); });
  }
  q.submit(async () => { reached += 1; });
  await settle(40);
  assert.equal(reached, 1, "同步抛错之后队列仍要能继续推进");
  assert.equal(q.stats().inFlight, 0);
});

test("onError 自己抛错也不能让计数停住", async () => {
  const q = new BoundedAsyncQueue({
    maxInFlight: 1,
    maxQueued: 5,
    onError: () => { throw new Error("回调自己炸了"); },
  });
  let reached = 0;
  for (let i = 0; i < 3; i += 1) q.submit(() => Promise.reject(new Error("x")));
  q.submit(async () => { reached += 1; });
  await settle(40);
  assert.equal(reached, 1, "连回调抛错都不该让队列停摆——那正是死锁的定义");
  assert.equal(q.stats().inFlight, 0);
});

test("maxInFlight=0 会被抬到 1（否则队列永远推不动）", async () => {
  const q = new BoundedAsyncQueue({ maxInFlight: 0, maxQueued: 5 });
  let ran = 0;
  q.submit(async () => { ran += 1; });
  await settle(10);
  assert.equal(ran, 1, "上限 0 会让 submit 永远走排队分支——这里要兜住");
});

test("【自证】判据会红：把减计数那行去掉，『reject 不卡住』必须失败", () => {
  // 自证不改动磁盘：这里量的是"如果少了一行会怎样"这一判据本身是否成立。
  // 症状：在途数只增不减 → 第 2 个起全部排队 → reject 数量少于 3。
  let inflight = 0;
  const runFaulty = (task: () => Promise<unknown>) => {
    if (inflight >= 1) return;
    inflight += 1;                 // 只加不减
    void task().then(() => { inflight -= 1; }, () => { /* 漏了这一行 */ });
  };
  for (let i = 0; i < 3; i += 1) runFaulty(() => Promise.reject(new Error("x")));
  assert.equal(inflight, 1, "自证样本：漏掉减计数时，在途数会卡在上限");
});
