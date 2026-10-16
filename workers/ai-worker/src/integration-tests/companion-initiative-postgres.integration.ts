import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { enqueueParticipationObservation } from "@astella/agent-host";
import { sql } from "drizzle-orm";
import type { AgentTurnRequest, AgentTurnResult } from "@astella/shared";
import { assertCompanionContextSourcesCurrent } from "../handlers/companion-context-sources.ts";
import { CompanionContextChangedError } from "../lib/non-retryable-errors.ts";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { recordCompanionAwareness, readParticipationPreferences, writeParticipationPreferences,
  arrangeCompanionAttention, writeCompanionSelfNote } from "@astella/agent-host";

const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 2 });
process.env.DATABASE_URL = testDatabaseUrl("DATABASE_URL_WORKER");
delete process.env.AI_PLATFORMS_CONFIG;
delete process.env.TOKENRHYTHM_API_KEY;
process.env.COMPANION_DIALOGUE_V1_ENABLED = "true";
process.env.COMPANION_VOICE_DIALOGUE_V1_ENABLED = "true";
const { withWorkerWorkspaceTransaction: transaction, closeDatabase } = await import("../db.ts");
const { runCompanionInitiative } = await import("../handlers/companion-initiative.ts");
const { runCompanionDialogue } = await import("../handlers/companion-dialogue.ts");
const { MockProvider } = await import("../lib/providers/mock.ts");
after(async () => { await admin.end({ timeout: 2 }); await closeDatabase(); });

async function fixture() {
  const userId = randomUUID(), workspaceId = randomUUID(), conversationId = randomUUID(), launchId = randomUUID();
  await admin.begin(async tx => {
    await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${userId},${`initiative-${userId}@x.test`},'h','owner')`;
    await tx`INSERT INTO workspaces(id,name,owner_id) VALUES(${workspaceId},'initiative fixture',${userId})`;
    await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
    await tx`INSERT INTO user_ai_settings(user_id,consent_version,consent_at,data_policy)
      VALUES(${userId},'integration-test-v1',now(),${tx.json({ sendToExternal: false, sendImageContent: false, piiDetection: true, auditLogging: true })})`;
    await tx`INSERT INTO user_companion_account_state(user_id) VALUES(${userId})`;
    await tx`INSERT INTO companion_conversations(id,workspace_id,user_id,kind,title,title_source,status)
      VALUES(${conversationId},${workspaceId},${userId},'dialogue','相处','placeholder','active')`;
  });
  return { userId, workspaceId, conversationId, launchId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const prefs = async (f: Fixture, markdown: string, expectedRevision = 0) => (await transaction(f, tx => writeParticipationPreferences(tx, f,
  { markdown, enabled: true, expectedRevision, source: { kind: "settings", workspaceId: f.workspaceId, messageId: null, quote: null } }))).preferences;
async function observe(f: Fixture, typing = false) {
  return transaction(f, tx => recordCompanionAwareness(tx, f, { version: 1, id: randomUUID(), appLaunchId: f.launchId,
    deviceSessionId: `device:${f.launchId}`, host: "desktop", topic: "app.started", occurredAt: new Date().toISOString(), elapsedMs: 0,
    context: { foreground: true, unlocked: true, typing, learning: false, conversationId: f.conversationId,
      page: { key: "home", label: "书房", revision: null, context: null } } }));
}
async function prepare(f: Fixture) {
  const [job] = await admin`UPDATE jobs SET status='running',started_at=now(),lease_token='fixture-lease'
    WHERE id=(SELECT id FROM jobs WHERE requested_by=${f.userId} AND type='companion_initiative' AND status='pending' ORDER BY scheduled_at,id LIMIT 1) RETURNING id,payload`;
  assert.ok(job);
  await runCompanionInitiative({ id: job.id, payload: job.payload, workspaceId: f.workspaceId, requestedBy: f.userId,
    leaseToken: "fixture-lease", signal: new AbortController().signal }).catch(error => { throw error.cause ?? error; });
  return job;
}
async function runPrepared(f: Fixture, answer: (request: AgentTurnRequest) => Promise<AgentTurnResult>) {
  const [run] = await admin`SELECT id,job_id FROM companion_turn_runs WHERE user_id=${f.userId} ORDER BY generation DESC LIMIT 1`;
  assert.ok(run);
  await admin`UPDATE jobs SET status='running',started_at=now(),lease_token='fixture-lease' WHERE id=${run.job_id}`;
  const original = MockProvider.prototype.executeAgentTurn;
  const stream = Object.getOwnPropertyDescriptor(MockProvider.prototype, "chatCompletionStream")!;
  MockProvider.prototype.executeAgentTurn = answer;
  Object.defineProperty(MockProvider.prototype, "chatCompletionStream", { ...stream, value: undefined });
  try { await runCompanionDialogue({ id:run.job_id,payload:{runId:run.id},workspaceId:f.workspaceId,requestedBy:f.userId,
    leaseToken:"fixture-lease",signal:new AbortController().signal }); }
  finally { MockProvider.prototype.executeAgentTurn = original; Object.defineProperty(MockProvider.prototype,"chatCompletionStream",stream); }
  return run;
}
const silentAnswer = async (): Promise<AgentTurnResult> => ({ content:"",toolCalls:[],finishReason:"stop",usage:{promptTokens:10,completionTokens:0},providerRequestId:null });

test("reply-finished publication suppresses an exact parent paragraph through both final and tool channels", async () => {
  for (const channel of ["final", "tool"] as const) {
    const f = await fixture();
    await observe(f); await prepare(f);
    const [pending] = await admin`SELECT id FROM companion_turn_runs WHERE user_id=${f.userId} ORDER BY generation DESC LIMIT 1`;
    const userMessageId = randomUUID();
    await admin`INSERT INTO companion_messages(id,workspace_id,user_id,conversation_id,seq,role,kind,blocks,content_sha256)
      VALUES(${userMessageId},${f.workspaceId},${f.userId},${f.conversationId},1,'user','text',
        '[{"type":"text","text":"更新称呼为小柚，保留解释先举生活例子的偏好。"}]'::jsonb,${"0".repeat(64)})`;
    await admin`UPDATE companion_conversations SET next_message_seq=2 WHERE id=${f.conversationId}`;
    await admin`UPDATE companion_turn_runs SET user_message_id=${userMessageId},input_source=NULL WHERE id=${pending!.id}`;
    const text = "改好了，小柚：以后就这么称呼你，解释先举生活例子的偏好原样保留。";
    const parent = pending!, message = { id: randomUUID() };
    await admin`INSERT INTO companion_messages(id,workspace_id,user_id,conversation_id,seq,role,kind,blocks,run_id,content_sha256)
      VALUES(${message.id},${f.workspaceId},${f.userId},${f.conversationId},2,'assistant','text',
        ${admin.json([{ type: "text", text: `我去把那条记录找出来更新。\n\n${text}` }])},${parent.id},${"1".repeat(64)})`;
    await admin`UPDATE companion_turn_runs SET status='succeeded',assistant_message_id=${message.id},finished_at=now() WHERE id=${parent.id}`;
    await admin`UPDATE companion_conversations SET next_message_seq=3 WHERE id=${f.conversationId}`;
    await transaction(f, tx => enqueueParticipationObservation(tx, f, {
      topic: "reply.finished", dedupeKey: `reply:${parent.id}`, parentRunId: parent.id,
      conversationId: f.conversationId, facts: { messageIds: [message.id] }, ttlMs: 120_000,
    }));
    await prepare(f);
    let attempts = 0;
    const followup = await runPrepared(f, async () => channel === "final"
      ? { ...(await silentAnswer()), content: text }
      : attempts++ > 0 ? silentAnswer() : { ...(await silentAnswer()), finishReason: "tool_calls", toolCalls: [
        { id: "repeated-parent-paragraph", name: "companion_publish_utterance", arguments: { text, final: true } },
      ] });
    assert.equal((await admin`SELECT 1 FROM companion_messages WHERE run_id=${followup.id}`).length, 0, channel);
    const events = await admin`SELECT type,payload FROM companion_stream_events WHERE run_id=${followup.id}`;
    assert.ok(events.some(e => e.type === "turn.completed" && e.payload.silent === true), channel);
    assert.ok(events.every(e => !["assistant.delta", "assistant.utterance", "assistant.final", "voice.segment.ready"].includes(e.type)), channel);
    assert.equal((await admin`SELECT status FROM companion_turn_runs WHERE id=${followup.id}`)[0]?.status, "succeeded", channel);
  }
});

test("built-in defaults greet a new account with no saved participation preference", async () => {
  const f = await fixture();
  assert.equal((await transaction(f,tx=>readParticipationPreferences(tx,f))).markdown,"");
  assert.equal(await observe(f),true);
  const [queued] = await admin`SELECT j.id,o.topic FROM jobs j JOIN companion_awareness_observations o ON o.id=(j.payload->>'observationId')::uuid
    WHERE j.requested_by=${f.userId} AND j.type='companion_initiative' AND j.status='pending'`;
  assert.equal(queued!.topic,"app.started");
  await prepare(f);
  let greeted = false;
  const run = await runPrepared(f,async()=>{
    if (greeted) return silentAnswer();
    greeted = true;
    return { content:"",toolCalls:[{id:"startup-greeting",name:"companion_publish_utterance",arguments:{text:"欢迎回来。"}}],
      finishReason:"tool_calls",usage:{promptTokens:10,completionTokens:10},providerRequestId:null };
  });
  const [message] = await admin`SELECT blocks FROM companion_messages WHERE run_id=${run.id} AND role='assistant'`;
  assert.equal(message!.blocks[0].text,"欢迎回来。");
});

test("startup after a failed user turn keeps the history but assembles a host-occasion task", async () => {
  const f = await fixture();
  await observe(f); await prepare(f);
  const [old] = await admin`SELECT id FROM companion_turn_runs WHERE user_id=${f.userId} ORDER BY generation DESC LIMIT 1`;
  const messageId = randomUUID(), question = "P(A)=0 能否推出严格集合包含？请给一个反例。";
  await admin`INSERT INTO companion_messages(id,workspace_id,user_id,conversation_id,seq,role,kind,blocks,content_sha256)
    VALUES(${messageId},${f.workspaceId},${f.userId},${f.conversationId},1,'user','text',
      ${admin.json([{ type: "text", text: question }])},${"a".repeat(64)})`;
  await admin`UPDATE companion_turn_runs SET user_message_id=${messageId},input_source=NULL,status='failed',finished_at=now() WHERE id=${old!.id}`;
  await admin`UPDATE companion_conversations SET next_message_seq=2 WHERE id=${f.conversationId}`;
  f.launchId = randomUUID();
  await observe(f); await prepare(f);
  let checked = false;
  const current = await runPrepared(f, async request => {
    const historical = request.messages.find(message => message.role === "system" && String(message.content).startsWith("<historical_turn_outcome>"));
    assert.ok(historical?.hostObservation, "the terminal question is retained as attributed historical data");
    const record = JSON.parse(String(historical.content).split("\n")[2]!);
    assert.equal(record.originalText, question, "the failed question remains complete and unchanged");
    assert.equal(record.replyStatus, "failed");
    assert.equal(request.messages.filter(message => message.role === "user").length, 0, "no invented or pending user request is appended");
    assert.match(request.systemPrompt, /当前任务是处理末尾 hostObservation/);
    assert.doesNotMatch(request.systemPrompt, /把最后一条消息作为对方向你说的话来接|当前用户请求仍以最后一条 user 消息为准|当前问题以最后一条 user 消息为准/);
    const timeline = JSON.parse(request.systemPrompt.slice(request.systemPrompt.indexOf("<conversation_timeline>")).split("\n")[2]!);
    assert.equal(timeline.current.speaker, "host");
    assert.equal(timeline.history[0].replyTerminal, true);
    if (checked) return silentAnswer();
    checked = true;
    return { ...(await silentAnswer()), toolCalls: [{ id: "host-greeting", name: "companion_publish_utterance", arguments: { text: "欢迎回来，今天怎么样？", final: true } }], finishReason: "tool_calls" };
  });
  assert.ok(checked);
  const [saved] = await admin`SELECT snapshot FROM companion_context_handoff_snapshots WHERE run_id=${current.id}`;
  assert.equal(saved!.snapshot.currentRequest.source, "host_observation");
});

test("content-page help and learning review are built in without personal preferences", async () => {
  const page = await fixture();
  await transaction(page,tx=>recordCompanionAwareness(tx,page,{version:1,id:randomUUID(),appLaunchId:page.launchId,
    deviceSessionId:`device:${page.launchId}`,host:"desktop",topic:"page.arrived",occurredAt:new Date().toISOString(),elapsedMs:0,
    context:{foreground:true,unlocked:true,typing:false,learning:false,conversationId:page.conversationId,
      page:{key:"source-detail:source-1",label:"资料详情",revision:"v1",context:null}}}));
  assert.equal((await admin`SELECT 1 FROM jobs j JOIN companion_awareness_observations o ON o.id=(j.payload->>'observationId')::uuid
    WHERE j.requested_by=${page.userId} AND j.type='companion_initiative' AND o.topic='page.arrived'`).length,1);
  const home = await fixture();
  await transaction(home,tx=>recordCompanionAwareness(tx,home,{version:1,id:randomUUID(),appLaunchId:home.launchId,
    deviceSessionId:`device:${home.launchId}`,host:"desktop",topic:"page.arrived",occurredAt:new Date().toISOString(),elapsedMs:0,
    context:{foreground:true,unlocked:true,typing:false,learning:false,conversationId:home.conversationId,
      page:{key:"home",label:"书房",revision:null,context:null}}}));
  assert.equal((await admin`SELECT 1 FROM jobs WHERE requested_by=${home.userId} AND type='companion_initiative'`).length,0);
  const study = await fixture();
  await transaction(study,tx=>recordCompanionAwareness(tx,study,{version:1,id:randomUUID(),appLaunchId:study.launchId,
    deviceSessionId:`device:${study.launchId}`,host:"desktop",topic:"context.updated",occurredAt:new Date().toISOString(),elapsedMs:0,
    context:{foreground:true,unlocked:true,typing:false,learning:true,conversationId:study.conversationId,
      page:{key:"note-learning:note-1",label:"学习笔记",revision:"v1",context:null}}}));
  assert.equal((await admin`SELECT 1 FROM jobs j JOIN companion_awareness_observations o ON o.id=(j.payload->>'observationId')::uuid
    WHERE j.requested_by=${study.userId} AND j.type='companion_initiative' AND o.topic='study.started'`).length,1);
});

test("ordinary user prose persists across workspaces, has CAS/history, and another user cannot read it", async (t) => {
  const f = await fixture(), other = await fixture();
  const saved = await prefs(f, "学久了提醒我走走；重新打开没看懂的笔记先帮我回忆。");
  assert.equal(saved.revision, 1);
  const anotherWorkspace = randomUUID();
  await admin`INSERT INTO workspaces(id,name,owner_id) VALUES(${anotherWorkspace},'same account',${f.userId})`;
  await admin`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${anotherWorkspace},${f.userId},'owner')`;
  const otherScope = { ...f, workspaceId: anotherWorkspace };
  assert.equal((await transaction(otherScope, tx => readParticipationPreferences(tx, otherScope))).markdown, saved.markdown);
  assert.equal((await transaction(other, tx => readParticipationPreferences(tx, other))).markdown, "");
  /**
   * 「别人读不到本人偏好」必须在**受限角色**连接上验：本仓库的夹具走的是超户串，
   * 超户绕过 RLS，查不到行不等于策略生效，查得到也不等于越权（前一轮就因此
   * 在超户配置下假红、在受限配置下假绿）。用 `scripts/dev-disposable-db.sh` 打印的
   * `RLS_TEST_API_DATABASE_URL` 跑真角色；没有它就明说这一条没验到。
   */
  const apiRoleUrl = process.env.RLS_TEST_API_DATABASE_URL?.trim();
  if (!apiRoleUrl) t.diagnostic("未设 RLS_TEST_API_DATABASE_URL：跳过跨用户 RLS 那条断言（超户连接验不出策略）");
  else {
    const apiRole = postgres(apiRoleUrl, { max: 1 });
    try {
      await apiRole`SELECT set_config('app.workspace_id', ${other.workspaceId}, false)`;
      await apiRole`SELECT set_config('app.user_id', ${other.userId}, false)`;
      assert.equal((await apiRole`SELECT 1 FROM companion_participation_preferences WHERE user_id=${f.userId}`).length, 0,
        "受限角色下别人还是读到了本人的相处偏好");
      await apiRole`SELECT set_config('app.user_id', ${f.userId}, false)`;
      assert.equal((await apiRole`SELECT markdown FROM companion_participation_preferences WHERE user_id=${f.userId}`).length, 1,
        "本人这一侧还是读不到自己的相处偏好");
    } finally { await apiRole.end({ timeout: 2 }); }
  }
  await assert.rejects(() => prefs(f, "修改", 0), /刚刚有变化/);
  const rows = await admin`SELECT revision FROM companion_participation_preference_versions WHERE user_id=${f.userId}`;
  assert.equal(rows.length, 1);
});
test("renderer reload, reconnect and second window cannot create a second launch opportunity", async () => {
  const f = await fixture(); await prefs(f, "每次启动应用跟我问好。");
  assert.equal(await observe(f), true); assert.equal(await observe(f), false);
  await admin`UPDATE companion_awareness_observations SET expires_at=now()-interval '2 days' WHERE user_id=${f.userId}`;
  await transaction(f, tx => tx.execute(sql`SELECT astella_enqueue_companion_attention()`));
  assert.equal(await observe(f), false);
  await admin`UPDATE companion_awareness_observations SET expires_at=now()+interval '2 minutes' WHERE user_id=${f.userId}`;
  await prepare(f);
  const runs = await admin`SELECT user_message_id,input_source FROM companion_turn_runs WHERE user_id=${f.userId}`;
  assert.equal(runs.length, 1); assert.equal(runs[0]!.user_message_id, null);
  assert.equal(runs[0]!.input_source.topic, "app.started");
  assert.equal((await admin`SELECT 1 FROM companion_messages WHERE user_id=${f.userId} AND role='user'`).length, 0);
});
test("heartbeats deduplicate before renewing a lease or crediting foreground study", async () => {
  const f = await fixture();
  const observation = { version:1 as const,id:randomUUID(),appLaunchId:f.launchId,deviceSessionId:`device:${f.launchId}`,
    host:"desktop" as const,topic:"context.updated" as const,occurredAt:new Date().toISOString(),elapsedMs:20_000,
    context:{foreground:true,unlocked:true,typing:false,learning:true,conversationId:f.conversationId,page:null} };
  await transaction(f, tx => recordCompanionAwareness(tx,f,observation));
  await admin`UPDATE companion_awareness_sessions SET updated_at=now()-interval '20 seconds' WHERE user_id=${f.userId}`;
  const next = { ...observation,id:randomUUID(),occurredAt:new Date().toISOString() };
  assert.equal(await transaction(f, tx => recordCompanionAwareness(tx,f,next)),true);
  const [before] = await admin`SELECT updated_at FROM companion_awareness_sessions WHERE user_id=${f.userId}`;
  assert.equal(await transaction(f, tx => recordCompanionAwareness(tx,f,next)),false);
  const [after] = await admin`SELECT updated_at FROM companion_awareness_sessions WHERE user_id=${f.userId}`;
  assert.equal(String(before!.updated_at),String(after!.updated_at));
  const spans = await admin`SELECT extract(epoch FROM ended_at-started_at)*1000 AS duration FROM companion_study_spans WHERE user_id=${f.userId}`;
  assert.equal(spans.length,1); assert.ok(Number(spans[0]!.duration)<=20_000);
  const older = { ...next,id:randomUUID(),occurredAt:new Date(Date.now()-60_000).toISOString() };
  assert.equal(await transaction(f, tx => recordCompanionAwareness(tx,f,older)),false);
  const wakeups = await admin`SELECT o.topic FROM jobs j JOIN companion_awareness_observations o
    ON o.id=(j.payload->>'observationId')::uuid WHERE j.requested_by=${f.userId} AND j.type='companion_initiative'`;
  assert.deepEqual(wakeups.map(row=>row.topic),["study.started"]);
});
test("an attention wake uses the same agent and silence is a successful result", async () => {
  const f = await fixture(); await prefs(f,"学久了提醒我休息。"); await observe(f); await prepare(f);
  const origin = await runPrepared(f,silentAnswer);
  await transaction(f, tx => arrangeCompanionAttention(tx,f,{key:"study-check",expectedRevision:0,intent:"看真实学习时长后再判断是否适合提醒；不适合就安静。",
    topics:["app.foreground"],nextReviewAt:new Date(Date.now()+60_000).toISOString(),expiresAt:null,preferenceRevision:1,selfNote:null,state:"active"},
    {conversationId:f.conversationId,runId:origin.id}));
  await admin`UPDATE companion_attention_plans SET next_review_at=now()-interval '1 second' WHERE user_id=${f.userId}`;
  await transaction(f, tx => tx.execute(sql`SELECT astella_enqueue_companion_attention()`));
  await transaction(f, tx => tx.execute(sql`SELECT astella_enqueue_companion_attention()`));
  const due = await admin`SELECT id FROM jobs WHERE requested_by=${f.userId} AND payload->>'attentionKey'='study-check'`;
  assert.equal(due.length,1);
  await prepare(f); const run = await runPrepared(f,silentAnswer);
  const [result] = await admin`SELECT status FROM companion_turn_runs WHERE id=${run.id}`;
  assert.equal(result!.status,"succeeded");
  assert.equal((await admin`SELECT 1 FROM companion_messages WHERE user_id=${f.userId}`).length,0);
  const [event] = await admin`SELECT payload FROM companion_stream_events WHERE run_id=${run.id} AND type='turn.completed'`;
  assert.equal(event!.payload.silent,true);
});
test("a quiet execution note does not become a conversation message", async () => {
  const f = await fixture(); await prefs(f,"学久了提醒我休息。"); await observe(f); await prepare(f);
  const run = await runPrepared(f,async()=>({ ...(await silentAnswer()), content:"（这轮没有需要补充的新内容，安静收尾。）" }));
  const [result] = await admin`SELECT status FROM companion_turn_runs WHERE id=${run.id}`;
  assert.equal(result!.status,"succeeded");
  assert.equal((await admin`SELECT 1 FROM companion_messages WHERE user_id=${f.userId}`).length,0);
  const events = await admin`SELECT type,payload FROM companion_stream_events WHERE run_id=${run.id} ORDER BY seq`;
  assert.equal(events.filter(event=>event.type==='assistant.final' || event.type==='assistant.utterance').length,0);
  assert.equal(events.find(event=>event.type==='turn.completed')!.payload.silent,true);
});
test("a structured quiet decision finishes without another model call or speech", async () => {
  const f = await fixture(); await observe(f); await prepare(f);
  let calls = 0;
  const run = await runPrepared(f,async request=>{
    calls++;
    assert.equal(calls,1);
    assert.equal(request.disableThinking,true,"Startup consideration should use the light thinking mode");
    return { ...(await silentAnswer()),toolCalls:[{id:"done-silently",name:"companion_finish_participation",arguments:{decision:"silent"}}],finishReason:"tool_calls" };
  });
  const [result] = await admin`SELECT status FROM companion_turn_runs WHERE id=${run.id}`;
  assert.equal(result!.status,"succeeded");
  assert.equal(calls,1);
  assert.equal((await admin`SELECT 1 FROM companion_messages WHERE run_id=${run.id}`).length,0);
  assert.equal((await admin`SELECT 1 FROM companion_stream_events WHERE run_id=${run.id} AND type IN ('assistant.final','assistant.delta','assistant.utterance','voice.segment.ready')`).length,0);
});
test("a pending page opportunity is dropped after its actual page changes", async () => {
  const f = await fixture(); await prefs(f,"进入资料页时，看到实际失败就帮我排障。");
  const base = {version:1 as const,appLaunchId:f.launchId,deviceSessionId:`device:${f.launchId}`,host:"desktop" as const,
    occurredAt:new Date().toISOString(),elapsedMs:0,context:{foreground:true,unlocked:true,typing:false,learning:false,
      conversationId:f.conversationId,page:{key:"source:one",label:"资料",revision:"v1",context:null}}};
  await transaction(f, tx => recordCompanionAwareness(tx,f,{...base,id:randomUUID(),topic:"help.available",
    evidence:{domain:"source",entityId:"one",revision:"v1",description:"资料解析失败，页面显示可重试。"}}));
  await transaction(f, tx => recordCompanionAwareness(tx,f,{...base,id:randomUUID(),topic:"context.updated",occurredAt:new Date().toISOString(),
    context:{...base.context,page:{...base.context.page,key:"home"}}}));
  await prepare(f); assert.equal((await admin`SELECT 1 FROM companion_turn_runs WHERE user_id=${f.userId}`).length,0);
});
test("preference and live presence changes stop an accepted initiative before it publishes", async () => {
  const f = await fixture(); await prefs(f,"每次启动问好。"); await observe(f); await prepare(f);
  const [run] = await admin`SELECT id FROM companion_turn_runs WHERE user_id=${f.userId}`;
  const [account] = await admin`SELECT presence FROM user_companion_account_state WHERE user_id=${f.userId}`;
  await transaction(f, tx => assertCompanionContextSourcesCurrent(tx,f,run!.id));
  await admin`UPDATE user_companion_account_state SET presence='{"presence":"dnd"}'::jsonb WHERE user_id=${f.userId}`;
  await assert.rejects(()=>transaction(f,tx=>assertCompanionContextSourcesCurrent(tx,f,run!.id)),CompanionContextChangedError);
  await admin`UPDATE user_companion_account_state SET presence=${admin.json(account!.presence)} WHERE user_id=${f.userId}`;
  await prefs(f,"以后不用启动问候。",1);
  let calls=0;
  await assert.rejects(()=>runPrepared(f,async()=>{calls++;return silentAnswer();}),CompanionContextChangedError);
  assert.equal(calls,0);
  const [result] = await admin`SELECT status,error_code FROM companion_turn_runs WHERE id=${run!.id}`;
  assert.equal(result!.status,"cancelled");assert.equal(result!.error_code,null);
  assert.equal((await admin`SELECT 1 FROM companion_stream_events WHERE run_id=${run!.id} AND type='error'`).length,0);
});
test("typing takes priority, and a preference correction invalidates the old derived plan", async () => {
  const f = await fixture(); await prefs(f, "每次启动问好。"); await observe(f, true); await prepare(f);
  assert.equal((await admin`SELECT 1 FROM companion_turn_runs WHERE user_id=${f.userId}`).length, 0);
  const p = await fixture(); await prefs(p, "每次启动问好。"); await observe(p); await prepare(p);
  const [origin] = await admin`SELECT id FROM companion_turn_runs WHERE user_id=${p.userId}`;
  await transaction(p, tx => arrangeCompanionAttention(tx, p, { key: "startup", expectedRevision: 0, intent: "依据启动偏好考虑问候",
    topics: ["app.started"], nextReviewAt: null, expiresAt: null, preferenceRevision: 1, selfNote: null, state: "active" },
    { conversationId: p.conversationId, runId: origin!.id }));
  const changed = await prefs(p, "以后不用启动招呼。", 1); assert.equal(changed.revision, 2);
  const [plan] = await admin`SELECT state,next_review_at FROM companion_attention_plans WHERE user_id=${p.userId}`;
  assert.equal(plan!.state,"completed"); assert.equal(plan!.next_review_at,null);
});
for (const userInitiated of [false, true]) test(`the same agent publishes real utterances for ${userInitiated ? "a user reply" : "an initiative"} and ends without a duplicate final`, async () => {
  const f = await fixture(); if (!userInitiated) await prefs(f, "每次启动应用跟我问好。"); await observe(f); await prepare(f);
  const [run] = await admin`SELECT id,job_id FROM companion_turn_runs WHERE user_id=${f.userId}`;
  assert.ok(run);
  if (userInitiated) {
    const userMessageId = randomUUID();
    await admin`INSERT INTO companion_messages(id,workspace_id,user_id,conversation_id,seq,role,kind,blocks,run_id,content_sha256)
      VALUES(${userMessageId},${f.workspaceId},${f.userId},${f.conversationId},1,'user','text',
        '[{"type":"text","text":"可以分几句跟我说，先问好，再问我想学什么。"}]'::jsonb,${run.id},${"0".repeat(64)})`;
    await admin`UPDATE companion_conversations SET next_message_seq=2 WHERE id=${f.conversationId}`;
    await admin`UPDATE companion_turn_runs SET user_message_id=${userMessageId},input_source=NULL WHERE id=${run.id}`;
  }
  await admin`UPDATE jobs SET status='running',started_at=now(),lease_token='fixture-lease' WHERE id=${run.job_id}`;
  const originalTurn = MockProvider.prototype.executeAgentTurn;
  const stream = Object.getOwnPropertyDescriptor(MockProvider.prototype, "chatCompletionStream")!;
  let step = 0;
  MockProvider.prototype.executeAgentTurn = async request => {
    if (step === 0 && !userInitiated) {
      // 主动那一轮没有新的用户话语：宿主观察压在末尾，她后面再没有「刚进来的那句用户话」可答。
      // 过去几轮的 user/assistant 原文照样回放——那是她要接着聊的那段交流本身。
      const observation = request.messages.at(-1)!;
      assert.equal(observation.role, "system");
      assert.equal(observation.hostObservation, true);
      assert.match(String(observation.content), /这不是他发来的话/);
    }
    step++;
    assert.equal(step, 1, "A batch of complete utterances must finish without an extra provider request");
    return { content: "", toolCalls: [
      { id: "say-first", name: "companion_publish_utterance", arguments: { text: "你回来啦。", final: false } },
      { id: "say-last", name: "companion_publish_utterance", arguments: { text: "今天想从哪里开始，我陪你。", final: true } },
    ], finishReason: "tool_calls", usage: { promptTokens: 10, completionTokens: 10 }, providerRequestId: null };
  };
  Object.defineProperty(MockProvider.prototype, "chatCompletionStream", { ...stream, value: undefined });
  try {
    await runCompanionDialogue({ id: run.job_id, payload: { runId: run.id }, workspaceId: f.workspaceId, requestedBy: f.userId,
      leaseToken: "fixture-lease", signal: new AbortController().signal });
  } finally { MockProvider.prototype.executeAgentTurn = originalTurn; Object.defineProperty(MockProvider.prototype, "chatCompletionStream", stream); }
  const messages = await admin`SELECT role,blocks FROM companion_messages WHERE user_id=${f.userId} AND role='assistant' ORDER BY seq`;
  assert.equal(messages.length, 2); assert.ok(messages.every(m => m.role === "assistant"));
  assert.equal(messages[0]!.blocks[0].text, "你回来啦。");
  const [result] = await admin`SELECT status FROM companion_turn_runs WHERE id=${run.id}`; assert.equal(result!.status, "succeeded");
  const events = await admin`SELECT type,payload FROM companion_stream_events WHERE run_id=${run.id} ORDER BY seq`;
  assert.equal(events.filter(e => e.type === "assistant.utterance").length, 2);
  assert.equal(events.filter(e => e.type === "assistant.final").length, 0);
  assert.ok(events.some(e => e.type === "turn.completed"));
  const voice = events.filter(e => e.type === "voice.segment.ready");
  assert.equal(voice.length,2);
  assert.equal(voice[0]!.payload.ordinal,1); assert.equal(voice[1]!.payload.ordinal,2);
  assert.ok(voice[0]!.payload.messageId); assert.notEqual(voice[0]!.payload.messageId,voice[1]!.payload.messageId);
  assert.ok(voice[1]!.payload.displayStart>voice[0]!.payload.displayEnd);
  assert.equal((await admin`SELECT 1 FROM companion_awareness_observations WHERE user_id=${f.userId} AND topic='reply.finished'`).length, userInitiated ? 1 : 0);
  if (userInitiated) assert.equal((await admin`SELECT 1 FROM jobs j JOIN companion_awareness_observations o
    ON o.id=(j.payload->>'observationId')::uuid WHERE j.requested_by=${f.userId} AND j.type='companion_initiative'
      AND o.topic='reply.finished' AND j.status='pending'`).length, 1);
});

test("a due intention yields to typing and can wake again at the same revision", async () => {
  const f = await fixture(); await prefs(f,"学久了提醒我休息。"); await observe(f); await prepare(f);
  const [origin] = await admin`SELECT id FROM companion_turn_runs WHERE user_id=${f.userId}`;
  await admin`UPDATE companion_turn_runs SET status='succeeded',finished_at=now() WHERE id=${origin!.id}`;
  await admin`UPDATE jobs SET status='succeeded' WHERE requested_by=${f.userId}`;
  await admin`UPDATE companion_awareness_sessions SET typing_until=now()+interval '6 seconds' WHERE user_id=${f.userId}`;
  await transaction(f,tx=>arrangeCompanionAttention(tx,f,{key:"study-rest",expectedRevision:0,intent:"读取实际学习时长，再考虑是否提醒走走。",
    topics:["study.started"],nextReviewAt:new Date(Date.now()+60_000).toISOString(),expiresAt:null,preferenceRevision:1,selfNote:null,state:"active"},
    {conversationId:f.conversationId,runId:origin!.id}));
  await admin`UPDATE companion_attention_plans SET next_review_at=now()-interval '1 second' WHERE user_id=${f.userId}`;
  await transaction(f,tx=>tx.execute(sql`SELECT astella_enqueue_companion_attention()`));
  await prepare(f);
  const [deferred] = await admin`SELECT revision,next_review_at FROM companion_attention_plans WHERE user_id=${f.userId}`;
  assert.equal(deferred!.revision,1);assert.ok(deferred!.next_review_at);
  assert.equal((await admin`SELECT 1 FROM companion_turn_runs WHERE user_id=${f.userId}`).length,1);
  await admin`UPDATE companion_awareness_sessions SET typing_until=NULL,context=jsonb_set(context,'{typing}','false') WHERE user_id=${f.userId}`;
  await admin`UPDATE companion_attention_plans SET next_review_at=now()-interval '1 second' WHERE user_id=${f.userId}`;
  await transaction(f,tx=>tx.execute(sql`SELECT astella_enqueue_companion_attention()`));
  assert.equal((await admin`SELECT 1 FROM jobs WHERE requested_by=${f.userId} AND payload->>'attentionKey'='study-rest'`).length,2);
  await prepare(f);const run=await runPrepared(f,silentAnswer);
  assert.equal((await admin`SELECT status FROM companion_turn_runs WHERE id=${run.id}`)[0]!.status,"succeeded");
});

test("an agent's own revision advances its note without rewriting the input, while a user correction fences it", async () => {
  const f=await fixture();await prefs(f,"有新进展再告诉我。");await observe(f);await prepare(f);
  const [origin]=await admin`SELECT id FROM companion_turn_runs WHERE user_id=${f.userId}`;
  await admin`UPDATE companion_turn_runs SET status='succeeded',finished_at=now() WHERE id=${origin!.id}`;
  await transaction(f,async tx=>{
    await writeCompanionSelfNote(tx,f,{key:"own-inquiry",expectedRevision:0,title:"一个有来源的疑问",body:"先查阅，再形成自己的认识。",
      tier:"active",nextReviewAt:null,expiresAt:null,reason:"保留未完关注。"});
    await arrangeCompanionAttention(tx,f,{key:"own-plan",expectedRevision:0,intent:"推进自己的疑问，没新内容就安静结束。",
      topics:[],nextReviewAt:new Date(Date.now()+60_000).toISOString(),expiresAt:null,preferenceRevision:null,
      selfNote:{key:"own-inquiry",revision:1},state:"active"},{conversationId:f.conversationId,runId:origin!.id});
  });
  await admin`UPDATE companion_attention_plans SET next_review_at=now()-interval '1 second' WHERE user_id=${f.userId}`;
  await transaction(f,tx=>tx.execute(sql`SELECT astella_enqueue_companion_attention()`));await prepare(f);
  let calls=0;const run=await runPrepared(f,async()=>calls++===0?{content:"",toolCalls:[{id:"advance-own-note",name:"companion_write_self_note",
    arguments:{key:"own-inquiry",expectedRevision:1,title:"一个有来源的疑问",body:"已记录这次实际推敲；下次有依据再接着查。",
      tier:"active",nextReviewAt:null,expiresAt:null,reason:"完成这次有界考虑。"}}],finishReason:"tool_calls",usage:{promptTokens:10,completionTokens:10},providerRequestId:null}:await silentAnswer());
  const [saved]=await admin`SELECT revision FROM companion_self_notes WHERE user_id=${f.userId}`;assert.equal(saved!.revision,2);
  const [input]=await admin`SELECT input_source,status FROM companion_turn_runs WHERE id=${run.id}`;
  assert.equal(input!.status,"succeeded");assert.equal(input!.input_source.facts.selfNote.revision,1);
  await transaction(f,tx=>assertCompanionContextSourcesCurrent(tx,f,run.id));
  await transaction(f,tx=>writeCompanionSelfNote(tx,f,{key:"own-inquiry",expectedRevision:2,title:"用户纠正了这个疑问",body:"先按这次纠正重新核对。",
    tier:"active",nextReviewAt:null,expiresAt:null,reason:"用户更正。"}));
  await assert.rejects(()=>transaction(f,tx=>assertCompanionContextSourcesCurrent(tx,f,run.id)),CompanionContextChangedError);
});

test("the same domain fact cannot reopen a help opportunity after a renderer reload", async () => {
  const f = await fixture();
  const fact = { version: 1 as const, id: randomUUID(), appLaunchId: f.launchId,
    deviceSessionId: `device:${f.launchId}`, host: "desktop" as const, topic: "help.available" as const,
    occurredAt: new Date().toISOString(), elapsedMs: 0,
    context: { foreground: true, unlocked: true, typing: false, learning: false,
      conversationId: f.conversationId, page: { key: "source:fixture", label: "资料", revision: "1", context: null } },
    evidence: { domain: "source" as const, entityId: "source:fixture", revision: "failed:1", description: "这次资料处理失败，有可用的重试入口。" } };
  assert.equal(await transaction(f, tx => recordCompanionAwareness(tx, f, fact)), true);
  assert.equal(await transaction(f, tx => recordCompanionAwareness(tx, f,
    { ...fact, id: randomUUID(), occurredAt: new Date().toISOString() })), false);
  assert.equal((await admin`SELECT 1 FROM jobs WHERE requested_by=${f.userId} AND type='companion_initiative'`).length, 1);
  assert.equal(await transaction(f, tx => recordCompanionAwareness(tx, f,
    { ...fact, id: randomUUID(), occurredAt: new Date().toISOString(), evidence: { ...fact.evidence, revision: "failed:2" } })), true);
  assert.equal((await admin`SELECT 1 FROM jobs WHERE requested_by=${f.userId} AND type='companion_initiative'`).length, 2);
});

test("ordinary complete answer is one message; a useful later thought uses an independent proactive run", async () => {
  const f = await fixture();
  await observe(f); await prepare(f);
  const [parent] = await admin`SELECT id FROM companion_turn_runs WHERE user_id=${f.userId}`;
  const userMessageId = randomUUID();
  await admin`INSERT INTO companion_messages(id,workspace_id,user_id,conversation_id,seq,role,kind,blocks,run_id,content_sha256)
    VALUES(${userMessageId},${f.workspaceId},${f.userId},${f.conversationId},1,'user','text',
      '[{"type":"text","text":"setTimeout 的作用是什么？"}]'::jsonb,${parent!.id},${"0".repeat(64)})`;
  await admin`UPDATE companion_conversations SET next_message_seq=2 WHERE id=${f.conversationId}`;
  await admin`UPDATE companion_turn_runs SET user_message_id=${userMessageId},input_source=NULL WHERE id=${parent!.id}`;
  await runPrepared(f, async () => ({ content: "setTimeout 把一个函数安排在指定延迟后执行。", toolCalls: [],
    finishReason: "stop", usage: { promptTokens: 10, completionTokens: 10 }, providerRequestId: null }));
  const before = await admin`SELECT id,run_id FROM companion_messages WHERE user_id=${f.userId} AND role='assistant'`;
  assert.equal(before.length,1);
  const firstEvents = await admin`SELECT type FROM companion_stream_events WHERE run_id=${parent!.id}`;
  assert.equal(firstEvents.filter(event => event.type === 'assistant.utterance').length,0);
  assert.equal(firstEvents.filter(event => event.type === 'assistant.final').length,1);
  await prepare(f);
  const child = await runPrepared(f,async request => {
    const observation = request.messages.at(-1)!;
    assert.match(String(observation.content), /刚把用户那一轮答完/, "答后考虑要说清这是接着刚才那一轮");
    return { content: "", toolCalls: [{ id: "useful-new-thought", name: "companion_publish_utterance",
      arguments: { text: "有个容易误用的细节：这个延迟只是最早时间，主线程忙时回调会更晚执行。" } }],
      finishReason: "tool_calls", usage: { promptTokens: 10, completionTokens: 10 }, providerRequestId: null };
  });
  assert.notEqual(child.id,parent!.id);
  const messages = await admin`SELECT run_id,blocks FROM companion_messages WHERE user_id=${f.userId} AND role='assistant' ORDER BY seq`;
  assert.equal(messages.length,2); assert.notEqual(messages[0]!.run_id,messages[1]!.run_id);
  const [source] = await admin`SELECT input_source FROM companion_turn_runs WHERE id=${child.id}`;
  assert.equal(source!.input_source.parentRunId,parent!.id);
  const observations = await admin`SELECT id FROM companion_awareness_observations WHERE user_id=${f.userId} AND topic='reply.finished'`;
  assert.equal(observations.length,1,'补充不能给自己再安排一轮补充');
});

test("an internal execution reads the exchange as a conversation, with the host event last", async () => {
  const f = await fixture();
  await admin`INSERT INTO companion_messages(id,workspace_id,user_id,conversation_id,seq,role,kind,blocks,content_sha256)
    VALUES(${randomUUID()},${f.workspaceId},${f.userId},${f.conversationId},1,'assistant','text',
      '[{"type":"text","text":"上次已经解释过递归的终止条件。"}]'::jsonb,${"0".repeat(64)})`;
  await admin`UPDATE companion_conversations SET next_message_seq=2 WHERE id=${f.conversationId}`;
  await prefs(f, "有值得补充的新内容再说。"); await observe(f); await prepare(f);
  const run = await runPrepared(f, async request => {
    // 她要说的是「接着刚才」，所以刚才那句得是真实的一轮，不是报表里的一个字段。
    const spoken = request.messages.filter(message => message.role === "assistant");
    assert.equal(spoken.length, 1, "已发布的发言按真实消息回放");
    assert.match(String(spoken[0]!.content), /上次已经解释过递归的终止条件/);
    // 但它不是本轮的草稿：观察压在末尾，回放的消息不带上一轮的工具与思考句柄。
    const observation = request.messages.at(-1)!;
    assert.equal(observation.role, "system");
    assert.equal(observation.hostObservation, true);
    for (const message of request.messages) {
      assert.equal((message as { toolCalls?: unknown }).toolCalls, undefined, "跨运行的工具句柄不能拼进新的原生工具轮");
      assert.equal((message as { reasoning?: unknown }).reasoning, undefined, "跨运行的思考句柄不能拼进新的原生工具轮");
    }
    const text = String(observation.content);
    assert.match(text, /这不是他发来的话/, "她要知道这不是用户又发了一句");
    for (const plumbing of ["preparationJobId", "recentDialogue", "attentionRevision"])
      assert.ok(!text.includes(plumbing), `宿主内部字段 ${plumbing} 不该出现在她的观察里`);
    return silentAnswer();
  });
  assert.equal((await admin`SELECT status FROM companion_turn_runs WHERE id=${run.id}`)[0]!.status,"succeeded");
});

test("attention verification preserves satisfied state and still enforces CAS and live authority", async () => {
  const f = await fixture(); await prefs(f, "安静时可以想起点什么。"); await observe(f); await prepare(f);
  const [run] = await admin`SELECT id FROM companion_turn_runs WHERE user_id=${f.userId}`;
  const origin = { conversationId: f.conversationId, runId: run!.id };
  const plan = { key: "quiet", expectedRevision: 0, intent: "只关注前台安静事件。",
    topics: ["presence.quiet", "app.foreground"] as ("presence.quiet" | "app.foreground")[],
    nextReviewAt: null, expiresAt: null, preferenceRevision: 1, selfNote: null, state: "active" as const };
  const created = await transaction(f, tx => arrangeCompanionAttention(tx, f, plan, origin));
  assert.equal(created.changed, true);
  const verified = await transaction(f, tx => arrangeCompanionAttention(tx, f,
    { ...plan, expectedRevision: 1, topics: ["app.foreground", "presence.quiet", "presence.quiet"] }, origin));
  assert.equal(verified.changed, false);
  assert.deepEqual(verified.attention, created.attention, "verification preserves version, timestamp, origin and topics");
  await assert.rejects(transaction(f, tx => arrangeCompanionAttention(tx, f, plan, origin)),
    { code: "attention_stale" }, "an identical payload cannot bypass a stale CAS");
  const changed = await transaction(f, tx => arrangeCompanionAttention(tx, f,
    { ...plan, expectedRevision: 1, topics: ["presence.quiet"] }, origin));
  assert.equal(changed.changed, true); assert.equal(changed.attention.revision, 2);
  await prefs(f, "安静时也不要主动说话。", 1);
  await assert.rejects(transaction(f, tx => arrangeCompanionAttention(tx, f,
    { ...plan, expectedRevision: 2, topics: ["presence.quiet"] }, origin)), { code: "participation_stale" });
});

test("identical preference writes preserve plans, while a newly affirmed source renews authority", async () => {
  const f = await fixture(); await prefs(f, "只在安静时主动说话。"); await observe(f); await prepare(f);
  const [run] = await admin`SELECT id FROM companion_turn_runs WHERE user_id=${f.userId}`;
  const origin = { conversationId: f.conversationId, runId: run!.id };
  await transaction(f, tx => arrangeCompanionAttention(tx, f, { key: "quiet", expectedRevision: 0, intent: "安静时考虑说一句。",
    topics: ["presence.quiet"], nextReviewAt: null, expiresAt: null, preferenceRevision: 1, selfNote: null, state: "active" }, origin));
  const before = await transaction(f, tx => readParticipationPreferences(tx, f));
  const input = { expectedRevision: 1, markdown: before.markdown, enabled: true, source: before.source! };
  const replay = await transaction(f, tx => writeParticipationPreferences(tx, f, input));
  assert.equal(replay.changed, false); assert.deepEqual(replay.preferences, before);
  assert.equal((await admin`SELECT state FROM companion_attention_plans WHERE user_id=${f.userId}`)[0]!.state, "active");
  await assert.rejects(transaction(f, tx => writeParticipationPreferences(tx, f, { ...input, expectedRevision: 0 })), { code: "participation_stale" });
  const messageId = randomUUID();
  await admin`INSERT INTO companion_messages(id,workspace_id,user_id,conversation_id,seq,role,kind,blocks,content_sha256)
    VALUES(${messageId},${f.workspaceId},${f.userId},${f.conversationId},1,'user','text',
      '[{"type":"text","text":"只在安静时主动说话。"}]'::jsonb,${"0".repeat(64)})`;
  const renewed = await transaction(f, tx => writeParticipationPreferences(tx, f,
    { ...input, source: { kind: "user_message", workspaceId: f.workspaceId, messageId, quote: before.markdown } }));
  assert.equal(renewed.changed, true); assert.equal(renewed.preferences.revision, 2);
  assert.equal((await admin`SELECT state FROM companion_attention_plans WHERE user_id=${f.userId}`)[0]!.state, "completed");
});

test("attention receipts reflect completed timers and reject expired or invalid note authority", async () => {
  const f = await fixture(); await observe(f); await prepare(f);
  const [run] = await admin`SELECT id FROM companion_turn_runs WHERE user_id=${f.userId}`;
  const origin = { conversationId: f.conversationId, runId: run!.id };
  const plan = { key: "own", expectedRevision: 0, intent: "关注一个真实疑问。", topics: ["presence.quiet"] as "presence.quiet"[],
    nextReviewAt: null, expiresAt: null, preferenceRevision: null, selfNote: null, state: "active" as const };
  await assert.rejects(transaction(f, tx => arrangeCompanionAttention(tx, f,
    { ...plan, expiresAt: new Date(Date.now() - 1_000).toISOString() }, origin)), { code: "attention_expired" });
  await assert.rejects(transaction(f, tx => arrangeCompanionAttention(tx, f,
    { ...plan, nextReviewAt: new Date(Date.now() + 60_000).toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString() }, origin)),
    { code: "attention_after_expiry" });
  const completed = await transaction(f, tx => arrangeCompanionAttention(tx, f,
    { ...plan, state: "completed", nextReviewAt: new Date(Date.now() - 1_000).toISOString() }, origin));
  assert.equal(completed.attention.nextReviewAt, null);
  assert.equal((await admin`SELECT next_review_at FROM companion_attention_plans WHERE user_id=${f.userId}`)[0]!.next_review_at, null);
  await transaction(f, tx => writeCompanionSelfNote(tx, f, { key: "inquiry", expectedRevision: 0, title: "疑问", body: "还需要查证。",
    tier: "active", nextReviewAt: null, expiresAt: null, reason: "保留未完关注。" }));
  const linked = { ...plan, key: "linked", selfNote: { key: "inquiry", revision: 1 } };
  await transaction(f, tx => arrangeCompanionAttention(tx, f, linked, origin));
  await admin`UPDATE companion_self_notes SET user_disabled=true WHERE user_id=${f.userId} AND entry_key='inquiry'`;
  await assert.rejects(transaction(f, tx => arrangeCompanionAttention(tx, f, { ...linked, expectedRevision: 1 }, origin)), { code: "self_note_stale" });
});

test("a rejected attention revision has a known outcome and can be corrected by the same agent", async () => {
  const f = await fixture(); await prefs(f,"学习开始后关注休息时机。"); await observe(f); await prepare(f);
  let step = 0;
  const run = await runPrepared(f, async request => {
    if (step === 2) return silentAnswer();
    if (step === 1) assert.ok(request.messages.some(message => message.role === "tool" && String(message.content).includes("not_executed")));
    const expectedRevision = step++ === 0 ? 1 : 0;
    return { content: "", toolCalls: [{ id: `arrange:${step}`, name: "companion_arrange_attention", arguments: {
      key: "study-rest", expectedRevision, intent: "有实际学习时段后再判断休息时机。", topics: ["study.started"],
      nextReviewAt: null, expiresAt: null, preferenceRevision: 1, selfNote: null, state: "active" } }],
      finishReason: "tool_calls", usage: { promptTokens: 10, completionTokens: 10 }, providerRequestId: null };
  });
  const calls = await admin`SELECT status FROM companion_agent_tool_calls WHERE run_id=${run.id} ORDER BY created_at`;
  assert.deepEqual(calls.map(call => call.status),["not_executed","succeeded"]);
  assert.equal((await admin`SELECT revision FROM companion_attention_plans WHERE user_id=${f.userId}`)[0]!.revision,1);
  assert.equal((await admin`SELECT status FROM companion_turn_runs WHERE id=${run.id}`)[0]!.status,"succeeded");
});

test("a due wake waits until she is actually at the app instead of burning itself", async () => {
  const f = await fixture(); await prefs(f, "学久了提醒我走走。"); await observe(f); await prepare(f);
  const [origin] = await admin`SELECT id FROM companion_turn_runs WHERE user_id=${f.userId}`;
  await transaction(f, tx => arrangeCompanionAttention(tx, f, { key: "study-rest", expectedRevision: 0,
    intent: "接着看这段前台学习够不够长，够就提醒起身。", topics: ["study.started"],
    nextReviewAt: new Date(Date.now() + 30_000).toISOString(), expiresAt: null, preferenceRevision: 1,
    selfNote: null, state: "active" }, { conversationId: f.conversationId, runId: origin!.id }));
  await admin`UPDATE companion_attention_plans SET next_review_at=now()-interval '1 second' WHERE user_id=${f.userId}`;
  // 人走了：租约过期。到点也不该被吃掉——吃掉又没说出来，这条关注就永久睡着了。
  await admin`UPDATE companion_awareness_sessions SET updated_at=now()-interval '2 minutes' WHERE user_id=${f.userId}`;
  assert.equal(Number((await admin`SELECT astella_enqueue_companion_attention() AS n`)[0]!.n), 0);
  assert.ok((await admin`SELECT next_review_at FROM companion_attention_plans WHERE user_id=${f.userId}`)[0]!.next_review_at,
    "她回来之前这次安排要一直留着");
  assert.equal((await admin`SELECT 1 FROM jobs WHERE requested_by=${f.userId} AND type='companion_initiative'
    AND status='pending' AND payload->>'attentionKey' IS NOT NULL`).length, 0);
  // 她回来了：同一条安排这一次真的唤起。
  await admin`UPDATE companion_awareness_sessions SET updated_at=now() WHERE user_id=${f.userId}`;
  assert.equal(Number((await admin`SELECT astella_enqueue_companion_attention() AS n`)[0]!.n), 1);
  assert.equal((await admin`SELECT next_review_at FROM companion_attention_plans WHERE user_id=${f.userId}`)[0]!.next_review_at, null);
});

test("one note earns one help chance per launch, not one per saved version", async () => {
  const f = await fixture(), noteId = randomUUID();
  const arrive = (revision: string) => transaction(f, tx => recordCompanionAwareness(tx, f, {
    version: 1, id: randomUUID(), appLaunchId: f.launchId, deviceSessionId: `device:${f.launchId}`, host: "desktop",
    topic: "page.arrived", occurredAt: new Date().toISOString(), elapsedMs: 0,
    context: { foreground: true, unlocked: true, typing: false, learning: false, conversationId: f.conversationId,
      page: { key: `note-read:${noteId}`, label: "笔记", revision, context: null } } }));
  assert.equal(await arrive("version-1"), true);
  // 同一篇笔记又存了一版：还是这次启动里的那一页，不再要一整轮模型。
  assert.equal(await arrive("version-2"), false);
  assert.equal((await admin`SELECT 1 FROM companion_awareness_observations WHERE user_id=${f.userId} AND topic='page.arrived'`).length, 1);
  assert.equal((await admin`SELECT 1 FROM jobs WHERE requested_by=${f.userId} AND type='companion_initiative'
    AND payload->>'observationId' IS NOT NULL`).length, 1);
});

test("a routine opening yields to the account's declared cadence while a greeting does not", async () => {
  const f = await fixture();
  await admin`UPDATE user_companion_account_state SET intervention_level='moderate' WHERE user_id=${f.userId}`;
  const arrive = (noteId: string) => transaction(f, tx => recordCompanionAwareness(tx, f, { version: 1, id: randomUUID(),
    appLaunchId: f.launchId, deviceSessionId: `device:${f.launchId}`, host: "desktop", topic: "page.arrived",
    occurredAt: new Date().toISOString(), elapsedMs: 0,
    context: { foreground: true, unlocked: true, typing: false, learning: false, conversationId: f.conversationId,
      page: { key: `note-read:${noteId}`, label: "笔记", revision: "version-1", context: null } } }));
  // 她刚在另一篇笔记上搭过一次话：这一次真的产出了消息，间隔从这一刻开始计。
  await arrive(randomUUID());
  await prepare(f);
  await runPrepared(f, async () => ({ content: "", toolCalls: [{ id: "first-help", name: "companion_publish_utterance",
    arguments: { text: "这篇的开头有个容易混的地方。" } }], finishReason: "tool_calls",
    usage: { promptTokens: 10, completionTokens: 10 }, providerRequestId: null }));
  assert.equal((await admin`SELECT 1 FROM companion_messages WHERE user_id=${f.userId} AND role='assistant'`).length, 1);
  // 换一篇笔记：仍然是「她自己新起的话题」，适中档 30 分钟内不再起一整轮。
  await arrive(randomUUID());
  await prepare(f);
  assert.equal((await admin`SELECT 1 FROM companion_turn_runs WHERE user_id=${f.userId}`).length, 1,
    "到页面的搭话是新起话题，适中档 30 分钟内刚说过就不再起一整轮");
  // 招呼是用户先要过的相处方式，不进**档位节奏**（适中档 30 分钟）。
  // 2026-10-16 用户口径（全局主动不用节流太严重）新增了一条 2 分钟的跨话题地板，
  // 它也管触发式话题；所以这里把上一次开口挪到地板窗口之外，验的仍然是
  // "招呼不受档位节奏管"这件事本身。
  await admin`UPDATE assistant_deliveries SET created_at=now()-interval '10 minutes' WHERE user_id=${f.userId}`;
  await observe(f); await prepare(f);
  assert.equal((await admin`SELECT 1 FROM companion_turn_runs WHERE user_id=${f.userId}`).length, 2);
});

/**
 * 2026-10-14 用户判定"第一版还是不太行"之后，这条判据反过来钉。
 *
 * 旧实现把"安静结束的那次考虑"也算一次主动，于是她每档只能开一次口，而只要有一次
 * 选择不说，下一次机会又往后推一整个间隔——实链路复现的体感就是"她从来不主动"。
 * 现在：只有真的产出了 assistant 消息的运行才算一次开口；沉默是成本问题，
 * 由每档的安静门槛与"一段安静只开一次门"管。
 */
test("a quiet chance below the level's threshold is not an occasion, and silence does not spend the cadence", async () => {
  const f = await fixture();
  await admin`UPDATE user_companion_account_state SET intervention_level='moderate' WHERE user_id=${f.userId}`;
  const runs = async () => Number((await admin`SELECT count(*)::int AS n FROM companion_turn_runs WHERE user_id=${f.userId}`)[0]!.n);
  const quiet = (quietForMs: number) => transaction(f, tx => recordCompanionAwareness(tx, f, { version: 1, id: randomUUID(),
    appLaunchId: f.launchId, deviceSessionId: `device:${f.launchId}`, host: "desktop", topic: "presence.quiet",
    occurredAt: new Date().toISOString(), elapsedMs: 0,
    context: { foreground: true, unlocked: true, typing: false, learning: false, speaking: false,
      participationAllowed: true, quietForMs, conversationId: f.conversationId,
      page: { key: "home", label: "书房", revision: null, context: null } } }));

  // 客户端在安静满 90 秒时就会上报；适中档要 3 分钟才算一个合适的开口时机。
  assert.equal(await quiet(120_000), true, "不到门槛的安静仍然如实入库");
  await prepare(f);
  assert.equal(await runs(), 0, "适中档 2 分钟的安静还不到开口时机");

  // 真的安静下来了：起一轮，她这一轮选择不说。
  assert.equal(await quiet(240_000), true);
  await prepare(f);
  assert.equal(await runs(), 1);
  await runPrepared(f, async () => silentAnswer());

  // 沉默不吃额度：下一段安静照旧可以起一轮。旧实现正是在这里把她静音掉的。
  assert.equal(await quiet(240_000), true);
  await prepare(f);
  assert.equal(await runs(), 2, "安静结束不该把下一次机会推后一整个间隔——那正是「她从来不主动」的成因");
  await runPrepared(f, async () => silentAnswer());

  // 她真的说了话：这一次才开始计间隔。
  assert.equal(await quiet(240_000), true);
  await prepare(f);
  assert.equal(await runs(), 3);
  await runPrepared(f, async () => ({ content: "", toolCalls: [{ id: "say-hi", name: "companion_publish_utterance",
    arguments: { text: "在呢。今天怎么样？" } }], finishReason: "tool_calls", usage: { promptTokens: 10, completionTokens: 10 }, providerRequestId: null }));
  assert.equal((await admin`SELECT 1 FROM companion_messages WHERE user_id=${f.userId} AND role='assistant'`).length, 1,
    "她真的开了一次口，这一次才该被算进间隔");

  assert.equal(await quiet(240_000), true);
  await prepare(f);
  assert.equal(await runs(), 3, "刚说过一句之后，适中档 30 分钟内的下一段安静不再起新话题");

  // 招呼仍然不进**档位**这条闸：用户先要过的东西不受她自己说话的节奏管。
  // 它进的是 2026-10-16 新增的那条 2 分钟跨话题地板，所以先把上一次开口挪出窗口。
  await admin`UPDATE assistant_deliveries SET created_at=now()-interval '10 minutes' WHERE user_id=${f.userId}`;
  await observe(f); await prepare(f);
  assert.equal((await admin`SELECT 1 FROM companion_turn_runs WHERE user_id=${f.userId} AND input_source->>'topic'='app.started'`).length, 1);
});

test("a due attention she arranged herself is not pushed away by her own cadence", async () => {
  const f = await fixture();
  await admin`UPDATE user_companion_account_state SET intervention_level='moderate' WHERE user_id=${f.userId}`;
  // 她先在一篇笔记上搭过一次话：这一次真的产出了消息，间隔从这一刻开始计。
  await transaction(f, tx => recordCompanionAwareness(tx, f, { version: 1, id: randomUUID(), appLaunchId: f.launchId,
    deviceSessionId: `device:${f.launchId}`, host: "desktop", topic: "page.arrived", occurredAt: new Date().toISOString(), elapsedMs: 0,
    context: { foreground: true, unlocked: true, typing: false, learning: false, conversationId: f.conversationId,
      page: { key: `note-read:${randomUUID()}`, label: "笔记", revision: "version-1", context: null } } }));
  await prepare(f);
  const spoke = await runPrepared(f, async () => ({ content: "", toolCalls: [{ id: "first-help", name: "companion_publish_utterance",
    arguments: { text: "这篇的开头有个容易混的地方。" } }], finishReason: "tool_calls",
    usage: { promptTokens: 10, completionTokens: 10 }, providerRequestId: null }));
  // 同一次运行里她自己排了一条「回头再看一眼」——这是她答应自己（和用户）的事。
  await transaction(f, tx => arrangeCompanionAttention(tx, f, { key: "own-plan", expectedRevision: 0,
    intent: "接着想他上次没弄懂的那一步；没有新内容就安静结束。", topics: [], nextReviewAt: new Date(Date.now() + 3_600_000).toISOString(),
    expiresAt: null, preferenceRevision: null, selfNote: null, state: "active" },
    { conversationId: f.conversationId, runId: spoke.id }));
  await admin`UPDATE companion_attention_plans SET next_review_at=now()-interval '1 second' WHERE user_id=${f.userId}`;
  // 到点由维护 tick 入队（在场才入队），而不是靠她自己再起一个新话题。
  await admin`UPDATE companion_awareness_sessions SET updated_at=now() WHERE user_id=${f.userId}`;
  await admin`SELECT astella_enqueue_companion_attention()`;
  const queued = await admin`SELECT payload FROM jobs WHERE requested_by=${f.userId} AND type='companion_initiative' AND status='pending'`;
  assert.ok(queued.some(row => row.payload.attentionKey === "own-plan"), "到点的关注要真的入队");
  await prepare(f);
  assert.equal((await admin`SELECT 1 FROM companion_turn_runs WHERE user_id=${f.userId} AND input_source->>'topic'='attention.due'`).length, 1,
    "她先前答应自己回来看一眼的事，不该被自己刚说过一句话挡掉");
});

test("initiative without a hint uses the existing inbox rather than creating a detached dialogue", async () => {
  const f = await fixture(), inboxId = randomUUID();
  await admin`INSERT INTO companion_conversations(id,workspace_id,user_id,kind,title,title_source,status)
    VALUES(${inboxId},${f.workspaceId},${f.userId},'inbox','inbox','system','active')`;
  await transaction(f, tx => recordCompanionAwareness(tx, f, { version: 1, id: randomUUID(), appLaunchId: f.launchId,
    deviceSessionId: `device:${f.launchId}`, host: "desktop", topic: "app.started", occurredAt: new Date().toISOString(), elapsedMs: 0,
    context: { foreground: true, unlocked: true, typing: false, learning: false, conversationId: null,
      page: { key: "home", label: "书房", revision: null, context: null } } }));
  await prepare(f);
  const [run] = await admin`SELECT conversation_id FROM companion_turn_runs WHERE user_id=${f.userId}`;
  assert.equal(run?.conversation_id, inboxId);
});

test("one quiet spell is considered once; new input cancels stale opportunities and rearms consideration", async () => {
  const f = await fixture(), firstEpisode = randomUUID(), nextEpisode = randomUUID();
  const deviceSessionId = `device:${f.launchId}`;
  const context = (quietEpisodeId: string) => ({ foreground: true, unlocked: true, typing: false, learning: false,
    quietEpisodeId, conversationId: f.conversationId, page: { key: "home", label: "书房", revision: null, context: null } });
  const quiet = (quietEpisodeId: string, quietForMs = 240_000) => transaction(f, tx => recordCompanionAwareness(tx, f,
    { version: 1, id: randomUUID(), appLaunchId: f.launchId, deviceSessionId, host: "desktop", topic: "presence.quiet",
      occurredAt: new Date().toISOString(), elapsedMs: 0, context: { ...context(quietEpisodeId), quietForMs } }));
  const count = async () => (await admin`SELECT 1 FROM companion_turn_runs WHERE user_id=${f.userId}`).length;
  await quiet(firstEpisode); await prepare(f);
  await runPrepared(f, silentAnswer);
  await quiet(firstEpisode, 330_000); await prepare(f);
  assert.equal(await count(), 1, "silent outcome must not cause another paid run for the same pause");
  await quiet(firstEpisode, 420_000);
  await transaction(f, tx => recordCompanionAwareness(tx, f, { version: 1, id: randomUUID(), appLaunchId: f.launchId,
    deviceSessionId, host: "desktop", topic: "context.updated", occurredAt: new Date().toISOString(), elapsedMs: 0,
    context: context(nextEpisode) }));
  await prepare(f);
  assert.equal(await count(), 1, "an observation queued before activity no longer owns a speaking opportunity");
  await quiet(nextEpisode); await prepare(f);
  assert.equal(await count(), 2, "new activity starts a new opportunity without a speech cooldown from silence");
  const [run] = await admin`SELECT id FROM companion_turn_runs WHERE user_id=${f.userId} ORDER BY generation DESC LIMIT 1`;
  await transaction(f, tx => recordCompanionAwareness(tx, f, { version: 1, id: randomUUID(), appLaunchId: f.launchId,
    deviceSessionId, host: "desktop", topic: "context.updated", occurredAt: new Date().toISOString(), elapsedMs: 0,
    context: context(randomUUID()) }));
  await assert.rejects(transaction(f, tx => assertCompanionContextSourcesCurrent(tx, f, run!.id)),
    /context|上下文|CONTEXT/i, "new input also revokes a model run already in progress");
});
