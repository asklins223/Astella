import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  API_POOL_MAX,
  POSTGRES_DEFAULT_MAX_CONNECTIONS,
  WORKER_POOL_MAX,
  WORKER_POOL_MIN,
  connectionBudget,
  describeConnectionBudget,
  workerPoolMax,
} from "../connection-budget.ts";

/**
 * P3-11：多副本部署前**必须**核一次连接预算。
 *
 * ## 这条判据的对象
 *
 * 不是"配置对不对"，是**两侧的池大小与 shared 里的预算模型是否一致**。
 *
 * 预算模型在 `packages/shared/src/connection-budget.ts`（纯函数，不连库），
 * 而**真正的池大小在两个进程各自的 `db.ts` 里**。它们必须同源：
 * 模型算出 25、代码里其实是 30，那这份预算表就是假的。
 *
 * ## 为什么"不一致"比"超了"更危险
 *
 * 超了会在部署时炸（或者变成偶发 500）。不一致则是**表看起来很安全**——
 * 有人照着这份模型决定"再开 2 个副本没问题"，而实际上早就超了。
 */

// 本文件在 `packages/shared/src/__tests__/`，仓库根往上 **四** 层。
// 写三层会落到 `packages/`，于是去找 `apps/api/src/db/client.ts` 会得到 ENOENT
// ——而 ENOENT 长得像"文件不存在"，很容易被误判成"这个判据本来就抓不到"。
const REPO_ROOT = new URL("../../../../", import.meta.url).pathname;
const API_DB = join(REPO_ROOT, "apps", "api", "src", "db", "client.ts");
const WORKER_DB = join(REPO_ROOT, "workers", "ai-worker", "src", "db.ts");

test("api 的池大小与预算模型一致（models 必须等于现实）", () => {
  const source = readFileSync(API_DB, "utf8");
  const m = source.match(/postgres\([^)]*,\s*\{[\s\S]{0,300}?max:\s*(\d+)/);
  assert.ok(m,
    "自证：判据必须从 apps/api/src/db/client.ts 里认出那个 `max:`，"
    + "否则它只是安静地什么都没检查");
  assert.equal(Number(m[1]), API_POOL_MAX,
    `api 的池是 ${m[1]}，而预算模型按 ${API_POOL_MAX} 算——`
    + "改了一边没改另一边，这份预算表就是假的");
});

test("worker 的池算法与预算模型同构", () => {
  const source = readFileSync(WORKER_DB, "utf8");
  // 逐字同构的判据：三个数字都要在
  for (const n of [WORKER_POOL_MIN, 4, WORKER_POOL_MAX]) {
    assert.ok(source.includes(String(n)),
      `workers/ai-worker/src/db.ts 里找不到 ${n}——`
      + "池算法变形了，预算模型要跟着改");
  }
  assert.ok(/Math\.max\(\s*15\s*,\s*Math\.min\(\s*64\s*,/.test(source),
    "worker 的池算法已经不是 `max(15, min(64, 并发×4))` 这个形状了——"
    + "请同步更新 connection-budget.ts 的 workerPoolMax");
});

test("workerPoolMax 与 worker 源文件里的算法给出同一个数", () => {
  // 把 worker 的算法在这里重跑一遍：改了一边没改另一边，这里会红。
  for (const concurrency of [1, 3, 4, 8, 16, 32]) {
    const fromSource = (() => {
      const raw = readFileSync(WORKER_DB, "utf8");
      // 照抄 workers/ai-worker/src/db.ts:39 的形状
      const m = raw.match(/Math\.max\((\d+),\s*Math\.min\((\d+),\s*\w+\s*\*\s*(\d+)\)\)/);
      assert.ok(m, "自证：必须能从 worker 的 db.ts 里认出池算法");
      return Math.max(Number(m[1]), Math.min(Number(m[2]), concurrency * Number(m[3])));
    })();
    assert.equal(workerPoolMax(concurrency), fromSource,
      `并发 ${concurrency} 时两边算出不同：模型 ${workerPoolMax(concurrency)}、`
      + `源码 ${fromSource}——改了一边没改另一边，这份预算表就是假的`);
  }
});

test("单实例双副本就已经很紧；worker 并发拉满会直接超", () => {
  // 默认形状：api 1 + worker 1
  const single = connectionBudget({ apiReplicas: 1, workerReplicas: 1, workerConcurrency: 3 });
  assert.equal(single.apiTotal, 25);
  assert.equal(single.workerTotal, 15);
  assert.equal(single.total, 40);
  assert.equal(single.maxConnections, POSTGRES_DEFAULT_MAX_CONNECTIONS);
  assert.ok(single.ok, "单实例双副本（40 条）应当还在默认上限内");

  // 2 副本 + worker 并发拉满：2×25 + 2×64 = 178 > 100
  const doubled = connectionBudget({ apiReplicas: 2, workerReplicas: 2, workerConcurrency: 16 });
  assert.equal(doubled.workerTotal, 128, "并发 16 → 池 64");
  assert.equal(doubled.total, 178);
  assert.equal(doubled.ok, false,
    "2 api + 2 worker（并发 16）应当判为超预算——"
    + "而 Postgres 的默认 max_connections 只有 100");
  assert.ok(describeConnectionBudget(doubled).includes("超了"),
    "超预算时说明里必须出现「超了」，否则启动日志会读成一切正常");
});

test("上限可以为系统连接留余量：贴着顶不算超", () => {
  // api 1 + worker 1 = 40；把 max_connections 设成 41 → 40 <= 40(41-1) 通过
  const tight = connectionBudget({
    apiReplicas: 1, workerReplicas: 1, workerConcurrency: 3, maxConnections: 41,
  });
  assert.equal(tight.ok, true, "留 1 条给系统连接后，40 条应当刚好放行");
  const over = connectionBudget({
    apiReplicas: 1, workerReplicas: 1, workerConcurrency: 3, maxConnections: 40,
  });
  assert.equal(over.ok, false, "40 条顶在 39 的天花板上，应当判超");
});

test("【自证】判据会红：把 api 的池改大而不动模型必须被抓", () => {
  const real = readFileSync(API_DB, "utf8");
  const inflated = real.replace("max: 25,", "max: 30,");
  const got = inflated.match(/postgres\([^)]*,\s*\{[\s\S]{0,300}?max:\s*(\d+)/);
  assert.ok(got, "自证样本没造好");
  assert.equal(Number(got[1]), 30, "自证样本应当把池改成 30");
  assert.notEqual(Number(got[1]), API_POOL_MAX,
    "自证样本没造好：改成 30 之后应当与模型对不上");
  // 自证不该改动磁盘上的文件
  assert.ok(readFileSync(API_DB, "utf8").includes("max: 25,"));
  assert.ok(existsSync(API_DB));
});
