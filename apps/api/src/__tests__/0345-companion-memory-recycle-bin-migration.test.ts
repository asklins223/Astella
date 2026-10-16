import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0345_companion_memory_recycle_bin.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };

test("0345 已登记，且给软删除行补上回收区到期时间", () => {
  assert.ok(
    journal.entries.some((e) => e.tag === "0345_companion_memory_recycle_bin"),
    "0345 没进 journal —— 迁移不会被执行",
  );
  assert.match(migration, /ADD COLUMN purge_after timestamptz/);
  // 老数据不能停在「没有 purge_after ⇒ 永远不进回收区」的状态。
  assert.match(
    migration,
    /SET purge_after = deleted_at \+ interval '30 days'[\s\S]*?WHERE deleted_at IS NOT NULL\s+AND purge_after IS NULL/,
    "既有软删除行必须被补上窗口",
  );
});

test("回收区窗口只有一个数：迁移与两条删除路径都指向同一份声明", () => {
  assert.match(migration, /interval '30 days'/);
  // 2026-10-16：窗口的**唯一声明**搬到了 shared（`companionMemoryRecycleBinDays`），
  // 因为写下 `purge_after` 的地方有两处——API 的记忆服务与 worker 里模型自己调的
  // `companion_forget_memory`。原来只在 API 这份实现里写着 30，worker 那份少了这一列，
  // 于是模型删掉的记忆永远进不了回收区。所以这条判据从「服务层也写 30」改成
  // 「服务层引用那份唯一声明，且本地不再出现第二个 30」——同一条不变量，更严的形状。
  const service = readFileSync(
    new URL("../modules/companion-conversation/memory/memory-service.ts", import.meta.url),
    "utf8",
  );
  assert.match(service, /const memoryRecycleBinDays = companionMemoryRecycleBinDays;/,
    "服务层的窗口必须来自 shared 的唯一声明");
  assert.doesNotMatch(service, /MEMORY_RECYCLE_BIN_DAYS\s*=\s*30/,
    "本地再写一个 30 就是第二个漂移点");
  const shared = readFileSync(
    new URL("../../../../packages/shared/src/contracts/companion-memory-desktop-contracts.ts", import.meta.url),
    "utf8",
  );
  assert.match(shared, /export const companionMemoryRecycleBinDays = 30;/,
    "唯一声明必须就是 30 天 —— 它一变，这里和迁移的两处语义一起变");
});

test("恢复与到期清除是两条独立的路，不是一条路的两个状态", () => {
  // 「普通删除可恢复」与「彻底清除不等窗口」是 A47 的两半，各自有入口。
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.astella_restore_companion_memory/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.astella_purge_expired_companion_memory/);

  // 恢复必须同时清掉两个列——只清 deleted_at 的话 purge_after 会残留，
  // 那条记忆将来说不定会被到期清理当成"已删"再抹一次。
  const restore = migration.slice(
    migration.indexOf("astella_restore_companion_memory"),
    migration.indexOf("astella_purge_expired_companion_memory()\nRETURNS"),
  );
  assert.match(restore, /deleted_at = NULL/);
  assert.match(restore, /purge_after = NULL/);
});

test("到期清除只删过了窗口的行，不碰在用的与回收区里的", () => {
  const purge = migration.slice(migration.indexOf("astella_purge_expired_companion_memory()\nRETURNS"));
  assert.match(purge, /deleted_at IS NOT NULL/);
  assert.match(purge, /purge_after IS NOT NULL/);
  assert.match(purge, /purge_after <= now\(\)/,
    "必须带 <= now()，否则清理的是未来到期的行");
  // 这是一条**清兜底**路径，不该拿到直接表权限。
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.astella_purge_expired_companion_memory\(\) FROM PUBLIC/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.astella_restore_companion_memory\(uuid, uuid, uuid\) FROM PUBLIC/);
});

test("【自证】判据认得出「只写 deleted_at、没有回收区」这个旧形状", () => {
  const oldShape = "UPDATE assistant_memory_items SET deleted_at = now() WHERE id = $1;";
  assert.ok(!/purge_after/.test(oldShape),
    "自证样本没造好：旧形状里应当完全没有 purge_after");
  assert.ok(/ADD COLUMN purge_after/.test(migration),
    "自证：本迁移确实新增了那一列，所以上面那条不是恒真");
});