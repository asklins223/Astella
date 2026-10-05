/**
 * 路由层 HTTP 契约集成测试（第五轮 B1 盲区）。
 *
 * 此前全仓无 `.inject(` 测试——分页形状、错误 JSON、状态码全靠手写契约，
 * 无自动化保护。本测试用真实 Fastify 实例 + 真实 DB session 认证，
 * 锁死以下契约（2026-08-11 统一后）：
 * - 错误响应统一 { error, message }（invalid_id_format / not_found）；
 * - 非法 UUID 一律 400；
 * - 软删除返回 204（DELETE /sources/:id）；
 * - 分页统一 { items, nextCursor, total }（GET /notes）。
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID, createHash } from "node:crypto";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";

// 夹具那一边用 migrator：CI 的 `DATABASE_URL_API` 是 NOBYPASSRLS 的 `ailearn_api`，
// 而这份文件是**裸 SQL 建 session/source 行**（不带 app.workspace_id 上下文），在
// `sec01_v1_sources_tenant_guard` 那一半 RESTRICTIVE 守卫下直接 42501。被测的 HTTP 侧
// 仍走应用自己的池（受限角色），所以隔离语义没丢。
const CONN = testDatabaseUrl("DATABASE_URL_MIGRATOR");
const sql = postgres(CONN, { max: 2 });
const { closeDatabase } = await import("../db/client.ts");

after(async () => {
  await closeDatabase();
  await sql.end({ timeout: 2 });
});

/** 与 identity/service.ts hashToken 一致（SHA-256 hex） */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function seedIdentity(): Promise<{
  token: string;
  workspaceId: string;
  userId: string;
  cleanup: () => Promise<void>;
}> {
  const ws = randomUUID();
  const uid = randomUUID();
  const token = `contract-test-${randomUUID()}`;
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`SELECT set_config('app.user_id', ${uid}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role) VALUES (${uid}, ${"ct-" + uid.slice(0, 8) + "@x.test"}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${ws}, ${"w" + ws.slice(0, 8)}, ${uid})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${ws}, ${uid}, 'owner')`;
    await tx`INSERT INTO sessions (token, user_id, workspace_id, expires_at)
      VALUES (${hashToken(token)}, ${uid}, ${ws}, now() + interval '1 hour')`;
  });
  const cleanup = async () => {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      await tx`SELECT set_config('app.user_id', ${uid}, true)`;
      await tx`DELETE FROM note_versions WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM notes WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM sources WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM sessions WHERE user_id = ${uid}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM workspaces WHERE id = ${ws}`;
      await tx`DELETE FROM users WHERE id = ${uid}`;
    });
  };
  return { token, workspaceId: ws, userId: uid, cleanup };
}

async function buildApp(extra?: {
  rateLimitStore?: { increment: () => unknown; delete: () => void; sweep?: () => void };
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const multipart = (await import("@fastify/multipart")).default;
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
  const { noteRoutes } = await import("../modules/note/routes.ts");
  const { reviewRoutes } = await import("../modules/review/routes.ts");
  const { sourceRoutes } = await import("../modules/source/routes.ts");
  const { uploadRoutes } = await import("../modules/upload/routes.ts");
  const { importRoutes } = await import("../modules/import/routes.ts");
  await app.register(noteRoutes);
  await app.register(reviewRoutes);
  await app.register(sourceRoutes);
  await app.register(uploadRoutes, extra as never);
  await app.register(importRoutes);
  return app;
}

test("契约：错误响应统一 {error, message} + 非法 UUID 400 + 软删除 204 + 分页形状", async () => {
  const identity = await seedIdentity();
  const app = await buildApp();
  try {
    const auth = { authorization: `Bearer ${identity.token}` };

    // 1) 非法 UUID → 400 { error: "invalid_id_format", message }
    const badId = await app.inject({ method: "GET", url: "/v2/notes/not-a-uuid", headers: auth });
    assert.equal(badId.statusCode, 400);
    assert.deepEqual(badId.json(), { error: "invalid_id_format", message: "无效的 id 格式" });

    // 2) 合法但不存在 → 404 { error: "not_found", message }
    const missingId = await app.inject({
      method: "GET",
      url: `/v2/notes/${randomUUID()}`,
      headers: auth,
    });
    assert.equal(missingId.statusCode, 404);
    assert.deepEqual(missingId.json(), { error: "not_found", message: "资源不存在" });

    // 3) 软删除 source → 204（无响应体）
    const sourceId = randomUUID();
    await sql`INSERT INTO sources (id, workspace_id, created_by, type, title, status)
      VALUES (${sourceId}, ${identity.workspaceId}, ${identity.userId}, 'url', '契约测试', 'ready')`;
    const del = await app.inject({
      method: "DELETE",
      url: `/sources/${sourceId}`,
      headers: auth,
    });
    assert.equal(del.statusCode, 204);
    assert.equal(del.body, "");

    // 4) 分页统一 { items, nextCursor, total }（GET /notes）
    for (let index = 0; index < 2; index += 1) {
      await sql`INSERT INTO notes (id, workspace_id, created_by, title)
        VALUES (${randomUUID()}, ${identity.workspaceId}, ${identity.userId}, ${"契约笔记" + index})`;
    }
    const list = await app.inject({ method: "GET", url: "/notes?limit=1", headers: auth });
    assert.equal(list.statusCode, 200);
    const body = list.json();
    assert.ok(Array.isArray(body.items), "分页响应必须含 items 数组");
    assert.equal(typeof body.total, "number", "分页响应必须含 total");
    assert.ok(
      body.nextCursor === null || typeof body.nextCursor === "string",
      "分页响应必须含 nextCursor（string|null）",
    );
    assert.ok(!("nextOffset" in body), "nextOffset 已废弃，不得出现在响应中");
  } finally {
    await identity.cleanup();
    await app.close();
  }
});

test("契约：upload 429 限流返回 {error: rate_limited, message} + Retry-After", async () => {
  const identity = await seedIdentity();
  const app = await buildApp({
    rateLimitStore: {
      // 永不允许：count 超限、resetAt 未来
      increment: () => ({ count: 99, resetAt: Date.now() + 60_000 }),
      delete: () => {},
      sweep: () => {},
    },
  });
  try {
    const boundary = "----contract-boundary-7d4f";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="dummy"',
      "",
      "x",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const res = await app.inject({
      method: "POST",
      url: "/uploads/images",
      headers: {
        authorization: `Bearer ${identity.token}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(Buffer.byteLength(body)),
      },
      payload: body,
    });
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers["retry-after"], "60");
    assert.deepEqual(res.json(), { error: "rate_limited", message: "上传过于频繁，请稍后重试" });
  } finally {
    await identity.cleanup();
    await app.close();
  }
});

test("契约：/import/markdown 相同 importId 幂等（F-033）", async () => {
  const identity = await seedIdentity();
  const app = await buildApp();
  try {
    const auth = { authorization: `Bearer ${identity.token}` };
    const body = {
      importId: "idem-contract-1",
      items: [{ title: "幂等契约笔记", content: "# 幂等契约笔记\n\n正文内容。" }],
    };
    const first = await app.inject({
      method: "POST",
      url: "/import/markdown",
      headers: auth,
      payload: body,
    });
    assert.equal(first.statusCode, 200, `首次导入应成功: ${first.body}`);
    const second = await app.inject({
      method: "POST",
      url: "/import/markdown",
      headers: auth,
      payload: body,
    });
    assert.equal(second.statusCode, 200, "幂等重放应成功（不报错）");
    const rows = await sql`
      SELECT count(*)::int AS c FROM notes WHERE workspace_id = ${identity.workspaceId}
    `;
    assert.equal(Number(rows[0]?.c ?? 0), 1, "同 importId 重放不得创建重复笔记");
  } finally {
    await identity.cleanup();
    await app.close();
  }
});

/**
 * 「暂不安排」两条入口的路由契约（39d W7-3 刀一）。
 *
 * 服务层的判据在 `review-schedule-boundary-postgres` 那份里已经量过，那一份调的是函数——
 * 函数绿不等于**这门有人打得开**：状态码、请求校验、以及"笔记不存在"要回 404 而不是
 * 让外键抛 500，全都只在路由这一层成立。这一格也是那两条 route 目前唯一的读数。
 */
test("契约：目标「暂不安排」与「恢复」两条 route 的形状", async () => {
  const identity = await seedIdentity();
  const app = await buildApp();
  const noteId = randomUUID();
  const objectiveId = randomUUID();
  try {
    const auth = { authorization: `Bearer ${identity.token}` };
    await sql`INSERT INTO notes (id, workspace_id, created_by, title)
      VALUES (${noteId}, ${identity.workspaceId}, ${identity.userId}, '暂不安排契约那一篇')`;

    // 「恢复并开启」要真的排得上，前提是**有人替她开过授权**。
    //
    // 2026-10-05 补记：7dce8ae3（w7-8）给唯一调度边界加了来源级授权判定，其中
    // `never_authorized` 那一档明确写着「创建卡、读过笔记或结束一轮都不默认授权未来提醒」
    // ⇒ 排不上 ⇒ `resume` 如实回 409 `objective_held`。而本用例的夹具只插了一篇笔记，
    // 从没建立过任何授权来源，于是它一直在 409 上红，报错写着 409 !== 200——
    // 看不出是夹具缺东西。
    //
    // 判据自己说的两样都要给：`learning_objective_origins_v2` 里目标落在哪篇笔记上
    // （note 档血缘），以及那篇笔记上有一条 active 的订阅。
    // note 档血缘按 `loo_v2_kind_fields_chk`（0175）还要求 note_version_id 非空，
    // 所以先给这篇笔记落一个版本。
    const noteVersionId = randomUUID();
    await sql`INSERT INTO note_versions (id, workspace_id, note_id, version_no, content_hash, content_json, created_by)
      VALUES (${noteVersionId}, ${identity.workspaceId}, ${noteId}, 1, ${"a".repeat(64)},
              ${JSON.stringify({ blocks: [] })}, ${identity.userId})`;
    await sql`INSERT INTO learning_objective_origins_v2
        (id, workspace_id, origin_id, objective_id, objective_revision_id, origin_kind, note_id, note_version_id, integrity)
      VALUES (${randomUUID()}, ${identity.workspaceId}, ${randomUUID()}, ${objectiveId}, ${randomUUID()},
              'note', ${noteId}, ${noteVersionId}, 'verified')`;
    await sql`INSERT INTO review_subscriptions_v2
        (id, workspace_id, user_id, source, subject_type, subject_id, status, scope_note)
      VALUES (${randomUUID()}, ${identity.workspaceId}, ${identity.userId},
              'note_subscription', 'note', ${noteId}, 'active', '恢复并开启的契约夹具')`;

    // 1) 请求体非法 ⇒ 400，且形状与全仓统一（{error, message}）
    const rejected = await app.inject({
      method: "POST",
      url: "/v2/reviews/objectives/hold",
      headers: auth,
      payload: { noteId: "not-a-uuid", objectiveId },
    });
    assert.equal(rejected.statusCode, 400);
    assert.deepEqual(rejected.json(), { error: "validation", message: "参数非法" });

    // 2) 笔记不存在 ⇒ 404 一句人话，不是外键的 500
    const missingNote = await app.inject({
      method: "POST",
      url: "/v2/reviews/objectives/hold",
      headers: auth,
      payload: { noteId: randomUUID(), objectiveId },
    });
    assert.equal(missingNote.statusCode, 404);
    assert.equal(missingNote.json().error, "note_not_found");

    // 3) 立排除：第一次是"这次立的"，连点第二下如实说"已经在排除中"（幂等，不重复立）
    const first = await app.inject({
      method: "POST",
      url: "/v2/reviews/objectives/hold",
      headers: auth,
      payload: { noteId, objectiveId },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().alreadyHeld, false);
    assert.equal(first.json().dismissedPendingSchedules, 0,
      "这个目标此刻没有待处理的安排可撤——那个数只能是真数出来的，不能是估的");
    const twice = await app.inject({
      method: "POST",
      url: "/v2/reviews/objectives/hold",
      headers: auth,
      payload: { noteId, objectiveId },
    });
    assert.equal(twice.json().alreadyHeld, true, "连点两下不该把第二次说成刚立上");

    // 4) 恢复：第一次 released=true，再恢复一次如实回 false（"本来就没在排除中"≠"已恢复"）
    // `noteId` 自 2026-09-27 起必填：这一发不再只是解除排除，它会写 `review_schedules`，
    // 排的是"这一篇的这个目标"，所以要由服务端判可见性。少传就是 400。
    const resumed = await app.inject({
      method: "POST",
      url: "/v2/reviews/objectives/resume",
      headers: auth,
      payload: { noteId, objectiveId },
    });
    assert.equal(resumed.statusCode, 200);
    assert.equal(resumed.json().released, true);
    const again = await app.inject({
      method: "POST",
      url: "/v2/reviews/objectives/resume",
      headers: auth,
      payload: { noteId, objectiveId },
    });
    assert.equal(again.json().released, false);

    const live = await sql`
      SELECT count(*)::int AS n FROM objective_review_holds_v2
      WHERE workspace_id = ${identity.workspaceId} AND objective_id = ${objectiveId}
        AND released_at IS NULL
    `;
    assert.equal(Number(live[0].n), 0, "恢复之后不该还有活的排除");
    // 没被恢复之前那次"连点"只留一份活行，恢复后全部盖时间戳 ⇒ 历史行还在（不删历史）。
    const history = await sql`
      SELECT count(*)::int AS n FROM objective_review_holds_v2
      WHERE objective_id = ${objectiveId}
    `;
    assert.equal(Number(history[0].n), 1,
      "两次设排除命中同一份活行 ⇒ 表上只该有一条历史，部分唯一索引在路由这一发也生效");
  } finally {
    await sql`DELETE FROM objective_review_holds_v2 WHERE workspace_id = ${identity.workspaceId}`;
    await sql`DELETE FROM notes WHERE id = ${noteId}`;
    await app.close();
    await identity.cleanup();
  }
});
