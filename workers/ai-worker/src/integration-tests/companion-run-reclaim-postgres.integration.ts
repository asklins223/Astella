/**
 * 孤儿 companion run 的回收判据（迁移 0232 + 0424，真实 Postgres + 真实受限角色）。
 *
 * 为什么必须有这支：2026-10-13 用户实测「上一条卡死之后，新对话永远是那个状态」。
 * 库里抓到的现场是一条 `accepted` 的 run 配一个**从没被领走**的 pending job——
 * 0232 的判据只认「没有 job / job 不存在 / job 已 dead」，这一种形状它管不到，
 * 于是那条 run 永远占着会话上的 partial unique index，之后每一句都在写用户消息
 * 之前被 409 拒回。
 *
 * 这里钉的是两头的边界：
 *   - **该收的收掉**，并且错误码要说清是哪一种（客户端按码给话，不再指向不存在的停止）；
 *   - **不该收的不许收**：刚排队的 job、正在正常跑的 run，一次误杀就是当着用户的面
 *     把他的问题丢掉。
 *
 * 断言的读走 worker 角色并带作用域：函数是 SECURITY DEFINER，能不能被 worker 调用、
 * 写出来的事件 worker 看不看得见，都要在这一条连接上一起证明。
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";

const ADMIN_URL = testDatabaseUrl("DATABASE_URL_MIGRATOR");
const WORKER_URL = testDatabaseUrl("DATABASE_URL_WORKER");

// 回收器自己的连接（db.ts 读 DATABASE_URL）必须是受限的 worker 角色：
// 用超户跑等于绕过 grant 与 RLS，"生产静默什么都不做"那一类回退就测不出来。
process.env.DATABASE_URL = WORKER_URL;
delete process.env.AI_PLATFORMS_CONFIG;
delete process.env.TOKENRHYTHM_API_KEY;
delete process.env.AI_REQUIRE_CONFIGURED_PROVIDER;

const admin = postgres(ADMIN_URL, { max: 3 });
const workerReader = postgres(WORKER_URL, { max: 2 });

after(async () => {
  await admin.end({ timeout: 5 }).catch(() => {});
  await workerReader.end({ timeout: 5 }).catch(() => {});
  const { closeDatabase } = await import("../db.ts");
  await closeDatabase().catch(() => {});
});

const { tickCompanionRunReconcile, resetCompanionRunReconcileThrottleForTest } =
  await import("../handlers/schedulers/companion-run-reconcile-scheduler.ts");

interface StuckTurn { workspaceId: string; userId: string; conversationId: string; runId: string; jobId: string }

/**
 * 造一条卡住的 run 与它的 job。
 *
 * `runAgeMinutes`／`jobAgeMinutes` 决定回收判据看不看得到它：正常执行预算是 110s，
 * 富余线是 5 分钟，所以这里默认摆 20 分钟前。
 */
async function seedStuckTurn(options: {
  runStatus?: "accepted" | "running";
  jobStatus: "pending" | "running" | "dead" | "succeeded";
  runAgeMinutes?: number;
  jobAgeMinutes?: number;
  leaseAgeMinutes?: number;
}): Promise<StuckTurn> {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const conversationId = randomUUID();
  const userMessageId = randomUUID();
  const runId = randomUUID();
  const jobId = randomUUID();
  const ago = (minutes: number): Date => new Date(Date.now() - minutes * 60_000);
  const runAge = ago(options.runAgeMinutes ?? 20);
  const jobAge = ago(options.jobAgeMinutes ?? 20);
  const leaseAge = ago(options.leaseAgeMinutes ?? 20);
  await admin.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role)
             VALUES (${userId}, ${`reclaim-${userId.slice(0, 8)}@x.test`}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${workspaceId}, ${`w-${workspaceId.slice(0, 8)}`}, ${userId})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
    await tx`INSERT INTO user_ai_settings (user_id, consent_version, consent_at, data_policy)
             VALUES (${userId}, 'integration-test-v1', now(),
                     ${tx.json({ sendToExternal: false, sendImageContent: false, piiDetection: true, auditLogging: true })})`;
    await tx`INSERT INTO companion_conversations (id, workspace_id, user_id, kind, title, title_source, status)
             VALUES (${conversationId}, ${workspaceId}, ${userId}, 'dialogue', '会话', 'auto', 'active')`;
    await tx`INSERT INTO companion_messages (id, conversation_id, workspace_id, user_id, role, seq, kind, blocks, content_sha256)
             VALUES (${userMessageId}, ${conversationId}, ${workspaceId}, ${userId}, 'user', 1, 'text',
                     ${tx.json([{ type: "text", text: "帮我把这一段理顺。" }])}, ${"0".repeat(64)})`;
    await tx`INSERT INTO jobs (id, type, workspace_id, requested_by, payload, status, attempts,
                               max_attempts, priority, resource_class, scheduled_at, started_at,
                               lease_token, lease_renewed_at, finished_at)
             VALUES (${jobId}, 'companion_agent', ${workspaceId}, ${userId}, ${tx.json({ runId })},
                     ${options.jobStatus}, 0, 3, 1, 'interactive_ai', ${jobAge},
                     ${options.jobStatus === "pending" ? null : jobAge},
                     ${`fixture-${jobId.slice(0, 8)}`}, ${leaseAge},
                     ${options.jobStatus === "succeeded" ? jobAge : null})`;
    await tx`INSERT INTO companion_turn_runs
             (id, conversation_id, workspace_id, user_id, user_message_id, generation, status,
              idempotency_key_hash, request_body_hash, job_id, created_at, updated_at)
             VALUES (${runId}, ${conversationId}, ${workspaceId}, ${userId}, ${userMessageId}, 1,
                     ${options.runStatus ?? "accepted"}, ${"a".repeat(64)}, ${"b".repeat(64)}, ${jobId},
                     ${runAge}, ${runAge})`;
  });
  return { workspaceId, userId, conversationId, runId, jobId };
}

async function readAsWorker(scope: StuckTurn) {
  const rows = await workerReader.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id', ${scope.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${scope.userId}, true)`;
    const run = await tx`SELECT status, error_code, finished_at FROM companion_turn_runs WHERE id=${scope.runId}`;
    const events = await tx`SELECT type, payload FROM companion_stream_events WHERE run_id=${scope.runId} ORDER BY seq`;
    return { run: run[0] ?? null, events };
  });
  return rows as unknown as { run: { status: string; error_code: string | null; finished_at: Date | null } | null;
    events: { type: string; payload: Record<string, unknown> }[] };
}

async function cleanup(scope: StuckTurn): Promise<void> {
  await admin.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id', ${scope.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${scope.userId}, true)`;
    await tx`DELETE FROM companion_stream_events WHERE conversation_id=${scope.conversationId}`;
    await tx`DELETE FROM companion_turn_runs WHERE id=${scope.runId}`;
    await tx`DELETE FROM jobs WHERE id=${scope.jobId}`;
    await tx`DELETE FROM companion_messages WHERE conversation_id=${scope.conversationId}`;
    await tx`DELETE FROM companion_conversations WHERE id=${scope.conversationId}`;
    await tx`DELETE FROM user_ai_settings WHERE user_id=${scope.userId}`;
    await tx`DELETE FROM workspace_members WHERE workspace_id=${scope.workspaceId}`;
    await tx`DELETE FROM workspaces WHERE id=${scope.workspaceId}`;
    await tx`DELETE FROM users WHERE id=${scope.userId}`;
  });
}

test("job 从没被领走的 accepted run 会被终结，错误码说清是没跑起来", async () => {
  const scope = await seedStuckTurn({ runStatus: "accepted", jobStatus: "pending" });
  resetCompanionRunReconcileThrottleForTest();
  try {
    assert.equal(await tickCompanionRunReconcile(), 1);
    const actual = await readAsWorker(scope);
    assert.equal(actual.run?.status, "failed");
    assert.equal(actual.run?.error_code, "JOB_NEVER_STARTED");
    assert.ok(actual.run?.finished_at, "终态时间要落下，run 才算真的收口");
    const error = actual.events.find(event => event.type === "error");
    assert.equal(error?.payload.code, "JOB_NEVER_STARTED");
    assert.equal(error?.payload.recoverable, false);
    assert.ok(actual.events.some(event => event.type === "character.cue"), "失败也要有她的表情收尾");
  } finally { await cleanup(scope); }
});

test("租约失效的 running 与已 dead 的各自说清原因；刚排队的不动", async () => {
  const leaseLost = await seedStuckTurn({ runStatus: "running", jobStatus: "running", leaseAgeMinutes: 20 });
  const dead = await seedStuckTurn({ runStatus: "accepted", jobStatus: "dead" });
  // 一分钟内刚排上的队：worker 只是还没轮到它，收掉就是当着用户的面丢掉他这句话。
  const queued = await seedStuckTurn({ runStatus: "accepted", jobStatus: "pending", jobAgeMinutes: 1, runAgeMinutes: 1 });
  resetCompanionRunReconcileThrottleForTest();
  try {
    assert.equal(await tickCompanionRunReconcile(), 2);
    assert.equal((await readAsWorker(leaseLost)).run?.error_code, "JOB_LEASE_LOST");
    assert.equal((await readAsWorker(dead)).run?.error_code, "JOB_DEAD");
    const untouched = await readAsWorker(queued);
    assert.equal(untouched.run?.status, "accepted", "宽限期内的排队不许终结");
    assert.equal(untouched.events.length, 0);
  } finally {
    await cleanup(leaseLost); await cleanup(dead); await cleanup(queued);
  }
});

test("回收过的 run 不重复收：第二次扫描一个都不动", async () => {
  const scope = await seedStuckTurn({ runStatus: "accepted", jobStatus: "succeeded" });
  resetCompanionRunReconcileThrottleForTest();
  try {
    assert.equal(await tickCompanionRunReconcile(), 1);
    assert.equal((await readAsWorker(scope)).run?.error_code, "JOB_FINISHED_WITHOUT_RUN");
    resetCompanionRunReconcileThrottleForTest();
    assert.equal(await tickCompanionRunReconcile(), 0);
    const events = await readAsWorker(scope);
    assert.equal(events.events.filter(event => event.type === "error").length, 1, "不能补两条失败");
  } finally { await cleanup(scope); }
});
