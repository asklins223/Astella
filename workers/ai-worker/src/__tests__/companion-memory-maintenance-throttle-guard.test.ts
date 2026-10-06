/**
 * 守卫：`tickCompanionMemoryMaintenance` 的两个兜底清理必须有节流，且是**到点就跑**。
 *
 * ## 挡住的是哪次真事故
 *
 * 2026-10-01~02 实测，这两个查询（回收区到期清理 / 归档保留上限淘汰）**一次
 * 节流都没有**——同一文件里上面那次每日维护有 `lastMaintenanceAt`，它们没有；
 * 同目录所有兄弟调度器也都有（30s ~ 60min）。DB 授权缺失（0345/0346 只授了
 * `astella_api`）之后，失败被 catch 成一条 WARN，下一 tick 再来一次，永不停止。
 *
 * worker tick 的退避当时也是坏的（`index.ts` 在 claimJobs 成功后无条件
 * `currentPollMs = POLL_MS`，封顶 1000ms），于是这条循环稳定 1 次/秒，
 * 18 小时刷出 13 万条 WARN / 43.8 MB，容器 CPU 237%。
 *
 * ## 为什么判据是「到点就跑」而不是「成功才推进」
 *
 * 「成功才推进」在 30s 节流下只是每 30s 重试一次，可以接受；这里是兜底清理，
 * 持续失败时「成功才推进」等于**没有节流**，正是事故形态。所以时间戳必须在
 * 查询之前推进。本守卫锁死的就是这个顺序，而不只是「有没有节流」。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
  new URL("../handlers/companion-memory-maintenance.ts", import.meta.url),
  "utf8",
);

/** 与源码同构的判据：拆出门、两条查询、推进点三处位置。 */
function analyze(text: string): {
  gateIndex: number;
  advanceIndex: number;
  queryIndexes: number[];
} {
  const gateIndex = text.indexOf("if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;");
  const advanceIndex = text.indexOf("lastCleanupAt = now;");
  const queryIndexes = ["astella_purge_expired_companion_memory", "astella_enforce_companion_memory_retention"]
    .map((fn) => text.indexOf(`public.${fn}()`))
    // 没出现时 indexOf 返回 -1，映射成 NaN 让后续断言失败而不是静默通过
    .map((i) => (i < 0 ? Number.NaN : i));
  return { gateIndex, advanceIndex, queryIndexes };
}

test("两个兜底清理共用一道节流门", () => {
  assert.match(
    source,
    /const CLEANUP_INTERVAL_MS = [\d_ *+]+;/,
    "清理查询需要自己的间隔常量",
  );
  const { gateIndex } = analyze(source);
  assert.ok(gateIndex > 0, "找不到清理查询的节流门——它被删掉了？");
});

test("时间戳在查询之前推进（到点就跑，不等结果）", () => {
  const { gateIndex, advanceIndex, queryIndexes } = analyze(source);
  assert.ok(gateIndex > 0 && advanceIndex > 0, "节流门与推进点都要在");
  assert.ok(
    gateIndex < advanceIndex,
    "推进点必须紧跟在门后面",
  );
  for (const [i, q] of queryIndexes.entries()) {
    assert.ok(!Number.isNaN(q), `第 ${i + 1} 条清理查询在源码里找不到了`);
    assert.ok(
      advanceIndex < q,
      "推进点必须早于查询——「成功才推进」在持续失败时等于没有节流，"
      + "那正是 2026-10-02 这次事故的形态",
    );
  }
});

test("每日维护那道门没有被这次改动顺手改掉", () => {
  assert.match(source, /const MAINTENANCE_INTERVAL_MS = 24 \* 60 \* 60 \* 1000;/);
  assert.match(source, /if \(now - lastMaintenanceAt >= MAINTENANCE_INTERVAL_MS\)/);
});

test("【自证】判据认得出「成功后推进」这个真实退化", () => {
  // 反向控制：把推进点挪到查询之后，同一套判据必须报红。
  // 样本里的函数名必须是真的——判据按 `public.<fn>()` 定位，
  // 换成假名会得到 NaN，而 `NaN < x` 恒为 false，那这条「自证」
  // 验的就不是判据本身了。
  const regressed = [
    "if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;",
    "SELECT public.astella_purge_expired_companion_memory() AS purged;",
    "SELECT public.astella_enforce_companion_memory_retention() AS evicted;",
    "lastCleanupAt = now;",
  ].join("\n");
  const { advanceIndex, queryIndexes } = analyze(regressed);
  for (const q of queryIndexes) {
    assert.ok(!Number.isNaN(q), "自证样本没造好：判据根本定位不到这两条查询");
  }
  assert.ok(
    !(advanceIndex < queryIndexes[0] && advanceIndex < queryIndexes[1]),
    "推进点落在查询之后——判据必须拒绝这种写法",
  );
});