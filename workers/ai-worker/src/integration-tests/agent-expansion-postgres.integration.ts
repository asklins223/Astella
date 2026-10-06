/**
 * 42 阶段 1 子任务 C：笔记拓展接入持续 Agent 的真实数据库行为回归。
 *
 * 这份夹具只在一次性库上跑（见 scripts/dev-disposable-db.sh）。它钉的是几条
 * 不能靠读源码推断的语义：
 *
 *   1. 同一目标同一版本的拓展只排一个 job（语义幂等），换 provider call id 也不重排；
 *   2. job 报成功不等于交付——只有 note_expansion_tasks 里真的存下这一行才算；
 *      回执丢了就停在 outcome_unknown，而且仍然算「可以继续等」，不是「重做一次」；
 *   3. 产物必须和这一次操作逐字对上：job 的 type、归属、payload 冻结的材料，
 *      外加目标冻结材料集合。一个目标冻结两份材料时，串错的产物不许顶账；
 *   4. 核对预算用尽后，只有逐字对上的真实草稿才再醒一次目标（0370 迁移）；
 *   5. 目标停掉或被新要求替代之后，拓展不再调用模型；模型调用记在目标预算上。
 *   6. （子任务 D）读取自己保存的草稿：读到手改过的当前草稿、超长单块能分页读完、
 *      跨目标/跨用户/跨空间/错版本/错 payload 一律读不到、迟到的目标不能借工具越权。
 *
 * 除了「造夹具」之外没有手写 SQL 去伪造状态机：job 状态变化靠 0368 的触发器，
 * 后续核对靠真实的 astella_enqueue_agent_recovery()，完成判定走真正的 advance store。
 */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { after, test } from "node:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@astella/shared/db-schema";
import { sql as query } from "drizzle-orm";
import { createAgentStore, createAgentAdvanceStore, readOperationResultReceipt,
  type AgentStorePorts, type OperationReceiptRequest, type OperationReceiptV1 } from "@astella/agent-host";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { invokeNoteCapability } from "../agent/note-capabilities.ts";
import type { AgentWorkerAdvanceStore } from "../agent/store.ts";
import { readExpansionDrafts, type ExpansionReadResult } from "../agent/expansion-reading.ts";
import { noteAgentCapabilityManifest } from "@astella/shared/agent-capabilities";
import { loadAgentGenerationContext } from "../agent/generation-context.ts";
import { closeDatabase, type WorkerTransaction } from "../db.ts";

const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 2 });
const apiClient = postgres(testDatabaseUrl("DATABASE_URL_API"), { max: 2 });
const workerClient = postgres(testDatabaseUrl("DATABASE_URL_WORKER"), { max: 2 });

// 子任务 D 需要「用户手动改过草稿」这条真链路：写入走 API 侧既有的
// updateNoteExpansionTaskDrafts，而不是手写 UPDATE 去伪造一份改过的内容。
process.env.DATABASE_URL_API ??= testDatabaseUrl("DATABASE_URL_API");
const { withWorkspaceTransaction, closeDatabase: closeApiDatabase } =
  await import("../../../../apps/api/src/db/client.ts");
const { updateNoteExpansionTaskDrafts } =
  await import("../../../../apps/api/src/modules/note-expansions/service.ts");

function ports(client: ReturnType<typeof postgres>): AgentStorePorts<WorkerTransaction> {
  const db = drizzle(client, { schema });
  return {
    id: randomUUID,
    transaction: (scope, action) => db.transaction(async (tx) => {
      await tx.execute(query`SELECT set_config('app.workspace_id',${scope.workspaceId},true),set_config('app.user_id',${scope.userId},true)`);
      return action(tx);
    }),
  };
}
const api = createAgentStore({ ...ports(apiClient), ensureIdentity: async (tx, scope) => {
  await tx.execute(query`INSERT INTO user_companion_account_state(user_id) VALUES(${scope.userId}) ON CONFLICT(user_id) DO NOTHING`);
} });
const workerPorts = ports(workerClient);

const EXPANSION = "note_expansion_generate";
const fixtures: { userId: string; workspaceIds: string[] }[] = [];
after(async () => {
  try {
    for (const fixture of fixtures) await admin.begin(async (tx) => {
      for (const workspaceId of fixture.workspaceIds) {
        await tx`DELETE FROM agent_runs WHERE workspace_id=${workspaceId}`;
        await tx`DELETE FROM note_expansion_tasks WHERE workspace_id=${workspaceId}`;
        await tx`DELETE FROM note_expansions WHERE workspace_id=${workspaceId}`;
        await tx`UPDATE notes SET current_version_id=NULL WHERE workspace_id=${workspaceId}`;
        await tx`DELETE FROM note_blocks WHERE workspace_id=${workspaceId}`;
        await tx`DELETE FROM note_versions WHERE workspace_id=${workspaceId}`;
        await tx`DELETE FROM notes WHERE workspace_id=${workspaceId}`;
        await tx`DELETE FROM jobs WHERE workspace_id=${workspaceId}`;
        await tx`DELETE FROM workspaces WHERE id=${workspaceId}`;
      }
      await tx`DELETE FROM user_companion_account_state WHERE user_id=${fixture.userId}`;
      await tx`DELETE FROM user_ai_settings WHERE user_id=${fixture.userId}`;
      await tx`DELETE FROM users WHERE id=${fixture.userId}`;
    });
  } finally {
    await Promise.all([admin.end(), apiClient.end(), workerClient.end(), closeDatabase(), closeApiDatabase()]);
  }
});

/** 一个用户、两个空间、一篇笔记的两个版本：v1 是目标冻结的那一版，v2 是后来编辑的。 */
async function fixture(title = "光合作用") {
  const userId = randomUUID(), workspaceIds = [randomUUID(), randomUUID()];
  const noteId = randomUUID(), noteVersionId = randomUUID(), otherVersionId = randomUUID();
  fixtures.push({ userId, workspaceIds });
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${userId},${`agent42c-${userId}@test.invalid`},'fixture','owner')`;
    for (const workspaceId of workspaceIds) {
      await tx`INSERT INTO workspaces(id,name,owner_id) VALUES(${workspaceId},'agent42c fixture',${userId})`;
      await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
    }
    await tx`INSERT INTO notes(id,workspace_id,title,created_by) VALUES(${noteId},${workspaceIds[0]},${title},${userId})`;
    for (const [versionId, versionNo, text] of [
      [noteVersionId, 1, "叶绿体利用光能制造有机物。"], [otherVersionId, 2, "后来补写的一段。"],
    ] as const) {
      await tx`INSERT INTO note_versions(id,note_id,workspace_id,version_no,content_json,created_by,content_hash)
        VALUES(${versionId},${noteId},${workspaceIds[0]},${versionNo},'{}',${userId},${createHash("sha256").update(text).digest("hex")})`;
      await tx`INSERT INTO note_blocks(version_id,workspace_id,ordinal,type,content)
        VALUES(${versionId},${workspaceIds[0]},1,'paragraph',${text})`;
    }
    await tx`UPDATE notes SET current_version_id=${noteVersionId} WHERE id=${noteId}`;
  });
  return {
    userId, workspaceId: workspaceIds[0]!, otherWorkspaceId: workspaceIds[1]!,
    noteId, noteVersionId, otherVersionId,
    input: { kind: "note_version" as const, noteId, noteVersionId },
  };
}

/** 第二篇笔记：钉「一个目标冻结两份材料」时产物串到另一份上的情况。 */
async function anotherNote(scope: { workspaceId: string; userId: string }, title: string, text: string) {
  const noteId = randomUUID(), noteVersionId = randomUUID();
  await admin.begin(async (tx) => {
    await tx`INSERT INTO notes(id,workspace_id,title,created_by) VALUES(${noteId},${scope.workspaceId},${title},${scope.userId})`;
    await tx`INSERT INTO note_versions(id,note_id,workspace_id,version_no,content_json,created_by,content_hash)
      VALUES(${noteVersionId},${noteId},${scope.workspaceId},1,'{}',${scope.userId},${createHash("sha256").update(text).digest("hex")})`;
    await tx`INSERT INTO note_blocks(version_id,workspace_id,ordinal,type,content)
      VALUES(${noteVersionId},${scope.workspaceId},1,'paragraph',${text})`;
    await tx`UPDATE notes SET current_version_id=${noteVersionId} WHERE id=${noteId}`;
  });
  return { kind: "note_version" as const, noteId, noteVersionId };
}

async function lease(scope: { workspaceId: string; userId: string }, runId: string, revision = 1) {
  const leaseToken = randomUUID();
  const [job] = await admin`UPDATE jobs SET status='running',lease_token=${leaseToken},started_at=now()
    WHERE id=(SELECT id FROM jobs WHERE workspace_id=${scope.workspaceId} AND payload->>'runId'=${runId}
      AND payload->>'revision'=${String(revision)} AND type='agent_run_advance' AND status='pending' ORDER BY id LIMIT 1) RETURNING id`;
  assert.ok(job, "durable outbox must supply a pending advance");
  return { id: String(job.id), workspaceId: scope.workspaceId, requestedBy: scope.userId, leaseToken };
}

type Child = { status: string; operationId: string; execution: { kind: "job"; id: string }; reused?: boolean };
function startExpansion(advance: AgentWorkerAdvanceStore, noteId: string, noteVersionId: string, providerCallId: string) {
  return invokeNoteCapability(advance, { id: providerCallId, name: EXPANSION, arguments: { noteId, noteVersionId } }) as Promise<Child>;
}

function drafts() {
  return [{
    candidateId: randomUUID(), requestId: randomUUID(),
    title: "光合作用的能量来源",
    relationship: "沿着叶绿体这条线继续追问，能量究竟从哪里来。",
    sourceReferences: [{ blockOrdinal: 1, quote: "叶绿体利用光能制造有机物。" }],
    blocks: [{ type: "paragraph", content: "光是能量进入这篇笔记的入口。" }],
    selected: false,
  }];
}

/** 领域表里的那一行：真实保存下来的待选草稿批次。drafts 必须按真 jsonb 写入。 */
function saveDraft(noteId: string, noteVersionId: string, jobId: string, userId: string, workspaceId: string, requestId: string) {
  return admin.begin(async (tx) => {
    await tx`INSERT INTO note_expansion_tasks(id,workspace_id,user_id,note_id,note_version_id,request_id,drafts)
      VALUES(${jobId},${workspaceId},${userId},${noteId},${noteVersionId},${requestId},${tx.json(drafts())})`;
  });
}
function repointDraft(jobId: string, noteId: string, noteVersionId: string) {
  return admin.begin(async (tx) => {
    await tx`UPDATE note_expansion_tasks SET note_id=${noteId},note_version_id=${noteVersionId} WHERE id=${jobId}`;
  });
}

/**
 * advance job 的真实收尾。store.release() 只清掉 agent_runs.advance_job_id，不会结掉
 * jobs 里那一行——生产中是 worker 交还租约后由 astella_finish_job 收尾。夹具必须补上这一步：
 * 留着一条 running 的 advance job，会让 0368 恢复函数里的
 * `NOT EXISTS(... type='agent_run_advance' AND status IN ('pending','running'))` 判成假，
 * 于是它不再排下一次续跑——那是 active outbox 的防重，不是缺陷。
 */
function finishAdvance(jobId: string) {
  return admin`UPDATE jobs SET status='succeeded',lease_token=NULL,finished_at=now() WHERE id=${jobId}`;
}

/** 收掉一次待核对的事件，然后返回目标当前对外的说法。 */
async function settle(scope: { workspaceId: string; userId: string }, runId: string) {
  const leaseRow = await lease(scope, runId);
  const store = createAgentAdvanceStore(workerPorts, leaseRow, runId, 1);
  assert.ok(await store.acquire());
  await store.release(false);
  await finishAdvance(leaseRow.id);
  return api.get(scope, runId);
}

/**
 * 走一次真实的结果未知核对：把目标放回等待态、把上次核对推旧，
 * 然后调用 worker 真正调用的那个恢复函数。`exhausted` 用来模拟核对预算已用尽，
 * 此时唯一能再唤醒目标的理由就是「产物真的落库了」。
 */
async function reconcile(runId: string, operationId: string, options: { exhausted?: boolean } = {}) {
  await admin.begin(async (tx) => {
    await tx`UPDATE agent_runs SET status='waiting',advance_job_id=NULL,advance_lease_token=NULL WHERE id=${runId}`;
    if (options.exhausted) {
      await tx`UPDATE agent_operations SET receipt_checks=4,updated_at=now()-interval '1 minute' WHERE id=${operationId}`;
    } else {
      await tx`UPDATE agent_operations SET updated_at=now()-interval '1 minute' WHERE id=${operationId}`;
    }
  });
  await workerClient`SELECT astella_enqueue_agent_recovery()`;
  const [{ n }] = await admin`SELECT count(*)::int n FROM agent_run_events
    WHERE operation_id=${operationId} AND processed_at IS NULL`;
  return n;
}

test("拓展语义幂等不重排；job 成功但没有真实保存记录时不报完成，草稿落库后才交付", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const run = await api.create(scope, { requestId: randomUUID(), goal: "把这篇笔记往前拓展一层", inputs: [f.input] });
  const first = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, first, run.runId, 1);
  await advance.acquire();

  const child = await startExpansion(advance, f.input.noteId, f.input.noteVersionId, "provider-1");
  assert.equal(child.status, "accepted", "accepted 只是接受，不是完成");
  const repeated = await startExpansion(advance, f.input.noteId, f.input.noteVersionId, "provider-2");
  assert.equal(repeated.execution.id, child.execution.id);
  assert.equal(repeated.operationId, child.operationId);
  const [{ n }] = await admin`SELECT count(*)::int n FROM jobs WHERE type=${EXPANSION} AND workspace_id=${scope.workspaceId}`;
  assert.equal(n, 1, "同一目标同一版本的拓展只应排一个 job");
  await advance.release(false);
  await finishAdvance(first.id);

  // 0368 的触发器记录 child job 的真实状态，并排一次续跑。
  await admin`UPDATE jobs SET status='succeeded',lease_token=NULL,finished_at=now() WHERE id=${child.execution.id}`;
  const unknown = await settle(scope, run.runId);
  assert.equal(unknown.operations[0]!.status, "outcome_unknown");
  assert.deepEqual(unknown.artifacts, [], "没有真实保存记录就没有产物");
  assert.match(unknown.operations[0]!.error ?? "", /回执暂时读不到/);
  const [{ allowed }] = await workerPorts.transaction(scope, (tx) => tx.execute(
    query`SELECT astella_agent_job_current(${child.execution.id},${scope.workspaceId},${scope.userId},false) AS allowed`)) as { allowed: boolean }[];
  assert.equal(allowed, true, "结果未知不等于可以重做一次");
  const [{ rerun }] = await admin`SELECT count(*)::int rerun FROM jobs WHERE type=${EXPANSION} AND workspace_id=${scope.workspaceId}`;
  assert.equal(rerun, 1, "回执不确定时不得再排一个生成");

  // 草稿真的落库之后，回执才被采用；产物指向 taskId = jobId 和那一版笔记。
  await saveDraft(f.input.noteId, f.input.noteVersionId, child.execution.id, scope.userId, scope.workspaceId, child.operationId);
  assert.equal(await reconcile(run.runId, child.operationId), 1, "真实落库后应当能被再次核对");
  const delivered = await settle(scope, run.runId);
  assert.equal(delivered.operations[0]!.status, "succeeded");
  assert.equal(delivered.operations[0]!.error, null, "成功后不该留着未知回执的话术");
  assert.deepEqual(delivered.artifacts, [{
    kind: "note_expansion", id: child.execution.id, jobId: child.execution.id,
    noteId: f.input.noteId, noteVersionId: f.input.noteVersionId,
  }]);

  // 已存的只是待选草稿：用户还没有收下任何一篇，也不会自动制卡。
  const [task] = await admin`SELECT confirmed_candidate_ids,confirmed_at FROM note_expansion_tasks WHERE id=${child.execution.id}`;
  assert.equal(task?.confirmed_candidate_ids, null);
  assert.equal(task?.confirmed_at, null);
  const [{ notes }] = await admin`SELECT count(*)::int notes FROM notes WHERE workspace_id=${scope.workspaceId}`;
  assert.equal(notes, 1, "草稿不会自己变成新笔记");
});

test("两份冻结材料之间串错产物：类型、归属、payload 材料与冻结集合都要对上", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const secondInput = await anotherNote(scope, "密度", "密度表示单位体积物质的质量。");
  const outside = await anotherNote(scope, "浮力", "浮力来自液体对物体的托举。");
  const run = await api.create(scope, { requestId: randomUUID(), goal: "把这两篇都拓展一层", inputs: [f.input, secondInput] });
  const first = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, first, run.runId, 1);
  await advance.acquire();
  // 这次操作要的是第一篇；note-capabilities 把它冻结进了 job payload。
  const child = await startExpansion(advance, f.input.noteId, f.input.noteVersionId, "provider-first-note");
  await advance.release(false);
  await finishAdvance(first.id);
  // 回执现在按 execution 分派并返回三档：result / failed / pending。
  // 这里这一格全是「认得出产物」与「认不出」的对立——认不出对 job 执行体一律是
  // pending（领域事实还不足以定性），不是 failed：没有任何一条分支说这次操作明确失败。
  const read = (overrides: Partial<OperationReceiptRequest> = {}) =>
    workerPorts.transaction(scope, (tx) => readOperationResultReceipt(tx, {
      capability: EXPANSION, execution: child.execution, scope, inputs: [f.input, secondInput], ...overrides,
    }));
  const artifactOf = (receipt: OperationReceiptV1) => {
    assert.equal(receipt.kind, "result", `应当认出产物，实际是 ${receipt.kind}`);
    assert.ok(receipt.kind === "result" && receipt.result.kind === "artifact");
    return receipt.result.artifact;
  };
  const notDelivered = (receipt: OperationReceiptV1, why: string) =>
    assert.equal(receipt.kind, "pending", why);
  await saveDraft(f.input.noteId, f.input.noteVersionId, child.execution.id, scope.userId, scope.workspaceId, child.operationId);
  assert.deepEqual(artifactOf(await read()), {
    kind: "note_expansion", id: child.execution.id, jobId: child.execution.id,
    noteId: f.input.noteId, noteVersionId: f.input.noteVersionId,
  }, "逐字对上的草稿才是这次操作的产物");

  // 串到同一空间的另一份冻结材料上：payload 说第一篇，草稿却是第二篇。
  await repointDraft(child.execution.id, secondInput.noteId, secondInput.noteVersionId);
  notDelivered(await read(), "另一份材料的产物不能顶替这次操作");
  // 同一篇笔记的另一个版本：noteId 对上了也还不算。
  await repointDraft(child.execution.id, f.input.noteId, f.otherVersionId);
  notDelivered(await read(), "别的版本的产物不能顶替这次操作");
  // 换个能力去读：类型不对就不成立。
  notDelivered(await read({ capability: "note_overview_generate" }), "类型不对不成立");
  // 未登记的能力永远拿不到产物。
  notDelivered(await read({ capability: "note_expansion_generate_v2" }), "未登记能力没有产物");
  // 换 user / 换 workspace 读同一行，读不到别人的草稿。
  notDelivered(await read({ scope: { workspaceId: scope.workspaceId, userId: randomUUID() } }), "读不到别人的草稿");
  notDelivered(await read({ scope: { workspaceId: f.otherWorkspaceId, userId: scope.userId } }), "读不到别的空间的草稿");
  // 换执行体：别的 job 的草稿不认。
  notDelivered(await read({ execution: { kind: "job", id: randomUUID() } }), "别的 job 的草稿不认");
  // 换一个**种类的执行体**去读同一行：kind 也是绑定的一部分，只有 job 才配这三类产物。
  notDelivered(await read({ execution: { kind: "card_generation", id: randomUUID() } }),
    "card_generation 执行体不配笔记产物的回执");

  // payload 与草稿都指向第三篇，而那一篇根本没被冻结进这个目标：仍然不认。
  // ::text 必须显式写：postgres.js 把参数发成 unknown，jsonb_build_object 的 any 参数无隐式来源，报 42P18。
  await admin.begin(async (tx) => {
    await tx`UPDATE jobs SET payload=payload || jsonb_build_object('noteId',${outside.noteId}::text,'noteVersionId',${outside.noteVersionId}::text)
      WHERE id=${child.execution.id}`;
  });
  await repointDraft(child.execution.id, outside.noteId, outside.noteVersionId);
  notDelivered(await read(), "payload 自己也对得上，但材料不在目标的冻结集合里");
  artifactOf(await read({ inputs: [f.input, secondInput, outside] }));

  // 走一遍真实的状态机：串错的草稿不会被 store 报成完成，改回来才会。
  await admin`UPDATE jobs SET payload=payload || jsonb_build_object(
    'noteId',${f.input.noteId}::text,'noteVersionId',${f.input.noteVersionId}::text)
    WHERE id=${child.execution.id}`;
  await repointDraft(child.execution.id, secondInput.noteId, secondInput.noteVersionId);
  await admin`UPDATE jobs SET status='succeeded',lease_token=NULL,finished_at=now() WHERE id=${child.execution.id}`;
  const crossed = await settle(scope, run.runId);
  assert.equal(crossed.operations[0]!.status, "outcome_unknown", "串到另一份材料的草稿不能报完成");
  assert.deepEqual(crossed.artifacts, []);
  await repointDraft(child.execution.id, f.input.noteId, f.input.noteVersionId);
  assert.equal(await reconcile(run.runId, child.operationId), 1);
  const settled = await settle(scope, run.runId);
  assert.equal(settled.operations[0]!.status, "succeeded", "改回本次操作真正要的那一版后才交付");
  assert.equal(settled.artifacts[0]!.noteVersionId, f.input.noteVersionId);
  assert.equal(settled.artifacts[0]!.noteId, f.input.noteId);
});

test("核对预算用尽后，只有逐字对上的真实草稿才会再醒一次目标（0370 迁移）", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const secondInput = await anotherNote(scope, "浮力", "浮力来自液体对物体的托举。");
  const run = await api.create(scope, { requestId: randomUUID(), goal: "拓展这篇", inputs: [f.input, secondInput] });
  const first = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, first, run.runId, 1);
  await advance.acquire();
  const child = await startExpansion(advance, f.input.noteId, f.input.noteVersionId, "provider-recovery");
  await advance.release(false);
  await finishAdvance(first.id);
  await admin`UPDATE jobs SET status='succeeded',lease_token=NULL,finished_at=now() WHERE id=${child.execution.id}`;
  assert.equal((await settle(scope, run.runId)).operations[0]!.status, "outcome_unknown");

  // 核对预算已用尽：此时唯一还能唤醒目标的理由就是产物真的落库了。
  assert.equal(await reconcile(run.runId, child.operationId, { exhausted: true }), 0,
    "没有任何真实保存记录时不得再唤醒");
  await saveDraft(secondInput.noteId, secondInput.noteVersionId, child.execution.id, scope.userId, scope.workspaceId, child.operationId);
  assert.equal(await reconcile(run.runId, child.operationId, { exhausted: true }), 0,
    "串到另一份材料的草稿不得让未知结果反复唤醒");
  await repointDraft(child.execution.id, f.input.noteId, f.input.noteVersionId);
  assert.equal(await reconcile(run.runId, child.operationId, { exhausted: true }), 1,
    "真实落库且逐字对上的草稿必须还能把目标叫醒一次");

  const settled = await settle(scope, run.runId);
  assert.equal(settled.operations[0]!.status, "succeeded");
  assert.equal(settled.artifacts[0]!.kind, "note_expansion");
  assert.equal(settled.artifacts[0]!.id, child.execution.id);
});

test("目标被停掉或被新要求替代后，拓展不再调用模型；模型调用记在目标预算上", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const goal = `这一次只讲能量来源。${"补充背景材料。".repeat(500)}最后的限制：不要自动收下这批草稿，也不要制卡。`;
  const run = await api.create(scope, { requestId: randomUUID(), goal, inputs: [f.input] });
  const first = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, first, run.runId, 1);
  await advance.acquire();
  const child = await startExpansion(advance, f.input.noteId, f.input.noteVersionId, "provider-fence");

  const jobContext = {
    id: child.execution.id, workspaceId: scope.workspaceId, requestedBy: scope.userId, leaseToken: randomUUID(),
    payload: { noteId: f.input.noteId, noteVersionId: f.input.noteVersionId,
      requestId: child.operationId, agentRunId: run.runId, agentRevision: 1 },
  };
  const context = await loadAgentGenerationContext(jobContext);
  assert.match(context.instructions, /这一次只讲能量来源/, "用户当前的要求要真的进入拓展的提示");
  assert.ok(context.instructions.includes(JSON.stringify(goal)), "长要求末尾的限制不能被提示裁剪丢掉");
  const before = (await api.get(scope, run.runId)).modelCalls;
  await context.reserveModelCall();
  assert.equal((await api.get(scope, run.runId)).modelCalls, before + 1, "子任务的模型调用记在目标的预算上");

  // 目标停掉之后，同一份上下文不能再占一次预算，也就不会再调一次模型。
  await api.control(scope, run.runId, 1, "cancel");
  await assert.rejects(context.reserveModelCall(), /这次生成已经停止/);
  assert.equal((await api.get(scope, run.runId)).modelCalls, before + 1, "被拦下的调用不占预算");

  // 要求已经换代时，旧 revision 的上下文同样不再继续。
  const revised = await api.revise(scope, run.runId, 1, "换一个方向重新拓展");
  assert.equal(revised.revision, 2);
  await assert.rejects(loadAgentGenerationContext(jobContext), /已经被新的要求替代/);
});

// ─── 42 阶段 1 子任务 D：读取真实拓展草稿 ────────────────────────────────────────
//
// 前面四条钉的是「生成与回执」。这三条钉的是「读」：Agent 看得见自己保存的草稿内容，
// 看得见用户手动改过的那一版，一个 20000 字的长块能分页读完而不是永远截在尾部，
// 而越权的那几种读法——另一个目标、另一个用户、另一个空间、错版本、错 payload 绑定——
// 一律读不到。只读能力不得留下任何痕迹：读完前后 operation/job/模型调用都不变。

const READ = "note_expansion_read";
const READ_MAX_OUTPUT_CHARS = 4000;
// 用清单里那一份真实校验器断言「next 能原样带回」，不在测试里复制 schema。
const noteReadManifest = noteAgentCapabilityManifest.find((entry) => entry.definition.name === READ)!;

type Scope = { workspaceId: string; userId: string };
const inApi = <T>(scope: Scope, action: (tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0]) => Promise<T>) =>
  withWorkspaceTransaction(scope, action);

function readDrafts(store: AgentWorkerAdvanceStore, args: Record<string, unknown>) {
  return invokeNoteCapability(store, { id: randomUUID(), name: READ, arguments: args }) as Promise<ExpansionReadResult>;
}

/** 断言这一页真的读到了正文，并把类型收窄到带正文的那一支。 */
async function readPage(store: AgentWorkerAdvanceStore, args: Record<string, unknown>) {
  const page = await readDrafts(store, args);
  if (!page.available) throw new assert.AssertionError({ message: `这一页应当读得到，实际：${page.reason}` });
  return page;
}

/**
 * 按**边界层次**断言稳定错误码，不是宽泛 catch。
 *
 * 三层各拒各的：能力层 403 input_outside_goal（材料不在冻结集合）、可见性层 404
 * input_not_found（材料失权）、领域绑定层 404 expansion_task_not_found（不是这个目标的成果）、
 * 围栏层 409 advance_obsolete（目标停了）、位置/版本层 400 invalid_read_position。
 * 断言 code 而不是只匹配话术：话术会改，code 是契约。
 */
async function rejectsWith(promise: Promise<unknown>, code: string, message?: RegExp) {
  await assert.rejects(promise, (error: Error & { code?: string }) => {
    assert.equal(error.code, code, `这一层应当回 ${code}，实际 ${error.code}：${error.message}`);
    if (message) assert.match(error.message, message);
    return true;
  });
}

/** 去掉每段前面的序号标记，只留模型真正读到的那些字。 */
function stripPageMarks(body: string) {
  return body.replace(/【草稿 \d+ · 第 \d+ 段 · \w+】\n/g, "");
}

/** 读取前后的账本快照：只读能力必须一个 operation、一个 job 都不多出来。 */
async function counts(scope: Scope, runId: string) {
  const [row] = await admin`
    SELECT (SELECT count(*)::int FROM agent_operations WHERE run_id=${runId}) AS operations,
           (SELECT count(*)::int FROM jobs WHERE workspace_id=${scope.workspaceId}) AS jobs,
           (SELECT model_calls::int FROM agent_runs WHERE id=${runId}) AS model_calls,
           (SELECT count(*)::int FROM note_expansion_tasks WHERE workspace_id=${scope.workspaceId}) AS tasks`;
  return [row.operations, row.jobs, row.model_calls, row.tasks];
}

async function currentCandidateId(taskId: string) {
  const [row] = await admin`SELECT drafts->0->>'candidateId' AS candidate_id FROM note_expansion_tasks WHERE id=${taskId}`;
  return String(row.candidate_id);
}

/** 走真实状态机把一次拓展送成 succeeded（带 artifact），返回目标与那次操作。 */
async function deliveredExpansion(
  scope: Scope,
  f: Awaited<ReturnType<typeof fixture>>, providerCallId: string, inputs = [f.input],
) {
  const run = await api.create(scope, { requestId: randomUUID(), goal: "把这篇笔记往前拓展一层", inputs });
  const first = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, first, run.runId, 1);
  await advance.acquire();
  const child = await startExpansion(advance, f.input.noteId, f.input.noteVersionId, providerCallId);
  await advance.release(false);
  await finishAdvance(first.id);
  await admin`UPDATE jobs SET status='succeeded',lease_token=NULL,finished_at=now() WHERE id=${child.execution.id}`;
  assert.equal((await settle(scope, run.runId)).operations[0]!.status, "outcome_unknown");
  await saveDraft(f.input.noteId, f.input.noteVersionId, child.execution.id, scope.userId, scope.workspaceId, child.operationId);
  assert.equal(await reconcile(run.runId, child.operationId), 1, "真实落库后应当能被再次核对");
  assert.equal((await settle(scope, run.runId)).operations[0]!.status, "succeeded");
  return { run, child };
}

/** 给读取开一个真实续跑租约：读能力也要过一次 advance 的围栏。 */
async function reader(scope: Scope, runId: string, revision: number) {
  const leaseRow = await lease(scope, runId, revision);
  const store = createAgentAdvanceStore(workerPorts, leaseRow, runId, revision);
  assert.ok(await store.acquire(), "读取也要在一次真实的续跑里进行");
  return store;
}

test("读取读到的是当前保存的草稿：手动修改看得见，超长单块能分页读完，且不留任何痕迹", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const { run, child } = await deliveredExpansion(scope, f, "provider-read");
  // 目标被新要求替代到第 2 版：成果属于第 1 版的操作，但仍属于同一个 run，仍读得到。
  assert.equal((await api.revise(scope, run.runId, 1, "换一个方向继续")).revision, 2);
  const store = await reader(scope, run.runId, 2);
  const args = { noteId: f.input.noteId, noteVersionId: f.input.noteVersionId, taskId: child.execution.id };

  const firstPage = await readPage(store, args);
  assert.equal(firstPage.taskId, child.execution.id);
  assert.equal(firstPage.taskState, "ready", "草稿已存但用户还没收下，仍是等挑选的 ready");
  assert.equal(firstPage.available, true);
  assert.equal(firstPage.confirmed, false);
  assert.equal(firstPage.artifactRevision, 1, "成果来自第 1 版的操作，要如实报出来");
  assert.equal(firstPage.candidateOrdinal, 1);
  assert.equal(firstPage.totalCandidates, 1);
  assert.equal(firstPage.title, "光合作用的能量来源");
  assert.equal(firstPage.relationship, "沿着叶绿体这条线继续追问，能量究竟从哪里来。");
  assert.deepEqual(firstPage.sourceReferences, [{ blockOrdinal: 1, quote: "叶绿体利用光能制造有机物。", quoteTruncated: false }]);
  assert.equal(firstPage.complete, true, "这一篇只有一段，一次就读完了");
  assert.equal(firstPage.next, null);
  assert.match(firstPage.body, /光是能量进入这篇笔记的入口。/);

  // 用户在草稿册里改过：标题、正文都要读到改过的那一版，而不是库里生成时那一版。
  const long = Array.from({ length: 19_990 }, (_, index) => String(index % 10)).join("") + "结尾标记";
  const editedTitle = "光合作用的能量来源（用户改过）";
  const candidateId = await currentCandidateId(child.execution.id);
  await inApi(scope, (tx) => updateNoteExpansionTaskDrafts(tx, scope, f.input.noteId, child.execution.id, {
    drafts: [{ candidateId, title: editedTitle, selected: true,
      blocks: [{ type: "paragraph", content: long }] }],
  }));
  const ledgerBefore = await counts(scope, run.runId);

  const edited = await readPage(store, args);
  assert.equal(edited.title, editedTitle, "读到的必须是手动改过的那一版");
  assert.equal(edited.selected, true, "勾选状态如实回传，读不改它");
  assert.equal(edited.confirmed, false, "勾选不是收下：确认状态不受读取影响");
  assert.equal(edited.truncated, true, "一个两万个字的单块绝不能一次读完");
  assert.ok(edited.next && (edited.next.startBlockOffset > 0 || edited.next.startBlockOrdinal > 1),
    `切点必须交出段内位置：${JSON.stringify(edited.next)}`);
  // next 的字段名就是工具参数名：原样 spread 进下一次调用，必须直接过 strict schema。
  assert.equal(noteReadManifest.argumentSchema.safeParse({ ...args, ...edited.next }).success, true,
    "next 必须能原样带回去，不能靠改名或删字段");
  assert.ok(edited.remainingChars > 0, "没读到的部分要说得出还剩多少，不能说成读完");

  // 照 next 一直读：拼起来必须正好是那篇草稿，一个字不多一个字不少。
  const read = [stripPageMarks(edited.body)];
  let page = edited;
  for (let step = 0; page.next && step < 100; step += 1) {
    page = await readPage(store, { ...args, ...page.next });
    const serialized = JSON.stringify(page);
    assert.ok(serialized.length <= READ_MAX_OUTPUT_CHARS, `一次读取序列化 ${serialized.length} 字，越过了 manifest 的上限`);
    assert.ok(page.body.length > 0, "任何一页都要读到东西，不能空转");
    read.push(stripPageMarks(page.body));
  }
  assert.equal(page.next, null, "读到结尾时 next 必须是 null，这时才可以说这一篇读完了");
  assert.equal(read.join(""), long, "分页读完的结果必须正好是那一篇草稿的正文");
  assert.ok(page.complete === true && page.truncated === false);

  // 位置越界明确报错，不 clamp 回最后一篇/第一段去重读旧内容。
  await rejectsWith(readDrafts(store, { ...args, startCandidateOrdinal: 2 }), "invalid_read_position", /只有 1 篇草稿/);
  await rejectsWith(readDrafts(store, { ...args, startBlockOrdinal: 2 }), "invalid_read_position", /只有 1 段/);
  await rejectsWith(readDrafts(store, { ...args, startBlockOffset: 19_995 }), "invalid_read_position", /超出了这一段/);
  // 从中间续读必须带版本令牌，否则两版正文会被拼成一篇。
  await rejectsWith(readDrafts(store, { ...args, startBlockOffset: 100 }), "invalid_read_position", /draftsUpdatedAt/);

  // 用户在分页期间又改了草稿：拿旧令牌续读必须被挡下，并说清是重来。
  const stale = { startCandidateOrdinal: 1, startBlockOrdinal: 1, startBlockOffset: 100, draftsUpdatedAt: edited.draftsUpdatedAt };
  const secondTitle = "光合作用的能量来源（用户又改过）";
  await inApi(scope, (tx) => updateNoteExpansionTaskDrafts(tx, scope, f.input.noteId, child.execution.id, {
    drafts: [{ candidateId, title: secondTitle, selected: true, blocks: [{ type: "paragraph", content: long }] }],
  }));
  const reopened = await readPage(store, args);
  assert.equal(reopened.title, secondTitle, "初页可以读最新编辑");
  assert.notEqual(reopened.draftsUpdatedAt, stale.draftsUpdatedAt, "两次编辑必须落在不同的版本上，这条断言才有意义");
  await rejectsWith(readDrafts(store, { ...args, ...stale }), "invalid_read_position", /重新读/);

  // 只读：不新建 operation/job，不动目标预算，不改确认态。
  assert.deepEqual(await counts(scope, run.runId), ledgerBefore, "读取不得留下任何 operation、job 或模型调用");
  const [confirmed] = await admin`SELECT confirmed_candidate_ids FROM note_expansion_tasks WHERE id=${child.execution.id}`;
  assert.equal(confirmed.confirmed_candidate_ids, null, "读取不收下任何草稿");
  const [{ notes }] = await admin`SELECT count(*)::int notes FROM notes WHERE workspace_id=${scope.workspaceId}`;
  assert.equal(notes, 1, "读取不会把草稿变成新笔记");
});

test("越权读取一律读不到：另一个目标、另一个用户、另一个空间、错版本与错 payload 绑定", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  // 冻结集合里放同一篇笔记的两个版本：只有这样，「版本错配」才会走到领域绑定那一层，
  // 而不是先被能力层的冻结输入检查挡下 —— 那两层是不同的判据，要分别断言。
  const v2 = { kind: "note_version" as const, noteId: f.noteId, noteVersionId: f.otherVersionId };
  const { run, child } = await deliveredExpansion(scope, f, "provider-scope", [f.input, v2]);
  assert.equal((await api.revise(scope, run.runId, 1, "换一个方向继续")).revision, 2);
  const store = await reader(scope, run.runId, 2);
  const args = { noteId: f.input.noteId, noteVersionId: f.input.noteVersionId, taskId: child.execution.id };
  assert.equal((await readPage(store, args)).taskId, child.execution.id, "本目标读自己的成果");

  // 同一空间里的另一个目标：材料一样、用户一样，只有 run 不同 —— 不读。
  const otherRun = await api.create(scope, { requestId: randomUUID(), goal: "另一件事", inputs: [f.input] });
  const otherStore = await reader(scope, otherRun.runId, 1);
  await rejectsWith(readDrafts(otherStore, args), "expansion_task_not_found");

  // 换用户、换空间：直读领域读取半，用别的作用域拿同一行。
  for (const foreign of [{ workspaceId: f.otherWorkspaceId, userId: scope.userId },
    { workspaceId: scope.workspaceId, userId: randomUUID() }]) {
    const page = await workerPorts.transaction(foreign, (tx) => readExpansionDrafts(tx, {
      ...foreign, runId: run.runId, ...args, startCandidateOrdinal: 1, startBlockOrdinal: 1, startBlockOffset: 0,
      maxOutputChars: READ_MAX_OUTPUT_CHARS }));
    assert.equal(page, null, `换个作用域不该读得到：${foreign.workspaceId === scope.workspaceId ? "别的用户" : "别的空间"}`);
  }

  // 领域行的版本是 v1，读 v2：版本在冻结集合里，所以这一层必须由领域绑定拒绝。
  await rejectsWith(readDrafts(store, { ...args, noteVersionId: f.otherVersionId }), "expansion_task_not_found");

  // 不在冻结集合里的版本：能力层先挡下，与上面那条是不同的边界。
  const outside = await anotherNote(scope, "浮力", "浮力来自液体对物体的托举。");
  await rejectsWith(readDrafts(store, { noteId: outside.noteId, noteVersionId: outside.noteVersionId, taskId: child.execution.id }),
    "input_outside_goal");

  // 领域行的材料与 job payload 对不上：读侧不认这一批。
  await admin.begin(async (tx) => {
    await tx`UPDATE jobs SET payload=payload || jsonb_build_object('noteVersionId',${f.otherVersionId}::text) WHERE id=${child.execution.id}`;
  });
  await rejectsWith(readDrafts(store, args), "expansion_task_not_found");
  await admin.begin(async (tx) => {
    await tx`UPDATE jobs SET payload=payload || jsonb_build_object('noteVersionId',${f.input.noteVersionId}::text) WHERE id=${child.execution.id}`;
  });

  // 材料失权：源笔记被软删之后，同一个目标里的旧 revision 成果也不再读得到。
  await admin`UPDATE notes SET deleted_at=now() WHERE id=${f.input.noteId}`;
  await rejectsWith(readDrafts(store, args), "input_not_found", /这版笔记现在读不到/);
  await admin`UPDATE notes SET deleted_at=NULL WHERE id=${f.input.noteId}`;

  // 目标停掉之后，迟到的那一次执行不能再借工具读走任何东西。
  await api.control(scope, run.runId, 2, "cancel");
  await rejectsWith(readDrafts(store, args), "advance_obsolete");
});

test("不能把目标输入乙的批次当成输入甲那次操作的成果", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const secondInput = await anotherNote(scope, "密度", "密度表示单位体积物质的质量。");
  const { run, child } = await deliveredExpansion(scope, f, "provider-cross", [f.input, secondInput]);
  assert.equal((await api.revise(scope, run.runId, 1, "换一个方向继续")).revision, 2);
  const store = await reader(scope, run.runId, 2);

  // 草稿行被改指到输入乙那一篇：它同样在冻结集合里、同样可见，
  // 但 job payload 冻结的是输入甲 —— 读侧必须按 payload 判，不能只看「在不在 inputs 里」。
  await repointDraft(child.execution.id, secondInput.noteId, secondInput.noteVersionId);
  await rejectsWith(readDrafts(store, {
    noteId: secondInput.noteId, noteVersionId: secondInput.noteVersionId, taskId: child.execution.id }), "expansion_task_not_found");

  // 材料不在目标冻结集合里时，能力层就先挡住：这份材料没交给这个目标。
  const outside = await anotherNote(scope, "浮力", "浮力来自液体对物体的托举。");
  await rejectsWith(readDrafts(store, {
    noteId: outside.noteId, noteVersionId: outside.noteVersionId, taskId: child.execution.id }), "input_outside_goal");
});
