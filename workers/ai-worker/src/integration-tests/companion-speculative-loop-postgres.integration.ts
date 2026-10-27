import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import postgres from "postgres";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { closeDatabase } from "../db.ts";
import { runCompanionAgentLoop } from "../handlers/agent/companion-agent-runtime.ts";
import type { ReadContext } from "../handlers/turn/companion-dialogue-store.ts";
import { MockProvider } from "../lib/providers/mock.ts";
import type { AIProvider } from "../lib/ai-provider.ts";
import { createGovernedProvider } from "../lib/governance.ts";
import { createCompanionContextReceipts } from "../handlers/context/companion-context-receipts.ts";
import { AgentOutputError } from "../lib/non-retryable-errors.ts";
import { sha256Utf8V1 } from "@astella/shared/content-hash";
import { getCompanionAgentTool } from "@astella/shared";
import { writeFileSync } from "node:fs";
import { executeCompanionMemoryTool } from "../handlers/tools/companion-memory-tools.ts";
import { CompanionOutputTimeoutError } from "../handlers/agent/companion-output-watchdog.ts";

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
  // Quotes are JSON-escaped by the tool envelope while remaining stable in the
  // editor's Markdown projection; backslashes here would be consumed as Markdown escapes.
  const original='"'.repeat(5000)+"关键结论在最后。";
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
    const pageReceipts: Array<Record<string, unknown>> = [];
    const provider:AIProvider=new MockProvider();
    provider.chatCompletion=async()=>({content:JSON.stringify({intent:"question",toolUse:"read",
      subjects:[],goalRelation:"unrelated",candidateOperations:[],ambiguities:[],voiceStyle:{decision:"none",instruction:null},pendingOfferIndexes:[]}),usage:{}});
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
        pageReceipts.push({ bodyLength: parsed.data.body.length, truncated: parsed.data.truncated,
          endOrdinal: parsed.data.endOrdinal, nextStartOrdinal: parsed.data.nextStartOrdinal,
          nextStartOffset: parsed.data.nextStartOffset });
        next=parsed.data;
        if(!parsed.data.truncated) return {content:"内容已经读完了。",toolCalls:[],finishReason:"stop",usage:null,providerRequestId:null};
      }
      return {content:null,toolCalls:[{id:`read-${calls}`,name:'companion_notes_read',arguments:{ action: "read",noteId,
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
    assert.equal(pages.join(''),original, JSON.stringify(pageReceipts));
    assert.equal(calls,3,"两页工具取材之后只生成一次终答");
    const [run]=await f.mutate(tx=>tx`SELECT context_pressure FROM companion_turn_runs WHERE id=${f.event.read.runId}`);
    assert.equal(run.context_pressure.inputTokens,contextReceipts.latestPressure()?.inputTokens,
      "工具循环终答必须保存最后一次发送的读数，不能停在上一个工具步");
  } finally {await f.cleanup();}
});

function readContext(f: Awaited<ReturnType<typeof fixture>>): ReadContext {
  return { ...f.event.read, conversationId: f.conversationId, userMessageId: f.messageId,
    runStatus: "running",
    livePageView: null, pageContext: null, userText: "你好",
    recentMessages: [], residentMemories: [], memoryDirectory: [], playbookCatalog: [], playbookCandidates: [], deliveryObservation: null,
    organizationSurface: null, memoryRefs: [], hereAndNow: null, thisTurnFacts: null,
    factSpans: null, conversationSummary: null, personaProfileRevision: 0,
    personaExamplesRevision: 0, defaultExpressionVersion: "test", petProfile: null,
    nextMessageSeq: 2, nextEventSeq: 1 };
}

for (const failure of ["provider_first_output_timeout", "provider_idle_timeout", "unsaved-prose"] as const) {
  test(`note request resumes on the configured fallback after ${failure}, without publishing an unverified save`, async () => {
    const f = await fixture();
    const text = "新建一篇关于秦朝的笔记，并保存成笔记。";
    const served: string[] = [], delivered: string[] = [];
    let searched = false;
    try {
      await f.mutate(tx => tx`UPDATE user_companion_account_state
        SET agent_settings=jsonb_set(agent_settings,'{permissionLevel}','"full"'::jsonb)
        WHERE user_id=${f.event.read.userId}`);
      const fallback: AIProvider = {
        id: "openai_compatible", modelId: "fallback-note-test", visionModelId: "", promptVersion: "test",
        chatCompletion: async () => { throw new Error("a clear note creation must not classify"); },
        executeAgentTurn: async request => {
          served.push("fallback");
          assert.equal(request.messages.filter(message => message.role === "user").length, 1);
          assert.equal(request.messages.find(message => message.role === "user")?.content, text);
          if (!searched) {
            searched = true;
            return { content: null, toolCalls: [{ id: "grounding", name: "companion_notes_read",
              arguments: { action: "search", query: "秦朝", match: "any" } }], finishReason: "tool_calls", usage: null, providerRequestId: null };
          }
          return { content: null, toolCalls: [{ id: "saved-note", name: "companion_notes_write",
            arguments: { action: "create", title: "秦朝", markdown: "秦始皇于公元前221年完成统一，建立秦朝。郡县制加强了中央对地方的管理，统一文字和度量衡促进了交流。沉重的徭役和政治危机又加快了秦朝的衰亡。秦朝虽短暂，仍对后世制度产生了深远影响。", links: [] } }],
            finishReason: "tool_calls", usage: null, providerRequestId: null };
        },
      } as AIProvider;
      const primary: AIProvider = { ...fallback, modelId: "primary-note-test",
        executeAgentTurn: async () => { served.push("primary");
          if (failure === "unsaved-prose") return { content: "秦朝笔记已经保存好了。", toolCalls: [], finishReason: "stop", usage: null, providerRequestId: null };
          throw new CompanionOutputTimeoutError(failure);
        },
      };
      if (failure === "unsaved-prose") {
        primary.chatCompletionStreamToolCalls = true;
        primary.chatCompletionStream = async (_messages, _options, _signal, onDelta) => {
          served.push("primary"); onDelta("秦朝笔记已经保存好了。");
          return { content: "秦朝笔记已经保存好了。", toolCalls: [], finishReason: "stop" };
        };
      }
      const result = await runCompanionAgentLoop({ ctx: f.event.ctx,
        read: { ...readContext(f), userText: text }, provider: primary, fallbackProvider: fallback,
        toolConstraints: { visionEnabled: false }, baseMessages: [{ role: "system", content: "完成保存，以真实回执为准。" }, { role: "user", content: text }],
        onProviderDelta: async delta => { delivered.push(delta); return true; }, expiresAt: new Date(Date.now() + 60_000).toISOString() });
      assert.equal(result.status, "completed");
      assert.deepEqual(served, ["primary", "fallback", "fallback"], "the fallback remains selected and receipts close the request without another model call");
      assert.ok(!delivered.join("").includes("秦朝笔记已经保存好了"), "unverified save prose must never become visible");
      const rows = await f.mutate(tx => tx`SELECT name,status,result_ref FROM companion_agent_tool_calls WHERE run_id=${f.event.read.runId} ORDER BY created_at`);
      assert.equal(rows.filter(row => row.name === "notes.write.create" && row.status === "succeeded").length, 1);
      const notes = await f.mutate(tx => tx`SELECT id FROM notes WHERE workspace_id=${f.event.ctx.workspaceId}`);
      assert.equal(notes.length, 1, "recovery must not duplicate a business write");
      const [checkpoint] = await f.mutate(tx => tx`SELECT runtime_checkpoint FROM companion_agent_steps WHERE run_id=${f.event.read.runId} AND runtime_checkpoint IS NOT NULL ORDER BY step_no DESC LIMIT 1`);
      assert.equal(JSON.parse(checkpoint.runtime_checkpoint.stateJson).state.protocolFallback, true);
      if (result.status === "completed") assert.ok(result.text.includes("已保存 1 篇笔记"));
    } finally { await f.cleanup(); }
  });
}

test("命中输出上限时保留已流出的正文，但不会把半截答案结为成功", async () => {
  const f=await fixture();
  try {
    const provider:AIProvider=new MockProvider();
    const delivered:string[]=[];
    provider.chatCompletion=async()=>({content:JSON.stringify({intent:"conversation",toolUse:"none",
      subjects:[],goalRelation:"unrelated",candidateOperations:[],ambiguities:[],voiceStyle:{decision:"none",instruction:null},pendingOfferIndexes:[]}),usage:{}});
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

/**
 * 2026-10-13 起问题轮也有自己的投机形状：干净的解释（无指称/歧义/候选动作、目标无关）
 * 会保留**提问版**那条流（开思考、完整工具面、无注意力块），闲聊版照旧作废；
 * 用户的等待从"分类器 + 正式第一步"变成"两者取最大"。
 */
test("干净的问题保留提问版投机，闲聊版作废且不再多发一次正式请求", async () => {
  const f=await fixture();
  try {
    const provider:AIProvider=new MockProvider();
    provider.chatCompletionStreamToolCalls = true;
    const modes:Array<boolean|undefined>=[], temperatures:Array<number|undefined>=[], policies:string[]=[], delivered:string[]=[];
    provider.chatCompletion=async()=>({content:JSON.stringify({intent:"question",toolUse:"none",
      subjects:[],goalRelation:"unrelated",candidateOperations:[],ambiguities:[],voiceStyle:{decision:"none",instruction:null},pendingOfferIndexes:[]}),usage:{}});
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
    // 两条投机同时发出（闲聊先建、提问后建），分类落地后只留提问版：没有第三次调用。
    assert.deepEqual(modes,[true,false]);
    assert.deepEqual(temperatures,[0.9,0.3]);
    assert.match(policies[1]!, /方向是否颠倒/);
    assert.doesNotMatch(policies[1]!, /current_turn_interpretation_data/);
    assert.equal(result.status,"completed");
    assert.equal(result.text,"牛顿第二定律说的是：合力等于质量乘加速度。");
    assert.equal(delivered.join(""),result.text);
    // 答案已在手里就不再发「正在思考…」：那条状态会晚于首字，是一句假话。
    const statuses = await f.mutate(tx => tx`SELECT payload->>'status' AS status FROM companion_stream_events
      WHERE run_id=${f.event.read.runId} AND type='assistant.status'`);
    assert.equal(statuses.some(row => row.status === "thinking"), false,
      JSON.stringify(statuses));
  } finally {await f.cleanup();}
});

test("解释带来指称或目标关联时两条投机都作废，正式请求仍看到注意力块", async () => {
  const f=await fixture();
  try {
    const provider:AIProvider=new MockProvider();
    provider.chatCompletionStreamToolCalls = true;
    const prompts:string[]=[], delivered:string[]=[];
    provider.chatCompletion=async()=>({content:JSON.stringify({intent:"question",toolUse:"none",
      subjects:[{description:"那篇笔记",objectIndex:0}],goalRelation:"continue",candidateOperations:[],
      ambiguities:[],voiceStyle:{decision:"none",instruction:null},pendingOfferIndexes:[]}),usage:{}});
    provider.chatCompletionStream=async(_messages,options,_signal,onDelta)=>{
      const prompt=String(_messages[0]?.content);
      prompts.push(prompt);
      // 每条都长于 12 字的流式放行阈值，否则 deliver 不会触发（本用例直接跑循环，没有对话层的尾部补写）。
      const content=prompt.includes("current_turn_interpretation_data") ? "这是带注意力块的正式答案，按规定交付。"
        : options.disableThinking ? "这是应该作废的闲聊猜测。" : "这是没有注意力块的提问版答案。";
      onDelta(content);
      return {content,toolCalls:[],finishReason:"stop"};
    };
    provider.executeAgentTurn=async()=>{throw new Error("无工具请求不需要缓冲重跑");};
    const result=await runCompanionAgentLoop({ctx:f.event.ctx,read:{...readContext(f),userText:"我那篇笔记讲了什么？"},provider,
      toolConstraints:{visionEnabled:false},baseMessages:[{role:"system",content:"解释概念。"},
        {role:"user",content:"我那篇笔记讲了什么？"}],expiresAt:new Date(Date.now()+60000).toISOString(),
      onProviderDelta:async text=>{delivered.push(text);return true;}});
    // 两条投机（闲聊 + 提问版）都被作废，正式第一步带着注意力块发出，只交付它的正文。
    assert.equal(prompts.length,3);
    assert.doesNotMatch(prompts[1]!, /current_turn_interpretation_data/);
    assert.match(prompts[2]!, /current_turn_interpretation_data/);
    assert.equal(result.status,"completed");
    assert.equal(result.text,"这是带注意力块的正式答案，按规定交付。");
    assert.equal(delivered.join(""),result.text);
    // 投机作废时「正在思考…」照发——那时她确实还在想。
    const statuses = await f.mutate(tx => tx`SELECT payload->>'status' AS status FROM companion_stream_events
      WHERE run_id=${f.event.read.runId} AND type='assistant.status'`);
    assert.equal(statuses.some(row => row.status === "thinking"), true, JSON.stringify(statuses));
  } finally {await f.cleanup();}
});

test("旧审校开关不能恢复失败实验，解释直接交付且保留说明性引号",async()=>{
  const f=await fixture(),saved=process.env.COMPANION_EXPLANATION_REVIEW_V1;
  try {
    process.env.COMPANION_EXPLANATION_REVIEW_V1="true";
    const provider:AIProvider=new MockProvider(),delivered:string[]=[],modes:Array<boolean|undefined>=[];
    provider.chatCompletionStreamToolCalls = true;
    let bufferedCalls=0;
    const answer="热量通常从较热物体传给较冷物体。可以把这个过程叫作「物体与环境之间缓慢地传递热量」。";
    provider.chatCompletion=async()=>({content:JSON.stringify({intent:"question",toolUse:"none",subjects:[],
      goalRelation:"unrelated",candidateOperations:[],ambiguities:[],voiceStyle:{decision:"none",instruction:null},pendingOfferIndexes:[]}),usage:{}});
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

test("真实缓存解释中的退休用途字段不再改变思考、采样或正式请求", async () => {
  const f = await fixture();
  const userText = "我还没交呢，写完而已";
  try {
    await f.mutate(tx => tx`UPDATE companion_turn_runs SET turn_interpretation=${tx.json({
      version: 1, requestHash: sha256Utf8V1(userText), intent: "conversation", toolUse: "none",
      subjects: [], goalRelation: "unrelated", goalReference: null, candidateOperations: [],
      ambiguities: [], pendingOfferIndexes: [], status: "interpreted",
      dialogueFrame: { purpose: "correction", evidence: { messageIndex: 0, quote: userText, sourceSha256: sha256Utf8V1(userText) },
        userState: [{ topic: "报告", aspect: "progress", relation: "correction", messageIndex: 0,
          quote: userText, sourceSha256: sha256Utf8V1(userText) }] },
    })} WHERE id=${f.event.read.runId}`);
    const provider: AIProvider = new MockProvider();
    provider.chatCompletionStreamToolCalls = true;
    let classifierCalls = 0;
    const delivered: string[] = [], modes: Array<boolean | undefined> = [], temperatures: Array<number | undefined> = [];
    provider.chatCompletion = async () => { classifierCalls++; throw new Error("缓存命中不重新分类"); };
    provider.executeAgentTurn = async () => { throw new Error("无工具请求走流式正文"); };
    provider.chatCompletionStream = async (messages, options, _signal, onDelta) => {
      modes.push(options.disableThinking);
      temperatures.push(options.temperature);
      assert.doesNotMatch(String(messages[0]?.content), /dialogueFrame|userState/);
      const content = "嗯，写完和交出去确实是两件事。";
      onDelta(content);
      return { content, toolCalls: [], finishReason: "stop" };
    };
    const result = await runCompanionAgentLoop({ ctx: f.event.ctx, read: { ...readContext(f), userText }, provider,
      toolConstraints: { visionEnabled: false }, baseMessages: [{ role: "system", content: "回应本轮原话。" }, { role: "user", content: userText }],
      expiresAt: new Date(Date.now() + 60_000).toISOString(), onProviderDelta: async text => { delivered.push(text); return true; } });
    assert.equal(result.status, "completed");
    assert.equal(delivered.join(""), result.text);
    assert.equal(classifierCalls, 0);
    assert.deepEqual(modes, [true]);
    assert.deepEqual(temperatures, [0.9]);
    const [row] = await f.mutate(tx => tx`SELECT turn_interpretation FROM companion_turn_runs WHERE id=${f.event.read.runId}`);
    assert.equal("dialogueFrame" in row.turn_interpretation, false, "写回现役合同不会把退休字段再存入运行上下文");
  } finally { await f.cleanup(); }
});

test("纯文本创作在真实循环交付长对白，不误入引文纠正或备用模型", async () => {
  const f = await fixture();
  const userText = "写一个关于海边旧灯塔的故事。";
  const answer = "天快黑了，年轻人推开灯塔的门。守灯人说：“等这阵风过去，我们再把灯点亮。”\n\n“你外婆从来不提他。”她母亲说，“我小时候问过一回，她没说话，第二天把我送去镇上念书了。后来我就没再问。”\n\n守灯人留下一张纸条：\n\n> 等这阵风过去，我们再把灯点亮。";
  try {
    const provider: AIProvider = new MockProvider();
    provider.chatCompletionStreamToolCalls = true;
    provider.chatCompletion = async () => ({ content: JSON.stringify({ intent: "task", toolUse: "none",
      subjects: [], goalRelation: "unrelated", candidateOperations: [], ambiguities: [], voiceStyle: { decision: "none", instruction: null }, pendingOfferIndexes: [] }), usage: {} });
    let calls = 0;
    provider.executeAgentTurn = async request => {
      calls += 1;
      assert.ok(request.tools.length > 0, "agent tools remain available even when this answer needs none");
      assert.notEqual(request.toolChoice, "required");
      return { content: answer, toolCalls: [], finishReason: "stop", usage: null, providerRequestId: null };
    };
    const fallback: AIProvider = new MockProvider();
    fallback.executeAgentTurn = async () => { assert.fail("人物对白不应触发备用模型"); };
    const result = await runCompanionAgentLoop({ ctx: f.event.ctx, read: { ...readContext(f), userText }, provider,
      fallbackProvider: fallback, toolConstraints: { visionEnabled: false },
      baseMessages: [{ role: "system", content: "在回复里完成创作。" }, { role: "user", content: userText }],
      expiresAt: new Date(Date.now() + 60_000).toISOString() });
    assert.equal(result.status, "completed");
    assert.equal(result.text, answer);
    assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});

test("已附选区的回复即使无需工具也核对引用块原文", async () => {
  const f = await fixture();
  const userText = "这里原句怎么说的？";
  const selection = "胡克定律仅在弹性限度内适用，超过范围后不能继续套用。";
  const answer = `> ${selection}`;
  try {
    const provider: AIProvider = new MockProvider();
    provider.chatCompletion = async () => ({ content: JSON.stringify({ intent: "question", toolUse: "none",
      subjects: [], goalRelation: "unrelated", candidateOperations: [], ambiguities: [], voiceStyle: { decision: "none", instruction: null }, pendingOfferIndexes: [] }), usage: {} });
    let primaryCalls = 0, fallbackCalls = 0;
    provider.executeAgentTurn = async () => {
      primaryCalls += 1;
      return { content: primaryCalls === 1 ? "> 弹簧总是满足胡克定律，没有任何适用限制。" : answer,
        toolCalls: [], finishReason: "stop", usage: null, providerRequestId: null };
    };
    const fallback: AIProvider = new MockProvider();
    fallback.executeAgentTurn = async () => {
      fallbackCalls += 1;
      return { content: answer, toolCalls: [], finishReason: "stop", usage: null, providerRequestId: null };
    };
    const result = await runCompanionAgentLoop({ ctx: f.event.ctx,
      read: { ...readContext(f), userText, pageContext: { selection: { text: selection, sharing: "user_selected" } } },
      provider, fallbackProvider: fallback, toolConstraints: { visionEnabled: false },
      baseMessages: [{ role: "system", content: `<selection_data>\n${selection}\n</selection_data>` },
        { role: "user", content: userText }], expiresAt: new Date(Date.now() + 60_000).toISOString() });
    assert.equal(result.status, "completed");
    assert.equal(result.text, answer);
    assert.equal(primaryCalls, 2, "选区中不存在的引文触发一次纠正");
    assert.equal(fallbackCalls, 0, "引文纠正沿用现役模型");
  } finally { await f.cleanup(); }
});

test("检索工具返回完整存量记忆，已展开记录按ID避重而非比较80字预览", async () => {
  const f = await fixture();
  const memoryId = randomUUID();
  const content = "以前常用蓝笔记录。".repeat(45) + "最后纠正：现在已改用铅笔，蓝笔只是旧习惯。";
  try {
    await f.mutate(tx => tx`INSERT INTO assistant_memory_items
      (id,workspace_id,user_id,kind,content,scope,candidate,user_confirmed,importance,confidence,embedding_status)
      VALUES (${memoryId},${f.event.ctx.workspaceId},${f.event.read.userId},'episodic',${content},'workspace',false,true,0.9,1,'none')`);
    const event = { ...f.event, read: readContext(f), expiresAt: new Date(Date.now() + 60_000).toISOString(), constraints: { visionEnabled: false } };
    // The memory family keys on internal operation names, exactly as the
    // dispatcher hands them over after resolving `action`.
    const recall = { ...getCompanionAgentTool("companion_memory_read")!, name: "memory.read.recall" };
    const first = await executeCompanionMemoryTool(event, recall, { query: "蓝笔" });
    const memories = (first.value as { memories: Array<{ memoryId: string; revision: number; content: string }> }).memories;
    assert.equal(memories.length, 1);
    assert.equal(memories[0]?.content, content);
    const read = await executeCompanionMemoryTool(event,
      { ...getCompanionAgentTool("companion_memory_read")!, name: "memory.read.read" },
      { memoryId, expectedRevision: memories[0]!.revision });
    assert.equal((read.value as { content: string }).content, content);
    assert.equal(event.read.memoryRefs[0]?.memoryId, memoryId);
    assert.equal(event.read.memoryRefs[0]?.content.length, 80, "UI引用预览的显式合同保持80字，模型已读完整正文");
    const again = await executeCompanionMemoryTool(event, recall, { query: "蓝笔" });
    assert.deepEqual((again.value as { memories: unknown[] }).memories, []);
    const management = await executeCompanionMemoryTool(event, recall, { query: "蓝笔", includeShown: true });
    assert.equal((management.value as { memories: Array<{ content: string }> }).memories[0]?.content, content);
  } finally { await f.cleanup(); }
});

/**
 * 「换模型重说」那条降级链的**接线**（2026-10-16）。
 *
 * 判据本身早就有（`planCompanionStepAfterAnswer` 的 `swapToFallback`，单测钉在
 * `companion-agent-runtime.test.ts:926`），但生产没配 `companion_fallback` 槽，
 * `args.fallbackProvider` 恒为 undefined —— 于是运行时那句"这一步换兜底档"落到
 * `stepProvider = args.provider`，同档把同一句谎再说一遍。这两条盯的是**这一步真的换了 provider**，
 * 而反面对照盯的是"没配兜底槽时仍回主档"，这样判据不会因为缺槽而假绿。
 */
function actionNarrationStub(modelId: string, served: string[], text: string): AIProvider {
  return {
    id: "openai_compatible", modelId,
    chatCompletion: async () => ({ content: JSON.stringify({ intent: "task", toolUse: "act",
      subjects: [], goalRelation: "unrelated", candidateOperations: ["attention.write.save_participation"],
      ambiguities: [], voiceStyle: { decision: "none", instruction: null }, pendingOfferIndexes: [] }), usage: {} }),
    executeAgentTurn: async () => { served.push(modelId);
      return { content: text, toolCalls: [], finishReason: "stop", usage: null, providerRequestId: null }; },
  } as unknown as AIProvider;
}

async function runActionRequestTurn(fallbackConfigured: boolean) {
  const f = await fixture();
  const served: string[] = [];
  try {
    const primary = actionNarrationStub("primary-model", served, "好，我把参与度调成安静些了。");
    const fallback = actionNarrationStub("fallback-model", served, "参与度这次没有改动，我先按原样留着。");
    let status = "";
    try {
      const result = await runCompanionAgentLoop({ ctx: f.event.ctx,
        read: { ...readContext(f), userText: "把参与度改成安静。" }, provider: primary,
        ...(fallbackConfigured ? { fallbackProvider: fallback } : {}),
        toolConstraints: { visionEnabled: false },
        baseMessages: [{ role: "system", content: "按要求执行。" }, { role: "user", content: "把参与度改成安静。" }],
        expiresAt: new Date(Date.now() + 60_000).toISOString() });
      status = result.status;
    } catch (error) {
      // 补的那一步仍然没有落库回执 → 交付闸照旧作废整轮（`destroysTurn = !landedWrites`）。
      // 这条用例盯的是"补的那一步由哪个模型作答"，不是这道闸的取舍。
      if (!(error instanceof AgentOutputError) || error.code !== "action_unverified") throw error;
      status = `action_unverified:${(error as AgentOutputError).code}`;
    }
    return { status, served };
  } finally { await f.cleanup(); }
}

test("判据要求换兜底模型的那一步真的由兜底档作答，不再让主档把同一句话重说一遍", async () => {
  const { status, served } = await runActionRequestTurn(true);
  assert.equal(status, "action_unverified:action_unverified");
  assert.ok(served.length > 1, `补步没跑起来：${JSON.stringify(served)}`);
  assert.equal(served[0], "primary-model", "第一步是主档");
  assert.deepEqual([...new Set(served.slice(1))], ["fallback-model"],
    `说而不做之后补的每一步都必须在兜底档上：${JSON.stringify(served)}`);
});

test("没配兜底槽时那一步仍回主档：反面对照，证明上一条盯的是换档而不是重跑", async () => {
  const { served } = await runActionRequestTurn(false);
  assert.ok(served.length > 1, `补步没跑起来：${JSON.stringify(served)}`);
  assert.deepEqual([...new Set(served)], ["primary-model"],
    "没有兜底档时补步只能重问同一个模型——这正是 2026-10-16 之前的实际形态");
});

test("direct entries keep the original history and complete without classification or speculative drafts", async () => {
  const previous=process.env.COMPANION_AGENT_ENTRY_MODE;
  try {
    for(const mode of ['direct_fast','direct_thinking'] as const){
      process.env.COMPANION_AGENT_ENTRY_MODE=mode;
      const f=await fixture();
      try{
        const provider=new MockProvider();let classifications=0,steps=0;
        provider.chatCompletion=async()=>{classifications++;throw new Error('classifier must not run');};
        const invitation='故事说到两个朋友来到河边。要继续听吗？';
        provider.executeAgentTurn=async request=>{
          steps++;assert.equal(request.disableThinking,mode==='direct_fast');
          assert.ok(request.messages.some(m=>m.role==='assistant'&&m.content===invitation));
          assert.equal(request.toolChoice,'auto');
          return {content:'两个朋友看见一条小船停在岸边，于是坐下来等船夫回来。',toolCalls:[],finishReason:'stop',usage:null,providerRequestId:null};
        };
        const result=await runCompanionAgentLoop({ctx:f.event.ctx,read:{...readContext(f),userText:'继续讲。'},provider,
          toolConstraints:{visionEnabled:false},baseMessages:[{role:'system',content:'接着用户正在听的故事自然回应。'},
            {role:'assistant',content:invitation},{role:'user',content:'继续讲。'}],expiresAt:new Date(Date.now()+60_000).toISOString()});
        assert.equal(result.status,'completed');assert.equal(steps,1);assert.equal(classifications,0);
      } finally{await f.cleanup();}
    }
  } finally{if(previous===undefined)delete process.env.COMPANION_AGENT_ENTRY_MODE;else process.env.COMPANION_AGENT_ENTRY_MODE=previous;}
});

test("direct native voice control persists the durable dialect before the next spoken response", async () => {
  const previous=process.env.COMPANION_AGENT_ENTRY_MODE;process.env.COMPANION_AGENT_ENTRY_MODE='direct_thinking';
  const f=await fixture();
  try{
    const {persistCompanionDialectPreference,readCompanionDialectPreference}=await import('../handlers/turn/companion-voice-preference.ts');
    const {resolveCompanionVoiceInstruction}=await import('../handlers/turn/companion-voice-request-style.ts');
    const provider=new MockProvider();let steps=0;let instruction:string|null=null;
    const userText='以后默认河南话，但这句用四川话。';
    provider.chatCompletion=async()=>{throw new Error('classifier must not run');};
    provider.executeAgentTurn=async request=>{
      steps++;assert.equal(request.disableThinking,false);
      if(steps===1){
        assert.ok(request.tools.some(t=>t.name==='companion_configure_turn'));
        return {content:null,toolCalls:[{id:'voice-control',name:'companion_configure_turn',arguments:{sourceQuote:userText,
          voiceStyle:{decision:'apply',instruction:'请用四川话表达。',persistentPreference:{action:'set',dialect:'河南话'}}}}],finishReason:'tool_calls',usage:null,providerRequestId:null};
      }
      assert.match(instruction??'',/四川话/);
      assert.equal(await readCompanionDialectPreference({workspaceId:f.event.ctx.workspaceId,userId:f.event.read.userId}),'河南话');
      return {content:'好，这一句用四川话，以后默认河南话。',toolCalls:[],finishReason:'stop',usage:null,providerRequestId:null};
    };
    const result=await runCompanionAgentLoop({ctx:f.event.ctx,read:{...readContext(f),userText},provider,
      toolConstraints:{visionEnabled:false},baseMessages:[{role:'system',content:'按当前用户的声音要求表达。'},{role:'user',content:userText}],
      onTurnInterpretation:async attention=>{
        instruction=resolveCompanionVoiceInstruction(userText,attention.voiceStyle).instruction;
        return persistCompanionDialectPreference({workspaceId:f.event.ctx.workspaceId,userId:f.event.read.userId,change:attention.voiceStyle.persistentPreference});
      },expiresAt:new Date(Date.now()+60_000).toISOString()});
    assert.equal(result.status,'completed');assert.equal(steps,2);
  }finally{await f.cleanup();if(previous===undefined)delete process.env.COMPANION_AGENT_ENTRY_MODE;else process.env.COMPANION_AGENT_ENTRY_MODE=previous;}
});

test("direct fast entry honors native deepening and saves the reasoning mode in its checkpoint", async () => {
  const previous=process.env.COMPANION_AGENT_ENTRY_MODE;process.env.COMPANION_AGENT_ENTRY_MODE='direct_fast';
  const f=await fixture();
  try{
    const provider=new MockProvider();const modes:boolean[]=[];
    provider.chatCompletion=async()=>{throw new Error('classifier must not run');};
    provider.executeAgentTurn=async request=>{
      modes.push(request.disableThinking===true);
      if(modes.length===1)return {content:null,toolCalls:[{id:'deepen-control',name:'companion_deepen',arguments:{}}],finishReason:'tool_calls',usage:null,providerRequestId:null};
      assert.equal(request.tools.some(t=>t.name==='companion_deepen'),false);
      return {content:'先检查所有条件，再逐一排除不满足条件的情况，可以得到唯一符合要求的结论。',toolCalls:[],finishReason:'stop',usage:null,providerRequestId:null};
    };
    const result=await runCompanionAgentLoop({ctx:f.event.ctx,read:{...readContext(f),userText:'请严谨分析这个问题。'},provider,
      toolConstraints:{visionEnabled:false},baseMessages:[{role:'system',content:'必要时先深入推理。'},{role:'user',content:'请严谨分析这个问题。'}],expiresAt:new Date(Date.now()+60_000).toISOString()});
    assert.equal(result.status,'completed');assert.deepEqual(modes,[true,false]);
    const [stored]=await f.mutate(tx=>tx`SELECT runtime_checkpoint FROM companion_agent_steps WHERE run_id=${f.event.read.runId} AND runtime_checkpoint IS NOT NULL ORDER BY step_no DESC LIMIT 1`);
    const state=JSON.parse(stored.runtime_checkpoint.stateJson).state;
    assert.equal(state.entryMode,'direct_fast');assert.equal(state.deepened,true);
  }finally{await f.cleanup();if(previous===undefined)delete process.env.COMPANION_AGENT_ENTRY_MODE;else process.env.COMPANION_AGENT_ENTRY_MODE=previous;}
});

test("hybrid conversation streams once without classifying, and settled recovery does not regenerate", async () => {
  const previous=process.env.COMPANION_AGENT_ENTRY_MODE;process.env.COMPANION_AGENT_ENTRY_MODE='hybrid';
  const f=await fixture();
  try{
    const provider:AIProvider=new MockProvider();let streams=0,classifiers=0;const deltas:string[]=[];
    provider.chatCompletionStreamToolCalls=true;
    provider.chatCompletion=async()=>{classifiers++;throw new Error('conversation must not classify');};
    provider.executeAgentTurn=async()=>{throw new Error('prefetched reply must not regenerate');};
    const answer='今天想先歇一歇也很好，我就在这里陪着你，想说点什么都可以。';
    provider.chatCompletionStream=async(_messages,options,_signal,onDelta)=>{
      streams++;assert.equal(options.disableThinking,true);assert.equal(options.tools?.length,0);
      onDelta(JSON.stringify({reply:answer}));
      return {content:JSON.stringify({reply:answer}),toolCalls:[],finishReason:'stop',usage:{}};
    };
    const args={ctx:f.event.ctx,read:{...readContext(f),userText:'先别整理笔记，陪我聊聊。'},provider,
      toolConstraints:{visionEnabled:false},baseMessages:[{role:'system' as const,content:'自然回应用户。'},
        {role:'user' as const,content:'先别整理笔记，陪我聊聊。'}],
      onProviderDelta:async(text:string)=>{deltas.push(text);return true;},expiresAt:new Date(Date.now()+60_000).toISOString()};
    const result=await runCompanionAgentLoop(args);
    assert.equal(result.status,'completed');if(result.status==='completed')assert.equal(result.text,answer);
    assert.equal(deltas.join(''),answer);assert.equal(streams,1);assert.equal(classifiers,0);
    const again=await runCompanionAgentLoop(args);assert.deepEqual(again,result);assert.equal(streams,1);
    const [meta]=await f.mutate(tx=>tx`SELECT route FROM companion_turn_runs WHERE id=${f.event.read.runId}`);
    assert.equal(meta.route.entryMode,'hybrid');assert.equal(meta.route.hybrid.decision,'reply');assert.equal(meta.route.classifier.source,'direct');
  }finally{await f.cleanup();if(previous===undefined)delete process.env.COMPANION_AGENT_ENTRY_MODE;else process.env.COMPANION_AGENT_ENTRY_MODE=previous;}
});

test("hybrid handoff classifies lazily and the host reads actual note facts before answering", async () => {
  const previous=process.env.COMPANION_AGENT_ENTRY_MODE;process.env.COMPANION_AGENT_ENTRY_MODE='hybrid';
  const f=await fixture(),noteId=randomUUID(),versionId=randomUUID();
  try{
    await f.mutate(async tx=>{
      await tx`INSERT INTO notes(id,workspace_id,title,created_by) VALUES(${noteId},${f.event.ctx.workspaceId},'混合入口实测',${f.event.read.userId})`;
      await tx`INSERT INTO note_versions(id,note_id,workspace_id,version_no,content_json,content_hash,created_by)
        VALUES(${versionId},${noteId},${f.event.ctx.workspaceId},1,'{}',${'e'.repeat(64)},${f.event.read.userId})`;
      await tx`UPDATE notes SET current_version_id=${versionId} WHERE id=${noteId}`;
      await tx`INSERT INTO note_blocks(workspace_id,version_id,ordinal,type,content)
        VALUES(${f.event.ctx.workspaceId},${versionId},1,'paragraph','实验组得分72分，对照组61分。')`;
    });
    const provider:AIProvider=new MockProvider();const order:string[]=[];
    provider.chatCompletionStreamToolCalls=true;
    provider.chatCompletion=async()=>{
      order.push('classify');return {content:JSON.stringify({intent:'question',toolUse:'read',subjects:[],goalRelation:'unrelated',
        candidateOperations:['notes.read.read'],ambiguities:[],voiceStyle:{decision:'none',instruction:null,persistentPreference:{action:'keep',dialect:null}},pendingOfferIndexes:[]}),usage:{}};
    };
    provider.chatCompletionStream=async(messages,options,_signal,onDelta)=>{
      if(order.length===0){order.push('handoff');assert.equal(options.disableThinking,true);
        onDelta('{"task":true}');return {content:'{"task":true}',toolCalls:[],finishReason:'stop',usage:{}};}
      order.push('answer');assert.ok(order.includes('classify'));
      assert.ok(messages.some(m=>typeof m.content==='string'&&m.content.includes('<prefetched_note>')&&m.content.includes('72')));
      onDelta('实验组得分72分。');return {content:'实验组得分72分。',toolCalls:[],finishReason:'stop',usage:{}};
    };
    const result=await runCompanionAgentLoop({ctx:f.event.ctx,read:{...readContext(f),userText:'读一下这篇笔记，告诉我实验组得分。',
      pageContext:{version:1,context:{pageKind:'note',noteId,noteVersionId:versionId}}},provider,toolConstraints:{visionEnabled:false},
      baseMessages:[{role:'system',content:'从真实材料作答。'},{role:'user',content:'读一下这篇笔记，告诉我实验组得分。'}],onProviderDelta:async()=>true,expiresAt:new Date(Date.now()+60_000).toISOString()});
    assert.equal(result.status,'completed');if(result.status==='completed')assert.match(result.text,/72/);
    assert.equal(order[0],'handoff');assert.equal(order.at(-1),'answer');
    const [meta]=await f.mutate(tx=>tx`SELECT route FROM companion_turn_runs WHERE id=${f.event.read.runId}`);
    assert.equal(meta.route.hybrid.decision,'task');assert.equal(meta.route.classifier.source,'l2');
  }finally{await f.cleanup();if(previous===undefined)delete process.env.COMPANION_AGENT_ENTRY_MODE;else process.env.COMPANION_AGENT_ENTRY_MODE=previous;}
});

test("hybrid grounds the first reply in the visible note and honors an explicit no-read constraint", async () => {
  const previous=process.env.COMPANION_AGENT_ENTRY_MODE;process.env.COMPANION_AGENT_ENTRY_MODE='hybrid';
  try{
    for(const allowed of [true,false]){
      const f=await fixture(),noteId=randomUUID(),versionId=randomUUID();
      try{
        await f.mutate(async tx=>{
          await tx`INSERT INTO notes(id,workspace_id,title,created_by) VALUES(${noteId},${f.event.ctx.workspaceId},'当前材料',${f.event.read.userId})`;
          await tx`INSERT INTO note_versions(id,note_id,workspace_id,version_no,content_json,content_hash,created_by)
            VALUES(${versionId},${noteId},${f.event.ctx.workspaceId},1,'{}',${'f'.repeat(64)},${f.event.read.userId})`;
          await tx`UPDATE notes SET current_version_id=${versionId} WHERE id=${noteId}`;
          await tx`INSERT INTO note_blocks(workspace_id,version_id,ordinal,type,content) VALUES(${f.event.ctx.workspaceId},${versionId},1,'paragraph','实验组得分72分。')`;
        });
        const provider:AIProvider=new MockProvider();let calls=0;
        provider.chatCompletion=async()=>{throw new Error('grounded reply must not classify');};
        provider.chatCompletionStream=async(messages,_options,_signal,onDelta)=>{
          calls++;const loaded=messages.some(m=>typeof m.content==='string'&&m.content.includes('<prefetched_note>')&&m.content.includes('72'));
          assert.equal(loaded,allowed);
          const content=JSON.stringify({reply:allowed?'实验组得分72分。':'那我们先不读笔记，聊聊天吧。'});
          onDelta(content);return {content,toolCalls:[],finishReason:'stop',usage:{}};
        };
        const result=await runCompanionAgentLoop({ctx:f.event.ctx,read:{...readContext(f),userText:allowed?'实验组得了多少分？':'先不要读取笔记，陪我聊聊天。',
          pageContext:{version:1,context:{pageKind:'note',noteId,noteVersionId:versionId}}},provider,
          toolConstraints:{visionEnabled:false,noteLibraryReadEnabled:allowed},baseMessages:[{role:'system',content:'按真实材料回答，尊重不读的要求。'},
            {role:'user',content:allowed?'实验组得了多少分？':'先不要读取笔记，陪我聊聊天。'}],onProviderDelta:async()=>true,expiresAt:new Date(Date.now()+60_000).toISOString()});
        assert.equal(result.status,'completed');assert.equal(calls,1);
      }finally{await f.cleanup();}
    }
  }finally{if(previous===undefined)delete process.env.COMPANION_AGENT_ENTRY_MODE;else process.env.COMPANION_AGENT_ENTRY_MODE=previous;}
});

test("hybrid partial note context returns to the classified path before fast publication", async () => {
  const previous=process.env.COMPANION_AGENT_ENTRY_MODE;process.env.COMPANION_AGENT_ENTRY_MODE='hybrid';
  const f=await fixture(),noteId=randomUUID(),versionId=randomUUID();
  try{
    await f.mutate(async tx=>{
      await tx`INSERT INTO notes(id,workspace_id,title,created_by) VALUES(${noteId},${f.event.ctx.workspaceId},'长笔记',${f.event.read.userId})`;
      await tx`INSERT INTO note_versions(id,note_id,workspace_id,version_no,content_json,content_hash,created_by)
        VALUES(${versionId},${noteId},${f.event.ctx.workspaceId},1,'{}',${'a'.repeat(64)},${f.event.read.userId})`;
      await tx`UPDATE notes SET current_version_id=${versionId} WHERE id=${noteId}`;
      await tx`INSERT INTO note_blocks(workspace_id,version_id,ordinal,type,content) VALUES(${f.event.ctx.workspaceId},${versionId},1,'paragraph',${'背景材料'.repeat(1000)+'实验组得分72分。'})`;
    });
    const provider:AIProvider=new MockProvider();let classified=false;
    provider.chatCompletion=async()=>{classified=true;return {content:JSON.stringify({intent:'conversation',toolUse:'none',subjects:[],goalRelation:'unrelated',candidateOperations:[],ambiguities:[],pendingOfferIndexes:[]}),usage:{}};};
    provider.chatCompletionStream=async(_messages,options,_signal,onDelta)=>{
      assert.equal(classified,true);assert.equal(options.responseFormat,'text');
      const content='好，笔记先放一边，我们轻松聊聊天。';onDelta(content);return {content,toolCalls:[],finishReason:'stop',usage:{}};
    };
    const result=await runCompanionAgentLoop({ctx:f.event.ctx,read:{...readContext(f),userText:'今天有点累，轻松聊聊。',
      pageContext:{version:1,context:{pageKind:'note',noteId,noteVersionId:versionId}}},provider,toolConstraints:{visionEnabled:false},
      baseMessages:[{role:'system',content:'按当前请求回应。'},{role:'user',content:'今天有点累，轻松聊聊。'}],onProviderDelta:async()=>true,expiresAt:new Date(Date.now()+60_000).toISOString()});
    assert.equal(result.status,'completed');assert.equal(classified,true);
  }finally{await f.cleanup();if(previous===undefined)delete process.env.COMPANION_AGENT_ENTRY_MODE;else process.env.COMPANION_AGENT_ENTRY_MODE=previous;}
});

test("live direct entries use governed real models with isolated database tools", { skip:process.env.ENTRY_LIVE_REAL!=='1' },async t=>{
  const previous=process.env.COMPANION_AGENT_ENTRY_MODE;
  const observations:Record<string,unknown>[]=[];
  const {resolveAIGovernanceContext,resolveProviderForTask}=await import('../lib/governance.ts');
  const {createProvider}=await import('../lib/ai-provider.ts');
  const {buildCompanionPersonaMessages}=await import('../handlers/turn/companion-dialogue-content.ts');
  const {persistCompanionDialectPreference,readCompanionDialectPreference}=await import('../handlers/turn/companion-voice-preference.ts');
  const {resolveCompanionVoiceInstruction}=await import('../handlers/turn/companion-voice-request-style.ts');
  const {traceProvider}=await import('../../scripts/companion-entry/harness.ts');
  const cases=[
    {name:'thinking-read',mode:'direct_thinking',text:'读取当前笔记，告诉我实验组复习测验的得分。只回答一句话。',read:true},
    {name:'fast-read',mode:'direct_fast',text:'读取当前笔记，告诉我实验组复习测验的得分。只回答一句话。',read:true},
    {name:'thinking-voice',mode:'direct_thinking',text:'以后默认河南话，但这句用四川话，只回一句早安问候。',voice:true},
    {name:'fast-deepening',mode:'direct_fast',text:'请先进入深度推理，再证明：从1到20选5个互不相邻的整数，且总和为偶数，共有多少种选法？请给出严谨的计数理由。',deep:true},
    {name:'hybrid-casual',mode:'hybrid',text:'今天有点累，不想做任务，陪我聊两句就好。',casual:true},
    {name:'hybrid-read',mode:'hybrid',text:'对了，这篇里的实验组到底考了多少分呀？看完告诉我就好，不要改。',read:true},
    {name:'hybrid-read-unseen',mode:'hybrid',text:'这篇记录中的实验组测验得分是多少？只告诉我实际记载的得分。',read:93},
    {name:'hybrid-write',mode:'hybrid',text:'把当前笔记中“实验组复习测验得分72分”改为“实验组复习测验得分75分”，其他内容保持原样，保存后简单告诉我。',read:true,edit:true},
    {name:'hybrid-voice',mode:'hybrid',text:'以后默认河南话，但这句用四川话，只回一句早安问候。',voice:true},
  ] as const;
  try{
    for(const scenario of cases.filter(c=>!process.env.ENTRY_LIVE_CASES||process.env.ENTRY_LIVE_CASES.split(',').includes(c.name)))await t.test(`live direct ${scenario.name}`,async()=>{
      process.env.COMPANION_AGENT_ENTRY_MODE=scenario.mode;
      const f=await fixture(),noteId=randomUUID(),versionId=randomUUID();const started=performance.now();
      const traces:Parameters<typeof traceProvider>[2]=[];
      const controller=new AbortController();
      const timeout=setTimeout(()=>controller.abort(new Error('Live entry scenario exceeded 180 seconds')),180_000);
      let instruction:string|null=null,firstPublished:number|null=null,earlyVoice=false,prefetched=false;
      try{
        await f.mutate(async tx=>{
          await tx`INSERT INTO user_ai_settings(user_id,consent_version,consent_at,data_policy)
            VALUES(${f.event.read.userId},'entry-synthetic-test',now(),${tx.json({sendToExternal:true,sendImageContent:false,piiDetection:false,auditLogging:true})})`;
          if('read' in scenario){
            if('edit' in scenario)await tx`UPDATE companion_turn_runs SET permission_level='full' WHERE id=${f.event.read.runId}`;
            await tx`INSERT INTO notes(id,workspace_id,title,created_by) VALUES(${noteId},${f.event.ctx.workspaceId},'间隔复习实验',${f.event.read.userId})`;
            await tx`INSERT INTO note_versions(id,note_id,workspace_id,version_no,content_json,content_hash,created_by)
              VALUES(${versionId},${noteId},${f.event.ctx.workspaceId},1,'{}',${'d'.repeat(64)},${f.event.read.userId})`;
            await tx`UPDATE notes SET current_version_id=${versionId} WHERE id=${noteId}`;
            await tx`INSERT INTO note_blocks(workspace_id,version_id,ordinal,type,content)
              VALUES(${f.event.ctx.workspaceId},${versionId},1,'paragraph',${`实验组复习测验得分${typeof scenario.read==='number'?scenario.read:72}分，对照组得分61分。`})`;
          }
        });
        const pageContext='read' in scenario?{version:1,context:{pageKind:'note',noteId,noteVersionId:versionId,contextRevision:'entry-live-test'}}:null;
        if(pageContext)await f.mutate(tx=>tx`UPDATE companion_turn_runs SET page_context=${tx.json(pageContext)} WHERE id=${f.event.read.runId}`);
        const gov=await resolveAIGovernanceContext(f.event.ctx.workspaceId,f.event.read.userId);
        assert.equal(gov.consentOk,true);
        const slot=resolveProviderForTask(gov,'companion_agent');assert.notEqual(slot.providerName,'mock');
        const governed=createGovernedProvider(createProvider(slot.providerName,{...slot.providerConfig,sessionId:`entry-live-${f.event.read.runId}`}),gov,f.event.ctx.workspaceId,
          {userId:f.event.read.userId,jobId:f.event.ctx.id,operation:'companion_entry_live',dataCategories:['user_answer']});
        const traced=traceProvider(governed,started,traces);
        const provider=new Proxy(traced,{get(target,key){
          if(key==='chatCompletionStream')return async(...args:Parameters<NonNullable<AIProvider['chatCompletionStream']>>)=>{
            prefetched ||= args[0].some(m=>typeof m.content==='string'&&m.content.includes('<prefetched_note>'));
            return target.chatCompletionStream!(...args);
          };
          const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
        }});
        const result=await runCompanionAgentLoop({ctx:{...f.event.ctx,signal:controller.signal},read:{...readContext(f),userText:scenario.text,pageContext},provider,
          toolConstraints:{visionEnabled:false},baseMessages:buildCompanionPersonaMessages({userText:scenario.text,recentMessages:[],pageContext}),
          onProviderDelta:async text=>{if(text.trim()){
            firstPublished??=performance.now()-started;
            if('voice' in scenario&&!instruction?.includes('四川话'))earlyVoice=true;
          }return true;},
          onTurnInterpretation:async attention=>{
            instruction=resolveCompanionVoiceInstruction(scenario.text,attention.voiceStyle).instruction;
            return persistCompanionDialectPreference({workspaceId:f.event.ctx.workspaceId,userId:f.event.read.userId,change:attention.voiceStyle.persistentPreference});
          },expiresAt:new Date(Date.now()+180_000).toISOString()});
        const calls=await f.mutate(tx=>tx`SELECT name,status FROM companion_agent_tool_calls WHERE run_id=${f.event.read.runId}`);
        const [meta]=await f.mutate(tx=>tx`SELECT route,model_call_count,turn_interpretation FROM companion_turn_runs WHERE id=${f.event.read.runId}`);
        observations.push({case:scenario.name,status:result.status,text:result.status==='completed'?result.text:null,firstPublished,elapsedMs:performance.now()-started,calls,route:meta.route,modelCalls:meta.model_call_count,traces,instruction,earlyVoice,prefetched});
        assert.equal(result.status,'completed');
        if(scenario.mode!=='hybrid'){assert.equal(meta.route.classifier.source,'direct');assert.equal(traces.filter(c=>c.kind==='classifier').length,0);}
        if('casual' in scenario){assert.equal(meta.route.hybrid.decision,'reply');assert.equal(traces.filter(c=>c.kind==='classifier').length,0);assert.equal(traces.length,1);}
        if('read' in scenario){
          assert.ok(calls.some(c=>c.name==='companion_notes_read'&&c.status==='succeeded')||(scenario.mode==='hybrid'&&prefetched));
          if(result.status==='completed')assert.match(result.text,'edit' in scenario?/75|七十五/:typeof scenario.read==='number'?/93|九十三/:/72|七十二/);
          if('edit' in scenario){
            assert.ok(calls.some(c=>c.name==='companion_notes_write'&&c.status==='succeeded'));
            const blocks=await f.mutate(tx=>tx`SELECT b.content FROM note_blocks b JOIN notes n ON n.current_version_id=b.version_id WHERE n.id=${noteId} ORDER BY b.ordinal`);
            const saved=blocks.map(b=>b.content).join('\n');assert.match(saved,/75/);assert.match(saved,/61/);assert.doesNotMatch(saved,/72/);
          }
        }
        if('voice' in scenario){
          assert.match(instruction??'',/四川话/);assert.equal(earlyVoice,false);
          assert.equal(await readCompanionDialectPreference({workspaceId:f.event.ctx.workspaceId,userId:f.event.read.userId}),'河南话');
        }
        if('deep' in scenario)assert.ok(traces.some(c=>c.kind==='generation'&&c.disableThinking===false));
      }catch(err){observations.push({case:scenario.name,error:err instanceof Error?err.message:'unknown',traces,elapsedMs:performance.now()-started});throw err;}
      finally{clearTimeout(timeout);controller.abort();await f.cleanup();if(process.env.ENTRY_LIVE_OUT)writeFileSync(process.env.ENTRY_LIVE_OUT,JSON.stringify(observations,null,2));}
    });
  }finally{if(previous===undefined)delete process.env.COMPANION_AGENT_ENTRY_MODE;else process.env.COMPANION_AGENT_ENTRY_MODE=previous;}
});
