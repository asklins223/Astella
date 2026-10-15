/**
 * 守卫：worker 调用的每个 public 函数都必须有 `astella_worker` 的 EXECUTE 授权。
 *
 * ## 这条守卫挡住的是哪次真事故
 *
 * 2026-10-01~02 实测：worker 用受限角色 `astella_worker`（compose 的
 * DATABASE_URL_WORKER），而 `astella_purge_expired_companion_memory`（0345）与
 * `astella_enforce_companion_memory_retention`（0346）各自 REVOKE 掉 PUBLIC 之后
 * **只授给了 `astella_api`**。后台 tick 每秒调一次 → 每秒两条
 * `42501 permission denied`，18 小时不停，worker 日志 43.8 MB、容器 CPU 237%。
 *
 * 0346 内部自己就露了马脚：第 115 行给 `astella_companion_memory_retention_limits`
 * 授了 worker，紧接着第 116 行的 enforce 又只授 api。所以这不是设计，是笔误——
 * 而笔误在两个数据库角色之间，肉眼 review 极难发现：同一个迁移文件里，
 * 授 api 的行和授 worker 的行紧挨着。
 *
 * ## 判据怎么定的
 *
 * 一个函数对 worker 可用，当且仅当二者之一：
 *   (a) 某条迁移 `GRANT EXECUTE ... TO astella_worker`；或
 *   (b) 全仓从未 `REVOKE ... FROM PUBLIC` —— 那它对 PUBLIC 可执行，worker 也在其中。
 *
 * 只做 (a) 会误报：`astella_queue_job_depth` / `astella_queue_oldest_pending_age`
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
  for (const fn of text.matchAll(/public\.(astella_\w+)\s*\(/g)) {
    if (!CALLED.has(fn[1])) {
      CALLED.set(fn[1], file.slice(REPO_ROOT.length));
    }
  }
}

/** 函数名 → 拿到过 EXECUTE 的角色集合。 */
const GRANTED_ROLES = new Map<string, Set<string>>();
/** 迁移里显式授给 api/worker 的函数 → 角色集合（**不限 `astella_` 前缀**）。 */
const MIGRATION_GRANTS = new Map<string, Set<string>>();
/** 被 REVOKE 掉 PUBLIC 的函数。 */
const REVOKED_FROM_PUBLIC = new Set<string>();
/** 迁移流水里「最后一次动作是 DROP」的函数——早先那条 GRANT 已经随函数一起没了。 */
const DROPPED_BY_LATER_MIGRATION = new Set<string>();

const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const GRANT_RE =
  /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.([A-Za-z_]\w*)\s*\([\s\S]*?\)\s*TO\s+([^;]+);/gi;

for (const file of migrationFiles) {
  const text = readFileSync(join(MIGRATIONS_DIR, file), "utf8");

  // 签名可能跨行（形参里的类型带逗号），所以括号内允许换行。
  for (const m of text.matchAll(GRANT_RE)) {
    const roles = GRANTED_ROLES.get(m[1]) ?? new Set<string>();
    for (const role of m[2].split(",")) roles.add(role.trim().toLowerCase());
    GRANTED_ROLES.set(m[1], roles);

    if (m[1].startsWith("astella_")) continue; // 上面那份判据只看 worker 直接调的 astella_*
    const runtime = MIGRATION_GRANTS.get(m[1]) ?? new Set<string>();
    for (const role of m[2].split(",")) {
      const r = role.trim().toLowerCase();
      if (r === "astella_api" || r === "astella_worker") runtime.add(r);
    }
    if (runtime.size) MIGRATION_GRANTS.set(m[1], runtime);
  }
  for (const m of text.matchAll(
    /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.(astella_\w+)\s*\([\s\S]*?\)\s*FROM\s+PUBLIC/gi,
  )) {
    REVOKED_FROM_PUBLIC.add(m[1]);
  }
  // 按迁移顺序覆盖登记：先建后删 → 不在册；删了又重建 → 回到在册。
  for (const m of text.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.([A-Za-z_]\w*)/gi)) {
    DROPPED_BY_LATER_MIGRATION.delete(m[1]);
  }
  for (const m of text.matchAll(/DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?public\.([A-Za-z_]\w*)/gi)) {
    DROPPED_BY_LATER_MIGRATION.add(m[1]);
  }
}

// 迁移之外，还有 `astella_` 前缀的授权同样会被 role-grants 收掉，一并纳入下面的对账。
for (const [fn, roles] of GRANTED_ROLES) {
  const runtime = MIGRATION_GRANTS.get(fn) ?? new Set<string>();
  for (const r of roles) {
    if (r === "astella_api" || r === "astella_worker") runtime.add(r);
  }
  if (runtime.size) MIGRATION_GRANTS.set(fn, runtime);
}

const ROLE_BOOTSTRAP = readFileSync(
  join(REPO_ROOT, "infra/postgres/roles.sql"),
  "utf8",
);

/** roles.sql 在顶部全量 REVOKE 之后**重新授出去**的 (函数 → 角色)。 */
const REGRANTED = new Map<string, Set<string>>();
function collect(target: Map<string, Set<string>>, fn: string, roleList: string) {
  const roles = target.get(fn) ?? new Set<string>();
  for (const r of roleList.split(",")) {
    const role = r.trim().toLowerCase();
    if (role === "astella_api" || role === "astella_worker") roles.add(role);
  }
  if (roles.size) target.set(fn, roles);
}
// 落点一：显式 `GRANT EXECUTE ON FUNCTION public.x(...) TO ...`
for (const m of ROLE_BOOTSTRAP.matchAll(GRANT_RE)) collect(REGRANTED, m[1], m[2]);
// 落点二：数组驱动的 `('public.x(args)', 'astella_api, astella_worker')`
for (const m of ROLE_BOOTSTRAP.matchAll(
  /\(\s*'public\.([A-Za-z_]\w*)\([^']*\)'\s*,\s*'([^']*)'\s*\)/g,
)) {
  collect(REGRANTED, m[1], m[2]);
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
    CALLED.has("astella_purge_expired_companion_memory"),
    "事故函数本身必须仍在扫描范围内——否则这条守卫已经失效",
  );
  assert.ok(REVOKED_FROM_PUBLIC.size > 0, "一条 REVOKE 都没扫到，grant 解析多半坏了");
});

test("worker 调用的每个 public 函数都对 astella_worker 可执行", () => {
  const broken: string[] = [];
  for (const [fn, caller] of CALLED) {
    const granted = GRANTED_ROLES.get(fn);
    if (granted?.has("astella_worker")) continue;
    if (!REVOKED_FROM_PUBLIC.has(fn)) continue; // 仍属 PUBLIC，可执行
    broken.push(`${fn}（${caller}）`);
  }
  assert.deepEqual(
    broken,
    [],
    `这些函数 REVOKE 掉 PUBLIC 后没给 astella_worker 授权，worker 调用即 42501：\n`
      + broken.join("\n")
      + "\n补一条 GRANT EXECUTE ... TO astella_worker 的迁移。",
  );
});

test("【自证】判据认得出「只授 api」这个真实退化", () => {
  // 反向控制：把 worker 的授权摘掉，同一套判据必须报红。
  const fakeRoles = new Map(GRANTED_ROLES);
  fakeRoles.set("astella_purge_expired_companion_memory", new Set(["astella_api"]));
  const fakeRevoked = new Set(REVOKED_FROM_PUBLIC);
  fakeRevoked.add("astella_purge_expired_companion_memory");

  const usable = (fn: string) =>
    fakeRoles.get(fn)?.has("astella_worker") || !fakeRevoked.has(fn);
  assert.equal(usable("astella_purge_expired_companion_memory"), false);
  assert.equal(usable("astella_queue_job_depth"), true, "没 revoke 的走 PUBLIC，仍可用");
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
    /GRANT EXECUTE ON FUNCTION public\.astella_purge_expired_companion_memory\(\) TO astella_worker;/,
  );
  assert.match(
    repair,
    /GRANT EXECUTE ON FUNCTION public\.astella_enforce_companion_memory_retention\(\) TO astella_worker;/,
  );
});

test("角色引导重置授权后仍恢复伴星回收、期限和整理函数；三份清单一致", () => {
  const bootstrap = readFileSync(join(REPO_ROOT, "infra/postgres/roles.sql"), "utf8");
  const signatures = [
    ["astella_restore_companion_memory(uuid,uuid,uuid)", "astella_api"],
    ["astella_purge_expired_companion_memory()", "astella_api, astella_worker"],
    ["astella_companion_memory_retention_limits()", "astella_api, astella_worker"],
    ["astella_enforce_companion_memory_retention()", "astella_api, astella_worker"],
    ["astella_reclaim_stale_memory_organization_leases()", "astella_worker"],
    ["astella_commit_memory_organization(uuid,uuid,text,text,integer)", "astella_worker"],
    ["astella_enqueue_companion_memory_organize()", "astella_worker"],
    ["astella_companion_memory_organization_thresholds()", "astella_worker"],
    // 0426/0432：`companion_stream_events` 归档触发器调用出去的那支（不带 astella_ 前缀，
    // 上面按 worker 源码扫的判据结构性地抓不到它，只能靠这份三清单对账兜住）。
    ["companion_process_event_payload(text,jsonb)", "astella_api, astella_worker"],
    ["astella_enqueue_companion_memory_embedding_repair()", "astella_worker"],
    ["astella_assert_handoff_snapshot_fence(uuid,integer)", "astella_worker"],
  ];
  assert.match(bootstrap, /GRANT EXECUTE ON FUNCTION %s TO %s/);
  for (const [signature, roles] of signatures) {
    assert.ok(bootstrap.includes(`('public.${signature}', '${roles}')`), `引导遗漏 ${signature}`);
    for (const role of roles.split(", ")) {
      assert.ok(bootstrap.includes(`('${role}', '${signature}')`), `缺失反向断言 ${role}: ${signature}`);
    }
    assert.ok(bootstrap.includes(`to_regprocedure('public.${signature}')`), `允许清单遗漏 ${signature}`);
  }
});

/**
 * 结构性守卫：迁移里授给 api/worker 的每一支函数，roles.sql 必须重授一次。
 *
 * 上面那条 worker 源码判据的成立前提是「迁移是授权的最终真相」，而 role-grants 这个
 * one-shot 每次 `make up` 都会跑，其顶部的
 * `REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, astella_api, astella_worker`
 * 恰恰把这个前提推翻——只有 roles.sql 里重新 GRANT 过的才活得下来。
 * 于是同一个洞在四周里开了三次：0426（手记归档，整轮对话必挂）、
 * 0431（向量补偿入队，worker 每 tick 一声 42501）、0389（交接快照围栏，长会话压缩才炸）。
 * 前两支连 `astella_` 前缀都不是或不在源码里，按源码扫的判据结构性地看不见它们。
 */
const REGRANT_EXCEPTIONS: Record<string, string> = {
  // pgvector 的库函数：roles.sql 按 pg_depend.deptype='e' 整体恢复，不走逐支白名单。
  vector: "扩展函数，走 deptype='e' 那一段整体恢复",
  vector_in: "扩展函数，同上",
  l2_distance: "扩展函数，同上",
  cosine_distance: "扩展函数，同上",
  inner_product: "扩展函数，同上",
  // 0327 两支迁移顺手授了 worker，但全仓只有 api 侧调用；roles.sql 只恢复 api 是刻意的。
  astella_find_user_by_email: "只有 api 调用（登录路径），worker 那一份是迁移多授的",
  astella_user_in_workspace: "只有 api 调用，同上",
  // 全仓（含迁移、SQL、脚本）没有任何调用点，已不是功能面。
  astella_bump_workspace_epoch: "0261 之后无人调用",
  astella_release_run_processing: "0121 之后无人调用",
};

test("迁移授给 api/worker 的函数，role-grants 重跑后必须仍在（roles.sql 需重授）", () => {
  const wiped: string[] = [];
  for (const [fn, roles] of MIGRATION_GRANTS) {
    if (REGRANT_EXCEPTIONS[fn] || DROPPED_BY_LATER_MIGRATION.has(fn)) continue;
    const regranted = REGRANTED.get(fn) ?? new Set<string>();
    for (const role of roles) {
      if (!regranted.has(role)) wiped.push(`${fn} → ${role}`);
    }
  }
  assert.deepEqual(
    wiped,
    [],
    `这些函数迁移里授过，但 infra/postgres/roles.sql 没有重授，` +
      `下一次 role-grants 重跑后调用方即 42501：\n` +
      wiped.join("\n") +
      `\n补进 roles.sql 的 VALUES 重授清单、worker/api 允许清单与反向必检清单三份。`,
  );
});

test("【自证】重授对账认得出 0426 这种「迁移授了、roles.sql 没登记」的退化", () => {
  // 反向控制：把归档函数从三份清单里摘掉，同一套判据必须报红。
  assert.ok(
    (REGRANTED.get("companion_process_event_payload") ?? new Set()).has("astella_worker"),
    "roles.sql 的重授没被扫到，判据本身已经坏了",
  );
  // 「后来被 DROP 的不必再重授」这条豁免必须只认这四支——正则写宽了就是把整条守卫关掉。
  assert.deepEqual(
    [...DROPPED_BY_LATER_MIGRATION].filter((fn) => MIGRATION_GRANTS.has(fn)).sort(),
    [
      "astella_claim_commit_outbox",
      "astella_enqueue_companion_thoughts",
      "astella_find_resumable_companion_journey",
      "astella_mark_run_processing_processed",
      "astella_mark_dead_jobs_under_terminal_runs",
      "astella_purge_old_agent_events",
    ].sort(),
    "DROP 豁免集变了：要么漏扫，要么扫宽了",
  );
  const fake = new Map(REGRANTED);
  fake.delete("companion_process_event_payload");
  const wiped = [...MIGRATION_GRANTS].filter(
    ([fn, roles]) =>
      !REGRANT_EXCEPTIONS[fn] &&
      !DROPPED_BY_LATER_MIGRATION.has(fn) &&
      [...roles].some((r) => !(fake.get(fn) ?? new Set()).has(r)),
  );
  assert.ok(
    wiped.some(([fn]) => fn === "companion_process_event_payload"),
    "摘掉重授后判据没报红——这条守卫是空断言",
  );
});
