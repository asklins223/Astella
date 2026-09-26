/**
 * 失败留档（2026-09-19）：一轮失败之后，"她已经说出来的那半句"必须留在历史里。
 *
 * 背景（症状①）：失败路径此前只写 `error` 事件、不写消息，于是气泡里已经出现过的文字
 * 在收尾瞬间从对话历史里彻底消失——用户看到的是"内容没了"，历史里连这一轮都查不到。
 * 与"用户按停止"的 `kind='cancelled'` 留档对称，这里验证 `kind='error'` 那条：
 *
 * - 已下发 ≥ 阈值 → 落一条 error 消息、绑定 run、推进会话计数器；
 * - 太短不落（碎片是噪音，不是记录）；
 * - 重复调用幂等（不会插出第二条）；
 * - run 的真实终态不是 failed（取消/被接替/仍在跑）→ 一条都不落。
 *
 * 只调用留档函数本身，不跑 handler：这条链路不碰队列，dev worker 在跑也不会互相干扰。
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";

const CONN = testDatabaseUrl("DATABASE_URL_API");
process.env.DATABASE_URL ??= CONN;

const sql = postgres(CONN, { max: 2 });

after(async () => {
  await sql.end({ timeout: 2 });
  const { closeDatabase } = await import("../db.ts");
  await closeDatabase();
});

const { persistFailedPartial, pickCompanionFailureFallbackLine } =
  await import("../handlers/companion-dialogue.ts");

async function seedBase(): Promise<{ workspaceId: string; userId: string }> {
  const ws = randomUUID();
  const uid = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`SELECT set_config('app.user_id', ${uid}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role) VALUES (${uid}, ${"t-" + uid.slice(0, 8) + "@x.test"}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${ws}, ${"w" + ws.slice(0, 8)}, ${uid})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${ws}, ${uid}, 'owner')`;
  });
  return { workspaceId: ws, userId: uid };
}

async function seedRun(
  ws: string,
  uid: string,
  runStatus: string,
): Promise<{ runId: string; cid: string; cleanup: () => Promise<void> }> {
  const runId = randomUUID();
  const cid = randomUUID();
  const userMessageId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`SELECT set_config('app.user_id', ${uid}, true)`;
    await tx`INSERT INTO companion_conversations (id, workspace_id, user_id, kind, title, title_source, status)
             VALUES (${cid}, ${ws}, ${uid}, 'dialogue', '会话', 'auto', 'active')`;
    await tx`INSERT INTO companion_messages (id, conversation_id, workspace_id, user_id, role, seq, kind, blocks, content_sha256)
             VALUES (${userMessageId}, ${cid}, ${ws}, ${uid}, 'user', 1, 'text',
                     ${tx.json([{ type: "text", text: "帮我复习光合作用" }])}, ${"0".repeat(64)})`;
    await tx`INSERT INTO companion_turn_runs
             (id, conversation_id, workspace_id, user_id, user_message_id, generation, status,
              idempotency_key_hash, request_body_hash)
             VALUES (${runId}, ${cid}, ${ws}, ${uid}, ${userMessageId}, 1, ${runStatus},
                     ${"a".repeat(64)}, ${"b".repeat(64)})`;
    await tx`UPDATE companion_conversations SET next_message_seq = 2, next_event_seq = 100 WHERE id = ${cid}`;
  });
  const cleanup = async () => {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      await tx`SELECT set_config('app.user_id', ${uid}, true)`;
      // 顺序不能反：companion_turn_runs.user_message_id 指向 companion_messages，
      // companion_conversations.workspace_id 指向 workspaces。
      await tx`DELETE FROM companion_turn_runs WHERE id = ${runId}`;
      await tx`DELETE FROM companion_messages WHERE conversation_id = ${cid}`;
      await tx`DELETE FROM companion_conversations WHERE id = ${cid}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM workspaces WHERE id = ${ws}`;
      await tx`DELETE FROM users WHERE id = ${uid}`;
    });
  };
  return { runId, cid, cleanup };
}

async function readPartial(
  ws: string,
  uid: string,
  cid: string,
  runId: string,
): Promise<{
  messages: { id: string; kind: string; run_id: string | null; text: string; seq: number }[];
  assistantMessageId: string | null;
  nextMessageSeq: number;
}> {
  return await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`SELECT set_config('app.user_id', ${uid}, true)`;
    const rows = await tx`SELECT id, kind, run_id, blocks, seq FROM companion_messages
                          WHERE conversation_id = ${cid} AND role = 'assistant' ORDER BY seq`;
    const run = await tx`SELECT assistant_message_id FROM companion_turn_runs WHERE id = ${runId}`;
    const conv = await tx`SELECT next_message_seq FROM companion_conversations WHERE id = ${cid}`;
    return {
      messages: rows.map((row) => ({
        id: String(row.id),
        kind: String(row.kind),
        run_id: row.run_id ? String(row.run_id) : null,
        text: (row.blocks as { text?: string }[])[0]?.text ?? "",
        seq: Number(row.seq),
      })),
      assistantMessageId: run[0]?.assistant_message_id ? String(run[0].assistant_message_id) : null,
      nextMessageSeq: Number(conv[0]?.next_message_seq ?? 0),
    };
  });
}

const DELIVERED = "我先说说光合作用这件事：它分成光反应和暗反应两段。";

test("失败留档：已下发的前缀落成一条 kind='error' 的 assistant 消息并绑定 run", async () => {
  const { workspaceId, userId } = await seedBase();
  const s = await seedRun(workspaceId, userId, "failed");
  try {
    const written = await persistFailedPartial({
      workspaceId,
      userId,
      conversationId: s.cid,
      runId: s.runId,
      deliveredText: DELIVERED,
    });
    assert.equal(written, true, "够长就该落档");

    const after_ = await readPartial(workspaceId, userId, s.cid, s.runId);
    assert.equal(after_.messages.length, 1);
    assert.equal(after_.messages[0].kind, "error");
    assert.equal(after_.messages[0].run_id, s.runId, "留档绑定本 run（历史才能挂上过程留痕）");
    assert.equal(after_.messages[0].text, DELIVERED, "落的必须是用户看过的那段字");
    assert.equal(after_.assistantMessageId, after_.messages[0].id, "回填 assistant_message_id");
    assert.equal(after_.nextMessageSeq, 3, "会话计数器推进一格");
  } finally {
    await s.cleanup();
  }
});

test("失败留档：太短时不落那句碎片，改落兜底话（fail-open；旧断言的是「什么都不落」）", async () => {
  const { workspaceId, userId } = await seedBase();
  const s = await seedRun(workspaceId, userId, "failed");
  try {
    const written = await persistFailedPartial({
      workspaceId,
      userId,
      conversationId: s.cid,
      runId: s.runId,
      deliveredText: "好，我",
    });
    // 这条用例原来钉的是"太短 ⇒ 不落、返回 false、库里零行"。那次改判有出处：
    // 界面上什么都没有＝"她突然不理人"（抱怨 #4），于是实现换成 fail-open——
    // 半句太短时**落一句诚实的兜底话**（`COMPANION_FAILURE_FALLBACK_LINES`，按 runId 确定性取）。
    // 所以这里翻成两半：仍然"不落碎片原话"（那条护栏没撤），但必须留下一句能看见的话。
    assert.equal(written, true);
    const after_ = await readPartial(workspaceId, userId, s.cid, s.runId);
    assert.equal(after_.messages.length, 1, "太短也要留下一句，不能让用户面对空白");
    assert.notEqual(after_.messages[0].text, "好，我", "碎片原话不许当记录落——这条仍是噪音判据");
    assert.equal(after_.messages[0].text, pickCompanionFailureFallbackLine(s.runId),
      "兜底话必须取自那一份话术表，不能在别处再写一遍");
    assert.equal(after_.assistantMessageId, after_.messages[0].id);
  } finally {
    await s.cleanup();
  }
});

test("失败留档：重复调用幂等，不会插出第二条", async () => {
  const { workspaceId, userId } = await seedBase();
  const s = await seedRun(workspaceId, userId, "failed");
  try {
    assert.equal(await persistFailedPartial({
      workspaceId, userId, conversationId: s.cid, runId: s.runId, deliveredText: DELIVERED,
    }), true);
    assert.equal(await persistFailedPartial({
      workspaceId, userId, conversationId: s.cid, runId: s.runId, deliveredText: DELIVERED,
    }), false, "第二次必须被 fence 挡住");
    const after_ = await readPartial(workspaceId, userId, s.cid, s.runId);
    assert.equal(after_.messages.length, 1);
    assert.equal(after_.nextMessageSeq, 3, "计数器只推进一次");
  } finally {
    await s.cleanup();
  }
});

test("失败留档：run 的终态不是 failed（取消/被接替/仍在跑）时一条都不落", async () => {
  // 每个状态一套独立 fixture：同一个工作区里塞三个会话会让清场把别人留下。
  for (const status of ["cancelled", "superseded", "running"] as const) {
    const { workspaceId, userId } = await seedBase();
    const s = await seedRun(workspaceId, userId, status);
    try {
      assert.equal(await persistFailedPartial({
        workspaceId, userId, conversationId: s.cid, runId: s.runId, deliveredText: DELIVERED,
      }), false, `status=${status} 不该留档`);
      const after_ = await readPartial(workspaceId, userId, s.cid, s.runId);
      assert.equal(after_.messages.length, 0, `status=${status} 不该有消息`);
      assert.equal(after_.assistantMessageId, null);
    } finally {
      await s.cleanup();
    }
  }
});
