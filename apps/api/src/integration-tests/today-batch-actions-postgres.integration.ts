import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { withWorkspaceTransaction, closeDatabase } from "../db/client.ts";
import { actOnTodayBatchV2, readTodayBatchV2 } from "../modules/learning-dashboard/home-suggestion-service.ts";

const fixtureUrl = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!fixtureUrl || !process.env.DATABASE_URL_API) throw new Error("批次集测需要夹具连接和受限 API 角色");
const sql = postgres(fixtureUrl, { max: 1 });
const userId = randomUUID();
const workspaceId = randomUUID();
const scope = { userId, workspaceId, timeZone: "Asia/Shanghai", now: new Date("2026-10-05T08:00:00Z") };

before(async () => {
  await sql`INSERT INTO users (id, email, password_hash) VALUES (${userId}, ${`batch-${userId}@example.invalid`}, 'unused')`;
  await sql`INSERT INTO workspaces (id, owner_id, name) VALUES (${workspaceId}, ${userId}, '批次空账号测试')`;
  await sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
});
after(async () => {
  await closeDatabase();
  await sql`DELETE FROM daily_review_batches_v2 WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
  await sql`DELETE FROM users WHERE id = ${userId}`;
  await sql.end();
});

test("空账号减量只应用一次，回执等于落库容量且不生成不存在的任务", async () => {
  await withWorkspaceTransaction(scope, async tx => {
    const before = await readTodayBatchV2(tx, scope);
    const result = await actOnTodayBatchV2(tx, { ...scope, action: "reduce", reduceBy: 2 });
    const after = await readTodayBatchV2(tx, scope);
    assert.equal(result.lockedLength, Math.max(0, before.lockedLength - 2));
    assert.equal(result.lockedLength, after.lockedLength);
    assert.equal(result.remaining, 0);
    assert.deepEqual(after.items, []);
    assert.match(result.screenLine, /没有待复习的卡片/);
  });
});

test("空账号暂停与恢复保留容量，剩余数仍为零", async () => {
  await withWorkspaceTransaction(scope, async tx => {
    const before = await readTodayBatchV2(tx, scope);
    for (const action of ["pause", "resume"] as const) {
      const result = await actOnTodayBatchV2(tx, { ...scope, action });
      assert.equal(result.lockedLength, before.lockedLength);
      assert.equal(result.remaining, 0);
      assert.equal(result.paused, action === "pause");
      assert.doesNotMatch(result.screenLine, /做完|剩下 [1-9]/);
    }
  });
});
