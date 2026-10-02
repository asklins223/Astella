import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * P1-11 / P1-19：worker handler 的测试覆盖棘轮。
 *
 * ## 先说审计的数字对不上
 *
 * 审计条目写「6 个零测试的 worker handler」与「5 处笔记生成 handler」，
 * 本仓库实测是 **16 个 handler 没有任何测试文件引用**（口径：worker 的测试文件里
 * 有没有出现过这个 handler 模块名）。16 里有 4 个是 `note-*` 生成类
 * （`note-dynamic-artifact-generate` / `note-expansion-generate` /
 * `note-overview-generate` / `note-annotation-explain`）。
 *
 * 数字对不上不改变要做什么，但它决定了**这份基线该写多大**——按 6 写基线，
 * 剩下 10 个会立刻把门禁顶红，而它们并不会因为写错数字而消失。
 *
 * ## 这条棘轮做什么、不做什么
 *
 * **做**：把"哪些 handler 还没有测试"变成一条**只能缩小**的显式基线。
 * 新增一个没有测试的 handler 会立刻变红。
 *
 * **不做**：它**不**声称这 16 个已经有测试了。这条门禁的价值是
 * 「缺口不再悄悄变大」，不是「缺口已经消失」。真正的补测要逐个 handler
 * 单独做（多数 handler 只有一个 `runXxx(job)` 导出，要 mock 租约、事务、
 * 治理上下文与 provider，不是一条正则能覆盖的）。
 *
 * 豁免数**只能减不能加**：新增一个免测 handler 时，必须在本文件里写明理由，
 * 减掉时顺手删掉对应行。
 */

/** 当前还没有任何测试引用的 handler。**只能删，不能加。** */
const BASELINE_UNTESTED: ReadonlySet<string> = new Set([
/*
 * 「被测试引用」的口径要说清楚：判据读的是**测试源码里有没有出现这个模块名**。
 * 它不区分「import 了并真的调用」与「只在注释里被提到」——
 * 2026-09-30（B2）拆出 `companion-tool-execution` 之后，它被
 * `companion-tool-executor-ledger.test.ts` 读**源码文本**逐条核对执行分支
 * 与 `*Id` 登记表，于是模块名出现在那份测试里，棘轮据此认为它有覆盖。
 *
 * 那算**源码文本覆盖**，不是行为单测：它抓得到"分支被删了""登记表指向不存在的列"，
 * 抓不到"SQL 跑起来对不对"。要补的是后者，不是把它从这张表里挪走。
 */

  // 2026-09-30（B2）补记：`companion-agent-events` 原本也在这张表里——
  // 拆出持久化族之后它没有按名覆盖。补了
  // `companion-agent-events-durability-source-guard.test.ts` 之后它**不再**是
  // "没有测试引用"（那条守卫按名读了它），所以从表里删掉。
  //
  // 实测记录，留给下一个人：把 `finishStep` 里的 `finished_at = now()` 删掉，
  // 在补那条守卫之前，worker 的 873 条测试**一条都不红**。也就是说这一族的 SQL
  // 此前不是"间接覆盖"，是**没覆盖**。现在盯住的是几个耐久字段（最要命的那部分），
  // 其余语句仍然只有源码文本守卫、没有行为断言。
  // 2026-10-02：从这张表里删掉 `companion-memory-maintenance`。
  // 起因是一次真实事故：它的两个兜底清理查询（回收区到期 / 归档淘汰）**没有
  // 任何节流**，DB 授权缺失后每秒各抛一次错、18 小时不停，worker 日志 43.8 MB、
  // 容器 CPU 237%。补 `companion-memory-maintenance-throttle-guard.test.ts` 守住那道门。
  //
  // 按本文件顶部说清的口径，这仍算**源码文本覆盖**：那条守卫读源码里的门与推进点
  // 顺序，抓得到「节流被删掉」「改成成功才推进」，抓不到「SQL 跑起来对不对」。
  // 后者由 `integration-tests/companion-memory-handlers-postgres.integration.ts`
  // 覆盖（它真连 Postgres 调 `tickCompanionMemoryMaintenance`），但那份不是
  // `.test.ts`，不进本棘轮的 blob——所以这里别把它当成行为覆盖。
  "card-generation-v2-handler",
  "companion-daily-summary-scheduler",
  "companion-delivery-write",
  "companion-dialogue-deltas",
  "companion-memory-embedding",
  "companion-note-reads",
  "companion-proposal-expiry-scheduler",
  "companion-reminder-scheduler",
  "companion-run-reconcile-scheduler",
  "companion-thought-scheduler",
  "note-annotation-explain",
  "note-expansion-generate",
  "note-overview-generate",
]);

const WORKER_SRC = new URL("..", import.meta.url).pathname;
const HANDLERS_DIR = join(WORKER_SRC, "handlers");

function handlerModules(): string[] {
  return readdirSync(HANDLERS_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => f.slice(0, -3))
    .sort();
}

const SELF = "worker-handler-test-coverage-ratchet.test.ts";

/**
 * 把所有测试文件的文本拼成一大坨，然后看 handler 名字在不在里面。
 *
 * **必须把自己排除掉。** 本文件在注释与基线里逐字写着那 16 个 handler 名，
 * 它自己会被 `readdirSync` 收进 blob，于是每一个 handler 都"有测试"——
 * 棘轮直接退化成永远绿灯。这不是假设，是第一版真实发生的事：
 * 自证 `assert.ok(!blob.includes("note-dynamic-artifact-generate"))` 当场变红，
 * 才暴露出自己给自己打了分。
 */
function testSourceBlob(): string {
  const chunks: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".test.ts") && entry.name !== SELF) {
        chunks.push(readFileSync(full, "utf8"));
      }
    }
  };
  walk(WORKER_SRC);
  return chunks.join("\n");
}

test("handler 目录里的模块都被算进来了（收集器没坏）", () => {
  const handlers = handlerModules();
  assert.ok(handlers.length >= 30, `只收集到 ${handlers.length} 个 handler，收集器多半坏了`);
  assert.ok(handlers.includes("note-dynamic-artifact-generate"),
    "连审计点名的那个 handler 都没收集到");
});

test("没有测试引用的 handler 集合与基线完全相等（棘轮只能缩小）", () => {
  const blob = testSourceBlob();
  const handlers = handlerModules();
  const untested = handlers.filter((h) => !blob.includes(h));

  const added = untested.filter((h) => !BASELINE_UNTESTED.has(h));
  const removed = [...BASELINE_UNTESTED].filter((h) => !untested.includes(h));

  assert.deepEqual(added, [],
    "这些 handler 没有任何测试引用：要么补一条测试，要么（确实豁免时）"
    + "在本文件里写明理由后加进基线：\n" + added.join("\n"));
  assert.deepEqual(removed, [],
    "这些 handler 已经有测试了——从基线里删掉它们，让棘轮收得更紧：\n" + removed.join("\n"));
});

test("基线里的名字都还存在于 handlers 目录（不留僵尸条目）", () => {
  const handlers = new Set(handlerModules());
  const zombies = [...BASELINE_UNTESTED].filter((h) => !handlers.has(h));
  assert.deepEqual(zombies, [],
    "基线里有已经不存在的 handler，删掉：\n" + zombies.join("\n"));
});

test("【自证】本文件的判据真的能区分「有测试」与「没测试」", () => {
  const blob = testSourceBlob();
  // 判据的正向自证：至少要有一个 handler 被判成"有测试"，否则这条门禁
  // 退化成"全部无测试"，add/removed 两个断言都恒真。
  const handlers = handlerModules();
  const tested = handlers.filter((h) => blob.includes(h));
  assert.ok(tested.length > 0,
    "一个 handler 都没判成有测试——收集器或判据坏了，这条棘轮会变成空跑");
  // 反向自证：基线里那几个确实测不到
  // 换一个**确实还没测**的 handler 来做反向自证：
  // note-dynamic-artifact-generate 在 2026-09-29 补了锚点漂移用例后已出基线。
  assert.ok(!blob.includes("note-expansion-generate"),
    "note-expansion-generate 已经有测试了？那基线和自证都该更新");
});
