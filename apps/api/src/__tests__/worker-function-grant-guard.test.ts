/**
 * 守卫：worker 调用的每个 public 函数都必须有 `ailearn_worker` 的 EXECUTE 授权。
 *
 * ## 这条守卫挡住的是哪次真事故
 *
 * 2026-10-01~02 实测：worker 用受限角色 `ailearn_worker`（compose 的
 * DATABASE_URL_WORKER），而 `ailearn_purge_expired_companion_memory`（0345）与
 * `ailearn_enforce_companion_memory_retention`（0346）各自 REVOKE 掉 PUBLIC 之后
 * **只授给了 `ailearn_api`**。后台 tick 每秒调一次 → 每秒两条
 * `42501 permission denied`，18 小时不停，worker 日志 43.8 MB、容器 CPU 237%。
 *
 * 0346 内部自己就露了马脚：第 115 行给 `ailearn_companion_memory_retention_limits`
 * 授了 worker，紧接着第 116 行的 enforce 又只授 api。所以这不是设计，是笔误——
 * 而笔误在两个数据库角色之间，肉眼 review 极难发现：同一个迁移文件里，
 * 授 api 的行和授 worker 的行紧挨着。
 *
 * ## 判据怎么定的
 *
 * 一个函数对 worker 可用，当且仅当二者之一：
 *   (a) 某条迁移 `GRANT EXECUTE ... TO ailearn_worker`；或
 *   (b) 全仓从未 `REVOKE ... FROM PUBLIC` —— 那它对 PUBLIC 可执行，worker 也在其中。
 *
 * 只做 (a) 会误报：`ailearn_queue_job_depth` / `ailearn_queue_oldest_pending_age`
 * 从没被 revoke 过，PUBLIC 本来就能执行，worker 一直在正常调用（实测
 * `failed to refresh queue metrics` 全程只有 3 次，且都是启动瞬间）。
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const REPO_ROOT = new URL("../../../../", import.meta.url).pathname;
const WORKER_SRC = join(REPO_ROOT, "workers/ai-worker/src");
const MIGRATIONS_DIR = join(REPO_ROOT, "apps/api/src/db/migrations");

/** 运行时源码目录；测试与集成测试不算调用方。 */
function runtimeSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "integration-tests") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...runtimeSourceFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

const CALLED = new Map<string, string>(); // 函数名 → 首个调用点（相对路径）
for (const file of runtimeSourceFiles(WORKER_SRC)) {
  const text = readFileSync(file, "utf8");
  for (const fn of text.matchAll(/public\.(ailearn_\w+)\s*\(/g)) {
    if (!CALLED.has(fn[1])) {
      CALLED.set(fn[1], file.slice(REPO_ROOT.length));
    }
  }
}

/** 函数名 → 拿到过 EXECUTE 的角色集合。 */
const GRANTED_ROLES = new Map<string, Set<string>>();
/** 被 REVOKE 掉 PUBLIC 的函数。 */
const REVOKED_FROM_PUBLIC = new Set<string>();

const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

for (const file of migrationFiles) {
  const text = readFileSync(join(MIGRATIONS_DIR, file), "utf8");

  // 签名可能跨行（形参里的类型带逗号），所以括号内允许换行。
  for (const m of text.matchAll(
    /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.(ailearn_\w+)\s*\([\s\S]*?\)\s*TO\s+([^;]+);/gi,
  )) {
    const roles = GRANTED_ROLES.get(m[1]) ?? new Set<string>();
    for (const role of m[2].split(",")) roles.add(role.trim().toLowerCase());
    GRANTED_ROLES.set(m[1], roles);
  }
  for (const m of text.matchAll(
    /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.(ailearn_\w+)\s*\([\s\S]*?\)\s*FROM\s+PUBLIC/gi,
  )) {
    REVOKED_FROM_PUBLIC.add(m[1]);
  }
}

test("扫描本身有效：不能扫出空集后「全部通过」", () => {
  // 反向控制。这条守卫的断言全是「不该出现」，一旦正则写坏、
  // 目录挪了或 `public.` 前缀约定变了，CALLED 会变空集而**照样全绿**——
  // 那是空断言，不是通过。判据：worker 确实在调一批 SECURITY DEFINER 函数。
  assert.ok(
    CALLED.size >= 12,
    `只扫到 ${CALLED.size} 个函数，正则/目录一定坏了（实测应为 16 个）`,
  );
  assert.ok(
    CALLED.has("ailearn_purge_expired_companion_memory"),
    "事故函数本身必须仍在扫描范围内——否则这条守卫已经失效",
  );
  assert.ok(REVOKED_FROM_PUBLIC.size > 0, "一条 REVOKE 都没扫到，grant 解析多半坏了");
});

test("worker 调用的每个 public 函数都对 ailearn_worker 可执行", () => {
  const broken: string[] = [];
  for (const [fn, caller] of CALLED) {
    const granted = GRANTED_ROLES.get(fn);
    if (granted?.has("ailearn_worker")) continue;
    if (!REVOKED_FROM_PUBLIC.has(fn)) continue; // 仍属 PUBLIC，可执行
    broken.push(`${fn}（${caller}）`);
  }
  assert.deepEqual(
    broken,
    [],
    `这些函数 REVOKE 掉 PUBLIC 后没给 ailearn_worker 授权，worker 调用即 42501：\n`
      + broken.join("\n")
      + "\n补一条 GRANT EXECUTE ... TO ailearn_worker 的迁移。",
  );
});

test("【自证】判据认得出「只授 api」这个真实退化", () => {
  // 反向控制：把 worker 的授权摘掉，同一套判据必须报红。
  const fakeRoles = new Map(GRANTED_ROLES);
  fakeRoles.set("ailearn_purge_expired_companion_memory", new Set(["ailearn_api"]));
  const fakeRevoked = new Set(REVOKED_FROM_PUBLIC);
  fakeRevoked.add("ailearn_purge_expired_companion_memory");

  const usable = (fn: string) =>
    fakeRoles.get(fn)?.has("ailearn_worker") || !fakeRevoked.has(fn);
  assert.equal(usable("ailearn_purge_expired_companion_memory"), false);
  assert.equal(usable("ailearn_queue_job_depth"), true, "没 revoke 的走 PUBLIC，仍可用");
});

test("0359 已登记且授对了角色", () => {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string }> };
  assert.ok(
    journal.entries.some((e) => e.tag === "0359_worker_function_grant_repair"),
    "0359 没进 journal，migrate 永远不会执行它",
  );

  const repair = readFileSync(
    join(MIGRATIONS_DIR, "0359_worker_function_grant_repair.sql"),
    "utf8",
  );
  assert.match(
    repair,
    /GRANT EXECUTE ON FUNCTION public\.ailearn_purge_expired_companion_memory\(\) TO ailearn_worker;/,
  );
  assert.match(
    repair,
    /GRANT EXECUTE ON FUNCTION public\.ailearn_enforce_companion_memory_retention\(\) TO ailearn_worker;/,
  );
});