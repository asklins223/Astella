/**
 * 方案 44 的**迁移在真实数据库上**的行为：0388 的失效传播与 0389 的快照围栏。
 *
 * ## 为什么必须跑真库
 *
 * 0389 曾经**完全跑不起来**，而当时七条判据全绿。原因是 0337 加的约束叫
 * `companion_context_handoff_snapshots_snapshot_version_check`（内容 `snapshot_version = 1`），
 * 0389 只 DROP 了 `…_snapshots_version_check` 这个**不存在的**名字，于是新加了一条冗余的
 * `>= 1`，而拦路的那个一动没动。每次写轨迹都撞约束。
 *
 * 文本形状的判据看不出这件事：名字对得上、语句读得懂、SQL 语法完全正确——它只是撞上了
 * 一个名字相近的旧约束。所以这里不写形状断言，直接建行、真跑 UPDATE、看结果。
 *
 * 运行方式（需要一次性可丢弃库，见 scripts/dev-disposable-db.sh）：
 *   DATABASE_URL_API=... node --import tsx --test \
 *     src/integration-tests/plan44-invalidation-fencing-postgres.integration.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

// 夹具要写 users/workspaces，而 users 的 RLS 只放行「id = app.user_id」的自插入——
// 受限的 api 角色插不进第二个用户（真库报 42501）。所以按仓库约定：
// **夹具写入用 migrator，被测代码的读写用受限角色**（见 integration-test-db-env）。
const CONN = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!CONN) throw new Error("DATABASE_URL_API 未配置——44 的失效传播集成测试要求真实 Postgres");

const sql = postgres(CONN, { max: 2 });
const workspaceId = randomUUID();
const userId = randomUUID();
const email = `plan44-${userId.slice(0, 8)}@example.test`;

/** 每条用例自带一套行 id，互不干扰——共享 id 会让第二条撞上第一条留下的行。 */
interface Fixture { conversationId: string; summaryId: string; memoryId: string; runId: string }
function newFixture(): Fixture {
  return { conversationId: randomUUID(), summaryId: randomUUID(), memoryId: randomUUID(), runId: randomUUID() };
}

/**
 * 建最小夹具。
 *
 * 清理顺序由外键决定：先子后父。workspaces.owner_id 指向 users，所以必须先删 workspace
 * 再删 user——反过来会撞 `workspaces_owner_id_users_id_fk`，而这种报错会把真正的断言
 * 结果整个盖掉（第一版正是这样：两个用例都红在清理阶段，看不出断言到底过没过）。
 */
async function seed(): Promise<Fixture> {
  const ids = newFixture();
  await sql`INSERT INTO users (id, email, password_hash) VALUES (${userId}, ${email}, 'x')
    ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO workspaces (id, owner_id, name) VALUES (${workspaceId}, ${userId}, 'w')
    ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO companion_conversations
    (id, workspace_id, user_id, title, title_source, kind, status, context_revision)
    VALUES (${ids.conversationId}, ${workspaceId}, ${userId}, 't', 'placeholder', 'dialogue', 'active', 3)`;
  return ids;
}

/** postgres.js 的查询结果是 Result 包装的；断言标量时要先取第一行第一列。 */
async function fenceOk(runId: string, version: number): Promise<boolean> {
  const [row] = await sql`SELECT public.ailearn_assert_handoff_snapshot_fence(${runId}, ${version}) AS ok`;
  return Boolean(row!.ok);
}

async function cleanup(ids: Fixture): Promise<void> {
  await sql`DELETE FROM companion_context_handoff_snapshots WHERE run_id = ${ids.runId}`.catch(() => {});
  await sql`DELETE FROM companion_turn_runs WHERE id = ${ids.runId}`.catch(() => {});
  await sql`DELETE FROM conversation_summaries WHERE id = ${ids.summaryId}`.catch(() => {});
  await sql`DELETE FROM assistant_memory_items WHERE id = ${ids.memoryId}`.catch(() => {});
  await sql`DELETE FROM companion_conversations WHERE id = ${ids.conversationId}`.catch(() => {});
  await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`.catch(() => {});
  await sql`DELETE FROM users WHERE id = ${userId}`.catch(() => {});
}

after(async () => {
  await sql.end({ timeout: 5 }).catch(() => {});
});

test("0388：用户遗忘那条记忆之后，它派生出那份摘要立刻不再被注入", async () => {
  const ids = await seed();
  try {
    await sql`INSERT INTO conversation_summaries
      (id, workspace_id, user_id, conversation_id, summary, status, derived_memory_id)
      VALUES (${ids.summaryId}, ${workspaceId}, ${userId}, ${ids.conversationId},
              '"以前聊过公式的适用条件"'::jsonb, 'confirmed', ${ids.memoryId})`;
    await sql`INSERT INTO assistant_memory_items
      (id, workspace_id, user_id, kind, content, source_event_id, epistemic_status)
      VALUES (${ids.memoryId}, ${workspaceId}, ${userId}, 'episodic', '他偏好语音',
              ${`summary:${ids.conversationId}:conversation`}, 'supported')`;

    const before = await sql`SELECT status FROM conversation_summaries WHERE id = ${ids.summaryId}`;
    assert.equal(before[0]!.status, "confirmed");

    // 这正是 §3.3 关心的动作：用户把那条记忆忘了。
    await sql`UPDATE assistant_memory_items SET dismissed_at = now() WHERE id = ${ids.memoryId}`;

    const after = await sql`SELECT status FROM conversation_summaries WHERE id = ${ids.summaryId}`;
    assert.equal(after[0]!.status, "stale", "遗忘没有传递到派生摘要");
    // 关键：读侧只认 candidate/confirmed，stale 落在之外 → 不再出现在对话上下文里。
    const visible = await sql`SELECT count(*)::int AS n FROM conversation_summaries
      WHERE id = ${ids.summaryId} AND status IN ('candidate','confirmed')`;
    assert.equal(visible[0]!.n, 0, "失效的摘要仍在读取侧认领范围内");
  } finally {
    await cleanup(ids);
  }
});

test("0389：快照推进到下一版；run 结束后的迟到结果写不进去", async () => {
  const ids = await seed();
  try {
    await sql`INSERT INTO companion_turn_runs
      (id, workspace_id, user_id, conversation_id, generation, status, idempotency_key_hash, request_body_hash)
      VALUES (${ids.runId}, ${workspaceId}, ${userId}, ${ids.conversationId}, 1, 'running',
              ${"b".repeat(64)}, ${"c".repeat(64)})`;
    await sql`INSERT INTO companion_context_handoff_snapshots
      (run_id, workspace_id, user_id, conversation_id, snapshot, snapshot_sha256, snapshot_version)
      VALUES (${ids.runId}, ${workspaceId}, ${userId}, ${ids.conversationId},
              ${sql.json({ version: 1, runId: ids.runId, conversationId: ids.conversationId })},
              ${"a".repeat(64)}, 1)`;

    // 版本 1 + run 在跑 → 围栏放行（这正是 0337 那个 =1 约束曾经挡死的地方）。
    assert.equal(await fenceOk(ids.runId, 1), true);
    assert.equal(await fenceOk(ids.runId, 2), false,
      "版本对不上还放行，迟到结果就会覆盖别人推进过的快照");

    const trace = [{ foldedFromSeq: "1", foldedThroughSeq: "1", foldedMessageCount: 1,
      summarySourceSha256: "b".repeat(64), remainingFromSeq: null, uncoveredBeforeSeq: null,
      modelId: null, inputTokens: 12000, triggerTokens: 10000, hardInputTokens: 15000,
      reason: "over_trigger_line", at: new Date().toISOString() }];
    const bump = () => sql`
      UPDATE companion_context_handoff_snapshots s
         SET snapshot = jsonb_set(s.snapshot, '{compactions}', ${sql.json(trace)}::jsonb),
             snapshot_sha256 = ${"d".repeat(64)},
             snapshot_version = s.snapshot_version + 1,
             created_at = now()
        FROM companion_turn_runs r
       WHERE s.run_id = ${ids.runId} AND r.id = s.run_id
         AND r.status IN ('accepted','running','waiting_for_confirmation')
         AND public.ailearn_assert_handoff_snapshot_fence(${ids.runId}, s.snapshot_version)
      RETURNING s.snapshot_version`;

    const first = await bump();
    assert.equal(first.length, 1, "轨迹写不进去——0337 那个 snapshot_version = 1 的约束没被放开？");
    assert.equal(Number(first[0]!.snapshot_version), 2);

    // run 已结束 → 迟到结果必须写不进去（快照停在 2）。
    await sql`UPDATE companion_turn_runs SET status = 'failed' WHERE id = ${ids.runId}`;
    assert.equal(await fenceOk(ids.runId, 2), false);
    assert.equal((await bump()).length, 0, "run 已经结束，迟到的轨迹不该覆盖快照");
    const final = await sql`SELECT snapshot_version FROM companion_context_handoff_snapshots WHERE run_id = ${ids.runId}`;
    assert.equal(Number(final[0]!.snapshot_version), 2);
  } finally {
    await cleanup(ids);
  }
});
