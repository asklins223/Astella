/** Real-provider acceptance on a disposable DB. Focus=refine explicitly uses an
 * offline domain fixture before exercising the actual API/LLM rewrite and check. */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import postgres from "postgres";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";
import { agentStore, agentStorePorts } from "../src/agent/store.ts";
import { createAgentMethodStore } from "@ailearn/agent-host";
import { markAgentAdvanceFailed, runAgentAdvance } from "../src/agent/advance.ts";
import { runCompanionDialogue } from "../src/handlers/companion-dialogue.ts";
import { runNoteOverviewGenerate } from "../src/handlers/note-overview-generate.ts";
import { runNoteDynamicArtifactGenerate } from "../src/handlers/note-dynamic-artifact-generate.ts";
import { NoteDynamicArtifactOutputError } from "../src/lib/non-retryable-errors.ts";
import { runNoteExpansionGenerate } from "../src/handlers/note-expansion-generate.ts";
import { runCompanionMemoryExtract } from "../src/handlers/companion-memory-extractor.ts";
import { runCompanionMemoryEmbeddingRebuild } from "../src/handlers/companion-memory-embedding.ts";
import { runCompanionSummarizer } from "../src/handlers/companion-summarizer.ts";
import { wipeCardGenerationFixtures, assertFixtureWipeClean } from "../src/integration-tests/card-generation-fixture-cleanup.ts";
import { claimJobs, markJobSucceeded, markJobDead } from "../src/queue.ts";
import { claimV2OutboxJobs, completeV2OutboxJob } from "../src/card-generation-v2/outbox-queue.ts";
import { processV2OutboxJob } from "../src/handlers/card-generation-v2-handler.ts";
import { cardGenerationV3LlmRequested, processCardGenerationSimplifiedJob } from "../src/card-generation-v3/handler.ts";
import { createDeterministicCardGenerateV3Provider, createDeterministicCardContentCheckV3Provider,
  createDeterministicCardCandidateRewriteV3Provider } from "../src/card-generation-v3/deterministic.ts";
import { createGovernedProvider, resolveAIGovernanceContext, resolveProviderForTask } from "../src/lib/governance.ts";
import { createProvider } from "../src/lib/ai-provider.ts";
import { basicAgentCapabilityManifest } from "@ailearn/shared/agent-capabilities";
import { closeDatabase } from "../src/db.ts";
import { ensureCompanionInbox } from "../../../apps/api/src/modules/companion-conversation/turn/companion-conversations-service.ts";
import { createCompanionTurn } from "../../../apps/api/src/modules/companion-conversation/turn/turn-service.ts";
import { decideCompanionProposal } from "../../../apps/api/src/modules/companion-conversation/learning-action-bridge.ts";
import { closeDatabase as closeApiDatabase, withWorkspaceTransaction } from "../../../apps/api/src/db/client.ts";
import { upsertMemory, archiveMemory, restoreMemory, moveMemoryBudgetTier } from "../../../apps/api/src/modules/companion-conversation/memory/memory-service.ts";
import { handleCandidateActionV2 } from "../../../apps/api/src/modules/card-generation-v2/candidate-review-service.ts";
import { createGenerationRunV2 } from "../../../apps/api/src/modules/card-generation-v2/generation-run-service.ts";

assert.equal(process.env.REAL_MODEL_BATCH,"1","Real provider execution must be explicit");
if (["all", "methods", "cards", "demo_cards", "rewrite", "refine"].includes(process.env.PROBE_FOCUS ?? "all"))
  assert.ok(cardGenerationV3LlmRequested(), "Real acceptance must explicitly use the V3 LLM card pipeline, not the offline deterministic default");
const admin=postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"),{max:2});
const userId=randomUUID(),workspaceId=randomUUID(),scope={userId,workspaceId};
const cases:Record<string,unknown>[]=[];
const jobFailures:Array<{type:string;code:string;message:string}>=[];
const focus=process.env.PROBE_FOCUS??"all";
if(focus==="adaptation_comparison") {
  // Both arms use the same runtime flags. Only this one confirmed preference's
  // real archive/restore state changes; unrelated maintenance is kept off.
  process.env.COMPANION_MEMORY_VECTOR_V1="true";
  process.env.COMPANION_MEMORY_EXTRACTOR_V1="false";
  process.env.COMPANION_SUMMARIZER_V1="false";
}
const suffix=focus==="adaptation_comparison"&&process.env.PROBE_COMPARISON_RECHECK==="1"?"adaptation_comparison-recheck":focus==="all"?"path":focus;
const output=new URL(`../../../outputs/agent-42-implementation/real-${suffix}-results.json`,import.meta.url);
const handlers={agent_run_advance:runAgentAdvance,companion_agent:runCompanionDialogue,note_overview_generate:runNoteOverviewGenerate,
  note_dynamic_artifact_generate:runNoteDynamicArtifactGenerate,note_expansion_generate:runNoteExpansionGenerate,
  companion_memory_extract:runCompanionMemoryExtract,companion_memory_embedding_rebuild:runCompanionMemoryEmbeddingRebuild,companion_summarizer:runCompanionSummarizer};
async function drainUntil(done:()=>Promise<boolean>,timeoutMs=300_000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    if(await done())return;
    const [jobs,outbox]=await Promise.all([
      claimJobs(undefined,{interactiveLimit:3,backgroundLimit:3}),claimV2OutboxJobs(1),
    ]);
    for(const job of jobs)assert.equal(job.workspaceId,workspaceId,"Never process another validation fixture's jobs");
    for(const job of outbox)assert.equal(job.workspaceId,workspaceId,"Never process another validation fixture's card outbox");
    // Both production queues have independent consumers. Do not hold a ready
    // overview behind a slow card call in the acceptance runner.
    const processed=await Promise.allSettled([...jobs.map(async job=>{
      const handler=handlers[job.type as keyof typeof handlers];
      if(!handler){await markJobDead(job,"Unsupported probe job");return;}
      console.log(JSON.stringify({event:"job",type:job.type}));
      const signal=AbortSignal.timeout(180_000);
      try{await handler({...job,signal});await markJobSucceeded(job);}catch(error){
        const failure={type:job.type,code:(error as {code?:string}).code??(error as Error).name,message:(error as Error).message};
        jobFailures.push(failure);console.log(JSON.stringify({event:"job_failed",...failure}));
        await markJobDead(job,"Real acceptance handler failed");
        if(job.type==="agent_run_advance")await markAgentAdvanceFailed(job);
        else if(!(error instanceof NoteDynamicArtifactOutputError))throw error;
      }
    }),...outbox.map(job=>processV2OutboxJob(job))]);
    for(const result of processed)if(result.status==="rejected")throw result.reason;
    if(!jobs.length&&!outbox.length)await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error("Real path did not settle within acceptance deadline");
}
async function goalCase(name:string,goal:string,inputs:Parameters<typeof agentStore.create>[1]["inputs"]=[]){
  const start=Date.now();const created=await agentStore.create(scope,{requestId:randomUUID(),goal,inputs});
  const acceptedMs=Date.now()-start;
  await drainUntil(async()=>["completed","failed","cancelled","paused"].includes((await agentStore.get(scope,created.runId)).status));
  const result=await agentStore.get(scope,created.runId);
  const [row]=await admin`SELECT messages FROM agent_runs WHERE id=${result.runId}`;
  const messages=row.messages as Array<{role:string;content:unknown;toolCallId?:string;toolCalls?:Array<{id:string;name:string;arguments:Record<string,unknown>}>}>;
  const calls=messages.flatMap(message=>message.toolCalls?.map(call=>call.name)??[]);
  const entry={name,status:result.status,elapsedMs:Date.now()-start,modelCalls:result.modelCalls,tools:calls,
    artifacts:result.artifacts.map(artifact=>artifact.kind),summary:result.summary,error:result.error,
    receipts:messages.filter(message=>message.role==="tool").map(message=>({callId:message.toolCallId,result:typeof message.content==="string"?JSON.parse(message.content):message.content})),
    arguments:messages.flatMap(message=>message.toolCalls??[])};
  const audits=await admin`SELECT operation,provider,model_id,status,cost_tokens,duration_ms FROM ai_audit_log
    WHERE workspace_id=${workspaceId} AND created_at>=${new Date(start)} ORDER BY created_at`;
  const cardRuns=await admin`SELECT c.id,c.status,c.error_code,c.error_message FROM card_generation_runs_v2 c
    JOIN agent_operations o ON o.card_generation_run_id=c.id WHERE o.run_id=${result.runId} AND c.workspace_id=${workspaceId}`;
  const cardRunIds=cardRuns.map(run=>run.id);
  const candidates=cardRunIds.length?await admin`SELECT run_id,candidate_id,revision,plan_objective_local_id,
    objective_draft,presentation_draft,hints,quality_state,review_decision,publish_state
    FROM card_generation_candidates_v2 WHERE workspace_id=${workspaceId} AND run_id IN ${admin(cardRunIds)}
    ORDER BY run_id,candidate_id,revision`:[];
  const cardEvents=cardRunIds.length?await admin`SELECT run_id,event_type,payload FROM card_generation_events_v2
    WHERE workspace_id=${workspaceId} AND run_id IN ${admin(cardRunIds)} ORDER BY run_id,event_seq`:[];
  const overviewIds=result.artifacts.filter(artifact=>artifact.kind==="note_overview").map(artifact=>artifact.id);
  const overviews=overviewIds.length?await admin`SELECT id,note_id,note_version_id,body,source_references FROM note_overviews
    WHERE workspace_id=${workspaceId} AND id IN ${admin(overviewIds)}`:[];
  const demoIds=result.artifacts.filter(artifact=>artifact.kind==="note_dynamic_artifact").map(artifact=>artifact.id);
  const demos=demoIds.length?await admin`SELECT id,note_id,note_version_id,title,subject,caution,outline_json,html FROM note_learning_artifacts
    WHERE workspace_id=${workspaceId} AND id IN ${admin(demoIds)}`:[];
  Object.assign(entry,{audits,candidates,cardEvents,cardRuns,overviews,demos,timingSource:"Disposable DB runner; not native UI latency"});
  const steps=await admin`SELECT ordinal,context_snapshot,created_at FROM agent_run_steps WHERE run_id=${result.runId} ORDER BY ordinal`;
  const artifactEvents=await admin`SELECT e.created_at FROM agent_run_events e JOIN agent_operations o ON o.id=e.operation_id
    WHERE e.run_id=${result.runId} AND e.execution_status='succeeded' AND o.result->>'kind'='artifact' ORDER BY e.created_at LIMIT 1`;
  const elapsedFrom=(value:Date|string)=>new Date(value).getTime()-start;
  Object.assign(entry,{timings:{acceptedMs,firstStepPersistedMs:steps[0]?elapsedFrom(steps[0].created_at):null,
    firstArtifactMs:artifactEvents[0]?elapsedFrom(artifactEvents[0].created_at):null,terminalCommittedMs:elapsedFrom(result.updatedAt)},
    requests:steps.map(step=>({ordinal:step.ordinal,systemChars:step.context_snapshot.systemPrompt.length,
    toolDefinitionChars:JSON.stringify(step.context_snapshot.tools).length,maxTokens:step.context_snapshot.maxTokens,
    offeredTools:step.context_snapshot.tools.map((tool:{name:string})=>tool.name),roles:step.context_snapshot.messages.map((message:{role:string})=>message.role),
    userTexts:step.context_snapshot.messages.filter((message:{role:string})=>message.role==='user').map((message:{content:string})=>message.content)}))});
  cases.push(entry);await writeFile(output,JSON.stringify({version:1,cases},null,2));
  console.log(JSON.stringify({...entry,demos:demos.map(demo=>({...demo,html:`[${demo.html.length} characters, preserved in structured evidence]`}))}));
  if(focus!=="benchmark")assert.equal(result.status,"completed",`${name} must actually finish`);
  if(calls.includes("card_generation_generate")){
    const cardAudits=audits.filter(audit=>audit.operation==="card_generation_v3:chat_completion");
    assert.ok(cardAudits.some(audit=>audit.status==="success"&&audit.provider!=="mock"),"A real card call audit is required, not a reserved budget counter");
    assert.ok(cardRunIds.length>0&&candidates.length>0,"These learnable fixtures must deliver actual candidate content");
    assert.ok(candidates.some(candidate=>candidate.quality_state==="passed"),"At least one candidate must pass the actual content check");
    assert.ok(candidates.every(candidate=>candidate.review_decision==="undecided"&&candidate.publish_state==="unpublished"),"User approval remains pending for every card revision");
    const [published]=await admin`SELECT count(*)::int n FROM learning_cards_v2 WHERE workspace_id=${workspaceId}`;
    assert.equal(published.n,0,"Preparing candidates must not activate learning cards");
  }
  return {result,calls};
}
try{
  const [before]=await admin`SELECT count(*)::int n FROM jobs WHERE status IN ('pending','running')`;
  assert.equal(before.n,0,"Start with an empty disposable queue");
  await admin.begin(async tx=>{
    await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${userId},${`agent42-live-${userId}@test.invalid`},'fixture','owner')`;
    await tx`INSERT INTO workspaces(id,name,owner_id) VALUES(${workspaceId},'方案42真实路径验收',${userId})`;
    await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
    await tx`INSERT INTO user_companion_account_state(user_id,global_enabled) VALUES(${userId},true)`;
    await tx`INSERT INTO user_ai_settings(user_id,consent_at,consent_version,data_policy) VALUES(${userId},now(),'acceptance-public-material',
      ${tx.json({sendToExternal:true,sendImageContent:true,piiDetection:true,auditLogging:true})})`;
  });
  const governance=await resolveAIGovernanceContext(workspaceId,userId),selected=resolveProviderForTask(governance,"companion_agent");
  assert.notEqual(selected.providerName,"mock","Acceptance must use the configured real provider");
  console.log(JSON.stringify({event:"provider",provider:selected.providerName,model:selected.providerConfig.model}));
  if(process.env.PROBE_DIAGNOSTIC==='1'){
    const provider=createGovernedProvider(createProvider(selected.providerName,selected.providerConfig),governance,workspaceId,{userId,operation:'agent_diagnostic',dataCategories:['user_answer']});
    for(const [name,systemPrompt,text,tools]of [
      ['minimal-text','按照用户的最新请求回答。','只回答这四个字：春雨落下',[]],
      ['minimal-tool','你是学习助手。需要计算时使用提供的工具，再依据真实结果回答。','请用计算器核对 (12 / 4) * 2。',basicAgentCapabilityManifest.map(item=>({name:item.definition.name,description:item.definition.description,parameters:item.definition.parameters}))],
    ]as const){
      const response=await provider.executeAgentTurn!({role:'companion_agent',systemPrompt,messages:[{role:'user',content:text}],tools:[...tools],toolChoice:'auto',maxTokens:2400,temperature:0.3},AbortSignal.timeout(60000));
      console.log(JSON.stringify({event:'diagnostic',name,response}));
    }
  }else{
  if(focus==="adaptation_comparison") {
    const preference="解释学习材料时，用三句话：先给一个准确的生活类比，再说明公式与单位，最后说明适用边界；不加标题或清单，总长不超过160字。仅在没有当前相反要求时适用，闲聊不用。";
    const memory=await withWorkspaceTransaction(scope,async tx=>{
      const created=await upsertMemory(tx,scope,{kind:"preference",content:preference,appliesWhen:"解释学习材料且当次没有要求不同格式",
        userStated:true,candidate:false,scope:"workspace",sourceType:"user_stated",pinned:true});
      const moved=await moveMemoryBudgetTier(tx,scope,{memoryItemId:created.memoryItemId,tier:"resident",actorType:"user",actorId:userId});
      assert.ok(moved.status==="moved"||moved.status==="unchanged");
      return created;
    });
    const prompts=[
      {name:"新材料电容",text:"解释这份新材料，说明公式、单位和适用条件。材料：在线性理想电容模型中 Q=CU；Q 为电荷量，单位库仑 C，C 为电容，单位法拉 F，U 为两端电压，单位伏特 V。同一电容值下电荷量与电压成正比；电介质或几何条件改变时不能沿用原电容值。不要生成或保存其他内容。"},
      {name:"新材料弹簧",text:"解释这份新材料，说明公式、单位和适用条件。材料：胡克定律描述弹性限度内弹簧的弹力大小 F=kx；F 单位牛顿 N，k 单位牛顿每米 N/m，x 是相对原长的形变量，单位米 m。力的方向与形变方向相反，大小式不表示方向；超出弹性限度不能直接使用。不要生成或保存其他内容。"},
      {name:"当前明确例外",text:"这次用标题和清单详细解释下列材料，不用生活类比，也不要保存这个临时要求。材料：在线性理想电容模型中 Q=CU；Q 单位库仑 C，C 单位法拉 F，U 单位伏特 V；电介质或几何条件改变时不能沿用原电容值。请逐项解释符号、单位和适用边界。"},
      {name:"家常不套学习格式",text:"今天晚饭吃了热乎乎的面，还遇见一只懒洋洋的小猫，心情好多了。"},
    ];
    for(const [index,prompt] of prompts.entries()) {
      if(process.env.PROBE_COMPARISON_RECHECK==="1"&&prompt.name!=="新材料弹簧")continue;
      // Alternate order across pairs rather than always giving one arm the
      // first request. A fresh disposable inbox removes prior-answer leakage.
      for(const enabled of index%2===0?[false,true]:[true,false]) {
        const changed=await withWorkspaceTransaction(scope,tx=>(enabled?restoreMemory:archiveMemory)(tx,scope,memory.memoryItemId));
        assert.ok(changed);assert.equal(changed.archived,!enabled);
        await admin`UPDATE companion_conversations SET status='archived' WHERE workspace_id=${workspaceId} AND user_id=${userId} AND status='active'`;
        const inbox=await ensureCompanionInbox(scope),conversationId=String(inbox.body.id);
        const start=Date.now();
        const turn=await createCompanionTurn({...scope,conversationId,idempotencyKey:randomUUID(),body:{version:1,
          clientMessageId:randomUUID(),inputKind:"text",sourceSurface:"pet",blocks:[{type:"text",text:prompt.text}]}});
        const turnRun=String((turn.body as {runId:string}).runId);
        await drainUntil(async()=>{const[row]=await admin`SELECT status FROM companion_turn_runs WHERE id=${turnRun}`;
          return ['succeeded','failed','cancelled','superseded','waiting_for_confirmation'].includes(row.status);});
        const [state]=await admin`SELECT status,model_call_count,tool_call_count,persona_profile_revision FROM companion_turn_runs WHERE id=${turnRun}`;
        const messages=await admin`SELECT blocks FROM companion_messages WHERE conversation_id=${conversationId} AND role='assistant' AND run_id=${turnRun} ORDER BY seq`;
        const tools=await admin`SELECT name AS tool_name,status FROM companion_agent_tool_calls WHERE run_id=${turnRun} ORDER BY created_at`;
        const [handoff]=await admin`SELECT snapshot FROM companion_context_handoff_snapshots WHERE run_id=${turnRun}`;
        const snapshot=handoff?.snapshot as {historyTail:unknown[];memoryRefs:Array<{memoryId:string}>;modelMessages:Array<{role:string;content:string}>};
        const audits=await admin`SELECT operation,provider,model_id,status,cost_tokens,duration_ms FROM ai_audit_log
          WHERE workspace_id=${workspaceId} AND created_at>=${new Date(start)} ORDER BY created_at`;
        const reply=messages.flatMap(message=>(message.blocks as Array<{text?:string}>).map(block=>block.text??"")).join("\n");
        const entry={name:prompt.name,adaptationEnabled:enabled,input:prompt.text,inputSha256:createHash("sha256").update(prompt.text).digest("hex"),
          status:state.status,elapsedMs:Date.now()-start,modelCalls:state.model_call_count,toolCalls:state.tool_call_count,
          personaRevision:state.persona_profile_revision,preference:{memoryId:memory.memoryItemId,revision:changed.revision,archived:changed.archived},
          context:{historyCount:snapshot.historyTail.length,preferenceInjected:snapshot.memoryRefs.some(ref=>ref.memoryId===memory.memoryItemId),
            systemMessageCount:snapshot.modelMessages.filter(message=>message.role==='system').length,
            systemCharacters:snapshot.modelMessages.filter(message=>message.role==='system').reduce((sum,message)=>sum+message.content.length,0)},
          tools,reply,audits,fixtureSetup:"Confirmed preference via actual memory API; fresh inbox is disposable DB isolation, not a product history operation",
          timingSource:"Sequential disposable DB runner; not native UI latency"};
        cases.push(entry);await writeFile(output,JSON.stringify({version:1,cases},null,2));console.log(JSON.stringify(entry));
        assert.equal(state.status,'succeeded');assert.equal(snapshot.historyTail.length,0);
        assert.equal(entry.context.preferenceInjected,enabled);assert.equal(entry.context.systemMessageCount,1);
        assert.ok(audits.some(audit=>audit.status==='success'&&audit.provider!=='mock'));
        assert.ok(!tools.some(tool=>/save_memory|forget_memory|revise_goal|create_goal/.test(tool.tool_name)),"The comparison must not create new adaptation or tasks");
      }
    }
  }
  if(focus==="benchmark"){
    const combined=await goalCase("公开资料与计算组合","请实际读取我给的公开页面 https://example.com ，说明这页的用途；再用计算器核对 12 / 4。把资料来源、阅读范围和计算结果保留在交付摘要，不启动其他生成。");
    if(combined.result.status==="completed"){
      assert.ok(combined.calls.includes("agent_read_public_document")&&combined.calls.includes("agent_calculate"));
      assert.match(combined.result.summary??"",/example\.com/);
    }else assert.equal(combined.result.status,"failed","A failed provider must leave an honest terminal status");
  }
  if(["all","methods","cards","demo_cards","rewrite","refine"].includes(focus)){
  if(focus==="all"){
  const calculated=await goalCase("真实计算","请实际调用计算器核对 (12 / 4) * 2，结果和表达式留在交付摘要中，不生成笔记、演示或卡片。");
  assert.ok(calculated.calls.includes("agent_calculate"));assert.match(calculated.result.summary??"",/6/);
  const document=await goalCase("公开资料与计算组合","请实际读取我给的公开页面 https://example.com ，说明这页的用途；再用计算器核对 12 / 4。把资料来源、阅读范围和计算结果保留在交付摘要，不启动其他生成。");
  assert.ok(document.calls.includes("agent_read_public_document"));assert.ok(document.calls.includes("agent_calculate"));
  assert.match(document.result.summary??"",/example\.com/);
  }
  const noteId=randomUUID(),noteVersionId=randomUUID();
  const paragraphs=["欧姆定律：对温度不变的欧姆导体，电流 I 与两端电压 U 成正比，与电阻 R 成反比，I=U/R。",
    "电压单位伏特 V，电阻单位欧姆 Ω，电流单位安培 A。U=12 V、R=4 Ω 时 I=3 A。电阻不变而电压加倍时电流加倍。",
    "使用欧姆定律要检查导体性质和温度条件。不是所有器件在所有条件下都满足线性关系。"];
  await admin.begin(async tx=>{
    await tx`INSERT INTO notes(id,workspace_id,title,created_by) VALUES(${noteId},${workspaceId},'欧姆定律真实组合验收',${userId})`;
    await tx`INSERT INTO note_versions(id,note_id,workspace_id,version_no,content_json,created_by,content_hash) VALUES(${noteVersionId},${noteId},${workspaceId},1,'{}',${userId},${createHash('sha256').update(paragraphs.join('\n')).digest('hex')})`;
    for(const [index,content]of paragraphs.entries())await tx`INSERT INTO note_blocks(version_id,workspace_id,ordinal,type,content) VALUES(${noteVersionId},${workspaceId},${index+1},'paragraph',${content})`;
    await tx`UPDATE notes SET current_version_id=${noteVersionId} WHERE id=${noteId}`;
  });
  const compound=focus==="refine"?null:await goalCase(
    focus==="demo_cards"?"互动演示与待审核卡片组合":"速看与待审核卡片组合",
    focus==="demo_cards"
      ?"读取这篇欧姆定律笔记，做一个能调电压和电阻、观察电流变化的互动演示，再准备一批待审核学习卡。两份结果都要实际保存，留在对话手记，由我审核卡片；不要生成速看或拓展，不自动收下、激活或安排复习。"
      :"读取这篇欧姆定律笔记，保存一份简洁速看，再准备一批待审核学习卡。两份结果保留在对话手记，由我审核卡片；不要自动收下、激活或安排复习。",[{kind:"note_version",noteId,noteVersionId}]);
  if(compound){
    assert.ok(compound.result.artifacts.some(item=>item.kind===(focus==="demo_cards"?"note_dynamic_artifact":"note_overview")));
    assert.ok(compound.result.operations.some(item=>item.result?.kind==="no_cards_recommended"||item.result?.kind==="artifact"&&item.result.artifact.kind==="card_candidates"));
    if(focus==="demo_cards"){
      assert.ok(compound.calls.includes("note_dynamic_artifact_generate")&&compound.calls.includes("card_generation_generate"));
      assert.ok(!compound.calls.includes("note_overview_generate")&&!compound.calls.includes("note_expansion_generate"));
      const [captured]=cases.slice(-1) as Array<{demos?:Array<{note_id:string;note_version_id:string;html:string}>}>;
      assert.equal(captured.demos?.length,1);
      assert.equal(captured.demos[0].note_id,noteId);assert.equal(captured.demos[0].note_version_id,noteVersionId);
      assert.ok(captured.demos[0].html.length>1000,"A genuine saved renderer document is required");
    }
  }
  let cardRunId=compound?.result.artifacts.find(item=>item.kind==="card_candidates")?.id;
  if(focus==="refine"){
    const key=randomUUID();
    const created=await createGenerationRunV2(scope,noteVersionId,{version:2,noteVersionId,
      sourceScope:{kind:"whole_note"},learningGoal:"understand",detailThreshold:"balanced",quantity:{kind:"adaptive"},clientRequestId:key},key);
    const jobs=await claimV2OutboxJobs(1);
    assert.equal(jobs.length,1);assert.equal(jobs[0].runId,created.runId);assert.equal(jobs[0].workspaceId,workspaceId);
    await processCardGenerationSimplifiedJob(jobs[0],{
      generate:createDeterministicCardGenerateV3Provider(),check:createDeterministicCardContentCheckV3Provider(),
      rewrite:createDeterministicCardCandidateRewriteV3Provider(),
    });
    await completeV2OutboxJob(jobs[0].id,jobs[0].leaseToken);
    const [audit]=await admin`SELECT count(*)::int n FROM ai_audit_log WHERE workspace_id=${workspaceId}`;
    assert.equal(audit.n,0,"Offline bootstrap must never be reported as a real model call");
    cases.push({name:"离线领域夹具准备",providerMode:"deterministic",externalModelCalls:0});
    cardRunId=created.runId;
  }
  if(["rewrite","refine"].includes(focus)){
    assert.ok(cardRunId);
    const [run]=await admin`SELECT card_content_epoch,current_plan_version,review_draft_revision FROM card_generation_runs_v2
      WHERE workspace_id=${workspaceId} AND id=${cardRunId}`;
    const [plan]=await admin`SELECT plan_hash FROM card_generation_plans_v2
      WHERE workspace_id=${workspaceId} AND run_id=${cardRunId} AND plan_version=${run.current_plan_version}`;
    const [before]=await admin`SELECT * FROM card_generation_candidates_v2 WHERE workspace_id=${workspaceId} AND run_id=${cardRunId}
      AND quality_state='passed' AND publish_state='unpublished' AND review_decision='undecided' ORDER BY created_at LIMIT 1`;
    assert.ok(before);
    const start=Date.now();
    await handleCandidateActionV2(scope,{version:2,runId:cardRunId,expectedCardContentEpoch:run.card_content_epoch,
      expectedPlanVersion:run.current_plan_version,expectedPlanHash:plan.plan_hash,expectedReviewDraftRevision:run.review_draft_revision,
      action:{type:"regenerate_candidate",candidateId:before.candidate_id,expectedRevision:before.revision,
        expectedRevisionHash:before.candidate_revision_hash,feedbackReasonCodes:["surface_paraphrase"]}},randomUUID());
    const [queued]=await admin`SELECT id FROM card_generation_run_outbox_v2 WHERE workspace_id=${workspaceId} AND run_id=${cardRunId}
      AND job_type='card_candidate_refine_v3' ORDER BY created_at DESC LIMIT 1`;
    assert.ok(queued);
    await drainUntil(async()=>{
      const [row]=await admin`SELECT status FROM card_generation_run_outbox_v2 WHERE workspace_id=${workspaceId} AND id=${queued.id}`;
      return ["completed","failed"].includes(row.status);
    });
    const [outbox]=await admin`SELECT status,last_error FROM card_generation_run_outbox_v2 WHERE workspace_id=${workspaceId} AND id=${queued.id}`;
    const revisions=await admin`SELECT revision,presentation_draft,objective_draft,quality_state,review_decision,publish_state,derived_from
      FROM card_generation_candidates_v2 WHERE workspace_id=${workspaceId} AND run_id=${cardRunId} AND candidate_id=${before.candidate_id} ORDER BY revision`;
    const audits=await admin`SELECT operation,provider,model_id,status,cost_tokens,duration_ms FROM ai_audit_log
      WHERE workspace_id=${workspaceId} AND created_at>=${new Date(start)} ORDER BY created_at`;
    const entry={name:"审核台请求真实改写",elapsedMs:Date.now()-start,outbox,revisions,audits};
    cases.push(entry);await writeFile(output,JSON.stringify({version:1,cases},null,2));console.log(JSON.stringify(entry));
    assert.equal(outbox.status,"completed","Actual API → rewrite → content check → outbox must complete");
    const latest=revisions.at(-1)!;
    assert.equal(latest.revision,before.revision+1);
    assert.equal(latest.quality_state,"passed");
    assert.equal(latest.review_decision,"undecided");
    assert.equal(latest.publish_state,"unpublished");
    const answer=JSON.stringify(latest.objective_draft.canonicalAnswer);
    assert.match(answer,/I\s*=\s*U\s*\/\s*R/);
    assert.match(answer,/温度(?:不变|(?:保持)?恒定)|恒温/);
    assert.doesNotMatch(answer,/阻值不随温度|电阻不随温度|温度变化不会影响/,
      "The source fixes the temperature; it does not claim intrinsic resistance is independent of temperature");
    assert.ok(audits.filter(audit=>audit.operation==="card_generation_v3:chat_completion"&&audit.status==="success"&&audit.provider!=="mock").length>=2,
      "Both real rewrite and real content check require actual audits");
  }
  if(focus==="methods"){
    assert.ok(compound);
    const methods=createAgentMethodStore(agentStorePorts);
    const proposed=await methods.propose(scope,{runId:compound.result.runId,expectedRunRevision:compound.result.revision,
      title:"先读材料再整理速看与学习卡",appliesWhen:"用户希望把一篇新笔记整理成速看与待审核学习卡"});
    const confirmed=await methods.control(scope,proposed.methodId,{expectedRevision:proposed.revision,action:"confirm"});
    assert.equal(confirmed.availability,"available");
    const freshNote=randomUUID(),freshVersion=randomUUID();
    const text="直流稳态电路中，电功率 P=UI，单位瓦特 W；电能 E=Pt，时间 t 的单位是秒 s。U=12 V、I=2 A 时 P=24 W，持续5秒消耗120焦耳。交流平均功率不能直接把电压和电流有效值相乘当作有功功率，需考虑功率因数。";
    await admin.begin(async tx=>{
      await tx`INSERT INTO notes(id,workspace_id,title,created_by) VALUES(${freshNote},${workspaceId},'新材料：电功率与能量',${userId})`;
      await tx`INSERT INTO note_versions(id,note_id,workspace_id,version_no,content_json,created_by,content_hash) VALUES(${freshVersion},${freshNote},${workspaceId},1,'{}',${userId},${createHash('sha256').update(text).digest('hex')})`;
      await tx`INSERT INTO note_blocks(version_id,workspace_id,ordinal,type,content) VALUES(${freshVersion},${workspaceId},1,'paragraph',${text})`;
      await tx`UPDATE notes SET current_version_id=${freshVersion} WHERE id=${freshNote}`;
    });
    const reused=await goalCase("已确认方法处理新材料","按我已确认的《先读材料再整理速看与学习卡》方法处理这篇电功率新笔记。先读取方法和这篇新材料，再保存一份简洁速看、准备一批待审核学习卡；由我审核，不激活、不排复习。",[{kind:"note_version",noteId:freshNote,noteVersionId:freshVersion}]);
    assert.ok(reused.calls.includes("agent_read_method"));
    assert.ok(reused.result.artifacts.some(item=>item.kind==="note_overview"));
    assert.ok(reused.result.operations.some(item=>item.result?.kind==="no_cards_recommended"||item.result?.kind==="artifact"&&item.result.artifact.kind==="card_candidates"));
    const uses=await methods.uses(scope,confirmed.methodId);
    assert.ok(uses.items.some(item=>item.contextId===reused.result.runId&&item.methodRevision===confirmed.revision));
    const [row]=await admin`SELECT messages FROM agent_runs WHERE id=${reused.result.runId}`;
    const reads=(row.messages as Array<{toolCalls?:Array<{name:string;arguments:{noteId?:string;noteVersionId?:string}}>}>).flatMap(message=>message.toolCalls??[]).filter(call=>call.name==='note_read');
    assert.ok(reads.length>0&&reads.every(call=>call.arguments.noteId===freshNote&&call.arguments.noteVersionId===freshVersion),'The reused method must read the new material');
  }

  }
  if(!["methods","benchmark","cards","demo_cards","rewrite","refine","adaptation_comparison"].includes(focus)){
  const conversation=await ensureCompanionInbox(scope),conversationId=String(conversation.body.id);
  const dialogueCases: ReadonlyArray<readonly [string, string]> = focus === "context" ? [
    ["任务前台", "交给你处理：实际用计算器核对 20 / 5，结果留在对话手记。不要生成其他内容。"],
    ["进度与疲惫混合", "刚才核对20 / 5的事现在怎么样了？我今天忙得好累，想歇一会儿。只核对进度并陪我说两句，不要替我取消、安排学习或记住这个临时情绪。"],
    ["待确认偏好", "以后讲学习内容，先给一个日常类比，再解释公式。这个要求请记住，家常闲聊时不用这样。"],
    ["提案后家常", "我们先聊别的：今天晚饭吃了一碗热乎乎的面，还遇见一只懒洋洋的小猫，心情一下好了。"],
    ["家常后的短回应", "好"],
    ["拒绝学习话题", "今天不想聊学习了，只想安静歇一会儿，也不用提醒我还有任务。"],
    ["自然收尾", "那我先休息啦，晚安。"],
  ] : [
    ["任务前台","交给你处理：实际用计算器核对 20 / 5，结果留在对话手记。不要生成其他内容。"],
    ["任务转家常","今天晚饭吃了一碗热乎乎的面，还遇见一只懒洋洋的小猫，心情一下好了。"],
    ["回到任务","回来看看，刚才交给你核对 20 / 5 的那件事怎么样了？请核对真实进度。"],
    ["明确持续偏好","以后讲学习内容，先给一个日常类比，再解释公式。这个要求请记住，家常闲聊时不用这样。"],
    ["当前例外","这次解释欧姆定律只给公式与适用条件，不要类比。"],
    ["后续学习采用","再帮我理解电功率 P=UI 和适用范围，按我平时喜欢的方式讲。"],
    ["撤回持续偏好","请忘掉刚才那条学习讲解先给日常类比的偏好；以后讲法由当次问题决定。"],
    ["撤回后的明确要求","说明直流电路中 P=UI 的单位和适用条件，只给公式与条件，不用类比。"],
  ];
  for(const [name,text]of dialogueCases.filter(([name])=>
    (focus!=="withdraw"||["明确持续偏好","撤回持续偏好","撤回后的明确要求"].includes(name))
    &&(focus!=="adaptation"||!["任务前台","任务转家常","回到任务"].includes(name)))){
    // A new foreground message explicitly supersedes its pending foreground
    // generation, just as the product composer does. Background goals retain
    // their own state; the acceptance runner never confirms the old proposal.
    const active = focus === "context" ? await admin`SELECT generation FROM companion_turn_runs WHERE conversation_id=${conversationId}
      AND status IN ('accepted','running','waiting_for_confirmation','cancel_requested')` : [];
    const start=Date.now();const turn=await createCompanionTurn({...scope,conversationId,idempotencyKey:randomUUID(),body:{version:1,clientMessageId:randomUUID(),inputKind:"text",sourceSurface:"pet",blocks:[{type:"text",text}],
      ...(active[0] ? {supersedesGeneration:active[0].generation} : {})}});
    const turnRun=String((turn.body as {runId:string}).runId);
    await drainUntil(async()=>{const[row]=await admin`SELECT status FROM companion_turn_runs WHERE id=${turnRun}`;return ["succeeded","failed","cancelled","superseded","waiting_for_confirmation"].includes(row.status);});
    const confirmations=[];
    const [parked]=await admin`SELECT status FROM companion_turn_runs WHERE id=${turnRun}`;
    if(parked.status==='waiting_for_confirmation' && focus !== "context"){
      const proposals=await admin`SELECT id,payload_sha256,payload FROM companion_action_proposals WHERE agent_run_id=${turnRun} AND status='pending'`;
      assert.ok(proposals.length>0,'A waiting turn must expose its real confirmation');
      assert.equal(name,'明确持续偏好','Only this explicit fixture preference asks for a write confirmation');
      console.log(JSON.stringify({event:'confirming_real_proposals',name,payloads:proposals.map(proposal=>proposal.payload)}));
      for(const proposal of proposals){
        const result=await decideCompanionProposal({...scope,proposalId:proposal.id,decision:'confirm',idempotencyKey:randomUUID(),expectedPayloadSha256:proposal.payload_sha256});
        confirmations.push({kind:proposal.payload.kind,status:(result as {status:string}).status});
      }
      await drainUntil(async()=>{const[row]=await admin`SELECT status FROM companion_turn_runs WHERE id=${turnRun}`;return ['succeeded','failed','cancelled','superseded'].includes(row.status);});
    }
    const [state]=await admin`SELECT status,model_call_count,tool_call_count FROM companion_turn_runs WHERE id=${turnRun}`;
    const messages=await admin`SELECT blocks FROM companion_messages WHERE conversation_id=${conversationId} AND role='assistant' AND run_id=${turnRun} ORDER BY seq`;
    const tools=await admin`SELECT name AS tool_name,status FROM companion_agent_tool_calls WHERE run_id=${turnRun} ORDER BY created_at`;
    const reply=messages.flatMap(message=>(message.blocks as Array<{text?:string}>).map(block=>block.text??"")).join("\n");
    const memories=await admin`SELECT kind,content,applies_when,user_confirmed,revision FROM assistant_memory_items WHERE workspace_id=${workspaceId} AND user_id=${userId} AND deleted_at IS NULL AND dismissed_at IS NULL`;
    const proposals = focus === "context" ? await admin`SELECT id,status,decision,payload FROM companion_action_proposals
      WHERE workspace_id=${workspaceId} AND user_id=${userId} ORDER BY created_at` : [];
    const goals = focus === "context" ? await admin`SELECT id,status,revision FROM agent_runs
      WHERE workspace_id=${workspaceId} AND user_id=${userId} ORDER BY created_at` : [];
    const entry={name,input:text,status:state.status,elapsedMs:Date.now()-start,modelCalls:state.model_call_count,toolCalls:state.tool_call_count,confirmations,tools,reply,memories,
      ...(focus === "context" ? {proposals,goals} : {})};
    cases.push(entry);await writeFile(output,JSON.stringify({version:1,cases},null,2));console.log(JSON.stringify(entry));
    if (focus === "context" && name === "待确认偏好") {
      assert.equal(state.status,"waiting_for_confirmation","This scenario requires a real pending proposal, not a fabricated fixture");
      assert.ok(proposals.some(proposal=>proposal.status === "pending" && proposal.decision === null));
    } else assert.equal(state.status,"succeeded");
    if (focus === "context") {
      assert.ok(!goals.some(goal=>goal.status === "cancelled"),"Changing the current conversation must not cancel background goals");
      assert.ok(!memories.some(memory=>memory.user_confirmed),"Neither casual speech nor a short acknowledgement approves a previous preference");
      if(name === "进度与疲惫混合") {
        assert.ok(tools.some(tool=>tool.tool_name === "agent_list_goals" || tool.tool_name === "agent_read_goal"));
        assert.match(reply,/休息|歇|累|放松|辛苦/);
        assert.ok(!tools.some(tool=>/save_memory|cancel_goal|revise_goal/.test(tool.tool_name)));
      }
      if(["提案后家常","家常后的短回应","拒绝学习话题","自然收尾"].includes(name)) {
        assert.equal(tools.length,0,"A casual turn must not perform a previous proposal or learning action");
        assert.ok(proposals.every(proposal=>proposal.decision !== "confirm" && proposal.status !== "succeeded"));
      }
      if(name === "自然收尾") assert.doesNotMatch(reply,/[?？]|要不要|学一|复习|计划|任务/);
    }
    if(name==="当前例外"){assert.match(reply,/(?:I\s*=\s*(?:U\s*[/÷]\s*R|\\frac\{U\}\{R\})|U\s*=\s*I\s*(?:[×*·]\s*)?R|R\s*=\s*U\s*[/÷]\s*I)/);assert.ok(memories.some(memory=>memory.kind==="preference"&&memory.user_confirmed&&/类比/.test(memory.content)));}
    if(name==="后续学习采用"){assert.match(reply,/类比|比作|就像|好比|比方|想象/);assert.match(reply,/P\s*=\s*U\s*(?:[×*·]\s*)?I/,'Adapting the explanation must still answer the current power question');}
    if(name==="撤回持续偏好"){assert.ok(tools.some(tool=>tool.tool_name==="companion_forget_memory"));assert.ok(!memories.some(memory=>memory.kind==="preference"&&memory.user_confirmed&&/类比/.test(memory.content)));}
    if(name==="任务转家常"){assert.equal(tools.length,0);assert.doesNotMatch(reply,/任务|计算|20\s*[/÷]\s*5|手记|进度/);}
    if(name==="回到任务")assert.ok(tools.some(tool=>tool.tool_name==="agent_list_goals"));
    if(name==="明确持续偏好"){assert.ok(tools.some(tool=>tool.tool_name==='companion_save_memory'));assert.ok(memories.some(memory=>memory.kind==='preference'&&memory.user_confirmed&&/类比/.test(memory.content)));}
  }
  }
  }
}finally{
  const audits=await admin`SELECT operation,provider,model_id,status,cost_tokens,duration_ms FROM ai_audit_log WHERE workspace_id=${workspaceId} ORDER BY created_at`;
  await writeFile(output,JSON.stringify({version:1,cases,audits,jobFailures},null,2));
  await admin.begin(async tx=>{
    await tx`SET LOCAL app.allow_history_mutation = 'on'`;
    await tx`DELETE FROM agent_runs WHERE workspace_id=${workspaceId}`;
    await tx`DELETE FROM card_generation_runs_v2 WHERE workspace_id=${workspaceId}`;
    await tx`DELETE FROM companion_conversations WHERE workspace_id=${workspaceId}`;
    await tx`DELETE FROM assistant_memory_items WHERE workspace_id=${workspaceId}`;
    await tx`DELETE FROM note_overviews WHERE workspace_id=${workspaceId}`;
    await tx`DELETE FROM note_learning_artifacts WHERE workspace_id=${workspaceId}`;
    await tx`DELETE FROM note_expansion_tasks WHERE workspace_id=${workspaceId}`;
    await tx`DELETE FROM jobs WHERE workspace_id=${workspaceId}`;

  });
  let report;
  try { report=await wipeCardGenerationFixtures(admin,[workspaceId],[userId]); }
  finally { await Promise.all([admin.end(),closeDatabase(),closeApiDatabase()]); }
  assertFixtureWipeClean(report);
}
