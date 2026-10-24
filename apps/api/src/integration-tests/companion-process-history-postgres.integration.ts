import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { listCompanionRunNodes } from "../modules/companion-conversation/turn/companion-events.ts";
import { closeDatabase } from "../db/client.ts";

const databaseUrl = process.env.DATABASE_URL_API ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("companion process history requires a real Postgres database");
// Fixture setup needs to assume the worker role; the application query below
// still uses DATABASE_URL_API through withWorkspaceTransaction.
const db = postgres(process.env.DATABASE_URL_MIGRATOR ?? databaseUrl, { max: 2 });
test.after(async () => { await closeDatabase(); await db.end({ timeout: 2 }); });

test("worker 写入的思考和工具随对话保留：清理实时事件、超过最近 20 轮后仍能回读", async () => {
  const workspaceId = randomUUID(), userId = randomUUID(), conversationId = randomUUID();
  const userMessageId = randomUUID(), assistantMessageId = randomUUID(), runId = randomUUID();
  const entries = [
    { type: "assistant.thinking", payload: { index: 0, text: "先查阅这篇笔记。" } },
    { type: "agent.tool", payload: { tool: { toolCallId: "read", name: "companion_open_card", status: "requested", safeLabel: "打开笔记", privateDiagnostic: "不进入手记档案" } } },
    { type: "assistant.thinking", payload: { index: 1, text: "接着核对材料中的例子。" } },
    { type: "agent.tool", payload: { tool: { toolCallId: "read", name: "companion_open_card", status: "succeeded", safeLabel: "打开笔记", safeSummary: "读到了当时的正文" } } },
  ];
  try {
    await db.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true), set_config('app.user_id', ${userId}, true)`;
      await tx`INSERT INTO users (id,email,password_hash,role) VALUES (${userId},${`process-${userId}@example.test`},'test-hash','owner')`;
      await tx`INSERT INTO workspaces (id,name,owner_id) VALUES (${workspaceId},'手记过程测试',${userId})`;
      await tx`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (${workspaceId},${userId},'owner')`;
      await tx`INSERT INTO companion_conversations (id,workspace_id,user_id,kind,title,title_source,status,next_event_seq)
        VALUES (${conversationId},${workspaceId},${userId},'dialogue','过程测试','placeholder','active',5)`;
      await tx`INSERT INTO companion_messages (id,conversation_id,workspace_id,user_id,role,seq,kind,blocks,content_sha256)
        VALUES (${userMessageId},${conversationId},${workspaceId},${userId},'user',1,'text',${tx.json([{ type: "text", text: "查阅笔记" }])},${"0".repeat(64)})`;
      for (let i = 1; i <= 21; i++) await tx`INSERT INTO companion_turn_runs
        (id,conversation_id,workspace_id,user_id,user_message_id,generation,status,idempotency_key_hash,request_body_hash,created_at)
        VALUES (${i === 1 ? runId : randomUUID()},${conversationId},${workspaceId},${userId},${userMessageId},${i},
          ${i === 1 ? "running" : "succeeded"},${randomUUID()},${"b".repeat(64)},${new Date(Date.now() - (22 - i) * 60_000)})`;
    });
    await db.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true), set_config('app.user_id', ${userId}, true)`;
      await tx`SET LOCAL ROLE astella_worker`;
      for (let i = 0; i < entries.length; i++) await tx`INSERT INTO companion_stream_events
        (conversation_id,seq,workspace_id,user_id,run_id,generation,account_epoch,type,payload,expires_at)
        VALUES (${conversationId},${i + 1},${workspaceId},${userId},${runId},1,0,${entries[i]!.type},${tx.json(entries[i]!.payload)},now() - interval '1 day')`;
    });
    await db.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true), set_config('app.user_id', ${userId}, true)`;
      await tx`INSERT INTO companion_messages (id,conversation_id,workspace_id,user_id,role,seq,kind,blocks,content_sha256,run_id)
        VALUES (${assistantMessageId},${conversationId},${workspaceId},${userId},'assistant',2,'text',${tx.json([{ type: "text", text: "正文已生成。" }])},${"0".repeat(64)},${runId})`;
      await tx`UPDATE companion_turn_runs SET status='succeeded', assistant_message_id=${assistantMessageId}, step_count=2, tool_call_count=1 WHERE id=${runId}`;
      await tx`DELETE FROM companion_stream_events WHERE conversation_id=${conversationId}`;
    });
    const recent = await listCompanionRunNodes({ workspaceId,userId,conversationId,after: 0 });
    assert.ok(recent.ok && !recent.runs.some(run => run.runId === runId));
    const archived = await listCompanionRunNodes({ workspaceId,userId,conversationId,after: 0,includeThinking: true,runIds: [runId] });
    assert.ok(archived.ok);
    assert.equal(archived.items.length, 0);
    assert.equal(archived.runs.length, 1);
    assert.equal(archived.runs[0]!.processTimeline?.length, 4);
    assert.deepEqual(archived.runs[0]!.processTimeline?.map(event => event.seq), [1,2,3,4]);
    assert.equal(archived.runs[0]!.assistantMessageId, assistantMessageId);
    assert.ok(!JSON.stringify(archived.runs[0]!.processTimeline).includes("privateDiagnostic"));
    const forbidden = await listCompanionRunNodes({ workspaceId: randomUUID(),userId,conversationId,after: 0,includeThinking: true,runIds: [runId] });
    assert.equal(forbidden.ok, false);
  } finally {
    await db.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true), set_config('app.user_id', ${userId}, true)`;
      await tx`DELETE FROM companion_stream_events WHERE conversation_id=${conversationId}`;
      await tx`DELETE FROM companion_turn_runs WHERE conversation_id=${conversationId}`;
      await tx`DELETE FROM companion_messages WHERE conversation_id=${conversationId}`;
      await tx`DELETE FROM companion_conversations WHERE id=${conversationId}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id=${workspaceId}`;
      await tx`DELETE FROM workspaces WHERE id=${workspaceId}`;
      await tx`DELETE FROM users WHERE id=${userId}`;
    });
  }
});
