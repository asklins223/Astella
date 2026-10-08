import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AgentTurnRequest } from "@astella/shared";
import { observedProvider, platform, outputDir, save, safeFailure, type WireReceipt } from "./acceptance-common.ts";
import { hashDialogueValue, snapshotDialogueRequest, snapshotDialogueWireBody } from "./dialogue-experiment.ts";
import { finalizeCompanionReplyText, sanitizeCompanionVisibleText, validateCompanionOutput } from "../handlers/companion-dialogue-content.ts";

const suffix=process.env.LIVE_DEEPSEEK_MODE_SUFFIX;
if(!suffix||!/^[a-z0-9-]{1,40}$/.test(suffix))throw new Error("Unique diagnostic suffix required");
const name=`deepseek-mode-diagnostic-${suffix}`;
if(existsSync(`${outputDir}/${name}-manifest.json`)||existsSync(`${outputDir}/${name}.json`))throw new Error("No evidence overwrite");
const route=platform("agent_turn");
if(route.model!=="deepseek-v4.1-flash")throw new Error("Human fixed-model instruction");
if(!route.modelProfile?.reasoning?.levels.includes("low")||!route.modelProfile.reasoning.levels.includes("high"))
  throw new Error("Declared thinking modes required");
const source=JSON.parse(readFileSync(`${outputDir}/dialogue-layer-diagnostic-layers-1008-v1-manifest.json`,"utf8"));
const modes=["none-0.9","none-0.2","low","high"] as const;
type Mode=typeof modes[number];
const fixtures=source.fixtures.map((f:{id:string;requests:{bare:{request:AgentTurnRequest}}})=>({id:f.id,request:f.requests.bare.request}));
if(fixtures.length!==6)throw new Error("Exactly six existing diagnostic prefixes required");
const frozen={frozenAt:new Date().toISOString(),batchId:randomUUID(),model:route.model,profile:route.modelProfile,
  sourceManifestHash:hashDialogueValue(source),maxCalls:24,modes,fixtures:fixtures.map((f:{id:string;request:AgentTurnRequest})=>({id:f.id,snapshot:snapshotDialogueRequest(f.request)})),
  scope:"Same DeepSeek, Go Responses endpoint, exact original native messages and 32-character bare identity. Known diagnostic prefixes, not acceptance. None modes isolate temperature; low versus high isolates effort. None versus thinking bundles effort with the profile-required omission of temperature. No model/persona/production change. One sample per cell; no overall causal or naturalness success rate.",
};
writeFileSync(`${outputDir}/${name}-manifest.json`,JSON.stringify(frozen,null,2),{flag:"wx"});
type Row={id:string;mode:Mode;request:ReturnType<typeof snapshotDialogueRequest>;wireSnapshots:ReturnType<typeof snapshotDialogueWireBody>[];
  answer?:string;rawAnswer?:string;rawDelta?:string;finishReason?:string;validation?:ReturnType<typeof validateCompanionOutput>;
  completedMatchesDeltas?:boolean;error?:ReturnType<typeof safeFailure>;firstVisibleMs?:number|null;elapsedMs?:number};
const rows:Row[]=[],wire:WireReceipt[]=[];
const persist=()=>save(name,{manifestHash:hashDialogueValue(frozen),rows,wire});persist();
for(const [index,fixture] of fixtures.entries()){
  const order=[...modes.slice(index%4),...modes.slice(0,index%4)];
  for(const mode of order){
    const request:AgentTurnRequest={...structuredClone(fixture.request),disableThinking:mode.startsWith("none"),
      temperature:mode==="none-0.2"?0.2:0.9};
    const resolved=mode==="low"||mode==="high"?{...route,modelProfile:{...route.modelProfile!,
      reasoning:{...route.modelProfile!.reasoning!,default:mode}}}:route;
    const row:Row={id:fixture.id,mode,request:snapshotDialogueRequest(request),wireSnapshots:[]};rows.push(row);
    const provider=observedProvider(resolved,`${frozen.batchId}/${fixture.id}/${mode}`,wire,undefined,undefined,undefined,body=>{
      if(wire.length>=frozen.maxCalls)throw new Error("Physical budget24");row.wireSnapshots.push(snapshotDialogueWireBody(body));});
    let rawDelta="",firstVisibleMs:number|null=null;const started=Date.now();
    try{
      if(!provider.chatCompletionStream)throw new Error("Streaming required");
      const native=request.messages.map(m=>{if((m.role!=="user"&&m.role!=="assistant")||typeof m.content!=="string"||m.reasoning?.length)
        throw new Error("Only original visible native text is replayed");return{role:m.role,content:m.content};});
      const result=await provider.chatCompletionStream([{role:"system",content:request.systemPrompt},...native],
        {maxTokens:request.maxTokens,temperature:request.temperature,disableThinking:request.disableThinking,responseFormat:"text"},
        AbortSignal.timeout(45000),delta=>{rawDelta+=delta;if(firstVisibleMs===null&&sanitizeCompanionVisibleText(rawDelta).trim())firstVisibleMs=Date.now()-started;});
      const answer=finalizeCompanionReplyText({text:result.content,runId:fixture.id}).text,validation=validateCompanionOutput(answer);
      Object.assign(row,{answer:validation.ok?validation.text:answer,rawAnswer:result.content,validation,finishReason:result.finishReason,
        completedMatchesDeltas:result.content===rawDelta});
    }catch(error){row.error=safeFailure(error);}
    Object.assign(row,{rawDelta,firstVisibleMs,elapsedMs:Date.now()-started});persist();
    console.log(JSON.stringify({completed:rows.length,physical:wire.length,id:row.id,mode,elapsedMs:row.elapsedMs,error:row.error??null}));
  }
}
