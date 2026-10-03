import assert from "node:assert/strict";
import test from "node:test";
import {
  acquireSseSlotIn,
  createSseLimiter,
  resolveSseMaxStreamsPerUser,
  resolveSseMaxStreamsTotal,
} from "../sse-connection-limiter.ts";

// 2026-10-03。这组测试守的是三条长连事件流（inbox / run-events / card-gen-events）
// 共享的那套上限。此前 run 与 card-v2 两条流**一个上限都没有**，inbox 则内联着
// 一份和它们不共享的每用户 Map——那份内联实现已被本模块取代。

test("每用户上限：到顶后拒绝同一主体，但不波及别的用户", () => {
  const limiter = createSseLimiter();
  const limits = { maxPerUser: 2, maxTotal: 100 };

  const a1 = acquireSseSlotIn(limiter, "inbox", "user-a", limits);
  const a2 = acquireSseSlotIn(limiter, "inbox", "user-a", limits);
  assert.equal(a1.ok, true);
  assert.equal(a2.ok, true);

  const a3 = acquireSseSlotIn(limiter, "inbox", "user-a", limits);
  assert.equal(a3.ok, false);
  assert.equal(a3.ok === false && a3.reason, "per_user");

  // 另一个用户照常可用——这正是"每用户桶"与"全局桶"必须分开的意义。
  const b1 = acquireSseSlotIn(limiter, "inbox", "user-b", limits);
  assert.equal(b1.ok, true);
});

test("进程总上限：不同命名空间的用户也会被同一个总上限挡住", () => {
  const limiter = createSseLimiter();
  const limits = { maxPerUser: 10, maxTotal: 3 };

  assert.equal(acquireSseSlotIn(limiter, "inbox", "u1", limits).ok, true);
  assert.equal(acquireSseSlotIn(limiter, "run-events", "u2", limits).ok, true);
  assert.equal(acquireSseSlotIn(limiter, "card-gen-events", "u3", limits).ok, true);

  // 第 4 条：即使每个命名空间、每个用户都远未到自己的上限。
  const rejected = acquireSseSlotIn(limiter, "inbox", "u4", limits);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.ok === false && rejected.reason, "total");
});

test("命名空间之间每用户桶互不干扰", () => {
  const limiter = createSseLimiter();
  const limits = { maxPerUser: 1, maxTotal: 100 };
  const key = "u1:ws1";

  assert.equal(acquireSseSlotIn(limiter, "inbox", key, limits).ok, true);
  // 同一个主体在另一条流上应当还能再开一条。
  assert.equal(acquireSseSlotIn(limiter, "run-events", key, limits).ok, true);
  assert.equal(acquireSseSlotIn(limiter, "card-gen-events", key, limits).ok, true);
});

test("release 幂等：重复调用不会把计数减成负数或提前放出别人的槽位", () => {
  const limiter = createSseLimiter();
  const limits = { maxPerUser: 1, maxTotal: 2 };

  const first = acquireSseSlotIn(limiter, "inbox", "u1", limits);
  assert.equal(first.ok, true);
  first.ok && first.release();
  first.ok && first.release();
  first.ok && first.release();

  // 槽位已经完整归还，两个名额都还能再拿到。
  const second = acquireSseSlotIn(limiter, "inbox", "u2", limits);
  const third = acquireSseSlotIn(limiter, "run-events", "u3", limits);
  assert.equal(second.ok, true);
  assert.equal(third.ok, true);

  // 第 3 条应当被总上限挡住——如果重复 release 把计数减成负数，这里就会通过。
  const fourth = acquireSseSlotIn(limiter, "inbox", "u4", limits);
  assert.equal(fourth.ok, false);
  assert.equal(fourth.ok === false && fourth.reason, "total");
});

test("归还槽位后同一用户可以重新连接", () => {
  const limiter = createSseLimiter();
  const limits = { maxPerUser: 1, maxTotal: 10 };

  const first = acquireSseSlotIn(limiter, "inbox", "u1", limits);
  assert.equal(first.ok, true);
  assert.equal(acquireSseSlotIn(limiter, "inbox", "u1", limits).ok, false);

  first.ok && first.release();
  const reconnected = acquireSseSlotIn(limiter, "inbox", "u1", limits);
  assert.equal(reconnected.ok, true);
});

test("上限解析：非法输入回落到默认值，而不是变成 0 或 NaN", () => {
  assert.equal(resolveSseMaxStreamsPerUser(undefined), 5);
  assert.equal(resolveSseMaxStreamsTotal(undefined), 200);
  assert.equal(resolveSseMaxStreamsPerUser("8"), 8);
  assert.equal(resolveSseMaxStreamsTotal("0"), 200, "0 不是正整数，应回落默认");
  assert.equal(resolveSseMaxStreamsPerUser("-3"), 5);
  assert.equal(resolveSseMaxStreamsPerUser("abc"), 5);
  assert.equal(resolveSseMaxStreamsPerUser("2.5"), 5, "非整数应回落默认");
});
