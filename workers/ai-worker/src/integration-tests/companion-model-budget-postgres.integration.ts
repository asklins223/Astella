import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import postgres from "postgres";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { readRunMeta, reserveCompanionProviderCall } from "../handlers/agent/companion-agent-events.ts";
import { resolveAgentTurnInterpretation } from "@astella/agent-core";
import { closeDatabase, withWorkerWorkspaceTransaction } from "../db.ts";
import { memorySourceHasActionProposal } from "../handlers/memory/companion-memory-extractor.ts";
import { writeBatchedDeltas } from "../handlers/turn/companion-dialogue-deltas.ts";
import { CompanionContextChangedError } from "../lib/non-retryable-errors.ts";
import { createHash } from "node:crypto";
import { canonicalJsonV1 } from "@astella/shared/content-hash";
import { persistCompanionContextHandoffSnapshot } from "../handlers/turn/companion-dialogue-store.ts";
import { encodeCompanionToolResult } from "../handlers/agent/companion-runtime-checkpoint.ts";
import { loadContinuation } from "../handlers/tools/companion-tool-call-ledger.ts";
import type { AgentEventContext } from "../handlers/tools/companion-read-tools.ts";
import { companionCapabilityOfferedInHostContext, resolveAllCompanionAgentTools, type AgentTurnRequest } from "@astella/shared";
import type { CompanionAgentLoopArgs } from "../contracts/companion-agent-loop.ts";
import { openCompanionTurn, companionRecoveryIdentity } from "../handlers/turn/companion-turn-opening.ts";
import { resolveCompanionEntryMode } from "../handlers/turn/companion-entry-mode.ts";
import { companionRuntimeStateSchema, encodeCompanionRuntimeCheckpoint } from "../handlers/agent/companion-runtime-checkpoint.ts";
import type { ReadContext } from "../handlers/turn/companion-dialogue-store.ts";
import { runCompanionAgentLoop } from "../handlers/agent/companion-agent-runtime.ts";
import { MockProvider } from "../lib/providers/mock.ts";
import { CompanionRunInactiveError } from "../handlers/turn/companion-dialogue-store.ts";
import { withCompanionRecoveryTransaction, withCompanionReceiptTransaction } from "../handlers/agent/companion-runtime-checkpoint.ts";

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
  return { event, mutate, conversationId, count: async () => Number((await mutate(tx => tx`SELECT model_call_count FROM companion_turn_runs WHERE id=${runId}`))[0].model_call_count),
    cleanup: () => mutate(async tx => {
      await tx`SET LOCAL app.allow_history_mutation = 'on'`;
      await tx`DELETE FROM companion_agent_tool_calls WHERE run_id=${runId}`;
      await tx`DELETE FROM companion_action_proposals WHERE conversation_id=${conversationId}`;
      await tx`DELETE FROM agent_runs WHERE workspace_id=${workspaceId} AND user_id=${userId}`;
      await tx`DELETE FROM companion_turn_runs WHERE id=${runId}`;
      await tx`DELETE FROM companion_messages WHERE conversation_id=${conversationId}`;
      await tx`DELETE FROM companion_conversations WHERE id=${conversationId}`;
      await tx`DELETE FROM jobs WHERE workspace_id=${workspaceId}`;
      await tx`DELETE FROM assistant_memory_items WHERE workspace_id=${workspaceId}`;
      await tx`DELETE FROM user_companion_account_state WHERE user_id=${userId}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id=${workspaceId}`;
      await tx`DELETE FROM workspaces WHERE id=${workspaceId}`;
      await tx`DELETE FROM users WHERE id=${userId}`;
    }) };
}

for (const status of ["cancel_requested", "cancelled", "superseded", "succeeded", "failed"]) {
  test(`a ${status} run stops recovery without losing ownership of factual receipts`, async () => {
    const f = await fixture();
    const event = { ...f.event,
      read: { ...f.event.read, conversationId: f.conversationId } as ReadContext,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), constraints: { visionEnabled: false } };
    try {
      assert.equal(await withCompanionRecoveryTransaction(event, async () => "active"), "active");
      await f.mutate(tx => tx`UPDATE companion_turn_runs SET status=${status} WHERE id=${event.read.runId}`);
      let executions = 0;
      await assert.rejects(withCompanionRecoveryTransaction(event, async () => { executions++; }),
        error => error instanceof CompanionRunInactiveError && error.status === status);
      assert.equal(executions, 0);
      assert.equal(await withCompanionReceiptTransaction(event, async () => "existing receipt"), "existing receipt");
      assert.equal(await f.count(), 0);
      const [run] = await f.mutate(tx => tx`SELECT status,error_code FROM companion_turn_runs WHERE id=${event.read.runId}`);
      assert.equal(run.status, status);
      assert.equal(run.error_code, null);
    } finally { await f.cleanup(); }
  });
}

test("search-only citation drafts are corrected before either final channel publishes or executes", async () => {
  for (const channel of ["plain", "finish"] as const) {
    const f = await fixture();
    const provider = new MockProvider();
    Object.defineProperty(provider, "chatCompletionStream", { value: undefined });
    let calls = 0;
    const corrected = "这次尚未读取原网页，暂时不能核实这个结论。";
    provider.executeAgentTurn = async request => {
      if (calls++ === 0) return { content: channel === "plain" ? "未经原文核对的结论。[^web-unread]" : "",
        toolCalls: channel === "plain" ? [] : [{ id: "unread-finish", name: "companion_finish",
          arguments: { text: "未经原文核对的结论。[^web-unread]" } }],
        finishReason: channel === "plain" ? "stop" : "tool_calls", usage: { promptTokens: 10, completionTokens: 10 }, providerRequestId: null };
      assert.ok(JSON.stringify(request.messages).includes("https://example.com/unread"));
      assert.ok(JSON.stringify(request.messages).includes("真实读取回执"));
      return { content: corrected, toolCalls: [], finishReason: "stop", usage: { promptTokens: 10, completionTokens: 10 }, providerRequestId: null };
    };
    const read: ReadContext = { ...f.event.read, conversationId: f.conversationId,
      userMessageId: (await f.mutate(tx => tx`SELECT user_message_id FROM companion_turn_runs WHERE id=${f.event.read.runId}`))[0]!.user_message_id,
      runStatus: "running", livePageView: null, pageContext: null, userText: "核对原网页 https://example.com/unread 后简短回答并引用。",
      recentMessages: [], residentMemories: [], memoryDirectory: [], playbookCatalog: [], playbookCandidates: [], deliveryObservation: null,
      organizationSurface: null, memoryRefs: [], hereAndNow: null, thisTurnFacts: null, factSpans: null, conversationSummary: null,
      personaProfileRevision: 0, personaExamplesRevision: 0, defaultExpressionVersion: "test", petProfile: null, nextMessageSeq: 2, nextEventSeq: 1 };
    const args: CompanionAgentLoopArgs = { ctx: f.event.ctx, read, provider, toolConstraints: { visionEnabled: false },
      baseMessages: [{ role: "user", content: read.userText }],
      onProviderDelta: async () => { assert.fail("An unverified citation must never stream before correction"); },
      expiresAt: new Date(Date.now() + 60_000).toISOString() };
    // Native tool exchanges belong to the private checkpoint, never to the
    // public dialogue's ChatMessage history. Resume a controlled search receipt.
    const opening = openCompanionTurn(args);
    const meta = await readRunMeta(f.event);
    const definitions = resolveAllCompanionAgentTools(meta.permissionLevel,
      { visionEnabled: false, webSearchEnabled: false, noteLibraryReadEnabled: true })
      .filter(definition => companionCapabilityOfferedInHostContext(definition,
        { writingAnnotation: false, completeNoteReply: false, initiative: false }));
    const checkpoint = encodeCompanionRuntimeCheckpoint(companionRecoveryIdentity({ args, currentRequest: opening.currentRequest,
      permissionLevel: meta.permissionLevel, definitions, primary: provider, fallback: null }), { phase: "continue",
      state: companionRuntimeStateSchema.parse({ messages: [...opening.messages,
        { role: "assistant", content: "", toolCalls: [{ id: "search", name: "companion_web", arguments: { action: "search", query: "original source" } }] },
        { role: "tool", toolCallId: "search", content: JSON.stringify({ ok: true, operation: "web.search", data: { sources: [
          { referenceId: "web-unread", citationMarker: "[^web-unread]", title: "A located source", url: "https://example.com/unread" }] } }) }],
        compactedEvidence: [], stepCount: 1, toolCallCount: 1, elapsedMs: 0, visibleSegments: [], visibleSegmentDelivered: [], richBlocks: [],
        webSearchCalls: 1, historyFoldApplied: false, invalidArgumentCalls: [], rejectedExecutionConstraints: [], degenerateRetried: false,
        outputRepairToolCount: null, actionSteerAttempts: 0, quoteCorrectionUsed: false, lookupClaimSteered: false,
        steerSwapToFallback: false, utterancePublished: false, entryMode: resolveCompanionEntryMode() }) });
    try {
      await f.mutate(async tx => {
        await tx`UPDATE companion_turn_runs SET step_count=1,tool_call_count=1 WHERE id=${read.runId}`;
        await tx`INSERT INTO companion_agent_steps(id,workspace_id,user_id,conversation_id,run_id,step_no,kind,status,request_hash,runtime_checkpoint)
          VALUES(${randomUUID()},${f.event.ctx.workspaceId},${read.userId},${read.conversationId},${read.runId},1,'model','succeeded',${'0'.repeat(64)},${tx.json(checkpoint)})`;
      });
      const result = await runCompanionAgentLoop(args);
      assert.equal(result.status, "completed");
      if (result.status === "completed") assert.equal(result.text, corrected);
      assert.equal(calls, 2);
      assert.equal((await f.mutate(tx => tx`SELECT 1 FROM companion_agent_tool_calls WHERE run_id=${read.runId}`)).length, 0);
      assert.equal((await f.mutate(tx => tx`SELECT 1 FROM companion_agent_steps WHERE run_id=${read.runId} AND error_code='READ_EVIDENCE_MISSING'`)).length, 1);
    } finally {
      await f.mutate(async tx => { await tx`DELETE FROM companion_agent_steps WHERE run_id=${read.runId}`; await tx`DELETE FROM companion_stream_events WHERE run_id=${read.runId}`; });
      await f.cleanup();
    }
  }
});

test("turn attention reads real conversation goals as candidates and round-trips its current interpretation", async () => {
  const f = await fixture(), other = await fixture();
  const goalIds = [randomUUID(), randomUUID()];
  const scope = { workspaceId: f.event.ctx.workspaceId, userId: f.event.read.userId };
  try {
    const empty = await readRunMeta(f.event);
    assert.deepEqual(empty.relatedGoals, []);
    assert.equal(empty.turnInterpretation, undefined);
    const insertGoal = (owner: typeof f, goalId: string, conversationId: string | null) => owner.mutate(tx => tx`
      INSERT INTO agent_runs(id,workspace_id,user_id,identity_id,account_epoch,request_id,conversation_id,goal)
      SELECT ${goalId},${owner.event.ctx.workspaceId},${owner.event.read.userId},id,epoch,${randomUUID()},${conversationId},'回归任务'
      FROM user_companion_account_state WHERE user_id=${owner.event.read.userId}`);
    for (const id of goalIds) await insertGoal(f, id, f.conversationId);
    await insertGoal(f, randomUUID(), null);
    await insertGoal(other, randomUUID(), f.conversationId);
    const related = await readRunMeta(f.event);
    assert.deepEqual(new Set(related.relatedGoals?.map(goal => goal.id)), new Set(goalIds),
      "multiple owned goals remain candidates; an unbound or foreign goal is excluded");
    const attention = resolveAgentTurnInterpretation({ intent: 'conversation', toolUse: 'none',
      subjects: [{ description: '泡茶休息' }], goalRelation: 'unrelated', candidateOperations: [], ambiguities: [],
      voiceStyle: { decision: 'none', instruction: null } },
      { requestHash: '1'.repeat(64), objects: related.relatedGoals ?? [], capabilities: [] });
    await f.mutate(tx => tx`UPDATE companion_turn_runs SET turn_interpretation=${tx.json(attention)}
      WHERE id=${f.event.read.runId} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId}`);
    const restored = await readRunMeta(f.event);
    assert.deepEqual(restored.turnInterpretation, attention);
    assert.equal(restored.turnInterpretation?.goalReference, null,
      "conversation context does not silently bind a candidate goal to small talk");
  } finally { await other.cleanup(); await f.cleanup(); }
});

test("explicit memory actions own their immutable source even after rejection, expiry or completion", async () => {
  const f = await fixture();
  const scope = { workspaceId: f.event.ctx.workspaceId, userId: f.event.read.userId };
  const [source] = await f.mutate(tx=>tx`SELECT user_message_id FROM companion_turn_runs WHERE id=${f.event.read.runId}`);
  const check = (messageId: string) => withWorkerWorkspaceTransaction(scope,
    tx=>memorySourceHasActionProposal(tx, scope, messageId));
  try {
    assert.equal(await check(source.user_message_id), false, "ordinary conversation keeps its automatic admission path");
    const proposalId = randomUUID();
    await f.mutate(tx=>tx`INSERT INTO companion_action_proposals(id,workspace_id,user_id,conversation_id,
      source_message_id,source_generation,payload,payload_sha256,title,target_summary,impact_summary,status,
      idempotency_key_hash,expires_at)
      VALUES(${proposalId},${scope.workspaceId},${scope.userId},${f.conversationId},${source.user_message_id},1,
        ${tx.json({kind:'save_memory',memoryKind:'preference',content:'解释先举例'})},${'c'.repeat(64)},'回归','回归','回归',
        'pending',${'d'.repeat(64)},now()+interval '5 minutes')`);
    for (const status of ['pending','rejected','expired','failed','succeeded']) {
      await f.mutate(tx=>tx`UPDATE companion_action_proposals SET status=${status} WHERE id=${proposalId}`);
      assert.equal(await check(source.user_message_id), true, status);
    }
    assert.equal(await check(randomUUID()), false, "the fence is for the immutable source, not all future preferences");
    await f.mutate(tx=>tx`UPDATE companion_action_proposals SET payload='{"kind":"navigate"}'::jsonb WHERE id=${proposalId}`);
    assert.equal(await check(source.user_message_id), false, "a navigation proposal does not seize memory admission");
  } finally { await f.cleanup(); }
});

test("默认模型计数只记实际调用，不用旧次数上限截断并发任务", async () => {
  const saved = process.env.WORKER_COMPANION_MAX_MODEL_CALLS;
  delete process.env.WORKER_COMPANION_MAX_MODEL_CALLS;
  const f = await fixture();
  try {
    const results = await Promise.allSettled(Array.from({ length: 40 }, () => reserveCompanionProviderCall(f.event)));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 40);
    assert.equal(await f.count(), 40);
  } finally {
    if (saved === undefined) delete process.env.WORKER_COMPANION_MAX_MODEL_CALLS;
    else process.env.WORKER_COMPANION_MAX_MODEL_CALLS = saved;
    await f.cleanup();
  }
});

test("显式配置的模型调用上限原子执行，确认续跑不重置已用次数", async () => {
  const saved = process.env.WORKER_COMPANION_MAX_MODEL_CALLS;
  process.env.WORKER_COMPANION_MAX_MODEL_CALLS = "12";
  const f = await fixture();
  try {
    const results = await Promise.allSettled(Array.from({length:13},()=>reserveCompanionProviderCall(f.event)));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,12);
    assert.equal(await f.count(),12);
    const continuation = randomUUID();
    await f.mutate(async tx => {
      await tx`INSERT INTO jobs(id,type,workspace_id,requested_by,payload,status,lease_token,started_at)
        VALUES(${continuation},'companion_agent',${f.event.ctx.workspaceId},${f.event.read.userId},
          ${tx.json({runId:f.event.read.runId,proposalId:randomUUID()})},'running','continuation',now())`;
      await tx`UPDATE companion_turn_runs SET status='accepted' WHERE id=${f.event.read.runId}`;
    });
    const resumed = {...f.event,ctx:{...f.event.ctx,id:continuation,leaseToken:'continuation'}};
    await assert.rejects(()=>reserveCompanionProviderCall(resumed),/budget exhausted/);
    await f.mutate(tx=>tx`UPDATE companion_turn_runs SET model_call_count=2 WHERE id=${f.event.read.runId}`);
    await reserveCompanionProviderCall(resumed);
    assert.equal(await f.count(),3,"the legitimate continuation may call, retaining prior use");
  } finally {
    if (saved === undefined) delete process.env.WORKER_COMPANION_MAX_MODEL_CALLS;
    else process.env.WORKER_COMPANION_MAX_MODEL_CALLS = saved;
    await f.cleanup();
  }
});

async function memorySnapshot(f: Awaited<ReturnType<typeof fixture>>, versioned = true) {
  const memoryId = randomUUID();
  const { workspaceId } = f.event.ctx, { userId, runId } = f.event.read;
  await f.mutate(async tx => {
    await tx`INSERT INTO assistant_memory_items(id,workspace_id,user_id,kind,content,user_stated,user_confirmed,candidate,
      source_type,author_type,author_id,epistemic_status,budget_tier)
      VALUES(${memoryId},${workspaceId},${userId},'preference','解释时先举例',true,true,false,
        'user_stated','user',${userId},'supported','resident')`;
    const [memory] = await tx`SELECT revision FROM assistant_memory_items WHERE id=${memoryId}`;
    const snapshot = { version:1,runId,conversationId:f.conversationId,
      memoryRefs:[{memoryId,kind:'preference',content:'解释时先举例'}],memoryDirectory:[],
      ...(versioned?{memorySourceVersions:[{memoryId,revision:Number(memory.revision)}]}:{}) };
    await tx`INSERT INTO companion_context_handoff_snapshots(run_id,workspace_id,user_id,conversation_id,snapshot,snapshot_sha256,snapshot_version)
      VALUES(${runId},${workspaceId},${userId},${f.conversationId},${tx.json(snapshot)},
        ${createHash('sha256').update(canonicalJsonV1(snapshot)).digest('hex')},1)`;
  });
  return memoryId;
}

test("current memory version permits calls; exposure bookkeeping is harmless, correction blocks old replay before charging", async () => {
  const f = await fixture();
  try {
    const memoryId = await memorySnapshot(f);
    await reserveCompanionProviderCall(f.event);
    await f.mutate(tx=>tx`UPDATE assistant_memory_items SET last_used_at=now() WHERE id=${memoryId}`);
    await reserveCompanionProviderCall(f.event);
    assert.equal(await f.count(),2);
    await f.mutate(tx=>tx`UPDATE assistant_memory_items SET content='改成直接给公式' WHERE id=${memoryId}`);
    await assert.rejects(()=>reserveCompanionProviderCall(f.event),CompanionContextChangedError);
    assert.equal(await f.count(),2,"a withdrawn prompt never spends another provider call");
  } finally { await f.cleanup(); }
});

test("confirmed own memory writes resume the frozen snapshot; external changes and unsuccessful receipts still fence it", async () => {
  for (const action of ["forget", "revise"] as const) {
    const f = await fixture();
    const { workspaceId } = f.event.ctx, { userId, runId } = f.event.read;
    try {
      const memoryId = await memorySnapshot(f);
      const [saved] = await f.mutate(tx => tx`SELECT snapshot,snapshot_sha256 FROM companion_context_handoff_snapshots WHERE run_id=${runId}`);
      const replay = () => persistCompanionContextHandoffSnapshot({ workspaceId, userId, runId,
        snapshot: saved!.snapshot, sha256: saved!.snapshot_sha256 });
      await replay();
      await f.mutate(async tx => {
        const stepId = randomUUID();
        await tx`INSERT INTO companion_agent_steps(id,workspace_id,user_id,conversation_id,run_id,step_no,kind,status)
          VALUES(${stepId},${workspaceId},${userId},${f.conversationId},${runId},1,'model','succeeded')`;
        await tx`INSERT INTO companion_agent_tool_calls(id,workspace_id,user_id,conversation_id,run_id,step_id,tool_call_id,
          name,tool_version,arguments,arguments_sha256,risk_class,status,result_payload)
          VALUES(${randomUUID()},${workspaceId},${userId},${f.conversationId},${runId},${stepId},'confirmed-memory-write',
            ${'memory.write.'+action},'1.0.0',${tx.json({ memoryId })},${'a'.repeat(64)},'irreversible','failed',
            ${tx.json(encodeCompanionToolResult({value:{memoryId,revision:2},safeSummary:'confirmed write'}))})`;
        if (action === "forget") await tx`UPDATE assistant_memory_items SET deleted_at=now() WHERE id=${memoryId}`;
        else await tx`UPDATE assistant_memory_items SET content='修订后的偏好' WHERE id=${memoryId}`;
      });
      await assert.rejects(replay, CompanionContextChangedError, "an unsuccessful receipt cannot authorize changed sources");
      await f.mutate(tx => tx`UPDATE companion_agent_tool_calls SET status='succeeded' WHERE run_id=${runId}`);
      const restored = await replay();
      assert.deepEqual(restored.snapshot, saved!.snapshot, "the original prompt remains frozen, including its hash");
      await reserveCompanionProviderCall(f.event);
      assert.equal(await f.count(), 1);
      // A later user correction/withdrawal is not covered by this action.
      if (action === "revise") {
        await f.mutate(tx => tx`UPDATE assistant_memory_items SET content='用户又修改了偏好' WHERE id=${memoryId}`);
        await assert.rejects(replay, CompanionContextChangedError);
        await assert.rejects(() => reserveCompanionProviderCall(f.event), CompanionContextChangedError);
        assert.equal(await f.count(), 1);
      }
    } finally { await f.cleanup(); }
  }
});

test("a confirmed continuation accepts registered flat/domain aliases and rejects a different operation or call id", async () => {
  const f = await fixture();
  const { workspaceId } = f.event.ctx, { userId, runId } = f.event.read;
  const stepId = randomUUID(), proposalId = randomUUID(), memoryId = randomUUID(), callId = "confirmed-forget";
  try {
    await f.mutate(async tx => {
      await tx`INSERT INTO companion_agent_steps(id,workspace_id,user_id,conversation_id,run_id,step_no,kind,status)
        VALUES(${stepId},${workspaceId},${userId},${f.conversationId},${runId},1,'model','waiting')`;
      await tx`INSERT INTO companion_agent_tool_calls(id,workspace_id,user_id,conversation_id,run_id,step_id,tool_call_id,
        name,tool_version,arguments,arguments_sha256,risk_class,status,proposal_id,result_payload)
        VALUES(${randomUUID()},${workspaceId},${userId},${f.conversationId},${runId},${stepId},${callId},'memory.write.forget',
          '1.0.0',${tx.json({memoryId})},${'a'.repeat(64)},'reversible_low','succeeded',${proposalId},
          ${tx.json(encodeCompanionToolResult({value:{memoryId},safeSummary:'已忘掉'}))})`;
      await tx`INSERT INTO companion_action_proposals(id,workspace_id,user_id,conversation_id,source_message_id,source_generation,
        payload,payload_sha256,title,target_summary,impact_summary,status,decision,idempotency_key_hash,expires_at)
        SELECT ${proposalId},${workspaceId},${userId},${f.conversationId},user_message_id,1,'{"kind":"agent_tool_review"}',
          ${'b'.repeat(64)},'忘记记忆','测试记忆','删除这条记忆','succeeded','confirm',${'c'.repeat(64)},now()+interval '1 hour'
        FROM companion_turn_runs WHERE id=${runId}`;
    });
    const event: AgentEventContext = { ctx: f.event.ctx,
      read: { ...f.event.read, conversationId: f.conversationId } as AgentEventContext['read'],
      expiresAt: new Date(Date.now()+60_000).toISOString(), constraints: {} };
    const replay = (name: string, args: Record<string, unknown>, id = callId) => loadContinuation(event, [
      {role:'assistant',content:'',toolCalls:[{id,name,arguments:args}]},
      {role:'tool',toolCallId:id,content:'{"status":"waiting_confirmation"}'},
    ] as AgentTurnRequest['messages'], proposalId, Infinity, {pendingCallId:id,onExecution:()=>{}});
    for (const [name,args] of [
      ['companion_memory_forget',{memoryId}], ['companion_memory_write',{action:'forget',memoryId}],
      ['memory.write.forget',{memoryId}],
    ] as const) {
      const restored = await replay(name,args);
      assert.equal(JSON.parse(String(restored[1]!.content)).ok, true, name);
    }
    await assert.rejects(() => replay('companion_memory_write',{action:'save',content:'other operation'}), CompanionContextChangedError);
    await assert.rejects(() => replay('companion_memory_forget',{memoryId},'different-call'), CompanionContextChangedError);
  } finally { await f.cleanup(); }
});

test("archive/delete/expiry and unversioned snapshots block provider and buffered delivery, with no stale delta committed", async () => {
  for(const mutation of ['archive','delete','expire','unversioned'] as const) {
    const f = await fixture();
    try {
      const memoryId = await memorySnapshot(f,mutation!=='unversioned');
      if(mutation==='archive')await f.mutate(tx=>tx`UPDATE assistant_memory_items SET archived_at=now() WHERE id=${memoryId}`);
      if(mutation==='delete')await f.mutate(tx=>tx`UPDATE assistant_memory_items SET deleted_at=now() WHERE id=${memoryId}`);
      if(mutation==='expire')await f.mutate(tx=>tx`UPDATE assistant_memory_items SET valid_from=now()-interval '2 days',valid_until=now()-interval '1 day' WHERE id=${memoryId}`);
      await assert.rejects(()=>reserveCompanionProviderCall(f.event),CompanionContextChangedError,mutation);
      await assert.rejects(()=>writeBatchedDeltas({assistantText:'旧偏好下的回答。',ctx:f.event.ctx,
        read:{...f.event.read,conversationId:f.conversationId},expiresAt:new Date(Date.now()+60000).toISOString(),
        notifyCompanionEvent:async()=>{throw new Error('No stale event may be notified');}}),CompanionContextChangedError,mutation);
      assert.equal(await f.count(),0);
      const [events]=await f.mutate(tx=>tx`SELECT count(*)::int AS n FROM companion_stream_events WHERE run_id=${f.event.read.runId}`);
      assert.equal(Number(events.n),0);
    } finally { await f.cleanup(); }
  }
});

test("cancel, epoch, generation, job identity and lease fences reject before increment", async () => {
  const f = await fixture();
  try {
    await f.mutate(tx=>tx`UPDATE companion_turn_runs SET status='cancel_requested' WHERE id=${f.event.read.runId}`);
    await assert.rejects(()=>reserveCompanionProviderCall(f.event));
    await f.mutate(tx=>tx`UPDATE companion_turn_runs SET status='running' WHERE id=${f.event.read.runId}`);
    await assert.rejects(()=>reserveCompanionProviderCall({...f.event,read:{...f.event.read,accountEpoch:1}}));
    await assert.rejects(()=>reserveCompanionProviderCall({...f.event,read:{...f.event.read,generation:2}}));
    await assert.rejects(()=>reserveCompanionProviderCall({...f.event,ctx:{...f.event.ctx,leaseToken:'old'}}));
    await f.mutate(tx=>tx`UPDATE jobs SET payload='{}'::jsonb WHERE id=${f.event.ctx.id}`);
    await assert.rejects(()=>reserveCompanionProviderCall(f.event));
    assert.equal(await f.count(),0);
  } finally { await f.cleanup(); }
});
