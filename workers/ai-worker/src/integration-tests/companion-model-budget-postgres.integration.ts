import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import postgres from "postgres";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";
import { readRunMeta, reserveCompanionProviderCall } from "../handlers/companion-agent-events.ts";
import { resolveAgentTurnInterpretation } from "@ailearn/agent-core";
import { closeDatabase, withWorkerWorkspaceTransaction } from "../db.ts";
import { memorySourceHasActionProposal } from "../handlers/companion-memory-extractor.ts";
import { writeBatchedDeltas } from "../handlers/companion-dialogue-deltas.ts";
import { CompanionContextChangedError } from "../lib/non-retryable-errors.ts";
import { createHash } from "node:crypto";

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
      subjects: [{ description: '泡茶休息' }], goalRelation: 'unrelated', candidateOperations: [], ambiguities: [] },
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

test("parallel calls share the persistent turn ceiling; a confirmation continuation does not reset it", async () => {
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
  } finally { await f.cleanup(); }
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
        ${createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')},1)`;
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
