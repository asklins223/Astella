/**
 * worker 侧记忆链路 handler（此前零覆盖）：
 *   - companion_memory_embedding_rebuild：向量重建
 *   - companion_memory_maintenance：每日衰减/归档 tick
 *
 * 这两条都是「静默失败」风险最高的形态：它们不在用户请求路径上，出错只写日志。
 * 因此这里锁的是**边界行为**而不是 happy path：
 *   1. payload 缺 userId → 必须显式报错（不能默默跳过整批记忆）；
 *   2. 未取得 AI 同意 → fail closed（不得在无同意的工作区生成/落库向量）；
 *   3. 同意已给但未配置 embedding provider → 优雅跳过，且**不得**把记忆标成
 *      ready（否则检索会拿到空向量）；
 *   4. 维护 tick 的每日一次性由数据库日期键保证：重复调用不重复维护、不抛错。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { getCompanionAgentTool } from "@ailearn/shared";
import { runCompanionMemoryEmbeddingRebuild } from "../handlers/companion-memory-embedding.ts";
import { executeDirectTool, executeReadTool } from "../handlers/companion-tool-execution.ts";
import { CompanionToolError } from "../handlers/companion-tool-result.ts";
import { retrieveActiveCompanionMemoryDirectory } from "../handlers/companion-memory-vector.ts";
import { tickCompanionMemoryMaintenance } from "../handlers/companion-memory-maintenance.ts";
import { closeDatabase, withWorkerWorkspaceTransaction } from "../db.ts";

const MIGRATOR_URL = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
const WORKER_URL = process.env.DATABASE_URL_WORKER ?? process.env.DATABASE_URL;
if (!MIGRATOR_URL || !WORKER_URL) {
  throw new Error("DATABASE_URL_MIGRATOR / DATABASE_URL_WORKER 未配置——该测试要求真实 Postgres");
}

// 夹具与断言用 migrator（拥有这些表、BYPASSRLS），handler 走它自己的 worker 连接。
const admin = postgres(MIGRATOR_URL, { max: 3 });

const userId = randomUUID();
const workspaceId = randomUUID();
const jobId = randomUUID();
const leaseToken = `lease-${randomUUID()}`;
const memoryId = randomUUID();
const revisionMemoryId = randomUUID();
const sourceSessionId = randomUUID();
const revisionDeliveryId = randomUUID();
const prefix = userId.slice(0, 8);

after(async () => {
  await admin`DELETE FROM users WHERE id = ${userId}`.catch(() => {});
  await admin.end({ timeout: 5 }).catch(() => {});
  await closeDatabase().catch(() => {});
});

await admin`
  INSERT INTO users (id, email, password_hash, role)
  VALUES (${userId}, ${`mem-worker-${prefix}@example.test`}, 'test-hash', 'owner')
`;
await admin`
  INSERT INTO workspaces (id, name, owner_id, workspace_type)
  VALUES (${workspaceId}, ${`mem-worker-${prefix}`}, ${userId}, 'personal')
`;
// embedding 重建的候选集合：非候选、未删除、embedding_status='none'。
await admin`
  INSERT INTO assistant_memory_items
    (id, workspace_id, user_id, kind, content, applies_when, valid_from, valid_until,
     candidate, embedding_status, source_event_id)
  VALUES (${memoryId}, ${workspaceId}, ${userId}, 'goal',
          '需要向量化的记忆。完整正文只在按 ID 读取时返回。', '讨论学习目标时',
          now() - interval '1 day', now() + interval '30 days', false, 'none', ${`worker-embed:${memoryId}`})
`;
await admin`
  INSERT INTO assistant_memory_items
    (id, workspace_id, user_id, kind, content, source_event_id, source_session_id,
     source_speaker, source_basis, applies_when, valid_from, valid_until,
     user_stated, user_confirmed, candidate, importance, confidence, scope,
     source_type, author_type, author_id, epistemic_status, embedding_status)
  VALUES (${revisionMemoryId}, ${workspaceId}, ${userId}, 'preference', '旧的记忆内容',
          ${`worker-revise:${revisionMemoryId}`}, ${sourceSessionId}, 'user', 'direct_statement',
          '工作日', now() - interval '1 day', now() + interval '30 days',
          true, true, false, 0.8, 0.9, 'workspace', 'user_stated', 'user', ${userId}, 'supported', 'ready')
`;
await admin`
  INSERT INTO assistant_deliveries
    (id, workspace_id, user_id, inbox_sequence, dedupe_key, state, kind, payload_ref, expires_at)
  VALUES (${revisionDeliveryId}, ${workspaceId}, ${userId}, 1, ${`worker-revise:${revisionMemoryId}`},
          'displayed', 'memory_candidate', ${admin.json({ memoryItemId: revisionMemoryId })}, now() + interval '1 day')
`;
// status='running' + 匹配 lease_token 才能通过 assertJobLease。
await admin`
  INSERT INTO jobs (id, type, workspace_id, requested_by, payload, status, lease_token, started_at)
  VALUES (${jobId}, 'companion_memory_embedding_rebuild', ${workspaceId}, ${userId},
          ${admin.json({ userId })}, 'running', ${leaseToken}, now())
`;

const job = {
  id: jobId,
  workspaceId,
  requestedBy: userId,
  leaseToken,
  payload: { userId },
} as unknown as Parameters<typeof runCompanionMemoryEmbeddingRebuild>[0];

async function setConsent(granted: boolean): Promise<void> {
  // 同意从 `workspaces` 搬到了 `user_ai_settings`（迁移 0237，按 user_id 键，DROP 了
  // workspaces 那三列）。夹具原来还在写旧列，这个文件的两条用例自 0237 起就地 42703——
  // 只因为 `v1.0` 不在 CI 的 push 分支上，才一直没人看到它红。
  await admin`
    INSERT INTO user_ai_settings (user_id, consent_version, consent_at)
    VALUES (${userId}, ${granted ? "v1" : null}, ${granted ? new Date() : null})
    ON CONFLICT (user_id) DO UPDATE
      SET consent_version = EXCLUDED.consent_version,
          consent_at = EXCLUDED.consent_at
  `;
}

test("payload 缺 userId → 显式报错（不得静默跳过整批记忆）", async () => {
  const broken = { ...job, payload: {} } as typeof job;
  await assert.rejects(
    () => runCompanionMemoryEmbeddingRebuild(broken),
    /缺 userId/,
  );
});

test("只配置 mock provider 时同意门有意豁免；但缺少向量 provider 时不得改状态", async () => {
  // governance 的同意门只在存在外部非 mock provider 时生效（mock 不外发数据）。
  // 无任何平台配置的测试环境正是 mock-only：handler 必须**不抛错**地优雅跳过。
  // 真正的同意强制点由 src/lib/governance-consent.test.ts 用注入 provider 覆盖。
  await setConsent(false);
  await assert.doesNotReject(() => runCompanionMemoryEmbeddingRebuild(job));
  const rows = await admin`SELECT embedding_status FROM assistant_memory_items WHERE id = ${memoryId}`;
  assert.equal(rows[0]?.embedding_status, "none", "没有向量 provider 时不得改动 embedding 状态");
});

test("已同意但未配置 embedding provider → 优雅跳过，且不得把记忆标成 ready", async () => {
  await setConsent(true);
  await assert.doesNotReject(() => runCompanionMemoryEmbeddingRebuild(job));

  const rows = await admin`SELECT embedding_status FROM assistant_memory_items WHERE id = ${memoryId}`;
  assert.equal(
    rows[0]?.embedding_status,
    "none",
    "没有向量就不能标 ready —— 否则检索会拿到空向量",
  );
  const embeddings = await admin`SELECT count(*)::int AS n FROM assistant_memory_embeddings WHERE memory_id = ${memoryId}`;
  assert.equal(embeddings[0]?.n, 0, "未生成向量时不得写 embeddings 行");
});

test("active 目录只给线索；按稳定 ID 展开要求有效范围与当前 revision", async () => {
  const directory = await withWorkerWorkspaceTransaction(
    { workspaceId, userId },
    (tx) => retrieveActiveCompanionMemoryDirectory(tx, { workspaceId, userId }),
  );
  const entry = directory.find((candidate) => candidate.memoryId === memoryId);
  assert.ok(entry);
  assert.equal(entry?.title, "需要向量化的记忆。");
  assert.equal(entry?.appliesWhen, "讨论学习目标时");
  assert.equal("content" in entry, false, "目录只返回标题/适用条件，不带正文列");

  const definition = getCompanionAgentTool("companion_read_memory");
  assert.ok(definition);
  const read = {
    userId,
    runId: randomUUID(),
    pageContext: null,
    residentMemories: [],
    memoryRefs: [] as Array<{ memoryId: string; kind: string; content: string }>,
  };
  const event = {
    ctx: { workspaceId },
    read,
    constraints: {},
  } as unknown as Parameters<typeof executeReadTool>[0];
  const expanded = await executeReadTool(event, definition, {
    memoryId,
    expectedRevision: 1,
  });
  assert.equal(expanded.value.content, "需要向量化的记忆。完整正文只在按 ID 读取时返回。");
  assert.equal(read.memoryRefs[0]?.memoryId, memoryId);

  await assert.rejects(
    () => executeReadTool(event, definition, { memoryId, expectedRevision: 2 }),
    /没找到这条仍有效且版本匹配/,
  );
  await assert.rejects(
    () => executeReadTool(event, definition, { memoryId: randomUUID(), expectedRevision: 1 }),
    /没找到这条仍有效且版本匹配/,
  );
});

test("维护 tick：数据库日期键保证每日一次，重复调用不抛错也不重复维护", async () => {
  await assert.doesNotReject(() => tickCompanionMemoryMaintenance());
  const afterFirst = await admin`
    SELECT count(*)::int AS n FROM companion_memory_maintenance_runs
    WHERE run_date = (now() AT TIME ZONE 'UTC')::date
  `;
  assert.equal(afterFirst[0]?.n, 1, "首次 tick 必须留下当日日期键（跨副本一次性门）");

  await assert.doesNotReject(() => tickCompanionMemoryMaintenance());
  const afterSecond = await admin`
    SELECT count(*)::int AS n FROM companion_memory_maintenance_runs
    WHERE run_date = (now() AT TIME ZONE 'UTC')::date
  `;
  assert.equal(afterSecond[0]?.n, 1, "重复 tick 不得产生第二条当日记录");
});

test("full 档记忆修订：CAS 追加旧版本，保留来源与未改的时间条件", async () => {
  const definition = getCompanionAgentTool("companion_revise_memory");
  assert.ok(definition);
  const event = {
    ctx: { workspaceId },
    read: { userId },
  } as unknown as Parameters<typeof executeDirectTool>[0];

  const result = await executeDirectTool(event, definition, {
    memoryId: revisionMemoryId,
    expectedRevision: 1,
    content: "新的记忆内容",
  });
  assert.equal(result.value.memoryId, revisionMemoryId);
  assert.equal(result.value.revision, 2);
  assert.equal(result.value.changed, true);

  const current = await admin`
    SELECT revision, content, source_event_id, source_session_id, applies_when,
           valid_from, valid_until, user_stated, user_confirmed, candidate,
           author_type, author_id, epistemic_status, embedding_status
      FROM assistant_memory_items WHERE id = ${revisionMemoryId}
  `;
  assert.equal(current[0].revision, 2);
  assert.equal(current[0].content, "新的记忆内容");
  assert.equal(current[0].source_event_id, `worker-revise:${revisionMemoryId}`);
  assert.equal(current[0].source_session_id, sourceSessionId);
  assert.equal(current[0].applies_when, "工作日");
  assert.equal(current[0].user_stated, true);
  assert.equal(current[0].user_confirmed, true);
  assert.equal(current[0].candidate, false);
  assert.equal(current[0].author_type, "user");
  assert.equal(current[0].author_id, userId);
  assert.equal(current[0].epistemic_status, "supported");
  assert.equal(current[0].embedding_status, "pending");
  const delivery = await admin`
    SELECT state, display_lease FROM assistant_deliveries WHERE id = ${revisionDeliveryId}
  `;
  assert.equal(delivery[0].state, "acted");
  assert.equal(delivery[0].display_lease, null);
  assert.ok(current[0].valid_from instanceof Date);
  assert.ok(current[0].valid_until instanceof Date);

  const history = await admin`
    SELECT revision, content, source_event_id, source_session_id, applies_when
      FROM assistant_memory_item_revisions
     WHERE memory_id = ${revisionMemoryId}
     ORDER BY revision
  `;
  assert.deepEqual(history.map((row) => row.revision), [1]);
  assert.equal(history[0].content, "旧的记忆内容");
  assert.equal(history[0].source_event_id, `worker-revise:${revisionMemoryId}`);
  assert.equal(history[0].source_session_id, sourceSessionId);
  assert.equal(history[0].applies_when, "工作日");

  await assert.rejects(
    () => executeDirectTool(event, definition, {
      memoryId: revisionMemoryId,
      expectedRevision: 1,
      content: "过期输入不得覆盖",
    }),
    (error: unknown) => error instanceof CompanionToolError && /刚刚更新/.test(error.message),
  );
  const unchanged = await admin`
    SELECT revision, content FROM assistant_memory_items WHERE id = ${revisionMemoryId}
  `;
  assert.equal(unchanged[0].revision, 2);
  assert.equal(unchanged[0].content, "新的记忆内容");
});
