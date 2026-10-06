/**
 * 方案 42 第一批 A：目标历史与更早分页的数据库行为。
 *
 * 覆盖的是源码看不出来的几件事：同一微秒的时间戳会不会翻页翻重、
 * 暂停/恢复/停止会不会凭空多一版、失败重试有没有把旧要求留住、
 * CAS 失败与幂等重复会不会多写一条凭据、worker 能不能写又改不动。
 *
 * 产物那一段走真实链路：invokeNoteCapability 建操作与 job（payload 里冻结材料），
 * 再把 note_overviews 真落库、job 置成功、由回执读取把 artifact 写回操作行。
 * 手工 INSERT 一个 payload={} 的假 job 不算「已完成的产品」，那只能证明
 * 「有 job 成功」，不能证明「产物真的存在且属于这次操作」。
 *
 * 运行方式（需要一次性测试库，且 0369 已迁移）：
 *   cd workers/ai-worker && DATABASE_URL_MIGRATOR=... DATABASE_URL_API=... \
 *   DATABASE_URL_WORKER=... node --import tsx --test --test-concurrency=1 \
 *   src/integration-tests/agent-history-postgres.integration.ts
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@astella/shared/db-schema";
import { sql as query } from "drizzle-orm";
import { createAgentAdvanceStore, createAgentStore, type AgentStorePorts } from "@astella/agent-host";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { closeDatabase, type WorkerTransaction } from "../db.ts";
import { invokeNoteCapability } from "../agent/note-capabilities.ts";

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
// 伴星的 agent_revise_goal / agent_control_goal 工具走 worker 宿主，
// 所以历史存档也必须能在 worker 角色下真的发生。
const worker = createAgentStore(workerPorts);

const fixtures: { userIds: string[]; workspaceIds: string[] }[] = [];
after(async () => {
  try {
    for (const fixture of fixtures) await admin.begin(async tx => {
      for (const workspaceId of fixture.workspaceIds) {
        await tx`DELETE FROM agent_runs WHERE workspace_id=${workspaceId}`;
        await tx`DELETE FROM note_overviews WHERE workspace_id=${workspaceId}`;
        await tx`UPDATE notes SET current_version_id=NULL WHERE workspace_id=${workspaceId}`;
        await tx`DELETE FROM note_blocks WHERE workspace_id=${workspaceId}`;
        await tx`DELETE FROM note_versions WHERE workspace_id=${workspaceId}`;
        await tx`DELETE FROM notes WHERE workspace_id=${workspaceId}`;
        await tx`DELETE FROM jobs WHERE workspace_id=${workspaceId}`;
        await tx`DELETE FROM workspaces WHERE id=${workspaceId}`;
      }
      for (const userId of fixture.userIds) {
        await tx`DELETE FROM user_companion_account_state WHERE user_id=${userId}`;
        await tx`DELETE FROM user_ai_settings WHERE user_id=${userId}`;
        await tx`DELETE FROM users WHERE id=${userId}`;
      }
    });
  } finally { await Promise.all([admin.end(), apiClient.end(), workerClient.end(), closeDatabase()]); }
});

/** 本人两个空间（跨空间用），另一个用户一个空间（跨用户用）。 */
async function fixture(content = ["叶绿体利用光能制造有机物。"], title = "光合作用") {
  const userId = randomUUID(), otherUserId = randomUUID();
  const [workspaceId, otherWorkspaceId, foreignWorkspaceId] = [randomUUID(), randomUUID(), randomUUID()];
  const noteId = randomUUID(), noteVersionId = randomUUID();
  fixtures.push({ userIds: [userId, otherUserId], workspaceIds: [workspaceId, otherWorkspaceId, foreignWorkspaceId] });
  await admin.begin(async tx => {
    for (const id of [userId, otherUserId]) {
      await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${id},${`agent42a-${id}@test.invalid`},'fixture','owner')`;
      // 直接建伴星身份：后面要按 identity_id 造历史目标，也要直接驱动 worker。
      await tx`INSERT INTO user_companion_account_state(user_id) VALUES(${id}) ON CONFLICT(user_id) DO NOTHING`;
    }
    for (const id of [workspaceId, otherWorkspaceId])
      await tx`INSERT INTO workspaces(id,name,owner_id) VALUES(${id},'agent42a fixture',${userId})`;
    await tx`INSERT INTO workspaces(id,name,owner_id) VALUES(${foreignWorkspaceId},'agent42a foreign',${otherUserId})`;
    for (const id of [workspaceId, otherWorkspaceId])
      await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${id},${userId},'owner')`;
    await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${foreignWorkspaceId},${otherUserId},'owner')`;
    await tx`INSERT INTO notes(id,workspace_id,title,created_by) VALUES(${noteId},${workspaceId},${title},${userId})`;
    await tx`INSERT INTO note_versions(id,note_id,workspace_id,version_no,content_json,created_by,content_hash)
      VALUES(${noteVersionId},${noteId},${workspaceId},1,'{}',${userId},${createHash("sha256").update(content.join("\n")).digest("hex")})`;
    for (const [index, text] of content.entries())
      await tx`INSERT INTO note_blocks(version_id,workspace_id,ordinal,type,content) VALUES(${noteVersionId},${workspaceId},${index + 1},'paragraph',${text})`;
    await tx`UPDATE notes SET current_version_id=${noteVersionId} WHERE id=${noteId}`;
  });
  return {
    scope: { workspaceId, userId },
    otherWorkspaceScope: { workspaceId: otherWorkspaceId, userId },
    foreignScope: { workspaceId: foreignWorkspaceId, userId: otherUserId },
    input: { kind: "note_version" as const, noteId, noteVersionId },
  };
}

type Scope = { workspaceId: string; userId: string };
type NoteRef = { noteId: string; noteVersionId: string };

async function identityOf(userId: string) {
  const [row] = await admin`SELECT id,epoch FROM user_companion_account_state WHERE user_id=${userId}`;
  assert.ok(row, "夹具必须先建出伴星身份");
  return row;
}

/** 认领该版本待办的 advance job。 */
async function lease(scope: Scope, runId: string, revision: number) {
  const leaseToken = randomUUID();
  const [job] = await admin`UPDATE jobs SET status='running',lease_token=${leaseToken},started_at=now()
    WHERE id=(SELECT id FROM jobs WHERE workspace_id=${scope.workspaceId} AND payload->>'runId'=${runId}
      AND payload->>'revision'=${String(revision)} AND type='agent_run_advance' AND status='pending' ORDER BY id LIMIT 1)
    RETURNING id`;
  assert.ok(job, "推进队列必须留下一个待办");
  return { id: String(job.id), workspaceId: scope.workspaceId, requestedBy: scope.userId, leaseToken };
}

/**
 * 让某一版真的做出一个速看：能力调用建操作与 job，产物落进 note_overviews，
 * job 置成功后由回执读取把真实 artifact 写回操作行。
 */
async function completedOperation(scope: Scope, runId: string, revision: number, note: NoteRef) {
  const first = await lease(scope, runId, revision);
  const advance = createAgentAdvanceStore(workerPorts, first, runId, revision);
  assert.ok(await advance.acquire(), "目标应当能被唤起");
  const child = await invokeNoteCapability(advance, {
    id: `overview-${randomUUID()}`, name: "note_overview_generate",
    arguments: { noteId: note.noteId, noteVersionId: note.noteVersionId },
  }) as { operationId: string; execution: { kind: "job"; id: string } };
  await advance.release(false);
  const overviewId = randomUUID();
  await admin.begin(async tx => {
    await tx`INSERT INTO note_overviews(id,workspace_id,user_id,note_id,note_version_id,body,generation_job_id)
      VALUES(${overviewId},${scope.workspaceId},${scope.userId},${note.noteId},${note.noteVersionId},'光能转化为有机物中的化学能。',${child.execution.id})`;
    await tx`UPDATE jobs SET status='succeeded',lease_token=NULL,finished_at=now() WHERE id IN (${first.id},${child.execution.id})`;
  });
  const receipt = await lease(scope, runId, revision);
  const reader = createAgentAdvanceStore(workerPorts, receipt, runId, revision);
  assert.ok(await reader.acquire(), "回执回来后目标应当重新被唤起");
  await reader.release(false);
  const projected = await api.get(scope, runId);
  assert.equal(projected.operations.find(operation => operation.operationId === child.operationId)?.status, "succeeded",
    "产物真的落在领域表里，才算这次操作做成了");
  return { jobId: child.execution.id, operationId: child.operationId, overviewId };
}

/** Drizzle 会把数据库错误包一层，断言要落在 SQLSTATE 上而不是包装文字。 */
function isInsufficientPrivilege(error: unknown) {
  const code = (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
  return code === "42501";
}

test("list：同一微秒的时间戳也不会翻页翻重，缺省 20、上限 50", async () => {
  const f = await fixture(), identity = await identityOf(f.scope.userId);
  const runIds = Array.from({ length: 25 }, () => randomUUID());
  await admin.begin(async tx => {
    for (const [index, id] of runIds.entries()) {
      const at = index < 10 ? "2026-10-04 00:00:00.500000+00" : `2026-10-04 00:01:${String(index).padStart(2, "0")}+00`;
      await tx`INSERT INTO agent_runs(id,workspace_id,user_id,identity_id,account_epoch,request_id,goal,status,created_at,updated_at)
        VALUES(${id},${f.scope.workspaceId},${f.scope.userId},${identity.id},${identity.epoch},${randomUUID()},${`目标 ${index}`},'completed',${at},${at})`;
    }
  });
  const expected = await admin`SELECT id FROM agent_runs WHERE workspace_id=${f.scope.workspaceId} ORDER BY updated_at DESC,id DESC`;

  const first = await api.list(f.scope);
  assert.equal(first.items.length, 20, "缺省就是第一页 20 条");
  assert.ok(first.nextCursor, "还有更早一页时必须给出游标");

  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await api.list(f.scope, cursor ? { limit: 7, cursor } : { limit: 7 });
    seen.push(...result.items.map(run => run.runId));
    cursor = result.nextCursor ?? undefined;
    if (!cursor) break;
  }
  assert.deepEqual(seen, expected.map(row => row.id), "顺序要对，不重也不漏");
  assert.equal(new Set(seen).size, 25);

  const widest = await api.list(f.scope, { limit: 50 });
  assert.equal(widest.items.length, 25);
  assert.equal(widest.nextCursor, null, "没有更早一页时是 null 而不是空串");
  assert.equal((await api.list(f.scope, { limit: 51 })).items.length, 25, "直接调 store 也要收口到上限");
  assert.deepEqual((await api.list(f.otherWorkspaceScope)).items, [], "另一个空间读不到");
  assert.deepEqual((await api.list(f.foreignScope)).items, [], "另一个用户读不到");
});

test("游标来路不对就整体作废，绝不悄悄退回第一页", async () => {
  const f = await fixture(), identity = await identityOf(f.scope.userId);
  for (const index of [0, 1]) {
    const at = `2026-10-04 00:02:0${index}+00`;
    await admin`INSERT INTO agent_runs(id,workspace_id,user_id,identity_id,account_epoch,request_id,goal,status,created_at,updated_at)
      VALUES(${randomUUID()},${f.scope.workspaceId},${f.scope.userId},${identity.id},${identity.epoch},${randomUUID()},${`目标 ${index}`},'completed',${at},${at})`;
  }
  const page = await api.list(f.scope, { limit: 1 });
  assert.equal(page.items.length, 1);
  const [real] = await admin`SELECT id FROM agent_runs WHERE workspace_id=${f.scope.workspaceId} ORDER BY updated_at DESC,id DESC LIMIT 1`;
  // 把游标改指向别的空间：形状合法也作废。
  const forged = Buffer.from(JSON.stringify({ version: 1,
    workspaceId: f.foreignScope.workspaceId, userId: f.foreignScope.userId,
    updatedAt: page.items[0].updatedAt, runId: real.id })).toString("base64url");
  for (const bad of ["", "not-base64url", "x".repeat(600), forged,
    Buffer.from(JSON.stringify({ version: 1, workspaceId: f.scope.workspaceId, userId: f.scope.userId,
      updatedAt: page.items[0].updatedAt })).toString("base64url")]) {
    await assert.rejects(api.list(f.scope, { cursor: bad }), /这个位置已经读不到了/);
  }
});

test("暂停、恢复、停止都停在同一版，历史里只有当前这一条", async () => {
  const f = await fixture(), scope = f.scope;
  const run = await api.create(scope, { requestId: randomUUID(), goal: "做一份速看", inputs: [f.input] });
  const paused = await api.control(scope, run.runId, 1, "pause");
  assert.equal(paused.status, "paused");
  assert.equal(paused.revision, 1, "暂停不换版本");
  const resumed = await api.control(scope, run.runId, 1, "resume");
  assert.equal(resumed.status, "queued");
  assert.equal(resumed.revision, 1, "恢复同一版不制造新的要求");

  const afterResume = await api.history(scope, run.runId);
  assert.deepEqual(afterResume.items.map(item => item.revision), [1]);
  assert.deepEqual(afterResume.unrecordedRevisions, []);
  assert.equal(afterResume.nextBeforeRevision, null);
  assert.equal(afterResume.items[0].recordedAt, null);
  const [{ archived }] = await admin`SELECT count(*)::int archived FROM agent_run_revisions WHERE run_id=${run.runId}`;
  assert.equal(archived, 0, "暂停/恢复不该写存档");

  const cancelled = await api.control(scope, run.runId, 1, "cancel");
  assert.equal(cancelled.status, "cancelled");
  assert.equal((await api.history(scope, run.runId)).items.length, 1, "停止也不换版本");
  assert.equal((await api.control(scope, run.runId, 1, "pause")).revision, 1);
});

test("要求修订：旧要求、旧结果与旧时间原样存档，产物一个都不删", async () => {
  const f = await fixture(), scope = f.scope;
  const run = await api.create(scope, { requestId: randomUUID(), goal: "把这一节整理成速看", inputs: [f.input] });
  const first = await completedOperation(scope, run.runId, 1, f.input);
  await admin`UPDATE agent_runs SET status='completed',summary='第一版的结论',model_calls=3 WHERE id=${run.runId}`;
  const revised = await api.revise(scope, run.runId, 1, "只保留速看，解释短一些");
  assert.equal(revised.revision, 2);
  assert.equal(revised.goal, "只保留速看，解释短一些");
  assert.equal(revised.artifacts[0].id, first.overviewId, "已完成产物留在当前目标上");

  const history = await api.history(scope, run.runId);
  assert.deepEqual(history.items.map(item => item.revision), [2, 1]);
  const current = history.items[0], older = history.items[1];
  assert.equal(current.recordedAt, null);
  assert.equal(current.supersededByRevision, null);
  assert.equal(older.goal, "把这一节整理成速看", "旧要求留在旧版");
  assert.equal(older.summary, "第一版的结论");
  assert.equal(older.status, "completed");
  assert.equal(older.modelCalls, 3);
  assert.deepEqual(older.inputs, [f.input]);
  assert.equal(older.supersededByRevision, 2);
  assert.ok(older.recordedAt && older.lastActiveAt && older.startedAt, "旧版要留住它自己的三个时间");
  assert.ok(older.recordedAt >= older.lastActiveAt, "存档时间不早于它最后一次有动静");
  assert.deepEqual(older.operations.map(operation => operation.operationId), [first.operationId]);
  assert.deepEqual(older.artifacts.map(artifact => artifact.id), [first.overviewId], "旧版带的是自己那份真实产物");
  assert.deepEqual(current.operations, [], "新版的 operation 不能塞进旧版");
  const [{ still }] = await admin`SELECT count(*)::int still FROM note_overviews WHERE id=${first.overviewId}`;
  assert.equal(still, 1, "历史不删已完成产物");

  const second = await completedOperation(scope, run.runId, 2, f.input);
  const afterSecond = await api.history(scope, run.runId);
  assert.deepEqual(afterSecond.items.find(item => item.revision === 1)!.artifacts.map(a => a.id), [first.overviewId]);
  assert.deepEqual(afterSecond.items.find(item => item.revision === 2)!.artifacts.map(a => a.id), [second.overviewId],
    "新版结果不塞到旧版");
  assert.deepEqual((await api.get(scope, run.runId)).artifacts.map(a => a.id), [first.overviewId, second.overviewId]);
});

test("失败后换一次继续：失败那一版连同它已做出来的成果一起留下", async () => {
  const f = await fixture(), scope = f.scope;
  const run = await api.create(scope, { requestId: randomUUID(), goal: "先做速看，再解释", inputs: [f.input] });
  const first = await completedOperation(scope, run.runId, 1, f.input);
  await admin`UPDATE agent_runs SET status='failed',summary='做到一半',error='有一部分没做成' WHERE id=${run.runId}`;
  const retried = await api.control(scope, run.runId, 1, "resume");
  assert.equal(retried.revision, 2);
  const history = await api.history(scope, run.runId);
  assert.deepEqual(history.items.map(item => item.revision), [2, 1]);
  const older = history.items[1];
  assert.equal(older.status, "failed");
  assert.equal(older.error, "有一部分没做成");
  assert.equal(older.summary, "做到一半");
  assert.deepEqual(older.artifacts.map(artifact => artifact.id), [first.overviewId]);
});

test("幂等重复与 CAS 失败都不长历史", async () => {
  const f = await fixture(), scope = f.scope;
  const requestId = randomUUID();
  const first = await api.create(scope, { requestId, goal: "整理成速看", inputs: [f.input] });
  const repeated = await api.create(scope, { requestId, goal: "整理成速看", inputs: [f.input] });
  assert.equal(repeated.runId, first.runId);
  await assert.rejects(api.create(scope, { requestId, goal: "另一个要求", inputs: [f.input] }), /已有另一份要求/);
  assert.deepEqual((await api.history(scope, first.runId)).items.map(item => item.revision), [1]);

  const revised = await api.revise(scope, first.runId, 1, "只保留速看");
  assert.equal(revised.revision, 2);
  await assert.rejects(api.revise(scope, first.runId, 1, "用旧版本改"), /刚刚更新/);
  await assert.rejects(api.control(scope, first.runId, 1, "pause"), /最新状态/);
  assert.deepEqual((await api.history(scope, first.runId)).items.map(item => item.revision), [2, 1],
    "被 CAS 挡住的那次不该再存档一版");
  const [{ archived }] = await admin`SELECT count(*)::int archived FROM agent_run_revisions WHERE run_id=${first.runId}`;
  assert.equal(archived, 1);
});

test("历史按 revision 往回翻：每页有界、游标含边界、缺档如实点名", async () => {
  const f = await fixture(), scope = f.scope;
  const run = await api.create(scope, { requestId: randomUUID(), goal: "第 1 版", inputs: [f.input] });
  for (let revision = 2; revision <= 6; revision += 1)
    await api.revise(scope, run.runId, (await api.get(scope, run.runId)).revision, `第 ${revision} 版`);

  const walked: number[] = [];
  let cursor: number | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await api.history(scope, run.runId, cursor ? { limit: 2, beforeRevision: cursor } : { limit: 2 });
    assert.ok(result.items.length + result.unrecordedRevisions.length <= 2, "一页覆盖的 revision 号数不得超过 limit");
    walked.push(...result.items.map(item => item.revision));
    if (result.nextBeforeRevision === null) break;
    cursor = result.nextBeforeRevision;
  }
  assert.deepEqual(walked, [6, 5, 4, 3, 2, 1], "六版一次不重不漏地读完");
  // beforeRevision 含边界：它就是本页第一版的号。
  for (const page of [4, 5]) {
    const result = await api.history(scope, run.runId, { limit: 2, beforeRevision: page });
    assert.equal(result.items[0].revision, page, "游标含边界，落在本页第一项");
    assert.ok(result.items.every(item => item.revision <= page), "本页不得出现比游标更新的一版");
    assert.ok(result.items.every(item => item.recordedAt !== null), "更早的页里没有当前版");
  }
  await assert.rejects(api.history(scope, run.runId, { beforeRevision: 99 }), /这个位置已经读不到了/);
  await assert.rejects(api.history(scope, run.runId, { beforeRevision: 0 }), /这个位置已经读不到了/);

  // 模拟部署前走过的修订：没有任何凭据，如实点名而不是编一段。
  await admin`DELETE FROM agent_run_revisions WHERE run_id=${run.runId} AND revision IN (2,3)`;
  assert.deepEqual((await api.history(scope, run.runId)).unrecordedRevisions, [2, 3]);

  // 有缺档时翻页：每一版只能出现在一页里，更早页的存档不许漏进本页。
  const walkedGapped: number[] = [], reported: number[] = [];
  let gappedCursor: number | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await api.history(scope, run.runId, gappedCursor ? { limit: 2, beforeRevision: gappedCursor } : { limit: 2 });
    walkedGapped.push(...result.items.map(item => item.revision));
    reported.push(...result.unrecordedRevisions);
    if (result.nextBeforeRevision === null) break;
    gappedCursor = result.nextBeforeRevision;
  }
  assert.deepEqual(walkedGapped, [6, 5, 4, 1], "缺了 2、3，其余各版仍然一页一次");
  assert.deepEqual(reported, [3, 2], "缺档各报一次，不重复也不遗漏");
  assert.equal(new Set([...walkedGapped, ...reported]).size, 6);

  const top = await api.history(scope, run.runId, { limit: 2 });
  assert.deepEqual(top.items.map(item => item.revision), [6, 5], "首页窗口是 5..6");
  assert.deepEqual(top.unrecordedRevisions, []);
  assert.equal(top.nextBeforeRevision, 4);
  const middle = await api.history(scope, run.runId, { limit: 2, beforeRevision: 4 });
  assert.deepEqual(middle.items.map(item => item.revision), [4], "本页窗口是 3..4，第 1 版属于更早的一页");
  assert.deepEqual(middle.unrecordedRevisions, [3]);
  assert.equal(middle.nextBeforeRevision, 2);
  const tail = await api.history(scope, run.runId, { limit: 2, beforeRevision: 2 });
  assert.deepEqual(tail.items.map(item => item.revision), [1]);
  assert.deepEqual(tail.unrecordedRevisions, [2], "已经存档的那一版不能被说成没存档");
  assert.equal(tail.nextBeforeRevision, null);

  const identity = await identityOf(f.scope.userId);
  const deepId = randomUUID();
  await admin`INSERT INTO agent_runs(id,workspace_id,user_id,identity_id,account_epoch,request_id,goal,status,revision)
    VALUES(${deepId},${f.scope.workspaceId},${f.scope.userId},${identity.id},${identity.epoch},${randomUUID()},'很久以前的目标','completed',600)`;
  const deep = await api.history(scope, deepId, { limit: 5 });
  assert.deepEqual(deep.items.map(item => item.revision), [600]);
  assert.deepEqual(deep.unrecordedRevisions, [596, 597, 598, 599], "revision 很大时不做 1..599 的无界遍历");
  assert.equal(deep.unrecordedRevisions.length + deep.items.length, 5, "一页覆盖的号数与 limit 同阶");
  assert.equal(deep.nextBeforeRevision, 595);
});

test("跨用户、跨空间读不到别人的目标与它的历史", async () => {
  const f = await fixture(), scope = f.scope;
  const run = await api.create(scope, { requestId: randomUUID(), goal: "只属于这个空间", inputs: [f.input] });
  await api.revise(scope, run.runId, 1, "换个要求");
  for (const other of [f.otherWorkspaceScope, f.foreignScope]) {
    await assert.rejects(api.history(other, run.runId), /这件事现在读不到/);
    await assert.rejects(api.get(other, run.runId), /这件事现在读不到/);
    assert.deepEqual((await api.list(other)).items, []);
  }
});

test("worker 角色能追加历史，但改不动也删不掉", async () => {
  const f = await fixture(), scope = f.scope;
  const run = await api.create(scope, { requestId: randomUUID(), goal: "伴星替我接下的目标", inputs: [f.input] });
  const revised = await worker.revise(scope, run.runId, 1, "改成伴星的口吻");
  assert.equal(revised.revision, 2, "worker 宿主上的 revise 必须能落下存档");
  assert.deepEqual((await api.history(scope, run.runId)).items.map(item => item.revision), [2, 1]);
  await assert.rejects(workerPorts.transaction(scope, tx => tx.execute(query`
    UPDATE agent_run_revisions SET goal='改写过去' WHERE run_id=${run.runId}`)), isInsufficientPrivilege);
  await assert.rejects(workerPorts.transaction(scope, tx => tx.execute(query`
    DELETE FROM agent_run_revisions WHERE run_id=${run.runId}`)), isInsufficientPrivilege);
});