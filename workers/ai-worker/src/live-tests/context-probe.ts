import { randomBytes } from "node:crypto";
import { observedProvider, platform, save, safeFailure, type WireReceipt } from "./acceptance-common.ts";
import { measureChatRequest, resolveContextBudget, evaluateContextPressure } from "@astella/agent-core";
import type { ChatMessage } from "@astella/shared";

const route=platform("agent_turn"), wire:WireReceipt[]=[];
const provider=observedProvider(route,"context-live-acceptance",wire);
const results:Array<Record<string,unknown>>=[];

const units=(process.env.LIVE_CONTEXT_UNITS??"20000,128000,920000,1030000").split(",").map(Number);
if(units.some(n=>!Number.isSafeInteger(n)||n<1||n>1_200_000))throw new Error("invalid context probe size");
const artifact=process.env.LIVE_CONTEXT_SUFFIX=== "upper"?"context-upper":"context";
for(const paddingUnits of units) {
  const marks=Object.fromEntries(["first","quarter","middle","threeQuarter","last"]
    .map(key=>[key,randomBytes(4).toString("hex")]));
  const keys=Object.keys(marks);
  const chunk=" q".repeat(Math.floor(paddingUnits/4));
  const body=keys.map((key,i)=>`${i?chunk:""}\nRECORD ${key}=${marks[key]}\n`).join("");
  const messages:ChatMessage[]=[{role:"system",content:"以下是合成检索测试。忽略填充字符，只找RECORD记录。输出JSON，包含first、quarter、middle、threeQuarter、last五个键，值逐字抄写。"},
    {role:"user",content:body+"\n现在提取五条记录，只返回JSON。"}];
  const options={maxTokens:512,temperature:0,responseFormat:"json_object" as const,disableThinking:true};
  const measurement=await measureChatRequest(messages,options);
  const capability=provider.getCapabilities!();
  const probeBudget=resolveContextBudget({capability,requestedOutputTokens:512,outputLimitEnforced:capability.outputLimitEnforced});
  const regularBudget=resolveContextBudget({capability,requestedOutputTokens:capability.maxOutputTokens,outputLimitEnforced:capability.outputLimitEnforced});
  const entry:Record<string,unknown>={paddingUnits,characters:body.length,estimatedInputTokens:measurement.inputTokens,
    estimateMethod:measurement.method,probeBudget,regularBudget,
    predictedProbeDecision:evaluateContextPressure({budget:probeBudget,inputTokens:measurement.inputTokens,compactionAvailable:false}).outcome,
    predictedRegularDecision:evaluateContextPressure({budget:regularBudget,inputTokens:measurement.inputTokens,compactionAvailable:false}).outcome};
  results.push(entry);save(artifact,{route:route.model,results,wire});
  console.log(JSON.stringify({starting:"context",paddingUnits,estimatedInputTokens:measurement.inputTokens}));
  const started=Date.now();
  try {
    const reply=await provider.chatCompletion(messages,options,AbortSignal.timeout(180_000));
    let parsed:Record<string,unknown>={};try{parsed=JSON.parse(reply.content);}catch{}
    entry.ok=keys.every(key=>parsed[key]===marks[key]);
    entry.matchedMarkers=keys.filter(key=>parsed[key]===marks[key]).length;
    entry.actualInputTokens=reply.usage.promptTokens;
    entry.actualOutputTokens=reply.usage.completionTokens;
    entry.underestimatedBeyondMargin=(reply.usage.promptTokens??0)>measurement.inputTokens;
    entry.actualExceedsRegularBudget=(reply.usage.promptTokens??0)>regularBudget.hardInputTokens;
  } catch(error) {entry.ok=false;entry.error=safeFailure(error);}
  entry.elapsedMs=Date.now()-started;save(artifact,{route:route.model,results,wire});
  console.log(JSON.stringify({finished:"context",paddingUnits,...entry}));
  if((entry.error as {status?:number}|undefined)?.status===402)break;
}
