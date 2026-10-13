import assert from "node:assert/strict";
import { platform, observedProvider, root, safeFailure, type WireReceipt } from "./acceptance-common.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { registerFactory } from "../lib/provider-factory.ts";
import type { CapabilityImpl } from "@astella/shared";
import { fixture, readContext, closeFixtureDatabase } from "./runtime-fixture.ts";
import { readParticipationPreferences, listCompanionAttention, recordCompanionAwareness } from "@astella/agent-host";
import { randomUUID } from "node:crypto";
import { runCompanionInitiative } from "../handlers/companion-initiative.ts";
import { runCompanionDialogue } from "../handlers/companion-dialogue.ts";
import { withWorkerWorkspaceTransaction } from "../db.ts";
import { buildCompanionPersonaMessages } from "../handlers/companion-dialogue-content.ts";
import { runCompanionAgentLoop } from "../handlers/companion-agent-runtime.ts";
import { createGovernedProvider } from "../lib/governance.ts";
import { createCompanionContextReceipts } from "../handlers/companion-context-receipts.ts";
import { reserveCompanionProviderCall } from "../handlers/companion-agent-events.ts";
import { canonicalJsonV1, sha256Utf8V1 } from "@astella/shared/content-hash";

if (!new URL(process.env.DATABASE_URL_MIGRATOR!).pathname.startsWith("/astella_initiative_"))
  throw new Error("Use an isolated astella_initiative_* database");
const route = platform("agent_turn"), wire: WireReceipt[] = [], results: Array<Record<string, unknown>> = [];
const liveEvidence: Array<Record<string, unknown>> = [];
// Observe the actual production provider factory; keep its resolved runtime configuration.
registerFactory(route.type, "agent_turn", config => observedProvider({ ...route,
  apiKey: config.apiKey ?? route.apiKey, baseUrl: config.baseUrl ?? route.baseUrl, model: config.model ?? route.model,
  modelProfile: config.modelProfile ?? route.modelProfile, options: config.options ?? route.options },
  `initiative-production-${randomUUID()}`, wire) as unknown as CapabilityImpl);
const outputDir = `${root}outputs/audits/2026-10-13-initiative`;
mkdirSync(outputDir, { recursive: true });
function failureKind(error: unknown): string {
  const cause = error as { message?: string; cause?: { message?: string } };
  const message = `${cause?.message ?? ""} ${cause?.cause?.message ?? ""}`;
  if (/TCP\/TLS connection|connect.*timed? ?out/i.test(message)) return "connection_timeout";
  if (/timeout|timed? ?out|aborted/i.test(message)) return "transport_timeout";
  if (/DNS|hostname|ENOTFOUND|EAI_AGAIN/i.test(message)) return "dns";
  if (/permission denied|row-level security/i.test(message)) return "database_permission";
  if (/response failed/i.test(message)) return "provider_response_failed";
  return "other";
}
process.env.COMPANION_DIALOGUE_V1_ENABLED="true";
process.env.COMPANION_VOICE_DIALOGUE_V1_ENABLED="false";
async function actualInitiative(f: Awaited<ReturnType<typeof fixture>>, studyMinutes: number | null) {
  const learning = studyMinutes !== null;
  const scope={workspaceId:f.event.ctx.workspaceId,userId:f.event.read.userId}, launchId=randomUUID(),deviceSessionId=`live-probe:${launchId}`;
  const savedPreferences = await withWorkerWorkspaceTransaction(scope,tx=>readParticipationPreferences(tx,scope));
  await f.mutate(async tx=>{
    await tx`INSERT INTO user_ai_settings(user_id,consent_version,consent_at,data_policy) VALUES(${scope.userId},'live-test-v1',now(),
      ${tx.json({sendToExternal:true,sendImageContent:false,piiDetection:true,auditLogging:true})})
      ON CONFLICT(user_id) DO UPDATE SET consent_version=EXCLUDED.consent_version,consent_at=EXCLUDED.consent_at,data_policy=EXCLUDED.data_policy`;
    await tx`UPDATE companion_turn_runs SET status='succeeded',finished_at=now() WHERE id=${f.event.read.runId}`;
    await tx`UPDATE companion_conversations SET next_generation=greatest(next_generation,2) WHERE id=${f.conversationId}`;
    if(studyMinutes && studyMinutes > 0) await tx`INSERT INTO companion_study_spans(id,workspace_id,user_id,device_session_id,started_at,ended_at)
      SELECT gen_random_uuid(),${scope.workspaceId},${scope.userId},${deviceSessionId},now()-i*interval '45 seconds',now()-(i-1)*interval '45 seconds'
      FROM generate_series(1,${Math.round(studyMinutes * 60 / 45)}::integer) i`;
  });
  const observe=(topic:"app.started"|"context.updated",elapsedMs=0)=>withWorkerWorkspaceTransaction(scope,tx=>recordCompanionAwareness(tx,scope,
    {version:1,id:randomUUID(),appLaunchId:launchId,deviceSessionId,host:"desktop",topic,occurredAt:new Date().toISOString(),elapsedMs,
      context:{foreground:true,unlocked:true,typing:false,learning,conversationId:f.conversationId,
        page:{key:learning?"note-learning:probe":"home",label:learning?"学习页":"书房",revision:null,context:null}}}));
  await observe(learning?"context.updated":"app.started");
  const jobRows=await f.mutate(tx=>tx`UPDATE jobs SET status='running',started_at=now(),lease_token='budget-lease'
    WHERE id=(SELECT id FROM jobs WHERE requested_by=${scope.userId} AND type='companion_initiative' AND status='pending' ORDER BY scheduled_at LIMIT 1)
    RETURNING id,payload`);
  const job=jobRows[0];assert.ok(job);
  await runCompanionInitiative({...f.event.ctx,id:job.id,payload:job.payload});
  const runs=await f.mutate(tx=>tx`SELECT id,job_id,user_message_id FROM companion_turn_runs WHERE user_id=${scope.userId} AND input_source IS NOT NULL ORDER BY generation DESC LIMIT 1`);
  const run=runs[0];assert.ok(run);assert.equal(run.user_message_id,null);
  await f.mutate(tx=>tx`UPDATE jobs SET status='running',started_at=now(),lease_token='budget-lease' WHERE id=${run.job_id}`);
  let pending=Promise.resolve();const timer=setInterval(()=>{pending=pending.then(async()=>{await observe("context.updated",15_000);});},15_000);
  try{await runCompanionDialogue({...f.event.ctx,id:run.job_id,payload:{runId:run.id}});}
  finally{clearInterval(timer);await pending;}
  const finalRows=await f.mutate(tx=>tx`SELECT status,model_call_count FROM companion_turn_runs WHERE id=${run.id}`);
  const messages=await f.mutate(tx=>tx`SELECT blocks FROM companion_messages WHERE run_id=${run.id} AND role='assistant' ORDER BY seq`);
  const text=messages.flatMap(m=>m.blocks.filter((b:{type:string})=>b.type==='text').map((b:{text:string})=>b.text)).join("\n\n");
  liveEvidence.push({ studyMinutes, savedPreferenceRevision: savedPreferences.revision, status: finalRows[0]!.status, modelCalls: finalRows[0]!.model_call_count, text });
  assert.equal(finalRows[0]!.status,"succeeded");
  assert.doesNotMatch(text,/本轮.{0,8}(?:更多内容|结束|不发言)|提醒已发|安静结束|静默结束/);
  let nextReviewAt: string | null = null;
  if (studyMinutes === 0) {
    assert.equal(messages.length, 0, "A just-started learning session must not publish a premature rest reminder or a quiet execution note");
    const plans = await withWorkerWorkspaceTransaction(scope, tx => listCompanionAttention(tx, scope));
    const review = plans.find(plan => plan.topics.includes("study.started") && plan.nextReviewAt);
    assert.ok(review?.nextReviewAt, "A foreground learning start needs an actual later review, not just saved prose");
    nextReviewAt = review.nextReviewAt;
    assert.ok(new Date(nextReviewAt).getTime() > Date.now());
    assert.ok(new Date(nextReviewAt).getTime() < Date.now() + 60 * 60_000);
  } else {
    assert.ok(text.trim());
    if(learning) assert.match(text,/休息|起[身来]|走|活动/);
  }
  assert.equal((await f.mutate(tx=>tx`SELECT count(*)::integer AS n FROM companion_messages WHERE conversation_id=${f.conversationId} AND role='user'`))[0]!.n,1);
  return {kind:learning ? `foreground-study-${studyMinutes}-minutes` : "actual-app-started",text,
    modelCalls:finalRows[0]!.model_call_count,messageCount:messages.length,nextReviewAt};
}
const cases = [
  { id:"startup-and-qualitative-study",text:"以后每次启动应用都跟我问好。我学久了也提醒我起来走走，不用让我先定分钟数。",expected:[/启动|打开/,/久|休息|走走/] },
  { id:"unseen-page-and-continuation",text:"以后我重新打开同一篇笔记时，先帮我接上上次留下的问题。答完我的问题之后，如果发现漏了一个关键条件，可以再补一句，不要重复刚说过的话。",expected:[/笔记/,/问题/,/补|遗漏|漏|条件/] },
  { id:"explicit-time",text:"以后连续学习五十分钟就提醒我起身休息，只有应用在前台的学习时间才算。",expected:[/50|五十/,/前台/] },
];
const selectedCases = cases.filter(sample => !process.env.INITIATIVE_PROBE_CASE || sample.id === process.env.INITIATIVE_PROBE_CASE);
const includeBuiltInCase = !process.env.INITIATIVE_PROBE_CASE || process.env.INITIATIVE_PROBE_CASE === "built-in-defaults-without-preference";
assert.ok(selectedCases.length || includeBuiltInCase, "INITIATIVE_PROBE_CASE must select an existing case");
try {
  for (const sample of selectedCases) {
    const f = await fixture(), scope = { workspaceId:f.event.ctx.workspaceId,userId:f.event.read.userId };
    let checked: Record<string,unknown>={};
    try {
      const blocks = [{type:"text",text:sample.text}];
      await f.mutate(async tx => {
        await tx`SET LOCAL app.allow_history_mutation='on'`;
        await tx`UPDATE companion_messages SET blocks=${tx.json(blocks)},content_sha256=${sha256Utf8V1(canonicalJsonV1(blocks))} WHERE id=${f.messageId}`;
      });
      const read = { ...readContext(f),userText:sample.text }, receipts = createCompanionContextReceipts();
      const provider = createGovernedProvider(observedProvider(route,`initiative-probe-${sample.id}`,wire),{
        consentOk:true,policy:{sendToExternal:true,sendImageContent:false,piiDetection:false,auditLogging:false}},scope.workspaceId,
        {userId:scope.userId,operation:"companion_agent",reserveCall:()=>reserveCompanionProviderCall({ctx:f.event.ctx,read})},receipts.pressureGate);
      const reply = await runCompanionAgentLoop({ctx:f.event.ctx,read,provider,contextReceipts:receipts,toolConstraints:{visionEnabled:false},
        baseMessages:buildCompanionPersonaMessages({userText:sample.text,recentMessages:[],pageContext:null,petProfile:null,scope,
          participationPreferences:await withWorkerWorkspaceTransaction(scope,tx=>readParticipationPreferences(tx,scope))}),
        expiresAt:new Date(Date.now()+10*60_000).toISOString()});
      const saved = await withWorkerWorkspaceTransaction(scope,tx=>readParticipationPreferences(tx,scope));
      const attention = await withWorkerWorkspaceTransaction(scope,tx=>listCompanionAttention(tx,scope));
      checked={preferences:saved.markdown,attention:attention.map(p=>({intent:p.intent,topics:p.topics,nextReviewAt:p.nextReviewAt})),visibleReply:reply.status==="completed"?reply.text:null};
      assert.equal(saved.source?.kind,"user_message"); assert.equal(saved.source?.messageId,f.messageId);
      assert.ok(sample.text.includes(saved.source?.quote ?? "")); assert.ok(saved.revision>0);
      for (const pattern of sample.expected) assert.match(saved.markdown,pattern);
      assert.ok(attention.length>0,"A lasting request must have an actual observation or review arrangement");
      if(sample.id==="unseen-page-and-continuation") {
        assert.ok(attention.some(p=>p.topics.includes("page.arrived")),"Reopening a note must have an actual page observation");
      }
      if(sample.id!=="unseen-page-and-continuation")assert.ok(attention.some(p=>p.topics.includes("study.started")),"Learning starts from observed foreground activity");
      for(const p of attention)if(p.topics.includes("study.started") && p.nextReviewAt)assert.ok(new Date(p.nextReviewAt).getTime()<Date.now()+60*60_000,"A study review should not silently drift into the next day");
      const live=sample.id==="startup-and-qualitative-study"
        ? { ...await actualInitiative(f,null), studyStart: await actualInitiative(f,0) }
        : sample.id==="explicit-time"?await actualInitiative(f,51):null;
      results.push({id:sample.id,passed:true,preferences:saved.markdown,attention:attention.map(p=>({intent:p.intent,topics:p.topics,nextReviewAt:p.nextReviewAt})),
        visibleReply:reply.status === "completed" ? reply.text : null,live});
      console.log(JSON.stringify({case:sample.id,passed:true,attentionCount:attention.length}));
    } catch(error) { const db=error as {code?:string;constraint_name?:string;table_name?:string;cause?:{code?:string;constraint_name?:string;table_name?:string}};
      const code=db.cause?.code??db.code, constraint=db.cause?.constraint_name??db.constraint_name, table=db.cause?.table_name??db.table_name;
      const diagnostic={...safeFailure(error),kind:failureKind(error),...(code&&/^[A-Z0-9]{5}$/.test(code)?{code}:{}),...(constraint&&/^[a-z_0-9]+$/.test(constraint)?{constraint}:{}),...(table&&/^[a-z_0-9]+$/.test(table)?{table}:{})};
      results.push({id:sample.id,passed:false,error:diagnostic,...checked}); console.log(JSON.stringify({case:sample.id,passed:false,error:diagnostic})); }
    finally { await f.cleanup(); }
  }
  if (includeBuiltInCase) {
    const f = await fixture();
    try {
      const scope={workspaceId:f.event.ctx.workspaceId,userId:f.event.read.userId};
      const empty = await withWorkerWorkspaceTransaction(scope,tx=>readParticipationPreferences(tx,scope));
      assert.equal(empty.revision,0); assert.equal(empty.markdown,"");
      const live = await actualInitiative(f,null);
      assert.match(live.text,/来|欢迎|你好|嗨/,"Built-in startup behaviour should greet a new account without saved personal preferences");
      assert.doesNotMatch(live.text,/饭点|容易走神|你(?:一直|已经)在(?:学习|工作|休息)/,"Startup greeting must not invent an activity or routine for the user");
      results.push({id:"built-in-defaults-without-preference",passed:true,preferences:"",live});
      console.log(JSON.stringify({case:"built-in-defaults-without-preference",passed:true}));
    } catch(error) {
      const diagnostic={...safeFailure(error),kind:failureKind(error)};
      results.push({id:"built-in-defaults-without-preference",passed:false,error:diagnostic});
      console.log(JSON.stringify({case:"built-in-defaults-without-preference",passed:false,error:diagnostic}));
    } finally { await f.cleanup(); }
  }
} finally {
  const at = new Date().toISOString(), report = JSON.stringify({ at, results, liveEvidence, wire }, null, 2);
  writeFileSync(`${outputDir}/companion-initiative-semantic-probe.json`, report);
  writeFileSync(`${outputDir}/attempt-${at.replace(/[:.]/g, "-")}.json`, report);
  await closeFixtureDatabase();
}
if (results.some(result=>!result.passed)) process.exitCode=1;
