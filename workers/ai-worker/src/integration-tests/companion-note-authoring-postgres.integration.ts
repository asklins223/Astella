import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import postgres from "postgres";
import { getCompanionAgentTool, resolveAllCompanionAgentTools } from "@astella/shared";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { createPrivateNoteRecords } from "@astella/agent-host";
import { executeCompanionCreateNote, companionCreatedNoteId,
  type CompanionNoteAuthoringEvent } from "../handlers/note/companion-note-authoring.ts";
import { executeReadTool } from "../handlers/tools/companion-tool-execution.ts";
import type { AgentEventContext } from "../handlers/tools/companion-read-tools.ts";
import { closeDatabase, withWorkerWorkspaceTransaction } from "../db.ts";
import { withWorkspaceTransaction, closeDatabase as closeApiDatabase } from "../../../../apps/api/src/db/client.ts";
import { createNote, getNoteWithVersion } from "../../../../apps/api/src/modules/note/service.ts";
import { loadNoteDoc, applyNoteDocUpdate } from "../../../../apps/api/src/modules/note/document-state.ts";
import { projectFragmentBlocks, writeFragmentBlocks } from "../../../../apps/api/src/modules/note/doc-fragment.ts";
import { persistFailedPartial } from "../handlers/turn/companion-dialogue-failure-retention.ts";
import { resumeCompanionRun } from "../../../../apps/api/src/modules/companion-conversation/turn/companion-resume.ts";

const dbUrl = testDatabaseUrl("DATABASE_URL_MIGRATOR");
if (!new URL(dbUrl).pathname.startsWith("/astella_note_authoring_")) throw new Error("Use an isolated astella_note_authoring_* database");
const admin = postgres(dbUrl, { max: 2 });
after(async () => { await admin.end(); await closeDatabase(); await closeApiDatabase(); });
const ARTICLE = "# 电功率\n\n电功率表示单位时间内转换的电能。直流电路中 P = UI；纯电阻且适用欧姆定律时，也可写成 P = I²R。\n\n不能把恒定电压与恒定电流两个条件混为一谈。";

async function fixture(options: { userText?: string; searchCompleted?: boolean; noteLibraryReadEnabled?: boolean } = {}) {
  const workspaceId = randomUUID(), userId = randomUUID(), runId = randomUUID(), jobId = randomUUID();
  const conversationId = randomUUID(), messageId = randomUUID(), stepId = randomUUID(), creationCallId = randomUUID();
  const userText = options.userText ?? "把刚才聊的电功率写成一篇笔记，链接相关笔记。";
  const mutate = <T>(action: (tx: postgres.TransactionSql) => Promise<T>) => admin.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id',${workspaceId},true),set_config('app.user_id',${userId},true)`;
    return action(tx);
  });
  await mutate(async tx => {
    await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${userId},${`authoring-${userId}@test.invalid`},'h','owner')`;
    await tx`INSERT INTO workspaces(id,name,owner_id) VALUES(${workspaceId},'笔记创建隔离回归',${userId})`;
    await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
    await tx`INSERT INTO user_companion_account_state(user_id,epoch,global_enabled) VALUES(${userId},0,true)`;
    await tx`INSERT INTO companion_conversations(id,workspace_id,user_id,kind,title,title_source,status,next_message_seq)
      VALUES(${conversationId},${workspaceId},${userId},'dialogue','知识点讨论','auto','active',2)`;
    await tx`INSERT INTO companion_messages(id,conversation_id,workspace_id,user_id,role,seq,kind,blocks,content_sha256)
      VALUES(${messageId},${conversationId},${workspaceId},${userId},'user',1,'text',
        ${tx.json([{ type: 'text', text: userText }])},${'0'.repeat(64)})`;
    await tx`INSERT INTO jobs(id,type,workspace_id,requested_by,payload,status,lease_token,started_at)
      VALUES(${jobId},'companion_agent',${workspaceId},${userId},${tx.json({runId})},'running','authoring-lease',now())`;
    const permissionSnapshot = { version: 1, level: 'full', offeredTools: resolveAllCompanionAgentTools('full', {
      noteLibraryReadEnabled: options.noteLibraryReadEnabled !== false,
    }).map(({name,toolVersion,riskClass}) => ({name,toolVersion,riskClass})) };
    await tx`INSERT INTO companion_turn_runs(id,conversation_id,workspace_id,user_id,user_message_id,generation,status,
      idempotency_key_hash,request_body_hash,account_epoch,job_id,permission_level,permission_snapshot)
      VALUES(${runId},${conversationId},${workspaceId},${userId},${messageId},1,'running',${'a'.repeat(64)},${'b'.repeat(64)},0,${jobId},'full',${tx.json(permissionSnapshot)})`;
    await tx`INSERT INTO companion_agent_steps(id,workspace_id,user_id,conversation_id,run_id,step_no,kind,status)
      VALUES(${stepId},${workspaceId},${userId},${conversationId},${runId},1,'model','running')`;
  });
  const record = (name: string, args: Record<string, unknown>, status = "succeeded", resultRef: string | null = null) => mutate(tx => tx`
    INSERT INTO companion_agent_tool_calls(id,workspace_id,user_id,conversation_id,run_id,step_id,tool_call_id,name,
      tool_version,arguments,arguments_sha256,risk_class,status,result_ref)
    VALUES(${randomUUID()},${workspaceId},${userId},${conversationId},${runId},${stepId},${name === 'notes.write.create' ? creationCallId : randomUUID()},${name},'1.0.0',
      ${JSON.stringify(args)}::jsonb,${'c'.repeat(64)},${name === 'notes.write.create' ? 'reversible_low' : 'read'},${status},${resultRef})`);
  if (options.searchCompleted !== false) await record("notes.read.search", { query: "电功率 欧姆定律" });
  await record("notes.write.create", { title: "电功率", markdown: ARTICLE, links: [] }, "executing");
  const event: CompanionNoteAuthoringEvent = {
    ctx: { id: jobId, workspaceId, requestedBy: userId, leaseToken: 'authoring-lease', payload: { runId }, signal: new AbortController().signal },
    read: { userId, runId, accountEpoch: 0, generation: 1, userText },
  };
  const related = await withWorkspaceTransaction({workspaceId,userId}, tx => createNote(tx, workspaceId, userId, {
    title: "欧姆定律基础", blocks: [{type:'paragraph',content:'在温度等物理条件不变的导体中，电压与电流的比值为电阻，可写为 U = IR。'}],
  }));
  assert.ok(related);
  return { event, mutate, record, creationCallId, scope: {workspaceId,userId}, related };
}

async function readRelated(f: Awaited<ReturnType<typeof fixture>>) {
  // Real read executor supplies the frozen read receipt; only the surrounding
  // mock provider ledger is fixture data.
  const args = { noteId: f.related.note.id, noteVersionId: f.related.version.id };
  const read = await executeReadTool(f.event as AgentEventContext, getCompanionAgentTool("companion_notes_read")!, { action: "read", ...args });
  await f.record("notes.read.read", args, "succeeded", read.resultRef!);
  return { ...args, reason: "提供 U、I、R 的关系，说明 P = I²R 的推导与适用条件" };
}

test("引用预览使用真实读取的对象、版本与段落，来源重读不伪造笔记身份", async () => {
  const f = await fixture(), sourceId = randomUUID();
  const note = await executeReadTool(f.event as AgentEventContext, getCompanionAgentTool("companion_notes_read")!,
    { action: "read", noteId: f.related.note.id, noteVersionId: f.related.version.id, startOrdinal: 1 });
  const noteQuote = note.blocks?.find(block => block.type === "quote");
  assert.ok(noteQuote?.type === "quote");
  assert.deepEqual(noteQuote.sourceRef, { kind: "note", noteId: f.related.note.id, noteVersionId: f.related.version.id, blockOrdinal: 1 });
  await f.mutate(async tx => {
    await tx`INSERT INTO sources(id,workspace_id,type,title,status,created_by) VALUES(${sourceId},${f.scope.workspaceId},'text','实际来源','ready',${f.scope.userId})`;
    await tx`INSERT INTO source_segments(source_id,workspace_id,ordinal,text,char_start,char_end)
      VALUES(${sourceId},${f.scope.workspaceId},2,'实际来源段落',0,6)`;
  });
  const source = await executeReadTool(f.event as AgentEventContext, getCompanionAgentTool("companion_notes_read")!, { action: "source", sourceId, startOrdinal: 2 });
  const sourceQuote = source.blocks?.find(block => block.type === "quote");
  assert.ok(sourceQuote?.type === "quote");
  assert.deepEqual(sourceQuote.sourceRef, { kind: "source", sourceId, segmentOrdinal: 2 });
});

test("从讨论直接保存独立笔记，真实链接、搜索和CRDT编辑都能读到同一份内容", async () => {
  const f = await fixture(), link = await readRelated(f);
  const result = await executeCompanionCreateNote(f.event, { title: "电功率", markdown: ARTICLE, links: [link] }, undefined, f.creationCallId);
  const noteId = String(result.value.noteId), versionId = String(result.value.noteVersionId);
  assert.equal(noteId, companionCreatedNoteId(f.event.read.runId, f.creationCallId));
  assert.equal(result.blocks?.[0]?.type, "nav");
  assert.equal((result.value.linkedNotes as unknown[]).length, 1);
  await withWorkspaceTransaction(f.scope, async tx => {
    const saved = await getNoteWithVersion(tx, noteId, f.scope.workspaceId, f.scope.userId);
    assert.ok(saved);
    assert.equal(saved.note.shareScope, "private");
    assert.equal(saved.version.id, versionId);
    const body = saved.blocks.map(block => block.content).join("\n");
    assert.match(body, new RegExp(`astella-note:${link.noteId}`));
    assert.match(body, /欧姆定律基础/);
    const { doc } = await loadNoteDoc(tx, { ...f.scope, noteId });
    assert.match(projectFragmentBlocks(doc).map(block => block.content).join("\n"), /P = UI/);
    doc.destroy();
    await applyNoteDocUpdate(tx, { ...f.scope, noteId }, versionId, doc => {
      writeFragmentBlocks(doc, [...saved.blocks, { type: "paragraph", content: "用户补写：固定电压时要另核对电阻变化。" }]);
    });
    const edited = await getNoteWithVersion(tx, noteId, f.scope.workspaceId, f.scope.userId);
    assert.match(edited!.blocks.map(block => block.content).join("\n"), /用户补写/);
  });
  const [row] = await f.mutate(tx => tx`SELECT n.share_scope,s.body,v.content_hash=md5(v.content_json::text) AS hash_ok
    FROM notes n JOIN note_versions v ON v.id=n.current_version_id JOIN search_documents s ON s.object_id=n.id
    WHERE n.id=${noteId}`);
  assert.equal(row.hash_ok, true);
  assert.match(row.body, /用户补写/);
  const replay = await executeCompanionCreateNote(f.event, { title: "重试不改标题", markdown: ARTICLE + "这一句不应覆盖用户修改。", links: [] }, undefined, f.creationCallId);
  assert.equal(replay.value.noteId, noteId);
  const [count] = await f.mutate(tx => tx`SELECT count(*)::int AS n FROM notes WHERE id=${noteId}`);
  assert.equal(count.n, 1);
});

test("一篇长笔记能保存八条已读关联，正文和末尾都完整落库", async () => {
  const f = await fixture();
  const links = [await readRelated(f)];
  for (let index = 1; index < 8; index += 1) {
    const related = await withWorkspaceTransaction(f.scope, tx => createNote(tx, f.scope.workspaceId, f.scope.userId, {
      title: `电功率关联 ${index}`, blocks: [{ type: "paragraph", content: `关联 ${index} 解释功率与电路的具体条件。` }],
    }));
    assert.ok(related);
    const args = { noteId: related.note.id, noteVersionId: related.version.id };
    const read = await executeReadTool(f.event as AgentEventContext, getCompanionAgentTool("companion_notes_read")!, { action: "read", ...args });
    await f.record("notes.read.read", args, "succeeded", read.resultRef!);
    links.push({ ...args, reason: `第 ${index} 篇提供推导的具体条件与依据` });
  }
  const markdown = ARTICLE + "\n\n" + "功率的适用条件需要结合电路的电压与电流核对。".repeat(2_000) + "正文最后一句仍完整保留。";
  const result = await executeCompanionCreateNote(f.event, { title: "长电功率笔记", markdown, links }, undefined, f.creationCallId);
  assert.equal((result.value.linkedNotes as unknown[]).length, 8);
  await withWorkspaceTransaction(f.scope, async tx => {
    const saved = await getNoteWithVersion(tx, String(result.value.noteId), f.scope.workspaceId, f.scope.userId);
    const body = saved!.blocks.map(block => block.content).join("\n");
    assert.ok(body.includes("正文最后一句仍完整保留。"));
    for (const link of links) assert.ok(body.includes(`astella-note:${link.noteId}`));
  });
});

test("超过旧 2 MiB 的内部笔记写入完整保存，不借用传输帧配额拒收正文", async () => {
  const f = await fixture();
  const paragraphs = Array.from({ length: 20 }, (_, index) => `段落 ${index + 1}\n` + "完整原文内容。".repeat(10_000));
  const markdown = "# 完整长笔记\n\n" + paragraphs.join("\n\n") + "\n\n末尾原文完整保留。";
  assert.ok(Buffer.byteLength(markdown) > 2 * 1024 * 1024);
  const result = await executeCompanionCreateNote(f.event, { title: "完整长笔记", markdown, links: [] }, undefined, f.creationCallId);
  await withWorkspaceTransaction(f.scope, async tx => {
    const saved = await getNoteWithVersion(tx, String(result.value.noteId), f.scope.workspaceId, f.scope.userId);
    const body = saved!.blocks.map(block => block.content).join("\n\n");
    assert.ok(body.includes("末尾原文完整保留。"));
    for (const paragraph of paragraphs) assert.ok(body.includes(paragraph));
  });
});

test("独立笔记无需检索；关联须读真实版本，已知对象不强制先搜索", async () => {
  const f = await fixture();
  await f.mutate(tx => tx`DELETE FROM companion_agent_tool_calls WHERE run_id=${f.event.read.runId} AND name='notes.read.search'`);
  const saved = await executeCompanionCreateNote(f.event, { title: "电功率", markdown: ARTICLE }, undefined, f.creationCallId);
  assert.deepEqual(saved.value.linkedNotes, [], "an independent note needs no search receipt");

  const linked = await fixture({ searchCompleted: false });
  await assert.rejects(executeCompanionCreateNote(linked.event, { title: "电功率", markdown: ARTICLE,
    links: [{ noteId: linked.related.note.id, noteVersionId: linked.related.version.id, reason: "提供 U、I、R 的关系" }] },
  undefined, linked.creationCallId), /关联|读取/);
  const link = await readRelated(linked);
  const direct = await executeCompanionCreateNote(linked.event, { title: "直接关联", markdown: ARTICLE, links: [link] }, undefined, linked.creationCallId);
  assert.equal((direct.value.linkedNotes as unknown[]).length, 1);
  assert.equal((await linked.mutate(tx => tx`SELECT count(*)::int AS n FROM companion_agent_tool_calls WHERE run_id=${linked.event.read.runId} AND name='notes.read.search'`))[0]?.n, 0);
});

test("用户明确要求不读其他资料时，不暴露或执行库搜索仍可保存独立笔记", async () => {
  const f = await fixture({ userText: "把电功率整理成笔记，不要读取其他资料。", searchCompleted: false, noteLibraryReadEnabled: false });
  const readEvent = { ...f.event, constraints: { noteLibraryReadEnabled: false } } as AgentEventContext;
  assert.equal(resolveAllCompanionAgentTools("full", readEvent.constraints).some(tool => tool.name === "companion_notes_read"), false);
  await assert.rejects(
    executeReadTool(readEvent, getCompanionAgentTool("companion_notes_read")!, { action: "search", query: "电功率" }),
    /要求不读取笔记库/,
  );
  const saved = await executeCompanionCreateNote(f.event, { title: "电功率", markdown: ARTICLE, links: [] }, undefined, f.creationCallId);
  assert.deepEqual(saved.value.linkedNotes, []);
  assert.equal((await f.mutate(tx => tx`SELECT count(*)::int AS count FROM companion_agent_tool_calls
    WHERE run_id=${f.event.read.runId} AND name='notes.read.search'`))[0]?.count, 0);
});

test("只凭标题、未读版本、改版或跨空间的关联不落库", async () => {
  const f = await fixture();
  const args = { title: "电功率", markdown: ARTICLE, links: [{ noteId: f.related.note.id, noteVersionId: f.related.version.id, reason: "提供适用条件与电阻的关系" }] };
  await assert.rejects(executeCompanionCreateNote(f.event, args, undefined, f.creationCallId), /尚未读取/);
  await readRelated(f);
  const newerVersionId = randomUUID();
  await f.mutate(async tx => {
    await tx`INSERT INTO note_versions(id,note_id,workspace_id,version_no,content_json,content_hash,created_by)
      VALUES(${newerVersionId},${f.related.note.id},${f.scope.workspaceId},2,'{"blocks":[]}',${'d'.repeat(32)},${f.scope.userId})`;
    await tx`UPDATE notes SET current_version_id=${newerVersionId} WHERE id=${f.related.note.id}`;
  });
  await assert.rejects(executeCompanionCreateNote(f.event, args, undefined, f.creationCallId), /已经改版/);
  await f.mutate(tx => tx`UPDATE notes SET current_version_id=${f.related.version.id} WHERE id=${f.related.note.id}`);
  const other = await fixture();
  const foreignLink = { noteId: other.related.note.id, noteVersionId: other.related.version.id, reason: "不能跨空间取资料" };
  await f.record("notes.read.read", foreignLink, "succeeded", JSON.stringify({kind:"note_read",noteId:foreignLink.noteId,noteVersionId:foreignLink.noteVersionId}));
  await assert.rejects(executeCompanionCreateNote(f.event, { ...args, links: [foreignLink] }, undefined, f.creationCallId), /当前不可见/);
  await f.mutate(tx => tx`UPDATE notes SET deleted_at=now() WHERE id=${f.related.note.id}`);
  await assert.rejects(executeCompanionCreateNote(f.event, args, undefined, f.creationCallId), /尚未读取/);
  await assert.rejects(executeCompanionCreateNote(f.event, { ...args, markdown: ARTICLE + "\n\n[[只凭标题造链接]]" }, undefined, f.creationCallId), /库内链接还没有核对/);
  const [row] = await f.mutate(tx => tx`SELECT count(*)::int AS n FROM notes WHERE id=${companionCreatedNoteId(f.event.read.runId, f.creationCallId)}`);
  assert.equal(row.n, 0);
});

test("停止、只读和取消信号都阻止创建；受限worker没有直接改笔记的权限", async () => {
  const f = await fixture(), input = { title: "电功率", markdown: ARTICLE };
  await f.mutate(tx => tx`UPDATE companion_turn_runs SET permission_level='read_only' WHERE id=${f.event.read.runId}`);
  await assert.rejects(executeCompanionCreateNote(f.event, input, undefined, f.creationCallId), /保存权限/);
  await f.mutate(tx => tx`UPDATE companion_turn_runs SET permission_level='full',cancel_requested_at=now() WHERE id=${f.event.read.runId}`);
  await assert.rejects(executeCompanionCreateNote(f.event, input, undefined, f.creationCallId), /已停止/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(executeCompanionCreateNote(f.event, input, abort.signal, f.creationCallId), /已经停止/);
  await assert.rejects(withWorkerWorkspaceTransaction(f.scope, tx =>
    createPrivateNoteRecords(tx, f.scope, { title: "越过聊天", titleSource: "manual", blocks: [] })),
  (error: unknown) => error instanceof Error && (error.cause as {code?:string})?.code === "42501");
  const [privileges] = await f.mutate(tx => tx`SELECT has_table_privilege('astella_worker','notes','INSERT') AS can_insert,
    has_table_privilege('astella_worker','notes','UPDATE') AS can_update,
    has_function_privilege('astella_worker','astella_create_private_note_v1(uuid,uuid,uuid,uuid,text,text,jsonb,uuid)','EXECUTE') AS can_create`);
  assert.equal(privileges.can_insert, false); assert.equal(privileges.can_update, false); assert.equal(privileges.can_create, true);
});

test("保存后的最终回复失败，历史仍交付真实笔记入口，重试留档不重复写笔记", async () => {
  const f = await fixture();
  const saved = await executeCompanionCreateNote(f.event, { title: "电功率", markdown: ARTICLE }, undefined, f.creationCallId);
  await f.mutate(async tx => {
    await tx`UPDATE companion_agent_tool_calls SET status='succeeded' WHERE run_id=${f.event.read.runId} AND name='notes.write.create'`;
    await tx`UPDATE companion_turn_runs SET status='failed',error_code='PROVIDER_UNAVAILABLE' WHERE id=${f.event.read.runId}`;
  });
  const [turn] = await f.mutate(tx => tx`SELECT conversation_id FROM companion_turn_runs WHERE id=${f.event.read.runId}`);
  const args = { ...f.scope, runId: f.event.read.runId, conversationId: String(turn.conversation_id), deliveredText: "" };
  assert.equal(await persistFailedPartial(args), true);
  assert.equal(await persistFailedPartial(args), false);
  const [message] = await f.mutate(tx => tx`SELECT m.blocks,r.status FROM companion_messages m
    JOIN companion_turn_runs r ON r.assistant_message_id=m.id WHERE r.id=${f.event.read.runId}`);
  assert.equal(message.status, "failed");
  assert.match(message.blocks[0].text, /笔记.*已保存.*无需重复生成/);
  assert.deepEqual(message.blocks[1].route, { kind: "note", noteId: saved.value.noteId, noteVersionId: saved.value.noteVersionId });
});

test("保存已提交但外层回执丢失时，只核对原对象与版本，不重新生成或写入", async () => {
  const f = await fixture();
  const saved = await executeCompanionCreateNote(f.event, { title: "电功率", markdown: ARTICLE, links: [] }, undefined, f.creationCallId);
  await f.mutate(async tx => {
    await tx`UPDATE companion_agent_tool_calls SET status='outcome_unknown' WHERE run_id=${f.event.read.runId} AND tool_call_id=${f.creationCallId}`;
    await tx`UPDATE companion_turn_runs SET status='failed',error_code='PROVIDER_IDLE_TIMEOUT' WHERE id=${f.event.read.runId}`;
  });
  const request = { ...f.scope, runId: f.event.read.runId, body: { version: 1, generation: 1, expectedEventCursor: 0, reconcileOnly: true } };
  const first = await resumeCompanionRun(request);
  assert.equal(first.body.reconciledCount, 1); assert.equal(first.body.unresolvedCount, 0);
  const repeated = await resumeCompanionRun(request);
  assert.equal(repeated.body.reconciledCount, 0);
  const [call] = await f.mutate(tx => tx`SELECT status,result_ref FROM companion_agent_tool_calls WHERE run_id=${f.event.read.runId} AND tool_call_id=${f.creationCallId}`);
  assert.equal(call.status, "succeeded");
  assert.equal(JSON.parse(call.result_ref).noteVersionId, saved.value.noteVersionId);
  const events = await f.mutate(tx => tx`SELECT payload FROM companion_stream_events WHERE run_id=${f.event.read.runId} AND type='agent.tool'`);
  assert.equal(events.length, 1); assert.equal(events[0].payload.tool.noteCreated.noteId, saved.value.noteId);
  const [notes] = await f.mutate(tx => tx`SELECT count(*)::int AS n FROM notes WHERE workspace_id=${f.scope.workspaceId}`);
  assert.equal(notes.n, 2); // original related note + exactly one created note
  const [jobs] = await f.mutate(tx => tx`SELECT count(*)::int AS n FROM jobs WHERE workspace_id=${f.scope.workspaceId}`);
  assert.equal(jobs.n, 1);
});

test("保存凭据损坏或对象已删除时，核对保留未知结果，不凭标题宣称成功", async () => {
  for (const deleted of [false, true]) {
    const f = await fixture();
    const saved = await executeCompanionCreateNote(f.event, { title: "电功率", markdown: ARTICLE, links: [] }, undefined, f.creationCallId);
    await f.mutate(async tx => {
      await tx`UPDATE companion_turn_runs SET status='failed',error_code='PROVIDER_IDLE_TIMEOUT' WHERE id=${f.event.read.runId}`;
      if (deleted) await tx`UPDATE notes SET deleted_at=now() WHERE id=${String(saved.value.noteId)}`;
      await tx`UPDATE companion_agent_tool_calls SET status='outcome_unknown',result_ref=${deleted ? saved.resultRef! : '{"kind":"created_note"}'} WHERE run_id=${f.event.read.runId} AND tool_call_id=${f.creationCallId}`;
    });
    const result = await resumeCompanionRun({ ...f.scope, runId: f.event.read.runId,
      body: { version: 1, generation: 1, expectedEventCursor: 0, reconcileOnly: true } });
    assert.equal(result.body.reconciledCount, 0); assert.equal(result.body.unresolvedCount, 1);
  }
});

test("自动关联前的库内检索不向模型暴露同空间其他成员的私有笔记", async () => {
  const f = await fixture(), other = await fixture(), privateId = randomUUID(), sharedId = randomUUID();
  await f.mutate(async tx => {
    for (const [id, shareScope] of [[privateId, "private"], [sharedId, "shared"]]) {
      await tx`INSERT INTO notes(id,workspace_id,title,created_by,share_scope)
        VALUES(${id},${f.scope.workspaceId},'检索隔离专用标记',${other.scope.userId},${shareScope})`;
    }
  });
  const result = await executeReadTool(f.event as AgentEventContext, getCompanionAgentTool("companion_notes_read")!, { action: "search", query: "检索隔离专用标记" });
  const found = result.value.notes as Array<{noteId:string}>;
  assert.deepEqual(found.map(note => note.noteId), [sharedId]);
});

test("自动关联按多个概念取候选，不要求旧笔记包含新笔记的全部主题词", async () => {
  const f = await fixture();
  const all = await executeReadTool(f.event as AgentEventContext, getCompanionAgentTool("companion_notes_read")!, { action: "search", query: "欧姆定律 电功率", match: "all" });
  assert.deepEqual(all.value.notes, []);
  const any = await executeReadTool(f.event as AgentEventContext, getCompanionAgentTool("companion_notes_read")!, { action: "search", query: "欧姆定律 电功率", match: "any" });
  assert.deepEqual((any.value.notes as Array<{noteId:string}>).map(note => note.noteId), [f.related.note.id]);
});

test("全局伴星自动执行不扩大空间成员的写权限，个人空间所有者的既有判据保留", async () => {
  const f = await fixture(), other = await fixture();
  await f.mutate(async tx => {
    await tx`UPDATE workspaces SET workspace_type='collaborative' WHERE id=${f.scope.workspaceId}`;
    await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${f.scope.workspaceId},${other.scope.userId},'owner')`;
    await tx`UPDATE workspace_members SET role='member' WHERE workspace_id=${f.scope.workspaceId} AND user_id=${f.scope.userId}`;
    await tx`UPDATE workspaces SET owner_id=${other.scope.userId} WHERE id=${f.scope.workspaceId}`;
  });
  await assert.rejects(executeCompanionCreateNote(f.event, { title: "电功率", markdown: ARTICLE }, undefined, f.creationCallId), /当前空间只能阅读/);
  await assert.rejects(withWorkerWorkspaceTransaction(f.scope, tx => createPrivateNoteRecords(tx, f.scope, {
    title: "不能绕过空间权限", titleSource: "manual", blocks: [], companionRunId: f.event.read.runId,
  })), (error: unknown) => error instanceof Error && (error.cause as {code?:string})?.code === "42501");
  await f.mutate(async tx => {
    await tx`UPDATE workspaces SET owner_id=${f.scope.userId} WHERE id=${f.scope.workspaceId}`;
    await tx`UPDATE workspace_members SET left_at=now() WHERE workspace_id=${f.scope.workspaceId} AND user_id=${other.scope.userId}`;
    await tx`UPDATE workspaces SET workspace_type='personal' WHERE id=${f.scope.workspaceId}`;
  });
  const saved = await executeCompanionCreateNote(f.event, { title: "电功率", markdown: ARTICLE }, undefined, f.creationCallId);
  assert.equal(saved.value.status, "succeeded", "个人空间ownerId成立时沿用既有OR判据");
});


test("真实笔记保存不把标题中的字数词或范围转换成硬限制", async () => {
  for (const [userText, markdown] of [
    ["写一篇介绍三字经的笔记", "# 三字经\n\n这是对三字经的介绍，正文不应被要求恰好三个字。"],
    ["整理四字成语，字数不限", "# 四字成语\n\n此处介绍成语的来源、含义和使用语境。"],
    ["写一段300–500字的笔记", "文".repeat(350)],
    ["Save an English note of 300–500 characters.", "A".repeat(350)],
  ]) {
    const f = await fixture({ userText, searchCompleted: false });
    const result = await executeCompanionCreateNote(f.event, { title: "原文保存", markdown, links: [] }, undefined, f.creationCallId);
    const saved = await withWorkspaceTransaction(f.scope, tx => getNoteWithVersion(tx, String(result.value.noteId), f.scope.workspaceId, f.scope.userId));
    assert.ok(saved);
    assert.equal(saved.blocks.map(block => block.content).join("\n\n"), markdown);
  }
});

test("记忆维护按实际候选状态和时间执行，不因计数词阻止晋升", async () => {
  const f = await fixture();
  const rollback = new Error("rollback test transaction");
  await assert.rejects(admin.begin(async tx => {
    await tx`DELETE FROM companion_memory_maintenance_runs WHERE run_date=CURRENT_DATE`;
    for (const content of ["今天我决定长期每天读30分钟", "每天学习物理", "I plan to keep a 30 minute reading habit."]) {
      await tx`INSERT INTO assistant_memory_items(workspace_id,user_id,kind,content,candidate,importance,created_at)
        VALUES(${f.scope.workspaceId},${f.scope.userId},'preference',${content},true,0.8,now()-interval '4 days')`;
    }
    const youngId = randomUUID();
    await tx`INSERT INTO assistant_memory_items(id,workspace_id,user_id,kind,content,candidate,importance)
      VALUES(${youngId},${f.scope.workspaceId},${f.scope.userId},'preference','recent candidate',true,0.8)`;
    await tx`SET LOCAL ROLE astella_worker`;
    const [first] = await tx`SELECT astella_run_companion_memory_maintenance() AS changed`;
    assert.ok(first.changed >= 3);
    const [second] = await tx`SELECT astella_run_companion_memory_maintenance() AS changed`;
    assert.equal(second.changed, 0);
    await tx`RESET ROLE`;
    const rows = await tx`SELECT id,candidate FROM assistant_memory_items WHERE workspace_id=${f.scope.workspaceId}`;
    assert.equal(rows.filter(row => row.id !== youngId && row.candidate === false).length, 3);
    assert.equal(rows.find(row => row.id === youngId)!.candidate, true);
    throw rollback;
  }), error => error === rollback);
});
