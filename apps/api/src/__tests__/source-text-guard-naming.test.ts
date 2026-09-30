import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * P3-5：只对**源码文本**下断言的测试，名字里要看得出来。
 *
 * ## 要区分的是哪两种测试
 *
 * · **行为测试** —— import 被测模块、调用它、断言返回值。
 * · **源码文本守卫** —— `readFileSync` 把源文件读进来，用正则或 `includes`
 *   断言"那一行必须长这样"。
 *
 * 两者都叫 `*.test.ts`。于是打开一份失败列表的人会以为它在测行为，
 * 而它其实钉的是**某段文本**——于是两种误读都来了：
 * 改代码时以为守卫会跟着语义走（它不会，它只认文本），
 * 以及以为"没红就是功能对了"（文本对不等于行为对）。
 *
 * ## 为什么不批量改名
 *
 * 2026-09-29 实测这类文件有 **66 个**（判据见下面 `isSourceTextGuard`）。
 * 一次改 66 个名字会同时动 CI 脚本、覆盖率门禁的文件清单与若干按路径找夹具的
 * 守卫——而"让它少几个"带来的收益远小于那份对账重新跑一遍的成本。
 *
 * 所以这里做的是**棘轮**：把现状钉成基线，**只许减不许增**。
 * 每改一个名字，基线减一；改完了这条自然退场。
 *
 * ⚠️ 本条**不删任何东西**。源码文本守卫在很多地方是唯一能钉住那条不变量
 * 的手段（RLS 谓词、migrate runner 的分流、路由版本前缀……）——
 * 删掉它们是把契约丢了，不是把债还了。
 */

const REPO_ROOT = new URL("../../../../", import.meta.url).pathname;
const ROOTS = [
  "apps/api/src",
  "packages/shared/src",
  "workers/ai-worker/src",
];

/** 名字里带了这些词，就已经在说"我是守卫"。 */
const MARKERS = ["guard", "contract", "shape", "lint", "source", "ratchet", "coverage"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/** 这个测试是「只对源码文本下断言」的守卫吗？ */
function isSourceTextGuard(source: string): boolean {
  if (!/readFileSync|readFile\(/.test(source)) return false;
  // 只要 import 了本地模块，它就至少有一部分在跑真代码
  const localImports = [...source.matchAll(/^import .*? from "(\.[^"]*)"/gm)];
  return localImports.length === 0;
}

/** 名字里没说自己是守卫的那些。 */
function unnamedSourceTextGuards(): string[] {
  const out: string[] = [];
  for (const rel of ROOTS) {
    const abs = join(REPO_ROOT, rel);
    let entries: string[];
    try {
      entries = walk(abs);
    } catch {
      continue;
    }
    for (const file of entries) {
      const base = file.split("/").pop()!;
      // 迁移测试的文件名就是迁移号，它已经说清了自己在看什么
      if (/^\d{4}-/.test(base)) continue;
      if (MARKERS.some((m) => base.includes(m))) continue;
      if (!isSourceTextGuard(readFileSync(file, "utf8"))) continue;
      out.push(file.replace(`${REPO_ROOT}/`, ""));
    }
  }
  return out.sort();
}

/**
 * 2026-09-29 实测基线，**只许往下走**。
 *
 *   66 → 首测值（用一份较松的脚本量的，含 desktop 端，偏大）
 *   50 → 同日重命名了本会话自己新建的 8 个之后，**由本判据自己重新量出的真值**：
 *        66 - 8 = 58 仍然偏松，于是按实际测量收到 50。
 *          feature-flag-consolidation / feature-flags-naming / error-envelope /
 *          doc-pointer-reachability / cursor-column-db-clock /
 *          memory-upsert-atomicity / shared-no-grabbag-constants / note-single-projection
 *        （都加了 `-source-guard` 后缀，且已确认**无任何外部引用**）
 *
 * 教训写在这里：基线必须由**判据自己**数一遍，不能用另一份脚本的结果——
 * 两份脚本口径不同时，棘轮就松了，而棘轮松了等于没有。
 *
 * 改一个名字就把它减一，并在同一处写明改了哪个——
 * 这样"还剩多少"始终是文件里的一个真数，而不是一次性的印象。
 */
const BASELINE = 50;

test("只对源码文本下断言的测试不许变多（名字要说清自己是守卫）", () => {
  const current = unnamedSourceTextGuards();
  assert.ok(
    current.length <= BASELINE,
    `名字里没说自己是守卫的源码文本测试从 ${BASELINE} 涨到了 ${current.length}。\n`
    + "新增这类测试时，文件名请带上 guard / contract / shape / source 之一，"
    + "或者直接写成 `NNNN-…-migration.test.ts`（迁移号已经说清它在看什么）。\n"
    + "理由：打开失败列表的人分不出「行为测试红了」和「文本形状变了」，"
    + "而这两种红的处理方式完全不同。",
  );
  // 自证：判据必须至少认得出一个，不能因为过滤条件写错而恒为空
  assert.ok(current.length > 0,
    "自证：判据认不出任何『未命名的源码文本守卫』——多半是过滤条件写坏了，"
    + "那样这条棘轮会永远绿");
});

test("【自证】判据会红：造一个未命名的源码文本守卫必须被抓", () => {
  const sample = [
    'import { readFileSync } from "node:fs";',
    'test("x", () => {',
    '  const s = readFileSync("a.ts", "utf8");',
    '  assert.match(s, /foo/);',
    "});",
  ].join("\n");
  assert.ok(isSourceTextGuard(sample),
    "自证样本没造好：判据必须认得出「只读文件不 import 本地模块」这种形状");
  // 掺一个本地 import 之后就不该再算纯文本守卫
  const withLocal = sample.replace(
    'import { readFileSync } from "node:fs";',
    'import { readFileSync } from "node:fs";\nimport { thing } from "./thing.ts";',
  );
  assert.equal(isSourceTextGuard(withLocal), false,
    "自证样本没造好：import 了本地模块之后就不算纯文本守卫了");
  // 名字里带标记的也不该进名单
  assert.ok(MARKERS.some((m) => "my-source-guard.test.ts".includes(m)));
});
