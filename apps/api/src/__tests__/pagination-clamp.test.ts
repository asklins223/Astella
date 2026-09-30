import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { clampLimit, clampOffset } from "../lib/pagination-utils.ts";

/**
 * P1-4：分页收敛到 `lib/pagination-utils.ts`，并防回退。
 *
 * ## 收口前实测到的东西
 *
 * 全仓 11 处手写 `Math.min(Math.max(...))` / `Math.max(1, Math.min(...))` 形式的
 * limit clamp。逐个喂 NaN 实测：**10 处原样吐出 NaN**。
 *
 * 后果不是"数字不对"这么轻——`learning-objectives/routes.ts:27` 的注释记着：
 * **drizzle 收到 NaN 时不渲染 LIMIT**，于是该端点退化成**全表扫描**。
 * 一个 `?limit=abc` 就能让任意这些端点扫全表。
 *
 * 唯一没中招的是 `note/routes.ts` 那一处，因为它顺手写了 `|| 100`（NaN 是 falsy）。
 * 这说明另外 10 处不是"忘了处理边界"，是**各自都不知道对方怎么处理**。
 */

test("clampLimit 对 NaN / 非数值字符串退回默认值（drizzle 的 NaN=无 LIMIT 漏洞）", () => {
  // 这三条正是线上会收到的 `?limit=` 取值
  assert.equal(clampLimit(Number.NaN, 20, 100), 20);
  assert.equal(clampLimit("abc", 20, 100), 20);
  assert.equal(clampLimit("", 20, 100), 20);
  assert.equal(clampLimit("  ", 20, 100), 20);
  assert.equal(clampLimit(Infinity, 20, 100), 20);
  assert.equal(clampLimit(-Infinity, 20, 100), 20);
  assert.equal(clampLimit(undefined, 20, 100), 20);
  assert.equal(clampLimit(null, 20, 100), 20);
});

test("clampLimit 收下字符串：不必每个调用点自己做 Number()", () => {
  assert.equal(clampLimit("50", 20, 100), 50);
  assert.equal(clampLimit("  7  ", 20, 100), 7, "带空白的数字串也要能用");
  assert.equal(clampLimit("1000", 20, 100), 100, "超上界压到 max");
  assert.equal(clampLimit("0", 20, 100), 1, "0 被抬到下界 1");
  assert.equal(clampLimit("-5", 20, 100), 1, "负数被抬到下界 1");
  assert.equal(clampLimit("3.9", 20, 100), 3, "小数向下取整");
});

test("clampLimit 的上界/下界语义（与收口前的目标值一致）", () => {
  assert.equal(clampLimit(5, 20, 100), 5);
  assert.equal(clampLimit(0, 20, 100), 1);
  assert.equal(clampLimit(-1, 20, 100), 1);
  assert.equal(clampLimit(200, 20, 100), 100);
  assert.equal(clampLimit(undefined, 200, 500), 200, "默认值本身不受 max 约束");
});

test("守卫：模块里不再手写 limit clamp", () => {
  const API_ROOT = new URL("../..", import.meta.url).pathname;
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) files.push(full);
    }
  };
  walk(join(API_ROOT, "src"));

  const offenders: string[] = [];
  for (const file of files) {
    const rel = relative(API_ROOT, file).split("/").join("/");
    if (rel === "src/lib/pagination-utils.ts") continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      // 只看注释行之外、且确实在夹一个 limit 的那种夹法
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
      const clamps = /Math\.(min|max)\s*\(\s*Math\.(min|max)\s*\(/.test(line);
      const mentionsLimit = /limit/i.test(line);
      if (clamps && mentionsLimit) {
        offenders.push(`${rel}:${i + 1}  ${trimmed.slice(0, 80)}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    "又手写了 limit clamp——用 lib/pagination-utils.ts 的 clampLimit：\n" + offenders.join("\n"));
});

/* ── clampOffset 的上界（P3-8）───────────────────────────────────────────── */

test("clampOffset 有上界：深翻页不能让 Postgres 扫到天荒地老", () => {
  // OFFSET 是"扫过再丢掉"。`OFFSET 10_000_000 LIMIT 50` 仍然要先读那一千万行。
  // 此前这个函数**只有下界**，所以 `?offset=10000000` 原样进 `.offset()`。
  assert.equal(clampOffset(10_000_000), 10_000);
  assert.equal(clampOffset(10_000), 10_000, "上界本身是允许的");
  assert.equal(clampOffset(10_001), 10_000);
  // 上界之内不该被改动（这里的上界是 1 万，不是 1 千万）
  assert.equal(clampOffset(0), 0);
  assert.equal(clampOffset(1_234), 1_234);
  assert.equal(clampOffset(9_999), 9_999);
  assert.equal(clampOffset(9_999_999), 10_000, "远超上界时被压到上界");
  // 下界行为不能因为加了上界而变
  assert.equal(clampOffset(-1), 0);
  assert.equal(clampOffset(-1, 20), 20, "defaultValue 仍然作为下界");
  // 字符串形态：与 clampLimit 同一套约定
  assert.equal(clampOffset("10000000"), 10_000);
  assert.equal(clampOffset(""), 0, "空串按『没给』处理");
  assert.equal(clampOffset("abc"), 0, "非数字不触发 500");
});

test("clampOffset 的上界可按路由调大，但不允许取消", () => {
  assert.equal(clampOffset(50_000, 0, 50_000), 50_000, "要放行到 5 万时给 max 就行");
  assert.equal(clampOffset(60_000, 0, 50_000), 50_000);
  // max 比 defaultValue 还小时不能让结果低于下界
  assert.equal(clampOffset(60_000, 100, 10), 100);
});
