/**
 * 面板服务层的纯函数测试（脱敏投影 + 分位数估算）。
 *
 * 这两处都是"错了也不会让任何东西变红、只会悄悄给人看错数字"的地方，
 * 所以各自钉死边界：脱敏投影宁可不显示也不能漏出自由文本；分位数在没有
 * 样本时必须返回 null 而不是 0。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { projectSafeError } from "../ops-service.ts";
import { estimateQuantile } from "../metrics-service.ts";
import { parseBucketBound } from "../../../lib/metrics.ts";

test("脱敏投影：匹配安全投影格式时只保留受控片段", () => {
  const projected = projectSafeError("operational_error:provider:TypeError:upstream_5xx");
  assert.equal(projected.category, "provider");
  assert.equal(projected.name, "TypeError");
  assert.equal(projected.code, "upstream_5xx");
  assert.equal(projected.summary, "provider · TypeError · upstream_5xx");

  // 没有 code 的两段式也要能用。
  const short = projectSafeError("operational_error:timeout:AbortError");
  assert.equal(short.category, "timeout");
  assert.equal(short.code, null);
});

test("脱敏投影：不符合格式的一律降级为 unknown，原始文本不得离开", () => {
  const freeText = "failed calling https://api.example.com/v1/chat with prompt: 用户的问题正文…";
  const projected = projectSafeError(freeText);
  assert.equal(projected.summary, "unknown");
  assert.equal(JSON.stringify(projected).includes("用户的问题正文"), false);
  assert.equal(JSON.stringify(projected).includes("example.com"), false);

  // 类别不在 allowlist 内 → 同样不通过。
  assert.equal(projectSafeError("operational_error:evil:Whatever").summary, "unknown");
  // 空值 → 明确的"无错误信息"，不是 unknown。
  assert.equal(projectSafeError(null).summary, "无错误信息");
  assert.equal(projectSafeError("").summary, "无错误信息");
});

test("分位数：无样本时返回 null，而不是一个假的 0", () => {
  assert.equal(estimateQuantile([], 0.95), null);
  assert.equal(estimateQuantile([{ le: 1, count: 0 }], 0.95), null);
  // 全落在 +Inf ⇒ 没有任何有限桶可插值。
  assert.equal(estimateQuantile([{ le: Infinity, count: 10 }], 0.95), null);
});

test("分位数：落在桶内时线性插值", () => {
  // 5 个样本全在 [1, 2.5) 桶 ⇒ 各分位数都落在 1~2.5 之间。
  const buckets = [
    { le: 0.5, count: 0 },
    { le: 1, count: 0 },
    { le: 2.5, count: 5 },
    { le: 5, count: 5 },
    { le: Infinity, count: 5 },
  ];
  const p50 = estimateQuantile(buckets, 0.5);
  assert.ok(p50 !== null && p50 > 1 && p50 < 2.5, `p50 应落在桶内，实际 ${p50}`);
  // 更高分位不会更小。
  assert.ok(estimateQuantile(buckets, 0.95)! >= p50!);
});

test("分位数：目标超出最高有限桶时返回该桶上界（由 overflowRatio 补充说明）", () => {
  const buckets = [
    { le: 1, count: 1 },
    { le: 2, count: 1 },
    { le: Infinity, count: 100 },
  ];
  // 99% 的样本都在 +Inf 桶里，任何有限分位数都只能贴着最高桶。
  assert.equal(estimateQuantile(buckets, 0.99), 2);
});

test("桶上界：+Inf 必须解析成真正的无穷大，不能变成 0", () => {
  // 这条曾是个静默 bug：`Number("+Inf")` 是 NaN，经 toNumber 落成 0，
  // 于是 +Inf 桶排在所有桶**前面**，estimateQuantile 在它里面命中目标分位，
  // 返回 0——「响应耗时」永远显示 0 秒，而没有任何报错。
  assert.equal(parseBucketBound("+Inf"), Number.POSITIVE_INFINITY);
  assert.equal(parseBucketBound("Inf"), Number.POSITIVE_INFINITY);
  assert.equal(parseBucketBound("Infinity"), Number.POSITIVE_INFINITY);
  assert.equal(parseBucketBound("0.5"), 0.5);
  assert.equal(parseBucketBound(1), 1);
  assert.ok(Number.isNaN(parseBucketBound("")));

  // 端到端复现：真实形状的桶序列（末桶是 +Inf）。
  // 有 bug 时 +Inf 落成 0 并排在最前，分位数直接被拽到 0；
  // 所以这里断言的核心是"**不是 0**"，而不是某个具体数值——
  // 线性插值在粗桶上会给出略低于桶下沿的值，那是 Prometheus 同款口径，不是缺陷。
  const buckets = [
    { le: parseBucketBound("0.1"), count: 0 },
    { le: parseBucketBound("1"), count: 4 },
    { le: parseBucketBound("+Inf"), count: 4 },
  ];
  const p50 = estimateQuantile(buckets, 0.5);
  assert.ok(p50 !== null && p50 > 0, `分位数不该塌成 0，实际 ${p50}`);

  // 反证：把 +Inf 当成 0（也就是修复前的行为）确实会把结果拽到 0。
  const broken = [
    { le: 0.1, count: 0 },
    { le: 1, count: 4 },
    { le: 0, count: 4 },
  ];
  assert.equal(estimateQuantile(broken, 0.5), 0, "这条断言记录了修复前的错误行为");
});
