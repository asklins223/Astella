/**
 * 记忆管理 HTTP 面（`/companion/memory*`，20 条路由）的行为契约。
 *
 * 服务层已由 assistant-memory / memory-star-map 集成测试覆盖；这里覆盖此前完全
 * 没有断言的一层：真实 session 下的状态码映射、strict body 校验、no-store，
 * 以及最要紧的**跨用户存在性不泄露**（对别人的 memoryId 必须 404，而不是 403
 * 或 200 —— 后者会暴露「这个 id 存在」）。
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import sensible from "@fastify/sensible";
// 账号级范围守卫的**同一句**拒绝文案（API 两处路由、伴星工具与提案链共用它）。
import {
  accountPreferenceRejectionMessage,
  type AccountPreferenceWriteRejection,
} from "@ailearn/shared/companion-memory-scope";

process.env.COMPANION_MEMORY_VECTOR_V1 = "true";
// 星图是独立开关（§9.8），只开 VECTOR 时 /memory/star-map 会 404。
process.env.COMPANION_MEMORY_STAR_MAP_V1 = "true";
process.env.COMPANION_SUMMARIZER_V1 = "true";

// Test fixture setup creates users/workspaces directly, while the API's own
// pool can remain on the restricted ailearn_api role for the request path.
const CONN = process.env.DATABASE_URL_TEST_ADMIN ?? process.env.DATABASE_URL ?? process.env.DATABASE_URL_API;
if (!CONN) {
  throw new Error("DATABASE_URL_API 未配置——memory routes HTTP 集成测试要求真实 Postgres");
}

const sql = postgres(CONN, { max: 3 });
const userA = randomUUID();
const userB = randomUUID();
const workspaceId = randomUUID();
const prefix = userA.slice(0, 8);
const conversationA = randomUUID();
const conversationB = randomUUID();

const { memoryRoutes } = await import("../modules/companion-conversation/memory/memory-routes.ts");
const { issueSession, revokeSession } = await import("../modules/identity/service.ts");
const { closeDatabase } = await import("../db/client.ts");

let app: FastifyInstance;
let tokenA = "";
let tokenB = "";

async function seedIdentity(): Promise<void> {
  await sql`
    INSERT INTO users (id, email, password_hash, role)
    VALUES
      (${userA}, ${`mem-http-a-${prefix}@example.test`}, 'test-hash', 'owner'),
      (${userB}, ${`mem-http-b-${prefix}@example.test`}, 'test-hash', 'owner')
  `;
  // 两个用户共处的空间必须是 collaborative：个人空间现在拒绝被分享
  // （`createInvite` 对 personal 目标直接 409），夹具若绕过业务校验造出
  // "第二成员写进别人 personal 空间"的行，测的就是一个产品上不可能存在的状态。
  await sql`
    INSERT INTO workspaces (id, name, owner_id, workspace_type)
    VALUES (${workspaceId}, ${`mem-http-${prefix}`}, ${userA}, 'collaborative')
  `;
  await sql`
    INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES (${workspaceId}, ${userA}, 'owner'), (${workspaceId}, ${userB}, 'member')
  `;
  await sql`
    INSERT INTO companion_conversations (id, workspace_id, user_id, kind, title, title_source, status)
    VALUES (${conversationA}, ${workspaceId}, ${userA}, 'dialogue', '整理测试甲', 'user', 'active'),
           (${conversationB}, ${workspaceId}, ${userB}, 'dialogue', '整理测试乙', 'user', 'active')
  `;
}

before(async () => {
  await seedIdentity();
  tokenA = (await issueSession(userA, workspaceId)).token;
  tokenB = (await issueSession(userB, workspaceId)).token;
  app = Fastify({ logger: false });
  // server.ts 用 @fastify/sensible 提供 httpErrors + 统一错误序列化；
  // 缺了它，`throw app.httpErrors.badRequest(...)` 会退化为 500（测试假象）。
  await app.register(sensible);
  await app.register(memoryRoutes);
  await app.ready();
});

after(async () => {
  await revokeSession(tokenA).catch(() => {});
  await revokeSession(tokenB).catch(() => {});
  await app?.close();
  // 顺序不能反：`workspaces.owner_id` 是 NO ACTION、`users.personal_workspace_id`
  // 是 RESTRICT，所以不先删空间就删不掉用户。原先这里整条都挂着 `.catch(() => {})`，
  // 删除失败被静默吞掉——dev 库里那批 `mem-http-*` 残留就是这么攒出来的。
  await sql`UPDATE users SET personal_workspace_id = NULL WHERE id IN (${userA}, ${userB})`;
  await sql`DELETE FROM assistant_memory_items WHERE user_id IN (${userA}, ${userB})`;
  await sql`DELETE FROM assistant_memory_item_revisions WHERE user_id IN (${userA}, ${userB})`;
  await sql`DELETE FROM companion_discovery_entries WHERE user_id IN (${userA}, ${userB})`;
  await sql`DELETE FROM companion_daily_summaries WHERE user_id IN (${userA}, ${userB})`;
  await sql`DELETE FROM sources WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM companion_conversations WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
  await sql`DELETE FROM users WHERE id IN (${userA}, ${userB})`;
  const leftover = await sql`SELECT count(*)::int AS n FROM workspaces WHERE id = ${workspaceId}`;
  assert.equal(leftover[0].n, 0, `夹具残留了工作区 ${workspaceId}，teardown 顺序需要修`);
  await sql.end({ timeout: 5 }).catch(() => {});
  await closeDatabase().catch(() => {});
});

function as(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function req(
  token: string,
  method: "GET" | "POST" | "DELETE",
  url: string,
  payload?: Record<string, unknown>,
): InjectOptions {
  const options: InjectOptions = { method, url, headers: as(token) };
  if (payload !== undefined) options.payload = payload;
  return options;
}

async function createMemory(token: string, body: Record<string, unknown> = {}): Promise<string> {
  const response = await app.inject(req(token, "POST", "/companion/memory", {
    kind: "preference",
    content: "喜欢在安静时段学习",
    ...body,
  }));
  assert.equal(response.statusCode, 201, `创建记忆必须 201，实际 ${response.statusCode}：${response.body}`);
  return response.json().memoryItemId as string;
}

test("匿名请求被拒（认证先于能力），已认证请求带 no-store", async () => {
  const anonymous = await app.inject({ method: "GET", url: "/companion/memory" });
  assert.equal(anonymous.statusCode, 401);

  const authed = await app.inject(req(tokenA, "GET", "/companion/memory"));
  assert.equal(authed.statusCode, 200);
  assert.equal(authed.headers["cache-control"], "no-store");
  assert.deepEqual(authed.json(), { version: 2, items: [] });
});

test("记忆维护在排队前拒绝未同意、空对话和跨用户会话，不生成必然失败的任务", async () => {
  const beforeJobs = await sql`SELECT count(*)::int AS n FROM jobs WHERE workspace_id = ${workspaceId}`;
  for (const url of [`/companion/conversations/${conversationA}/summarize`, "/companion/memory/rebuild-embeddings"]) {
    const response = await app.inject(req(tokenA, "POST", url));
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(response.json().error, "ai_consent_required");
  }
  const crossUser = await app.inject(req(tokenA, "POST", `/companion/conversations/${conversationB}/summarize`));
  assert.equal(crossUser.statusCode, 404, "不能泄露其他用户的会话存在性");
  const { updateAIConsent, updateAIDataPolicy, getAIPrivacySettings } = await import("../modules/identity/ai-consent-service.ts");
  await updateAIConsent(workspaceId, userA, "qa-consent-v1");
  const policy = await getAIPrivacySettings(workspaceId, userA);
  if (policy?.requiresConsent) {
    const denied = await app.inject(req(tokenA, "POST", `/companion/conversations/${conversationA}/summarize`));
    assert.equal(denied.statusCode, 403, denied.body);
    assert.equal(denied.json().error, "ai_data_policy_denied");
  }
  await updateAIDataPolicy(workspaceId, userA, { sendToExternal: true, sendImageContent: false, piiDetection: true, auditLogging: true });
  const empty = await app.inject(req(tokenA, "POST", `/companion/conversations/${conversationA}/summarize`));
  assert.equal(empty.statusCode, 409, empty.body);
  assert.equal(empty.json().error, "conversation_empty");
  const afterJobs = await sql`SELECT count(*)::int AS n FROM jobs WHERE workspace_id = ${workspaceId}`;
  assert.equal(afterJobs[0].n, beforeJobs[0].n, "以上拒绝不能先排后台任务");
});

test("预算状态只返回占用；层级 API 满额时返回候选且不会替用户降层", async () => {
  const ids: string[] = [];
  for (let index = 0; index < 7; index += 1) {
    ids.push(await createMemory(tokenB, {
      content: `容量预算测试 ${index} ${randomUUID()}`,
    }));
  }

  const status = await app.inject(req(tokenB, "GET", "/companion/memory/budget"));
  assert.equal(status.statusCode, 200);
  assert.equal(status.headers["cache-control"], "no-store");
  assert.equal(status.json().resident.used.items, 0);
  assert.equal(status.json().active.items, 7);
  assert.equal(status.body.includes("容量预算测试"), false, "预算读数不回传记忆正文");

  for (const id of ids.slice(0, 6)) {
    const moved = await app.inject(req(tokenB, "POST", `/companion/memory/${id}/budget-tier`, { tier: "resident" }));
    assert.equal(moved.statusCode, 200, moved.body);
    assert.equal(moved.json().result.status, "moved");
  }

  const overflow = await app.inject(req(tokenB, "POST", `/companion/memory/${ids[6]}/budget-tier`, { tier: "resident" }));
  assert.equal(overflow.statusCode, 409);
  assert.equal(overflow.headers["cache-control"], "no-store");
  assert.equal(overflow.json().error, "memory_resident_budget_full");
  assert.equal(overflow.json().result.status, "capacity");
  assert.equal(overflow.json().result.suggestedDowngrades.length, 6);

  const afterOverflow = await app.inject(req(tokenB, "GET", "/companion/memory/budget"));
  assert.equal(afterOverflow.json().resident.used.items, 6, "满额拒绝不能静默挪走已有记忆");
  assert.equal(afterOverflow.json().active.items, 1);
  const invalidTier = await app.inject(req(tokenB, "POST", `/companion/memory/${ids[6]}/budget-tier`, { tier: "pinned" }));
  assert.equal(invalidTier.statusCode, 400);
  const crossUser = await app.inject(req(tokenA, "POST", `/companion/memory/${ids[0]}/budget-tier`, { tier: "active" }));
  assert.equal(crossUser.statusCode, 404, "层级调整不得泄露另一用户的记忆是否存在");

  const cleared = await app.inject(req(tokenB, "DELETE", "/companion/memory"));
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.json().deletedCount, 7, "清除本测试数据，避免污染后续跨用户断言");
});

test("创建：合法 body → 201；已知字段非法 → 400（未知字段按本层约定被忽略）", async () => {
  await createMemory(tokenA);

  const empty = await app.inject(req(tokenA, "POST", "/companion/memory", { kind: "goal", content: "" }));
  assert.equal(empty.statusCode, 400);

  const badKind = await app.inject(req(tokenA, "POST", "/companion/memory", { kind: "not_a_kind", content: "x" }));
  assert.equal(badKind.statusCode, 400);

  const tooLong = await app.inject(req(tokenA, "POST", "/companion/memory", { kind: "goal", content: "字".repeat(201) }));
  assert.equal(tooLong.statusCode, 400, "§9.4 上限 200 字必须在 HTTP 层拒绝");

  // 未知字段：本模块的路由 schema 沿用 z.object（13 处）而非 strictObject（2 处），
  // 即多传的键被忽略、不影响已声明字段的校验结果。此处把这个既有约定钉住，
  // 使「改用 strict」成为一个显式决定，而不是改 schema 时的意外行为变化。
  // （桌面端的 typed IPC 边界是 strict 的；这层宽松只作用于 HTTP 面。）
  const unknownKey = await app.inject(req(tokenA, "POST", "/companion/memory", {
    kind: "goal", content: "未知字段被忽略", contnet: "拼错的键",
  }));
  assert.equal(unknownKey.statusCode, 201);
  assert.equal(unknownKey.json().content, "未知字段被忽略");
});

test("候选确认：includeCandidates=false 前后的可见性变化", async () => {
  const candidateId = await createMemory(tokenA, { kind: "learning_context", content: "候选内容", candidate: true });

  const hidden = await app.inject(req(tokenA, "GET", "/companion/memory"));
  assert.equal(
    hidden.json().items.some((item: { memoryItemId: string }) => item.memoryItemId === candidateId),
    false,
    "默认列表不含候选记忆",
  );

  const withCandidates = await app.inject(req(tokenA, "GET", "/companion/memory?includeCandidates=true"));
  assert.equal(
    withCandidates.json().items.some((item: { memoryItemId: string }) => item.memoryItemId === candidateId),
    true,
  );

  // 候选交付是怎么到用户眼前的：worker 写一行 `memory_candidate`，桌面按
  // **payload_ref.kind='memory_item'**（不是 kind 那一列）出文案、把卡片亮成"待处理"。
  // 确认必须给它结账（doc 34 L42）：`acted` 这个终态在整库里此前 0 行。
  //
  // 夹具与断言都走**这条已经用着的连接 + `set_config`**，和生产 `deliver()` 同一形状。
  // 别在这里另开第二条 postgres.js 池：那样会让这份文件挂起，而且挂得毫无现场可查
  // （进程在 pg_stat_activity 里完全不存在），第一反应很容易误判成"并行会话在抢锁"。
  const seqRow = await sql`
    SELECT COALESCE(MAX(inbox_sequence), 0) + 1 AS n FROM assistant_deliveries
    WHERE workspace_id = ${workspaceId} AND user_id = ${userA}`;
  const seq = Number(seqRow[0]?.n ?? 1);
  const ownDeliveryId = randomUUID();
  const otherDeliveryId = randomUUID();
  const seedDelivery = (id: string, memoryItemId: string, offset: number) => sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true),
                        set_config('app.user_id', ${userA}, true)`;
    await tx`
      INSERT INTO assistant_deliveries
        (id, assistant_session_id, workspace_id, user_id, inbox_sequence, dedupe_key,
         state, kind, payload_ref, display_lease, expires_at)
      VALUES (${id}, NULL, ${workspaceId}, ${userA}, ${seq + offset}, ${`l42-${id}`},
              'displayed', 'memory_candidate',
              ${sql.json({ kind: "memory_item", memoryItemId, contentPreview: "候选内容" })},
              ${sql.json({ leaseToken: "lease-l42", deviceSessionId: "dev-l42",
                expiresAt: new Date(Date.now() + 600_000).toISOString() })},
              now() + interval '30 days')
    `;
  });
  const readDelivery = (id: string) => sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true),
                        set_config('app.user_id', ${userA}, true)`;
    return await tx`SELECT state, display_lease FROM assistant_deliveries WHERE id = ${id}`;
  });
  await seedDelivery(ownDeliveryId, candidateId, 0);
  // 第二条指向**别的**记忆：它是"只结这一条"的对照。没有它，谓词写成"这个人所有候选交付"
  // 也能让断言全绿（这一族在本会话里已经抓过不止一次）。
  await seedDelivery(otherDeliveryId, randomUUID(), 1);

  const confirmed = await app.inject(req(tokenA, "POST", `/companion/memory/${candidateId}/confirm`));
  assert.equal(confirmed.statusCode, 200);
  const afterConfirm = await app.inject(req(tokenA, "GET", "/companion/memory"));
  assert.equal(
    afterConfirm.json().items.some((item: { memoryItemId: string }) => item.memoryItemId === candidateId),
    true,
    "确认后必须出现在默认列表",
  );

  const [own] = await readDelivery(ownDeliveryId);
  assert.equal(own?.state, "acted", "确认之后那条候选交付必须结账成 acted");
  assert.equal(own?.display_lease, null, "终态不留展示租约（与设备 ACK 同一形状）");
  const [other] = await readDelivery(otherDeliveryId);
  assert.equal(other?.state, "displayed", "只许结掉指向这条记忆的那一份");

  // 已终态的不被后来的忽略改写：确认在前、忽略在后，用户第一次表态就算数。
  const ignored = await app.inject(req(tokenA, "POST", `/companion/memory/${candidateId}/dismiss`));
  assert.equal(ignored.statusCode, 200);
  const [afterDismiss] = await readDelivery(ownDeliveryId);
  assert.equal(afterDismiss?.state, "acted", "已经 acted 的交付不能被随后的忽略改写");
});

test("pin / unpin / archive / restore / dismiss 状态迁移都可往返", async () => {
  const id = await createMemory(tokenA, { kind: "interaction_note", content: "状态迁移" });
  const step = async (action: string, expected = 200) => {
    const response = await app.inject(req(tokenA, "POST", `/companion/memory/${id}/${action}`));
    assert.equal(response.statusCode, expected, `${action} 期望 ${expected}`);
    return response;
  };

  assert.equal((await step("pin")).json().pinned, true);
  assert.equal((await step("unpin")).json().pinned, false);
  await step("archive");

  const withoutArchived = await app.inject(req(tokenA, "GET", "/companion/memory"));
  assert.equal(
    withoutArchived.json().items.some((item: { memoryItemId: string }) => item.memoryItemId === id),
    false,
    "归档后默认列表不含该记忆",
  );
  const withArchived = await app.inject(req(tokenA, "GET", "/companion/memory?includeArchived=true"));
  assert.equal(withArchived.json().items.some((item: { memoryItemId: string }) => item.memoryItemId === id), true);

  await step("restore");
  assert.equal(
    (await app.inject(req(tokenA, "GET", "/companion/memory"))).json().items
      .some((item: { memoryItemId: string }) => item.memoryItemId === id),
    true,
    "restore 后回到默认列表",
  );
  await step("dismiss");
});

test("记忆修订：来源不变、历史可读、旧 revision 提交会冲突", async () => {
  const id = await createMemory(tokenA, { kind: "goal", content: "原始内容", candidate: false });
  const before = (await app.inject(req(tokenA, "GET", "/companion/memory")))
    .json().items.find((item: { memoryItemId: string }) => item.memoryItemId === id);
  const response = await app.inject(req(tokenA, "POST", `/companion/memory/${id}/correct`, {
    content: "修正后的内容",
    expectedRevision: before.revision,
    reason: "用户澄清",
  }));
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().content, "修正后的内容");
  assert.equal(response.json().memoryItemId, id, "修订保持稳定 ID");
  assert.equal(response.json().revision, before.revision + 1);
  assert.equal(response.json().candidate, false, "用户已明确修正，不应再次排进候选确认");
  assert.equal(response.json().authorType, "user");
  assert.equal(response.json().sourceEventId, before.sourceEventId, "原始来源引用保持不变");

  const history = await app.inject(req(tokenA, "GET", `/companion/memory/${id}/revisions`));
  assert.equal(history.statusCode, 200);
  assert.equal(history.json().items.length, 1);
  assert.equal(history.json().items[0].content, "原始内容");
  assert.equal(history.json().items[0].revision, before.revision);

  const stale = await app.inject(req(tokenA, "POST", `/companion/memory/${id}/correct`, {
    content: "旧页面覆盖",
    expectedRevision: before.revision,
  }));
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().currentRevision, before.revision + 1);
  assert.equal(
    (await app.inject(req(tokenA, "GET", "/companion/memory"))).json().items
      .find((item: { memoryItemId: string }) => item.memoryItemId === id).content,
    "修正后的内容",
  );
});

test("列表筛选：kind 与 q 生效，非法查询参数 → 400", async () => {
  const filtered = await app.inject(req(tokenA, "GET", "/companion/memory?kind=preference"));
  assert.equal(filtered.statusCode, 200);
  assert.equal(
    filtered.json().items.every((item: { kind: string }) => item.kind === "preference"),
    true,
  );

  const searched = await app.inject(req(tokenA, "GET", "/companion/memory?q=安静"));
  assert.equal(searched.statusCode, 200);
  assert.ok(searched.json().items.length >= 1, "关键词应命中已创建的记忆");

  const badQuery = await app.inject(req(tokenA, "GET", "/companion/memory?kind=not_a_kind"));
  assert.equal(badQuery.statusCode, 400);
});

test("删除：单条 204 → 再删同一 id 404；清空返回 200 + deletedCount 且幂等", async () => {
  const id = await createMemory(tokenA, { kind: "episodic", content: "将被删除" });
  assert.equal((await app.inject(req(tokenA, "DELETE", `/companion/memory/${id}`))).statusCode, 204);
  assert.equal((await app.inject(req(tokenA, "DELETE", `/companion/memory/${id}`))).statusCode, 404);

  const cleared = await app.inject(req(tokenA, "DELETE", "/companion/memory"));
  assert.equal(cleared.statusCode, 200);
  assert.equal(typeof cleared.json().deletedCount, "number");
  assert.ok(cleared.json().deletedCount >= 1, "清空必须报告删除条数");
  assert.equal((await app.inject(req(tokenA, "DELETE", "/companion/memory"))).json().deletedCount, 0, "清空是幂等的");
  assert.deepEqual((await app.inject(req(tokenA, "GET", "/companion/memory"))).json().items, []);
});

test("跨用户隔离：对别人的 memoryId 一律 404（不泄露存在性），且原主人数据完好", async () => {
  const mine = await createMemory(tokenA, { kind: "goal", content: "A 的私有记忆" });

  for (const [method, url] of [
    ["POST", `/companion/memory/${mine}/confirm`],
    ["POST", `/companion/memory/${mine}/pin`],
    ["POST", `/companion/memory/${mine}/correct`],
    ["GET", `/companion/memory/${mine}/revisions`],
    ["DELETE", `/companion/memory/${mine}`],
  ] as const) {
    const response = await app.inject(req(
      tokenB,
      method,
      url,
      method === "POST" && url.endsWith("/correct")
        ? { content: "越权改写", expectedRevision: 1 }
        : undefined,
    ));
    assert.equal(response.statusCode, 404, `${method} ${url} 必须对他人资源返回 404`);
  }

  const stillThere = await app.inject(req(tokenA, "GET", "/companion/memory"));
  const item = stillThere.json().items.find((entry: { memoryItemId: string }) => entry.memoryItemId === mine);
  assert.equal(item?.content, "A 的私有记忆", "越权请求不得修改或删除原主人的记忆");

  const bList = await app.inject(req(tokenB, "GET", "/companion/memory"));
  assert.deepEqual(bList.json().items, [], "B 的列表里不得出现 A 的记忆");
});

test("导出与星图只包含自己的数据，且星图排除候选", async () => {
  const confirmedId = await createMemory(tokenA, { kind: "goal", content: "已确认条目", candidate: false });
  const candidateId = await createMemory(tokenA, { kind: "goal", content: "候选条目", candidate: true });

  const exported = await app.inject(req(tokenA, "GET", "/companion/memory/export"));
  assert.equal(exported.statusCode, 200);

  const starMap = await app.inject(req(tokenA, "GET", "/companion/memory/star-map"));
  assert.equal(starMap.statusCode, 200);
  const nodeIds = (starMap.json().nodes as Array<{ memoryId: string }>).map((node) => node.memoryId);
  assert.equal(nodeIds.includes(confirmedId), true);
  assert.equal(nodeIds.includes(candidateId), false, "候选记忆不得进入星图");

  const bStarMap = await app.inject(req(tokenB, "GET", "/companion/memory/star-map"));
  assert.deepEqual(bStarMap.json().nodes, [], "星图不得跨用户泄漏");
});

test('回收区带真实期限、跨用户隔离，恢复后从回收区移除', async () => {
  const id = await createMemory(tokenA, { content: '回收区测试记忆' });
  const removed = await app.inject(req(tokenA, 'DELETE', '/companion/memory/' + id));
  assert.equal(removed.statusCode, 204, removed.body);
  const recycled = await app.inject(req(tokenA, 'GET', '/companion/memory/recycle'));
  assert.equal(recycled.statusCode, 200, recycled.body);
  assert.equal(recycled.headers['cache-control'], 'no-store');
  const item = recycled.json().items.find((item: { id: string }) => item.id === id);
  assert.equal(item.content, '回收区测试记忆');
  assert.equal(Date.parse(item.purgeAfter) - Date.parse(item.deletedAt), 30 * 24 * 60 * 60 * 1000);
  const other = await app.inject(req(tokenB, 'GET', '/companion/memory/recycle'));
  assert.equal(other.json().items.some((item: { id: string }) => item.id === id), false);
  const restored = await app.inject(req(tokenA, 'POST', '/companion/memory/' + id + '/restore-deleted'));
  assert.equal(restored.statusCode, 204, restored.body);
  const after = await app.inject(req(tokenA, 'GET', '/companion/memory/recycle'));
  assert.equal(after.json().items.some((item: { id: string }) => item.id === id), false);
});

test('清空记忆同样进入 30 天回收区', async () => {
  const id = await createMemory(tokenA, { content: '清空后仍可恢复' });
  const cleared = await app.inject(req(tokenA, 'DELETE', '/companion/memory'));
  assert.equal(cleared.statusCode, 200, cleared.body);
  const recycled = await app.inject(req(tokenA, 'GET', '/companion/memory/recycle'));
  const item = recycled.json().items.find((item: { id: string }) => item.id === id);
  assert.ok(item);
  assert.equal(Date.parse(item.purgeAfter) - Date.parse(item.deletedAt), 30 * 24 * 60 * 60 * 1000);
});

test('关联目标可以超出最近 200 条，且不能读取另一用户的目标', async () => {
  const id = await createMemory(tokenA, { content: '很早的关联记忆' });
  await sql`UPDATE assistant_memory_items SET updated_at='2020-01-01' WHERE id=${id}`;
  await sql`INSERT INTO assistant_memory_items (workspace_id,user_id,kind,content,scope,importance,confidence,user_stated,user_confirmed,candidate,author_type)
    SELECT ${workspaceId},${userA},'preference','近期记忆 ' || number,'workspace',0.5,1,true,true,false,'user' FROM generate_series(1,201) AS number`;
  const recent = await app.inject(req(tokenA, 'GET', '/companion/memory'));
  assert.equal(recent.json().items.some((item: { memoryItemId: string }) => item.memoryItemId === id), false);
  const focused = await app.inject(req(tokenA, 'GET', '/companion/memory?focusMemoryId=' + id));
  assert.equal(focused.statusCode, 200, focused.body);
  assert.equal(focused.json().items.length, 200);
  assert.equal(focused.json().items.some((item: { memoryItemId: string }) => item.memoryItemId === id), true);
  const other = await app.inject(req(tokenB, 'GET', '/companion/memory?focusMemoryId=' + id));
  assert.equal(other.json().items.some((item: { memoryItemId: string }) => item.memoryItemId === id), false);
});

test('三条冲突逐项解决后只有保留项存活，且解除冲突组', async () => {
  const ids = await Promise.all([1,2,3].map(index => createMemory(tokenA, { content: '冲突项 ' + index })));
  const group = randomUUID();
  await sql`UPDATE assistant_memory_items SET conflict_group=${group} WHERE id IN (${ids[0]},${ids[1]},${ids[2]})`;
  for (const removeId of ids.slice(1)) {
    const result = await app.inject(req(tokenA, 'POST', `/companion/memory/${ids[0]}/resolve-conflict`, { removeId }));
    assert.equal(result.statusCode, 200, result.body);
  }
  const rows = await sql`SELECT id,deleted_at,conflict_group FROM assistant_memory_items WHERE id IN (${ids[0]},${ids[1]},${ids[2]})`;
  assert.equal(rows.filter(row => row.deleted_at === null).length, 1);
  assert.equal(rows.find(row => row.id === ids[0])?.conflict_group, null);
});

test('来源归档遮蔽真实引用日记与摘录，同一天另一用户的内容保持可读，迟到发布不能复活', async () => {
  const sourceId = randomUUID(), diaryA = randomUUID(), diaryB = randomUUID(), excerptA = randomUUID(), excerptB = randomUUID();
  const date = '2026-07-11';
  await sql`INSERT INTO sources (id,workspace_id,type,title,status,created_by)
    VALUES (${sourceId},${workspaceId},'url','引用资料','ready',${userA})`;
  await sql`INSERT INTO companion_daily_summaries (id,workspace_id,user_id,date,timezone,facts,summary,source_event_ids)
    VALUES (${diaryA},${workspaceId},${userA},${date},'Asia/Shanghai','[]','A 的引用日记',ARRAY[${sourceId}]),
           (${diaryB},${workspaceId},${userB},${date},'Asia/Shanghai','[]','B 的独立日记',ARRAY[]::text[])`;
  await sql`INSERT INTO companion_discovery_entries (id,workspace_id,user_id,kind,source,source_id,author,body)
    VALUES (${excerptA},${workspaceId},${userA},'diary_excerpt','diary',${date},'assistant','A 的摘录'),
           (${excerptB},${workspaceId},${userB},'diary_excerpt','diary',${date},'assistant','B 的摘录')`;
  await sql`UPDATE sources SET status='archived' WHERE id=${sourceId}`;
  const diaries = await sql`SELECT id,deleted_at,hidden_at,delete_reason FROM companion_daily_summaries WHERE id IN (${diaryA},${diaryB})`;
  assert.ok(diaries.find(row => row.id === diaryA)?.deleted_at);
  assert.ok(diaries.find(row => row.id === diaryA)?.hidden_at);
  assert.equal(diaries.find(row => row.id === diaryA)?.delete_reason, 'revoked_source');
  assert.equal(diaries.find(row => row.id === diaryB)?.deleted_at, null);
  const excerpts = await sql`SELECT id,masked FROM companion_discovery_entries WHERE id IN (${excerptA},${excerptB})`;
  assert.equal(excerpts.find(row => row.id === excerptA)?.masked, true);
  assert.equal(excerpts.find(row => row.id === excerptB)?.masked, false);
  await assert.rejects(sql`UPDATE companion_daily_summaries SET deleted_at=NULL,status='generated',summary='迟到任务' WHERE id=${diaryA}`, /must not be republished/);
});

test('已被替代的伴星判断可以修订，旧认识状态与四种作者词表真实进入版本表', async () => {
  const id = randomUUID();
  await sql`INSERT INTO assistant_memory_items (id,workspace_id,user_id,kind,content,scope,user_stated,source_type,author_type,source_speaker,source_basis,epistemic_status)
    VALUES (${id},${workspaceId},${userA},'preference','已经被替代的判断','workspace',false,'model_inferred','companion','companion','companion_interpretation','superseded')`;
  await sql`UPDATE assistant_memory_items SET content='新判断',epistemic_status='tentative' WHERE id=${id}`;
  const revisions = await sql`SELECT revision,author_type,source_speaker,source_basis,epistemic_status,content FROM assistant_memory_item_revisions WHERE memory_id=${id}`;
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].author_type, 'companion');
  assert.equal(revisions[0].source_speaker, 'companion');
  assert.equal(revisions[0].source_basis, 'companion_interpretation');
  assert.equal(revisions[0].epistemic_status, 'superseded');
  assert.equal(revisions[0].content, '已经被替代的判断');
  const current = await sql`SELECT revision,content FROM assistant_memory_items WHERE id=${id}`;
  assert.equal(current[0].revision, revisions[0].revision + 1);
});

/**
 * 账号级（跨空间）范围守卫的**真实 HTTP 回执**（42 阶段 1 E）。
 *
 * 为什么单测不够：单测钉的是"服务抛了什么、路由怎么映射"，而这一层要证明的是**线上
 * 契约**——用户真的 POST 过去时拿到 422、稳定的 error/reason、以及一句能照着做的中文；
 * 而同一个内容改成 workspace 保存就成功。同样要证明拒绝不是"改成成功"，也不是"悄悄
 * 降级成空间内"：被拒的修订之后，正文、修订号与只追加历史逐字不变。
 *
 * 走真实 session + `app.inject` 打实际路由；不 mock 路由，也不直接调映射函数拿一个
 * 假回执来比较。文案取自共享模块（`@ailearn/shared/companion-memory-scope`）——那是
 * API、伴星工具与提案链共用的**同一句**，比对着它断言才能守住"入口之间说的是同一句话"。
 */
test('账号级范围守卫：一般 global 偏好能存，本地内容/条件回 422 且记忆与历史不变', async () => {
  // 正向对照：一般偏好确实能作为账号级保存。
  const created = await app.inject(req(tokenA, 'POST', '/companion/memory', {
    kind: 'preference',
    content: '习惯晚上九点之后写笔记，白天只做采集',
    scope: 'global',
  }));
  assert.equal(created.statusCode, 201, `一般 global 偏好没能保存：${created.body}`);
  assert.equal(created.json().scope, 'global');
  const accountId = created.json().memoryItemId as string;
  // 这条用户名当前的全部记忆 id，是后面"被拒的写入一条都不该落库"的比对基线。
  // 用集合而不是绝对条数：本文件前面那些用例造过别的记忆，按总数比会假红。
  const memoryIds = async (): Promise<string[]> =>
    (await sql`SELECT id FROM assistant_memory_items
       WHERE workspace_id=${workspaceId} AND user_id=${userA} AND deleted_at IS NULL
       ORDER BY id`).map((row: Record<string, unknown>) => String(row.id));
  const baselineIds = await memoryIds();

  // 负向：四种本地写法都回 422 + 稳定 error/reason + 共享文案。
  const rejected: Array<{ label: string; body: Record<string, unknown>; reason: string }> = [
    { label: '科目', body: { kind: 'preference', content: '正在学数据库索引优化', scope: 'global' }, reason: 'content_workspace_bound' },
    { label: '当前书房材料', body: { kind: 'preference', content: '讲这篇笔记时先给一句结论', scope: 'global' }, reason: 'content_workspace_bound' },
    { label: '当前书房', body: { kind: 'preference', content: '这个书房的节奏比别的快', scope: 'global' }, reason: 'content_workspace_bound' },
    { label: '适用条件', body: { kind: 'preference', content: '提醒我先看反例', appliesWhen: '复习这门课时', scope: 'global' }, reason: 'applies_when_workspace_bound' },
    { label: '非偏好种类', body: { kind: 'goal', content: '习惯晚上九点之后写笔记', scope: 'global' }, reason: 'kind_not_preference' },
  ];
  for (const attempt of rejected) {
    const response = await app.inject(req(tokenA, 'POST', '/companion/memory', attempt.body));
    assert.equal(response.statusCode, 422, `${attempt.label}：本地内容被当成账号级接受了（${response.statusCode}）`);
    assert.equal(response.json().error, 'memory_global_scope_rejected', `${attempt.label}：错误码不稳定`);
    assert.equal(response.json().reason, attempt.reason, `${attempt.label}：理由与判据对不上`);
    assert.equal(
      response.json().message,
      accountPreferenceRejectionMessage(attempt.reason as AccountPreferenceWriteRejection),
      `${attempt.label}：文案不是共享层那一句`,
    );
  }

  // 被拒的那些不能"退一步保存成空间内记忆"，也不能换一条新行落库：一条都不该多出来。
  assert.deepEqual(await memoryIds(), baselineIds, '被拒的写入仍然被保存了（可能悄悄降级成了别的范围）');

  // 同样的本地内容，存成 workspace 就该成功——守卫只管账号级。
  const local = await app.inject(req(tokenA, 'POST', '/companion/memory', {
    kind: 'goal',
    content: '正在学数据库索引优化',
    scope: 'workspace',
  }));
  assert.equal(local.statusCode, 201, `空间内记忆被账号级守卫拦掉了：${local.body}`);
  assert.equal(local.json().scope, 'workspace');

  // 修订链路：先做一次合法修订，让基线是"修订之后"的真实库状态。
  const beforeRow = (await app.inject(req(tokenA, 'GET', '/companion/memory'))).json().items
    .find((item: { memoryItemId: string }) => item.memoryItemId === accountId);
  const legal = await app.inject(req(tokenA, 'POST', `/companion/memory/${accountId}/correct`, {
    content: '习惯晚上九点之后写笔记，白天只做采集，晚上十点前不想被打断',
    expectedRevision: beforeRow.revision,
  }));
  assert.equal(legal.statusCode, 200, `合法的账号级修订被拦了：${legal.body}`);
  const legalRevision = legal.json().revision as number;
  const historyBefore = await sql`SELECT revision FROM assistant_memory_item_revisions
    WHERE memory_id=${accountId} ORDER BY revision`;

  for (const attempt of [
    { label: '科目', body: { content: '下个月要考日语N3' }, reason: 'content_workspace_bound' },
    { label: '当前书房材料', body: { content: '先把这篇笔记讲完' }, reason: 'content_workspace_bound' },
    { label: '适用条件', body: { content: '提醒我先看反例', appliesWhen: '复习这门课时' }, reason: 'applies_when_workspace_bound' },
  ]) {
    const response = await app.inject(req(tokenA, 'POST', `/companion/memory/${accountId}/correct`, {
      ...attempt.body,
      expectedRevision: legalRevision,
    }));
    assert.equal(response.statusCode, 422, `${attempt.label}：修订把本地材料写进了账号级规则（${response.statusCode}）`);
    assert.equal(response.json().error, 'memory_global_scope_rejected');
    assert.equal(response.json().reason, attempt.reason);
    assert.equal(response.json().message, accountPreferenceRejectionMessage(attempt.reason as AccountPreferenceWriteRejection));
  }

  // 拒绝之后：正文、修订号、只追加历史与合法修订之后逐字相同。
  const afterRow = (await app.inject(req(tokenA, 'GET', '/companion/memory'))).json().items
    .find((item: { memoryItemId: string }) => item.memoryItemId === accountId);
  assert.equal(afterRow.content, legal.json().content, '被拒的修订仍然改了正文');
  assert.equal(afterRow.scope, 'global', '被拒的修订把账号级规则降级成了别的范围');
  assert.equal(afterRow.revision, legalRevision, '被拒的修订推进了 CAS 修订号');
  const historyAfter = await sql`SELECT revision FROM assistant_memory_item_revisions
    WHERE memory_id=${accountId} ORDER BY revision`;
  assert.deepEqual(historyAfter.map((row: Record<string, unknown>) => row.revision),
    historyBefore.map((row: Record<string, unknown>) => row.revision),
    '被拒的修订仍然写进了只追加历史表');

  // 收尾：把本例造出来的记忆删掉，别留给后面的用例（teardown 也会兜底）。
  for (const id of [accountId, local.json().memoryItemId as string]) {
    const removed = await app.inject(req(tokenA, 'DELETE', `/companion/memory/${id}`));
    assert.equal(removed.statusCode, 204, removed.body);
  }
});
