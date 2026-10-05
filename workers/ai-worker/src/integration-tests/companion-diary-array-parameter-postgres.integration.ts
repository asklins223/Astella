/**
 * 日记发布语句的 `text[]` 参数（2026-10-05）。
 *
 * ## 这条测试为什么必须连库
 *
 * `source_event_ids` 是 `text[]` 列，而本项目走 **postgres.js**：它把一个 JS 数组
 * 序列化成**行构造器** `($1,$2)`，不是数组字面量。于是
 *
 * ```
 * INSERT ... VALUES (..., ($1,$2)::text[], ...)  → column "source_event_ids" is of
 *                                                   type text[] but expression is of type record
 * INSERT ... VALUES (..., ()::text[], ...)      → syntax error at or near ")"
 * ```
 *
 * 两条分支都炸：**选材前失败（空数组）与成稿（非空数组）**。2026-09-30 起伴星日记
 * 连续 6 天一篇都没落库，模型每天照常写完了稿，全废在最后这一步 INSERT 上，job
 * 3 次重试后 dead，页面上是一片空白。
 *
 * 不连库就测不出来：纯单测只看到「拼出了一个字符串」，而错误发生在
 * **参数被驱动绑定并送进解析器**的那一刻。所以这里对着真表跑真语句。
 *
 * 覆盖面刻意包含"曾经坏掉的那两种形状"——空数组与非空数组。修法是把数组在应用侧
 * 拼成 PostgreSQL 数组字面量（`@ailearn/shared/pg-text-array`），本文件钉住这个
 * 契约，免得下一次有人觉得「直接传数组更干净」而改回去。
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { sql as drizzleSql } from "drizzle-orm";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";
import { toTextArrayLiteral } from "@ailearn/shared/pg-text-array";

const CONN = testDatabaseUrl("DATABASE_URL_API");
process.env.DATABASE_URL ??= CONN;

const sql = postgres(CONN, { max: 2 });

after(async () => {
  await sql.end({ timeout: 2 });
  const { closeDatabase } = await import("../db.ts");
  await closeDatabase();
});

const { diarySummaryUpsertSql } = await import("../handlers/companion-daily-summary.ts");
const { db } = await import("../db.ts");

const ZERO_FACTS = {
  notesCreated: 0, notesUpdated: 0, cardsCreated: 0, sourcesCreated: 0,
  jobsCreated: 0, jobsCompleted: 0, learningRunsCreated: 0, learningRunsCompleted: 0,
  pageContexts: 0, conversationMessages: 0, userMessages: 0, assistantMessages: 0,
};

async function seedScope(): Promise<{ workspaceId: string; userId: string; date: string }> {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const date = `it-${workspaceId.slice(0, 8)}`;
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role)
             VALUES (${userId}, ${"t-" + userId.slice(0, 8) + "@x.test"}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${workspaceId}, ${"w" + workspaceId.slice(0, 8)}, ${userId})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
  });
  return { workspaceId, userId, date };
}

function scopeOf(s: { workspaceId: string; userId: string; date: string }) {
  return { ...s, timezone: "Asia/Shanghai", diaryEnabledSince: new Date(0) };
}

function guardOf(sourceEventIds: string[]) {
  return {
    expectedHash: "h", govCtx: {} as never, provider: {} as never,
    selectionReason: "理由", selectedId: "moment-1",
    sourceEventIds,
    personaProfileRevision: 1, personaExamplesRevision: 1, defaultExpressionVersion: "1",
  };
}

async function readRow(workspaceId: string, userId: string, date: string) {
  const rows = await sql`
    SELECT status, source_event_ids, summary, selection_reason
      FROM companion_daily_summaries
     WHERE workspace_id = ${workspaceId} AND user_id = ${userId} AND date = ${date}`;
  return rows[0];
}

test("日记成稿：非空 source_event_ids 作为真正的 text[] 落库", async () => {
  const s = await seedScope();
  const ids = [randomUUID(), randomUUID(), randomUUID()];

  await db.execute(diarySummaryUpsertSql({
    scope: scopeOf(s),
    facts: ZERO_FACTS,
    draft: { blocks: [{ type: "text", text: "傍晚那阵子，你在屏幕前坐了很久。" }], digest: "d" },
    failureReason: null,
    guard: guardOf(ids),
  }));

  const row = await readRow(s.workspaceId, s.userId, s.date);
  assert.equal(row?.status, "generated");
  assert.deepEqual(row?.source_event_ids, ids, "必须落成 text[] 而不是 record");
  assert.equal(row?.summary, "傍晚那阵子，你在屏幕前坐了很久。");
  assert.equal(row?.selection_reason, "理由");
});

test("日记失败行：空 source_event_ids 不再是 `()` 语法错误", async () => {
  const s = await seedScope();

  // 这一支就是 09-30 之后每天真实走的那条：选材没过，guard 建了但 sourceEventIds 是空的。
  await db.execute(diarySummaryUpsertSql({
    scope: scopeOf(s),
    facts: ZERO_FACTS,
    draft: null,
    failureReason: "diary_output_invalid" as never,
    guard: guardOf([]),
  }));

  const row = await readRow(s.workspaceId, s.userId, s.date);
  assert.equal(row?.status, "failed");
  assert.deepEqual(row?.source_event_ids, [], "空数组落库为空数组，不是崩溃也不是 NULL");
});

test("没有 guard 时（连选材都没进）同样落库成功", async () => {
  const s = await seedScope();

  await db.execute(diarySummaryUpsertSql({
    scope: scopeOf(s),
    facts: ZERO_FACTS,
    draft: null,
    failureReason: "model_unavailable" as never,
    guard: undefined,
  }));

  const row = await readRow(s.workspaceId, s.userId, s.date);
  assert.equal(row?.status, "failed");
  assert.deepEqual(row?.source_event_ids, []);
});

test("对照组：JS 数组进 text[] 语境必然失败，字面量才落得进去", async () => {
  // 这条不是"测 postgres.js 的脾气"，是**守住这次修复的必要性**：
  // 哪天有人把 `toTextArrayLiteral(...)` 去掉直接传数组，这里会先红。
  //
  // Drizzle 把 Postgres 的真实原因挂在 `cause` 上（`err.message` 只有拼出来的那句
  // `Failed query: SELECT ($1, $2)::text[] AS v`），所以这里沿 cause 链取值。
  const broken = await db
    .execute(drizzleSql`SELECT ${["a", "b"]}::text[] AS v`)
    .then(() => null, (err: unknown) => {
      const chain: string[] = [];
      for (let cur: unknown = err; cur instanceof Error; cur = (cur as { cause?: unknown }).cause) {
        chain.push(cur.message);
      }
      return chain.join(" | ");
    });
  assert.match(
    String(broken),
    /record|syntax error/i,
    `JS 数组进 text[] 语境必然失败，实际拿到：${broken}`,
  );

  const ok = await db.execute<{ v: string[] }>(drizzleSql`SELECT ${toTextArrayLiteral(["a", "b"])}::text[] AS v`);
  assert.deepEqual(ok[0]?.v, ["a", "b"]);
});

test("字面量转义：引号与反斜杠必须原样进出", async () => {
  const values = ['a"b', "c\\d", "中文，标点", ""];
  const rows = await db.execute<{ v: string[] }>(drizzleSql`SELECT ${toTextArrayLiteral(values)}::text[] AS v`);
  assert.deepEqual(rows[0]?.v, values);
});
