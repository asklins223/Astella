import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * P3-4：源码里的**文档指针不许指向不存在的文件**。
 *
 * ## 背景
 *
 * 2026-09-29 有一批历史方案文档从仓库移出到本机 `project-archive/`
 * （`.gitignore` 忽略、不随仓库分发）。源码注释里当时还留着**十几处**指向
 * 那批已移出文档的路径——打开就是 404，读者没法核对。
 *
 * ## 为什么不能靠"把路径删掉"了事
 *
 * 那些注释都带着**判据的来由**（§4.3 / §P1 / §16.1 这类）。删干净了，
 * 下一个人看到一条不知道怎么来的规则，只能去猜或者重写一遍。
 *
 * 所以改成"原据 `<文档名>`，2026-09-29 已归档"——**保留出处、消掉坏路径**。
 *
 * ## 这条判据守什么
 *
 * 守住"源码注释里的 `docs/…` 指针必须能打开"。对象是**指针的可达性**，
 * 不是注释的内容。
 *
 * ## 一处自指的处理
 *
 * 本文件**排除自身**：注释里写着指针的形状，自证样本里还故意放了一个
 * 不存在的路径。扫自己必然把自己判成违规——"棘轮给自己打分"这个坑踩过不止一次。
 */

const REPO_ROOT = new URL("../../../../", import.meta.url).pathname;
const SELF = "doc-pointer-reachability-source-guard.test.ts";
const ROOTS = [
  "apps/api/src",
  "workers/ai-worker/src",
  "packages/shared/src",
  "apps/desktop-client/src",
];

/** 现行合同：只有这几份在仓库里，其余 learning-companion 文档都已移出。 */
const CURRENT_CONTRACTS: Readonly<Record<string, readonly string[]>> = {
  "docs/plans/learning-companion": [
    "40-companion-long-term-experience-and-diary-prd-2026-09-25.md",
    "40b-companion-runtime-and-observability-2026-09-27.md",
    "41-note-companion-learning-experience-2026-09-28.md",
    "41a-unified-agent-foundation-2026-09-28.md",
    "README.md",
  ],
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** 注释里的文档指针（路径以 `.md` 收尾）。 */
const DOC_POINTER = /(docs\/[A-Za-z0-9_./-]+?\.md)/g;

function danglingPointers(): string[] {
  const out: string[] = [];
  for (const rel of ROOTS) {
    const abs = join(REPO_ROOT, rel);
    if (!existsSync(abs)) continue;
    for (const file of walk(abs)) {
      if (file.endsWith(SELF)) continue;
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(DOC_POINTER)) {
        if (!existsSync(join(REPO_ROOT, m[1]!))) {
          out.push(`${file.replace(`${REPO_ROOT}/`, "")}: ${m[1]}`);
        }
      }
    }
  }
  return out;
}

test("源码注释里的 docs 指针都还能打开", () => {
  // 先确认判据不是空跑：现役指针至少要有一个
  let total = 0;
  for (const rel of ROOTS) {
    const abs = join(REPO_ROOT, rel);
    if (!existsSync(abs)) continue;
    for (const file of walk(abs)) {
      if (file.endsWith(SELF)) continue;
      total += [...readFileSync(file, "utf8").matchAll(DOC_POINTER)].length;
    }
  }
  assert.ok(total > 0, "自证：判据至少要扫到一个 docs 指针，否则它在空跑");

  assert.deepEqual(
    danglingPointers(),
    [],
    "这些注释里的文档指针指向不存在的文件。\n"
    + "2026-09-29 有一批 learning-companion 历史文档移出了仓库。\n"
    + "保留出处、去掉坏路径的写法是：「原据 <文档名>，2026-09-29 已归档」——"
    + "出处还在，路径不再是死链。",
  );
});

test("现行合同的清单与磁盘一致（别让它悄悄过期）", () => {
  for (const [dir, names] of Object.entries(CURRENT_CONTRACTS)) {
    for (const name of names) {
      assert.ok(
        existsSync(join(REPO_ROOT, dir, name)),
        `清单里的 ${dir}/${name} 已经不存在了——`
        + "历史文档重新入库或再次移出时，请同步更新这张表",
      );
    }
  }
});

test("【自证】判据会红：一个不存在的指针必须被判成悬空", () => {
  const bogus = "docs/plans/learning-companion/99-does-not-exist.md";
  assert.ok(!existsSync(join(REPO_ROOT, bogus)),
    "自证样本没造好：造出来的路径居然是存在的");
  assert.equal(
    [...` 判据原文（${bogus} §1）`.matchAll(DOC_POINTER)].length,
    1,
    "自证样本没造好：判据没认得出这个指针",
  );
  assert.ok(existsSync(join(REPO_ROOT, "README.md")), "自证不该改动磁盘上的文件");
});
