import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { AgentRole } from "@astella/shared";
import { buildCompanionPersonaMessages } from "../handlers/turn/companion-dialogue-content.ts";
import { resolveCompanionPersonaContext } from "../handlers/memory/companion-identity-context.ts";
import { companionResponseStrategy, isCompanionExplanation } from "../handlers/turn/companion-response-strategy.ts";
import { buildCompanionKnowledgeReview, parseCompanionKnowledgeReview } from "./diagnostics/companion-knowledge-review.ts";
import { CompanionKnowledgeReviewError } from "./diagnostics/companion-review-errors.ts";
import { companionStepRuntimePolicy } from "../handlers/turn/companion-step-plan.ts";
import { observedProvider, platform, save, safeFailure, type WireReceipt } from "./acceptance-common.ts";
import { qualityCases, parseQualityVerdicts, qualityJudgeMessages } from "./quality-cases.ts";
import { createQualityRequestBudget } from "./quality-budget.ts";
import { qualityPersonaVariant, selectQualityCases } from "./quality-persona-variant.ts";
import { execFileSync } from "node:child_process";

const route=platform("agent_turn"), wire:WireReceipt[]=[], results:Array<Record<string,unknown>>=[];
const batchId=randomUUID();
const budget=createQualityRequestBudget(process.env.LIVE_QUALITY_MAX_REQUESTS);
const revision=execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const worktreeDirty=execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length>0;
const startedAt=new Date().toISOString();
const suffix=process.env.LIVE_QUALITY_SUFFIX??"";
if(suffix&&!/^[a-z0-9-]{1,40}$/.test(suffix))throw new Error("Invalid quality output suffix");
const outputName=suffix?`quality-comparison-${suffix}`:"quality-comparison";
const variants=process.env.LIVE_QUALITY_CURRENT_ONLY==="1"?["current"]:null;
const repeats=Number(process.env.LIVE_QUALITY_REPEATS??2);
if(!Number.isInteger(repeats)||repeats<1||repeats>3)throw new Error("repeats must be 1..3");
const cases=selectQualityCases(qualityCases,process.env.LIVE_QUALITY_CASES);
if(cases.length===0)throw new Error("no selected cases");
const persist=()=>save(outputName,{batchId,revision,worktreeDirty,startedAt,route:route.model,
  requestBudget:budget.max,requestCount:budget.used,
  note:"Tool-free diagnostic, not the production agent loop: knowledge fixtures use a supplied question intent and 0.3 temperature. Baseline is a partial historical simulation and changes prompt/temperature/routing, not a temperature-only experiment. Judge uses evaluation-only references; raw answers require human review.",results,wire});

async function compare(fixture:typeof qualityCases[number]) {
  for(let repeat=0;repeat<repeats;repeat++)for(const variant of variants??(repeat%2?["current","baseline"]:["baseline","current"])) {
    const row:Record<string,unknown>={caseId:fixture.id,kind:fixture.kind,repeat,variant}; results.push(row);
    console.log(JSON.stringify({starting:fixture.id,repeat,variant}));
    const started=Date.now();
    try {
      // The old classifier treated self-report as casual chat. The current
      // diagnostic treats it as a question about records.
      const intent=fixture.kind==="conversation"?"conversation":fixture.kind==="knowledge"||variant==="current"?"question":"conversation";
      const strategy=companionResponseStrategy({intent,toolUse:"none"});
      const messages=buildCompanionPersonaMessages({userText:fixture.prompt,recentMessages:fixture.history,
        pageContext:null,petProfile:resolveCompanionPersonaContext(null)});
      let system=qualityPersonaVariant(String(messages[0]!.content),variant as "current"|"baseline");
      system+="\n"+companionStepRuntimePolicy({permissionLevel:"read_only",toolCount:0,stepBudget:3,
        finalAnswerOnly:false,attentionIntent:intent});
      if(variant==="current"&&strategy.guidance)system+="\n"+strategy.guidance;
      messages[0]={role:"system",content:system};
      row.systemHash=createHash("sha256").update(system).digest("hex");
      const provider=observedProvider(route,`quality-${batchId}-${fixture.id}-${repeat}-${variant}`,wire,
        undefined,undefined,undefined,()=>budget.reserve());
      let reply=await provider.chatCompletion(messages,{temperature:variant==="current"?strategy.temperature:
        fixture.kind==="knowledge"?0.4:0.9,maxTokens:Math.min(route.modelProfile?.maxOutputTokens??4096,4096),
        disableThinking:intent==="conversation",responseFormat:"text"},AbortSignal.timeout(90000));
      if(variant==="current"&&process.env.LIVE_QUALITY_REVIEW==="1"
          &&isCompanionExplanation({intent},fixture.prompt,0)) {
        row.draftAnswer=reply.content;row.draftMs=Date.now()-started;
        const revision=buildCompanionKnowledgeReview({role:AgentRole.COMPANION_AGENT,systemPrompt:system,
          messages:messages.slice(1),tools:[],maxTokens:Math.min(route.modelProfile?.maxOutputTokens??4096,4096),
          temperature:strategy.temperature,disableThinking:false},reply.content);
        const reviewStarted=Date.now();
        const reviewed=await provider.executeAgentTurn!(revision,AbortSignal.timeout(90000));
        if(reviewed.finishReason!=="stop"||reviewed.toolCalls.length)throw new Error("invalid review completion");
        row.knowledgeReviewRaw=reviewed.content;
        const report=parseCompanionKnowledgeReview(reviewed.content??"",reply.content);
        row.knowledgeReview=report.corrections;row.knowledgeFocus=report.focus;
        reply={content:report.answer,usage:reviewed.usage??{}};
        row.reviewMs=Date.now()-reviewStarted;
      }
      Object.assign(row,{answer:reply.content,generationMs:Date.now()-started,
        temperature:variant==="current"?strategy.temperature:fixture.kind==="knowledge"?0.4:0.9,
        fixture: {prompt:fixture.prompt,history:fixture.history,reference:fixture.reference,criteria:fixture.criteria,sources:fixture.sources}});
      persist();
      const judge=observedProvider(route,`judge-${batchId}-${fixture.id}-${repeat}-${variant}`,wire,
        undefined,undefined,undefined,()=>budget.reserve());
      const judged=await judge.chatCompletion(qualityJudgeMessages(fixture,reply.content),
        {temperature:0,maxTokens:Math.min(route.modelProfile?.maxOutputTokens??4096,4096),disableThinking:false,responseFormat:"json_object"},AbortSignal.timeout(90000));
      row.judgeAnswer=judged.content;
      let verdicts;
      try { verdicts=parseQualityVerdicts(judged.content,reply.content,fixture); }
      catch(error) { row.reviewStatus="invalid";row.judgeError=error instanceof SyntaxError?"json_parse":
        error instanceof Error?error.message:"invalid";throw error; }
      row.verdicts=verdicts;row.ok=verdicts.every(v=>v.pass);
    }catch(error){row.ok=false;row.error=safeFailure(error);
      if(error instanceof CompanionKnowledgeReviewError)row.reviewError=error.reason;}
    row.totalMs=Date.now()-started;persist();
    console.log(JSON.stringify({caseId:fixture.id,variant,repeat,ok:row.ok,generationMs:row.generationMs,error:row.error}));
  }
}
// Two independent cases at a time, each variant/repeat remains sequential.
for(let i=0;i<cases.length;i+=2) {
  const settled=await Promise.allSettled(cases.slice(i,i+2).map(compare));
  for(const r of settled)if(r.status==="rejected")throw r.reason;
}
persist();
if(results.some(row=>row.ok!==true)) process.exitCode=1;
