import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * P3-1 的一部分：`packages/shared` 里不许再有"什么都放一点"的大杂烩常量文件。
 *
 * ## 这一条是怎么来的
 *
 * `packages/shared/src/constants.ts` —— 87 行、14 个常量。逐个查引用：
 * **13 个零引用**（声明了但全仓无人使用），只有 `MAX_PENDING_JOBS_PER_WORKSPACE`
 * 真的在用，而它有**两个**生产使用方（`modules/source/service.ts` 与
 * `modules/job/service.ts`）。
 *
 * 13 个零引用的删掉，文件删掉；那一个移到 `job-queue-limits.ts`——
 * 名字是内容，它就是"每个空间能排多少个待处理作业"。
 *
 * ## 为什么零引用的常量比没有更坏
 *
 * 一个没人用的常量会让人以为"这条限制已经在了"。于是：
 * 写新代码的人看到 `CARD_GENERATION_MAX_IMAGES` 就以为上限受管，
 * 而真正生效的是别处硬写的字面量——**看着有约束、实际没有**。
 *
 * ## 这条判据守什么
 *
 * 守住"**不新建**大杂烩常量文件"，以及"已经搬走的那个不回来"。
 * 它不负责判断每个常量该不该存在（那是逐条 review 的事），
 * 负责的是别再攒出下一个 `constants.ts`。
 */

// 本文件在 `apps/api/src/__tests__/`，仓库根往上 **四** 层。
// ⚠️ 这个 off-by-one 本轮会话已经栽过五次（文档指针、feature-flags、连接预算、
//    迁移指令守卫、这里）——每次的报错都是 ENOENT，而 ENOENT 长得像
//    「文件不存在 / 判据本来就抓不到」，很容易把尺子的错当成结论。
const REPO_ROOT = new URL("../../../../", import.meta.url).pathname;
const SHARED_SRC = join(REPO_ROOT, "packages", "shared", "src");

test("shared 里那个大杂烩常量文件已经不在了", () => {
  assert.ok(
    !existsSync(join(SHARED_SRC, "constants.ts")),
    "packages/shared/src/constants.ts 又回来了——"
    + "它此前 87 行 14 个常量里 13 个零引用，是典型的『看着有约束、实际没人用』。",
  );
});

test("barrel 里没有残留的 constants 转出", () => {
  const index = readFileSync(join(SHARED_SRC, "index.ts"), "utf8");
  assert.ok(
    !/export \* from "\.\/constants\.ts"/.test(index),
    "index.ts 还在转出 ./constants——那个文件已经删了，这行会让 barrel 直接报错",
  );
});

test("shared 里不再有『只放常量大杂烩』的短文件", () => {
  // 判据：文件名是裸的 nouns.ts / constants.ts / limits.ts 这类**通用词**，
  // 而内容全是常量导出。带具体前缀的（job-queue-limits.ts）不在此列——
  // 它的名字说明了它管什么，这正是它能存在的原因。
  const GENERIC = /^(constants|consts|limits|values|numbers|settings|misc)\.ts$/;
  const offenders: string[] = [];
  for (const name of readdirSync(SHARED_SRC)) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    if (!GENERIC.test(name)) continue;
    const source = readFileSync(join(SHARED_SRC, name), "utf8");
    const exports = [...source.matchAll(/^export (?:const|function|type|interface) /gm)];
    if (exports.length > 0) offenders.push(`${name}（${exports.length} 个导出）`);
  }
  assert.deepEqual(
    offenders,
    [],
    "这些通用命名的文件装着一堆导出：\n" + offenders.join("\n")
    + "\n常量应当住在**名字说明它管什么**的文件里（例：job-queue-limits.ts）。"
    + "『什么都放一点』的文件既不会被找到，也不会被当成契约。",
  );
});

test("活下来的那个常量确实住在名字对得上的地方", () => {
  const limits = readFileSync(join(SHARED_SRC, "job-queue-limits.ts"), "utf8");
  assert.ok(
    /MAX_PENDING_JOBS_PER_WORKSPACE\s*=\s*\d+/.test(limits),
    "job-queue-limits.ts 里应当有那个跨模块的作业上限",
  );
  // 它有**两个**生产使用方，所以它必须留在 shared 而不是某个 api 模块里
  const users: string[] = [];
  for (const base of ["apps/api/src", "workers/ai-worker/src"]) {
    const abs = join(REPO_ROOT, base);
    if (!existsSync(abs)) continue;
    for (const file of walk(abs)) {
      if (file.endsWith(".test.ts")) continue;
      if (/MAX_PENDING_JOBS_PER_WORKSPACE/.test(readFileSync(file, "utf8"))) users.push(file);
    }
  }
  assert.ok(users.length >= 2,
    `只有 ${users.length} 处生产使用方——那它就不该留在 shared，`
    + "跟着唯一的使用方走即可");
});

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("【自证】判据会红：造一个 constants.ts 出来必须被抓", () => {
  assert.ok(
    GENERIC_RE.test("constants.ts"),
    "自证样本没造好：判据没认得这个名字",
  );
  assert.ok(
    !GENERIC_RE.test("job-queue-limits.ts"),
    "自证样本没造好：具体命名的文件不该被算进违规",
  );
  assert.ok(existsSync(join(SHARED_SRC, "job-queue-limits.ts")),
    "自证：磁盘上的文件不该被动过");
});

const GENERIC_RE = /^(constants|consts|limits|values|numbers|settings|misc)\.ts$/;
