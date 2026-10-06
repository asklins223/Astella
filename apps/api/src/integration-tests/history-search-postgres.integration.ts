/**
 * 完整历史全文搜索 HTTP 集成测试（方案 16 §10.4）。
 *
 * 覆盖：消息正文命中（参数化 ILIKE，只搜当前 user/workspace）、无命中、
 * 删除会话后不命中（物理清除）、缺 q 参数 400。
 *
 * 运行（**要跑在 CI 那个受限角色形状上**；以前这行写的是超户串，那等于把眼罩当配方发）：
 *   scripts/with-restricted-db-urls.py apps/api \
 *     node --import tsx --test --test-concurrency=1 src/integration-tests/history-search-postgres.integration.ts
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID, createHash } from "node:crypto";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { companionHistorySearchV1Schema } from "@astella/shared/companion-memory-desktop-contracts";

const CONN = testDatabaseUrl("DATABASE_URL_API");
process.env.DATABASE_URL_API ??= CONN;
const sql = postgres(CONN, { max: 2 });
const { closeDatabase } = await import("../db/client.ts");

/**
 * 裸 SQL 夹具/校验必须带 workspace/user 上下文。
 *
 * companion_conversations / companion_messages 是 FORCE RLS：受限角色
 * （astella_api）在无上下文事务里 DELETE 会静默匹配 0 行，于是"删除会话后
 * 不再命中"的断言仍然搜得到旧行（超级用户则绕过 RLS 掩盖同一问题）。
 */
function scoped<T>(
  scope: { workspaceId: string; userId: string },
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${scope.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${scope.userId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

after(async () => {
  await closeDatabase();
  await sql.end({ timeout: 2 });
});

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function seedIdentity() {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const token = `hs-test-${randomUUID()}`;
  const conversationId = randomUUID();
  // 种进去那条用户消息自己的 id：钉「命中的是哪一条」直接用它，不回读一次
  // （回读得再带一套 workspace 上下文才看得见行，而这一个 id 本来就只有一个来源）。
  const seededMessageId = randomUUID();
  await scoped({ workspaceId, userId }, async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash, role) VALUES (${userId}, ${"hs-" + userId.slice(0, 8) + "@x.test"}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${workspaceId}, ${"w" + workspaceId.slice(0, 8)}, ${userId})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
    await tx`INSERT INTO sessions (token, user_id, workspace_id, expires_at)
      VALUES (${hashToken(token)}, ${userId}, ${workspaceId}, now() + interval '1 hour')`;
    await tx`INSERT INTO companion_conversations (id, workspace_id, user_id, kind, status, title, title_source, created_at, updated_at)
      VALUES (${conversationId}, ${workspaceId}, ${userId}, 'inbox', 'active', '搜索测试会话', 'placeholder', now(), now())`;
      // 块的分派字段是 `type` 不是 `kind`（库里 1288 行实测 1274 条以 `{"type":"text"}` 开头、
    // 带 `kind` 的是 0 条；`companionContentBlockV1Schema` 也按 `type` 分派）。这份夹具以前
    // 写的是 `kind`——那份 schema 当场解不动，再一次证明这份文件从没跑过。
  await tx`INSERT INTO companion_messages (id, workspace_id, user_id, conversation_id, seq, role, kind, blocks, content_sha256, created_at)
      VALUES (${seededMessageId}, ${workspaceId}, ${userId}, ${conversationId}, 1, 'user', 'text',
              '[{"type":"text","text":"我喜欢独特关键词xyz的学习方法"}]'::jsonb, ${"h1"}, now())`;
      // 块的分派字段是 `type` 不是 `kind`（库里 1288 行实测 1274 条以 `{"type":"text"}` 开头、
    // 带 `kind` 的是 0 条；`companionContentBlockV1Schema` 也按 `type` 分派）。这份夹具以前
    // 写的是 `kind`——那份 schema 当场解不动，再一次证明这份文件从没跑过。
  await tx`INSERT INTO companion_messages (id, workspace_id, user_id, conversation_id, seq, role, kind, blocks, content_sha256, created_at)
      VALUES (${randomUUID()}, ${workspaceId}, ${userId}, ${conversationId}, 2, 'assistant', 'text',
              '[{"type":"text","text":"明白，我会按这个目标安排。"}]'::jsonb, ${"h2"}, now())`;
  });
  const cleanup = async () => {
    await scoped({ workspaceId, userId }, async (tx) => {
      await tx`DELETE FROM companion_messages WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM companion_conversations WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM sessions WHERE user_id = ${userId}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      await tx`DELETE FROM users WHERE id = ${userId}`;
    });
  };
  // 带关键词的那条是 seq=1 的用户消息；把它自己的 id 回传，用例才能钉"命中的是哪一条"。
  return { token, workspaceId, userId, conversationId, messageId: seededMessageId, cleanup };
}

async function buildApp(): Promise<FastifyInstance> {
  // 这一族路由在伴星对话能力开关后面（`config/learning-companion-flags.ts:24` 判的是字面量
  // `"true"`）。开关没开时**每一发都是 404**——2026-09-26 这份文件第一次真跑就红在这里，
  // 读起来像"历史搜索被删了"，其实是要先开闸。在这里把它开上，而不是让每个读红的人自己猜。
  process.env.COMPANION_DIALOGUE_V1_ENABLED = "true";
  const app = Fastify({ logger: false });
  const { continuousHistoryRoutes } = await import("../modules/companion-conversation/memory/continuous-history-routes.ts");
  await app.register(continuousHistoryRoutes);
  return app;
}

test("§10.4 历史搜索：命中/无命中/删除后不命中/缺 q 400", async () => {
  const identity = await seedIdentity();
  const app = await buildApp();
  try {
    const auth = { authorization: `Bearer ${identity.token}` };

    // 命中。
    const hit = await app.inject({
      method: "GET",
      url: `/companion/history/search?q=${encodeURIComponent("独特关键词xyz")}`,
      headers: auth,
    });
    assert.equal(hit.statusCode, 200);
    const hitBody = hit.json();
    assert.equal(hitBody.version, 1);
    assert.equal(hitBody.items.length, 1);
    // 一条命中回的是**消息本身**，不是"它属于哪条会话"：产品层刻意不暴露 conversation
    // （`packages/shared/src/contracts/companion-memory-desktop-contracts.ts` 那一段的文件头，
    // 且 `companionHistoryItemV1Schema` 是 `.strict()`）。这份文件从没跑过，因此一直按
    // 想象中的形状断言 `conversationId`/`conversationTitle`——那两个字段从来就没有过。
    // 现在按**客户端真正用来解析的那份 schema** 解一遍（两侧同一合同，不各写一遍形状），
    // 再钉"命中的确实是带那个关键词的那条消息"。
    const parsed = companionHistorySearchV1Schema.safeParse(hitBody);
    assert.ok(parsed.success, `响应过不了桌面端那份 schema：${JSON.stringify(parsed.error?.issues)}`);
    assert.equal(parsed.data!.items[0].messageId, identity.messageId,
      "命中的不是那条带关键词的消息");
    assert.ok(JSON.stringify(parsed.data!.items[0].blocks).includes("独特关键词xyz"));
    assert.equal((hitBody.items[0] as Record<string, unknown>).conversationId, undefined,
      "响应里出现了 conversation 字段——那一档「不暴露」的裁定被悄悄推翻了");

    // 无命中。
    const miss = await app.inject({
      method: "GET",
      url: `/companion/history/search?q=${encodeURIComponent("不存在的词zzz")}`,
      headers: auth,
    });
    assert.equal(miss.statusCode, 200);
    assert.ok(companionHistorySearchV1Schema.safeParse(miss.json()).success,
      "空结果也要过同一份 schema（否则界面那一侧会解不动）");
    assert.equal(miss.json().items.length, 0);

    // 缺 q → 400。
    const bad = await app.inject({ method: "GET", url: "/companion/history/search", headers: auth });
    assert.equal(bad.statusCode, 400);

    // 删除会话后不命中（物理清除；redacted 内容不得命中）。
    await scoped(identity, (tx) => tx`DELETE FROM companion_conversations WHERE id = ${identity.conversationId}`);
    const afterDelete = await app.inject({
      method: "GET",
      url: `/companion/history/search?q=${encodeURIComponent("独特关键词xyz")}`,
      headers: auth,
    });
    assert.equal(afterDelete.json().items.length, 0);
  } finally {
    await identity.cleanup();
    await app.close();
  }
});

test('连续历史读取旧正文、签名分页、较早消息定位并保持用户隔离', async () => {
  const identity = await seedIdentity();
  const other = await seedIdentity();
  const app = await buildApp();
  const oldActionId = randomUUID();
  const oldTextId = randomUUID();
  const previousSecret = process.env.AUTH_SURFACE_MANIFEST_SECRET;
  delete process.env.AUTH_SURFACE_MANIFEST_SECRET;
  try {
    await scoped(identity, async tx => {
      await tx`UPDATE companion_messages SET created_at = CASE WHEN seq = 1 THEN '2026-09-10'::timestamptz ELSE '2026-09-11'::timestamptz END WHERE conversation_id = ${identity.conversationId}`;
      await tx`INSERT INTO companion_messages (id,workspace_id,user_id,conversation_id,seq,role,kind,blocks,content_sha256,created_at)
        VALUES (${oldActionId},${identity.workspaceId},${identity.userId},${identity.conversationId},3,'assistant','action',
          '{"blocks":[{"type":"text","text":"旧记录：一次回执"}]}'::jsonb,'old-action','2026-09-08'),
          (${oldTextId},${identity.workspaceId},${identity.userId},${identity.conversationId},4,'user','text',
          '[{"kind":"text","text":"旧记录：一次提问"}]'::jsonb,'old-text','2026-09-09')`;
    });
    const headers = { authorization: 'Bearer ' + identity.token };
    const page = await app.inject({ method: 'GET', url: '/companion/history?limit=2', headers });
    assert.equal(page.statusCode, 200, page.body);
    const cursor = page.json().nextCursor;
    assert.equal(typeof cursor, 'string');
    const older = await app.inject({ method: 'GET', url: '/companion/history?limit=2&before=' + encodeURIComponent(cursor), headers });
    assert.equal(older.statusCode, 200, older.body);
    assert.equal(older.json().nextCursor, null);
    assert.deepEqual(older.json().items.map((item: { messageId: string }) => item.messageId), [oldActionId, oldTextId]);
    assert.deepEqual(older.json().items[0].blocks, [{ type: 'text', text: '旧记录：一次回执' }]);
    assert.deepEqual(older.json().items[1].blocks, [{ type: 'text', text: '旧记录：一次提问' }]);
    const found = await app.inject({ method: 'GET', url: '/companion/history?throughMessageId=' + oldActionId, headers });
    assert.equal(found.statusCode, 200, found.body);
    assert.deepEqual(found.json().items.map((item: { messageId: string }) => item.messageId), [oldActionId]);
    const noLeak = await app.inject({ method: 'GET', url: '/companion/history?throughMessageId=' + oldActionId, headers: { authorization: 'Bearer ' + other.token } });
    assert.equal(noLeak.statusCode, 404);
    const crossCursor = await app.inject({ method: 'GET', url: '/companion/history?before=' + encodeURIComponent(cursor), headers: { authorization: 'Bearer ' + other.token } });
    assert.equal(crossCursor.statusCode, 400);
    const forged = await app.inject({ method: 'GET', url: '/companion/history?before=' + encodeURIComponent(cursor + 'x'), headers });
    assert.equal(forged.statusCode, 400);
    const search = await app.inject({ method: 'GET', url: '/companion/history/search?q=' + encodeURIComponent('旧记录'), headers });
    assert.equal(search.statusCode, 200);
    assert.deepEqual(search.json().items.map((item: { messageId: string }) => item.messageId), [oldActionId, oldTextId]);
  } finally {
    if (previousSecret !== undefined) process.env.AUTH_SURFACE_MANIFEST_SECRET = previousSecret;
    await identity.cleanup(); await other.cleanup(); await app.close();
  }
});
