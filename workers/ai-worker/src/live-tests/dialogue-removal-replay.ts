import {readFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {AgentRole,type AgentTurnRequest} from "@astella/shared";
import {agentDialogueFrameV1Schema} from "./diagnostics/companion-dialogue-contracts.ts";
import {buildCompanionDialogueReview,applyCompanionDialogueReview} from "./diagnostics/companion-dialogue-review.ts";
import {observedProvider,platform,save,safeFailure,outputDir,type WireReceipt} from "./acceptance-common.ts";

// Read-only diagnostic on unaltered recorded synthetic drafts. It supplies no
// ideal answer, simulates no user, and does not change the production route.
const suffix=process.env.LIVE_REVIEW_REPLAY_SUFFIX??"deepseek";
if(!/^[a-z0-9-]{1,40}$/.test(suffix))throw new Error("Invalid replay suffix");
const route=platform("agent_turn",process.env.LIVE_MODEL_ID);
const wire:WireReceipt[]=[],results:Array<Record<string,unknown>>=[];
for(const [source,turn] of [["frame-review-v2",1],["frame-review-v2",2],["frame-review-v3-book",2]] as const){
 const session=JSON.parse(readFileSync(`${outputDir}/natural-dialogue-${source}.json`,"utf8"));
 const record=session.results[turn-1];if(!record?.ok)throw new Error("Missing recorded draft");
 const frame=agentDialogueFrameV1Schema.parse(record.turn_interpretation.dialogueFrame);
 const messages=session.results.slice(0,turn).flatMap((r:any,i:number)=>[
   {role:"user" as const,content:r.user},...(i<turn-1?[{role:"assistant" as const,content:r.answer}]:[])]);
 const request:AgentTurnRequest={role:AgentRole.COMPANION_AGENT,systemPrompt:record.instructions[1],messages,
   tools:[],maxTokens:route.modelProfile?.maxOutputTokens??8000,temperature:0.3,disableThinking:false};
 const revision=buildCompanionDialogueReview(request,record.answer,frame);
 const provider=observedProvider(route,`removal-replay-${randomUUID()}`,wire);
 if(!provider.executeAgentTurn)throw new Error("No agent request support");
 const row:Record<string,unknown>={source,turn,user:record.user,draft:record.answer};results.push(row);
 const before=wire.length,start=Date.now();
 console.log(JSON.stringify({starting:source,turn,model:route.model}));
 try{
   const response=await provider.executeAgentTurn(revision,AbortSignal.timeout(45000));
   row.plan=response.content;
   if(response.finishReason!=="stop"||response.toolCalls.length)throw new Error("Incomplete review");
   Object.assign(row,{protocolOk:true,...applyCompanionDialogueReview(response.content??"",record.answer)});
 }catch(error){Object.assign(row,{protocolOk:false,error:safeFailure(error)});}
 Object.assign(row,{elapsedMs:Date.now()-start,wire:wire.slice(before)});
 save(`dialogue-removal-replay-${suffix}`,{model:route.model,
   note:"Diagnostic only; recorded synthetic draft and conversation, reconstructed review request, no reference answer, no DB budget or HTTP delivery exercised. Structural validity does not certify judgment. These are known failures, not independent held-out acceptance.",results});
 console.log(JSON.stringify(row));
}
