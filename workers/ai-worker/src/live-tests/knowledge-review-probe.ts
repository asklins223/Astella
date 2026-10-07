import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { AgentRole } from "@astella/shared";
import { buildCompanionPersonaMessages } from "../handlers/companion-dialogue-content.ts";
import { resolveCompanionPersonaContext } from "../handlers/companion-identity-context.ts";
import { buildCompanionKnowledgeReview, parseCompanionKnowledgeReview } from "../handlers/companion-knowledge-review.ts";
import { platform, observedProvider, save, safeFailure, outputDir, type WireReceipt } from "./acceptance-common.ts";
import { qualityCases } from "./quality-cases.ts";

// Reuse known failures; reference facts are never sent to this review call.
const previous=JSON.parse(readFileSync(`${outputDir}/quality-comparison-reviewed.json`,"utf8")) as {
  results: Array<{caseId:string;answer:string}>;
};
const suffix=process.env.LIVE_REVIEW_SUFFIX??"";
if(suffix&&!/^[a-z0-9-]{1,40}$/.test(suffix))throw new Error("Invalid review suffix");
const name=suffix?`knowledge-review-probe-${suffix}`:"knowledge-review-probe";
const route=platform("agent_turn"), wire: WireReceipt[]=[], results:Array<Record<string,unknown>>=[];
for (const id of process.env.LIVE_REVIEW_CASES?.split(",")??["coffee-detailed","newton-pair","correlation"]) {
  const fixture=qualityCases.find(c=>c.id===id)!;
  const draft=previous.results.find(r=>r.caseId===id)!.answer;
  const messages=buildCompanionPersonaMessages({userText:fixture.prompt,recentMessages:fixture.history,
    pageContext:null,petProfile:resolveCompanionPersonaContext(null)});
  const request=buildCompanionKnowledgeReview({role:AgentRole.COMPANION_AGENT,
    systemPrompt:String(messages[0]!.content),messages:messages.slice(1),tools:[],
    temperature:0.3,maxTokens:route.modelProfile?.maxOutputTokens??131072},draft);
  const row:Record<string,unknown>={caseId:id,draft};results.push(row);
  console.log(JSON.stringify({starting:id}));
  try {
    const provider=observedProvider(route,`review-probe-${randomUUID()}`,wire),started=Date.now();
    const response=await provider.executeAgentTurn!(request,AbortSignal.timeout(90000));
    if(response.finishReason!=="stop"||response.toolCalls.length)throw new Error("invalid review completion");
    row.reviewMs=Date.now()-started;row.raw=response.content;
    Object.assign(row,parseCompanionKnowledgeReview(response.content??"",draft));row.protocolOk=true;
  } catch(error) {row.protocolOk=false;row.error=safeFailure(error);}
  save(name,{route:route.model,results,wire});
  console.log(JSON.stringify({caseId:id,protocolOk:row.protocolOk,reviewMs:row.reviewMs}));
}
