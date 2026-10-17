/**
 * 伴星记忆 embedding 全链路集成测试（调度器 → 作业 → 向量落库 → 向量召回）。
 *
 * 起因（2026-10 实测）：补偿调度器把 `jobs.created_at` 写错列名（真实列是
 * `scheduled_at`），整条 INSERT 每 30 分钟抛错一次、只被 warn 咽掉，于是
 * 151 条记忆对应 0 行向量，召回永远只有关键词那一条路。
 * 这条测试按真实调用链把每一环都量一遍：**作业确实入了队、跑完确实落了向量、
 * 向量检索确实以 vector 模式把那条排回第一**。
 *
 * provider 说明（如实记录，不假装语义）：
 * - `AI_PLATFORMS_CONFIG` 完全未设时 **不会** 落到 mock——`resolveSystemPlatform`
 *   读不到配置文件直接返回 null，`createEmbeddingProvider` 返回 null，
 *   handler 走"no embedding provider"跳过分支，一行向量都不会有。
 * - 内置 `MockProvider.embed` 契约性地返回 **null**（触发上游关键词兜底），
 *   同样产不出向量。
 * 所以沿用仓库既有集测写法（companion-memory-embedding-original-postgres）：
 * 临时配置文件把 embedding 槽指到 **mock 类型**平台（不出网、没有真实 key），
 * 再用 `registerFactory` 覆盖成产出确定性向量的测试工厂。
 * 工厂向量按内容哈希取稀疏 0/1（1024 维，列宽是 vector(1024)）：
 * **内容敏感但无语义**——相同内容余弦=1、不同内容≈0，只能证明向量这条路是通的，
 * 不能证明语义质量（那要真实模型的 live 探针）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";

const CONN = testDatabaseUrl("DATABASE_URL");
const admin = postgres(CONN, { max: 3 });

const temp = mkdtempSync(join(tmpdir(), "companion-embedding-pipeline-"));
const originalPlatformsConfig = process.env.AI_PLATFORMS_CONFIG;
process.env.AI_PLATFORMS_CONFIG = join(temp, "platforms.json");
writeFileSync(process.env.AI_PLATFORMS_CONFIG, JSON.stringify({
  platforms: { itmock: { type: "mock", models: { embedding: { contextWindowTokens: 32768, maxOutputTokens: 8192 } } } },
  capabilities: { embedding: { platform: "itmock", model: "embedding" } },
}));
// 治理层的"必须有真实 provider"开关会把 mock 回退当成配置错误直接抛；本测试
// 验的就是 mock 路径，显式摘掉它，保证不依赖运行者 shell 里残留的变量。
delete process.env.AI_REQUIRE_CONFIGURED_PROVIDER;
const originalVectorFlag = process.env.COMPANION_MEMORY_VECTOR_V1;
process.env.COMPANION_MEMORY_VECTOR_V1 = "true";

const { closeDatabase: closeWorkerDatabase, withWorkerWorkspaceTransaction } =
  await import("../../../../workers/ai-worker/src/db.ts");
const { tickCompanionMemoryEmbeddingScheduler, resetCompanionMemoryEmbeddingSchedulerForTest } =
  await import("../../../../workers/ai-worker/src/handlers/schedulers/companion-memory-embedding-scheduler.ts");
const { runCompanionMemoryEmbeddingRebuild } =
  await import("../../../../workers/ai-worker/src/handlers/memory/companion-memory-embedding.ts");
const { retrieveCompanionMemories } =
  await import("../../../../workers/ai-worker/src/handlers/memory/companion-memory-vector.ts");
const { registerFactory } = await import("../../../../workers/ai-worker/src/lib/provider-factory.ts");

const EMBEDDING_MODEL_REVISION = "it-mock-memory-embedding-v1";

/** 确定性稀疏向量：sha256(内容) 的 32 个字节各点亮一维（共 1024 维）。 */
function mockVectorFor(text: string): number[] {
  const vector = new Array<number>(1024).fill(0);
  const digest = createHash("sha256").update(text, "utf8").digest();
  for (const byte of digest) vector[byte % 1024] = 1;
  return vector;
}

// 覆盖 mock.ts 的内置 embedding 工厂（它返回 null）。必须在 handler 模块
// 加载完（工厂已注册）之后再覆盖——注册表是后写覆盖。
registerFactory("mock", "embedding", () => ({
  id: "mock",
  embeddingModelId: EMBEDDING_MODEL_REVISION,
  embed: async (text: string) => mockVectorFor(text),
} as never));

const userId = randomUUID();
const workspaceId = randomUUID();
const prefix = userId.slice(0, 8);

/** 五条 pending 记忆：调度器与重建的入选判据都齐（candidate=false、未删、已同意）。 */
const FIXTURES = [
  { key: "m-cat", content: "我的猫叫 Momo，周四要带去复查，结果出来要第一时间说。" },
  { key: "m-n2", content: "我现在准备在 7 月参加 JLPT N2 考试。" },
  { key: "m-jazz", content: "我在准备爵士钢琴的 transcribe，每天只练二十分钟。" },
  { key: "m-kid", content: "孩子明年上小学，晚上八点后不要提学习的事。" },
  { key: "m-lib", content: "习惯在图书馆三楼复习，周末不去。" },
];
const memoryIds = new Map<string, string>(FIXTURES.map((item) => [item.key, randomUUID()]));

before(async () => {
  await admin`
    INSERT INTO users (id, email, password_hash, role)
    VALUES (${userId}, ${`embedding-pipeline-${prefix}@example.test`}, 'test-hash', 'owner')
  `;
  await admin`
    INSERT INTO workspaces (id, name, owner_id, workspace_type)
    VALUES (${workspaceId}, ${`embedding-pipeline-${prefix}`}, ${userId}, 'collaborative')
  `;
  await admin`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
  // 补偿调度器的入选判据是这条同意行（consent_at + consent_version 都非空）。
  await admin`INSERT INTO user_ai_settings (user_id, consent_version, consent_at, data_policy)
    VALUES (${userId}, 'it-embedding-v1', now(), ${admin.json({
      sendToExternal: true, sendImageContent: false, piiDetection: true, auditLogging: true })})`;
  for (const item of FIXTURES) {
    await admin`
      INSERT INTO assistant_memory_items
        (id, workspace_id, user_id, kind, content, source_type, author_type, epistemic_status,
         user_stated, user_confirmed, candidate, importance, confidence, pinned, scope,
         embedding_status, budget_tier)
      VALUES (${memoryIds.get(item.key)!}, ${workspaceId}, ${userId}, 'preference', ${item.content},
        'user_stated', 'user', 'supported', true, true, false, 0.6, 0.6, false,
        'workspace', 'pending', 'active')
    `;
  }
});

after(async () => {
  // fire-and-forget 的审计行可能还在途，先让出半个心跳再清。
  await new Promise((resolve) => setTimeout(resolve, 250));
  await admin`DELETE FROM ai_audit_log WHERE workspace_id = ${workspaceId}`;
  await admin`DELETE FROM memory_usage_log WHERE user_id = ${userId}`;
  await admin`DELETE FROM assistant_memory_item_revisions WHERE user_id = ${userId}`;
  await admin`DELETE FROM assistant_memory_embeddings WHERE user_id = ${userId}`;
  await admin`DELETE FROM jobs WHERE workspace_id = ${workspaceId}`;
  await admin`DELETE FROM assistant_memory_items WHERE user_id = ${userId}`;
  await admin`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
  await admin`DELETE FROM workspaces WHERE id = ${workspaceId}`;
  await admin`DELETE FROM users WHERE id = ${userId}`;
  await admin.end({ timeout: 5 }).catch(() => {});
  await closeWorkerDatabase().catch(() => {});
  if (originalPlatformsConfig === undefined) delete process.env.AI_PLATFORMS_CONFIG;
  else process.env.AI_PLATFORMS_CONFIG = originalPlatformsConfig;
  if (originalVectorFlag === undefined) delete process.env.COMPANION_MEMORY_VECTOR_V1;
  else process.env.COMPANION_MEMORY_VECTOR_V1 = originalVectorFlag;
  rmSync(temp, { recursive: true, force: true });
});

test("pending 记忆经调度器入队、作业真实执行、向量落库并以 vector 模式召回", async () => {
  // ── 1) 补偿调度器：这一步就是 created_at 列名 bug 每次静默失败的地方。
  resetCompanionMemoryEmbeddingSchedulerForTest();
  await tickCompanionMemoryEmbeddingScheduler();

  const [job] = await admin`
    SELECT id FROM jobs
    WHERE type = 'companion_memory_embedding_rebuild'
      AND workspace_id = ${workspaceId}
      AND requested_by = ${userId}
      AND status = 'pending'
  `;
  assert.ok(job, "调度器没有为已同意账号下的 pending 记忆入队重建作业——补偿链路又断了");
  const embeddingsBefore = await admin`
    SELECT count(*)::int AS n FROM assistant_memory_embeddings WHERE user_id = ${userId}
  `;
  assert.equal(embeddingsBefore[0]!.n, 0,
    "此刻向量表应当还是 0 行：入队与落向量是两环，分开断言才能证明旧 bug 是在对的那一环被抓到");

  // ── 2) 按既有集测的 claim 模式把作业领起来，再真实执行 handler（含 assertJobLease）。
  const leaseToken = randomUUID();
  const [claimed] = await admin`
    UPDATE jobs SET status = 'running', lease_token = ${leaseToken}, started_at = now(),
      attempts = attempts + 1
    WHERE id = ${job!.id} AND status = 'pending'
    RETURNING id, payload
  `;
  assert.ok(claimed);
  await runCompanionMemoryEmbeddingRebuild({
    id: String(claimed.id),
    workspaceId,
    requestedBy: userId,
    payload: claimed.payload as Record<string, unknown>,
    leaseToken,
    signal: new AbortController().signal,
  } as never);

  // ── 3) 状态翻转 + 每行一条向量，model_revision 是本次 mock 工厂的那个。
  const statuses = await admin`
    SELECT embedding_status, count(*)::int AS n
    FROM assistant_memory_items WHERE user_id = ${userId}
    GROUP BY embedding_status
  `;
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0]!.embedding_status, "ready");
  assert.equal(Number(statuses[0]!.n), FIXTURES.length,
    "跑完重建后所有 pending 记忆都该是 ready——failed 会把真实失败吞进聚合结果里");
  const embeddings = await admin`
    SELECT memory_id, model_revision FROM assistant_memory_embeddings WHERE user_id = ${userId}
  `;
  assert.equal(embeddings.length, FIXTURES.length, "assistant_memory_embeddings 应当每条记忆一行");
  for (const row of embeddings) assert.equal(row.model_revision, EMBEDDING_MODEL_REVISION);
  await admin`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE id = ${claimed.id}`;

  // ── 4) 向量召回：查询向量 = 目标那条内容的 mock 向量（精确同内容，余弦=1）。
  // 这只证明 pgvector 这条路是通的：mock 向量内容敏感但无语义，
  // 排第一是同内容哈希相同这个数学事实，不是"理解了问题"。
  const target = FIXTURES[0]!;
  const targetId = memoryIds.get(target.key)!;
  const provider = {
    id: "mock",
    embeddingModelId: EMBEDDING_MODEL_REVISION,
    embed: async (text: string) => mockVectorFor(text),
  };
  const result = await withWorkerWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    retrieveCompanionMemories(tx, { workspaceId, userId }, target.content, {
      provider,
      precomputedEmbedding: mockVectorFor(target.content),
      topK: 5,
    }));
  assert.equal(result.mode, "vector",
    "有了 ready 向量还回 keyword_fallback，说明向量路径没接通（或 COMPANION_MEMORY_VECTOR_V1/模型基准没对上）");
  assert.ok(result.items.length > 0, "vector 模式下没有返回任何记忆");
  assert.equal(result.items[0]!.memoryId, targetId,
    `同内容查询的目标没排第一：实际顺序 ${result.items.map((item) => item.memoryId.slice(0, 4)).join(",")}`);
  console.log(`embedding 全链路：${FIXTURES.length} 条 pending → ${embeddings.length} 行向量（model_revision=${EMBEDDING_MODEL_REVISION}），召回模式=${result.mode}`);
});
