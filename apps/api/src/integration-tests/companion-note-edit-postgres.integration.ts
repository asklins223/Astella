import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import postgres from "postgres";
import { resolveAllCompanionAgentTools } from "@astella/shared";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { withWorkspaceTransaction, closeDatabase } from "../db/client.ts";
import { createNote } from "../modules/note/service.ts";
import { processCompanionNoteEdit } from "../modules/note/companion-edit-dispatch.ts";
import { createCompanionTurn } from "../modules/companion-conversation/turn/turn-service.ts";
import { closeNoteCollaboration } from "../modules/note/collaboration.ts";
import { executeCompanionNoteEdit } from "../../../../workers/ai-worker/src/handlers/companion-note-edit.ts";
import { closeDatabase as closeWorkerDatabase } from "../../../../workers/ai-worker/src/db.ts";
import type { AgentEventContext } from "../../../../workers/ai-worker/src/handlers/companion-read-tools.ts";

const url = testDatabaseUrl("DATABASE_URL_MIGRATOR");
if (!new URL(url).pathname.startsWith("/astella_note_edit_")) throw new Error("Use an isolated astella_note_edit_* database");
const admin = postgres(url, { max: 3 });
after(async () => { await closeNoteCollaboration(); await closeDatabase(); await closeWorkerDatabase(); await admin.end(); });

async function fixture(operation = "append") {
  const workspaceId = randomUUID(), userId = randomUUID(), runId = randomUUID(), jobId = randomUUID(), conversationId = randomUUID(), messageId = randomUUID(), stepId = randomUUID(), callId = randomUUID(), toolCallId = randomUUID();
  const scope = { workspaceId, userId };
  const mutate = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) => admin.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id',${workspaceId},true),set_config('app.user_id',${userId},true)`; return fn(tx);
  });
  await mutate(async tx => {
    await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${userId},${`edit-${userId}@test.invalid`},'h','owner')`;
    await tx`INSERT INTO workspaces(id,name,owner_id) VALUES(${workspaceId},'伴星编辑隔离验证',${userId})`;
    await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
    await tx`INSERT INTO user_companion_account_state(user_id,epoch,global_enabled) VALUES(${userId},0,true)`;
    await tx`INSERT INTO companion_conversations(id,workspace_id,user_id,kind,title,title_source,status,next_message_seq)
      VALUES(${conversationId},${workspaceId},${userId},'dialogue','修改笔记','auto','active',2)`;
    await tx`INSERT INTO companion_messages(id,conversation_id,workspace_id,user_id,role,seq,kind,blocks,content_sha256)
      VALUES(${messageId},${conversationId},${workspaceId},${userId},'user',1,'text',${tx.json([{ type: 'text', text: '追加到这篇筆记最后面' }])},${'0'.repeat(64)})`;
    await tx`INSERT INTO jobs(id,type,workspace_id,requested_by,payload,status,lease_token,started_at)
      VALUES(${jobId},'companion_agent',${workspaceId},${userId},${tx.json({runId})},'running','edit-lease',now())`;
    const permission = { version: 1, level: 'full', offeredTools: resolveAllCompanionAgentTools('full').map(({name,toolVersion,riskClass}) => ({name,toolVersion,riskClass})) };
    await tx`INSERT INTO companion_turn_runs(id,conversation_id,workspace_id,user_id,user_message_id,generation,status,
      idempotency_key_hash,request_body_hash,account_epoch,job_id,permission_level,permission_snapshot)
      VALUES(${runId},${conversationId},${workspaceId},${userId},${messageId},1,'running',${'a'.repeat(64)},${'b'.repeat(64)},0,${jobId},'full',${tx.json(permission)})`;
    await tx`INSERT INTO companion_agent_steps(id,workspace_id,user_id,conversation_id,run_id,step_no,kind,status)
      VALUES(${stepId},${workspaceId},${userId},${conversationId},${runId},1,'model','running')`;
  });
  const saved = await withWorkspaceTransaction(scope, tx => createNote(tx, workspaceId, userId, { title: "原笔记", blocks: [{ type: "paragraph", content: "甲乙丙丁" }, { type: "paragraph", content: "保留段落" }] }));
  const noteId = saved!.note.id, noteVersionId = saved!.version.id;
  const args = { noteId, noteVersionId, operation, ...(operation === "delete_blocks" ? { startBlock: 0, endBlock: 0, expectedBlocks: ["甲乙丙丁"] } : { markdown: "已保存的新内容" }) };
  await mutate(async tx => {
    await tx`UPDATE companion_turn_runs SET page_context=${tx.json({ context: { pageKind: "note", sharing: "page_registered", noteId, noteVersionId,
      editing: { cursor: { block: 0, offset: 2, coordinate: "document", expectedBlock: "甲乙丙丁" } } } })} WHERE id=${runId}`;
    await tx`INSERT INTO companion_agent_tool_calls(id,workspace_id,user_id,conversation_id,run_id,step_id,tool_call_id,name,tool_version,arguments,arguments_sha256,risk_class,status)
      VALUES(${callId},${workspaceId},${userId},${conversationId},${runId},${stepId},${toolCallId},'companion_edit_note','1.0.0',${tx.json(args)},${'c'.repeat(64)},'reversible_low','executing')`;
  });
  const receipt = async () => (await mutate(tx => tx`SELECT result_ref FROM companion_agent_tool_calls WHERE id=${callId}`))[0]?.result_ref;
  const content = async () => (await mutate(tx => tx`SELECT content FROM note_blocks WHERE version_id=(SELECT current_version_id FROM notes WHERE id=${noteId}) ORDER BY ordinal`)).map(row => row.content);
  return { scope, mutate, receipt, content, callId, toolCallId, runId, conversationId, noteId, noteVersionId, userId, workspaceId, jobId };
}

test("真实聊天提交保留当前笔记光标，服务端裁剪不会丢失编辑位置", async () => {
  const f = await fixture();
  await f.mutate(tx => tx`UPDATE companion_turn_runs SET status='cancelled',cancel_requested_at=now() WHERE id=${f.runId}`);
  await f.mutate(tx => tx`UPDATE companion_conversations SET next_generation=2 WHERE id=${f.conversationId}`);
  const editing = { cursor: { block: 0, offset: 2, coordinate: "document", expectedBlock: "甲乙丙丁" } };
  const response = await createCompanionTurn({ ...f.scope, conversationId: f.conversationId, idempotencyKey: randomUUID(), body: {
    version: 1, clientMessageId: randomUUID(), inputKind: "text", sourceSurface: "pet", blocks: [{ type: "text", text: "在光标后插入一句解释" }],
    context: { pageKind: "note", sharing: "page_registered", noteId: f.noteId, noteVersionId: f.noteVersionId, editing },
  } });
  assert.equal(response.statusCode, 202);
  const [run] = await f.mutate(tx => tx`SELECT page_context FROM companion_turn_runs WHERE id=${(response.body as { runId: string }).runId}`);
  assert.deepEqual(run.page_context.context.editing, editing);
});

test("受限 API 修改活文档、落盘与搜索投影，worker 等真实保存回执；重试不重复追加", async () => {
  const f = await fixture(); await processCompanionNoteEdit(f.scope, f.callId);
  const event = { ctx: { workspaceId: f.workspaceId, signal: new AbortController().signal }, read: { userId: f.userId, runId: f.runId } } as AgentEventContext;
  const result = await executeCompanionNoteEdit(event, f.toolCallId);
  assert.equal(result.value.status, "succeeded"); assert.match(result.safeSummary, /已追加/);
  assert.deepEqual(await f.content(), ["甲乙丙丁", "保留段落", "已保存的新内容"]);
  const [search] = await f.mutate(tx => tx`SELECT body FROM search_documents WHERE object_id=${f.noteId}`); assert.match(search.body, /已保存的新内容/);
  await f.mutate(tx => tx`UPDATE companion_agent_tool_calls SET result_ref=NULL WHERE id=${f.callId}`);
  await processCompanionNoteEdit(f.scope, f.callId); assert.equal((await f.content()).filter(text => text === "已保存的新内容").length, 1);
});
test("光标插入与段落删除经同一保存路径实际生效", async () => {
  const f = await fixture("insert_at_cursor"); await processCompanionNoteEdit(f.scope, f.callId);
  assert.deepEqual(await f.content(), ["甲乙已保存的新内容丙丁", "保留段落"]);
  const d = await fixture("delete_blocks"); await processCompanionNoteEdit(d.scope, d.callId); assert.deepEqual(await d.content(), ["保留段落"]);
});
test("停止、账号关闭、只读权限、跨空间和改版阻止编辑", async () => {
  for (const condition of ["cancel", "disabled", "readonly", "scope", "version"]) {
    const f = await fixture();
    await f.mutate(async tx => {
      if (condition === "cancel") await tx`UPDATE companion_turn_runs SET cancel_requested_at=now() WHERE id=${f.runId}`;
      if (condition === "disabled") await tx`UPDATE user_companion_account_state SET global_enabled=false WHERE user_id=${f.userId}`;
      if (condition === "readonly") await tx`UPDATE companion_turn_runs SET permission_level='read_only' WHERE id=${f.runId}`;
      if (condition === "scope") await tx`UPDATE companion_turn_runs SET page_context='{}' WHERE id=${f.runId}`;
      if (condition === "version") await tx`UPDATE companion_agent_tool_calls SET arguments=jsonb_set(arguments,'{noteVersionId}',to_jsonb(${randomUUID()}::text)) WHERE id=${f.callId}`;
    });
    await processCompanionNoteEdit(f.scope, f.callId); assert.equal(JSON.parse(await f.receipt()).kind, "note_edit_failed");
    assert.deepEqual(await f.content(), ["甲乙丙丁", "保留段落"]);
  }
});
test("目标原文变化时拒绝删除，不覆盖新输入", async () => {
  const f = await fixture("delete_blocks");
  await f.mutate(tx => tx`UPDATE companion_agent_tool_calls SET arguments=jsonb_set(arguments,'{expectedBlocks}','["旧原文"]'::jsonb) WHERE id=${f.callId}`);
  await processCompanionNoteEdit(f.scope, f.callId); assert.match(JSON.parse(await f.receipt()).message, /已经变化/);
  assert.deepEqual(await f.content(), ["甲乙丙丁", "保留段落"]);
});
