import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import type { db } from "../../db.ts";

/**
 * 入队 SQL 现在住在那里：SECURITY DEFINER 的库内函数（worker 角色不该跨书房扫记忆表）。
 * 这条守卫要钉的行为没变——**只给已经同意 AI 的人重算 embedding**——所以断言跟着判据搬：
 * TS 侧必须把这一轮交给那个函数，函数本体必须带着 consent 两条与状态过滤。
 * 不写死迁移号，按函数名找文件，免得下次改名时守卫又变成假红。
 */
const REPAIR_FUNCTION = "astella_enqueue_companion_memory_embedding_repair";
const MIGRATIONS = path.resolve(import.meta.dirname, "../../../../../apps/api/src/db/migrations");
const repairSql = (): string => {
  const file = readdirSync(MIGRATIONS).sort().reverse()
    .find(name => name.endsWith(".sql") && readFileSync(path.join(MIGRATIONS, name), "utf8")
      .includes(`FUNCTION public.${REPAIR_FUNCTION}()`));
  assert.ok(file, `找不到定义 ${REPAIR_FUNCTION} 的迁移`);
  return readFileSync(path.join(MIGRATIONS, file!), "utf8");
};
import {
  resetCompanionMemoryEmbeddingSchedulerForTest,
  tickCompanionMemoryEmbeddingScheduler,
} from "../companion-memory-embedding-scheduler.ts";

test("embedding scheduler enqueues once per cadence and scopes rebuilds to consenting memory owners", async () => {
  const queries: unknown[] = [];
  const executor = {
    execute: async (query: unknown) => {
      queries.push(query);
      return [{ enqueued: 2 }];
    },
  } as unknown as typeof db;
  resetCompanionMemoryEmbeddingSchedulerForTest();
  try {
    await tickCompanionMemoryEmbeddingScheduler(executor);
    await tickCompanionMemoryEmbeddingScheduler(executor);

    assert.equal(queries.length, 1, "同一调度周期只执行一次数据库扫描");
    const chunks = JSON.stringify((queries[0] as { queryChunks: unknown[] }).queryChunks);
    assert.match(chunks, new RegExp(REPAIR_FUNCTION), "调度侧要经那个库内函数入队");
    const sql = repairSql();
    assert.match(sql, /consent_at IS NOT NULL/);
    assert.match(sql, /consent_version IS NOT NULL/);
    assert.match(sql, /embedding_status IN/);
    assert.match(sql, /companion_memory_embedding_rebuild/);
    assert.match(sql, /ON CONFLICT/);
  } finally {
    resetCompanionMemoryEmbeddingSchedulerForTest();
  }
});

test("failed scheduler scans remain eligible for retry on the next call", async () => {
  let calls = 0;
  const executor = {
    execute: async () => {
      calls += 1;
      if (calls === 1) throw new Error("synthetic database failure");
      return [];
    },
  } as unknown as typeof db;
  resetCompanionMemoryEmbeddingSchedulerForTest();
  try {
    await tickCompanionMemoryEmbeddingScheduler(executor);
    await tickCompanionMemoryEmbeddingScheduler(executor);
    assert.equal(calls, 2, "失败的扫描不应推进节流时间戳");
  } finally {
    resetCompanionMemoryEmbeddingSchedulerForTest();
  }
});
