import assert from "node:assert/strict";
import { test } from "node:test";
import { interpretCompanionTurn, companionDialogueSources } from "../companion-tool-intent.ts";
import { companionDialoguePurposePolicy } from "../companion-dialogue-frame.ts";
import { shouldKeepSpeculativeFirstStep } from "../companion-speculative-first-step.ts";
import type { AIProvider } from "../../lib/ai-provider.ts";

const job={id:"frame-job",workspaceId:"frame-workspace",requestedBy:"frame-user",leaseToken:"frame-lease",signal:new AbortController().signal};

test("在已有解释调用中提供完整用户证据并绑定用途，不另发模型调用",async()=>{
  const old="背景🫧\r\n".repeat(400)+"尾部更正：未提交。";
  const messages=[{role:"user" as const,content:old},{role:"assistant" as const,content:"已经提交了"},
    {role:"user" as const,content:"还没交呢，写完而已"}];
  assert.equal(companionDialogueSources(messages)[0]!.content,old);
  let calls=0;
  const provider={id:"frame-test",modelId:"frame-test",visionModelId:"frame-test",promptVersion:"frame-test",
    chatCompletion:async (request,options)=>{
      calls++;
      const input=JSON.parse(String(request.at(-1)!.content));
      assert.equal(input.userRecords[0].content,old);
      assert.ok(!input.userRecords.some((x:{role:string})=>x.role==="assistant"));
      assert.equal(options.disableThinking,true);
      return {content:JSON.stringify({intent:"conversation",toolUse:"none",subjects:[],goalRelation:"unrelated",
        candidateOperations:[],ambiguities:[],dialogueFrame:{purpose:"correction",evidence:{messageIndex:2,quote:"还没交呢"},
          userState:[{topic:"报告",aspect:"progress",relation:"correction",messageIndex:2,quote:"还没交呢，写完而已"}]}}),usage:{}};
    }} as AIProvider;
  const result=await interpretCompanionTurn(provider,messages,{job,runId:"frame-run",userId:"frame-user",permissionLevel:"read_only",
    currentActiveTransaction:()=>undefined,verifyAttempt:async()=>true,dialogueFrameEnabled:true});
  assert.equal(calls,1);
  assert.equal(result.dialogueFrame?.purpose,"correction");
  assert.equal(result.dialogueFrame?.userState[0]?.quote,"还没交呢，写完而已");
  assert.equal(shouldKeepSpeculativeFirstStep(result),false,"没有收到用途和状态的预生成不能被复用");
  assert.notEqual(companionDialoguePurposePolicy(result.dialogueFrame),companionDialoguePurposePolicy({...result.dialogueFrame!,purpose:"seeking_help"}));
});

test("明确进展与纠正不会被闲聊类别关闭思考；招呼和口味仍走轻量档", async()=>{
  const { companionTurnThinking }=await import("../companion-turn-thinking.ts");
  const { companionResponseStrategy }=await import("../companion-response-strategy.ts");
  const state={topic:"报告",aspect:"timing" as const,relation:"statement" as const,
    messageIndex:0,quote:"明天交",sourceSha256:"a".repeat(64)};
  for(const dialogueFrame of [{purpose:"sharing" as const,userState:[state]},
    {purpose:"correction" as const,userState:[]}]){
    const attention={intent:"conversation",toolUse:"none",dialogueFrame};
    assert.equal(companionTurnThinking(attention).disableThinking,false);
    assert.equal(companionResponseStrategy(attention).temperature,0.3);
    assert.equal(companionResponseStrategy(attention).mode,"casual");
    assert.equal(companionResponseStrategy(attention).guidance,"");
  }
  for(const purpose of ["greeting","preference"] as const){
    const attention={intent:"conversation",toolUse:"none",dialogueFrame:{purpose,userState:[]}};
    assert.equal(companionTurnThinking(attention).disableThinking,true);
    assert.equal(companionResponseStrategy(attention).temperature,0.9);
  }
});

test("旧进展仅作为背景时不会把新的生活话题升级成思考轮",async()=>{
  const {companionTurnThinking}=await import("../companion-turn-thinking.ts");
  const {companionResponseStrategy}=await import("../companion-response-strategy.ts");
  const state={topic:"柜门",aspect:"timing" as const,relation:"statement" as const,relevance:"background" as const,
    messageIndex:0,quote:"周五装",sourceSha256:"a".repeat(64)};
  const attention={intent:"conversation",toolUse:"none",dialogueFrame:{purpose:"sharing" as const,userState:[state]}};
  assert.equal(companionTurnThinking(attention).disableThinking,true);
  assert.equal(companionResponseStrategy(attention).temperature,0.9);
});
