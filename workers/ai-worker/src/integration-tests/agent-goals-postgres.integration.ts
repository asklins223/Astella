import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { after, test } from "node:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@astella/shared/db-schema";
import { sql as query } from "drizzle-orm";
import { createAgentStore, createAgentAdvanceStore, type AgentStorePorts } from "@astella/agent-host";
import { agentTurnResultSchema, type AgentTurnRequest } from "@astella/shared";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { invokeNoteCapability } from "../agent/note-capabilities.ts";
import { loadAgentGenerationContext } from "../agent/generation-context.ts";
import { loadAgentLearningContext } from "../agent/learning-context.ts";
import { buildAgentGoalRequest } from "../agent/goal-context.ts";
import { invokeBasicCapability } from "../agent/basic-capabilities.ts";
import { AGENT_GOAL_DELIVERY_CAPABILITY, type AgentGoalDeliveryV1 } from "@astella/shared/agent-contracts";
import { closeDatabase, type WorkerTransaction } from "../db.ts";
import { closeDatabase as closeApiDatabase } from "../../../../apps/api/src/db/client.ts";
import { startNoteOverviewTask } from "../../../../apps/api/src/modules/note-overviews/service.ts";
import { startNoteLearningArtifactTask } from "../../../../apps/api/src/modules/note-learning-artifacts/service.ts";
import { startNoteExpansionTask } from "../../../../apps/api/src/modules/note-expansions/service.ts";
import { createGenerationRunV2 } from "../../../../apps/api/src/modules/card-generation-v2/generation-run-service.ts";
import { assertFixtureWipeClean, wipeCardGenerationFixtures } from "./card-generation-fixture-cleanup.ts";
import { runAgentAdvance } from "../agent/advance.ts";
import { runNoteOverviewGenerate } from "../handlers/note-overview-generate.ts";

const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 2 });
const apiClient = postgres(testDatabaseUrl("DATABASE_URL_API"), { max: 2 });
const workerClient = postgres(testDatabaseUrl("DATABASE_URL_WORKER"), { max: 2 });
function ports(client: ReturnType<typeof postgres>): AgentStorePorts<WorkerTransaction> {
  const db = drizzle(client, { schema });
  return { id: randomUUID, transaction: (scope, action) => db.transaction(async tx => {
    await tx.execute(query`SELECT set_config('app.workspace_id',${scope.workspaceId},true),set_config('app.user_id',${scope.userId},true)`);
    return action(tx);
  }) };
}
const api = createAgentStore({ ...ports(apiClient), ensureIdentity: async (tx, scope) => {
  await tx.execute(query`INSERT INTO user_companion_account_state(user_id) VALUES(${scope.userId}) ON CONFLICT(user_id) DO NOTHING`);
} });
const workerPorts = ports(workerClient);
const fixtures: { userId: string; workspaceIds: string[] }[] = [];
after(async () => {
  let report;
  try {
    for (const fixture of fixtures) await admin.begin(async tx => {
      await tx`SET LOCAL app.allow_history_mutation = 'on'`;
      for (const workspaceId of fixture.workspaceIds) {
        await tx`DELETE FROM agent_runs WHERE workspace_id=${workspaceId}`;
        await tx`DELETE FROM note_overviews WHERE workspace_id=${workspaceId}`;
        await tx`DELETE FROM note_learning_artifacts WHERE workspace_id=${workspaceId}`;
        await tx`DELETE FROM jobs WHERE workspace_id=${workspaceId}`;
      }
    });
    if (fixtures.length) report = await wipeCardGenerationFixtures(admin,
      fixtures.flatMap(fixture => fixture.workspaceIds), fixtures.map(fixture => fixture.userId));
  } finally { await Promise.all([admin.end(), apiClient.end(), workerClient.end(), closeDatabase(), closeApiDatabase()]); }
  if (report) assertFixtureWipeClean(report);
});
async function fixture(content = ["叶绿体利用光能制造有机物。"], title = "光合作用") {
  const userId = randomUUID(), workspaceIds = [randomUUID(),randomUUID()], noteId = randomUUID(), noteVersionId = randomUUID();
  fixtures.push({ userId, workspaceIds });
  await admin.begin(async tx => {
    await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${userId},${`agent42-${userId}@test.invalid`},'fixture','owner')`;
    for (const workspaceId of workspaceIds) {
      await tx`INSERT INTO workspaces(id,name,owner_id) VALUES(${workspaceId},'agent42 fixture',${userId})`;
      await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
    }
    await tx`INSERT INTO notes(id,workspace_id,title,created_by) VALUES(${noteId},${workspaceIds[0]},${title},${userId})`;
    await tx`INSERT INTO note_versions(id,note_id,workspace_id,version_no,content_json,created_by,content_hash)
      VALUES(${noteVersionId},${noteId},${workspaceIds[0]},1,'{}',${userId},${createHash('sha256').update(content.join('\n')).digest('hex')})`;
    for (const [index, text] of content.entries()) await tx`INSERT INTO note_blocks(version_id,workspace_id,ordinal,type,content) VALUES(${noteVersionId},${workspaceIds[0]},${index+1},'paragraph',${text})`;
    await tx`UPDATE notes SET current_version_id=${noteVersionId} WHERE id=${noteId}`;
  });
  return { userId, workspaceId: workspaceIds[0], otherWorkspaceId: workspaceIds[1], input: { kind: "note_version" as const, noteId, noteVersionId } };
}
async function anotherNote(scope: { workspaceId: string; userId: string }, title: string, content: string[]) {
  const noteId = randomUUID(), noteVersionId = randomUUID();
  await admin.begin(async tx => {
    await tx`INSERT INTO notes(id,workspace_id,title,created_by) VALUES(${noteId},${scope.workspaceId},${title},${scope.userId})`;
    await tx`INSERT INTO note_versions(id,note_id,workspace_id,version_no,content_json,created_by,content_hash)
      VALUES(${noteVersionId},${noteId},${scope.workspaceId},1,'{}',${scope.userId},${createHash('sha256').update(content.join('\n')).digest('hex')})`;
    for (const [index, text] of content.entries()) await tx`INSERT INTO note_blocks(version_id,workspace_id,ordinal,type,content)
      VALUES(${noteVersionId},${scope.workspaceId},${index+1},'paragraph',${text})`;
    await tx`UPDATE notes SET current_version_id=${noteVersionId} WHERE id=${noteId}`;
  });
  return { kind: "note_version" as const, noteId, noteVersionId };
}
async function lease(scope: { workspaceId: string; userId: string }, runId: string, revision = 1) {
  const leaseToken = randomUUID();
  const [job] = await admin`UPDATE jobs SET status='running',lease_token=${leaseToken},started_at=now()
    WHERE id=(SELECT id FROM jobs WHERE workspace_id=${scope.workspaceId} AND payload->>'runId'=${runId}
      AND payload->>'revision'=${String(revision)} AND type='agent_run_advance' AND status='pending' ORDER BY id LIMIT 1) RETURNING id`;
  assert.ok(job, "the durable outbox must supply a pending advance");
  return { id: String(job.id), workspaceId: scope.workspaceId, requestedBy: scope.userId, leaseToken };
}
const request: AgentTurnRequest = { role: "companion_agent", systemPrompt: "fixture", messages: [{ role: "user", content: "整理" }], tools: [], toolChoice: "auto", maxTokens: 200, temperature: 0 };

test("a greeting without a delivery cannot complete a durable goal or publish a false summary", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const run = await api.create(scope, { requestId: randomUUID(), goal: "请实际核对12/4", inputs: [] });
  const job = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, job, run.runId, 1);
  await advance.acquire();
  const greeting = agentTurnResultSchema.parse({content:"嗨，还没有收到任务。",toolCalls:[],finishReason:"stop",usage:null,providerRequestId:null});
  for (const index of [1, 2]) {
    const built = await buildAgentGoalRequest(advance, await advance.read());
    assert.deepEqual(built.tools.map(tool => tool.name), ["agent_calculate", "agent_read_public_document", "agent_deliver_goal"],
      "a goal without note inputs or confirmed methods must not offer their executors");
    assert.ok(!built.systemPrompt.includes("no_cards_recommended"), "unavailable domain instructions do not occupy this model step");
    const {step} = await advance.step(built, `greeting-${index}`);
    await advance.saveResponse(step, greeting);
    const outcome = await advance.applyStep(step, greeting, []);
    const projection = await api.get(scope, run.runId);
    assert.equal(outcome, index === 1 ? "continue" : "settled");
    assert.equal(projection.status, index === 1 ? "running" : "failed");
    assert.equal(projection.summary, null, "a stopped model is not a delivery");
  }
});

test("the real calculator result supports an explicit delivery, with a committed summary owned by that receipt", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const run = await api.create(scope, { requestId: randomUUID(), goal: "请实际核对12/4", inputs: [] });
  const job = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, job, run.runId, 1);
  await advance.acquire();
  const built = await buildAgentGoalRequest(advance, await advance.read()), {step} = await advance.step(built, "calculation-delivery");
  const delivery: AgentGoalDeliveryV1 = {outcome:"completed",summary:"12 / 4 = 3。",requirements:[{requirement:"实际核对12/4",fulfilled:true,evidenceCallIds:["calc"],textOnly:false}]};
  const response = agentTurnResultSchema.parse({content:"忽略这段无依据的闲聊",toolCalls:[
    {id:"calc",name:"agent_calculate",arguments:{expression:"12/4"}},
    {id:"delivery",name:AGENT_GOAL_DELIVERY_CAPABILITY,arguments:delivery},
  ],finishReason:"tool_calls",usage:null,providerRequestId:null});
  await advance.saveResponse(step,response);
  const calculated = await invokeBasicCapability(advance,response.toolCalls[0]!);
  assert.equal(await advance.applyStep(step,response,[
    {role:"tool",toolCallId:"calc",content:JSON.stringify(calculated)},
    {role:"tool",toolCallId:"delivery",content:JSON.stringify({status:"proposed",kind:"goal_delivery",delivery})},
  ]),"settled");
  const completed = await api.get(scope,run.runId);
  assert.equal(completed.status,"completed");assert.equal(completed.summary,delivery.summary);
});

test("a declared missing input pauses the same task, preserving a readable next step", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const run = await api.create(scope,{requestId:randomUUID(),goal:"请读取公开文档",inputs:[]});
  const job = await lease(scope,run.runId), advance = createAgentAdvanceStore(workerPorts,job,run.runId,1);
  await advance.acquire();
  const built = await buildAgentGoalRequest(advance,await advance.read()), {step}=await advance.step(built,"needs-document-url");
  const delivery: AgentGoalDeliveryV1={outcome:"needs_input",summary:"请补充要读取的公开网址。",requirements:[{requirement:"读取公开文档",fulfilled:false,evidenceCallIds:[],textOnly:false}]};
  const response=agentTurnResultSchema.parse({content:null,toolCalls:[{id:"delivery",name:AGENT_GOAL_DELIVERY_CAPABILITY,arguments:delivery}],finishReason:"tool_calls",usage:null,providerRequestId:null});
  await advance.saveResponse(step,response);
  await advance.applyStep(step,response,[{role:"tool",toolCallId:"delivery",content:JSON.stringify({status:"proposed",kind:"goal_delivery",delivery})}]);
  const paused=await api.get(scope,run.runId);assert.equal(paused.status,"paused");assert.equal(paused.summary,delivery.summary);
  assert.equal(paused.revision,1);assert.deepEqual(paused.artifacts,[]);
});

test("goal context keeps the complete 8,000-character request once under the shared identity", async () => {
  const f=await fixture(), scope={workspaceId:f.workspaceId,userId:f.userId}, goal="完整要求".repeat(2000);
  const run=await api.create(scope,{requestId:randomUUID(),goal,inputs:[]});
  const job=await lease(scope,run.runId), advance=createAgentAdvanceStore(workerPorts,job,run.runId,1);
  await advance.acquire();
  const built=await buildAgentGoalRequest(advance,await advance.read());
  assert.deepEqual(built.messages,[{role:"user",content:goal}]);
  assert.match(built.systemPrompt,/你是一起长期学习的 AI 桌宠/);
  assert.doesNotMatch(built.systemPrompt,/用户只是打招呼时/);
  assert.ok(built.tools.some(tool=>tool.name===AGENT_GOAL_DELIVERY_CAPABILITY));
});

test("semantic capability identity, paused receipts and failed continuation reuse completed work", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const run = await api.create(scope, { requestId: randomUUID(), goal: "做速看", inputs: [f.input] });
  const first = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, first, run.runId, 1);
  await advance.acquire();
  const materialRequest = await buildAgentGoalRequest(advance, await advance.read());
  const materialProperties = materialRequest.tools.find(tool => tool.name === "note_read")!.parameters.properties as Record<string, { enum: string[] }>;
  assert.deepEqual(materialProperties.noteId.enum, [f.input.noteId]);
  assert.deepEqual(materialProperties.noteVersionId.enum, [f.input.noteVersionId]);
  const call = { id: "provider-first", name: "note_overview_generate", arguments: { noteId: f.input.noteId, noteVersionId: f.input.noteVersionId } };
  const child = await invokeNoteCapability(advance, call) as { operationId: string; execution: { kind: "job"; id: string } };
  const repeated = await invokeNoteCapability(advance, { ...call, id: "different-provider-id" }) as { execution: { kind: "job"; id: string }; operationId: string };
  assert.equal(repeated.execution.id, child.execution.id); assert.equal(repeated.operationId, child.operationId);
  await api.control(scope, run.runId, 1, "pause");
  await assert.rejects(advance.step(request, "late"), /被新的要求替代/);
  const artifactId = randomUUID();
  await admin.begin(async tx => {
    await tx`INSERT INTO note_overviews(id,workspace_id,user_id,note_id,note_version_id,body,generation_job_id)
      VALUES(${artifactId},${scope.workspaceId},${scope.userId},${f.input.noteId},${f.input.noteVersionId},'成果',${child.execution.id})`;
    await tx`UPDATE jobs SET status='succeeded',lease_token=NULL,finished_at=now() WHERE id IN (${first.id},${child.execution.id})`;
  });
  const pausedLease = await lease(scope, run.runId), receipt = createAgentAdvanceStore(workerPorts, pausedLease, run.runId, 1);
  assert.equal((await receipt.acquire())?.status, "paused");
  const paused = await api.get(scope, run.runId);
  assert.equal(paused.status, "paused"); assert.equal(paused.artifacts[0].id, artifactId); assert.equal(paused.modelCalls, 0);
  await receipt.release(false);
  await admin`UPDATE jobs SET status='succeeded',lease_token=NULL,finished_at=now() WHERE id=${pausedLease.id}`;
  await admin`UPDATE agent_runs SET status='failed' WHERE id=${run.runId}`;
  const retried = await api.control(scope, run.runId, 1, "resume"); assert.equal(retried.revision, 2);
  const next = await lease(scope, run.runId, 2), continuing = createAgentAdvanceStore(workerPorts, next, run.runId, 2);
  await continuing.acquire();
  const reused = await invokeNoteCapability(continuing, { ...call, id: "third-provider-id" }) as unknown as
    { reused: boolean; execution: { kind: "job"; id: string } };
  assert.equal(reused.reused, true); assert.equal(reused.execution.id, child.execution.id);
  const [{ n }] = await admin`SELECT count(*)::int n FROM jobs WHERE type='note_overview_generate' AND workspace_id=${scope.workspaceId}`;
  assert.equal(n, 1);
});

test("approved active preferences remain scoped, temporary goals do not rewrite them, and child calls reserve a closing step", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  await admin`INSERT INTO assistant_memory_items(workspace_id,user_id,kind,content,user_confirmed,budget_tier,source_type,scope)
    VALUES(${scope.workspaceId},${scope.userId},'preference','讲学习内容时，先举日常例子，再给公式。',true,'active','user_stated','workspace'),
      (${scope.workspaceId},${scope.userId},'preference','不应采用的未确认推断',false,'resident','model_inferred','workspace')`;
  const preferences = await workerPorts.transaction(scope, tx => loadAgentLearningContext(tx, scope));
  assert.equal(preferences.preferences.length, 1); assert.match(preferences.preferences[0].content, /先举日常例子/);
  assert.deepEqual((await workerPorts.transaction({ ...scope, workspaceId: f.otherWorkspaceId }, tx => loadAgentLearningContext(tx, { ...scope, workspaceId: f.otherWorkspaceId }))).preferences, []);
  const run = await api.create(scope, { requestId: randomUUID(), goal: "这一次只给公式，不要例子", inputs: [f.input] });
  const first = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, first, run.runId, 1);
  await advance.acquire();
  const child = await invokeNoteCapability(advance, { id: "child", name: "note_overview_generate", arguments: { noteId: f.input.noteId, noteVersionId: f.input.noteVersionId } }) as { execution: { kind: "job"; id: string } };
  const context = await loadAgentGenerationContext({ id: child.execution.id, workspaceId: scope.workspaceId, requestedBy: scope.userId,
    leaseToken: randomUUID(), payload: { agentRunId: run.runId, agentRevision: 1 } });
  assert.match(context.instructions, /先举日常例子/); assert.match(context.instructions, /这一次只给公式/);
  await admin`UPDATE agent_runs SET model_calls=14 WHERE id=${run.runId}`;
  await context.reserveModelCall();
  await assert.rejects(context.reserveModelCall(), /预算已用完/);
  assert.equal((await api.get(scope, run.runId)).modelCalls, 15);
  assert.match((await workerPorts.transaction(scope, tx => loadAgentLearningContext(tx, scope))).preferences[0].content, /先举日常例子/);
});

test("API owner scope, request binding, visible inputs and stable cross-space identity", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId }, requestId = randomUUID();
  const first = await api.create(scope, { requestId, goal: "整理成速看", inputs: [f.input] });
  const repeated = await api.create(scope, { requestId, goal: "整理成速看", inputs: [f.input] });
  assert.equal(repeated.runId, first.runId);
  await assert.rejects(api.create(scope, { requestId, goal: "另一个要求", inputs: [f.input] }), /已有另一份要求/);
  const otherScope = { ...scope, workspaceId: f.otherWorkspaceId };
  assert.deepEqual((await api.list(otherScope)).items, []);
  await assert.rejects(api.create(otherScope, { requestId: randomUUID(), goal: "读另一空间的私有笔记", inputs: [f.input] }), /重新选择材料/);
  const other = await api.create(otherScope, { requestId: randomUUID(), goal: "另一空间的事", inputs: [] });
  assert.equal(other.identityId, first.identityId);
  const [{ n }] = await admin`SELECT count(*)::int n FROM jobs WHERE type='agent_run_advance' AND payload->>'runId'=${first.runId}`;
  assert.equal(n, 1);
});
test("revision and failed resume share the same active-goal quota as creation", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const requests = Array.from({ length: 5 }, (_, index) => ({ requestId: randomUUID(), goal: `目标 ${index + 1}`, inputs: [f.input] }));
  const runs = [];
  for (const input of requests) runs.push(await api.create(scope, input));
  assert.equal((await api.create(scope, requests[0])).runId, runs[0].runId, "an idempotent read must remain available at capacity");
  await assert.rejects(api.create(scope, { requestId: randomUUID(), goal: "第六件", inputs: [f.input] }), /先完成或停止/);
  await api.control(scope, runs[0].runId, 1, "cancel");
  await api.create(scope, { requestId: randomUUID(), goal: "另一件", inputs: [f.input] });
  await assert.rejects(api.revise(scope, runs[0].runId, 1, "重新开始"), /先完成或停止/);
  await admin`UPDATE agent_runs SET status='failed' WHERE id=${runs[1].runId}`;
  assert.equal((await api.revise(scope, runs[0].runId, 1, "重新开始")).revision, 2);
  await assert.rejects(api.control(scope, runs[1].runId, 1, "resume"), /先完成或停止/);
  await api.control(scope, runs[2].runId, 1, "pause");
  assert.equal((await api.control(scope, runs[2].runId, 1, "resume")).status, "queued", "resuming an already counted paused goal does not need another slot");
});
test("checkpoint restart, child receipt wake, retained artifacts and revision fences", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const run = await api.create(scope, { requestId: randomUUID(), goal: "做一份速看", inputs: [f.input] });
  const firstLease = await lease(scope, run.runId);
  let advance = createAgentAdvanceStore(workerPorts, firstLease, run.runId, 1);
  await advance.acquire();
  const response = agentTurnResultSchema.parse({ content: "先生成速看", finishReason: "tool_calls", usage: null, providerRequestId: null, toolCalls: [{ id: "provider-1", name: "note_overview_generate", arguments: { noteId: f.input.noteId, noteVersionId: f.input.noteVersionId } }] });
  const prepared = await advance.step(request, "snapshot-hash");
  await advance.saveResponse(prepared.step, response);
  const operationId = randomUUID(), jobId = randomUUID();
  await advance.invoke(async tx => {
    await tx.execute(query`INSERT INTO agent_operations(id,run_id,workspace_id,user_id,revision,tool_call_id,capability,job_id)
      VALUES(${operationId},${run.runId},${scope.workspaceId},${scope.userId},1,'overview','note_overview_generate',${jobId})`);
    // payload 冻结的必须是同一份笔记版本：回执靠它确认产物属于这一次操作（agent-host artifact-receipt）。
    await tx.execute(query`INSERT INTO jobs(id,type,workspace_id,requested_by,payload,status) VALUES(${jobId},'note_overview_generate',${scope.workspaceId},${scope.userId},${JSON.stringify({ noteId: f.input.noteId, noteVersionId: f.input.noteVersionId })}::jsonb,'pending')`);
  });
  await advance.applyStep(prepared.step, response, [{ role: "tool", toolCallId: "provider-1", content: '{"status":"accepted"}' }]);
  await advance.release(false);
  await admin`UPDATE jobs SET status='succeeded',lease_token=NULL,finished_at=now() WHERE id=${firstLease.id}`;
  const artifactId = randomUUID();
  await admin.begin(async tx => {
    await tx`INSERT INTO note_overviews(id,workspace_id,user_id,note_id,note_version_id,body,generation_job_id)
      VALUES(${artifactId},${scope.workspaceId},${scope.userId},${f.input.noteId},${f.input.noteVersionId},'光能转化为有机物中的化学能。',${jobId})`;
    await tx`UPDATE jobs SET status='succeeded',lease_token=NULL,finished_at=now() WHERE id=${jobId}`;
  });
  const secondLease = await lease(scope, run.runId);
  advance = createAgentAdvanceStore(workerPorts, secondLease, run.runId, 1);
  await advance.acquire();
  const current = await api.get(scope, run.runId);
  assert.equal(current.operations[0].status, "succeeded"); assert.equal(current.artifacts[0].id, artifactId);
  // 笔记产物那一档才带 jobId：产物是按种类收窄的联合类型，先收窄再断言属性。
  const delivered = current.artifacts[0];
  assert.ok(delivered.kind !== "card_candidates", "这一格交付的是笔记产物，不是制卡候选");
  assert.equal(delivered.jobId, jobId);
  const checkpoint = await advance.step(request, "second-hash");
  const answer = agentTurnResultSchema.parse({ content: "已做好速看", toolCalls: [], finishReason: "stop", usage: null, providerRequestId: null });
  await advance.saveResponse(checkpoint.step, answer);
  const before = (await api.get(scope, run.runId)).modelCalls;
  const restarted = createAgentAdvanceStore(workerPorts, secondLease, run.runId, 1);
  assert.ok(await restarted.acquire());
  const cached = await restarted.step({ ...request, systemPrompt: "a new prompt must not replace the frozen request" }, "changed-hash");
  assert.deepEqual(cached.response, answer); assert.equal(cached.step.request_hash, "second-hash");
  assert.equal((await api.get(scope, run.runId)).modelCalls, before);
  const revised = await api.revise(scope, run.runId, 1, "只保留速看，解释短一些");
  assert.equal(revised.revision, 2); assert.equal(revised.artifacts[0].id, artifactId);
  await assert.rejects(restarted.saveResponse(checkpoint.step, answer), /被新的要求替代/);
  await assert.rejects(api.revise(scope, run.runId, 1, "stale"), /刚刚更新/);
});
test("cancelled child commits are fenced and unknown outcomes never become automatic retries", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const run = await api.create(scope, { requestId: randomUUID(), goal: "做速看", inputs: [f.input] });
  const first = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, first, run.runId, 1);
  await advance.acquire();
  const jobId = randomUUID(), operationId = randomUUID();
  await advance.invoke(async tx => {
    await tx.execute(query`INSERT INTO agent_operations(id,run_id,workspace_id,user_id,revision,tool_call_id,capability,job_id)
      VALUES(${operationId},${run.runId},${scope.workspaceId},${scope.userId},1,'overview','note_overview_generate',${jobId})`);
    await tx.execute(query`INSERT INTO jobs(id,type,workspace_id,requested_by,payload,status) VALUES(${jobId},'note_overview_generate',${scope.workspaceId},${scope.userId},'{}','pending')`);
  });
  await advance.release(false);
  await admin`UPDATE jobs SET status='succeeded',lease_token=NULL,finished_at=now() WHERE id IN (${first.id},${jobId})`;
  const next = await lease(scope, run.runId), resumed = createAgentAdvanceStore(workerPorts, next, run.runId, 1);
  await resumed.acquire();
  assert.equal((await api.get(scope, run.runId)).operations[0].status, "outcome_unknown");
  await api.control(scope, run.runId, 1, "cancel");
  const rows = await workerPorts.transaction(scope, tx => tx.execute(query`SELECT astella_agent_job_current(${jobId},${scope.workspaceId},${scope.userId},false) AS allowed`));
  const [{ allowed }] = rows as unknown as { allowed: boolean }[];
  assert.equal(allowed, false);
  assert.equal((await api.get(scope, run.runId)).status, "cancelled");
  await assert.rejects(resumed.invoke(async () => "late effect"), /被新的要求替代/);
  const [{ n }] = await admin`SELECT count(*)::int n FROM jobs WHERE type='note_overview_generate' AND workspace_id=${scope.workspaceId}`;
  assert.equal(n, 1, "receipt uncertainty must not enqueue another generation");
});

test("GT-01/02 actual overview generation adopts approved feedback, follows one exception, then restores the preference", {
  skip: process.env.REAL_MODEL_BATCH !== "1" ? "enable only for a real model batch in the disposable database" : false,
}, async () => {
  const f = await fixture([
    "欧姆定律表明，在电阻不变时，电流与电压成正比，关系式为 I=U/R。",
    "如果电压保持不变，电阻增加到原来的两倍，电流会变成原来的一半。",
    "若电阻保持不变，电压增加到原来的两倍，电流也会增加到原来的两倍。",
  ], "欧姆定律反馈验收");
  const scope = { workspaceId: f.workspaceId, userId: f.userId };
  await admin`INSERT INTO user_ai_settings(user_id,consent_at,consent_version,data_policy)
    VALUES(${f.userId},now(),'test-fixture','{"sendToExternal":true,"piiDetection":true,"auditLogging":true}')`;
  await admin`INSERT INTO assistant_memory_items(workspace_id,user_id,kind,content,user_confirmed,budget_tier,source_type,scope)
    VALUES(${scope.workspaceId},${scope.userId},'preference','以后讲学习内容，请先用日常例子或类比解释，再讲抽象关系或公式。',true,'active','user_stated','workspace')`;
  const nextInput = await anotherNote(scope, "密度反馈验收", [
    "密度表示单位体积物质的质量，关系式为 ρ=m/V。",
    "同一种物质的密度保持不变时，体积增加到原来的两倍，质量也增加到原来的两倍。",
    "体积相同的不同物质，密度越大，质量就越大。",
  ]);
  const outputs: { sample: string; body: string; explanations: string[] }[] = [];
  const samples = [
    { sample: "later-task", goal: "把欧姆定律整理成速看", input: f.input },
    { sample: "temporary-exception", goal: "这一次只按数学关系解释，不用日常例子或类比；不要改变长期偏好。", input: f.input },
    { sample: "after-exception", goal: "把密度材料整理成速看", input: nextInput },
  ];
  for (const { sample, goal, input } of samples) {
    const run = await api.create(scope, { requestId: randomUUID(), goal, inputs: [input] });
    const rootLease = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, rootLease, run.runId, 1);
    await advance.acquire();
    const child = await invokeNoteCapability(advance, { id: sample, name: "note_overview_generate", arguments: { noteId: input.noteId, noteVersionId: input.noteVersionId } }) as { execution: { kind: "job"; id: string } };
    const leaseToken = randomUUID();
    const [job] = await admin`UPDATE jobs SET status='running',started_at=now(),lease_token=${leaseToken} WHERE id=${child.execution.id} RETURNING payload`;
    await runNoteOverviewGenerate({ id: child.execution.id, workspaceId: scope.workspaceId, requestedBy: scope.userId, payload: job.payload, leaseToken });
    const [saved] = await admin`SELECT body,overview_points FROM note_overviews WHERE generation_job_id=${child.execution.id}`;
    assert.ok(saved?.body);
    outputs.push({ sample, body: String(saved.body), explanations: saved.overview_points.map((point: { explanation: string }) => point.explanation) });
    await advance.release(false);
    await admin`UPDATE jobs SET status='succeeded',lease_token=NULL,finished_at=now() WHERE id IN (${rootLease.id},${child.execution.id})`;
  }
  // Save the actual outputs for semantic review; format checks alone cannot judge adaptation.
  console.log(JSON.stringify({ fixture: "GT-01/02", outputs }));
  const explanation = (output: typeof outputs[number]) => [output.body, ...output.explanations].join("\n");
  const everydayExample = /比如|例如|好比|比方|就像|类似|水流|水管|水龙头|棉花|铁块/;
  assert.match(explanation(outputs[0]), everydayExample);
  assert.doesNotMatch(explanation(outputs[1]), everydayExample);
  assert.match(explanation(outputs[2]), everydayExample);
  assert.match((await workerPorts.transaction(scope, tx => loadAgentLearningContext(tx, scope))).preferences[0].content, /以后讲学习内容/);
});

/**
 * note_read 的能力路径围栏（42 阶段 1 D 追加）。
 *
 * 读笔记与读拓展草稿是同类问题：先 `store.invoke` 核对、再另起无围栏事务去读的话，
 * 取消或修订可能夹在中间。两条读能力现在都在同一次 invoke 的事务里完成读取；
 * 这里用**真实能力调用**钉住它的后果：租约活着且材料在冻结集合里就读得到，
 * 目标一停，同一个租约的迟到读取立刻被 advance 围栏拒掉，而且什么账本都不增。
 */
test("note_read stays inside the advance fence: active lease reads, cancelled goal does not", async () => {
  const f = await fixture(["叶绿体利用光能制造有机物。", "光合作用把光能变成化学能。"]), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const run = await api.create(scope, { requestId: randomUUID(), goal: "整理这篇笔记", inputs: [f.input] });
  const rootLease = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, rootLease, run.runId, 1);
  assert.ok(await advance.acquire(), "活跃租约必须能拿到目标");

  const ledger = async () => {
    const [row] = await admin`
      SELECT (SELECT count(*)::int FROM agent_operations WHERE run_id=${run.runId}) AS operations,
             (SELECT count(*)::int FROM jobs WHERE workspace_id=${scope.workspaceId}) AS jobs,
             (SELECT model_calls::int FROM agent_runs WHERE id=${run.runId}) AS model_calls`;
    return [row.operations, row.jobs, row.model_calls];
  };
  const before = await ledger();

  // 活跃租约 + 冻结输入：走真实能力路径，读得到这一版正文。
  const page = await invokeNoteCapability(advance, {
    id: "provider-note-read", name: "note_read",
    arguments: { noteId: f.input.noteId, noteVersionId: f.input.noteVersionId },
  }) as { status: string; title: string; noteVersionId: string; totalBlocks: number; truncated: boolean; body: string };
  assert.equal(page.status, "succeeded");
  assert.equal(page.title, "光合作用");
  assert.equal(page.noteVersionId, f.input.noteVersionId);
  assert.equal(page.totalBlocks, 2);
  assert.equal(page.truncated, false);
  assert.match(page.body, /叶绿体利用光能制造有机物。/);
  assert.deepEqual(await ledger(), before, "只读不得留下 operation、job 或模型调用");

  // 目标停掉之后，同一个租约的迟到读取必须被围栏拒掉，而不是读到已经不该读的内容。
  await api.control(scope, run.runId, 1, "cancel");
  await assert.rejects(invokeNoteCapability(advance, {
    id: "provider-late-read", name: "note_read",
    arguments: { noteId: f.input.noteId, noteVersionId: f.input.noteVersionId },
  }), (error: Error & { code?: string }) => {
    assert.equal(error.code, "advance_obsolete", `取消后应当被围栏拒掉，实际 ${error.code}：${error.message}`);
    return true;
  });
  assert.deepEqual(await ledger(), before, "被拒的读取同样不碰账本");
  await advance.release(false);
});


test("the notebook overview button atomically accepts one Agent Run and completes from a real receipt without a planning call", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId }, requestId = randomUUID();
  const input = { requestId, noteVersionId: f.input.noteVersionId };
  const accepted = await startNoteOverviewTask(scope, f.input.noteId, input);
  assert.ok(accepted.agentRunId);
  const repeated = await startNoteOverviewTask(scope, f.input.noteId, input);
  assert.equal(repeated.agentRunId, accepted.agentRunId);
  assert.equal(repeated.taskId, accepted.taskId);
  const [created] = await admin`SELECT r.direct_request,r.model_calls,count(o.id)::int AS operations FROM agent_runs r
    JOIN agent_operations o ON o.run_id=r.id WHERE r.id=${accepted.agentRunId!} GROUP BY r.id`;
  assert.equal(created.model_calls, 0);
  assert.equal(created.operations, 1);
  assert.equal(created.direct_request.capability, "note_overview_generate");
  await admin`INSERT INTO note_overviews(workspace_id,user_id,note_id,note_version_id,body,source_references,generation_job_id)
    VALUES(${scope.workspaceId},${scope.userId},${f.input.noteId},${f.input.noteVersionId},'光能用于制造有机物。',
      '[{"blockOrdinal":1,"quote":"叶绿体利用光能制造有机物。"}]'::jsonb,${accepted.taskId})`;
  await admin`UPDATE jobs SET status='succeeded',finished_at=now() WHERE id=${accepted.taskId}`;
  const rootLease = await lease(scope, accepted.agentRunId!);
  await runAgentAdvance({ ...rootLease, payload: { runId: accepted.agentRunId, revision: 1 } });
  const finished = await api.get(scope, accepted.agentRunId!);
  assert.equal(finished.status, "completed");
  assert.equal(finished.modelCalls, 0);
  assert.equal(finished.artifacts[0]?.kind, "note_overview");
  const steps = await admin`SELECT execution_kind FROM agent_run_steps WHERE run_id=${accepted.agentRunId!}`;
  assert.equal(steps.length, 1);
  assert.equal(steps[0].execution_kind, "declared_request");
});

test("selected demonstration and expansion buttons preserve their validated anchors under their own Agent Run", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const anchor = { noteVersionId: f.input.noteVersionId, startBlockOrdinal: 1, endBlockOrdinal: 1,
    startOffset: 0, endOffset: 15, excerpt: "叶绿体利用光能制造有机物。", prefix: "", suffix: "" };
  anchor.endOffset = anchor.excerpt.length;
  const demo = await startNoteLearningArtifactTask(scope, f.input.noteId, { noteVersionId: f.input.noteVersionId,
    requestId: randomUUID(), sourceKind: "annotation", selectionAnchor: anchor });
  const expansion = await startNoteExpansionTask(scope, f.input.noteId, { noteVersionId: f.input.noteVersionId,
    requestId: randomUUID(), focusAnchor: anchor });
  assert.ok(demo.agentRunId && expansion.agentRunId);
  assert.notEqual(demo.agentRunId, expansion.agentRunId);
  const [demoJob] = await admin`SELECT payload FROM jobs WHERE id=${demo.taskId}`;
  const [expansionJob] = await admin`SELECT payload FROM jobs WHERE id=${expansion.taskId}`;
  assert.deepEqual(demoJob.payload.anchor, anchor);
  assert.equal(demoJob.payload.sourceKind, "annotation");
  assert.deepEqual(expansionJob.payload.focusAnchor, anchor);
  assert.equal(demoJob.payload.agentRunId, demo.agentRunId);
  assert.equal(expansionJob.payload.agentRunId, expansion.agentRunId);
  const before = await admin`SELECT count(*)::int AS n FROM agent_runs WHERE user_id=${scope.userId}`;
  await assert.rejects(startNoteLearningArtifactTask(scope, f.input.noteId, { noteVersionId: f.input.noteVersionId,
    requestId: randomUUID(), sourceKind: "annotation", selectionAnchor: { ...anchor, excerpt: "伪造选区" } }), /选中的原句/);
  const after = await admin`SELECT count(*)::int AS n FROM agent_runs WHERE user_id=${scope.userId}`;
  assert.equal(after[0].n, before[0].n, "invalid material creates neither a Run nor an operation");
});

test("the card button keeps the complete domain options and its original review Run while owning it through Agent", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const body = { version: 2 as const, noteVersionId: f.input.noteVersionId, sourceScope: { kind: "whole_note" as const },
    learningGoal: "apply" as const, detailThreshold: "deep" as const, quantity: { kind: "adaptive" as const, hardMaxCards: 19 },
    preferredStrategies: [], clientRequestId: randomUUID() };
  const key = randomUUID();
  const accepted = await createGenerationRunV2(scope, f.input.noteVersionId, body, key);
  assert.ok(accepted.agentRunId);
  const replay = await createGenerationRunV2(scope, f.input.noteVersionId, body, key);
  assert.equal(replay.runId, accepted.runId);
  assert.equal(replay.agentRunId, accepted.agentRunId);
  const [stored] = await admin`SELECT r.direct_request,r.model_calls,o.card_generation_run_id,o.card_generation_outbox_id
    FROM agent_runs r JOIN agent_operations o ON o.run_id=r.id WHERE r.id=${accepted.agentRunId!}`;
  assert.deepEqual(stored.direct_request.request, body);
  assert.equal(stored.card_generation_run_id, accepted.runId);
  assert.ok(stored.card_generation_outbox_id);
  assert.equal(stored.model_calls, 0);
  await assert.rejects(createGenerationRunV2(scope, f.input.noteVersionId,
    { ...body, quantity: { kind: "adaptive", hardMaxCards: 8 } }, key), /另一份设置/);
});

test("manual page generation survives Companion off/read-only while cancellation, epochs and autonomous authority stay enforced", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  await admin`INSERT INTO user_companion_account_state(user_id,global_enabled,agent_settings)
    VALUES(${scope.userId},false,'{"version":1,"permissionLevel":"read_only"}')`;
  const accepted = await startNoteOverviewTask(scope, f.input.noteId,
    { noteVersionId: f.input.noteVersionId, requestId: randomUUID() });
  assert.ok(accepted.agentRunId);
  await workerPorts.transaction(scope, async tx => {
    const rows = await tx.execute(query`SELECT astella_agent_job_current(${accepted.taskId}::uuid,${scope.workspaceId}::uuid,${scope.userId}::uuid,false) AS allowed`);
    assert.equal(rows[0].allowed, true, "the explicitly chosen capability is still authorized");
  });
  await assert.rejects(api.create(scope, { requestId: randomUUID(), goal: "自选动作", inputs: [f.input] }), /伴星当前已关闭/);
  await api.control(scope, accepted.agentRunId!, 1, "cancel");
  await workerPorts.transaction(scope, async tx => {
    const rows = await tx.execute(query`SELECT astella_agent_job_current(${accepted.taskId}::uuid,${scope.workspaceId}::uuid,${scope.userId}::uuid,false) AS allowed`);
    assert.equal(rows[0].allowed, false);
  });
  const next = await startNoteOverviewTask(scope, f.input.noteId,
    { noteVersionId: f.input.noteVersionId, requestId: randomUUID() });
  await admin`UPDATE user_companion_account_state SET epoch=epoch+1 WHERE user_id=${scope.userId}`;
  await workerPorts.transaction(scope, async tx => {
    const rows = await tx.execute(query`SELECT astella_agent_job_current(${next.taskId}::uuid,${scope.workspaceId}::uuid,${scope.userId}::uuid,false) AS allowed`);
    assert.equal(rows[0].allowed, false, "account revocation invalidates even a direct request");
  });
});
