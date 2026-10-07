import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import postgres from "postgres";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { closeDatabase } from "../db.ts";
import { runCompanionAgentLoop } from "../handlers/companion-agent-runtime.ts";
import type { ReadContext } from "../handlers/companion-dialogue-store.ts";
import { MockProvider } from "../lib/providers/mock.ts";
import type { AIProvider } from "../lib/ai-provider.ts";
import { createGovernedProvider } from "../lib/governance.ts";
import { createCompanionContextReceipts } from "../handlers/companion-context-receipts.ts";
import { CompanionKnowledgeReviewError, AgentOutputError } from "../lib/non-retryable-errors.ts";
import { AGENT_LOOP_MAX_STEPS } from "../handlers/companion-step-plan.ts";

const originalReviewFlag = process.env.COMPANION_EXPLANATION_REVIEW_V1;
before(()=>{process.env.COMPANION_EXPLANATION_REVIEW_V1="true";});
after(()=>{
  if(originalReviewFlag===undefined)delete process.env.COMPANION_EXPLANATION_REVIEW_V1;
  else process.env.COMPANION_EXPLANATION_REVIEW_V1=originalReviewFlag;
});

const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 2 });
after(async () => { await admin.end(); await closeDatabase(); });

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

test("真实工具循环保留完整JSON，并按块内游标读到长段落的最后一句", async () => {
  const f = await fixture();
  const noteId=randomUUID(), versionId=randomUUID();
  const original="\\".repeat(5000)+"关键结论在最后。";
  try {
    await f.mutate(async tx => {
      await tx`INSERT INTO notes(id,workspace_id,title,created_by) VALUES(${noteId},${f.event.ctx.workspaceId},'长段落',${f.event.read.userId})`;
      await tx`INSERT INTO note_versions(id,note_id,workspace_id,version_no,content_json,content_hash,created_by)
        VALUES(${versionId},${noteId},${f.event.ctx.workspaceId},1,'{}',${'c'.repeat(64)},${f.event.read.userId})`;
      await tx`UPDATE notes SET current_version_id=${versionId} WHERE id=${noteId}`;
      await tx`INSERT INTO note_blocks(workspace_id,version_id,ordinal,type,content)
        VALUES(${f.event.ctx.workspaceId},${versionId},1,'paragraph',${original})`;
    });
    const pages:string[]=[];
    const provider:AIProvider=new MockProvider();
    provider.chatCompletion=async()=>({content:JSON.stringify({intent:"question",toolUse:"read",
      subjects:[],goalRelation:"unrelated",candidateOperations:[],ambiguities:[],pendingOfferIndexes:[]}),usage:{}});
    let calls=0;
    provider.executeAgentTurn=async request=>{
      calls++;
      const tool=request.messages.at(-1);
      let next: {nextStartOrdinal?:number;nextStartOffset?:number}={nextStartOrdinal:1,nextStartOffset:0};
      if(tool?.role==='tool') {
        assert.ok(typeof tool.content==='string');
        const parsed=JSON.parse(tool.content);
        assert.equal(parsed.ok,true);
        pages.push(parsed.data.body);
        next=parsed.data;
        if(!parsed.data.truncated) return {content:"内容已经读完了。",toolCalls:[],finishReason:"stop",usage:null,providerRequestId:null};
      }
      return {content:null,toolCalls:[{id:`read-${calls}`,name:'companion_read_note',arguments:{noteId,
        noteVersionId:versionId,startOrdinal:next.nextStartOrdinal,startOffset:next.nextStartOffset}}],
        finishReason:"tool_calls",usage:null,providerRequestId:null};
    };
    const contextReceipts=createCompanionContextReceipts();
    const governed=createGovernedProvider(provider,{consentOk:true,policy:{sendToExternal:true,
      sendImageContent:false,piiDetection:false,auditLogging:false}},f.event.ctx.workspaceId,
      {userId:f.event.read.userId,operation:"companion_agent"},contextReceipts.pressureGate);
    const result=await runCompanionAgentLoop({ctx:f.event.ctx,read:readContext(f),provider:governed,contextReceipts,
      toolConstraints:{visionEnabled:false},baseMessages:[{role:"system",content:"读完指定笔记。"},
        {role:"user",content:"请读这篇笔记的完整正文。"}],expiresAt:new Date(Date.now()+60000).toISOString()});
    assert.equal(result.status,'completed');
    assert.equal(pages.join(''),original);
    assert.equal(calls,3,"两页工具取材之后只生成一次终答");
    const [run]=await f.mutate(tx=>tx`SELECT context_pressure FROM companion_turn_runs WHERE id=${f.event.read.runId}`);
    assert.equal(run.context_pressure.inputTokens,contextReceipts.latestPressure()?.inputTokens,
      "工具循环终答必须保存最后一次发送的读数，不能停在上一个工具步");
  } finally {await f.cleanup();}
});

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

test("命中输出上限时保留已流出的正文，但不会把半截答案结为成功", async () => {
  const f=await fixture();
  try {
    const provider:AIProvider=new MockProvider();
    const delivered:string[]=[];
    provider.chatCompletion=async()=>({content:JSON.stringify({intent:"conversation",toolUse:"none",
      subjects:[],goalRelation:"unrelated",candidateOperations:[],ambiguities:[],pendingOfferIndexes:[]}),usage:{}});
    const prefix="这一段已经说出来，但还没有把后面的内容讲完";
    provider.chatCompletionStream=async(_messages,_options,_signal,onDelta)=>{
      onDelta(prefix);return {content:prefix,toolCalls:[],finishReason:"length"};
    };
    provider.executeAgentTurn=async()=>{throw new Error("已经发出文字时不能再生成另一份答案");};
    await assert.rejects(runCompanionAgentLoop({ctx:f.event.ctx,read:readContext(f),provider,
      toolConstraints:{visionEnabled:false},baseMessages:[{role:"system",content:"自然回应。"},
        {role:"user",content:"你好"}],expiresAt:new Date(Date.now()+60000).toISOString(),
      onProviderDelta:async text=>{delivered.push(text);return true;}}),
      (error:unknown)=>error instanceof AgentOutputError && error.code==='output_truncated');
    assert.equal(delivered.join(''),prefix);
    const [step]=await f.mutate(tx=>tx`SELECT status FROM companion_agent_steps WHERE run_id=${f.event.read.runId}`);
    assert.equal(step.status,'failed');
  } finally {await f.cleanup();}
});

test("概念提问丢弃闲聊预生成，正式无工具流式请求开启思考并只交付正式正文", async () => {
  const f=await fixture();
  try {
    const provider:AIProvider=new MockProvider();
    const modes:Array<boolean|undefined>=[], temperatures:Array<number|undefined>=[], policies:string[]=[], delivered:string[]=[];
    provider.chatCompletion=async()=>({content:JSON.stringify({intent:"question",toolUse:"none",
      subjects:[],goalRelation:"unrelated",candidateOperations:[],ambiguities:[],pendingOfferIndexes:[]}),usage:{}});
    provider.chatCompletionStream=async(_messages,options,_signal,onDelta)=>{
      modes.push(options.disableThinking);
      temperatures.push(options.temperature);
      policies.push(String(_messages[0]?.content));
      const content=options.disableThinking ? "这是应该作废的闲聊猜测。" : "牛顿第二定律说的是：合力等于质量乘加速度。";
      onDelta(content);
      return {content,toolCalls:[],finishReason:"stop"};
    };
    provider.executeAgentTurn=async()=>{throw new Error("无工具请求不需要缓冲重跑");};
    const result=await runCompanionAgentLoop({ctx:f.event.ctx,read:{...readContext(f),userText:"牛顿第二定律是什么？"},provider,
      toolConstraints:{visionEnabled:false},baseMessages:[{role:"system",content:"解释概念。"},
        {role:"user",content:"牛顿第二定律是什么？"}],expiresAt:new Date(Date.now()+60000).toISOString(),
      onProviderDelta:async text=>{delivered.push(text);return true;}});
    assert.deepEqual(modes,[true,false]);
    assert.deepEqual(temperatures,[0.9,0.3]);
    assert.match(policies[1]!, /方向是否颠倒/);
    assert.equal(result.status,"completed");
    assert.equal(result.text,"牛顿第二定律说的是：合力等于质量乘加速度。");
    assert.equal(delivered.join(""),result.text);
  } finally {await f.cleanup();}
});

test("默认关闭实验审校时，解释直接交付且不误拦说明性引号",async()=>{
  const f=await fixture(),saved=process.env.COMPANION_EXPLANATION_REVIEW_V1;
  try {
    delete process.env.COMPANION_EXPLANATION_REVIEW_V1;
    const provider:AIProvider=new MockProvider(),delivered:string[]=[],modes:Array<boolean|undefined>=[];
    let bufferedCalls=0;
    const answer="热量通常从较热物体传给较冷物体。可以把这个过程叫作「物体与环境之间缓慢地传递热量」。";
    provider.chatCompletion=async()=>({content:JSON.stringify({intent:"question",toolUse:"none",subjects:[],
      goalRelation:"unrelated",candidateOperations:[],ambiguities:[],pendingOfferIndexes:[]}),usage:{}});
    provider.executeAgentTurn=async()=>{bufferedCalls++;throw new Error("默认关闭时不额外生成审校报告");};
    provider.chatCompletionStream=async(_messages,options,_signal,onDelta)=>{
      modes.push(options.disableThinking);
      const content=options.disableThinking?"作废的闲聊。":answer;
      onDelta(content);return {content,toolCalls:[],finishReason:"stop"};
    };
    const result=await runCompanionAgentLoop({ctx:f.event.ctx,read:{...readContext(f),userText:"解释物体怎样传热。"},provider,
      toolConstraints:{visionEnabled:false},baseMessages:[{role:"system",content:"讲清概念。"},{role:"user",content:"解释物体怎样传热。"}],
      expiresAt:new Date(Date.now()+60000).toISOString(),onProviderDelta:async text=>{delivered.push(text);return true;}});
    assert.equal(result.status,"completed");
    assert.equal(result.text,answer);
    assert.equal(delivered.join(""),answer);
    assert.deepEqual(modes,[true,false]);
    assert.equal(bufferedCalls,0);
  } finally {
    if(saved===undefined)delete process.env.COMPANION_EXPLANATION_REVIEW_V1;
    else process.env.COMPANION_EXPLANATION_REVIEW_V1=saved;
    await f.cleanup();
  }
});

test("续跑到最后一步时解释先用稳定档生成，复核后才交付终答", async () => {
  const f=await fixture();
  try {
    await f.mutate(tx=>tx`UPDATE companion_turn_runs SET step_count=${AGENT_LOOP_MAX_STEPS-1} WHERE id=${f.event.read.runId}`);
    const provider:AIProvider=new MockProvider();
    provider.chatCompletion=async()=>({content:JSON.stringify({intent:"question",toolUse:"none",subjects:[],
      goalRelation:"unrelated",candidateOperations:[],ambiguities:[],pendingOfferIndexes:[]}),usage:{}});
    let formalCalls=0;
    let draftCalls=0;
    const delivered:string[]=[];
    provider.executeAgentTurn=async request=>{
      if(request.systemPrompt.includes("<review_context_data>")) {
        formalCalls++;
        assert.equal(request.temperature,0.2);
        assert.equal(request.disableThinking,false);
        assert.equal(request.tools.length,0);
        assert.match(request.systemPrompt,/先审查命题/);
        assert.match(request.systemPrompt,/草稿中的错误不会发给用户/);
        return {content:JSON.stringify({focus:["当前用户问题"],corrections:[{spanId:1,issue:"unsupported",
          problem:"仅用于内部测试的审校说明。"}],
          answer:"牛顿第二定律说的是：合力等于质量乘加速度。"}),
          toolCalls:[],finishReason:"stop",usage:{completionTokens:80},providerRequestId:"review-request"};
      }
      draftCalls++;
      assert.equal(request.temperature,0.3);
      assert.equal(request.disableThinking,false);
      return {content:"草稿中的错误不会发给用户。",toolCalls:[],finishReason:"stop",usage:null,providerRequestId:null};
    };
    provider.chatCompletionStream=async(_messages,options,_signal,onDelta)=>{
      assert.equal(options.disableThinking,true,"审校 JSON 不能进入可见流式通道");
      const content="作废的猜测。";
      onDelta(content);return {content,toolCalls:[],finishReason:"stop"};
    };
    const result=await runCompanionAgentLoop({ctx:f.event.ctx,read:{...readContext(f),userText:"解释牛顿第二定律。"},
      provider,toolConstraints:{visionEnabled:false},baseMessages:[{role:"system",content:"讲清当前概念。"},
        {role:"user",content:"解释牛顿第二定律。"}],expiresAt:new Date(Date.now()+60000).toISOString(),
      onProviderDelta:async text=>{delivered.push(text);return true;}});
    assert.equal(result.status,"completed");
    assert.equal(formalCalls,1);
    assert.equal(draftCalls,1);
    assert.deepEqual(delivered,[],"复核全文还须经过语义校验，再由交付管线补写一次");
    assert.equal(result.text,"牛顿第二定律说的是：合力等于质量乘加速度。");
  } finally {await f.cleanup();}
});

test("发布前复核失败不会把未审的解释草稿当成功答案发出去",async()=>{
  const f=await fixture();
  try {
    const provider:AIProvider=new MockProvider();const delivered:string[]=[];
    provider.chatCompletion=async()=>({content:JSON.stringify({intent:"question",toolUse:"none",subjects:[],
      goalRelation:"unrelated",candidateOperations:[],ambiguities:[],pendingOfferIndexes:[]}),usage:{}});
    provider.executeAgentTurn=async request=>{
      if(request.systemPrompt.includes("<review_context_data>"))throw new Error("review unavailable");
      return {content:"这一段是尚未发布的草稿。",toolCalls:[],finishReason:"stop",usage:null,providerRequestId:null};
    };
    provider.chatCompletionStream=async(_messages,options,_signal,onDelta)=>{
      if(!options.disableThinking)throw new Error("review unavailable");
      onDelta("作废的闲聊。");return {content:"作废的闲聊。",toolCalls:[],finishReason:"stop"};
    };
    await assert.rejects(runCompanionAgentLoop({ctx:f.event.ctx,read:{...readContext(f),userText:"详细解释一个概念。"},provider,
      toolConstraints:{visionEnabled:false},baseMessages:[{role:"system",content:"解释当前问题。"},{role:"user",content:"详细解释一个概念。"}],
      expiresAt:new Date(Date.now()+60000).toISOString(),onProviderDelta:async text=>{delivered.push(text);return true;}}),/review unavailable/);
    assert.deepEqual(delivered,[]);
  }finally{await f.cleanup();}
});

test("复核后引文守卫要求改写时只保留校验后的终答，不泄漏前一版",async()=>{
  const f=await fixture();
  try {
    const provider:AIProvider=new MockProvider();const delivered:string[]=[];
    let reviews=0;
    provider.chatCompletion=async()=>({content:JSON.stringify({intent:"question",toolUse:"none",subjects:[],
      goalRelation:"unrelated",candidateOperations:[],ambiguities:[],pendingOfferIndexes:[]}),usage:{}});

    const final="热量从较热的物体传给较冷的物体。这个过程可以叫作「物体与环境之间缓慢地传递热量」。";
    provider.executeAgentTurn=async request=>{
      const content=request.systemPrompt.includes("<review_context_data>")
        ?JSON.stringify({focus:["当前用户问题"],corrections:[],answer:++reviews===1
          ?"笔记原文说：「热量总是从较冷的物体流向较热的物体」。":final})
        :"内部待核对的草稿。";
      return {content,toolCalls:[],finishReason:"stop",usage:null,providerRequestId:null};
    };
    provider.chatCompletionStream=async(_messages,options,_signal,onDelta)=>{
      assert.equal(options.disableThinking,true);
      onDelta("作废的闲聊。");return {content:"作废的闲聊。",toolCalls:[],finishReason:"stop"};
    };
    const result=await runCompanionAgentLoop({ctx:f.event.ctx,read:{...readContext(f),userText:"解释物体之间如何传热。"},provider,
      toolConstraints:{visionEnabled:false},baseMessages:[{role:"system",content:"讲清当前概念。"},{role:"user",content:"解释物体之间如何传热。"}],
      expiresAt:new Date(Date.now()+60000).toISOString(),onProviderDelta:async text=>{delivered.push(text);return true;}});
    assert.equal(reviews,2,"没有来源的真实引文声明必须触发改写");
    assert.equal(result.status,"completed");
    assert.equal(result.text,final,"被守卫拒绝的解释不能拼进最终正文");
    assert.deepEqual(delivered,[],"全部语义校验通过后才由交付管线一次补写");
  }finally{await f.cleanup();}
});

test("空解释经兜底修复后仍必须复核，不能把新草稿直接交付",async()=>{
  const f=await fixture();
  try {
    const provider:AIProvider=new MockProvider(), fallbackProvider:AIProvider=new MockProvider();
    Object.defineProperty(fallbackProvider,"id",{value:"repair-provider"});
    Object.defineProperty(fallbackProvider,"modelId",{value:"repair-model"});
    const delivered:string[]=[];let reviews=0,repairs=0;
    provider.chatCompletion=async()=>({content:JSON.stringify({intent:"question",toolUse:"none",subjects:[],
      goalRelation:"unrelated",candidateOperations:[],ambiguities:[],pendingOfferIndexes:[]}),usage:{}});

    fallbackProvider.executeAgentTurn=async()=>{
      repairs++;return {content:"修复得到的待审草稿。",toolCalls:[],finishReason:"stop",usage:null,providerRequestId:null};
    };
    const final="热量通常自发地从较热物体传给较冷物体。";
    provider.executeAgentTurn=async request=>{
      if(request.systemPrompt.includes("<review_context_data>")) {
        reviews++;assert.match(request.systemPrompt,/修复得到的待审草稿/);
        assert.equal(request.temperature,0.2);
        return {content:JSON.stringify({focus:["当前用户问题"],corrections:[],answer:final}),toolCalls:[],finishReason:"stop",usage:null,providerRequestId:null};
      }
      return {content:"",toolCalls:[],finishReason:"stop",usage:null,providerRequestId:null};
    };
    provider.chatCompletionStream=async(_messages,options,_signal,onDelta)=>{
      assert.equal(options.disableThinking,true);
      onDelta("作废的闲聊。");return {content:"作废的闲聊。",toolCalls:[],finishReason:"stop"};
    };
    const result=await runCompanionAgentLoop({ctx:f.event.ctx,read:{...readContext(f),userText:"详细解释热量传递。"},provider,fallbackProvider,
      toolConstraints:{visionEnabled:false},baseMessages:[{role:"system",content:"讲清当前概念。"},{role:"user",content:"详细解释热量传递。"}],
      expiresAt:new Date(Date.now()+60000).toISOString(),onProviderDelta:async text=>{delivered.push(text);return true;}});
    assert.equal(repairs,1);assert.equal(reviews,1);
    assert.equal(result.status,"completed");
    assert.equal(result.text,final);assert.deepEqual(delivered,[]);
  }finally{await f.cleanup();}
});

test("解释草稿命中输出上限也不会以部分正文绕过发布前复核",async()=>{
  const f=await fixture();
  try {
    const provider:AIProvider=new MockProvider();const delivered:string[]=[];
    provider.chatCompletion=async()=>({content:JSON.stringify({intent:"question",toolUse:"none",subjects:[],
      goalRelation:"unrelated",candidateOperations:[],ambiguities:[],pendingOfferIndexes:[]}),usage:{}});
    provider.executeAgentTurn=async()=>({content:"尚未经过复核的长草稿。".repeat(50),toolCalls:[],finishReason:"length",usage:null,providerRequestId:null});
    provider.chatCompletionStream=async(_messages,options,_signal,onDelta)=>{
      assert.equal(options.disableThinking,true,"截断草稿不能进入复核或发布请求");
      onDelta("作废的猜测。");return {content:"作废的猜测。",toolCalls:[],finishReason:"stop"};
    };
    await assert.rejects(runCompanionAgentLoop({ctx:f.event.ctx,read:{...readContext(f),userText:"详细解释这个概念。"},provider,
      toolConstraints:{visionEnabled:false},baseMessages:[{role:"system",content:"解释当前问题。"},{role:"user",content:"详细解释这个概念。"}],
      expiresAt:new Date(Date.now()+60000).toISOString(),onProviderDelta:async text=>{delivered.push(text);return true;}}),
      (error:unknown)=>error instanceof AgentOutputError&&error.code==="output_truncated");
    assert.deepEqual(delivered,[]);
  }finally{await f.cleanup();}
});

for (const failure of ["malformed", "invalid-span", "capped", "tool-call"] as const) {
  test(`私有审校 ${failure} 不能发布草稿或内部报告`,async()=>{
    const f=await fixture();
    try {
      const provider:AIProvider=new MockProvider(),delivered:string[]=[];
      provider.chatCompletion=async()=>({content:JSON.stringify({intent:"question",toolUse:"none",subjects:[],
        goalRelation:"unrelated",candidateOperations:[],ambiguities:[],pendingOfferIndexes:[]}),usage:{}});
      let reviews=0;
      provider.executeAgentTurn=async request=>{
        const reviewing=request.systemPrompt.includes("<review_context_data>");
        if(reviewing)reviews++;
        return {content:reviewing?(failure==="malformed"?"invalid private report":JSON.stringify({
          focus:["当前用户问题"],corrections:failure==="invalid-span"?[{spanId:999,issue:"scope",problem:"范围"}]:[],
          answer:"这个答案不应该绕过审校协议交付。"})):"这是尚未核对的私有草稿。",
          finishReason:reviewing&&failure==="capped"?"length":"stop",
          toolCalls:reviewing&&failure==="tool-call"?[{id:"unexpected",name:"companion_read_memory",arguments:{}}]:[],
          usage:null,providerRequestId:null};
      };
      provider.chatCompletionStream=async(_messages,options,_signal,onDelta)=>{
        assert.equal(options.disableThinking,true);
        onDelta("作废的闲聊。");return {content:"作废的闲聊。",toolCalls:[],finishReason:"stop"};
      };
      await assert.rejects(runCompanionAgentLoop({ctx:f.event.ctx,read:{...readContext(f),userText:"详细解释这个概念。"},provider,
        toolConstraints:{visionEnabled:false},baseMessages:[{role:"system",content:"讲清概念。"},{role:"user",content:"详细解释这个概念。"}],
        expiresAt:new Date(Date.now()+60000).toISOString(),onProviderDelta:async text=>{delivered.push(text);return true;}}),
        error=>failure==="capped"?error instanceof AgentOutputError&&error.code==="output_truncated":error instanceof CompanionKnowledgeReviewError);
      assert.equal(reviews,1);
      assert.deepEqual(delivered,[]);
      const [step]=await f.mutate(tx=>tx`SELECT status,error_code FROM companion_agent_steps WHERE run_id=${f.event.read.runId}`);
      assert.equal(step.status,"failed");
      assert.equal(step.error_code,failure==="capped"?"AGENT_BUDGET_EXCEEDED":"COMPANION_KNOWLEDGE_REVIEW_INVALID");
    } finally {await f.cleanup();}
  });
}

for (const streamTools of [false, true]) {
  test(`闲聊预生成进入真实循环后只消费一次，流式工具能力=${streamTools}`, async () => {
    const f = await fixture();
    try {
      const delivered: string[] = [];
      let streamCalls = 0, bufferedCalls = 0;
      const provider: AIProvider = new MockProvider();
      provider.chatCompletionStreamToolCalls = streamTools;
      provider.chatCompletion = async () => ({content: JSON.stringify({intent:"conversation",
        toolUse:"none", subjects:[], goalRelation:"unrelated", candidateOperations:[],
        ambiguities:[], pendingOfferIndexes:[]}), usage:{} });
      provider.chatCompletionStream = async (_messages, options, _signal, onDelta) => {
        streamCalls++;
        assert.equal(options.disableThinking, true);
        const content = "嗨，我在这里，刚好听见你打招呼。";
        onDelta(content);
        return { content, toolCalls:[], finishReason:"stop" };
      };
      provider.executeAgentTurn = async () => {
        bufferedCalls++;
        return {content:"这是不应该再次生成的另一份回答。", toolCalls:[], finishReason:"stop", usage:null, providerRequestId:null};
      };
      const contextReceipts = createCompanionContextReceipts();
      const governed = createGovernedProvider(provider, {consentOk:true,policy:{sendToExternal:true,
        sendImageContent:false,piiDetection:false,auditLogging:false}}, f.event.ctx.workspaceId,
        {userId:f.event.read.userId,operation:"companion_agent"}, contextReceipts.pressureGate);
      const result = await runCompanionAgentLoop({ctx:f.event.ctx, read:readContext(f), provider:governed, contextReceipts,
        toolConstraints:{visionEnabled:false}, baseMessages:[{role:"system",content:"自然回应当下。"},
          {role:"user",content:"你好"}], expiresAt:new Date(Date.now()+60000).toISOString(),
        onProviderDelta: async delta => {delivered.push(delta); return true;} });
      assert.equal(result.status, "completed");
      assert.equal(streamCalls, 1, "已放行的预生成不能再次调用流式模型");
      assert.equal(bufferedCalls, 0, "缓冲路径也必须消费预生成结果");
      assert.equal(result.text, delivered.join(""), "最终正文必须与已交付文字相同");
      const [run] = await f.mutate(tx => tx`SELECT context_pressure FROM companion_turn_runs WHERE id=${f.event.read.runId}`);
      assert.equal(run.context_pressure.operation, "companion_agent:chat_completion_stream");
      assert.notEqual(run.context_pressure.outputReservationTokens, 900, "终答回执不是分类器的小JSON预算");
    } finally { await f.cleanup(); }
  });
}
