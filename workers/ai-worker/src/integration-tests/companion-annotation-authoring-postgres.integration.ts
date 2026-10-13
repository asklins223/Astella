import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { noteAnnotationPageV1Schema } from "@astella/shared/note-annotation-contracts";
import { companionWrittenAnnotationV1Schema } from "@astella/shared/companion-note-authoring-contracts";
import { closeDatabase, withWorkerWorkspaceTransaction } from "../db.ts";
import { closeDatabase as closeApiDatabase, withWorkspaceTransaction } from "../../../../apps/api/src/db/client.ts";
import { createNote } from "../../../../apps/api/src/modules/note/service.ts";
import { listNoteAnnotations, changeNoteAnnotation } from "../../../../apps/api/src/modules/note-annotations/service.ts";
import { executeCompanionWriteAnnotation } from "../handlers/companion-annotation-authoring.ts";
import type { AgentEventContext } from "../handlers/companion-read-tools.ts";

const url = testDatabaseUrl("DATABASE_URL_MIGRATOR");
if (!new URL(url).pathname.startsWith("/astella_initiative_")) throw new Error("Use an isolated astella_initiative_* database");
const admin = postgres(url, { max: 2 });
after(async () => { await admin.end(); await closeDatabase(); await closeApiDatabase(); });
const markdown = "## 复利为什么增长\n\n每次计算出的利息都成为下一轮本金的一部分。\n\n```js\nconst nextPrincipal = principal * (1 + rate);\n```\n\n末段：利率和计息周期要使用同一时间单位。";

async function fixture() {
  const scope = { workspaceId: randomUUID(), userId: randomUUID() };
  const jobId = randomUUID(), runId = randomUUID(), conversationId = randomUUID(), messageId = randomUUID(), requestId = randomUUID(), stepId = randomUUID();
  const tx = <T>(action: (connection: postgres.TransactionSql) => Promise<T>) => admin.begin(async connection => {
    await connection`SELECT set_config('app.workspace_id',${scope.workspaceId},true),set_config('app.user_id',${scope.userId},true)`;
    return action(connection);
  });
  await tx(async t => {
    await t`INSERT INTO users(id,email,password_hash,role) VALUES(${scope.userId},${`annotation-${scope.userId}@test.invalid`},'h','owner')`;
    await t`INSERT INTO workspaces(id,name,owner_id) VALUES(${scope.workspaceId},'独立批注回归',${scope.userId})`;
    await t`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${scope.workspaceId},${scope.userId},'owner')`;
    await t`INSERT INTO user_companion_account_state(user_id,epoch,global_enabled) VALUES(${scope.userId},0,true)`;
  });
  const created = await withWorkspaceTransaction(scope, t => createNote(t, scope.workspaceId, scope.userId,
    { title: "复利", blocks: [{ type: "paragraph", content: "利息加入本金后，下一次也会继续产生利息。" }] }));
  assert.ok(created);
  const [block] = await tx(t => t`SELECT ordinal,content FROM note_blocks WHERE version_id=${created.version.id} ORDER BY ordinal`);
  const anchor = { noteVersionId: created.version.id, startBlockOrdinal: Number(block!.ordinal), endBlockOrdinal: Number(block!.ordinal),
    startOffset: 0, endOffset: 7, excerpt: "利息加入本金后", prefix: "", suffix: "，下一次也会继续产生利息。" };
  const pageContext = { version: 1, context: { pageKind: "note", sharing: "page_registered", noteId: created.note.id,
    noteVersionId: created.version.id, replyPurpose: "annotation", annotationTarget: { requestId, anchor } },
    selection: { text: anchor.excerpt, sharing: "user_selected" } };
  await tx(async t => {
    await t`INSERT INTO companion_conversations(id,workspace_id,user_id,kind,title,title_source,status,next_message_seq)
      VALUES(${conversationId},${scope.workspaceId},${scope.userId},'dialogue','解释原句','auto','active',2)`;
    await t`INSERT INTO companion_messages(id,conversation_id,workspace_id,user_id,role,seq,kind,blocks,content_sha256)
      VALUES(${messageId},${conversationId},${scope.workspaceId},${scope.userId},'user',1,'text',${t.json([{type:'text',text:'解释这句'}])},${'0'.repeat(64)})`;
    await t`INSERT INTO jobs(id,type,workspace_id,requested_by,payload,status,lease_token,started_at)
      VALUES(${jobId},'companion_agent',${scope.workspaceId},${scope.userId},${t.json({runId})},'running','annotation-lease',now())`;
    await t`INSERT INTO companion_turn_runs(id,conversation_id,workspace_id,user_id,user_message_id,generation,status,
      idempotency_key_hash,request_body_hash,account_epoch,job_id,permission_level,permission_snapshot,page_context)
      VALUES(${runId},${conversationId},${scope.workspaceId},${scope.userId},${messageId},1,'running',${'a'.repeat(64)},${'b'.repeat(64)},0,${jobId},'guided',
      ${t.json({offeredTools:[{name:'companion_write_annotation'}]})},${t.json(pageContext)})`;
    await t`INSERT INTO companion_agent_steps(id,workspace_id,user_id,conversation_id,run_id,step_no,kind,status)
      VALUES(${stepId},${scope.workspaceId},${scope.userId},${conversationId},${runId},1,'model','running')`;
    await t`INSERT INTO companion_agent_tool_calls(id,workspace_id,user_id,conversation_id,run_id,step_id,tool_call_id,name,
      tool_version,arguments,arguments_sha256,risk_class,status)
      VALUES(${randomUUID()},${scope.workspaceId},${scope.userId},${conversationId},${runId},${stepId},'write-quote','companion_write_annotation',
      '1.0.0',${t.json({markdown})},${'c'.repeat(64)},'reversible_low','executing')`;
  });
  const event = { ctx: { id: jobId, ...scope, requestedBy: scope.userId, leaseToken: 'annotation-lease', payload: {runId}, signal: new AbortController().signal },
    read: { ...scope, runId, conversationId, userMessageId: messageId, userText: "解释这句", accountEpoch: 0, generation: 1, pageContext },
    constraints: {}, expiresAt: new Date(Date.now()+60_000).toISOString() } as unknown as AgentEventContext;
  return { scope, event, requestId, anchor, noteId: created.note.id, tx };
}

test("写工具独立保存全文，API重开、编辑仍读到末段和代码；无需聊天消息身份", async () => {
  const f = await fixture();
  const result = await executeCompanionWriteAnnotation(f.event, { markdown }, undefined, "write-quote");
  const receipt = companionWrittenAnnotationV1Schema.parse(JSON.parse(result.resultRef!));
  assert.equal(receipt.annotation.explanation, markdown);
  assert.equal(receipt.annotation.sourceMessageId, null);
  assert.equal(receipt.requestId, f.requestId);
  const reopened = await withWorkspaceTransaction(f.scope, t => listNoteAnnotations(t, f.scope, f.noteId, {}));
  assert.equal(noteAnnotationPageV1Schema.parse(reopened).items[0]!.explanation, markdown);
  const edited = await withWorkspaceTransaction(f.scope, t => changeNoteAnnotation(t, f.scope, f.noteId, f.requestId,
    { expectedRevision: 1, explanation: markdown + "\n\n用户新增的理解。" }));
  assert.ok("explanation" in edited && edited.explanation.endsWith("用户新增的理解。"));
  const replay = await executeCompanionWriteAnnotation(f.event, { markdown: "重试不能覆盖用户的编辑。" }, undefined, "write-quote");
  assert.ok(JSON.parse(replay.resultRef!).annotation.explanation.endsWith("用户新增的理解。"));
  const [count] = await f.tx(t => t`SELECT count(*)::int AS n FROM note_annotations WHERE generation_job_id=${f.event.ctx.id}`);
  assert.equal(count!.n, 1);
});

test("停止后不写半份解释", async () => {
  const f = await fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(executeCompanionWriteAnnotation(f.event, {markdown}, controller.signal, "write-quote"), /已停止/);
  const [count] = await f.tx(t => t`SELECT count(*)::int AS n FROM note_annotations WHERE id=${f.requestId}`);
  assert.equal(count!.n, 0);
});

test("取消或原句篡改都不能写入", async () => {
  const f = await fixture();
  const forged = structuredClone(f.event.read.pageContext) as typeof f.event.read.pageContext & { context: { annotationTarget: { anchor: { startOffset: number } } } };
  forged.context.annotationTarget.anchor.startOffset = 1;
  await assert.rejects(executeCompanionWriteAnnotation({...f.event, read:{...f.event.read,pageContext:forged}}, {markdown}, undefined, "write-quote"));
  await f.tx(t => t`UPDATE companion_turn_runs SET cancel_requested_at=now() WHERE id=${f.event.read.runId}`);
  await assert.rejects(executeCompanionWriteAnnotation(f.event, {markdown}, undefined, "write-quote"), /已失效/);
  const [count] = await f.tx(t => t`SELECT count(*)::int AS n FROM note_annotations WHERE id=${f.requestId}`);
  assert.equal(count!.n, 0);
});

test("后台主动参与不能替用户创建批注", async () => {
  const f = await fixture();
  await assert.rejects(executeCompanionWriteAnnotation({...f.event,read:{...f.event.read,userMessageId:null}}, {markdown}, undefined, "write-quote"), /重新发起解释/);
  await withWorkerWorkspaceTransaction(f.scope, async t => {
    const rows = await t.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM note_annotations WHERE id=${f.requestId}`);
    assert.equal(rows[0]!.n, 0);
  });
});

test("完整写入就是终态，附带的无效发言不再产生额外模型调用", async () => {
  const f = await fixture();
  await f.tx(async t => {
    await t`INSERT INTO user_ai_settings(user_id,consent_version,consent_at,data_policy)
      VALUES(${f.scope.userId},'integration-test-v1',now(),${t.json({sendToExternal:false,sendImageContent:false,piiDetection:true,auditLogging:true})})`;
    await t`DELETE FROM companion_agent_tool_calls WHERE run_id=${f.event.read.runId}`;
    await t`DELETE FROM companion_agent_steps WHERE run_id=${f.event.read.runId}`;
    await t`UPDATE companion_turn_runs SET status='accepted',permission_snapshot=NULL WHERE id=${f.event.read.runId}`;
  });
  process.env.AI_PROVIDER = "mock";
  process.env.COMPANION_DIALOGUE_V1_ENABLED = "true";
  delete process.env.AI_PLATFORMS_PATH;
  const { MockProvider } = await import("../lib/providers/mock.ts");
  const { runCompanionDialogue } = await import("../handlers/companion-dialogue.ts");
  const original = MockProvider.prototype.executeAgentTurn;
  const stream = Object.getOwnPropertyDescriptor(MockProvider.prototype, "chatCompletionStream")!;
  let calls = 0;
  MockProvider.prototype.executeAgentTurn = async request => {
    assert.equal(++calls, 1, "完整产物已写入，不能为了无效的附带发言再次调模型");
    assert.ok(request.tools.some(tool => tool.name === "companion_write_annotation"));
    return { content: "", toolCalls: [
      { id: "write-formal-explanation", name: "companion_write_annotation", arguments: { markdown } },
      { id: "invalid-optional-speech", name: "companion_publish_utterance", arguments: { text: "（这轮没有需要补充的新内容，安静收尾。）" } },
    ], finishReason: "tool_calls", usage: {promptTokens:10,completionTokens:10}, providerRequestId: null };
  };
  Object.defineProperty(MockProvider.prototype,"chatCompletionStream",{...stream,value:undefined});
  try { await runCompanionDialogue(f.event.ctx); }
  finally { MockProvider.prototype.executeAgentTurn=original; Object.defineProperty(MockProvider.prototype,"chatCompletionStream",stream); }
  await f.tx(async t => {
    const [run] = await t`SELECT status,model_call_count,step_count FROM companion_turn_runs WHERE id=${f.event.read.runId}`;
    assert.equal(run!.status,"succeeded"); assert.equal(run!.model_call_count,1); assert.equal(run!.step_count,1);
    const [saved] = await t`SELECT explanation FROM note_annotations WHERE id=${f.requestId}`;
    assert.equal(saved!.explanation,markdown);
    const messages = await t`SELECT blocks FROM companion_messages WHERE run_id=${f.event.read.runId} AND role='assistant'`;
    assert.equal(messages.length,0);
  });
});
