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
import { AgentOutputError } from "../lib/non-retryable-errors.ts";
import { sha256Utf8V1 } from "@astella/shared/content-hash";
import { getCompanionAgentTool } from "@astella/shared";
import { executeCompanionMemoryTool } from "../handlers/companion-memory-tools.ts";

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
    recentMessages: [], residentMemories: [], memoryDirectory: [], playbookCatalog: [], playbookCandidates: [], deliveryObservation: null,
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

test("旧审校开关不能恢复失败实验，解释直接交付且保留说明性引号",async()=>{
  const f=await fixture(),saved=process.env.COMPANION_EXPLANATION_REVIEW_V1;
  try {
    process.env.COMPANION_EXPLANATION_REVIEW_V1="true";
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
    provider.chatCompletion = async () => ({ content: JSON.stringify({ intent: "task", toolUse: "none",
      subjects: [], goalRelation: "unrelated", candidateOperations: [], ambiguities: [], pendingOfferIndexes: [] }), usage: {} });
    let calls = 0;
    provider.executeAgentTurn = async request => {
      calls += 1;
      assert.equal(request.tools.length, 0);
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
      subjects: [], goalRelation: "unrelated", candidateOperations: [], ambiguities: [], pendingOfferIndexes: [] }), usage: {} });
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
    const recall = getCompanionAgentTool("companion_recall_memory")!;
    const first = await executeCompanionMemoryTool(event, recall, { query: "蓝笔" });
    const memories = (first.value as { memories: Array<{ memoryId: string; revision: number; content: string }> }).memories;
    assert.equal(memories.length, 1);
    assert.equal(memories[0]?.content, content);
    const read = await executeCompanionMemoryTool(event, getCompanionAgentTool("companion_read_memory")!,
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
