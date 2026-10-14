import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import type { AgentTurnRequest, AgentTurnResult } from "@astella/shared";
import { assertCompanionContextSourcesCurrent } from "../handlers/companion-context-sources.ts";
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
const prefs = (f: Fixture, markdown: string, expectedRevision = 0) => transaction(f, tx => writeParticipationPreferences(tx, f,
  { markdown, enabled: true, expectedRevision, source: { kind: "settings", workspaceId: f.workspaceId, messageId: null, quote: null } }));
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
  await assert.rejects(()=>transaction(f,tx=>assertCompanionContextSourcesCurrent(tx,f,run!.id)),/已变更或撤回/);
  await admin`UPDATE user_companion_account_state SET presence=${admin.json(account!.presence)} WHERE user_id=${f.userId}`;
  await prefs(f,"以后不用启动问候。",1);
  let calls=0;
  await assert.rejects(()=>runPrepared(f,async()=>{calls++;return silentAnswer();}),/已变更或撤回/);
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
  await assert.rejects(()=>transaction(f,tx=>assertCompanionContextSourcesCurrent(tx,f,run.id)),/已变更或撤回/);
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
  await admin`INSERT INTO companion_messages(id,workspace_id,user_id,conversation_id,seq,role,kind,blocks,content_sha256,created_at)
    VALUES(${randomUUID()},${f.workspaceId},${f.userId},${f.conversationId},1,'assistant','proactive',
      '[{"type":"text","text":"刚才那段要不要再看一遍。"}]'::jsonb,${"0".repeat(64)},now()-interval '10 minutes')`;
  await admin`UPDATE companion_conversations SET next_message_seq=2 WHERE id=${f.conversationId}`;
  const noteId = randomUUID();
  await transaction(f, tx => recordCompanionAwareness(tx, f, { version: 1, id: randomUUID(), appLaunchId: f.launchId,
    deviceSessionId: `device:${f.launchId}`, host: "desktop", topic: "page.arrived", occurredAt: new Date().toISOString(), elapsedMs: 0,
    context: { foreground: true, unlocked: true, typing: false, learning: false, conversationId: f.conversationId,
      page: { key: `note-read:${noteId}`, label: "笔记", revision: "version-1", context: null } } }));
  await prepare(f);
  assert.equal((await admin`SELECT 1 FROM companion_turn_runs WHERE user_id=${f.userId}`).length, 0,
    "到页面的搭话是新起话题，90 分钟前刚说过就不再起一整轮");
  // 招呼是用户先要过的相处方式，不进这条节奏。
  await observe(f); await prepare(f);
  assert.equal((await admin`SELECT 1 FROM companion_turn_runs WHERE user_id=${f.userId}`).length, 1);
});

test("a quiet-presence chance is considered once per declared cadence, even when she says nothing", async () => {
  const f = await fixture();
  await admin`UPDATE user_companion_account_state SET intervention_level='moderate' WHERE user_id=${f.userId}`;
  const quiet = () => transaction(f, tx => recordCompanionAwareness(tx, f, { version: 1, id: randomUUID(),
    appLaunchId: f.launchId, deviceSessionId: `device:${f.launchId}`, host: "desktop", topic: "presence.quiet",
    occurredAt: new Date().toISOString(), elapsedMs: 0,
    context: { foreground: true, unlocked: true, typing: false, learning: false, speaking: false,
      participationAllowed: true, quietForMs: 240_000, conversationId: f.conversationId,
      page: { key: "home", label: "书房", revision: null, context: null } } }));
  assert.equal(await quiet(), true);
  await prepare(f);
  await runPrepared(f, async () => silentAnswer());
  // 又一轮安静：她什么都没说出来，但这一次「想起要说点什么」已经花过一回了。
  assert.equal(await quiet(), true, "第二次闲场仍然如实入库");
  await prepare(f);
  assert.equal((await admin`SELECT 1 FROM companion_turn_runs WHERE user_id=${f.userId}`).length, 1,
    "间隔内不再起第二轮；只按发言计的话，用户会感到她隔一会儿就想起一次，哪怕一句也没说");
  // 招呼是用户先要过的，不受这条节奏管。
  await observe(f); await prepare(f);
  assert.equal((await admin`SELECT 1 FROM companion_turn_runs WHERE user_id=${f.userId} AND input_source->>'topic'='app.started'`).length, 1);
});
