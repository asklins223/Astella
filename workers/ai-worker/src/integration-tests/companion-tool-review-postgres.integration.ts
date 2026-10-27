import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import postgres from "postgres";
import { getCompanionAgentTool, resolveAllCompanionAgentTools, MAX_PENDING_JOBS_PER_WORKSPACE } from "@astella/shared";
import { canonicalJsonV1, sha256Utf8V1 } from "@astella/shared/content-hash";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { companionMemoryRecycleBinDays as MEMORY_RECYCLE_BIN_DAYS } from "@astella/shared/companion-memory-desktop-contracts";
import { ensureAgentToolCall, loadContinuation } from "../handlers/tools/companion-tool-call-ledger.ts";
import { runCompanionToolExecution } from "../handlers/tools/companion-tool-execution-run.ts";
import type { AgentEventContext } from "../handlers/tools/companion-read-tools.ts";
import { closeDatabase } from "../db.ts";
import { withWorkspaceTransaction, closeDatabase as closeApiDatabase } from "../../../../apps/api/src/db/client.ts";
import { createNote, getNoteWithVersion } from "../../../../apps/api/src/modules/note/service.ts";
import { decideCompanionProposal } from "../../../../apps/api/src/modules/companion-conversation/learning-action-bridge.ts";
import { processCompanionNoteEdit } from "../../../../apps/api/src/modules/note/companion-edit-dispatch.ts";
import { closeNoteCollaboration } from "../../../../apps/api/src/modules/note/collaboration.ts";
import { applyNoteDocUpdate } from "../../../../apps/api/src/modules/note/document-state.ts";
import { projectFragmentBlocks, writeFragmentBlocks } from "../../../../apps/api/src/modules/note/doc-fragment.ts";

const url = testDatabaseUrl("DATABASE_URL_MIGRATOR");
if (!new URL(url).pathname.startsWith("/astella_note_authoring_permission_")) throw new Error("Use a fresh isolated permission database");
const admin = postgres(url, { max: 2 });
after(async () => { await closeNoteCollaboration(); await closeApiDatabase(); await closeDatabase(); await admin.end(); });

async function fixture(permission: "read_only" | "guided" | "full") {
  const workspaceId = randomUUID(), userId = randomUUID(), runId = randomUUID(), conversationId = randomUUID();
  const messageId = randomUUID(), jobId = randomUUID(), stepId = randomUUID(), callId = `call_${randomUUID()}`;
  const scope = { workspaceId, userId };
  const mutate = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) => admin.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id',${workspaceId},true),set_config('app.user_id',${userId},true)`;
    return fn(tx);
  });
  await mutate(async tx => {
    await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${userId},${`review-${userId}@test.invalid`},'h','owner')`;
    await tx`INSERT INTO workspaces(id,name,owner_id) VALUES(${workspaceId},'确认保存隔离回归',${userId})`;
    await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
    await tx`INSERT INTO user_companion_account_state(user_id,epoch,global_enabled,agent_settings)
      VALUES(${userId},0,true,${tx.json({ version: 1, permissionLevel: permission })})`;
    await tx`INSERT INTO companion_conversations(id,workspace_id,user_id,kind,title,title_source,status,next_message_seq,next_event_seq)
      VALUES(${conversationId},${workspaceId},${userId},'dialogue','确认保存','auto','active',2,1)`;
    await tx`INSERT INTO companion_messages(id,conversation_id,workspace_id,user_id,role,seq,kind,blocks,content_sha256)
      VALUES(${messageId},${conversationId},${workspaceId},${userId},'user',1,'text',
        ${tx.json([{ type: 'text', text: '请整理这篇笔记，先让我查看结果再决定保存。' }])},${'0'.repeat(64)})`;
    await tx`INSERT INTO jobs(id,type,workspace_id,requested_by,payload,status,lease_token,started_at)
      VALUES(${jobId},'companion_agent',${workspaceId},${userId},${tx.json({ runId })},'running','review-lease',now())`;
    const snapshot = { version: 1, level: permission, offeredTools: resolveAllCompanionAgentTools(permission)
      .map(({ name, toolVersion, riskClass }) => ({ name, toolVersion, riskClass })) };
    await tx`INSERT INTO companion_turn_runs(id,conversation_id,workspace_id,user_id,user_message_id,generation,status,
      idempotency_key_hash,request_body_hash,account_epoch,job_id,permission_level,permission_snapshot)
      VALUES(${runId},${conversationId},${workspaceId},${userId},${messageId},1,'running',${'a'.repeat(64)},${'b'.repeat(64)},0,
        ${jobId},${permission},${tx.json(snapshot)})`;
    await tx`INSERT INTO companion_agent_steps(id,workspace_id,user_id,conversation_id,run_id,step_no,kind,status)
      VALUES(${stepId},${workspaceId},${userId},${conversationId},${runId},1,'model','running')`;
  });
  const note = await withWorkspaceTransaction(scope, tx => createNote(tx, workspaceId, userId, {
    title: "原笔记", blocks: [{ type: "paragraph", content: "原文段落" }, { type: "paragraph", content: "保留段落" }],
  }));
  assert.ok(note);
  const pageContext = { context: { noteId: note.note.id, noteVersionId: note.version.id,
    editing: { tail: { block: 1, expectedBlock: "保留段落" } } } };
  await mutate(tx => tx`UPDATE companion_turn_runs SET page_context=${tx.json(pageContext)} WHERE id=${runId}`);
  let event: AgentEventContext = { ctx: { id: jobId, workspaceId, requestedBy: userId, leaseToken: "review-lease", payload: { runId }, signal: new AbortController().signal },
    read: { userId, runId, conversationId, userMessageId: messageId, generation: 1, accountEpoch: 0,
      userText: "请整理这篇笔记，先让我查看结果再决定保存。", pageContext, recentMessages: [],
      runStatus: "running", livePageView: null, residentMemories: [], memoryDirectory: [], playbookCatalog: [], playbookCandidates: [],
      deliveryObservation: null, organizationSurface: null, memoryRefs: [], hereAndNow: null, thisTurnFacts: null,
      factSpans: null, conversationSummary: null, personaProfileRevision: 1, personaExamplesRevision: 1,
      defaultExpressionVersion: "fixture", petProfile: null, nextMessageSeq: 2, nextEventSeq: 1 },
    constraints: {}, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  const content = () => withWorkspaceTransaction(scope, async tx => {
    const saved = await getNoteWithVersion(tx, note.note.id, workspaceId, userId);
    return saved!.blocks.map(block => block.content);
  });
  const prepare = async (name: string, arguments_: Record<string, unknown>, id = callId) => {
    const definition = getCompanionAgentTool(name)!;
    await ensureAgentToolCall(event, stepId, definition, { id, arguments: arguments_ }, sha256Utf8V1(canonicalJsonV1(arguments_)));
    return runCompanionToolExecution({ event, definition, arguments: arguments_, operationCallId: id, toolCallId: id,
      deadlineAt: Date.now() + 30_000, signal: event.ctx.signal, runId, logger: { warn() {} } });
  };
  const proposal = async (id: string) => (await mutate(tx => tx`SELECT payload,payload_sha256,status FROM companion_action_proposals WHERE id=${id}`))[0]!;
  const decide = async (id: string, decision: "confirm" | "reject", key = randomUUID()) => {
    const p = await proposal(id);
    return decideCompanionProposal({ ...scope, proposalId: id, decision, idempotencyKey: key, expectedPayloadSha256: p.payload_sha256 });
  };
  const resume = async (id: string) => {
    const [job] = await mutate(tx => tx`SELECT id FROM jobs WHERE payload->>'proposalId'=${id}`);
    assert.ok(job);
    await mutate(tx => tx`UPDATE jobs SET status='running',lease_token='review-continuation',started_at=now() WHERE id=${job.id}`);
    event = { ...event, ctx: { ...event.ctx, id: job.id, leaseToken: "review-continuation", payload: { runId, proposalId: id } } };
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void mutate(tx => tx`SELECT id FROM companion_agent_tool_calls WHERE run_id=${runId} AND name='notes.write.edit' AND status='executing'`)
        .then(async rows => { for (const row of rows) await processCompanionNoteEdit(scope, row.id); })
        .finally(() => { busy = false; });
    }, 20);
    try { return await loadContinuation(event, [], id, Date.now() + 30_000); }
    finally { clearInterval(timer); while (busy) await new Promise(resolve => setTimeout(resolve, 5)); }
  };
  const editArgs = { noteId: note.note.id, noteVersionId: note.version.id, operation: "replace_blocks",
    startBlock: 0, endBlock: 0, expectedBlocks: ["原文段落"], markdown: "# 更新后的标题\n\n新内容" };
  return { scope, runId, note, mutate, event, prepare, proposal, decide, resume, content, editArgs };
}

for (const permission of ["read_only", "guided"] as const) test(`${permission}：完整更新预览先出现，确认保存后仅这一笔获授权`, async () => {
  const f = await fixture(permission);
  const result = await f.prepare("companion_notes_write", f.editArgs);
  assert.equal(result.kind, "waiting"); if (result.kind !== "waiting") return;
  const p = await f.proposal(result.proposalId);
  assert.equal(p.payload.confirmationStage, "after_preview");
  assert.match(p.payload.preview.markdown, /更新后的标题/);
  assert.match(p.payload.preview.markdown, /保留段落/);
  assert.deepEqual(await f.content(), ["原文段落", "保留段落"]);
  const decision = await f.decide(result.proposalId, "confirm") as { status: string };
  assert.equal(decision.status, "accepted", "点保存不冒充已经写入成功");
  await f.resume(result.proposalId);
  assert.deepEqual(await f.content(), ["# 更新后的标题", "新内容", "保留段落"]);
  assert.equal((await f.proposal(result.proposalId)).status, "succeeded");
  const [run] = await f.mutate(tx => tx`SELECT permission_level FROM companion_turn_runs WHERE id=${f.runId}`);
  assert.equal(run.permission_level, permission, "确认不提升全局或整轮权限");
});

test("取消更新预览不提交；原文和在等待期间的用户修改都保留", async () => {
  const f = await fixture("read_only"), result = await f.prepare("companion_notes_write", f.editArgs);
  assert.equal(result.kind, "waiting"); if (result.kind !== "waiting") return;
  await withWorkspaceTransaction(f.scope, tx => applyNoteDocUpdate(tx, { ...f.scope, noteId: f.note.note.id }, f.note.version.id,
    document => { const blocks = projectFragmentBlocks(document); blocks[1]!.content = "用户后来补写的内容"; writeFragmentBlocks(document, blocks); }));
  await f.decide(result.proposalId, "reject");
  const messages = await f.resume(result.proposalId);
  assert.deepEqual(await f.content(), ["原文段落", "用户后来补写的内容"]);
  assert.equal(JSON.parse(String(messages.at(-1)!.content)).ok, false);
  assert.equal((await f.proposal(result.proposalId)).status, "rejected");
});

test("最高档删除也必须执行前确认；确认后的重放不会再次删除", async () => {
  const f = await fixture("full");
  const args = { ...f.editArgs, operation: "delete_blocks" }; delete (args as { markdown?: string }).markdown;
  const result = await f.prepare("companion_notes_write", args);
  assert.equal(result.kind, "waiting"); if (result.kind !== "waiting") return;
  assert.equal((await f.proposal(result.proposalId)).payload.confirmationStage, "before_execute");
  assert.deepEqual(await f.content(), ["原文段落", "保留段落"]);
  const key = randomUUID();
  await f.decide(result.proposalId, "confirm", key); await f.resume(result.proposalId);
  assert.deepEqual(await f.content(), ["保留段落"]);
  await f.decide(result.proposalId, "confirm", key);
  const [tool] = await f.mutate(tx => tx`SELECT status FROM companion_agent_tool_calls WHERE run_id=${f.runId}`);
  assert.equal(tool.status, "succeeded", "迟到的同 key 决定不复活已完成调用");
  assert.deepEqual(await f.content(), ["保留段落"]);
});

for (const permission of ["read_only", "guided"] as const) test(`${permission}：新笔记先给完整草稿，保存前不进入笔记列表`, async () => {
  const f = await fixture(permission);
  assert.equal((await f.prepare("companion_notes_read", { query: "知识点" }, `search_${randomUUID()}`)).kind, "success");
  const result = await f.prepare("companion_notes_write", { title: "新笔记", markdown: "# 学习笔记\n\n这是完整的新笔记内容，包含独立的解释和结论。", links: [] });
  assert.equal(result.kind, "waiting"); if (result.kind !== "waiting") return;
  const count = async () => Number((await f.mutate(tx => tx`SELECT count(*)::int AS count FROM notes WHERE workspace_id=${f.scope.workspaceId}`))[0].count);
  assert.equal(await count(), 1);
  await f.decide(result.proposalId, "confirm"); await f.resume(result.proposalId);
  assert.equal(await count(), 2);
  assert.equal((await f.proposal(result.proposalId)).status, "succeeded");
});

test("修改已经冻结的参数不能借用确认，原笔记保持不变", async () => {
  const f = await fixture("read_only"), result = await f.prepare("companion_notes_write", f.editArgs);
  assert.equal(result.kind, "waiting"); if (result.kind !== "waiting") return;
  await f.decide(result.proposalId, "confirm");
  await f.mutate(tx => tx`UPDATE companion_agent_tool_calls SET arguments=jsonb_set(arguments,'{markdown}','"未经确认的内容"'::jsonb) WHERE run_id=${f.runId}`);
  const messages = await f.resume(result.proposalId);
  assert.equal(JSON.parse(String(messages.at(-1)!.content)).ok, false);
  assert.deepEqual(await f.content(), ["原文段落", "保留段落"]);
  assert.equal((await f.proposal(result.proposalId)).status, "failed");
});


test("同一任务可以分别审核并保存多篇笔记，回执和重试都绑定实际操作", async () => {
  const f = await fixture("read_only");
  await f.prepare("companion_notes_read", { query: "分成两篇" }, `search_${randomUUID()}`);
  const ids: string[] = [];
  for (const title of ["第一篇", "第二篇"]) {
    const callId = `create_${randomUUID()}`;
    const result = await f.prepare("companion_notes_write", { title, markdown: `# ${title}\n\n这是这一篇独立的正文和结论，不能被另一篇替代。`, links: [] }, callId);
    assert.equal(result.kind, "waiting"); if (result.kind !== "waiting") return;
    await f.decide(result.proposalId, "confirm"); await f.resume(result.proposalId);
    const [call] = await f.mutate(tx => tx`SELECT result_ref FROM companion_agent_tool_calls WHERE run_id=${f.runId} AND tool_call_id=${callId}`);
    const receipt = JSON.parse(call.result_ref);
    assert.equal(receipt.title, title); ids.push(receipt.noteId);
    assert.equal((await f.proposal(result.proposalId)).status, "succeeded");
  }
  assert.notEqual(ids[0], ids[1]);
  const [count] = await f.mutate(tx => tx`SELECT count(*)::int AS n FROM notes WHERE workspace_id=${f.scope.workspaceId}`);
  assert.equal(count.n, 3);
});

test("取消删除保留原文，回合续跑不能把取消冒充成功", async () => {
  const f = await fixture("full");
  const args = { ...f.editArgs, operation: "delete_blocks" }; delete (args as { markdown?: string }).markdown;
  const result = await f.prepare("companion_notes_write", args);
  assert.equal(result.kind, "waiting"); if (result.kind !== "waiting") return;
  assert.match((await f.proposal(result.proposalId)).payload.preview.markdown, /将从.*删除.*原文段落/s);
  await f.decide(result.proposalId, "reject");
  const messages = await f.resume(result.proposalId);
  assert.equal(JSON.parse(String(messages.at(-1)!.content)).ok, false);
  assert.deepEqual(await f.content(), ["原文段落", "保留段落"]);
});

for (const condition of ["scope", "epoch", "source"] as const) test(`确认保存仍核对实际权限和原文：${condition}`, async () => {
  const f = await fixture("read_only"), result = await f.prepare("companion_notes_write", f.editArgs);
  assert.equal(result.kind, "waiting"); if (result.kind !== "waiting") return;
  await f.decide(result.proposalId, "confirm");
  if (condition === "scope") await f.mutate(async tx => {
    const otherOwner = randomUUID();
    await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${otherOwner},${`owner-${otherOwner}@test.invalid`},'h','owner')`;
    await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${f.scope.workspaceId},${otherOwner},'owner')`;
    await tx`UPDATE workspaces SET workspace_type='collaborative',owner_id=${otherOwner} WHERE id=${f.scope.workspaceId}`;
    await tx`UPDATE workspace_members SET role='member' WHERE workspace_id=${f.scope.workspaceId} AND user_id=${f.scope.userId}`;
  });
  if (condition === "epoch") await f.mutate(tx => tx`UPDATE user_companion_account_state SET epoch=epoch+1 WHERE user_id=${f.scope.userId}`);
  if (condition === "source") await withWorkspaceTransaction(f.scope, tx => applyNoteDocUpdate(tx, { ...f.scope, noteId: f.note.note.id }, f.note.version.id,
    document => { const blocks = projectFragmentBlocks(document); blocks[0]!.content = "用户新原文"; writeFragmentBlocks(document, blocks); }));
  const messages = await f.resume(result.proposalId);
  assert.equal(JSON.parse(String(messages.at(-1)!.content)).ok, false);
  assert.deepEqual(await f.content(), [condition === "source" ? "用户新原文" : "原文段落", "保留段落"]);
  assert.equal((await f.proposal(result.proposalId)).status, "failed");
});

for (const changed of [false, true]) test(`删除记忆前展示实际内容，${changed ? "内容变化后拒绝删除" : "确认后删除当前这一条"}`, async () => {
  const f = await fixture("full"), memoryId = randomUUID();
  await f.mutate(tx => tx`INSERT INTO assistant_memory_items(id,workspace_id,user_id,kind,content,user_stated,user_confirmed)
    VALUES(${memoryId},${f.scope.workspaceId},${f.scope.userId},'preference','原来的学习偏好',true,true)`);
  const result = await f.prepare("companion_memory_write", { memoryId });
  assert.equal(result.kind, "waiting"); if (result.kind !== "waiting") return;
  assert.equal((await f.proposal(result.proposalId)).payload.preview.markdown, "原来的学习偏好");
  await f.decide(result.proposalId, "confirm");
  if (changed) await f.mutate(tx => tx`UPDATE assistant_memory_items SET content='用户修正的新偏好' WHERE id=${memoryId}`);
  await f.resume(result.proposalId);
  const [memory] = await f.mutate(tx => tx`SELECT deleted_at FROM assistant_memory_items WHERE id=${memoryId}`);
  assert.equal(Boolean(memory.deleted_at), !changed);
  assert.equal((await f.proposal(result.proposalId)).status, changed ? "failed" : "succeeded");
});

/**
 * 遗忘一条记忆要写下**三样**状态，少一样都不会报错，只会让"她看起来忘了、旧话还从别处回来"
 * （2026-10-16 审出的分歧：worker 这条路原来只写 `deleted_at`）：
 *   ① `purge_after` —— 到期清理要求它非空，否则墓碑永远进不了回收区；
 *   ② 发现簿遮蔽 —— 用户收藏过这条记忆时，簿子里的引文要一起遮掉（40 §7）；
 *   ③ 整理结论作废 —— 那条 `surface` 是这条记忆的转述，最长会被注入 7 天。
 * 真库上按最终状态断言，而不是只看 handler 有没有抛错。
 */
test("遗忘一条记忆：写回收窗口、遮蔽发现簿引文、作废整理结论", async () => {
  const f = await fixture("full"), memoryId = randomUUID();
  await f.mutate(async tx => {
    await tx`INSERT INTO assistant_memory_items(id,workspace_id,user_id,kind,content,user_stated,user_confirmed)
      VALUES(${memoryId},${f.scope.workspaceId},${f.scope.userId},'preference','用户收藏过的那条偏好',true,true)`;
    await tx`INSERT INTO companion_discovery_entries(workspace_id,user_id,kind,source,source_id,author,body)
      VALUES(${f.scope.workspaceId},${f.scope.userId},'kept_ai_suggestion','memory',${memoryId},'assistant','从这条记忆来的引文')`;
    await tx`INSERT INTO companion_memory_organization_state(workspace_id,user_id,surface,surface_at)
      VALUES(${f.scope.workspaceId},${f.scope.userId},'这条记忆的转述结论',now() - interval '8 days')
      ON CONFLICT (workspace_id,user_id) DO UPDATE SET surface=EXCLUDED.surface,surface_at=EXCLUDED.surface_at`;
  });
  const result = await f.prepare("companion_memory_write", { memoryId });
  assert.equal(result.kind, "waiting"); if (result.kind !== "waiting") return;
  await f.decide(result.proposalId, "confirm");
  await f.resume(result.proposalId);

  const [memory] = await f.mutate(tx => tx`SELECT deleted_at, purge_after FROM assistant_memory_items WHERE id=${memoryId}`);
  assert.ok(memory.deleted_at, "确认后应当进入软删");
  assert.ok(memory.purge_after,
    "只写 deleted_at 的墓碑永远进不了回收区：到期清理要求 purge_after 非空");
  const windowDays = (new Date(memory.purge_after).getTime() - new Date(memory.deleted_at).getTime()) / 86_400_000;
  assert.ok(Math.abs(windowDays - MEMORY_RECYCLE_BIN_DAYS) < 0.01,
    `回收窗口应为 ${MEMORY_RECYCLE_BIN_DAYS} 天，实际 ${windowDays.toFixed(4)} 天`);

  const [entry] = await f.mutate(tx => tx`SELECT masked FROM companion_discovery_entries
    WHERE workspace_id=${f.scope.workspaceId} AND user_id=${f.scope.userId} AND source='memory' AND source_id=${memoryId}`);
  assert.equal(entry.masked, true, "40 §7：来源被删掉后，簿子里那条引文不能再显示");

  const [state] = await f.mutate(tx => tx`SELECT surface FROM companion_memory_organization_state
    WHERE workspace_id=${f.scope.workspaceId} AND user_id=${f.scope.userId}`);
  assert.equal(state.surface, null,
    "整理结论是这条记忆的转述，正文删掉后它不能再进 prompt");
});


for (const changed of [false, true]) test(`取消提醒展示实际内容与时间，${changed ? "时间变化后拒绝取消" : "确认后只取消这一条"}`, async () => {
  const f = await fixture("full"), reminderId = randomUUID();
  await f.mutate(tx => tx`INSERT INTO companion_reminders(id,workspace_id,user_id,text,fire_at)
    VALUES(${reminderId},${f.scope.workspaceId},${f.scope.userId},'明天复习这篇笔记',now()+interval '1 day')`);
  const result = await f.prepare("companion_attention_write", { reminderId });
  assert.equal(result.kind, "waiting"); if (result.kind !== "waiting") return;
  assert.match((await f.proposal(result.proposalId)).payload.preview.markdown, /明天复习这篇笔记.*原定时间/s);
  await f.decide(result.proposalId, "confirm");
  if (changed) await f.mutate(tx => tx`UPDATE companion_reminders SET fire_at=fire_at+interval '1 day' WHERE id=${reminderId}`);
  await f.resume(result.proposalId);
  const [reminder] = await f.mutate(tx => tx`SELECT status FROM companion_reminders WHERE id=${reminderId}`);
  assert.equal(reminder.status, changed ? "pending" : "cancelled");
  assert.equal((await f.proposal(result.proposalId)).status, changed ? "failed" : "succeeded");
});

test("真实笔记容量内的长结果不再被 Agent 的 12000 字限制截断或拒绝", async () => {
  const f = await fixture("read_only");
  await f.prepare("companion_notes_read", { query: "长笔记" }, `search_${randomUUID()}`);
  const markdown = "# 完整长笔记\n\n" + "每一段都有真实完整的说明，不应被单会话工具的字符配额拒绝。\n\n".repeat(800) + "最终结论";
  assert.ok(markdown.length > 20000);
  const result = await f.prepare("companion_notes_write", { title: "长笔记", markdown, links: [] });
  assert.equal(result.kind, "waiting"); if (result.kind !== "waiting") return;
  assert.equal((await f.proposal(result.proposalId)).payload.preview.markdown, markdown);
  await f.decide(result.proposalId, "confirm"); await f.resume(result.proposalId);
  assert.equal((await f.proposal(result.proposalId)).status, "succeeded");
  const [saved] = await f.mutate(tx => tx`SELECT string_agg(b.content,E'\n\n' ORDER BY b.ordinal) AS body FROM notes n
    JOIN note_blocks b ON b.version_id=n.current_version_id WHERE n.workspace_id=${f.scope.workspaceId} AND n.title='长笔记'`);
  assert.match(saved.body, /最终结论$/);
});


test("账号行短暂被其他事务锁住时，保存等待锁释放，不误报失权", async () => {
  const f = await fixture("read_only"), result = await f.prepare("companion_notes_write", f.editArgs);
  assert.equal(result.kind, "waiting"); if (result.kind !== "waiting") return;
  await f.decide(result.proposalId, "confirm");
  let release!: () => void, acquired!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const lock = f.mutate(async tx => {
    await tx`SELECT user_id FROM user_companion_account_state WHERE user_id=${f.scope.userId} FOR UPDATE`;
    acquired(); await gate;
  });
  await ready;
  const resumption = f.resume(result.proposalId);
  await new Promise(resolve => setTimeout(resolve, 250)); release(); await lock; await resumption;
  assert.deepEqual(await f.content(), ["# 更新后的标题", "新内容", "保留段落"]);
  assert.equal((await f.proposal(result.proposalId)).status, "succeeded");
});


test("续跑入队失败时撤销整个确认；重试不会留下半确认或错误的任务指针", async () => {
  const f = await fixture("read_only"), result = await f.prepare("companion_notes_write", f.editArgs);
  assert.equal(result.kind, "waiting"); if (result.kind !== "waiting") return;
  await f.mutate(tx => tx`INSERT INTO jobs(type,workspace_id,requested_by,payload,status)
    SELECT 'companion_agent',${f.scope.workspaceId},${f.scope.userId},'{}'::jsonb,'pending' FROM generate_series(1,${MAX_PENDING_JOBS_PER_WORKSPACE})`);
  await assert.rejects(f.decide(result.proposalId, "confirm"), /pending jobs/);
  assert.equal((await f.proposal(result.proposalId)).status, "pending");
  const [waiting] = await f.mutate(tx => tx`SELECT status,waiting_proposal_id,job_id FROM companion_turn_runs WHERE id=${f.runId}`);
  assert.equal(waiting.status, "waiting_for_confirmation"); assert.equal(waiting.waiting_proposal_id, result.proposalId);
  assert.equal(waiting.job_id, f.event.ctx.id);
  await f.mutate(tx => tx`DELETE FROM jobs WHERE workspace_id=${f.scope.workspaceId} AND status='pending'`);
  await f.decide(result.proposalId, "confirm");
  const [published] = await f.mutate(tx => tx`SELECT r.status,j.payload->>'proposalId' AS proposal_id FROM companion_turn_runs r
    JOIN jobs j ON j.id=r.job_id WHERE r.id=${f.runId}`);
  assert.equal(published.status, "accepted"); assert.equal(published.proposal_id, result.proposalId);
  await f.resume(result.proposalId);
  assert.equal((await f.proposal(result.proposalId)).status, "succeeded");
});
