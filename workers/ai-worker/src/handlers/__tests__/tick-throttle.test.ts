import assert from "node:assert/strict";
import { test } from "node:test";

import { createTickThrottle } from "../tick-throttle.ts";

/** 调度器拿的是 `Date.now()`，节流初值 0 意味着「第一次调用必然放行」，模拟也要用真实量级。 */
const T0 = 1_700_000_000_000;

/** 模拟 worker 主循环：从 T0 起每 pollMs 拍一次，持续 `spanMs`，返回真的去撞函数的次数。 */
function simulate(
  intervalMs: number,
  pollMs: number,
  spanMs: number,
  succeed: boolean,
  retryBaseMs = 15_000,
): number {
  const throttle = createTickThrottle(intervalMs, retryBaseMs);
  let attempts = 0;
  for (let offset = 0; offset <= spanMs; offset += pollMs) {
    const now = T0 + offset;
    if (!throttle.due(now)) continue;
    attempts += 1;
    if (succeed) throttle.succeed(now);
    else throttle.fail(now);
  }
  return attempts;
}

test("周期照旧：成功之后一个周期内不再放行", () => {
  const throttle = createTickThrottle(60_000);
  assert.ok(throttle.due(T0));
  throttle.succeed(T0);
  assert.ok(!throttle.due(T0 + 1_000));
  assert.ok(!throttle.due(T0 + 59_999));
  assert.ok(throttle.due(T0 + 60_000));
});

test("DB 抖动：单次失败下一拍仍然重试（保留既有语义）", () => {
  const throttle = createTickThrottle(60 * 60 * 1000);
  throttle.fail(T0);
  assert.ok(throttle.due(T0 + 5_000), "第一次失败要能立刻重试，不然抖动就得等一个周期");
});

test("持续失败的撞库次数按指数退避收敛", () => {
  // 30 分钟档的调度器（向量补偿那一支），主循环 5 秒一拍。
  // 退避序列：0s、5s 立即重试一次，然后 15s→30s→60s→120s→240s→480s，上限一个周期。
  const firstMinute = simulate(30 * 60 * 1000, 5_000, 60_000, false);
  const firstHour = simulate(30 * 60 * 1000, 5_000, 60 * 60 * 1000, false);
  assert.equal(firstMinute, 4, "头一分钟应撞 4 发（0/5/20/50 秒）");
  assert.ok(
    firstHour >= 8 && firstHour <= 20,
    `一小时应当收敛到个位到十位数，实测 ${firstHour}`,
  );
});

test("【自证】退避被摘掉时这条判据会变红", () => {
  // 反向控制：照改动前那条判据原样模拟（失败**不**推进时间戳 → 每一拍都放行），
  // 18 小时 5 秒一拍 = 12,961 发 —— 0359 那场事故烧掉 43.8 MB 日志的形状。
  const span = 18 * 60 * 60 * 1000;
  let oldShapeAttempts = 0;
  let lastTickAt = 0;
  for (let offset = 0; offset <= span; offset += 5_000) {
    const now = T0 + offset;
    if (now - lastTickAt < 30 * 60 * 1000) continue;
    // 每一次都失败，所以 lastTickAt 永远停在 0
    oldShapeAttempts += 1;
  }
  const throttled = simulate(30 * 60 * 1000, 5_000, span, false);
  assert.ok(oldShapeAttempts > 12_000, `旧写法应当爆量，实测 ${oldShapeAttempts}`);
  assert.ok(
    throttled < oldShapeAttempts / 50,
    `带退避的最坏情况应远小于旧写法：${throttled} vs ${oldShapeAttempts}`,
  );
});

test("连败再久也只是每周期一发，指数不会溢出", () => {
  // 退避封顶在一个完整周期；`2 ** streak` 一旦溢出成 Infinity，与 0 相乘得 NaN，
  // `now >= NaN` 恒假会把调度器永久锁死——所以这里连撞十万次要仍然在动。
  const throttle = createTickThrottle(30 * 60 * 1000);
  let attempts = 0;
  for (let offset = 0; offset <= 7 * 24 * 60 * 60 * 1000; offset += 5_000) {
    const now = T0 + offset;
    if (!throttle.due(now)) continue;
    attempts += 1;
    throttle.fail(now);
  }
  const weekInIntervals = (7 * 24 * 60 * 60 * 1000) / (30 * 60 * 1000);
  assert.ok(
    attempts >= weekInIntervals * 0.5 && attempts <= weekInIntervals * 1.5,
    `一周应当收敛在每周期一发附近，实测 ${attempts}（期望≈${weekInIntervals}）`,
  );
});

test("恢复成功后重新按周期走，退避不留尾巴", () => {
  const throttle = createTickThrottle(60_000);
  throttle.fail(T0);
  throttle.fail(T0 + 5_000);
  assert.ok(!throttle.due(T0 + 10_000), "连败之后要挡住");
  throttle.succeed(T0 + 60_000);
  assert.ok(!throttle.due(T0 + 61_000));
  assert.ok(throttle.due(T0 + 120_000));
  throttle.fail(T0 + 120_000);
  assert.ok(throttle.due(T0 + 121_000), "退避计数已被成功清零，下一拍该立刻重试");
});

test("reset 放开闸门（测试与手动触发口）", () => {
  const throttle = createTickThrottle(60_000);
  throttle.succeed(T0);
  throttle.fail(T0 + 60_000);
  throttle.fail(T0 + 61_000);
  assert.ok(!throttle.due(T0 + 62_000));
  throttle.reset();
  assert.ok(throttle.due(T0 + 62_000));
});
