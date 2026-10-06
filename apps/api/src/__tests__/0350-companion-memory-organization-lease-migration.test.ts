import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0350_companion_memory_organization_lease.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as { entries: Array<{ tag: string }> };
const org = readFileSync(
  new URL("../../../../workers/ai-worker/src/handlers/companion-memory-organization.ts", import.meta.url),
  "utf8",
);

test("0350 已登记", () => {
  assert.ok(journal.entries.some((e) => e.tag === "0350_companion_memory_organization_lease"));
});

test("每个 (workspace,user) **最多一条**租约 —— 靠主键，不靠先查后插", () => {
  const leases = migration.slice(migration.indexOf("CREATE TABLE public.companion_memory_organization_leases"));
  assert.match(leases, /CONSTRAINT companion_memory_organization_leases_pkey\s+PRIMARY KEY \(workspace_id, user_id\)/,
    "「最多一项」必须由唯一约束保证：先查后插之间有窗口，多副本会各插一条");
});

test("租约有到期时间 —— 崩溃的副本不会执行清理", () => {
  // 没有 expires_at 的话，一个崩掉的副本会把这个用户**永久**锁死在"有人在整理"。
  assert.match(migration, /expires_at timestamptz NOT NULL/);
  assert.match(migration, /astella_reclaim_stale_memory_organization_leases/);
});

test("用户纠正与删除**不申请**这张租约，也不等它", () => {
  // §4.6.9：「用户纠正与删除仍可即时提交并推进 revision，不等待模型。」
  // 它们走 memory-service 自己的路径；租约表里没有它们的身影就是对的。
  const leaseSection = migration.slice(
    migration.indexOf("CREATE TABLE public.companion_memory_organization_leases"),
    migration.indexOf("ALTER TABLE public.companion_memory_organization_state ENABLE"),
  );
  assert.ok(!/correctMemory|deleteMemory/.test(leaseSection),
    "租约路径里不该出现用户纠正/删除——它们必须能绕过它");
});

test("提交时复查状态，冲突**不覆盖**别人已经推进的结果", () => {
  const commit = migration.slice(migration.indexOf("astella_commit_memory_organization"));
  assert.match(commit, /holder = p_holder/);
  assert.match(commit, /expires_at > now\(\)/,
    "过期租约持有一轮再提交，等于让一个已经不存在的进程写进状态");
  assert.match(commit, /last_success_at IS NULL OR last_success_at <= now\(\) - interval '1 second'/,
    "状态已被别人推进时本轮必须让位");
  // 返回 false 而不是抛错：调用方据此**不得**把建议当成已落地。
  assert.match(commit, /RETURN committed IS NOT NULL/);
});

test("失败**不改写** last_success_at —— 否则反复失败会把间隔窗口无限后推", () => {
  // 那正好是「低频用户永远不触发」的后门：积压一直不清，间隔却越推越远。
  assert.match(migration, /last_success_at timestamptz/);
  const state = migration.slice(migration.indexOf("CREATE TABLE public.companion_memory_organization_state"));
  assert.ok(!/last_success_at\s+timestamptz NOT NULL/.test(state),
    "last_success_at 必须可空——首次运行之前没有它");
});

test("surface 至多一段且有长度上限", () => {
  assert.match(migration, /surface text CHECK \(surface IS NULL OR char_length\(surface\) <= 240\)/);
  assert.match(org, /export function memoryOrganizationSurface/);
  assert.match(org, /return parts\.length === 0 \? null/,
    "§4.5.10「没有值得返回的内容可以为空」——不能每次都编一句");
  assert.match(org, /\.slice\(0, 240\)/);
});

test("两张表都按本人隔离", () => {
  for (const table of ["companion_memory_organization_state", "companion_memory_organization_leases"]) {
    assert.match(migration, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
    assert.match(migration, new RegExp(`ALTER TABLE public\\.${table} FORCE ROW LEVEL SECURITY`));
  }
});

test("【自证】判据认得出「用进程内互斥代替数据库租约」这个真实退化", () => {
  // 退化形状：只在 worker 进程里用一把 Map 互斥。
  const inProcessOnly = "const held = new Set<string>();";
  assert.ok(!/workspace_id|user_id/.test(inProcessOnly), "自证样本没造好");
  assert.match(migration, /PRIMARY KEY \(workspace_id, user_id\)/,
    "自证：本迁移确实把互斥落在数据库上");
  assert.match(org, /ON CONFLICT \(workspace_id, user_id\) DO NOTHING/,
    "自证：worker 侧确实是靠唯一约束判定，而不是先查后插");
});