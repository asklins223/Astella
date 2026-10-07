import { observedProvider, platform, save, safeFailure, type WireReceipt } from "./acceptance-common.ts";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { closeDatabase } from "../db.ts";
import { runCompanionAgentLoop } from "../handlers/companion-agent-runtime.ts";
import type { ReadContext } from "../handlers/companion-dialogue-store.ts";
import { createGovernedProvider } from "../lib/governance.ts";
import { createCompanionContextReceipts } from "../handlers/companion-context-receipts.ts";
import { buildCompanionPersonaMessages, finalizeCompanionReplyText, validateCompanionOutput } from "../handlers/companion-dialogue-content.ts";
import { resolveCompanionPersonaContext } from "../handlers/companion-identity-context.ts";
import { createCompanionStreamDelivery, reconcileStreamedText } from "../handlers/companion-dialogue-stream.ts";
const url=testDatabaseUrl("DATABASE_URL_MIGRATOR");
if(new URL(url).pathname!=="/astella_companion_live_20261007")throw new Error("Use the designated disposable live acceptance database");
const admin=postgres(url,{max:2});
async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), runId = randomUUID();
  const conversationId = randomUUID(), messageId = randomUUID(), jobId = randomUUID();
  const mutate = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) => admin.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id',${workspaceId},true),set_config('app.user_id',${userId},true)`;
    return fn(tx);
  });
  await mutate(async tx => {
    await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${userId},${`budget-${userId}@test.invalid`},'h','owner')`;
    await tx`INSERT INTO workspaces(id,name,owner_id) VALUES(${workspaceId},'预算回归',${userId})`;
    await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
    await tx`INSERT INTO user_companion_account_state(user_id,epoch,global_enabled) VALUES(${userId},0,true)`;
    await tx`INSERT INTO companion_conversations(id,workspace_id,user_id,kind,title,title_source,status)
      VALUES(${conversationId},${workspaceId},${userId},'dialogue','回归','auto','active')`;
    await tx`INSERT INTO companion_messages(id,conversation_id,workspace_id,user_id,role,seq,kind,blocks,content_sha256)
      VALUES(${messageId},${conversationId},${workspaceId},${userId},'user',1,'text','[]',${'0'.repeat(64)})`;
    await tx`INSERT INTO jobs(id,type,workspace_id,requested_by,payload,status,lease_token,started_at)
      VALUES(${jobId},'companion_agent',${workspaceId},${userId},${tx.json({runId})},'running','budget-lease',now())`;
    await tx`INSERT INTO companion_turn_runs(id,conversation_id,workspace_id,user_id,user_message_id,generation,status,
      idempotency_key_hash,request_body_hash,account_epoch,job_id)
      VALUES(${runId},${conversationId},${workspaceId},${userId},${messageId},1,'running',${'a'.repeat(64)},${'b'.repeat(64)},0,${jobId})`;
  });
  const event = { ctx: { id:jobId,workspaceId,requestedBy:userId,leaseToken:'budget-lease',payload:{runId},signal:new AbortController().signal },
    read: { userId,runId,accountEpoch:0,generation:1 } };
  return { event, mutate, conversationId, messageId, count: async () => Number((await mutate(tx => tx`SELECT model_call_count FROM companion_turn_runs WHERE id=${runId}`))[0].model_call_count),
    cleanup: () => mutate(async tx => {
      await tx`SET LOCAL app.allow_history_mutation = 'on'`;
      await tx`DELETE FROM companion_agent_tool_calls WHERE conversation_id=${conversationId}`;
      await tx`DELETE FROM companion_agent_steps WHERE conversation_id=${conversationId}`;
      await tx`DELETE FROM companion_stream_events WHERE conversation_id=${conversationId}`;
      await tx`DELETE FROM companion_action_proposals WHERE conversation_id=${conversationId}`;
      await tx`DELETE FROM agent_runs WHERE workspace_id=${workspaceId} AND user_id=${userId}`;
      await tx`DELETE FROM companion_turn_runs WHERE id=${runId}`;
      await tx`DELETE FROM companion_messages WHERE conversation_id=${conversationId}`;
      await tx`DELETE FROM companion_conversations WHERE id=${conversationId}`;
      await tx`DELETE FROM jobs WHERE workspace_id=${workspaceId}`;
      await tx`DELETE FROM assistant_memory_items WHERE workspace_id=${workspaceId}`;
      await tx`UPDATE notes SET current_version_id=null WHERE workspace_id=${workspaceId}`;
      await tx`DELETE FROM note_blocks WHERE workspace_id=${workspaceId}`;
      await tx`DELETE FROM note_versions WHERE workspace_id=${workspaceId}`;
      await tx`DELETE FROM notes WHERE workspace_id=${workspaceId}`;
      await tx`DELETE FROM user_companion_account_state WHERE user_id=${userId}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id=${workspaceId}`;
      await tx`DELETE FROM workspaces WHERE id=${workspaceId}`;
      await tx`DELETE FROM users WHERE id=${userId}`;
    }) };
}

function readContext(f: Awaited<ReturnType<typeof fixture>>): ReadContext {
  return { ...f.event.read, conversationId: f.conversationId, userMessageId: f.messageId,
    runStatus: "running", formalAnswerInProgress: false, formalAnswerTarget: null,
    livePageView: null, pageContext: null, groundedTutorContext: null, userText: "你好",
    recentMessages: [], residentMemories: [], memoryDirectory: [], playbookCatalog: [],
    organizationSurface: null, memoryRefs: [], hereAndNow: null, thisTurnFacts: null,
    factSpans: null, conversationSummary: null, personaProfileRevision: 0,
    personaExamplesRevision: 0, defaultExpressionVersion: "test", petProfile: null,
    nextMessageSeq: 2, nextEventSeq: 1 };
}

const history:Array<{role:"user"|"assistant";text:string}>=[];
const route=platform("agent_turn"), wire:WireReceipt[]=[], results:Array<Record<string,unknown>>=[];
const petProfile=resolveCompanionPersonaContext(null);
const cases=["嗨，今天不想学习。","就想歇会儿，不用问我问题。","嗯。",
  "那你喜欢什么样的午饭？不用反问我。","换个话题，讲讲为什么热咖啡会慢慢变凉，不用出题。",
  "你今天看到什么有趣的事情了？不用反问我。"];
try {
  for(const text of cases) {
    const f=await fixture();
    const entry:Record<string,unknown>={text};results.push(entry);
    const before=wire.length,started=Date.now();
    console.log(JSON.stringify({starting:"runtime",text}));
    try {
      await f.mutate(tx=>tx`UPDATE companion_messages SET blocks=${tx.json([{type:"text",text}])} WHERE id=${f.messageId}`);
      const read={...readContext(f),userText:text,recentMessages:[...history],petProfile};
      const contextReceipts=createCompanionContextReceipts();
      const raw=observedProvider(route,"runtime-live-conversation",wire);
      const provider=createGovernedProvider(raw,{consentOk:true,policy:{sendToExternal:true,sendImageContent:false,
        piiDetection:false,auditLogging:false}},f.event.ctx.workspaceId,
        {userId:f.event.read.userId,operation:"companion_agent"},contextReceipts.pressureGate);
      const delivery=createCompanionStreamDelivery({job:f.event.ctx,ctx:f.event.ctx,read,
        expiresAt:new Date(Date.now()+120000).toISOString(),factSpanValues:{},notifyCompanionEvent:async()=>{}});
      const baseMessages=buildCompanionPersonaMessages({userText:text,recentMessages:[...history],pageContext:null,
        petProfile,scope:{workspaceId:f.event.ctx.workspaceId,userId:f.event.read.userId},
        contextReceipt:rs=>contextReceipts.recordAssembly(rs)});
      const reply=await runCompanionAgentLoop({ctx:f.event.ctx,read,provider,contextReceipts,
        toolConstraints:{visionEnabled:false},baseMessages,expiresAt:new Date(Date.now()+120000).toISOString(),
        onProviderDelta:delta=>delivery.onRawDelta(delta)});
      if(reply.status!=="completed")throw new Error("unexpected confirmation");
      const answer=finalizeCompanionReplyText({text:reply.text,runId:read.runId}).text;
      const streamed=await delivery.finish();
      if(!streamed.ok)throw new Error("stream delivery rejected");
      const reconciled=reconcileStreamedText({delivered:streamed.text,validated:validateCompanionOutput(answer)});
      const tail=await delivery.writeTail(answer);
      const finished=await delivery.finish();
      entry.ok=reconciled.ok&&tail&&finished.ok;
      entry.answer=answer;entry.deliveredText=delivery.deliveredText();
      const [run]=await f.mutate(tx=>tx`SELECT step_count,tool_call_count,turn_interpretation,context_pressure FROM companion_turn_runs WHERE id=${read.runId}`);
      Object.assign(entry,{stepCount:run.step_count,toolCallCount:run.tool_call_count,intent:run.turn_interpretation,
        pressure:run.context_pressure,wire:wire.slice(before)});
      history.push({role:"user",text},{role:"assistant",text:answer});
    } catch(error) {entry.ok=false;entry.error=safeFailure(error);entry.wire=wire.slice(before);}
    finally {await f.cleanup();}
    entry.elapsedMs=Date.now()-started;save("runtime",{route:route.model,results});console.log(JSON.stringify(entry));
  }
} finally {await admin.end();await closeDatabase();}
