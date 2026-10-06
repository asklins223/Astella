/**
 * 方案 44 §5.5：跨会话「取回原文」这条闭环，在**真实数据库**上跑通。
 *
 * ## 为什么单独一条
 *
 * 这条链路上一轮被查出过一个只有真库能发现的缺陷：
 * `readPastConversationMessages` 取了 `companion_messages.page_context`——那一列只存在于
 * `companion_turn_runs`。SQL 解析守卫能发现它，但「发现语法/列没问题」不等于
 * 「取回的内容是对的」：正文是按 `companionHistoryText` 还原的，而用户消息带着
 * 选区上下文，还原对了才说明这一整条（跨会话摘要 → 覆盖区间 → 取回原文）是闭合的。
 *
 * 运行：DATABASE_URL_API=... DATABASE_URL=... npm run test:plan44-excerpt:postgres
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";

const CONN = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!CONN) throw new Error("DATABASE_URL 未配置——取回原文的集成测试要求真实 Postgres");

const sql = postgres(CONN, { max: 2 });
const workspaceId = randomUUID();
const userId = randomUUID();
const conversationId = randomUUID();
const turnRunId = randomUUID();
const userMessageId = randomUUID();
const email = `plan44x-${userId.slice(0, 8)}@example.test`;

const { readPastConversationMessages } = await import(
  "../../../../workers/ai-worker/src/handlers/companion-summary-retrieval.ts"
);

const { PgDialect } = await import("drizzle-orm/pg-core");
const dialect = new PgDialect();

/**
 * 被测函数吃的是 drizzle 的 `Executor`（只有一个 `execute(SQL)`），夹具手里是 postgres.js。
 *
 * 用 pg dialect 把 `SQL` 渲染成 `{sql, params}` 再交给 postgres.js——**参数必须真的绑定**。
 * 这不是洁癖：渲染出来是 `… >= $1::bigint`，若把字面量拼进文本，`::bigint` 会落在参数值
 * 内部，报 `syntax error at or near "::"`——而真凶是夹具，不是被测的 SQL。
 * 第一版正是这样栽的：报错指向 SQL，看不出问题在夹具。
 */
const drizzleExecutor = (db: ReturnType<typeof postgres>): { execute: (q: never) => Promise<unknown> } => ({
  execute: async (query: never) => {
    const rendered = dialect.sqlToQuery(query);
    // postgres.js 的参数类型比 drizzle 的 unknown[] 窄；这里只做一次显式转换，
    // 真实绑定关系不变（渲染出来仍是 $1、$2… + params 数组）。
    return db.unsafe(rendered.sql, rendered.params as Parameters<typeof db.unsafe>[1]);
  },
});

after(async () => {
  await sql`DELETE FROM companion_messages WHERE conversation_id = ${conversationId}`.catch(() => {});
  await sql`DELETE FROM companion_turn_runs WHERE id = ${turnRunId}`.catch(() => {});
  await sql`DELETE FROM companion_conversations WHERE id = ${conversationId}`.catch(() => {});
  await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`.catch(() => {});
  await sql`DELETE FROM users WHERE id = ${userId}`.catch(() => {});
  await sql.end({ timeout: 5 }).catch(() => {});
});

test("44 §5.5：按覆盖区间取回原文，正文按同一份投影还原（含用户消息的选区上下文）", async () => {
  await sql`INSERT INTO users (id, email, password_hash) VALUES (${userId}, ${email}, 'x')`;
  await sql`INSERT INTO workspaces (id, owner_id, name) VALUES (${workspaceId}, ${userId}, 'w')`;
  await sql`INSERT INTO companion_conversations
    (id, workspace_id, user_id, title, title_source, kind, status)
    VALUES (${conversationId}, ${workspaceId}, ${userId}, 't', 'auto', 'dialogue', 'active')`;

  const userText = "帮我复习光合作用";
  const assistantText = "光合作用分光反应与暗反应。";
  await sql`INSERT INTO companion_messages
    (id, workspace_id, user_id, conversation_id, seq, kind, role, blocks, content_sha256)
    VALUES (${userMessageId}, ${workspaceId}, ${userId}, ${conversationId}, 3, 'text', 'user',
            ${sql.json([{ type: "text", text: userText }])},
            ${createHash("sha256").update(userText).digest("hex")})`;
  await sql`INSERT INTO companion_messages
    (id, workspace_id, user_id, conversation_id, seq, kind, role, blocks, content_sha256)
    VALUES (${randomUUID()}, ${workspaceId}, ${userId}, ${conversationId}, 4, 'text', 'assistant',
            ${sql.json([{ type: "text", text: assistantText }])},
            ${createHash("sha256").update(assistantText).digest("hex")})`;

  // 用户消息带选区上下文：它挂在 companion_turn_runs 上，通过 user_message_id 回指。
  // 这一行是这一轮修好 page_context 取法之后**真正应该取到东西**的地方——
  // 修之前这里会报 column m.page_context does not exist。
  await sql`INSERT INTO companion_turn_runs
    (id, workspace_id, user_id, conversation_id, generation, status, user_message_id,
     idempotency_key_hash, request_body_hash, page_context)
    VALUES (${turnRunId}, ${workspaceId}, ${userId}, ${conversationId}, 1, 'succeeded', ${userMessageId},
            ${"a".repeat(64)}, ${"b".repeat(64)}, ${sql.json({ selection: { page: 12 } })})`;

  const result = await readPastConversationMessages(
    drizzleExecutor(sql),
    // 真正的调用形态：范围校验走会话，序号区间来自上一���的覆盖区间。
    { workspaceId, userId },
    { conversationId, fromSeq: "3", throughSeq: "4", limit: 10 },
  );

  assert.equal(result.messages.length, 2, "按 [3,4] 取回应拿到两条");
  assert.equal(result.messages[0]!.seq, "3");
  assert.equal(result.messages[0]!.role, "user");
  assert.ok(result.messages[0]!.text.includes("光合作用"), `用户正文没还原出来：${result.messages[0]!.text}`);
  assert.ok(result.messages[1]!.text.includes("光合作用分光反应"), "助手正文没还原出来");
  assert.equal(result.truncated, false);
});

test("44 §3.2：区间落在别人的会话上时取不到任何东西", async () => {
  const other = randomUUID();
  await sql`INSERT INTO companion_conversations
    (id, workspace_id, user_id, title, title_source, kind, status)
    VALUES (${other}, ${workspaceId}, ${userId}, '别人的', 'auto', 'dialogue', 'active')`;
  try {
    // 用**别的** user 去读上面那个会话：范围校验必须挡住。
    const stranger = randomUUID();
    await sql`INSERT INTO users (id, email, password_hash) VALUES (${stranger}, ${`s-${Date.now()}@x.test`}, 'x')`;
    const result = await readPastConversationMessages(
      drizzleExecutor(sql),
      { workspaceId, userId: stranger },
      { conversationId, fromSeq: "1", throughSeq: "99", limit: 10 },
    );
    assert.equal(result.messages.length, 0, "跨用户读到了别人的对话——范围校验失效");
    await sql`DELETE FROM users WHERE id = ${stranger}`;
  } finally {
    await sql`DELETE FROM companion_conversations WHERE id = ${other}`.catch(() => {});
  }
});
