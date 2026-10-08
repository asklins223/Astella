import { observedProvider, platform, save, safeFailure, type WireReceipt } from "./acceptance-common.ts";
import { fixture, readContext, closeFixtureDatabase } from "./runtime-fixture.ts";
import { runCompanionAgentLoop } from "../handlers/companion-agent-runtime.ts";
import { createGovernedProvider } from "../lib/governance.ts";
import { createCompanionContextReceipts } from "../handlers/companion-context-receipts.ts";
import { buildCompanionPersonaMessages, finalizeCompanionReplyText, validateCompanionOutput } from "../handlers/companion-dialogue-content.ts";
import { resolveCompanionPersonaContext } from "../handlers/companion-identity-context.ts";
import { createCompanionStreamDelivery, reconcileStreamedText } from "../handlers/companion-dialogue-stream.ts";
import { assertProductionProbeConfiguration } from "./production-preflight.ts";

assertProductionProbeConfiguration(process.env);

const history:Array<{role:"user"|"assistant";text:string}>=[];
const route=platform("agent_turn"), wire:WireReceipt[]=[], results:Array<Record<string,unknown>>=[];
const petProfile=resolveCompanionPersonaContext(null);
const suffix=process.env.LIVE_RUNTIME_SUFFIX??"";
if(suffix&&!/^[a-z0-9-]{1,40}$/.test(suffix))throw new Error("Invalid runtime output suffix");
const outputName=suffix?`runtime-${suffix}`:"runtime";
const cases=process.env.LIVE_RUNTIME_EMPTY_SELF==="1"?["你今天看到什么有趣的事情了？"]:
  process.env.LIVE_RUNTIME_KNOWLEDGE_ONLY==="1"?["讲讲为什么热咖啡会慢慢变凉，尤其是杯内液体怎么流动。"]:
  ["嗨，今天不想学习。","就想歇会儿。","嗯。",
  "那你喜欢什么样的午饭？","换个话题，讲讲为什么热咖啡会慢慢变凉。",
  "你今天看到什么有趣的事情了？"];
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
      const finalized=finalizeCompanionReplyText({text:reply.text,runId:read.runId}).text;
      const streamed=await delivery.finish();
      if(!streamed.ok)throw new Error("stream delivery rejected");
      const reconciled=reconcileStreamedText({delivered:streamed.text,validated:validateCompanionOutput(finalized)});
      if(!reconciled.ok)throw new Error(`full text reconciliation rejected: ${reconciled.reason}`);
      const answer=reconciled.text;
      const tail=await delivery.writeTail(answer);
      const finished=await delivery.finish();
      entry.ok=tail&&finished.ok&&delivery.deliveredText()===answer;
      entry.answer=answer;entry.deliveredText=delivery.deliveredText();
      const [run]=await f.mutate(tx=>tx`SELECT step_count,tool_call_count,turn_interpretation,context_pressure FROM companion_turn_runs WHERE id=${read.runId}`);
      Object.assign(entry,{stepCount:run.step_count,toolCallCount:run.tool_call_count,intent:run.turn_interpretation,
        pressure:run.context_pressure,wire:wire.slice(before)});
      history.push({role:"user",text},{role:"assistant",text:answer});
    } catch(error) {entry.ok=false;entry.error=safeFailure(error);entry.wire=wire.slice(before);}
    finally {await f.cleanup();}
    entry.elapsedMs=Date.now()-started;save(outputName,{route:route.model,results});console.log(JSON.stringify(entry));
  }
} finally {await closeFixtureDatabase();}
