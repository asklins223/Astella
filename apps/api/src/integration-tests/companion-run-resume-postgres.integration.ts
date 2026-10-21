import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { sha256Utf8V1 } from "@astella/shared/content-hash";
import { companionStreamEventV1Schema } from "@astella/shared";
import { fixture, closeFixtureDatabase } from "../../../../workers/ai-worker/src/live-tests/runtime-fixture.ts";
import { resumeCompanionRun as resumeRun } from "../modules/companion-conversation/turn/companion-resume.ts";
import { closeDatabase, withWorkspaceTransaction } from "../db/client.ts";

after(async () => { await closeFixtureDatabase(); await closeDatabase(); });
const resumeCompanionRun: typeof resumeRun = async args => {
  try { return await resumeRun(args); }
  catch (error) {
    if (error instanceof Error && error.cause instanceof Error) console.error("database cause:", error.cause.message);
    throw error;
  }
};

test("resume is one atomic replacement job, keeps the user request, and retires the old lease", async () => {
  const f = await fixture();
  try {
    await f.mutate(async tx => {
      await tx`UPDATE companion_messages SET client_message_id=${randomUUID()} WHERE id=${f.messageId}`;
      await tx`UPDATE companion_turn_runs SET status='failed',error_code='PROVIDER_IDLE_TIMEOUT',last_event_seq=7 WHERE id=${f.event.read.runId}`;
      await tx`UPDATE companion_conversations SET next_event_seq=8 WHERE id=${f.conversationId}`;
    });
    const request = { workspaceId: f.event.ctx.workspaceId, userId: f.event.read.userId, runId: f.event.read.runId,
      body: { version: 1, generation: 1, expectedEventCursor: 7 } };
    const results = await Promise.all([resumeCompanionRun(request), resumeCompanionRun(request)]);
    assert.deepEqual(results.map(item => item.statusCode).sort(), [200, 202]);
    const [run] = await f.mutate(tx => tx`SELECT * FROM companion_turn_runs WHERE id=${f.event.read.runId}`);
    assert.equal(run.status, "accepted"); assert.equal(run.user_message_id, f.messageId); assert.equal(run.generation, 1);
    assert.notEqual(run.job_id, f.event.ctx.id);
    const [old] = await f.mutate(tx => tx`SELECT status,lease_token FROM jobs WHERE id=${f.event.ctx.id}`);
    assert.equal(old.status, "dead"); assert.equal(old.lease_token, null);
    const [messages] = await f.mutate(tx => tx`SELECT count(*)::int AS n FROM companion_messages WHERE conversation_id=${f.conversationId} AND role='user'`);
    assert.equal(messages.n, 1);
    const [event] = await f.mutate(tx => tx`SELECT * FROM companion_stream_events WHERE run_id=${run.id} ORDER BY seq DESC LIMIT 1`);
    const parsed = companionStreamEventV1Schema.safeParse({ version: 1, conversationId: f.conversationId, runId: run.id,
      seq: Number(event.seq), generation: 1, type: event.type, payload: event.payload,
      workspaceId: request.workspaceId, accountEpoch: 0, createdAt: new Date(event.created_at).toISOString(), eventId: `${f.conversationId}:${event.seq}` });
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  } finally { await f.cleanup(); }
});

test("resume rejects a new topic, cancelled work, stale clicks, and missing checkpoints without creating jobs", async () => {
  const f = await fixture();
  const request = { workspaceId: f.event.ctx.workspaceId, userId: f.event.read.userId, runId: f.event.read.runId,
    body: { version: 1, generation: 1, expectedEventCursor: 7 } };
  try {
    await f.mutate(tx => tx`UPDATE companion_turn_runs SET status='failed',error_code='PROVIDER_UNAVAILABLE',last_event_seq=7,step_count=1 WHERE id=${request.runId}`);
    await assert.rejects(resumeCompanionRun(request), { code: "CONTEXT_STALE" });
    await f.mutate(tx => tx`UPDATE companion_turn_runs SET step_count=0,status='cancelled' WHERE id=${request.runId}`);
    await assert.rejects(resumeCompanionRun(request), { code: "ACTION_STALE" });
    await f.mutate(tx => tx`UPDATE companion_turn_runs SET status='failed',last_event_seq=8 WHERE id=${request.runId}`);
    await assert.rejects(resumeCompanionRun(request), { code: "STALE_GENERATION" });
    await f.mutate(async tx => {
      await tx`UPDATE companion_turn_runs SET last_event_seq=7 WHERE id=${request.runId}`;
      await tx`INSERT INTO companion_turn_runs(id,workspace_id,user_id,conversation_id,user_message_id,generation,status,idempotency_key_hash,request_body_hash)
        VALUES(${randomUUID()},${request.workspaceId},${request.userId},${f.conversationId},${f.messageId},2,'succeeded',${'d'.repeat(64)},${'e'.repeat(64)})`;
    });
    await assert.rejects(resumeCompanionRun(request), { code: "STALE_GENERATION" });
    const [jobs] = await f.mutate(tx => tx`SELECT count(*)::int AS n FROM jobs WHERE workspace_id=${request.workspaceId}`);
    assert.equal(jobs.n, 1);
  } finally { await f.cleanup(); }
});

test("lease retirement is API-only and rejects another actor, workspace or job", async () => {
  const f = await fixture(), other = await fixture();
  try {
    await f.mutate(tx => tx`UPDATE companion_turn_runs SET status='failed' WHERE id=${f.event.read.runId}`);
    const [acl] = await f.mutate(tx => tx`SELECT
      has_function_privilege('astella_api','astella_retire_companion_resume_job_v1(uuid,uuid)','EXECUTE') AS api,
      has_function_privilege('astella_worker','astella_retire_companion_resume_job_v1(uuid,uuid)','EXECUTE') AS worker`);
    assert.equal(acl.api, true); assert.equal(acl.worker, false);
    for (const scope of [
      { workspaceId: other.event.ctx.workspaceId, userId: other.event.read.userId },
      { workspaceId: f.event.ctx.workspaceId, userId: other.event.read.userId },
    ]) {
      const [result] = await withWorkspaceTransaction(scope, tx => tx.execute<{ allowed: boolean; actor: string }>(sql`
        SELECT astella_retire_companion_resume_job_v1(${f.event.read.runId},${f.event.ctx.id}) AS allowed,current_user AS actor`));
      assert.equal(result.actor, "astella_api"); assert.equal(result.allowed, false);
    }
    const [wrongJob] = await withWorkspaceTransaction({ workspaceId: f.event.ctx.workspaceId, userId: f.event.read.userId },
      tx => tx.execute<{ allowed: boolean }>(sql`SELECT astella_retire_companion_resume_job_v1(${f.event.read.runId},${other.event.ctx.id}) AS allowed`));
    assert.equal(wrongJob.allowed, false);
    const [job] = await f.mutate(tx => tx`SELECT status,lease_token FROM jobs WHERE id=${f.event.ctx.id}`);
    assert.equal(job.status, "running"); assert.ok(job.lease_token);
  } finally { await f.cleanup(); await other.cleanup(); }
});

test("an input checkpoint is reopened in place, with counts and private state preserved", async () => {
  const f = await fixture();
  try {
    const stepId = randomUUID(), stateJson = JSON.stringify({ phase: "input", state: { stepCount: 3, toolCallCount: 2 } });
    const checkpoint = { version: 1, identitySha256: 'a'.repeat(64), stateJson, stateSha256: sha256Utf8V1(stateJson) };
    await f.mutate(async tx => {
      await tx`UPDATE companion_messages SET client_message_id=${randomUUID()} WHERE id=${f.messageId}`;
      await tx`UPDATE companion_turn_runs SET status='failed',error_code='PROVIDER_FIRST_OUTPUT_TIMEOUT',step_count=3,tool_call_count=2 WHERE id=${f.event.read.runId}`;
      await tx`INSERT INTO companion_agent_steps(id,workspace_id,user_id,conversation_id,run_id,step_no,kind,status,runtime_checkpoint)
        VALUES(${stepId},${f.event.ctx.workspaceId},${f.event.read.userId},${f.conversationId},${f.event.read.runId},3,'model','failed',${tx.json(checkpoint)})`;
    });
    await resumeCompanionRun({ workspaceId: f.event.ctx.workspaceId, userId: f.event.read.userId, runId: f.event.read.runId,
      body: { version: 1, generation: 1, expectedEventCursor: 0 } });
    const [step] = await f.mutate(tx => tx`SELECT * FROM companion_agent_steps WHERE id=${stepId}`);
    assert.equal(step.status, "running"); assert.deepEqual(step.runtime_checkpoint, checkpoint);
    const [run] = await f.mutate(tx => tx`SELECT step_count,tool_call_count FROM companion_turn_runs WHERE id=${f.event.read.runId}`);
    assert.equal(run.step_count, 3); assert.equal(run.tool_call_count, 2);
  } finally { await f.cleanup(); }
});
