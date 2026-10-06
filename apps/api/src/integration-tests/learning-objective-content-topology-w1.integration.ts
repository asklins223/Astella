/**
 * Plan 23 W1-01..W1-08 集成测试（真实 Postgres）。
 *
 * 验证迁移 0175：
 *  1. learning_objective_origins_v2 存在且 FORCE RLS；
 *  2. concept_label / surface_revision / surface_updated_at 列存在；
 *  3. Origin RLS：跨 workspace 读写拒绝；本 workspace 读写通过（事务内 set_config）；
 *  4. Origin kind 条件约束：note 缺 note_version_id 拒绝、manual 带 note 拒绝；
 *  5. 同一 objective revision + note version 重复绑定被唯一索引拒绝；
 *  6. 同一 objective revision + note version 重复绑定被唯一索引拒绝。
 *
 * 环境：`DATABASE_URL_API_RLS` **必填**——必须指向一个**非 superuser** 的角色
 * （dev 的 astella 是 superuser：无条件绕过 RLS，即使 FORCE RLS 也不生效，于是隔离
 * 断言全部假通过）。一次性库里那份 `DATABASE_URL_API`（astella_api）就是这种角色。
 * 无 DB fail closed。
 *
 * 2026-09-25：以前这里缺变量会静默落到一个写死的开发库串（`astella_api@localhost`），
 * 于是本机跑这套用例时其实是在**真实 dev 库**上验隔离——而那正是最不该被悄悄碰到的库。
 * 现在缺变量当场喊（`testDatabaseUrl`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";

const CONN = testDatabaseUrl("DATABASE_URL_API_RLS");

/**
 * 把这一发自己种的 origin 行**真的**删掉，并在同一个 workspace 上下文里回读证明删干净了。
 *
 * 原来三处 `finally` 写的是 `DELETE … WHERE workspace_id = ?` 后面接一个 `.catch(() => {})`。
 * 这张表是 FORCE RLS、连接又是 NOBYPASSRLS 的 `astella_api`：不带 `app.workspace_id` 的事务里
 * USING 那一半就匹配 0 行 ⇒ 删不掉任何东西，而 `.catch` 把错误也一起咽了——**看起来很正常**。
 * 实测这份文件跑一遍在库里留 3 行孤儿（跑前 26、跑后 29，`workspace_id` 在 `workspaces` 里不存在）。
 * 这也是它一直没人敢跑的一半原因：跑一次脏一次。
 */
async function clearOwnOrigins(
  sql: postgres.Sql,
  workspaceId: string,
  planted: number,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    // 先数"删之前看得见几行"。少了这一步，整个回读是**空转**的：上下文一丢，删不到行，
    // 而同一事务里的回读也一样什么都看不见，`after === 0` 就恒真了。
    const before = await tx`
      SELECT count(*)::int AS n FROM learning_objective_origins_v2
      WHERE workspace_id = ${workspaceId}
    `;
    assert.equal(before[0].n, planted,
      `这一发本该种进 ${planted} 行、上下文里只看见 ${before[0].n} 行：受限角色下不带`
      + ` workspace 上下文的读与写都是 0 行，回读也就白读`);
    await tx`DELETE FROM learning_objective_origins_v2 WHERE workspace_id = ${workspaceId}`;
    const left = await tx`
      SELECT count(*)::int AS n FROM learning_objective_origins_v2
      WHERE workspace_id = ${workspaceId}
    `;
    assert.equal(left[0].n, 0,
      "种的 origin 行没删掉：受限角色下删 FORCE RLS 的表必须带 workspace 上下文");
  });
}

function mustConnect() {
  if (!CONN) {
    throw new Error("DATABASE_URL_API_RLS 未配置——W1 集成测试要求真实 Postgres");
  }
  return postgres(CONN, { max: 4 });
}

test("W1-01/07/04: 0175 新表存在且 FORCE RLS", async () => {
  const sql = mustConnect();
  try {
    const rows = await sql`
      SELECT c.relname AS table_name, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls
      FROM pg_class c
      WHERE c.relname IN ('learning_objective_origins_v2')
      ORDER BY 1
    `;
    assert.equal(rows.length, 1, "新表缺失");
    for (const row of rows) {
      assert.equal(row.rls, true, row.table_name + " 未 ENABLE RLS");
      assert.equal(row.force_rls, true, row.table_name + " 未 FORCE RLS");
    }
    const policies = await sql`
      SELECT tablename, policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename IN ('learning_objective_origins_v2')
    `;
    assert.equal(policies.length, 1, "每张新表至少一个 policy");
  } finally {
    await sql.end();
  }
});

test("W1-05/06/08: 列存在（concept_label / surface_revision / surface_updated_at）", async () => {
  const sql = mustConnect();
  try {
    const rows = await sql`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND (
        (table_name = 'learning_objective_revisions_v2' AND column_name = 'concept_label')
        OR (table_name = 'learning_objectives_v2' AND column_name IN ('surface_revision','surface_updated_at'))
      )
    `;
    const key = rows.map((r) => r.table_name + "." + r.column_name).sort();
    assert.deepEqual(key, [
      "learning_objective_revisions_v2.concept_label",
      "learning_objectives_v2.surface_revision",
      "learning_objectives_v2.surface_updated_at",
    ]);
  } finally {
    await sql.end();
  }
});

test("W1-04: Origin RLS 跨 workspace 隔离", async () => {
  const sql = mustConnect();
  const wsA = randomUUID();
  const wsB = randomUUID();
  const originId = randomUUID();
  const objectiveId = randomUUID();
  const revisionId = randomUUID();
  try {
    // 本 workspace 写入并读取
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${wsA}, true)`;
      await tx`
        INSERT INTO learning_objective_origins_v2
          (workspace_id, origin_id, objective_id, objective_revision_id, origin_kind)
        VALUES (${wsA}, ${originId}, ${objectiveId}, ${revisionId}, 'manual')
      `;
    });
    const own = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${wsA}, true)`;
      return tx`SELECT count(*)::int AS n FROM learning_objective_origins_v2 WHERE workspace_id = ${wsA}`;
    });
    assert.equal(Number(own[0].n), 1);

    // 切到另一 workspace 读不到（FORCE RLS 过滤）
    const other = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${wsB}, true)`;
      return tx`SELECT count(*)::int AS n FROM learning_objective_origins_v2 WHERE origin_id = ${originId}`;
    });
    assert.equal(Number(other[0].n), 0);

    // 跨 workspace 写入被拒绝（wsB 上下文中插入 wsA 行 → WITH CHECK 失败）
    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${wsB}, true)`;
        await tx`
          INSERT INTO learning_objective_origins_v2
            (workspace_id, origin_id, objective_id, objective_revision_id, origin_kind)
          VALUES (${wsA}, ${originId}, ${objectiveId}, ${revisionId}, 'manual')
        `;
      }),
      /row-level security policy/,
    );
  } finally {
    await clearOwnOrigins(sql, wsA, 1);
    await sql.end();
  }
});

test("W1-02: Origin kind 条件约束", async () => {
  const sql = mustConnect();
  const ws = randomUUID();
  try {
    const base = (tx: postgres.TransactionSql<Record<string, never>>) =>
      tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    // note 缺 note_version_id → 拒绝
    await assert.rejects(
      sql.begin(async (tx) => {
        await base(tx);
        await tx`
          INSERT INTO learning_objective_origins_v2
            (workspace_id, origin_id, objective_id, objective_revision_id, origin_kind, note_id)
          VALUES (${ws}, ${randomUUID()}, ${randomUUID()}, ${randomUUID()}, 'note', ${randomUUID()})
        `;
      }),
      /loo_v2_kind_fields_chk/,
      "note 缺 note_version_id",
    );
    // manual 带 note → 拒绝
    await assert.rejects(
      sql.begin(async (tx) => {
        await base(tx);
        await tx`
          INSERT INTO learning_objective_origins_v2
            (workspace_id, origin_id, objective_id, objective_revision_id, origin_kind, note_id, note_version_id)
          VALUES (${ws}, ${randomUUID()}, ${randomUUID()}, ${randomUUID()}, 'manual', ${randomUUID()}, ${randomUUID()})
        `;
      }),
      /loo_v2_kind_fields_chk/,
      "manual 带 note",
    );
    // imported 缺 import_batch_ref → 拒绝
    await assert.rejects(
      sql.begin(async (tx) => {
        await base(tx);
        await tx`
          INSERT INTO learning_objective_origins_v2
            (workspace_id, origin_id, objective_id, objective_revision_id, origin_kind)
          VALUES (${ws}, ${randomUUID()}, ${randomUUID()}, ${randomUUID()}, 'imported')
        `;
      }),
      /loo_v2_kind_fields_chk/,
      "imported 缺 import_batch_ref",
    );
    // 有效 manual → 通过
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      await tx`
        INSERT INTO learning_objective_origins_v2
          (workspace_id, origin_id, objective_id, objective_revision_id, origin_kind)
        VALUES (${ws}, ${randomUUID()}, ${randomUUID()}, ${randomUUID()}, 'manual')
      `;
    });
  } finally {
    await clearOwnOrigins(sql, ws, 1);
    await sql.end();
  }
});

test("W1-03: 同一 objective revision + note version 重复绑定被唯一索引拒绝", async () => {
  const sql = mustConnect();
  const ws = randomUUID();
  const objectiveRevisionId = randomUUID();
  const noteVersionId = randomUUID();
  try {
    const insert = (tx: postgres.TransactionSql<Record<string, never>>) =>
      tx`
        INSERT INTO learning_objective_origins_v2
          (workspace_id, origin_id, objective_id, objective_revision_id, origin_kind, note_id, note_version_id)
        VALUES (${ws}, ${randomUUID()}, ${randomUUID()}, ${objectiveRevisionId}, 'note', ${randomUUID()}, ${noteVersionId})
      `;
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      await insert(tx);
    });
    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
        await insert(tx);
      }),
      /loo_v2_note_binding_unique_idx/,
    );
  } finally {
    await clearOwnOrigins(sql, ws, 1);
    await sql.end();
  }
});
