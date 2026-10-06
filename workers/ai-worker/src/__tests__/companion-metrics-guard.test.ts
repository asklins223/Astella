import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  SHARED_COMPANION_METRIC_NAMES,
  COMPANION_SUMMARY_TOTAL_DEF,
  COMPANION_MEMORY_USED_COUNT_DEF,
  COMPANION_MEMORY_RETRIEVAL_MODE_TOTAL_DEF,
} from "@astella/shared/metrics-definitions";
import {
  companionSummaryTotal,
  companionMemoryUsedCount,
  companionMemoryRetrievalModeTotal,
} from "../lib/metrics.ts";

/**
 * P1-20：跨进程同名指标的定义必须来自 `packages/shared/metrics-definitions`。
 *
 * 收口前这三个指标在 api 与 worker 各写一遍。逐字节比对确认两边当时是**完全一样**的
 * ——所以这不是"已经坏了"，而是"随时会坏"：下一次只改一边就漂了，而漂了没有任何
 * 测试会红（Prometheus 那边表现为同名指标两套元数据，告警静默少算）。
 *
 * 这条守卫写在**两个进程各自**里，而不是写一份跨包的：
 * 跨包测试要一个包去读另一个包的源码，那是把部署拓扑写进测试。
 * 各自守各自的"不得再本地声明"，效果一样，而且哪边的构建跑到就守哪边。
 */

const METRICS_SOURCE = join(new URL("..", import.meta.url).pathname, "lib", "metrics.ts");

test("本地 metrics.ts 不再自己声明这三个共享指标的名字", () => {
  const source = readFileSync(METRICS_SOURCE, "utf8");
  const redeclared = SHARED_COMPANION_METRIC_NAMES.filter(
    (name) => new RegExp(`name:\\s*"${name}"`).test(source),
  );
  assert.deepEqual(redeclared, [],
    "这些指标的定义归 packages/shared/metrics-definitions.ts 管，本进程只负责 new 实例：\n"
    + redeclared.join("\n"));
});

test("实例的 name / help 与共享定义逐字一致（否则 Prometheus 看到两套元数据）", () => {
  const pairs = [
    [companionSummaryTotal, COMPANION_SUMMARY_TOTAL_DEF],
    [companionMemoryUsedCount, COMPANION_MEMORY_USED_COUNT_DEF],
    [companionMemoryRetrievalModeTotal, COMPANION_MEMORY_RETRIEVAL_MODE_TOTAL_DEF],
  ] as const;

  for (const [instance, def] of pairs) {
    const anyInstance = instance as unknown as { name: string; help: string };
    assert.equal(anyInstance.name, def.name);
    assert.equal(anyInstance.help, def.help, `${def.name} 的 help 与共享定义不一致`);
  }
});

test("label 名字与顺序与共享定义一致（顺序变了聚合就对不上）", () => {
  const pairs = [
    [companionSummaryTotal, COMPANION_SUMMARY_TOTAL_DEF],
    [companionMemoryUsedCount, COMPANION_MEMORY_USED_COUNT_DEF],
    [companionMemoryRetrievalModeTotal, COMPANION_MEMORY_RETRIEVAL_MODE_TOTAL_DEF],
  ] as const;

  for (const [instance, def] of pairs) {
    const anyInstance = instance as unknown as { labelNames: string[] };
    assert.deepEqual([...anyInstance.labelNames], [...def.labelNames], `${def.name} 的 label 不一致`);
  }
});

test("used_count 是 Histogram —— 改 Gauge 会让 _count/_sum/_bucket 三个序列消失", () => {
  assert.equal(COMPANION_MEMORY_USED_COUNT_DEF.kind, "histogram");
  const anyInstance = companionMemoryUsedCount as unknown as { constructor: { name: string } };
  assert.equal(anyInstance.constructor.name, "Histogram");
});
