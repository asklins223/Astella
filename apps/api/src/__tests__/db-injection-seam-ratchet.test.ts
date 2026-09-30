import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * P2-4：DB 注入缝**不得回退**。
 *
 * ## 审计说的和实测的
 *
 * 审计写"引入 DB 注入缝（哪怕 `setTestDb()` 形式的显式测试钩子），
 * **否则任何 DB 相关单元测试都写不出来**"。
 *
 * 后半句不成立。2026-09-29 实测：
 *   · `executor: ApiTransaction` 形参已有 **61** 处，横跨 note / companion-conversation /
 *     learning-runs / learning-sessions / note-learning-rounds / source / search / understanding；
 *   · 已经有测试文件靠手搓 executor 替身跑纯单元测试；
 *   · `apps/api/src/modules` 里**只剩 1 处**直接 `await db.select/insert/update/delete`。
 *
 * 也就是说本仓库当初选的**就是**更好的那条路（函数参数注入，而不是全局测试钩子）。
 * 全局 `setTestDb()` 那种钩子会带来另一种病：测试之间互相污染，且生产代码里
 * 多一条"只在测试里才走"的分支。
 *
 * ## 那还剩什么
 *
 * 剩的是**防回退**。注入缝最常见的失效方式不是有人"决定不用"，而是
 * 新写一个服务时图省事直接 `db.…`，没人发现——它能跑通，只是那个函数从此没法单测。
 *
 * 所以这里钉住基线，并且给那唯一一处合法例外留了名字与理由。
 */

const API_ROOT = new URL("..", import.meta.url).pathname;

/**
 * 唯一一处允许直接用裸 `db` 的地方。
 *
 * `note/maintenance.ts` 的 `purgeSoftDeletedNotes`：它要先**枚举所有空间**，
 * 而 `workspaces` 的 RLS 守卫有一条 NULL 分支（0257 专为登录路径开的），
 * 所以这一步用裸 `db` 是安全的。真正读笔记的每一步都回到带上下文的事务里——
 * `notes` 是 `ENABLE + FORCE ROW LEVEL SECURITY`，用裸 `db` 读它恒 0 行。
 *
 * 那个文件里已经把这层区别写进注释了（doc 34 L37 症状 A）。
 */
const ALLOWED_BARE_DB: Readonly<Record<string, string>> = {
  "modules/note/maintenance.ts":
    "枚举 workspaces（该表守卫有 NULL 分支）；读 notes 全部回到带上下文的事务",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const MODULES = join(API_ROOT, "modules");

/** 直接拿裸 `db` 做写读的地方。 */
function bareDbSites(): string[] {
  const out: string[] = [];
  for (const file of walk(MODULES)) {
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(/await\s+db\.(select|insert|update|delete)\b/g)) {
      const line = source.slice(0, m.index).split("\n").length;
      out.push(`${file.replace(`${API_ROOT}`, "")}:${line}:db.${m[1]}`);
    }
  }
  return out;
}

test("注入缝不回退：裸 db 的写读点不得增加", () => {
  // ⚠️ 去到**文件级**再查豁免表：site 的形状是 `路径:行号 db.xxx`，
  //    带着行号去查就永远匹配不上 ALLOWED_BARE_DB 的键——第一版就栽在这里，
  //    把唯一那处合法例外报成了违规。
  const fileOf = (site: string) => site.split(":")[0]!;
  const sites = bareDbSites().map(fileOf);
  const offenders = sites.filter((f) => !(f in ALLOWED_BARE_DB));
  assert.deepEqual(
    offenders,
    [],
    "这些地方直接用裸 db 做写读，服务函数从此没法在不连库的情况下单测：\n"
    + offenders.join("\n")
    + "\n\n两条路：把 executor 提成第一个形参（本仓库既有的 61 处都是这么做的），"
    + "或者——如果确实像 note/maintenance.ts 那样必须枚举跨空间的数据——"
    + "在本文件顶部的 ALLOWED_BARE_DB 里登记，并写清**为什么**这一处安全。",
  );
});

test("豁免表里登记的例外确实还在，且理由不是空的", () => {
  // 防的是"豁免表变成陈年旧账"：类被删了、或者改成走事务了，登记都要跟着减。
  const present = new Set(
    walk(MODULES).map((f) => f.replace(`${API_ROOT}`, "")),
  );
  for (const [file, reason] of Object.entries(ALLOWED_BARE_DB)) {
    assert.ok(present.has(file),
      `ALLOWED_BARE_DB 里的 ${file} 已经不存在了——请把这条登记删掉`);
    assert.ok(reason.trim().length > 10,
      `${file} 的豁免理由太短："${reason}"——写清**为什么**这一处用裸 db 是安全的`);
    assert.ok(bareDbSites().some((s) => s.startsWith(`${file}:`)),
      `${file} 已经不再用裸 db 了——豁免该撤了`);
  }
});

test("【自证】判据会红：新开一处裸 db 就会被抓", () => {
  const real = bareDbSites();
  const polluted = [...real, "modules/example/service.ts:10:db.select"];
  const offenders = polluted
    .map((s) => s.split(":")[0]!)
    .filter((f) => !(f in ALLOWED_BARE_DB));
  assert.equal(offenders.length, 1,
    "自证样本没造好：造的那一处应当正好落在豁免表之外");
  assert.ok(offenders[0]!.includes("example"),
    "自证样本没造好：报出来的应当是造的那一处");
  // 自证不该改动磁盘上的文件
  assert.deepEqual(bareDbSites(), real, "自证不该改动磁盘上的文件");
});
