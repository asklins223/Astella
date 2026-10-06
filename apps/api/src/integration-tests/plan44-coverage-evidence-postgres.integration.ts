/**
 * 方案 44 另外几个迁移在**真实数据库上**的行为：0382 覆盖区间、0384 会话内容修订号、
 * 0386 使用阶段、0387 证据归并回执。
 *
 * ## 为什么这些必须有真库证据
 *
 * 0389 的教训：能干净应用 ≠ 行为正确。那次是撞上一个名字相近的旧约束，
 * 而**所有**文本形状的判据都绿。这里四条的判据全写在约束与触发器里，
 * 形状断言同样看不见：
 *   - 0386 的 `feedback IS NULL OR stage IN ('read','adopted')` 到底拦不拦得住？
 *   - 0387 的 `independentCount <= jsonb_array_length(evidence)` 在四条同源依据、
 *     independentCount=1 时放不放行？（这正是 §6.4 归并后的形状）
 *   - 0384 的触发器只在 UPDATE/DELETE 上前进——**INSERT 不前进**，否则每来一条新消息
 *     就把所有摘要判成失效。
 *
 * 运行方式：DATABASE_URL_API=... npm run test:plan44-coverage:postgres
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";

// 夹具要写 users/workspaces，而 users 的 RLS 只放行「id = app.user_id」的自插入——
// 受限的 api 角色插不进第二个用户（真库报 42501）。所以按仓库约定：
// **夹具写入用 migrator，被测代码的读写用受限角色**（见 integration-test-db-env）。
const CONN = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!CONN) throw new Error("DATABASE_URL_API 未配置——44 的覆盖/证据集成测试要求真实 Postgres");

const sql = postgres(CONN, { max: 2 });
const workspaceId = randomUUID();
const userId = randomUUID();
const email = `plan44c-${userId.slice(0, 8)}@example.test`;

interface Ids { conversationId: string; methodId: string; summaryId: string }
const newIds = (): Ids => ({ conversationId: randomUUID(), methodId: randomUUID(), summaryId: randomUUID() });

async function seed(): Promise<Ids> {
  const ids = newIds();
  await sql`INSERT INTO users (id, email, password_hash) VALUES (${userId}, ${email}, 'x') ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO workspaces (id, owner_id, name) VALUES (${workspaceId}, ${userId}, 'w') ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO companion_conversations
    (id, workspace_id, user_id, title, title_source, kind, status, context_revision)
    VALUES (${ids.conversationId}, ${workspaceId}, ${userId}, 't', 'placeholder', 'dialogue', 'active', 3)`;
  return ids;
}

async function cleanup(ids: Ids): Promise<void> {
  await sql`DELETE FROM companion_messages WHERE conversation_id = ${ids.conversationId}`.catch(() => {});
  await sql`DELETE FROM conversation_summaries WHERE conversation_id = ${ids.conversationId}`.catch(() => {});
  await sql`DELETE FROM companion_method_uses WHERE method_id = ${ids.methodId}`.catch(() => {});
  await sql`DELETE FROM companion_procedural_playbooks WHERE id = ${ids.methodId}`.catch(() => {});
  await sql`DELETE FROM companion_conversations WHERE id = ${ids.conversationId}`.catch(() => {});
  await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`.catch(() => {});
  await sql`DELETE FROM users WHERE id = ${userId}`.catch(() => {});
}

async function addMessage(ids: Ids, seq: number, content: string): Promise<void> {
  await sql`INSERT INTO companion_messages
    (id, workspace_id, user_id, conversation_id, seq, kind, role, blocks, content_sha256)
    VALUES (${randomUUID()}, ${workspaceId}, ${userId}, ${ids.conversationId}, ${seq},
            'text', 'user', ${sql.json([{ type: "text", content }])}::jsonb,
            ${createHash("sha256").update(content).digest("hex")})`;
}

test("0391：0384 之前写下的摘要不会因为没记修订号而永远读不到", async () => {
  // 这条缺陷是 2026-10-06 在真窗口里发现的：问伴星「我们之前聊过什么」，
  // 而库里所有既有摘要的 verified_context_revision 都是 NULL，
  // `NULL = context_revision` 恒为 NULL（不是 true），于是**0384 之前写的每一份摘要
  // 都再也读不到了**——包括在它自己那个会话里。
  //
  // 单测与真库测试都没抓到它，因为夹具都是**新建**摘要（走写入侧会带上修订号），
  // 没有一条走「0384 之前就存在的摘要」。所以这里**故意手工造一条 legacy 行**。
  await seed();
  const conversationId = randomUUID();
  const legacySummaryId = randomUUID();
  const currentSummaryId = randomUUID();
  await sql`INSERT INTO companion_conversations
    (id, workspace_id, user_id, title, title_source, kind, status, context_revision)
    VALUES (${conversationId}, ${workspaceId}, ${userId}, 't', 'placeholder', 'dialogue', 'active', 1)`;
  const insert = (id: string, revision: number | null) => sql`INSERT INTO conversation_summaries
    (id, workspace_id, user_id, conversation_id, summary, coverage_from_seq, coverage_through_seq,
     coverage_source_hash, verified_context_revision)
    VALUES (${id}, ${workspaceId}, ${userId}, ${conversationId}, '"s"'::jsonb, 1, 9,
            ${"b".repeat(64)}, ${revision})`;
  // 停在修订号 1 = 消息从未被改写或删除 → 这些摘要**可证明**仍然有效。
  await insert(legacySummaryId, null);
  await insert(currentSummaryId, 1);

  const readable = () => sql`
    SELECT s.id FROM conversation_summaries s
    JOIN companion_conversations c ON c.id = s.conversation_id
    WHERE s.conversation_id = ${conversationId}
      AND s.verified_context_revision = c.context_revision`;
  assert.equal((await readable()).length, 1, "回填前只有自带修订号的那条读得到");

  // 迁移 0391 的语句（同一口径：只救可证明的那部分）。
  await sql`UPDATE conversation_summaries s SET verified_context_revision = c.context_revision
            FROM companion_conversations c
            WHERE s.conversation_id = c.id AND s.verified_context_revision IS NULL
              AND c.context_revision = 1 AND s.conversation_id = ${conversationId}`;

  const after = await readable();
  assert.equal(after.length, 2, "回填后两条都读得到——legacy 行不再被静默丢掉");

  // 反例：会话被改写过（修订号 > 1）时**不回填**——无法判断摘要写在改写之前还是之后。
  await sql`UPDATE companion_conversations SET context_revision = 2 WHERE id = ${conversationId}`;
  await sql`UPDATE conversation_summaries SET verified_context_revision = NULL WHERE id = ${currentSummaryId}`;
  await sql`UPDATE conversation_summaries s SET verified_context_revision = c.context_revision
            FROM companion_conversations c
            WHERE s.conversation_id = c.id AND s.verified_context_revision IS NULL
              AND c.context_revision = 1 AND s.conversation_id = ${conversationId}`;
  const stillNull = await sql`SELECT count(*)::int AS n FROM conversation_summaries
                              WHERE conversation_id = ${conversationId}
                                AND verified_context_revision IS NULL`;
  assert.equal(stillNull[0]!.n, 1, "修订号 > 1 的不回填——宁可少读，不可错读");

  await sql`DELETE FROM conversation_summaries WHERE conversation_id = ${conversationId}`.catch(() => {});
  await sql`DELETE FROM companion_conversations WHERE id = ${conversationId}`.catch(() => {});
});

after(async () => { await sql.end({ timeout: 5 }).catch(() => {}); });

test("0384：新消息不推进修订号；改写或删除才推进——否则每来一条消息就废掉所有摘要", async () => {
  const ids = await seed();
  try {
    const revisionOf = async () => (await sql`SELECT context_revision FROM companion_conversations
      WHERE id = ${ids.conversationId}`)[0]!.context_revision;

    await addMessage(ids, 1, "第一句");
    assert.equal(Number(await revisionOf()), 3, "INSERT 不该推进修订号");

    await addMessage(ids, 2, "第二句");
    assert.equal(Number(await revisionOf()), 3, "又一条 INSERT 仍不该推进");

    await sql`UPDATE companion_messages SET content_sha256 = ${"f".repeat(64)} WHERE conversation_id = ${ids.conversationId} AND seq = 1`;
    assert.equal(Number(await revisionOf()), 4, "改写来源必须推进——摘要盖住的那一段变了");

    await sql`DELETE FROM companion_messages WHERE conversation_id = ${ids.conversationId} AND seq = 2`;
    assert.equal(Number(await revisionOf()), 5, "删除来源必须推进");
  } finally {
    await cleanup(ids);
  }
});

test("0386：目录里出现过（offered）的那条使用记录收不到评价", async () => {
  const ids = await seed();
  try {
    await sql`INSERT INTO companion_procedural_playbooks
      (id, workspace_id, user_id, playbook_key, title, trigger_condition)
      VALUES (${ids.methodId}, ${workspaceId}, ${userId}, ${`k-${ids.methodId}`}, '先说适用条件', '讲公式时')`;
    await sql`INSERT INTO companion_method_uses
      (workspace_id, user_id, method_id, method_revision, context_kind, context_id,
       context_revision, source_key, stage)
      VALUES (${workspaceId}, ${userId}, ${ids.methodId}, 1, 'conversation', ${ids.conversationId},
              1, ${`s-offered-${ids.methodId}`}, 'offered')`;

    // 只出现在目录里 —— 正是 recordAgentMethodOffered 写的那一档。
    await assert.rejects(
      () => sql`UPDATE companion_method_uses SET feedback = 'helpful'
                 WHERE source_key = ${`s-offered-${ids.methodId}`}`,
      /feedback_requires_engagement/,
      "没读过正文就收得到评价——那正是『目录提供』被当成『用过』",
    );
    // 读过之后就能收。
    await sql`UPDATE companion_method_uses SET stage = 'read' WHERE source_key = ${`s-offered-${ids.methodId}`}`;
    await sql`UPDATE companion_method_uses SET feedback = 'helpful' WHERE source_key = ${`s-offered-${ids.methodId}`}`;
    const row = await sql`SELECT feedback, stage FROM companion_method_uses WHERE source_key = ${`s-offered-${ids.methodId}`}`;
    assert.equal(row[0]!.feedback, "helpful");
    assert.equal(row[0]!.stage, "read", "记录评价**不**该顺手把阶段提升成 adopted");
  } finally {
    await cleanup(ids);
  }
});

test("0387：四条同源依据归并成 1 条独立佐证，放行；声称 5 条则被拒", async () => {
  const ids = await seed();
  try {
    const evidence = [{ memoryId: "m1" }, { memoryId: "m2" }, { memoryId: "m3" }, { memoryId: "m4" }];
    const origins = { independentCount: 1, mergedCount: 4, origins: [{ originKey: "run:7", refCount: 4 }] };

    await sql`INSERT INTO companion_procedural_playbooks
      (id, workspace_id, user_id, playbook_key, title, trigger_condition, evidence, evidence_origins)
      VALUES (${ids.methodId}, ${workspaceId}, ${userId}, ${`k-${ids.methodId}`}, '先说适用条件', '讲公式时',
              ${sql.json(evidence)}::jsonb, ${sql.json(origins)}::jsonb)`;
    const stored = await sql`SELECT jsonb_array_length(evidence) AS n FROM companion_procedural_playbooks
      WHERE id = ${ids.methodId}`;
    assert.equal(Number(stored[0]!.n), 4, "evidence 必须保完整——折掉引用会让遗忘/纠正的传播断链");

    // 声称的独立佐证数超过依据条数 → 自相矛盾，必须被拒。
    await assert.rejects(
      () => sql`UPDATE companion_procedural_playbooks
                 SET evidence_origins = ${sql.json({ ...origins, independentCount: 5 })}::jsonb
               WHERE id = ${ids.methodId}`,
      /evidence_origins_check/,
      "独立佐证数不能超过依据条数——那正是把同源重述当成多方印证",
    );
  } finally {
    await cleanup(ids);
  }
});

test("0382：覆盖区间要么三列齐全且 from <= through，要么三列全空", async () => {
  const ids = await seed();
  try {
    // 半截覆盖（from 有、through 没有）——不得放行。
    await assert.rejects(
      () => sql`INSERT INTO conversation_summaries
                 (id, workspace_id, user_id, conversation_id, summary, coverage_from_seq, coverage_source_hash)
               VALUES (${ids.summaryId}, ${workspaceId}, ${userId}, ${ids.conversationId},
                       '"s"'::jsonb, 5, ${"a".repeat(64)})`,
      /coverage_range_check/,
      "半截覆盖会让读侧以为摘要盖住了它其实没盖住的一段",
    );
    // 完整且有序 → 放行。
    await sql`INSERT INTO conversation_summaries
      (id, workspace_id, user_id, conversation_id, summary, coverage_from_seq, coverage_through_seq, coverage_source_hash)
      VALUES (${ids.summaryId}, ${workspaceId}, ${userId}, ${ids.conversationId}, '"s"'::jsonb,
              5, 9, ${"a".repeat(64)})`;
    // 倒序 → 不得放行。
    await assert.rejects(
      () => sql`UPDATE conversation_summaries SET coverage_from_seq = 99 WHERE id = ${ids.summaryId}`,
      /coverage_range_check/,
      "from > through 的覆盖区间不得放行",
    );
  } finally {
    await cleanup(ids);
  }
});
