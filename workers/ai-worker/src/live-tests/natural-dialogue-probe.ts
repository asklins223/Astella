import { createInterface } from "node:readline";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { outputDir } from "./acceptance-common.ts";
import { RESEARCH_BASELINE_POLICY, RESEARCH_REJECTED_POLICY, RESEARCH_PAIRED_EXAMPLES } from "./research-dialogue-policies.ts";
import { conversationInstant } from "../handlers/companion-conversation-evidence.ts";
import { observedProvider, platform, save, safeFailure, type WireReceipt } from "./acceptance-common.ts";
import { fixture, readContext, closeFixtureDatabase } from "./runtime-fixture.ts";
import { runCompanionAgentLoop } from "../handlers/companion-agent-runtime.ts";
import { createGovernedProvider } from "../lib/governance.ts";
import { createCompanionContextReceipts } from "../handlers/companion-context-receipts.ts";
import { buildCompanionPersonaMessages, finalizeCompanionReplyText, validateCompanionOutput } from "../handlers/companion-dialogue-content.ts";
import { createCompanionStreamDelivery, reconcileStreamedText } from "../handlers/companion-dialogue-stream.ts";
import { resolveCompanionPersonaContext } from "../handlers/companion-identity-context.ts";
import { reserveCompanionProviderCall } from "../handlers/companion-agent-events.ts";
import { withWorkerWorkspaceTransaction } from "../db.ts";
import { sql } from "drizzle-orm";
import { readCompanionHistoryRows, companionHistoryText } from "../handlers/companion-dialogue-store.ts";
import { loadHereAndNow, renderHereAndNow } from "../handlers/companion-here-and-now.ts";
import { REPLAY_WINDOW_MESSAGES } from "../handlers/companion-context-handoff.ts";
import { COMPANION_VOICE_EXPRESSION_PROTOCOL_V1, readVoiceExpressionTags } from "@astella/shared/voice-expression-tags";
import { snapshotDialogueWireBody } from "./dialogue-experiment.ts";
import { assertProductionProbeConfiguration } from "./production-preflight.ts";

assertProductionProbeConfiguration(process.env);

// Interactive user turns, chosen after reading the actual last reply. No model
// simulates the user, supplies a target answer or asks for a constrained style.
const suffix=process.env.LIVE_NATURAL_SUFFIX??"session";
if(!/^[a-z0-9-]{1,40}$/.test(suffix))throw new Error("Invalid natural dialogue suffix");
const modelOverride = process.env.LIVE_MODEL_ID;
const route=platform("agent_turn",modelOverride),petProfile=resolveCompanionPersonaContext(null);
const effort = process.env.LIVE_CASUAL_EFFORT;
if (effort && (effort !== "low" || route.type !== "opencode_go"
  || !route.modelProfile?.reasoning?.levels.includes("low"))) throw new Error("Unsupported test effort");
const wire:WireReceipt[]=[], results:Array<Record<string,unknown>>=[];
const baseline = process.env.LIVE_RESEARCH_BASELINE === "1";
const candidate = process.env.LIVE_RESEARCH_CANDIDATE === "1";
const pairedExamples = process.env.LIVE_PAIRED_EXAMPLES === "1";
const noVoiceExamples = process.env.LIVE_NO_VOICE_EXAMPLES === "1";
if ([baseline,candidate,pairedExamples,noVoiceExamples,Boolean(effort),Boolean(modelOverride)].filter(Boolean).length > 1)
  throw new Error("Change one experiment variable at a time");
const mapInstructions = baseline || candidate || noVoiceExamples || pairedExamples ? (text:string) => {
  if(pairedExamples) return text.includes(RESEARCH_BASELINE_POLICY) ? text + "\n" + RESEARCH_PAIRED_EXAMPLES : text;
  if(noVoiceExamples) return text.replace(COMPANION_VOICE_EXPRESSION_PROTOCOL_V1,
    COMPANION_VOICE_EXPRESSION_PROTOCOL_V1.split("\n").filter(line=>!line.startsWith("格式示例")).join("\n"));
  if (candidate) return text.replace(RESEARCH_BASELINE_POLICY, RESEARCH_REJECTED_POLICY)
    .replace("有具体理由时才提问题或建议，", "问题来自具体好奇，建议围绕用户正在求助的问题。");
  return text.replace("表达风格示例（没有附对应用户问题，不代表当前对话目的、已经发生的经历或已接受的建议）：", "示例回复：");
} : undefined;
const seedName = process.env.LIVE_NATURAL_SEED;
if (seedName && !/^research-[a-z0-9-]+\.json$/.test(seedName)) throw new Error("Invalid synthetic seed name");
const seedHistory: Array<{role:"user"|"assistant";text:string;createdAt:string}> = seedName
  ? JSON.parse(readFileSync(`${outputDir}/${seedName}`, "utf8")) : [];
if (!Array.isArray(seedHistory) || seedHistory.length > 18 || seedHistory.some(m =>
  !m || !["user", "assistant"].includes(m.role) || typeof m.text !== "string" || !conversationInstant(m.createdAt)))
  throw new Error("Invalid synthetic seed records");
const initialSeq = seedHistory.length + 1;
const f=await fixture();
if (seedHistory.length) await f.mutate(async tx => {
  await tx`UPDATE companion_messages SET seq=${initialSeq} WHERE id=${f.messageId}`;
  await tx`UPDATE companion_conversations SET next_message_seq=${initialSeq+1} WHERE id=${f.conversationId}`;
  for (let i=0; i<seedHistory.length; i++) {
    const m=seedHistory[i]!;
    await tx`INSERT INTO companion_messages(id,conversation_id,workspace_id,user_id,role,seq,kind,blocks,content_sha256,created_at)
      VALUES(${randomUUID()},${f.conversationId},${f.event.ctx.workspaceId},${f.event.read.userId},${m.role},${i+1},'text',
        ${tx.json([{type:"text",text:m.text}])},${createHash("sha256").update(m.text).digest("hex")},${m.createdAt})`;
  }
});
const persist=()=>save(`natural-dialogue-${suffix}`,{route:route.model,conversationId:f.conversationId,
  experiment:baseline ? "baseline style, no timeline; test-only instruction mapping" : candidate ? "rejected style candidate, test-only mapping" : "production default at session start",
  seedHistory,
  casualEffortExperiment: effort ?? null,
  noVoiceExamplesExperiment: noVoiceExamples,
  pairedExamplesExperiment: pairedExamples,
  modelOverrideExperiment: modelOverride ?? null,
  productionReviewChain: "removed; diagnostic probes only",
  note:"Synthetic user, persistent test workspace and conversation; production history read/clock/loop/governance/delivery. Interactive follow-ups selected after reading the actual reply; no extra user-simulation model or answer references. ReadContext fixture bypasses full HTTP/turn-service. ok means delivery only.",results});
console.log(JSON.stringify({ready:true,conversationId:f.conversationId}));
const input=createInterface({input:process.stdin,crlfDelay:Infinity});

try {
  for await(const line of input) {
    if(line.trim()==="/quit")break;
    if(!line.trim())continue;
    const text=line; const index=results.length;
    const entry:Record<string,unknown>={turn:index+1,user:text};results.push(entry);
    const started=Date.now(),before=wire.length;
    let event=f.event,messageId=f.messageId,seq=initialSeq;
    try {
      if(index===0) {
        await f.mutate(tx=>tx`UPDATE companion_messages SET created_at=now(), blocks=${tx.json([{type:"text",text}])},
          content_sha256=${createHash("sha256").update(text).digest("hex")} WHERE id=${messageId}`);
      } else {
        const runId=randomUUID(),jobId=randomUUID();messageId=randomUUID();seq=index*2+initialSeq;
        await f.mutate(async tx=>{
          await tx`INSERT INTO companion_messages(id,conversation_id,workspace_id,user_id,role,seq,kind,blocks,content_sha256)
            VALUES(${messageId},${f.conversationId},${f.event.ctx.workspaceId},${f.event.read.userId},'user',${seq},'text',
              ${tx.json([{type:"text",text}])},${createHash("sha256").update(text).digest("hex")})`;
          await tx`INSERT INTO jobs(id,type,workspace_id,requested_by,payload,status,lease_token,started_at)
            VALUES(${jobId},'companion_agent',${f.event.ctx.workspaceId},${f.event.read.userId},${tx.json({runId})},'running','budget-lease',now())`;
          await tx`INSERT INTO companion_turn_runs(id,conversation_id,workspace_id,user_id,user_message_id,generation,status,
            idempotency_key_hash,request_body_hash,account_epoch,job_id)
            VALUES(${runId},${f.conversationId},${f.event.ctx.workspaceId},${f.event.read.userId},${messageId},${index+1},'running',
              ${createHash("sha256").update(runId).digest("hex")},${createHash("sha256").update(text).digest("hex")},0,${jobId})`;
        });
        event={ctx:{...f.event.ctx,id:jobId,payload:{runId},signal:new AbortController().signal},read:{...f.event.read,runId,generation:index+1}};
      }
      const source = await withWorkerWorkspaceTransaction({workspaceId:event.ctx.workspaceId, userId:event.read.userId}, async tx => {
        const rows = await readCompanionHistoryRows(tx, f.conversationId, {beforeSeq:String(seq), limit:REPLAY_WINDOW_MESSAGES});
        const snapshot = await loadHereAndNow(tx, {workspaceId:event.ctx.workspaceId,userId:event.read.userId,
          conversationId:f.conversationId,userText:text});
        const current = await tx.execute<{created_at:string}>(sql`SELECT to_char(created_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at FROM companion_messages WHERE id=${messageId}`);
        return {history:rows.reverse().map(m=>({role:m.role as "user"|"assistant",text:companionHistoryText(m),seq:m.seq,
          ...(!baseline ? {createdAt:m.created_at} : {})})), hereAndNow:renderHereAndNow(snapshot),
          conversationClock:!baseline && snapshot.observedAt && snapshot.timezone ? {
            observedAt:snapshot.observedAt,timezone:snapshot.timezone,currentMessageCreatedAt:current[0]?.created_at??null,
          } : undefined};
      });
      const read={...readContext(f),...event.read,userMessageId:messageId,nextMessageSeq:seq+1,
        userText:text,recentMessages:source.history,hereAndNow:source.hereAndNow,conversationClock:source.conversationClock,petProfile};
      entry.sourceTimes=source.conversationClock;
      const contextReceipts=createCompanionContextReceipts();
      const instructions:string[]=[];
      entry.instructions=instructions; // All input material belongs to this synthetic fixture.
      const requestSnapshots:Array<ReturnType<typeof snapshotDialogueWireBody>|{captureStatus:"omitted";reason:"reasoning_replay"|"unsupported_body"}>=[];
      entry.requestSnapshots=requestSnapshots;
      const raw=observedProvider(route,`natural-${f.conversationId}`,wire,s=>instructions.push(s),mapInstructions,
        effort === "low" ? {casualEffort:"low"} : undefined,body=>{
          // A later tool turn may contain private opaque replay handles. Keep
          // their omission explicit; never persist them or alter the real call.
          try { requestSnapshots.push(snapshotDialogueWireBody(body)); }
          catch(error) { requestSnapshots.push({captureStatus:"omitted",reason:
            error instanceof Error && /reasoning/.test(error.message) ? "reasoning_replay" : "unsupported_body"}); }
        });
      // Only final structured review output on this synthetic fixture is kept;
      // never capture private generated reasoning or add an evaluation call.
      if (raw.executeAgentTurn) {
        const execute=raw.executeAgentTurn.bind(raw);
        const reviewPlans:string[]=[];
        entry.dialogueReviewPlans=reviewPlans;
        raw.executeAgentTurn=async(request,signal)=>{
          const response=await execute(request,signal);
          if(request.systemPrompt.includes("内部结构化核对任务"))reviewPlans.push(response.content??"");
          return response;
        };
      }
      const provider=createGovernedProvider(raw,{consentOk:true,policy:{sendToExternal:true,sendImageContent:false,
        piiDetection:false,auditLogging:false}},event.ctx.workspaceId,
        {userId:read.userId,operation:"companion_agent",reserveCall:()=>reserveCompanionProviderCall({ctx:event.ctx,read})},contextReceipts.pressureGate);
      const expiresAt=new Date(Date.now()+120000).toISOString();
      const delivery=createCompanionStreamDelivery({job:event.ctx,ctx:event.ctx,read,expiresAt,
        factSpanValues:{},notifyCompanionEvent:async()=>{}});
      const baseMessages=buildCompanionPersonaMessages({userText:text,recentMessages:read.recentMessages,pageContext:null,petProfile,
        hereAndNow:read.hereAndNow,conversationClock:read.conversationClock,
        scope:{workspaceId:event.ctx.workspaceId,userId:read.userId},contextReceipt:rs=>contextReceipts.recordAssembly(rs)});
      entry.systemHash=createHash("sha256").update(String(baseMessages[0]!.content)).digest("hex");
      const result=await runCompanionAgentLoop({ctx:event.ctx,read,provider,contextReceipts,toolConstraints:{visionEnabled:false},
        baseMessages,expiresAt,onProviderDelta:delta=>delivery.onRawDelta(delta)});
      if(result.status!=="completed")throw new Error("natural conversation unexpectedly requested action confirmation");
      entry.voiceControls=readVoiceExpressionTags(result.text).map(({tag,kind})=>({tag,kind}));
      const finalized=finalizeCompanionReplyText({text:result.text,runId:read.runId}).text;
      const streamed=await delivery.finish();
      if(!streamed.ok)throw new Error("stream rejected");
      const reconciled=reconcileStreamedText({delivered:streamed.text,validated:validateCompanionOutput(finalized)});
      if(!reconciled.ok)throw new Error("full text rejected");
      const answer=reconciled.text;
      entry.answer=answer;
      if(!await delivery.writeTail(answer))throw new Error("tail rejected");
      const finished=await delivery.finish();
      if(!finished.ok||delivery.deliveredText()!==answer)throw new Error("delivery diverged");
      await f.mutate(async tx=>{
        await tx`INSERT INTO companion_messages(id,conversation_id,workspace_id,user_id,role,seq,kind,blocks,content_sha256)
          VALUES(${randomUUID()},${f.conversationId},${event.ctx.workspaceId},${read.userId},'assistant',${seq+1},'text',
            ${tx.json([{type:"text",text:answer}])},${createHash("sha256").update(answer).digest("hex")})`;
        await tx`UPDATE companion_turn_runs SET status='succeeded',finished_at=now() WHERE id=${read.runId}`;
        await tx`UPDATE jobs SET status='succeeded',finished_at=now() WHERE id=${event.ctx.id}`;
        await tx`UPDATE companion_conversations SET next_message_seq=${seq+2} WHERE id=${f.conversationId}`;
      });
      const [run]=await f.mutate(tx=>tx`SELECT turn_interpretation,model_call_count,tool_call_count,context_pressure
        FROM companion_turn_runs WHERE id=${read.runId}`);
      Object.assign(entry,{ok:true,answer,deliveredText:delivery.deliveredText(),...run});
    } catch(error) {
      Object.assign(entry,{ok:false,error:safeFailure(error)});
      if(error&&typeof error==="object"&&"code" in error) {
        entry.errorCode=String(error.code);
        if("constraint_name" in error)entry.constraint=String(error.constraint_name);
      }
      await f.mutate(async tx=>{
        await tx`UPDATE companion_turn_runs SET status='failed',finished_at=now() WHERE id=${event.read.runId}`;
        await tx`UPDATE jobs SET status='dead',finished_at=now() WHERE id=${event.ctx.id}`;
      });
    }
    Object.assign(entry,{elapsedMs:Date.now()-started,requestCount:wire.length-before,wire:wire.slice(before)});persist();
    console.log(JSON.stringify({turn:entry.turn,ok:entry.ok,answer:entry.answer,error:entry.error,elapsedMs:entry.elapsedMs}));
  }
} finally {input.close();process.stdin.pause();persist();await f.cleanup();await closeFixtureDatabase();}
