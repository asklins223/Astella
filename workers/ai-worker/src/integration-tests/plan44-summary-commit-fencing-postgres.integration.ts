/**
 * 方案 44 §3.3／§5.3：摘要**提交**的两条围栏在真实数据库上的行为。
 *
 * ## 这条要验的是什么
 *
 * `upsertCommittedSummary` 一条语句担着两件事，而且**成功与否只能看返回行数**：
 *
 *   1. 同一段区间（同哈希、同策略版本）已经有一份有效的了 → 不再提交。
 *      手动「整理近期对话」最需要它：`source_run_id` 是 NULL，而
 *      `conversation_summaries_unique_idx` 对 NULL 是 NULLS DISTINCT，
 *      `ON CONFLICT` 的冲突目标根本不会触发——连点两次就会插出两份同区间的摘要，
 *      接续链分叉，递归读只走 `coverage_through_seq` 最大的那一支，另一支谁也看不见。
 *   2. 同一来源键重入时，只有父版本仍是预期的那个才允许推进 revision。
 *
 * 这两条在单测里都只能靠「查询形状」钉住（见 companion-summary-chain.test.ts 的说明），
 * 真正的行为要在实库上跑。
 *
 * 运行：DATABASE_URL_API=... npm run test:plan44-summary-commit:postgres
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { upsertCommittedSummary, type CommittedSummaryUpsert } from "../handlers/companion-dialogue-store.ts";
import { withWorkerWorkspaceTransaction, type WorkerTransaction } from "../db.ts";

process.env.DATABASE_URL_API = testDatabaseUrl("DATABASE_URL_API");
process.env.DATABASE_URL_WORKER = testDatabaseUrl("DATABASE_URL_WORKER");

const scope = { workspaceId: randomUUID(), userId: randomUUID() };
const conversationId = randomUUID();
const email = `plan44c-${scope.userId.slice(0, 8)}@example.test`;
const POLICY = "companion-summary-v1";

const inWorker = <T>(action: (tx: WorkerTransaction) => Promise<T>): Promise<T> =>
  withWorkerWorkspaceTransaction(scope, action);

async function seedScope(): Promise<void> {
  const { default: postgres } = await import("postgres");
  const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 1 });
  await admin`INSERT INTO users (id, email, password_hash) VALUES (${scope.userId}, ${email}, 'x')
    ON CONFLICT (id) DO NOTHING`;
  await admin`INSERT INTO workspaces (id, owner_id, name) VALUES (${scope.workspaceId}, ${scope.userId}, 'w')
    ON CONFLICT (id) DO NOTHING`;
  // conversation_id 没有外键，但 0390 之后 workspace_id 有——夹具仍按真实形状建会话行，
  // 免得以后加了 FK 才现形。
  await admin`INSERT INTO companion_conversations (id, workspace_id, user_id, kind, title, title_source, status)
    VALUES (${conversationId}, ${scope.workspaceId}, ${scope.userId}, 'dialogue', 'plan44 commit fencing', 'system', 'active')
    ON CONFLICT (id) DO NOTHING`;
  await admin.end({ timeout: 5 });
}

async function dropScope(): Promise<void> {
  const { default: postgres } = await import("postgres");
  const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 1 });
  await admin`DELETE FROM conversation_summaries WHERE workspace_id = ${scope.workspaceId}`.catch(() => {});
  await admin`DELETE FROM companion_conversations WHERE id = ${conversationId}`.catch(() => {});
  await admin`DELETE FROM workspaces WHERE id = ${scope.workspaceId}`.catch(() => {});
  await admin`DELETE FROM users WHERE id = ${scope.userId}`.catch(() => {});
  await admin.end({ timeout: 5 });
}

after(async () => { await dropScope(); });

const commit = (
  over: Partial<CommittedSummaryUpsert> = {},
): Promise<string | null> => inWorker((tx) => upsertCommittedSummary(tx, {
  workspaceId: scope.workspaceId,
  userId: scope.userId,
  conversationId,
  summary: { title: "测试摘要" },
  sourceRunId: null,
  coverageFromSeq: "1",
  coverageThroughSeq: "40",
  sourceHash: "a".repeat(64),
  parentSummaryId: null,
  coverageManifest: { version: 1 },
  policyVersion: POLICY,
  verifiedContextRevision: "1",
  ...over,
}));

const rowsInConversation = () => inWorker(async (tx) => (
  await tx.execute<{ id: string; revision: number; status: string }>(sql`
    SELECT id, revision, status FROM conversation_summaries
    WHERE conversation_id = ${conversationId}
    ORDER BY coverage_through_seq DESC, updated_at DESC
  `)
));

test("44 §3.3：手动路径（source_run_id 为 NULL）连点两次只产生一份——第二次返回 null，不插分叉", async () => {
  await seedScope();
  const first = await commit();
  assert.ok(first, "第一次提交必须真的写进去了");

  const second = await commit();
  assert.equal(second, null, "同一区间重复触发必须什么都不提交（NULLS DISTINCT 的唯一索引挡不住它）");

  const rows = await rowsInConversation();
  assert.equal(rows.length, 1, `同一区间应只有一行，实际 ${rows.length} 行——链已经分叉`);
});

test("44 §3.3：区间没变但策略版本变了，允许重新提交（幂等键绑定策略版本）", async () => {
  const before = (await rowsInConversation()).length;
  const committed = await commit({ policyVersion: `${POLICY}-v2` });
  assert.ok(committed, "换了压缩策略版本就是另一次提交，不该被旧区间挡住");
  assert.equal((await rowsInConversation()).length, before + 1);
});

test("44 §3.3：已失效（stale）的旧区间不挡新提交——否则一次撤权会把这段历史永久钉死", async () => {
  await inWorker((tx) => tx.execute(sql`
    UPDATE conversation_summaries SET status = 'stale'
    WHERE conversation_id = ${conversationId} AND coverage_through_seq = 40
  `));
  // 区间、哈希、策略都与刚被标成 stale 的那一份一致——只有 status 不同。
  const committed = await commit();
  assert.ok(committed, "没有有效的同区间摘要时不挡提交，哪怕区间形状一模一样");
  const rows = await inWorker((tx) => tx.execute<{ status: string }>(sql`
    SELECT status FROM conversation_summaries WHERE id = ${committed}::uuid
  `));
  assert.equal(rows[0]!.status, "candidate");
});

test("44 §5.3：同一来源键重入且父版本没动时，推进 revision 而不是插新行", async () => {
  const runId = randomUUID();
  const first = await commit({ sourceRunId: runId, coverageFromSeq: "41", coverageThroughSeq: "80", sourceHash: "c".repeat(64) });
  assert.ok(first);
  const second = await commit({ sourceRunId: runId, coverageFromSeq: "41", coverageThroughSeq: "90", sourceHash: "d".repeat(64) });
  assert.equal(second, first, "同一个槽位重入应更新同一行");

  const rows = await inWorker((tx) => tx.execute<{ revision: number }>(sql`
    SELECT revision FROM conversation_summaries WHERE id = ${first}::uuid
  `));
  assert.equal(rows[0]!.revision, 2, "同一槽位的第二次提交应该推进 revision");
});

test("44 §5.3：同一来源键但父版本已经变了时整份作废——返回 null，且已有的行原封不动", async () => {
  const runId = randomUUID();
  const first = await commit({ sourceRunId: runId, coverageFromSeq: "91", coverageThroughSeq: "100", sourceHash: "e".repeat(64) });
  assert.ok(first);
  // 这条槽位的行记的父是 null；重入时若声称父是别人（链已经被更新的摘要接走了），
  // 就该整份作废，而不是把已有行改掉。
  const late = await commit({
    sourceRunId: runId, coverageFromSeq: "91", coverageThroughSeq: "105",
    sourceHash: "0".repeat(64), parentSummaryId: randomUUID(),
  });
  assert.equal(late, null, "父版本对不上时不能返回一个 id 冒充成功");

  const rows = await inWorker((tx) => tx.execute<{ coverage_through_seq: string; coverage_source_hash: string }>(sql`
    SELECT coverage_through_seq::text AS coverage_through_seq, coverage_source_hash
    FROM conversation_summaries WHERE id = ${first}::uuid
  `));
  assert.equal(rows[0]!.coverage_through_seq, "100", "已有的行必须原封不动");
  assert.equal(rows[0]!.coverage_source_hash, "e".repeat(64));
});
