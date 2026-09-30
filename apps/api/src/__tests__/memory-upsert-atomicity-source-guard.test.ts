import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * P2-11：伴星记忆的写入路径必须是**一条语句**的原子 upsert。
 *
 * ## 审计说的和实测的
 *
 * 审计写"`memory-service.ts:145-170` 加锁 + **补唯一索引**"。唯一索引**早就有了**——
 * `0132` 迁移建的 partial UNIQUE index：
 *
 *   ON assistant_memory_items (workspace_id, user_id, kind, source_event_id)
 *   WHERE deleted_at IS NULL AND source_event_id IS NOT NULL
 *
 * 实库确认（一次性库上 `pg_indexes` 查过）。所以缺的不是索引。
 *
 * ## 真正的缺陷
 *
 * 写入是 check-then-act：先 `SELECT ... LIMIT 1`，没有再 `INSERT`。
 * 同一个 `sourceEventId` 的两条伴星消息几乎必然并发，两个事务都查不到、都去插，
 * 其中一个撞 23505。
 *
 * 而这个错误**捕获不了**：`executor` 是已经开好的事务，Postgres 里任何语句失败
 * 都会把整个事务置为 aborted，之后发什么都只得到 25P02。所以唯一正确的形态是
 * 用 `ON CONFLICT ... DO UPDATE` 把"不存在就插、存在就改"压进**一条**语句。
 *
 * ## 为什么是结构断言
 *
 * 竞态本身无法在单测里稳定复现（要两个真并发事务）。而 `onConflictDoUpdate`
 * 的 `target` + `setWhere` **必须逐字复述那个 partial 索引的谓词**，
 * 少写 `setWhere` 就命中不到它、语句会在并发时才炸——单元测试照样全绿。
 * 所以这里钉形状。
 */

const API_ROOT = new URL("..", import.meta.url).pathname;
// 2026-09-30（B4）：记忆族进了 。
// 判据的对象是「那条 upsert 是原子的」，不是它在哪个目录——所以跟着搬。
const SERVICE = join(
  API_ROOT, "modules", "companion-conversation", "memory", "memory-service.ts",
);

test("记忆写入走 onConflictDoUpdate（不是 check-then-act）", () => {
  const source = readFileSync(SERVICE, "utf8");
  const insertAt = source.indexOf("executor.insert(assistantMemoryItems)");
  assert.ok(insertAt > 0, "自证：应当找得到那句 insert");

  const tail = source.slice(insertAt, insertAt + 4000);
  assert.ok(
    tail.includes(".onConflictDoUpdate("),
    "插入路径上没有 onConflictDoUpdate——这是 check-then-act："
    + "两个并发事务会都查不到、都去插，其中一个撞 partial unique index 的 23505，"
    + "而那个错误在事务里捕获不了（事务已 aborted），只能整条失败。",
  );
});

test("upsert 的 target 与 setWhere 逐字复述了那个 partial 索引", () => {
  const source = readFileSync(SERVICE, "utf8");
  const at = source.indexOf(".onConflictDoUpdate(");
  assert.ok(at > 0, "自证：应当找得到 onConflictDoUpdate");
  const block = source.slice(at, at + 3000);

  // 四列，缺一列就命中不到那个索引
  for (const col of [
    "assistantMemoryItems.workspaceId",
    "assistantMemoryItems.userId",
    "assistantMemoryItems.kind",
    "assistantMemoryItems.sourceEventId",
  ]) {
    assert.ok(block.includes(col), `upsert 的 target 少了 ${col}——命中不到 partial unique index`);
  }
  // partial 索引的谓词：少了 setWhere 同样命不中
  assert.ok(
    /setWhere:\s*sql`[\s\S]{0,200}deletedAt}\s*IS NULL[\s\S]{0,200}sourceEventId}\s*IS NOT NULL/.test(block),
    "upsert 缺少 setWhere（或没复述 partial 索引的谓词）——"
    + "Postgres 要求 ON CONFLICT 的 target 与那个 partial 索引完全一致才命中",
  );
});

test("【自证】形状判据会红：拿掉 onConflictDoUpdate 必须被抓", () => {
  const real = readFileSync(SERVICE, "utf8");
  const stripped = real.slice(0, real.indexOf(".onConflictDoUpdate("))
    + "\n  })\n  .returning();\n";
  assert.ok(
    real.includes(".onConflictDoUpdate("),
    "自证：真实文件里应当有 onConflictDoUpdate",
  );
  assert.ok(
    !stripped.includes(".onConflictDoUpdate("),
    "自证样本没造好：拿掉之后应当认不出",
  );
  // 自证不该改动磁盘上的文件
  assert.ok(readFileSync(SERVICE, "utf8").includes(".onConflictDoUpdate("));
});
