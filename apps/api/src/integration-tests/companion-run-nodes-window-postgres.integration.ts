/**
 * 过程留痕窗口的方向（2026-09-19 回审）。
 *
 * 真实 Postgres。`listCompanionRunNodes` 是给 UI 看"最近几轮她做了什么"的只读窗口，
 * 而它的 `runs` 摘要是最近 20 轮、节点事件却曾经按 seq **正序** limit 200——也就是
 * **最早**的那 200 条。会话累计超过 200 条节点事件后（一轮 agent 约 5–15 条，事件
 * TTL 24h），最近几轮的过程就会在历史里凭空消失，而摘要还在。
 *
 * 这个用例把窗口灌满，钉住"取最新的一批、且按时间正序返回"（折叠依赖顺序）。
 * 无 DB 时抛错（fail closed）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

process.env.AUTH_SURFACE_MANIFEST_SECRET ??= "integration-test-secret";

const databaseUrl = process.env.DATABASE_URL_API ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL_API 未配置——companion:postgres 集成测试要求真实 Postgres");
}
const sql = postgres(databaseUrl, { max: 2 });

import { listCompanionRunNodes } from "../modules/companion-conversation/turn/companion-events.ts";
import { closeDatabase } from "../db/client.ts";

test.after(async () => {
  await Promise.race([
    (async () => {
      await sql.end({ timeout: 5 }).catch(() => {});
      await closeDatabase().catch(() => {});
    })(),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
});

/** 超出窗口的会话：250 条可读节点事件 + 1 条已过 TTL 的。 */
async function seedBusyConversation() {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const conversationId = randomUUID();
  const seqs = Array.from({ length: 250 }, (_, index) => index + 1);
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role) VALUES (${userId}, ${`test-${userId.slice(0, 8)}@example.test`}, 'test-hash', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${workspaceId}, ${`test-ws-${workspaceId.slice(0, 8)}`}, ${userId})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
    await tx`INSERT INTO companion_conversations (id, workspace_id, user_id, kind, title, title_source, status)
             VALUES (${conversationId}, ${workspaceId}, ${userId}, 'dialogue', '长会话', 'placeholder', 'active')`;
    await tx`
      INSERT INTO companion_stream_events
        (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch, type, payload, expires_at)
      SELECT ${conversationId}, s, ${workspaceId}, ${userId}, NULL, 0, 0, 'assistant.status',
             '{"status":"thinking","safeLabel":"思考中"}'::jsonb, now() + interval '1 day'
      FROM unnest(${seqs}::int[]) AS s
    `;
    // seq 251 已过 TTL：必须在窗口里被滤掉，否则"过期"这条判据就没意义了。
    await tx`
      INSERT INTO companion_stream_events
        (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch, type, payload, expires_at)
      VALUES (${conversationId}, 251, ${workspaceId}, ${userId}, NULL, 0, 0, 'agent.tool',
              '{"tool":{"toolCallId":"dead","name":"observe.context","status":"succeeded","safeLabel":"读取学习上下文"}}'::jsonb,
              now() - interval '1 hour')
    `;
    // 生产里 `next_event_seq` 随每次写入自增；`latestSeq` 读的就是它减一，所以种子要自己推进，
    // 否则 latestSeq 会停在 0（默认 1 减一）。
    await tx`UPDATE companion_conversations SET next_event_seq = 252 WHERE id = ${conversationId}`;
  });
  const cleanup = async () => {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`DELETE FROM companion_stream_events WHERE conversation_id = ${conversationId}`;
      await tx`DELETE FROM companion_conversations WHERE id = ${conversationId}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      await tx`DELETE FROM users WHERE id = ${userId}`;
    });
  };
  return { workspaceId, userId, conversationId, cleanup };
}

test("过程留痕窗口取最新的一批，且按时间正序返回", async () => {
  const { workspaceId, userId, conversationId, cleanup } = await seedBusyConversation();
  try {
    const result = await listCompanionRunNodes({ workspaceId, userId, conversationId, after: 0 });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.items.length, 200, "窗口上限 200 条");
    // 正序 limit 会给出 1..200 —— 那是会话**最早**的一段，最近几轮反而是空的。
    assert.equal(result.items[0]?.seq, 51, "取的是最新的一批（51..250）");
    assert.equal(result.items[199]?.seq, 250);
    assert.ok(
      result.items.every((item, index) => index === 0 || item.seq > result.items[index - 1]!.seq),
      "折叠依赖时间顺序，返回必须按 seq 正序",
    );
    assert.equal(result.latestSeq, 251, "latestSeq 仍是会话的最后一个 seq");
    assert.equal(
      result.items.some((item) => item.seq === 251),
      false,
      "已过 TTL 的事件不出现在窗口里",
    );
    assert.deepEqual(result.runs, [], "没有 run 摘要行时不编造");
  } finally {
    await cleanup();
  }
});

test("after 是下界而不是翻页游标", async () => {
  const { workspaceId, userId, conversationId, cleanup } = await seedBusyConversation();
  try {
    const result = await listCompanionRunNodes({ workspaceId, userId, conversationId, after: 200 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.items.length, 50);
    assert.equal(result.items[0]?.seq, 201);
    assert.equal(result.items[49]?.seq, 250);
  } finally {
    await cleanup();
  }
});

test("别人的会话读不到（RLS）：返回 404 而不是空列表", async () => {
  const owner = await seedBusyConversation();
  const outsider = await seedBusyConversation();
  try {
    const result = await listCompanionRunNodes({
      workspaceId: outsider.workspaceId,
      userId: outsider.userId,
      conversationId: owner.conversationId,
      after: 0,
    });
    // RLS 让别人的会话"不存在"，所以是 404 而不是 403——不泄露"这个 id 存在"。
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.statusCode, 404);
  } finally {
    await owner.cleanup();
    await outsider.cleanup();
  }
});

test("user-only failure and actionable work survive the recent twenty-run window", async () => {
  const fixture = await seedBusyConversation();
  const { workspaceId, userId, conversationId } = fixture;
  const oldMessageId = randomUUID(), recentMessageId = randomUUID(), oldRunId = randomUUID();
  try {
    await sql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true), set_config('app.user_id', ${userId}, true)`;
      for (const [id, seq] of [[oldMessageId, 1], [recentMessageId, 2]] as const) {
        await tx`INSERT INTO companion_messages (id,conversation_id,workspace_id,user_id,role,seq,kind,blocks,content_sha256)
          VALUES (${id},${conversationId},${workspaceId},${userId},'user',${seq},'text',${tx.json([{type:'text',text:'question'}])},${'0'.repeat(64)})`;
      }
      for (let index = 0; index < 21; index++) {
        await tx`INSERT INTO companion_turn_runs
          (id,conversation_id,workspace_id,user_id,user_message_id,generation,status,error_code,idempotency_key_hash,request_body_hash,created_at)
          VALUES (${index === 0 ? oldRunId : randomUUID()},${conversationId},${workspaceId},${userId},${index === 0 ? oldMessageId : recentMessageId},${index + 1},
            ${index === 0 ? 'failed' : 'succeeded'},${index === 0 ? 'PROVIDER_FIRST_OUTPUT_TIMEOUT' : null},${randomUUID()},${'b'.repeat(64)},${new Date(Date.now() - (22-index)*60_000)})`;
      }
    });
    const recent = await listCompanionRunNodes({ workspaceId,userId,conversationId,after:0 });
    assert.ok(recent.ok && !recent.runs.some(run => run.runId === oldRunId));
    const archived = await listCompanionRunNodes({ workspaceId,userId,conversationId,after:0,userMessageIds:[oldMessageId] });
    assert.ok(archived.ok);
    assert.deepEqual(archived.runs.map(run => run.runId), [oldRunId]);
    assert.equal(archived.runs[0]?.assistantMessageId, null);
    const actionable = await listCompanionRunNodes({ workspaceId,userId,conversationId,after:0,includeRecoverable:true });
    assert.ok(actionable.ok && actionable.runs.some(run => run.runId === oldRunId));
    await sql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true), set_config('app.user_id', ${userId}, true)`;
      await tx`UPDATE companion_turn_runs SET status='succeeded',error_code=NULL,
        process_timeline=${tx.json([
          {type:'agent.tool',payload:{tool:{toolCallId:'same',status:'requested'}}},
          {type:'agent.tool',payload:{tool:{toolCallId:'same',status:'succeeded'}}}
        ])} WHERE id=${oldRunId}`;
    });
    const resolved = await listCompanionRunNodes({ workspaceId,userId,conversationId,after:0,includeRecoverable:true });
    assert.ok(resolved.ok && !resolved.runs.some(run => run.runId === oldRunId), "old requested events must not revive a completed tool");
  } catch (error) {
    throw error instanceof Error && error.cause instanceof Error ? error.cause : error;
  } finally {
    await sql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true), set_config('app.user_id', ${userId}, true)`;
      await tx`DELETE FROM companion_turn_runs WHERE conversation_id=${conversationId}`;
      await tx`DELETE FROM companion_messages WHERE conversation_id=${conversationId}`;
    });
    await fixture.cleanup();
  }
});
