import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_RUN_PROCESSING_CONCURRENCY,
  MAX_RUN_PROCESSING_CONCURRENCY,
  resolveRunProcessingConcurrency,
} from "../run-processing-tick.ts";

// 2026-10-03。tick 从「认领 1 条、逐条 await」改成「小批量认领 + 批内并发」。
// 这组测试守的是并发度的解析规则；真正的"并发确实发生了"由下面的集成测试
// （learning-runs-postgres.integration.ts）配合真实 tick 驱动验证——单测里
// 无法在不起数据库的情况下断言 Promise.allSettled 的实际交错。

test("并发度默认 4：与 worker 侧 DEFAULT_QUEUE_CONCURRENCY 保持同值", () => {
  assert.equal(DEFAULT_RUN_PROCESSING_CONCURRENCY, 4);
  assert.equal(resolveRunProcessingConcurrency(undefined), 4);
  assert.equal(resolveRunProcessingConcurrency(""), 4);
});

test("显式配置生效", () => {
  assert.equal(resolveRunProcessingConcurrency("1"), 1);
  assert.equal(resolveRunProcessingConcurrency("8"), 8);
});

test("非法值回落默认，而不是变成 0 或 NaN", () => {
  // 0 与负数会让 batchSize=0，while 循环随即拿不到任何行直接 break——
  // tick 静默什么都不做，而 /metrics 不会报任何异常。所以必须回落默认值。
  assert.equal(resolveRunProcessingConcurrency("0"), 4);
  assert.equal(resolveRunProcessingConcurrency("-2"), 4);
  assert.equal(resolveRunProcessingConcurrency("abc"), 4);
  assert.equal(resolveRunProcessingConcurrency("2.5"), 4);
});

test("并发度被上界钳住：每路都可能同时持有事务连接，不能无限放大", () => {
  // API 主池只有 25 条连接（见 db/client.ts）。放行 64 路并发去抢同事务
  // 上下文只会把 HTTP 请求挤出池——正是 db/client.ts 注释里记录过的故障模式。
  assert.equal(resolveRunProcessingConcurrency("64"), MAX_RUN_PROCESSING_CONCURRENCY);
  assert.equal(resolveRunProcessingConcurrency("999"), MAX_RUN_PROCESSING_CONCURRENCY);
  assert.equal(MAX_RUN_PROCESSING_CONCURRENCY, 16);
});

test("并发度恒为正整数（while 循环的 batchSize 不能退化）", () => {
  for (const raw of [undefined, "", "1", "3", "16", "64", "0", "-1", "x", "2.5"]) {
    const value = resolveRunProcessingConcurrency(raw);
    assert.ok(Number.isInteger(value) && value > 0, `${String(raw)} → ${value} 必须是正整数`);
  }
});
