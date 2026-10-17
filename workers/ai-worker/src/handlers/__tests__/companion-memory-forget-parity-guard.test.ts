import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 「忘掉一条记忆」有**两条实现**，它们必须写下同一组状态（2026-10-16）。
 *
 * 一条在 API（`memory-service.deleteMemory`，用户在记忆中心点删除），一条在 worker
 * （`companion_forget_memory`，她按用户要求自己删）。两条都写 `assistant_memory_items`，
 * 但 worker 那条是另一份手写 SQL——2026-10-16 审出来的分歧正是它只写了 `deleted_at`：
 *   - 没写 `purge_after` → 墓碑永远进不了回收区（到期清理要求两列都非空）；
 *   - 没遮蔽发现簿 → 用户收藏过的那条记忆，引文还留在簿子里。
 * 两处都不会报错，所以只能靠守卫钉住。
 *
 * 为什么是源码扫描而不是真库集成测试：这条守卫要挡的是**两条实现漂移**，而漂移发生在
 * 源码层；集成测试只覆盖它跑的那一条。真库那一侧的覆盖在
 * `agent-learning-preferences-postgres.integration.ts`（回收窗口断言）。
 */
const workerForget = readFileSync(new URL("../tools/companion-memory-tools.ts", import.meta.url), "utf8");
const apiForgot = readFileSync(
  new URL("../../../../../apps/api/src/modules/companion-conversation/memory/memory-service.ts", import.meta.url),
  "utf8",
);

/** 取一个 case 分支的源码，判据只在这一段里生效。 */
function forgetBranch(): string {
  const start = workerForget.indexOf('case "companion_forget_memory"');
  assert.notEqual(start, -1, "找不到 worker 的遗忘分支");
  const end = workerForget.indexOf('case "companion_set_boundary"', start);
  return workerForget.slice(start, end === -1 ? start + 6_000 : end);
}

test("worker 的遗忘路径写 purge_after，与到期清理的判据对齐", () => {
  const branch = forgetBranch();
  assert.match(branch, /purge_after\s*=\s*now\(\)/,
    "只写 deleted_at 的墓碑永远不会被回收：到期清理要求 purge_after 非空");
  assert.match(branch, /companionMemoryRecycleBinDays/,
    "窗口数值要引用 shared 的唯一声明，不能在 worker 里再写一个 30");
});

test("worker 的遗忘路径遮蔽发现簿里那条来源引文（40 §7）", () => {
  const branch = forgetBranch();
  // worker 对 companion_discovery_entries 一个表权限都没有（roles.sql 的 Worker privilege
  // matrix 就那样声明），所以遮蔽必须走那支 SECURITY DEFINER 函数——直接写 UPDATE 会在
  // 真库上 42501，而回滚之后「记忆没被删、旧引文还在」，两个错误一起静默。
  assert.match(branch, /astella_mask_companion_memory_discovery_entries\(/,
    "遮蔽要走 0441 那支带 owner/workspace/memory 约束的定义者函数");
  assert.doesNotMatch(branch, /UPDATE companion_discovery_entries/,
    "worker 没有这张表的 ACL：直接 UPDATE 在真库上是 permission denied");
});

test("0441 的定义者函数把操作绑在真实记忆行的归属上，并只授给 worker", () => {
  const migration = readFileSync(
    new URL("../../../../../apps/api/src/db/migrations/0441_worker_discovery_entry_masking.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /SECURITY DEFINER/);
  assert.match(migration, /SET search_path = pg_catalog, public/);
  // 归属绑定：不给「任意 workspace/user/source_id」留口子。
  assert.match(migration, /m\.id = p_memory_item_id[\s\S]*?m\.workspace_id = p_workspace_id[\s\S]*?m\.user_id = p_user_id/);
  assert.match(migration, /REVOKE ALL ON FUNCTION[\s\S]*?FROM PUBLIC, astella_api, astella_worker/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION[\s\S]*?TO astella_worker/);
  // 上面那句全量 REVOKE 只清表权限，函数要在 roles.sql 里再补一次（函数授权守卫的同一条判据）。
  const roles = readFileSync(new URL("../../../../../infra/postgres/roles.sql", import.meta.url), "utf8");
  assert.match(roles, /GRANT EXECUTE ON FUNCTION public\.astella_mask_companion_memory_discovery_entries\(uuid, uuid, uuid\)\s*\n\s*TO astella_worker/);
  assert.match(roles, /to_regprocedure\('public\.astella_mask_companion_memory_discovery_entries\(uuid,uuid,uuid\)'\)/);
});

test("worker 的遗忘路径作废那条记忆的整理结论", () => {
  const branch = forgetBranch();
  assert.match(branch, /UPDATE companion_memory_organization_state[\s\S]*?SET surface = NULL/,
    "整理结论是这条记忆的转述，正文删了而它留着，旧话还会从这一格回到 prompt");
});

test("两条遗忘实现都从 shared 取回收窗口，不各写一个数", () => {
  assert.match(apiForgot, /companionMemoryRecycleBinDays/,
    "API 那条路径也要引用 shared 的窗口声明");
  assert.doesNotMatch(apiForgot, /MEMORY_RECYCLE_BIN_DAYS\s*=\s*30/,
    "shared 才是唯一声明：本地再写一个 30 就是第二个漂移点");
  assert.match(workerForget, /import \{ companionMemoryRecycleBinDays \} from "@astella\/shared\/companion-memory-desktop-contracts"/);
});
