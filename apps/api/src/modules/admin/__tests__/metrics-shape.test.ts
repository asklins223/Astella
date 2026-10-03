/**
 * 指标抽取的形状契约。
 *
 * 这条测试存在的原因：直方图的 p50/p95 一度**恒为 null**，而面板上它表现为
 * "响应耗时"那条曲线永远是空的——没有任何报错、没有任何红。
 *
 * 根因是读错了字段：prom-client v15 把聚合种类（bucket / sum / count）
 * 放在 `metricName` 上，而 `labels` 里只有真实标签。读 `labels.__name__`
 * 拿到 undefined，三种聚合全部分类失败。
 *
 * 于是这里**从真实 registry 取数据**断言，而不是喂人造对象——喂人造对象
 * 正是当初让它溜过去的原因：人造对象带了 `__name__`，而真���的不带。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics,
  Registry,
} from "prom-client";

/**
 * 复刻生产里的抽取逻辑。
 *
 * 刻意从这段代码**抄**而不是 import：`summarizeHistogram` 没有单独导出，
 * 而 import 整个模块会把 metrics.ts 的全局 registry 一起拉进来，
 * 那样本用例就会污染进程里真实的指标。
 */
function extract(family: {
  name: string;
  type: string;
  values: Array<{ value: number; labels?: Record<string, string>; metricName?: string }>;
}) {
  const buckets: Array<{ le: number; count: number }> = [];
  let sum = 0;
  let count = 0;
  for (const item of family.values) {
    const labels = item.labels ?? {};
    const name = String(item.metricName ?? family.name);
    if (name.endsWith("_bucket")) buckets.push({ le: Number(labels.le), count: Number(item.value) });
    else if (name.endsWith("_sum")) sum = Number(item.value);
    else if (name.endsWith("_count")) count = Number(item.value);
  }
  return { buckets, sum, count };
}

test("prom-client v15：聚合种类在 metricName 上，不在 labels.__name__ 上", async () => {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const histogram = new Histogram({
    name: "shape_probe_seconds",
    help: "probe",
    labelNames: ["route"] as const,
    buckets: [0.1, 0.5, 1],
    registers: [registry],
  });
  histogram.observe({ route: "/a" }, 0.2);
  histogram.observe({ route: "/a" }, 0.7);

  const families = await registry.getMetricsAsJSON();
  const family = families.find((f) => f.name === "shape_probe_seconds");
  assert.ok(family, "直方图应当出现在 JSON 里");

  // 这两条断言是整条测试的地基：它们锁住"字段在哪"。
  assert.ok(
    family.values.every((v) => typeof (v as { metricName?: string }).metricName === "string"),
    "每条样本都该带 metricName",
  );
  assert.equal(
    family.values.every((v) => v.labels && v.labels.__name__ === undefined),
    true,
    "labels 里**不应该**有 __name__——读了它就会得到 undefined",
  );

  const extracted = extract(family as never);
  assert.equal(extracted.count, 2, "条数应被正确识别");
  assert.ok(extracted.sum > 0.8 && extracted.sum < 0.95, `总和应约等于 0.9，实际 ${extracted.sum}`);
  // 三个有限桶 + prom-client 自动补的 `+Inf` 桶。
  // `+Inf` 那条也要被识别：分位数估算靠它判断"有没有样本溢出最高桶"。
  assert.equal(extracted.buckets.length, 4);
  assert.equal(
    extracted.buckets.some((b) => !Number.isFinite(b.le)),
    true,
    "应当存在 +Inf 桶",
  );
  // 0.2 落在 [0.1, 0.5)，0.7 落在 [0.5, 1)。
  assert.equal(extracted.buckets.find((b) => b.le === 0.5)?.count, 1);
  assert.equal(extracted.buckets.find((b) => b.le === 1)?.count, 2);
});

test("counter / gauge 不带聚合后缀，取值方式不受影响", async () => {
  const registry = new Registry();
  const counter = new Counter({
    name: "shape_probe_total",
    help: "probe",
    registers: [registry],
  });
  const gauge = new Gauge({
    name: "shape_probe_gauge",
    help: "probe",
    registers: [registry],
  });
  counter.inc(7);
  gauge.set(3);

  const families = await registry.getMetricsAsJSON();
  const counterFamily = families.find((f) => f.name === "shape_probe_total");
  const gaugeFamily = families.find((f) => f.name === "shape_probe_gauge");

  assert.equal(counterFamily?.values[0].value, 7);
  assert.equal(gaugeFamily?.values[0].value, 3);
  // 它们没有后缀，所以抽取函数一律不匹配——这正是期望（既不是桶也不是和）。
  assert.deepEqual(extract(counterFamily as never).buckets, []);
});
