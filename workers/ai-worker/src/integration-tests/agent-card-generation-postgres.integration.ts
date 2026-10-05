/**
 * 42 阶段 1 子任务 R：`card_generation_generate` 接入持续 Agent 的整链回归。
 *
 * 这份夹具只在**专用的一次性库**上跑（`scripts/dev-disposable-db.sh`；主会话另备
 * 卡片验收库）。它钉的是几条读源码推断不出来的语义：
 *
 *   1. 一次 invoke 在**同一个事务**里造出领域 run 与**正好一个**初始简化链 outbox，
 *      且**不写假 jobs**：`agent_operations.job_id IS NULL`，执行体落在
 *      `card_generation_run_id` 上，"排到了"不等于"这批卡已经有了"。
 *   2. 操作身份只由影响生成的规范参数组成：换 provider call id 复用同一批，
 *      换任何影响生成的参数才长出新一批，第 9 次被 `operation_budget` 挡住。
 *   3. 绑定是四层的：run 身份、归属空间/用户、冻结材料集合、候选可审性。
 *      少一层就串账——串到别的空间、别的用户、没冻结的材料，或一张都不可审的批次。
 *   4. 可审交付 = 审核开放 ∧ **最新**修订 ∧ passed ∧ undecided ∧ unpublished ∧ 有
 *      binding plan hash。被更新的修订遮住的旧 passed、已决定的、已发布的、
 *      没有 binding 的，**都不算**交付。
 *   5. 零推荐是**正常收口**：`no_cards_recommended` 是 succeeded 且不产出 artifact；
 *      捏一张空 artifact 才是失败。理由只取领域已保存的事件，不猜正文。
 *   6. 共同预算按**每一次真实 provider.complete** 精确计数（含内核自动补采样）；
 *      没有绑定 Agent 目标的普通制卡不记 Agent 的账。
 *   7. 迟到结果（取消）不能成为当前交付；恢复扫描不重复创建 run，核对上限不被绕过。
 *
 * 除「造夹具」外没有手写 SQL 去伪造状态机：job 状态变化靠触发器，恢复靠真实的
 * `ailearn_enqueue_agent_recovery()`，完成判定走真正的 advance store，候选与事件
 * 全部来自**真的跑一次 V3 简化链**（确定性 provider，不外发、不付真实模型钱）。
 */
import assert from "node:assert/strict";
import { createGenerationRunInTransaction } from "@ailearn/card-generation";
import type { CreateCardGenerationRunRequestV2 } from "@ailearn/shared/card-generation-v2-contracts";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql as query } from "drizzle-orm";
import * as schema from "@ailearn/shared/db-schema";
import {
  createAgentStore, createAgentAdvanceStore, readOperationResultReceipt,
  type AgentStorePorts, type OperationReceiptRequest, type OperationReceiptV1,
} from "@ailearn/agent-host";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";
import { invokeCardGenerationCapability } from "../agent/card-capabilities.ts";
import type { AgentWorkerAdvanceStore } from "../agent/store.ts";
import { assertFixtureWipeClean, wipeCardGenerationFixtures } from "./card-generation-fixture-cleanup.ts";
import { closeDatabase, type WorkerTransaction } from "../db.ts";
import { closeDatabase as closeApiDatabase } from "../../../../apps/api/src/db/client.ts";

const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 2 });
const apiClient = postgres(testDatabaseUrl("DATABASE_URL_API"), { max: 2 });
const workerClient = postgres(testDatabaseUrl("DATABASE_URL_WORKER"), { max: 2 });

/**
 * 与 worker 生产那份同一个 drizzle 构造：能力适配器要的是**真实事务**，
 * `ReturnType<typeof createAgentAdvanceStore>` 会退回擦掉事务类型的窄口。
 */
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
/** Existing unbound domain runs remain readable/executable. New page requests
 * have Agent parents; use the real domain creator to model this legacy state. */
function createUnboundHistoricalCardRun(scope: { workspaceId: string; userId: string }, version: string,
  request: CreateCardGenerationRunRequestV2, key: string) {
  return ports(apiClient).transaction(scope, tx => createGenerationRunInTransaction(tx, scope, version, request, key,
    { maxInFlightRuns: 3, dailyRunLimit: 50 }));
}
const api = createAgentStore({ ...ports(apiClient), ensureIdentity: async (tx, scope) => {
  await tx.execute(query`INSERT INTO user_companion_account_state(user_id) VALUES(${scope.userId}) ON CONFLICT(user_id) DO NOTHING`);
} });
const workerPorts = ports(workerClient);

const CARD = "card_generation_generate";
/** 现役制卡链的初始那一发。审核台那几发（逐候选／整批重排）不是它。 */
const SIMPLIFIED = "card_generation_simplified_v1";

/** 一篇真能出好几张卡的笔记：确定性 provider 读得懂、内容门禁放得过。 */
const LEARNABLE_BLOCKS = [
  "TCP 建立连接时双方各自确认一次序号，确认完成之后才开始传数据。",
  "索引可以加快查询速度，但只有查询条件包含索引最左列时索引才会被使用。",
  "HTTP 是应用层协议，它本身不规定底层使用什么传输方式。",
  "事务的隔离级别决定并发事务之间能看见彼此多少中间状态。",
  "哈希表负载因子过高时会发生冲突，冲突多了查找就会退化成线性扫描。",
];
/** 全篇都被内容门禁挡下：领域如实判定不值得出卡 ⇒ no_cards_recommended。 */
const UNLEARNABLE_BLOCKS = ["见附件。", "待定。", "TODO 补。"];

type NoteFixture = { noteId: string; noteVersionId: string };
const fixtures: { userId: string; workspaceIds: string[] }[] = [];

after(async () => {
  if (process.env.V3_KEEP_FIXTURES === "1") {
    console.log("[keep-fixtures] 跳过清理：这一次是给排查用的，跑完请重跑 disposable 脚本回到干净状态");
    await Promise.all([admin.end({ timeout: 5 }), apiClient.end({ timeout: 5 }), workerClient.end({ timeout: 5 })]);
    return;
  }
  // 清理交给共用台子（删完回读计数，不干净就抛）。**先关池再喊**：池开着抛会让整个
  // 文件挂在超时上，看起来像"用例慢"。
  let report;
  try {
    report = await wipeCardGenerationFixtures(admin,
      fixtures.flatMap(f => f.workspaceIds),
      fixtures.map(f => f.userId));
  } finally {
    await Promise.all([admin.end({ timeout: 5 }), apiClient.end({ timeout: 5 }), workerClient.end({ timeout: 5 })])
      .catch(() => undefined);
    await Promise.all([closeDatabase(), closeApiDatabase()]);
  }
  assertFixtureWipeClean(report);
});

/**
 * 一个用户、两个空间、一篇笔记的两个版本。
 * v1 是目标冻结的那一版，v2 是后来编辑的——用来钉"别的版本的产物不能顶账"。
 */
async function fixture(title = "网络与加密") {
  const userId = randomUUID(), workspaceIds = [randomUUID(), randomUUID()];
  const noteId = randomUUID(), noteVersionId = randomUUID(), otherVersionId = randomUUID();
  fixtures.push({ userId, workspaceIds });
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${userId},${`agent42r-${userId}@test.invalid`},'fixture','owner')`;
    for (const workspaceId of workspaceIds) {
      await tx`INSERT INTO workspaces(id,name,owner_id) VALUES(${workspaceId},'agent42r fixture',${userId})`;
      await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
    }
    await tx`INSERT INTO notes(id,workspace_id,title,created_by) VALUES(${noteId},${workspaceIds[0]},${title},${userId})`;
    for (const [versionId, versionNo, text] of [
      [noteVersionId, 1, LEARNABLE_BLOCKS[0]!], [otherVersionId, 2, "后来补写的一段。"],
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

/**
 * 另外一篇笔记。owner 可以是别的空间或别的用户——后者会自动补一个用户行
 * （notes.created_id 有外键，没有用户行就建不出"别人建的笔记"这一格）。
 */
async function anotherNote(
  owner: { workspaceId: string; userId: string }, title: string, blocks: string[],
): Promise<NoteFixture> {
  const noteId = randomUUID(), versionId = randomUUID();
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users(id,email,password_hash,role)
      VALUES(${owner.userId},${`agent42r-${owner.userId}@test.invalid`},'fixture','owner')
      ON CONFLICT(id) DO NOTHING`;
    await tx`INSERT INTO notes(id,workspace_id,title,created_by) VALUES(${noteId},${owner.workspaceId},${title},${owner.userId})`;
    // 列序与 VALUES 一一对应：created_by 是 uuid，content_hash 是文本。
    // 两者写反会把标题串灌进 created_by，报 invalid input syntax for type uuid。
    await tx`INSERT INTO note_versions(id,note_id,workspace_id,version_no,content_json,content_hash,created_by)
      VALUES(${versionId},${noteId},${owner.workspaceId},1,
        ${tx.json({ blocks: blocks.map(content => ({ type: "paragraph", content })) })},
        ${createHash("sha256").update(blocks.join("\n")).digest("hex")},${owner.userId})`;
    for (const [ordinal, content] of blocks.entries()) {
      await tx`INSERT INTO note_blocks(id,version_id,workspace_id,type,content,ordinal)
        VALUES(${randomUUID()},${versionId},${owner.workspaceId},'paragraph',${content},${ordinal + 1})`;
    }
  });
  return { noteId, noteVersionId: versionId };
}

/**
 * 认领目标的 advance job。**必须由持久 outbox 真实供给**，不凭空插一行。
 * 找不到时轮询一小会儿：唤醒可能刚由 0373 触发器或上一次 release 写进去。
 */
async function lease(scope: { workspaceId: string; userId: string }, runId: string, revision = 1) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const leaseToken = randomUUID();
    const [job] = await admin`UPDATE jobs SET status='running',lease_token=${leaseToken},started_at=now()
      WHERE id=(SELECT id FROM jobs WHERE workspace_id=${scope.workspaceId} AND payload->>'runId'=${runId}
        AND payload->>'revision'=${String(revision)} AND type='agent_run_advance' AND status='pending' ORDER BY id LIMIT 1) RETURNING id`;
    if (job) return { id: String(job.id), workspaceId: scope.workspaceId, requestedBy: scope.userId, leaseToken };
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`持久 outbox 必须供给一个待认领的 advance job（run=${runId} rev=${revision}）`);
}

/**
 * advance job 的真实收尾。`store.release()` 只清 agent_runs 上的租约指针，结 jobs
 * 那一行是生产里 worker 交还租约后由 ailearn_finish_job 做的——夹具必须补上，
 * 否则 0368 恢复函数会判成"已经有活跃 outbox"，不再排下一次续跑。
 */
const finishAdvance = (jobId: string) =>
  admin`UPDATE jobs SET status='succeeded',lease_token=NULL,finished_at=now() WHERE id=${jobId}`;

/** 收掉一次待核对的事件，然后返回目标当前对外的说法。 */
async function settle(scope: { workspaceId: string; userId: string }, runId: string, revision = 1) {
  const leaseRow = await lease(scope, runId, revision);
  const store = createAgentAdvanceStore(workerPorts, leaseRow, runId, revision);
  assert.ok(await store.acquire());
  await store.release(true);
  await finishAdvance(leaseRow.id);
  return api.get(scope, runId);
}

/** 走一次真实的结果未知核对：把目标放回等待态、推旧上次核对，再调生产用的恢复函数。 */
/** 只调生产的恢复扫描，不碰目标状态。取消场景必须用它，而不是 reconcile()。 */
async function scanRecovery() {
  await workerClient`SELECT ailearn_enqueue_agent_recovery()`;
}

async function reconcile(runId: string, operationId: string, options: { exhausted?: boolean } = {}) {
  await admin.begin(async (tx) => {
    await tx`UPDATE agent_runs SET status='waiting',advance_job_id=NULL,advance_lease_token=NULL WHERE id=${runId}`;
    if (options.exhausted) {
      await tx`UPDATE agent_operations SET receipt_checks=4,updated_at=now()-interval '1 minute' WHERE id=${operationId}`;
    } else {
      await tx`UPDATE agent_operations SET updated_at=now()-interval '1 minute' WHERE id=${operationId}`;
    }
  });
  await workerClient`SELECT ailearn_enqueue_agent_recovery()`;
  const [{ n }] = await admin`SELECT count(*)::int n FROM agent_run_events
    WHERE operation_id=${operationId} AND processed_at IS NULL`;
  return n;
}

type CardCall = {
  status: string; operationId: string; reused?: boolean; outboxId?: string;
  execution: { kind: string; id: string };
  noteId: string; noteVersionId: string;
};
function startCard(advance: AgentWorkerAdvanceStore, args: Record<string, unknown>, providerCallId: string) {
  return invokeCardGenerationCapability(advance,
    { id: providerCallId, name: CARD, arguments: args }) as Promise<CardCall>;
}
const cardArgs = (f: { noteId: string; noteVersionId: string }, extra: Record<string, unknown> = {}) =>
  ({ noteId: f.noteId, noteVersionId: f.noteVersionId, ...extra });
const asInput = (f: { noteId: string; noteVersionId: string }) =>
  ({ kind: "note_version" as const, noteId: f.noteId, noteVersionId: f.noteVersionId });

const runStatus = async (runId: string) =>
  String((await admin`SELECT status FROM card_generation_runs_v2 WHERE id=${runId} LIMIT 1`)[0]?.status);
const runCount = async (workspaceId: string) =>
  Number((await admin`SELECT count(*)::int n FROM card_generation_runs_v2 WHERE workspace_id=${workspaceId}`)[0]?.n ?? 0);

/** 领域 run 上的全部 outbox（按创建顺序）。审核台那几发也在这个读数里。 */
async function outboxes(runId: string) {
  const rows = await admin`SELECT id, job_type, status FROM card_generation_run_outbox_v2
    WHERE run_id=${runId} ORDER BY created_at, id` as unknown as
    Array<{ id: string; job_type: string; status: string }>;
  return [...rows];
}

/** 认领这个 run 的**初始那一发**简化链 job（退回 pending 与认领写在同一事务里）。 */
async function claimInitialOutbox(runId: string) {
  return claimOutboxOfType(runId, SIMPLIFIED);
}

/**
 * 认领某个 run 某一 jobType 的 job（退回 pending 与认领写在同一事务里）。
 * 整批那一发与逐候选那一发共用这一条认领路径——两条路径分开写，测试就会自己造出
 * 一条生产里不存在的"只有某一档能被认领"。
 */
async function claimOutboxOfType(runId: string, jobType: string) {
  const leaseToken = randomUUID();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const rows = await admin.begin(async (tx) => {
      await tx`
        UPDATE card_generation_run_outbox_v2
        SET status = 'pending', lease_token = NULL, lease_expires_at = NULL,
            started_at = NULL, processed_at = NULL, next_attempt_at = NULL
        WHERE run_id = ${runId} AND job_type = ${jobType} AND status <> 'completed'`;
      // 分发点读的是**驼峰** jobType；同一 run 同一 jobType 可以有多条（重排那几发），
      // 按 created_at 取最早那条还没跑的。UPDATE ... ORDER BY Postgres 不支持，先子查询定行。
      const picked = await tx`
        UPDATE card_generation_run_outbox_v2
        SET status = 'processing', started_at = now(),
            lease_expires_at = now() + interval '30 minutes', lease_token = ${leaseToken}
        WHERE id = (
          SELECT id FROM card_generation_run_outbox_v2
          WHERE run_id = ${runId} AND job_type = ${jobType} AND status = 'pending'
          ORDER BY created_at LIMIT 1
        )
        RETURNING id, workspace_id, run_id, job_type, payload` as unknown as
        Array<{ id: string; workspace_id: string; run_id: string; job_type: string; payload: Record<string, unknown> }>;
      const row = picked[0];
      return row
        ? { id: row.id, workspaceId: row.workspace_id, runId: row.run_id,
            jobType: row.job_type, payload: row.payload, leaseToken }
        : null;
    });
    if (rows) return rows;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`40 次尝试内没能认领到这个 run 的 ${jobType} job`);
}

/** 真跑一次 V3 简化链：确定性 provider（`CARD_GENERATION_V3_PROVIDER` 不设即离线档）。 */
async function runSimplifiedChain(runId: string) {
  const job = await claimInitialOutbox(runId);
  const { processV2OutboxJob } = await import("../handlers/card-generation-v2-handler.ts");
  await processV2OutboxJob(job);
  return job;
}

/**
 * 独立再读一次「台面上真的可审的候选有几张」。
 *
 * 回执判据是 EXISTS，所以任何否定场景都必须先证明**可审集合真的空了**——
 * 只断言 read() 没给产物，分不清"领域确实没有可审的"和"夹具根本没造出那张可审的"。
 * 谓词与 packages/agent-host/src/operation-receipt.ts 的 cardReceiptCandidate 同一句话，
 * 但这里是从测试侧独立写的：共用同一份查询就没有对照意义了。
 */
async function reviewableCount(runId: string) {
  const [{ n }] = await admin`
    SELECT count(*)::int n FROM card_generation_candidates_v2 c
    WHERE c.run_id=${runId}
      AND c.quality_state='passed' AND c.review_decision='undecided'
      AND c.publish_state='unpublished' AND c.evidence_binding_plan_hash IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM card_generation_candidates_v2 newer
        WHERE newer.workspace_id=c.workspace_id AND newer.run_id=c.run_id
          AND newer.candidate_id=c.candidate_id AND newer.revision>c.revision)`;
  return Number(n);
}

/** 台面上真正可保留的候选（与回执判据同一句话，独立再读一次作对照）。 */
async function reviewableCandidates(runId: string) {
  const rows = await admin`
    SELECT candidate_id, candidate_revision_id, revision, evidence_binding_plan_hash
    FROM card_generation_candidates_v2
    WHERE run_id = ${runId} AND publish_state = 'unpublished' AND quality_state = 'passed'
    ORDER BY created_at` as unknown as
    Array<{ candidate_id: string; candidate_revision_id: string; revision: number; evidence_binding_plan_hash: string | null }>;
  return [...rows];
}

/** 领域事件里读到的真实调用数（这一格是库里的读数，不是进程里的计数器）。 */
const domainModelCalls = async (runId: string) => {
  const rows = await admin`
    SELECT payload FROM card_generation_events_v2
    WHERE run_id = ${runId} AND event_type = 'card_generation.simplified_completed'
    ORDER BY event_seq DESC LIMIT 1` as unknown as Array<{ payload: Record<string, unknown> }>;
  return rows[0]?.payload?.modelCalls as number | undefined;
};
const parentModelCalls = async (runId: string) =>
  Number((await admin`SELECT model_calls FROM agent_runs WHERE id=${runId}`)[0]?.model_calls ?? 0);

async function rejectsWith(run: () => Promise<unknown>, pattern: RegExp) {
  await assert.rejects(run, pattern);
}

/**
 * 父围栏的读数（worker 真正调用的那个 SQL 函数）。
 * 只有与 operation.card_generation_outbox_id 绑定的那一发才查 Agent 父围栏；
 * 没绑定的原有制卡 outbox 恒为 true —— 这一格两条都要断，否则"没绑就放行"和
 * "绑了才拦"分不开。
 */
async function cardJobCurrent(outboxId: string, workspaceId: string, userId: string, lock = false) {
  const rows = await workerPorts.transaction({ workspaceId, userId }, (tx) => tx.execute(
    query`SELECT ailearn_agent_card_job_current(${outboxId},${workspaceId},${lock}) AS allowed`));
  return (rows as unknown as Array<{ allowed: boolean }>)[0]!.allowed;
}

/** 回执三档的断言小工具：result 档拿产物，否则按"不该交付 / 不该失败"分别断。 */
function deliveredArtifact(receipt: OperationReceiptV1, why: string) {
  assert.equal(receipt.kind, "result", `${why}（实际 ${receipt.kind}）`);
  assert.ok(receipt.kind === "result" && receipt.result.kind === "artifact");
  return receipt.result.artifact;
}
function notDelivered(receipt: OperationReceiptV1, why: string) {
  assert.notEqual(receipt.kind, "result", why);
}

// ─────────────────────────────────────────────────────────────────────────────

test("一次 invoke 造出真实领域 run 与**正好一个**初始简化链 outbox，且不写假 jobs", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const run = await api.create(scope, { requestId: randomUUID(), goal: "把这一篇做成待审核的学习卡", inputs: [f.input] });
  const first = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, first, run.runId, 1);
  await advance.acquire();

  const child = await startCard(advance, cardArgs(f), "provider-1");
  assert.equal(child.status, "accepted", "accepted 只是接受，不是完成");
  assert.equal(child.execution.kind, "card_generation", "制卡没有准备用的假 job");

  const [row] = await admin`
    SELECT job_id, card_generation_run_id, card_generation_outbox_id, status
    FROM agent_operations WHERE id = ${child.operationId}`;
  assert.equal(row!.job_id, null, "制卡不写假 job");
  assert.equal(row!.card_generation_run_id, child.execution.id, "执行体就是那张真实领域 run");
  assert.equal(row!.card_generation_outbox_id, child.outboxId, "绑的是这一发初始 outbox");
  assert.equal(row!.status, "accepted");

  const [{ jobs }] = await admin`
    SELECT count(*)::int jobs FROM jobs WHERE workspace_id=${scope.workspaceId} AND type=${CARD}`;
  assert.equal(jobs, 0, "制卡不排 jobs 行");

  const emitted = await outboxes(child.execution.id);
  assert.equal(emitted.length, 1, "正好一个初始简化链 outbox");
  assert.equal(emitted[0]!.job_type, SIMPLIFIED);
  assert.equal(emitted[0]!.id, child.outboxId, "绑定的就是它");
  assert.equal(await runCount(scope.workspaceId), 1, "领域 run 真的建在这一个空间里");

  // 接受 ≠ 交付：还没跑的那一发，台面上还没有任何候选。
  assert.deepEqual(await reviewableCandidates(child.execution.id), []);
  await advance.release(true);
  await finishAdvance(first.id);
  const waiting = await api.get(scope, run.runId);
  assert.equal(waiting.operations[0]!.status, "accepted");
  assert.deepEqual(waiting.artifacts, [], "还没核对到成果就没有产物");
});

test("操作身份只由影响生成的规范参数组成：换 provider call id 复用，换参数才长出新一批", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const run = await api.create(scope, { requestId: randomUUID(), goal: "出卡", inputs: [f.input] });
  const first = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, first, run.runId, 1);
  await advance.acquire();

  const child = await startCard(advance, cardArgs(f), "provider-1");
  // provider call id 不进操作身份：同一份要求换一次调用，长不出第二批。
  const repeated = await startCard(advance, cardArgs(f), "provider-2");
  assert.equal(repeated.operationId, child.operationId);
  assert.equal(repeated.execution.id, child.execution.id);
  assert.equal(repeated.reused, true, "复用同一张已存在的执行体");
  assert.equal(await runCount(scope.workspaceId), 1, "同参数不重复建 run");

  // 换任何影响生成的参数（这里换细节档）才允许长出新一批。
  // 同一篇笔记同时只许一批在制（领域产品策略），所以先把上一批放到终态再换参数。
  await admin`UPDATE card_generation_runs_v2 SET status='closed_without_activation' WHERE id=${child.execution.id}`;
  const changed = await startCard(advance, cardArgs(f, { detailThreshold: "deep" }), "provider-3");
  assert.notEqual(changed.operationId, child.operationId, "参数不同是另一次语义请求");
  assert.notEqual(changed.execution.id, child.execution.id, "参数不同要另建一批");
  assert.equal(await runCount(scope.workspaceId), 2);

  // 上限：同一个目标最多 8 次操作，第 9 次被挡住，且不再建第 9 批。
  await admin`UPDATE card_generation_runs_v2 SET status='closed_without_activation' WHERE id=${changed.execution.id}`;
  for (let index = 0; index < 6; index += 1) {
    const extra = await startCard(advance, cardArgs(f, { hardMaxCards: 1 + index }), `provider-budget-${index}`);
    await admin`UPDATE card_generation_runs_v2 SET status='closed_without_activation' WHERE id=${extra.execution.id}`;
  }
  const [{ ops }] = await admin`SELECT count(*)::int ops FROM agent_operations WHERE run_id=${run.runId}`;
  assert.equal(ops, 8, "同一个目标最多 8 次操作");
  // 第 9 次要挑一组**前八次都没用过**的规范参数：hardMaxCards:8 是第一次的缺省值，
  // 照抄会命中「同一操作身份复用」，测到的是幂等不是上限。
  await rejectsWith(() => startCard(advance,
    cardArgs(f, { detailThreshold: "concise", hardMaxCards: 3 }), "provider-over-budget"), /生成上限/);
  assert.equal(await runCount(scope.workspaceId), 8, "被上限挡住的那一次不再建新批次");
  await advance.release(true);
  await finishAdvance(first.id);
});

test("冻结材料与可见性：材料不在目标内、跨空间、别人建的材料都在同一事务里被拒", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const second = await anotherNote(scope, "密度", ["密度表示单位体积物质的质量。"]);
  const outsideGoal = await anotherNote(scope, "浮力", ["浮力来自液体对物体的托举。"]);
  const otherSpace = await anotherNote(
    { workspaceId: f.otherWorkspaceId, userId: f.userId }, "别空间的", LEARNABLE_BLOCKS);
  const otherUserId = randomUUID();
  const otherUser = await anotherNote(
    { workspaceId: scope.workspaceId, userId: otherUserId }, "别人建的", LEARNABLE_BLOCKS);
  // 别人也在这个空间里：可见性要靠成员关系判定，光看 workspace_id 不够。
  await admin`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${scope.workspaceId},${otherUserId},'owner')`;
  fixtures.push({ userId: otherUserId, workspaceIds: [] });

  const run = await api.create(scope, {
    requestId: randomUUID(), goal: "只处理我交给你的那两篇",
    inputs: [f.input, asInput(second)],
  });
  const first = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, first, run.runId, 1);
  await advance.acquire();

  // 材料本身可读，但没被冻结进这个目标：拒绝，且不建 run。
  await rejectsWith(() => startCard(advance, cardArgs(outsideGoal), "provider-outside"), /不在当前目标范围内/);
  // 同一篇的另一个版本：noteId 对上也不算数。
  await rejectsWith(() => startCard(advance, cardArgs({ noteId: f.noteId, noteVersionId: f.otherVersionId }), "provider-old-version"),
    /不在当前目标范围内/);
  // 另一个空间的笔记：可见性核对在冻结核对之前就挡住。
  await rejectsWith(() => startCard(advance, cardArgs(otherSpace), "provider-other-space"), /读不到|不在当前目标范围内/);
  // 别人建的笔记：既不在冻结集合里，本空间也读不到（不是本人建的且未共享）。
  await rejectsWith(() => startCard(advance, cardArgs(otherUser), "provider-other-user"), /读不到|不在当前目标范围内/);

  assert.equal(await runCount(scope.workspaceId), 0, "被拒的调用一次都不该建出领域 run");
  const [{ ops }] = await admin`SELECT count(*)::int ops FROM agent_operations WHERE run_id=${run.runId}`;
  assert.equal(ops, 0, "被拒的调用不写操作行");
  await advance.release(true);
  await finishAdvance(first.id);
});

test("真跑一次 V3 简化链：有可审候选 A∧B 才交付并唤醒目标", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const run = await api.create(scope, { requestId: randomUUID(), goal: "出待审核的卡", inputs: [f.input] });
  const first = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, first, run.runId, 1);
  await advance.acquire();
  const child = await startCard(advance, cardArgs(f), "provider-chain");
  await advance.release(true);
  await finishAdvance(first.id);

  // 真跑：领域自己走到 review_ready，候选带上 binding plan hash。
  // 0373 的触发器在这一步写下待核对事件，并**持久 enqueue** 一次 advance
  // （唤醒不依赖 LISTEN，进程重启后恢复扫描仍捡得回来）。
  await runSimplifiedChain(child.execution.id);
  assert.equal(await runStatus(child.execution.id), "review_ready");
  const candidates = await reviewableCandidates(child.execution.id);
  assert.ok(candidates.length >= 1, `台面上应当至少有一张可保留候选（读到 ${candidates.length}）`);
  assert.ok(candidates.every(c => c.evidence_binding_plan_hash !== null), "可审候选要带 binding plan hash");

  const delivered = await settle(scope, run.runId);
  assert.equal(delivered.operations[0]!.status, "succeeded");

  assert.equal(delivered.operations[0]!.error, null, "成功后不该留着未知回执的话术");
  assert.deepEqual(delivered.operations[0]!.execution, { kind: "card_generation", id: child.execution.id });
  assert.deepEqual(delivered.artifacts, [{
    kind: "card_candidates", id: child.execution.id,
    noteId: f.input.noteId, noteVersionId: f.input.noteVersionId,
  }], "产物就是那张真实制卡 run，没有假 jobId");
});

test("零推荐是正常收口：succeeded + no_cards_recommended，且不产出 artifact", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const barren = await anotherNote(scope, "会议记录", UNLEARNABLE_BLOCKS);
  const input = asInput(barren);
  const run = await api.create(scope, { requestId: randomUUID(), goal: "这篇能出卡吗", inputs: [input] });
  const first = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, first, run.runId, 1);
  await advance.acquire();
  const child = await startCard(advance, cardArgs(barren), "provider-zero");
  await advance.release(true);
  await finishAdvance(first.id);

  await runSimplifiedChain(child.execution.id);
  assert.equal(await runStatus(child.execution.id), "no_cards_recommended");
  assert.deepEqual(await reviewableCandidates(child.execution.id), [], "零推荐就真的没有候选");

  assert.equal(await reconcile(run.runId, child.operationId), 1);
  const settled = await settle(scope, run.runId);
  assert.equal(settled.operations[0]!.status, "succeeded", "零推荐是成功收口，不是失败");
  assert.equal(settled.operations[0]!.error, null);
  assert.deepEqual(settled.artifacts, [], "零推荐不产出 artifact——捏一张空成果才是失败");
  const result = settled.operations[0]!.result;
  assert.equal(result?.kind, "no_cards_recommended");
  const reasonCodes = result?.kind === "no_cards_recommended" ? result.reasonCodes : [];
  assert.ok(reasonCodes.length <= 20, "理由条数有上界");
  assert.ok(reasonCodes.every(code => code.length <= 100), "每条理由有长度上界");
});

test("交付判据是四层绑定：材料、执行体种类、身份与可审候选缺一不可", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const batch = await anotherNote(scope, "拆判据那一篇", LEARNABLE_BLOCKS);
  const frozen = asInput(batch);
  const run = await api.create(scope, { requestId: randomUUID(), goal: "出卡", inputs: [frozen] });
  const first = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, first, run.runId, 1);
  await advance.acquire();
  const child = await startCard(advance, cardArgs(batch), "provider-negative");
  await advance.release(true);
  await finishAdvance(first.id);
  await runSimplifiedChain(child.execution.id);
  assert.equal(await runStatus(child.execution.id), "review_ready");

  const base = { workspaceId: scope.workspaceId, userId: scope.userId };
  const read = (overrides: Partial<OperationReceiptRequest> = {}) =>
    workerPorts.transaction(scope, (tx) => readOperationResultReceipt(tx, {
      capability: CARD, execution: { kind: "card_generation", id: child.execution.id },
      scope: base, inputs: [frozen], ...overrides,
    }));

  // 对照格：什么都不动时它**是**交付。先钉住这个，后面的否定格才有意义。
  deliveredArtifact(await read(), "对照格：可审候选齐备时算交付");

  // 1) 材料没冻结进目标：不是这次目标的交付。
  notDelivered(await read({ inputs: [f.input] }), "材料没冻结进目标");
  // 2) 换一个种类的执行体：笔记三类产物不配 card_generation 执行体，反之亦然。
  notDelivered(await read({ execution: { kind: "job", id: randomUUID() } }), "job 执行体不认制卡 run");
  // 3) 身份：别的空间 / 别的用户读同一行都读不到；不存在的那张 run 还没到定性那一档。
  notDelivered(await read({ scope: { workspaceId: f.otherWorkspaceId, userId: scope.userId } }), "别的空间读不到");
  notDelivered(await read({ scope: { workspaceId: scope.workspaceId, userId: randomUUID() } }), "别的用户读不到");
  assert.equal((await workerPorts.transaction(scope, (tx) => readOperationResultReceipt(tx, {
    capability: CARD, execution: { kind: "card_generation", id: randomUUID() }, scope: base, inputs: [frozen],
  }))).kind, "pending", "不存在的 run 没有可核对的领域事实，不是失败");
});

test("可审交付的两层合取：最新修订 ∧ 未决定 ∧ 未发布 ∧ 有 binding，拆掉任一层都不交付", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const batch = await anotherNote(scope, "拆可审性那一篇", LEARNABLE_BLOCKS);
  const frozen = asInput(batch);
  const run = await api.create(scope, { requestId: randomUUID(), goal: "出卡", inputs: [frozen] });
  const first = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, first, run.runId, 1);
  await advance.acquire();
  const child = await startCard(advance, cardArgs(batch), "provider-reviewability");
  await advance.release(true);
  await finishAdvance(first.id);
  await runSimplifiedChain(child.execution.id);
  assert.equal(await runStatus(child.execution.id), "review_ready");

  const base = { workspaceId: scope.workspaceId, userId: scope.userId };
  const read = () => workerPorts.transaction(scope, (tx) => readOperationResultReceipt(tx, {
    capability: CARD, execution: { kind: "card_generation", id: child.execution.id },
    scope: base, inputs: [frozen],
  }));
  const candidates = await reviewableCandidates(child.execution.id);
  assert.ok(candidates.length >= 1, "对照格的前提是台面上至少有一张可保留候选");
  deliveredArtifact(await read(), "对照格");

  // 1) 已审核决定的那张不再可审（枚举是 undecided/keep/reject/merged）。
  await admin`UPDATE card_generation_candidates_v2 SET review_decision='keep' WHERE run_id=${child.execution.id}`;
  notDelivered(await read(), "已决定的候选不再可审");
  await admin`UPDATE card_generation_candidates_v2 SET review_decision='undecided' WHERE run_id=${child.execution.id}`;
  // 2) 已进入发布的候选不是"待审核"（枚举里没有 published，是 activating/activated）。
  await admin`UPDATE card_generation_candidates_v2 SET publish_state='activating' WHERE run_id=${child.execution.id}`;
  notDelivered(await read(), "已发布的批次不是待审核候选");
  await admin`UPDATE card_generation_candidates_v2 SET publish_state='unpublished' WHERE run_id=${child.execution.id}`;
  // 3) 没有 binding plan hash 的候选不交付。
  //    原值**读出来**再写回：夹具自己解构出来的是 hash 字符串本身，
  //    再写 `${saved.saved}` 会把 undefined 灌进 NOT NULL 判定之外的地方。
  const [{ saved_hash }] = await admin`
    SELECT evidence_binding_plan_hash AS saved_hash FROM card_generation_candidates_v2
    WHERE run_id=${child.execution.id} AND evidence_binding_plan_hash IS NOT NULL
    ORDER BY created_at LIMIT 1`;
  assert.ok(saved_hash, "对照格的前提是台面上确实有带 hash 的候选");
  await admin`UPDATE card_generation_candidates_v2 SET evidence_binding_plan_hash=NULL
    WHERE run_id=${child.execution.id}`;
  assert.equal(await reviewableCount(child.execution.id), 0, "抹掉 hash 后台面上确实没有可审候选了");
  notDelivered(await read(), "没有 binding 的候选不交付");
  await admin`UPDATE card_generation_candidates_v2 SET evidence_binding_plan_hash=${saved_hash}
    WHERE run_id=${child.execution.id}`;
  assert.equal(await reviewableCount(child.execution.id), candidates.length, "hash 复原后可审集合回到原样");
  deliveredArtifact(await read(), "binding 复原后重新可交付");

  // 4) 非最新修订：判据是 **EXISTS**——台面上一张都不可审才算不可交付。
  //    只给第一张补一版新修订没用，别的 passed 仍然可审。所以这里对**整张对照集合**
  //    逐张补一版还没过检查（checking）的新修订，再回读证明可审集合真的空了。
  for (const subject of candidates) {
    await admin`
      INSERT INTO card_generation_candidates_v2
        (workspace_id, run_id, candidate_id, candidate_revision_id, revision, plan_revision_id,
          plan_version, plan_hash, card_content_epoch, plan_objective_local_id,
          objective_draft, presentation_draft, evidence_set_hash, candidate_revision_hash,
          quality_state, review_decision, publish_state, evidence_binding_plan_hash)
      SELECT workspace_id, run_id, candidate_id, ${randomUUID()}::uuid, revision + 1, plan_revision_id,
          plan_version, plan_hash, card_content_epoch, plan_objective_local_id,
          objective_draft, presentation_draft, evidence_set_hash, 'superseding-revision-by-fixture',
          'checking', 'undecided', 'unpublished', evidence_binding_plan_hash
      FROM card_generation_candidates_v2 WHERE candidate_revision_id=${subject.candidate_revision_id} LIMIT 1`;
  }
  const [{ newer }] = await admin`SELECT count(*)::int newer FROM card_generation_candidates_v2
    WHERE run_id=${child.execution.id} AND candidate_revision_hash='superseding-revision-by-fixture'`;
  assert.equal(newer, candidates.length, "每张可审候选都补出了一版新修订（写失败要在这里红）");
  assert.equal(await reviewableCount(child.execution.id), 0,
    "新修订还在 checking 时，旧 passed 全部被遮住 —— 整张对照集合都不再可审");
  // 最终语义：review_ready 只是"领域认为候选可审"，交付证据仍缺时**不得**宣称确定失败。
  // 必须是 pending，由终态事件落 outcome_unknown，等有限次恢复核对把证据等来。
  assert.equal((await read()).kind, "pending",
    "review_ready 却一张带证据的可审候选都查不到：应落 pending（→ outcome_unknown），不是确定失败");

  // 5) needs_attention 且没有可审候选 → failed：领域已给出终局结论，这一档才真的不再等。
  await admin`UPDATE card_generation_runs_v2 SET status='needs_attention' WHERE id=${child.execution.id}`;
  assert.equal((await read()).kind, "failed", "needs_attention 且无可审候选：领域已给终局结论");
  // 6) 已取消 / 已关闭未激活：台面上的 passed 只是历史记录，不是这次目标的交付。
  await admin`UPDATE card_generation_runs_v2 SET status='cancelled' WHERE id=${child.execution.id}`;
  assert.equal((await read()).kind, "failed", "已取消的批次不算可审交付");
  await admin`UPDATE card_generation_runs_v2 SET status='closed_without_activation' WHERE id=${child.execution.id}`;
  assert.equal((await read()).kind, "failed", "已关闭未激活的批次不算可审交付");
  // 7) 仍在生成：同样 pending，交给调用方落 accepted/running，不是失败。
  await admin`UPDATE card_generation_runs_v2 SET status='planning' WHERE id=${child.execution.id}`;
  assert.equal((await read()).kind, "pending", "仍在生成的档位是 pending");
  // 8) 对照：证据补齐后同一张 run 重新可交付——证明上一格是"证据缺"，不是"这一批坏了"。
  await admin`UPDATE card_generation_runs_v2 SET status='review_ready' WHERE id=${child.execution.id}`;
  await admin`UPDATE card_generation_candidates_v2 SET quality_state='passed', revision=revision+100
    WHERE run_id=${child.execution.id}`;
  assert.ok(await reviewableCount(child.execution.id) >= 1, "证据补齐后台面上重新有可审候选");
  deliveredArtifact(await read(), "证据补齐后同一批重新可交付");
});

test("共同预算：每一次真实 provider.complete 都记在目标上，耗尽就不再发请求", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const run = await api.create(scope, { requestId: randomUUID(), goal: "出卡", inputs: [f.input] });
  const first = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, first, run.runId, 1);
  await advance.acquire();
  const child = await startCard(advance, cardArgs(f), "provider-budget");
  await advance.release(true);
  await finishAdvance(first.id);

  const before = await parentModelCalls(run.runId);
  await runSimplifiedChain(child.execution.id);
  assert.equal(await runStatus(child.execution.id), "review_ready");
  const domain = await domainModelCalls(child.execution.id);
  assert.ok(domain !== undefined && domain > 0, "领域事件里读得到真实调用数");
  assert.equal(await parentModelCalls(run.runId) - before, domain,
    "每一次真实 provider.complete（含内核自动补采样）都记在目标预算上，一发不多一发不少");

  // 预算耗尽：目标账已满时，这一发不再外发任何 provider 请求。
  const second = await anotherNote(scope, "预算那一篇", LEARNABLE_BLOCKS);
  const run2 = await api.create(scope, { requestId: randomUUID(), goal: "再来一批", inputs: [asInput(second)] });
  const lease2 = await lease(scope, run2.runId), advance2 = createAgentAdvanceStore(workerPorts, lease2, run2.runId, 1);
  await advance2.acquire();
  const exhausted = await startCard(advance2, cardArgs(second), "provider-exhausted");
  await advance2.release(true);
  await finishAdvance(lease2.id);
  await admin`UPDATE agent_runs SET model_calls=max_model_calls WHERE id=${run2.runId}`;
  const saturated = await parentModelCalls(run2.runId);

  await runSimplifiedChain(exhausted.execution.id);
  assert.equal(await parentModelCalls(run2.runId), saturated, "预算耗尽时不再发额外 provider 请求");
  assert.notEqual(await runStatus(exhausted.execution.id), "review_ready",
    "预算耗尽不该凭空产出一批可审候选");
});

test("既有无父目标批次不记其他 Agent 的账；Agent 完成之后审核台那一发仍能继续", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const run = await api.create(scope, { requestId: randomUUID(), goal: "出卡", inputs: [f.input] });

  // 既有**不经过 Agent** 的制卡批次：没有 agent_operations 行，也不该动目标预算。
  const plain = await anotherNote(scope, "页面侧那一篇", LEARNABLE_BLOCKS);
  const plainRun = await createUnboundHistoricalCardRun(scope, plain.noteVersionId, {
    version: 2, noteVersionId: plain.noteVersionId, sourceScope: { kind: "whole_note" },
    learningGoal: "understand", detailThreshold: "balanced",
    quantity: { kind: "adaptive" }, clientRequestId: `plain-${randomUUID()}`,
  }, `plain-${randomUUID()}`);
  const before = await parentModelCalls(run.runId);
  await runSimplifiedChain(plainRun.runId);
  assert.equal(await parentModelCalls(run.runId), before, "没有绑定 Agent 目标的制卡不记 Agent 预算");
  const [{ ops }] = await admin`SELECT count(*)::int ops FROM agent_operations
    WHERE card_generation_run_id=${plainRun.runId}`;
  assert.equal(ops, 0, "既有无父目标批次不应凭空绑定目标");

  // Agent 那一批跑完之后，用户在审核台点的那一发**仍能继续**：
  // 它没绑在 operation 上，不会被一个已 completed 的旧目标卡住。
  const first = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, first, run.runId, 1);
  await advance.acquire();
  const child = await startCard(advance, cardArgs(f), "provider-review-again");
  await advance.release(true);
  await finishAdvance(first.id);
  await runSimplifiedChain(child.execution.id);
  assert.equal(await runStatus(child.execution.id), "review_ready");
  assert.equal(await reconcile(run.runId, child.operationId), 1);
  const delivered = await settle(scope, run.runId);
  assert.equal(delivered.operations[0]!.status, "succeeded");

  // 此用例检验 completed 父目标的围栏；操作成功本身不会完成父目标。
  await admin`UPDATE agent_runs SET status='completed',summary='候选已交付，请自行审核。'
    WHERE id=${run.runId}`;
  assert.equal((await api.get(scope, run.runId)).status, "completed");

  // 审核台那一发：**真的走领域入口**（handleCandidateActionV2 → regenerate_candidate），
  // 而不是自己插一行 outbox。只读已有那一发是空泛的——它证明不了"新 outbox 真的能排出来、
  // 真的跑得动、且不记到已完成的旧目标账上"。
  const [{ bound }] = await admin`SELECT card_generation_outbox_id AS bound FROM agent_operations
    WHERE id=${child.operationId}`;
  assert.equal(bound, child.outboxId, "Agent 只拥有初始那一发");
  assert.ok(child.outboxId, "回执必须带初始 outbox 的 id"); // 否则下面的 SQL 会收到 undefined
  assert.equal(bound, child.outboxId, "Agent 只拥有初始那一发");
  assert.equal((await outboxes(child.execution.id)).length, 1, "交付之后台面上仍只有初始那一发");

  // plan_hash 挂在 card_generation_plans_v2 上（run 上只有 current_plan_version），
  // 审核台入口要的是「当前那一版计划」的哈希，所以按 version 取，不能从 run 上取。
  const [plan] = await admin`SELECT r.card_content_epoch, r.current_plan_version, r.review_draft_revision,
      p.plan_hash
    FROM card_generation_runs_v2 r
    LEFT JOIN card_generation_plans_v2 p
      ON p.run_id = r.id AND p.plan_version = r.current_plan_version AND p.workspace_id = r.workspace_id
    WHERE r.id=${child.execution.id}`;
  const [subject] = await admin`SELECT candidate_id, revision, candidate_revision_hash
    FROM card_generation_candidates_v2
    WHERE run_id=${child.execution.id} AND quality_state='passed' AND review_decision='undecided'
      AND publish_state='unpublished' ORDER BY created_at LIMIT 1`;
  assert.ok(subject, "审核台入口的前提是台面上有一张待审核候选");
  assert.ok(plan!.plan_hash, `当前计划版本 ${plan!.current_plan_version} 必须真实存在（哈希取自它）`);

  const { handleCandidateActionV2 } = await import(
    "../../../../apps/api/src/modules/card-generation-v2/candidate-review-service.ts");
  const budgetBeforeReview = await parentModelCalls(run.runId);
  await handleCandidateActionV2(scope, {
    version: 2, runId: child.execution.id,
    expectedCardContentEpoch: plan!.card_content_epoch,
    expectedPlanVersion: plan!.current_plan_version,
    expectedPlanHash: plan!.plan_hash,
    expectedReviewDraftRevision: plan!.review_draft_revision,
    action: {
      type: "regenerate_candidate", candidateId: subject!.candidate_id,
      expectedRevision: subject!.revision, expectedRevisionHash: subject!.candidate_revision_hash,
      feedbackReasonCodes: ["too_many"],
    },
  }, `review-${randomUUID()}`);

  // 真的多出了一发，且 jobType 不是简化链整批那一发。
  const afterReview = await outboxes(child.execution.id);
  assert.equal(afterReview.length, 2, "审核台的重新生成真的排出了新的一发");
  const [reviewOutbox] = await admin`SELECT id, job_type FROM card_generation_run_outbox_v2
    WHERE run_id=${child.execution.id} AND job_type='card_candidate_refine_v3' LIMIT 1`;
  assert.ok(reviewOutbox, "新的一发是逐候选那一档，不是 Agent 绑定的初始那一发");
  assert.notEqual(reviewOutbox!.id, child.outboxId);

  // 认领并真跑它：父围栏没绑它，已 completed 的目标不该拦住它。
  const reviewJob = await claimOutboxOfType(child.execution.id, "card_candidate_refine_v3");
  const { processV2OutboxJob } = await import("../handlers/card-generation-v2-handler.ts");
  // 走分发点而不是直接调 handler：只有分发点会把 outbox 结成 completed，
  // 而"分发点把失败咽掉"正是这一格要防的（分发点静默失败过一次）。
  await processV2OutboxJob(reviewJob);
  const [finished] = await admin`SELECT status, last_error FROM card_generation_run_outbox_v2
    WHERE id=${reviewJob.id}` as unknown as Array<{ status: string; last_error: string | null }>;
  assert.equal(finished!.status, "completed",
    `审核台那一发真的跑完了（status=${finished!.status}／error=${String(finished!.last_error).slice(0, 200)}）`);

  assert.equal(await parentModelCalls(run.runId), budgetBeforeReview,
    "审核台的新动作不记到已交付的旧目标预算上");
  assert.equal((await api.get(scope, run.runId)).status, "completed",
    "审核台后续动作不重新开启已完成的父目标");
  assert.equal((await api.get(scope, run.runId)).operations[0]!.status, "succeeded",
    "审核台的新动作不改写已交付的操作");
});

test("取消之后迟到的成果不能成为当前交付；恢复扫描不重复创建 run", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const run = await api.create(scope, { requestId: randomUUID(), goal: "出卡", inputs: [f.input] });
  const first = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, first, run.runId, 1);
  await advance.acquire();
  const child = await startCard(advance, cardArgs(f), "provider-cancel");
  await advance.release(true);
  await finishAdvance(first.id);

  // 领域侧先出成果（模拟子任务在取消被看见之前跑完、提交迟到）。
  await runSimplifiedChain(child.execution.id);
  assert.equal(await runStatus(child.execution.id), "review_ready");

  await api.control(scope, run.runId, 1, "cancel");
  assert.equal((await api.get(scope, run.runId)).status, "cancelled");

  // 迟到的成果不许把已取消的目标改成"成功"，也不许凭空长出产物。
  // 只跑真实的恢复扫描，**不**把目标按回 waiting —— 按回去等于亲手复活一个已取消的目标，
  // 那样测到的是夹具的副作用，不是"取消之后不被叫回来"。
  await scanRecovery();
  const after = await api.get(scope, run.runId);
  assert.equal(after.status, "cancelled");
  assert.deepEqual(after.artifacts, [], "已取消的目标不认迟到的成果");
  assert.equal(await runCount(scope.workspaceId), 1, "恢复扫描不重复创建领域 run");
});

test("审核开放却还没有可审交付时落 outcome_unknown；核对上限用尽后只有真实交付事实才再醒一次", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const run = await api.create(scope, { requestId: randomUUID(), goal: "出卡", inputs: [f.input] });
  const first = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, first, run.runId, 1);
  await advance.acquire();
  const child = await startCard(advance, cardArgs(f), "provider-recovery");
  await advance.release(true);
  await finishAdvance(first.id);

  // 真跑到审核开放。binding plan hash 这一层先按住不给 —— 它就是"可审交付"四层里
  // 最后一层，拿它造出"审核已开放、但还没有一张真正可审"的那一格。
  await runSimplifiedChain(child.execution.id);
  assert.equal(await runStatus(child.execution.id), "review_ready");
  const [{ saved_hash }] = await admin`
    SELECT evidence_binding_plan_hash AS saved_hash FROM card_generation_candidates_v2
    WHERE run_id=${child.execution.id} AND evidence_binding_plan_hash IS NOT NULL
    ORDER BY created_at LIMIT 1`;
  assert.ok(saved_hash, "跑完的批次台面上确实有带 hash 的候选");
  const reviewableBefore = await reviewableCount(child.execution.id);
  assert.ok(reviewableBefore >= 1, "对照格的前提是台面上确实有可审候选");
  await admin`UPDATE card_generation_candidates_v2 SET evidence_binding_plan_hash=NULL
    WHERE run_id=${child.execution.id}`;
  assert.equal(await reviewableCount(child.execution.id), 0,
    "按住 hash 之后台面上确实一张都不可审 —— 否则这一格测的不是审核开放而无可审");

  // 终局却没有可核对成果：只能落 outcome_unknown —— 不冒充完成，也不重做一次。
  const unknown = await settle(scope, run.runId);
  assert.equal(unknown.operations[0]!.status, "outcome_unknown", "终了却无可核对结果不冒充完成");
  assert.deepEqual(unknown.artifacts, []);
  assert.equal(await runCount(scope.workspaceId), 1, "结果未知时不得重建一批");

  // 核对预算已用尽：review_ready 本身**不是**交付事实，不得让它一次次叫醒目标。
  assert.equal(await reconcile(run.runId, child.operationId, { exhausted: true }), 0,
    "审核开放却一张都不可审时不得无限唤醒");

  // 真的可审了：这时才再醒一次，而且恢复扫描不重复创建 run。
  await admin`UPDATE card_generation_candidates_v2 SET evidence_binding_plan_hash=${saved_hash}
    WHERE run_id=${child.execution.id}`;
  assert.equal(await reviewableCount(child.execution.id), reviewableBefore,
    "hash 复原后恢复成原来的可审集合");
  assert.equal(await reconcile(run.runId, child.operationId, { exhausted: true }), 1,
    "真实交付事实出现时，即使核对上限已越过也必须再醒一次");
  assert.equal(await runCount(scope.workspaceId), 1, "恢复扫描不重复创建领域 run");

  const settled = await settle(scope, run.runId);
  assert.equal(settled.operations[0]!.status, "succeeded");
  assert.equal(settled.operations[0]!.error, null, "成功后不该留着未知回执的话术");
  assert.deepEqual(settled.artifacts.map(a => a.kind), ["card_candidates"]);
});
test("父围栏逐条翻转：取消、账号 epoch、伴星关闭、只读、失去成员资格、材料不可见各自拦住迟到的写事务", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const run = await api.create(scope, { requestId: randomUUID(), goal: "出卡", inputs: [f.input] });
  const first = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, first, run.runId, 1);
  await advance.acquire();
  const child = await startCard(advance, cardArgs(f), "provider-fence");
  await advance.release(true);
  await finishAdvance(first.id);

  // 绑定的初始那一发：活跃目标上应当放行。
  assert.equal(await cardJobCurrent(child.outboxId!, scope.workspaceId, scope.userId), true, "对照格");

  // 既有无父目标批次（仍使用真实领域创建器）：整段围栏对它恒为 true。
  const plain = await anotherNote(scope, "没绑父目标那一篇", LEARNABLE_BLOCKS);
  const plainRun = await createUnboundHistoricalCardRun(scope, plain.noteVersionId, {
    version: 2, noteVersionId: plain.noteVersionId, sourceScope: { kind: "whole_note" },
    learningGoal: "understand", detailThreshold: "balanced",
    quantity: { kind: "adaptive" }, clientRequestId: `plain-${randomUUID()}`,
  }, `plain-${randomUUID()}`);
  const [plainOutbox] = await admin`SELECT id FROM card_generation_run_outbox_v2
    WHERE run_id=${plainRun.runId} AND job_type=${SIMPLIFIED} ORDER BY created_at LIMIT 1`;
  assert.equal(await cardJobCurrent(plainOutbox!.id, scope.workspaceId, scope.userId), true,
    "没绑 Agent 目标的 outbox 不进父围栏");

  // paused 是**保留**的一档：已接受的这发让它做完，父目标只是不推进新步骤。
  await api.control(scope, run.runId, 1, "pause");
  assert.equal(await cardJobCurrent(child.outboxId!, scope.workspaceId, scope.userId), true,
    "paused 保留：已接受的子任务允许做完");
  await api.control(scope, run.runId, 1, "resume");
  // resume 会排一次新续跑；把它认领并收掉，后面的围栏翻转才是在一个干净的目标上做的。
  await finishAdvance((await lease(scope, run.runId)).id);

  // 逐条翻转，每一条都要把"绑定的拦下 / 没绑的照旧"这两半同时断掉。
  // 还原一律按**原值**写回（而不是猜一个"正常值"）：默认值是迁移 0239 定的
  // {"version":1,"permissionLevel":"guided"}，写死一个别的字面量会把夹具变成
  // 另一份配置，测的就不是"撤销之后恢复放行"了。
  const [{ settings }] = await admin`SELECT agent_settings AS settings
    FROM user_companion_account_state WHERE user_id=${scope.userId}`;
  const [{ epoch }] = await admin`SELECT epoch FROM user_companion_account_state WHERE user_id=${scope.userId}`;
  const flips: Array<{ why: string; undo: () => Promise<unknown>; flip: () => Promise<unknown> }> = [
    {
      why: "伴星被关掉",
      flip: () => admin`UPDATE user_companion_account_state SET global_enabled=false WHERE user_id=${scope.userId}`,
      undo: () => admin`UPDATE user_companion_account_state SET global_enabled=true WHERE user_id=${scope.userId}`,
    },
    {
      why: "权限降到只读",
      flip: () => admin`UPDATE user_companion_account_state
        SET agent_settings=jsonb_set(agent_settings,'{permissionLevel}','"read_only"'::jsonb)
        WHERE user_id=${scope.userId}`,
      undo: () => admin`UPDATE user_companion_account_state SET agent_settings=${settings}::jsonb
        WHERE user_id=${scope.userId}`,
    },
    {
      why: "账号 epoch 变化",
      flip: () => admin`UPDATE user_companion_account_state SET epoch=epoch+1 WHERE user_id=${scope.userId}`,
      undo: () => admin`UPDATE user_companion_account_state SET epoch=${epoch} WHERE user_id=${scope.userId}`,
    },
    {
      why: "失去成员资格",
      flip: () => admin`UPDATE workspace_members SET left_at=now()
        WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId}`,
      undo: () => admin`UPDATE workspace_members SET left_at=NULL
        WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId}`,
    },
    {
      why: "冻结材料已不可见",
      flip: () => admin`UPDATE notes SET deleted_at=now() WHERE id=${f.noteId}`,
      undo: () => admin`UPDATE notes SET deleted_at=NULL WHERE id=${f.noteId}`,
    },
  ];
  for (const item of flips) {
    await item.flip();
    assert.equal(await cardJobCurrent(child.outboxId!, scope.workspaceId, scope.userId), false,
      `${item.why}之后父围栏必须拦住这一发`);
    assert.equal(await cardJobCurrent(plainOutbox!.id, scope.workspaceId, scope.userId), true,
      `${item.why}不该影响没绑 Agent 目标的 outbox`);
    await item.undo();
    assert.equal(await cardJobCurrent(child.outboxId!, scope.workspaceId, scope.userId), true,
      `${item.why}撤销之后恢复放行`);
  }

  // 取消目标：终态目标下这一发不再被允许；取消之后不再有新的绑定 run。
  await api.control(scope, run.runId, 1, "cancel");
  assert.equal(await cardJobCurrent(child.outboxId!, scope.workspaceId, scope.userId), false,
    "已取消的目标拦得住迟到的领域写事务");
  assert.equal((await api.get(scope, run.runId)).status, "cancelled");
});

test("要求修订之后，旧版那一发的迟到成果不进入新版本的交付", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const run = await api.create(scope, { requestId: randomUUID(), goal: "出卡", inputs: [f.input] });
  const first = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, first, run.runId, 1);
  await advance.acquire();
  const child = await startCard(advance, cardArgs(f), "provider-revise");
  await advance.release(true);
  await finishAdvance(first.id);

  // 先真的跑出成果：台面上确实有一批可审候选了，迟到的回执有东西可"顶"。
  await runSimplifiedChain(child.execution.id);
  assert.equal(await runStatus(child.execution.id), "review_ready");
  assert.ok(await reviewableCount(child.execution.id) >= 1, "前置条件：台面上确实有可审候选");

  // 用户换了一次要求。revise 会先取消未完成的这一次操作（cancelOutstanding），
  // 于是这一次不再可能成为交付 —— 这正是「迟到成果不顶账」的真实形状。
  const revised = await api.revise(scope, run.runId, 1, "改成只要三张，更精简");
  assert.equal(revised.revision, 2);
  const [bound] = await admin`SELECT revision, status FROM agent_operations WHERE id=${child.operationId}`;
  assert.equal(bound!.revision, 1, "这次操作仍属于旧版本");
  assert.equal(bound!.status, "cancelled", "修订取消未完成的制卡，迟到的回执不再是交付");

  const current = await settle(scope, run.runId, 2);
  assert.equal(current.revision, 2);
  assert.deepEqual(current.artifacts, [], "旧版本的成果不回填进新版本");
  assert.equal(current.operations.some(operation => operation.operationId === child.operationId), false,
    "新版本的 operation 列表里没有旧版那一行");

  // 历史页如实记着它属于第 1 版 —— 旧版记录不丢，只是不冒充新版成果。
  const history = await api.history(scope, run.runId, { limit: 20 });
  const firstRevision = history.items.find(item => item.revision === 1);
  assert.equal(firstRevision?.operations.length, 1, "旧版那一版里仍然记着这次操作");
  assert.deepEqual(firstRevision!.artifacts, [], "被取消的那一次不产出产物");
  assert.equal(firstRevision!.operations[0]!.status, "cancelled");
});

test("重复与乱序的回执事件不改已经定下来的终态", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const run = await api.create(scope, { requestId: randomUUID(), goal: "出卡", inputs: [f.input] });
  const first = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, first, run.runId, 1);
  await advance.acquire();
  const child = await startCard(advance, cardArgs(f), "provider-duplicate");
  await advance.release(true);
  await finishAdvance(first.id);
  // Reserve genuinely earlier sequence values before the real terminal event.
  // The fixture must not depend on gaps left by unrelated tests.
  const gaps = await admin`SELECT nextval('agent_run_events_seq_seq')::int AS seq FROM generate_series(1,2)`;
  await runSimplifiedChain(child.execution.id);
  assert.equal((await settle(scope, run.runId)).operations[0]!.status, "succeeded");

  const [{ terminalSeq }] = await admin`SELECT last_event_seq AS "terminalSeq" FROM agent_operations WHERE id=${child.operationId}`;
  assert.equal(gaps.length, 2);
  assert.ok(gaps.every(gap => gap.seq < terminalSeq), "the delayed events precede the authoritative terminal event");

  await admin.begin(async (tx) => {
    for (const gap of gaps) {
      await tx`INSERT INTO agent_run_events(run_id,workspace_id,user_id,revision,operation_id,execution_status,seq)
        VALUES(${run.runId},${scope.workspaceId},${scope.userId},1,${child.operationId},'failed',${gap.seq})`;
    }
  });
  const [{ written }] = await admin`SELECT count(*)::int written FROM agent_run_events
    WHERE operation_id=${child.operationId} AND seq IN (${gaps[0]!.seq}, ${gaps[1]!.seq})`;
  assert.equal(written, 2, "两条乱序事件确实写进去了（写失败要在这里红）");

  const after = await settle(scope, run.runId);
  assert.equal(after.operations[0]!.status, "succeeded", "终态不被重复或乱序事件改写");
  assert.deepEqual(after.artifacts.map(a => a.kind), ["card_candidates"], "已交付的成果不受影响");
  assert.equal(await runCount(scope.workspaceId), 1, "重复事件不重建领域 run");
});

test("模拟进程重启：恢复扫描从持久 outbox 捡回目标，不重复创建 run 也不重复唤醒", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const run = await api.create(scope, { requestId: randomUUID(), goal: "出卡", inputs: [f.input] });
  const first = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, first, run.runId, 1);
  await advance.acquire();
  const child = await startCard(advance, cardArgs(f), "provider-restart");
  await advance.release(true);
  await finishAdvance(first.id);

  // 「重启」：把目标放回等待态、推旧上次核对，**不动**任何领域事实，
  // 反复跑几次真实的恢复扫描 —— 唤醒必须是有界的。
  await admin.begin(async (tx) => {
    await tx`UPDATE agent_runs SET status='waiting',advance_job_id=NULL,advance_lease_token=NULL WHERE id=${run.runId}`;
    await tx`UPDATE agent_operations SET updated_at=now()-interval '5 minutes' WHERE id=${child.operationId}`;
  });
  for (let round = 0; round < 3; round += 1) {
    await workerClient`SELECT ailearn_enqueue_agent_recovery()`;
    await admin.begin(async (tx) => {
      await tx`UPDATE agent_runs SET status='waiting',advance_job_id=NULL,advance_lease_token=NULL WHERE id=${run.runId}`;
      await tx`UPDATE agent_operations SET updated_at=now()-interval '5 minutes' WHERE id=${child.operationId}`;
    });
  }
  assert.equal(await runCount(scope.workspaceId), 1, "反复恢复不重复创建领域 run");
  const [{ runs }] = await admin`SELECT count(*)::int runs FROM card_generation_run_outbox_v2
    WHERE run_id=${child.execution.id} AND job_type=${SIMPLIFIED}`;
  assert.equal(runs, 1, "也不重复排发简化链那一发");

  // 真的可审之后，恢复扫描才把目标捡回来并交付。
  await runSimplifiedChain(child.execution.id);
  await admin.begin(async (tx) => {
    await tx`UPDATE agent_runs SET status='waiting',advance_job_id=NULL,advance_lease_token=NULL WHERE id=${run.runId}`;
    await tx`UPDATE agent_operations SET updated_at=now()-interval '5 minutes' WHERE id=${child.operationId}`;
  });
  assert.equal(await settle(scope, run.runId).then(r => r.operations[0]!.status), "succeeded",
    "有真实交付事实时，重启后的恢复扫描捡得回来");
  assert.equal(await runCount(scope.workspaceId), 1, "交付之后依然没有多出第二个 run");
});

test("领域幂等的作用域：不同目标、不同 revision 各自建批；同一目标同一版换 provider callId 只建一次", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const args = cardArgs(f);

  // 目标 A：revision 1 建一批。
  const runA = await api.create(scope, { requestId: randomUUID(), goal: "第一次出卡", inputs: [f.input] });
  const leaseA = await lease(scope, runA.runId), advanceA = createAgentAdvanceStore(workerPorts, leaseA, runA.runId, 1);
  await advanceA.acquire();
  const firstOfA = await startCard(advanceA, args, "provider-A1");
  assert.equal(firstOfA.status, "accepted");
  assert.equal(await runCount(scope.workspaceId), 1, "目标 A 的第一次调用建一批");
  await advanceA.release(true);
  await finishAdvance(leaseA.id);

  // 同目标同 revision 换 provider callId：复用，不新建。
  const leaseA2 = await lease(scope, runA.runId), advanceA2 = createAgentAdvanceStore(workerPorts, leaseA2, runA.runId, 1);
  await advanceA2.acquire();
  const secondOfA = await startCard(advanceA2, args, "provider-A2-different-call-id");
  assert.equal(secondOfA.operationId, firstOfA.operationId, "同目标同版：换 callId 复用同一操作");
  assert.equal(secondOfA.execution.id, firstOfA.execution.id, "同目标同版：复用同一领域 run");
  assert.equal(await runCount(scope.workspaceId), 1, "provider 重试不新建领域 run");
  await advanceA2.release(true);
  await finishAdvance(leaseA2.id);

  // 目标 A 推进到 revision 2：材料与参数一模一样，仍然是**另一次独立工作**。
  await api.revise(scope, runA.runId, 1, "换个说法再来一次");
  // revision 1 那一批先落到终态，把在制额度让出来（与领域同空间在途上限一致）。
  await admin`UPDATE card_generation_runs_v2 SET status='closed_without_activation' WHERE id=${firstOfA.execution.id}`;
  const leaseA3 = await lease(scope, runA.runId, 2), advanceA3 = createAgentAdvanceStore(workerPorts, leaseA3, runA.runId, 2);
  await advanceA3.acquire();
  const revised = await startCard(advanceA3, args, "provider-A-revision-2");
  assert.notEqual(revised.execution.id, firstOfA.execution.id,
    "换了 revision 就是另一次独立工作，不能捡回上一版已经建好的领域 run");
  assert.notEqual(revised.operationId, firstOfA.operationId, "revision 不同就不是同一次操作");
  assert.equal(await runCount(scope.workspaceId), 2);
  await advanceA3.release(true);
  await finishAdvance(leaseA3.id);

  // 目标 B：同一用户、同一篇笔记、同一组参数 —— 两个独立目标之间同样不得复用。
  await admin`UPDATE card_generation_runs_v2 SET status='closed_without_activation' WHERE id=${revised.execution.id}`;
  const runB = await api.create(scope, { requestId: randomUUID(), goal: "另一个目标，出同样的卡", inputs: [f.input] });
  const leaseB = await lease(scope, runB.runId), advanceB = createAgentAdvanceStore(workerPorts, leaseB, runB.runId, 1);
  await advanceB.acquire();
  const firstOfB = await startCard(advanceB, args, "provider-B1");
  assert.notEqual(firstOfB.execution.id, firstOfA.execution.id,
    "两个独立目标之间不得复用同一张领域 run（那是两次独立工作，不是 provider 重试）");
  assert.equal(await runCount(scope.workspaceId), 3, "三个独立工作各自建一批");
  await advanceB.release(true);
  await finishAdvance(leaseB.id);

  // 三次的 outbox 绑定各不相同，每一发都只绑自己那一发。
  const bindings = await admin`SELECT card_generation_run_id, card_generation_outbox_id
    FROM agent_operations WHERE run_id IN (${runA.runId}, ${runB.runId}) AND card_generation_run_id IS NOT NULL
    ORDER BY created_at` as unknown as Array<{ card_generation_run_id: string; card_generation_outbox_id: string }>;
  assert.equal(bindings.length, 3);
  assert.equal(new Set(bindings.map(b => b.card_generation_run_id)).size, 3, "执行体互不重复");
  assert.equal(new Set(bindings.map(b => b.card_generation_outbox_id)).size, 3, "outbox 绑定互不重复");
});

test("已失去初始 outbox 租约时不请求 provider、不增加父 model_calls", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const run = await api.create(scope, { requestId: randomUUID(), goal: "出卡", inputs: [f.input] });
  const first = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, first, run.runId, 1);
  await advance.acquire();
  const child = await startCard(advance, cardArgs(f), "provider-lost-lease");
  await advance.release(true);
  await finishAdvance(first.id);

  const budgetBefore = await parentModelCalls(run.runId);
  const statusBefore = await runStatus(child.execution.id);

  // 「另一个 worker 抢走了这一发」：本进程手里的 leaseToken 已经不是库里那一个。
  const stale = await claimOutboxOfType(child.execution.id, SIMPLIFIED);
  const thiefToken = randomUUID();
  await admin`UPDATE card_generation_run_outbox_v2 SET lease_token=${thiefToken}
    WHERE id=${stale.id} AND status='processing'`;
  const [stillOurs] = await admin`SELECT count(*)::int n FROM card_generation_run_outbox_v2
    WHERE id=${stale.id} AND lease_token=${stale.leaseToken}`;
  assert.equal(stillOurs!.n, 0, "前置条件：这一发的租约已经易主，夹具没造成这个结果就要在这里红");

  const { processV2OutboxJob } = await import("../handlers/card-generation-v2-handler.ts");
  await processV2OutboxJob(stale);

  assert.equal(await parentModelCalls(run.runId), budgetBefore,
    "已经失去租约的调用不该计进父预算——没有归属的请求不该由用户的伴星目标买单");
  assert.equal(await runStatus(child.execution.id), statusBefore, "租约已易主，这一发不得推进领域 run");
  assert.equal(await reviewableCount(child.execution.id), 0, "也没有凭空产出可审候选");
  const [{ ops }] = await admin`SELECT count(*)::int ops FROM agent_operations WHERE run_id=${run.runId}`;
  assert.equal(ops, 1, "也不重复建操作行");
});

test("HTTP 400 穿过内核和领域包装后仍不可重试，outbox 当次终结而不是回队列", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const run = await api.create(scope, { requestId: randomUUID(), goal: "出卡", inputs: [f.input] });
  const first = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, first, run.runId, 1);
  await advance.acquire();
  const child = await startCard(advance, cardArgs(f), "provider-request-rejection");
  await advance.release(true);
  await finishAdvance(first.id);
  const job = await claimOutboxOfType(child.execution.id, SIMPLIFIED);
  const { processCardGenerationSimplifiedJob } = await import("../card-generation-v3/handler.ts");
  const { ProviderRequestError } = await import("../lib/provider-request-error.ts");
  const { isRetryableProviderError } = await import("../card-generation-v2/retry-classification.ts");
  const { failV2OutboxJob } = await import("../card-generation-v2/outbox-queue.ts");
  const deterministic = await import("../card-generation-v3/deterministic.ts");
  let calls = 0;
  let rejection: Error | undefined;
  await assert.rejects(processCardGenerationSimplifiedJob(job, {
    generate: { modelId: "request-rejected", async complete() {
      calls += 1;
      throw new ProviderRequestError({ provider: "fixture", status: 400 });
    } },
    check: deterministic.createDeterministicCardContentCheckV3Provider(),
    rewrite: deterministic.createDeterministicCardCandidateRewriteV3Provider(),
  }), (error: unknown) => {
    if (!(error instanceof Error)) return false;
    rejection = error;
    return !isRetryableProviderError(error) && /invalid_input.*HTTP 400/.test(error.message);
  });
  assert.equal(calls, 1, "确定性拒绝不再由任务内核重放");
  // Same retry classifier and persistence operation as the outbox consumer.
  await failV2OutboxJob(job.id, job.leaseToken, rejection!.message, isRetryableProviderError(rejection));
  const [outbox] = await admin`SELECT status,attempts,next_attempt_at FROM card_generation_run_outbox_v2 WHERE id=${job.id}`;
  assert.equal(outbox.status, "failed");
  assert.equal(outbox.attempts, 1, "领域包装不能把 400 转成可重试并等待六轮");
  assert.equal(await runStatus(child.execution.id), "needs_attention");
  assert.equal(await reviewableCount(child.execution.id), 0);
});

test("语义 provider 重试每一次单独计数：首次结构不合法、内核补一次采样才成功", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const run = await api.create(scope, { requestId: randomUUID(), goal: "出卡", inputs: [f.input] });
  const first = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, first, run.runId, 1);
  await advance.acquire();
  const child = await startCard(advance, cardArgs(f), "provider-retry-count");
  await advance.release(true);
  await finishAdvance(first.id);

  // 计一次真实 provider.complete 的次数。这个计数器代表**外发的请求数**，
  // 与领域事件里那个 modelCalls（代表内核内部尝试数）不是同一个东西。
  let calls = 0;
  const job = await claimOutboxOfType(child.execution.id, SIMPLIFIED);
  const { processCardGenerationSimplifiedJob } = await import("../card-generation-v3/handler.ts");
  const deterministic = await import("../card-generation-v3/deterministic.ts");
  const base = deterministic.createDeterministicCardGenerateV3Provider();

  // 真模型曾把依据 UUID 写成块序号；首次全批不合合同，内核修复一次后才提交。
  const flaky: Parameters<typeof processCardGenerationSimplifiedJob>[1]["generate"] = {
    modelId: `${base.modelId}-flaky-first-response`,
    async complete(request: Parameters<typeof base.complete>[0]) {
      calls += 1;
      const completion = await base.complete(request);
      if (calls !== 1) return completion;
      const invalid = JSON.parse(completion.text);
      for (const candidate of invalid.candidates) candidate.evidenceSnapshotIds = [1];
      return { ...completion, text: JSON.stringify(invalid) };
    },
  };
  const budgetBefore = await parentModelCalls(run.runId);
  await processCardGenerationSimplifiedJob(job, {
    generate: flaky,
    check: deterministic.createDeterministicCardContentCheckV3Provider(),
    rewrite: deterministic.createDeterministicCardCandidateRewriteV3Provider(),
  });

  assert.equal(calls, 2,
    "恰好两发 = 首次 + 内核按 maxAutoRetries:1 补的那一次结构修复；多一发说明又加了一层循环，少一发说明补采样预算没接上");
  assert.equal(await runStatus(child.execution.id), "review_ready", "补一次采样之后这一发真的成功了");
  assert.ok(await reviewableCount(child.execution.id) >= 1, "而且台面上确实有可审候选");

  const domainCalls = await domainModelCalls(child.execution.id);
  // domainCalls 数的是**所有任务**的尝试（生成 2 次 + 检查 1 次），上面 calls 只数生成那一档；
  // 两者不是同一个东西，这一格要断的正是它们对得上。
  assert.ok(domainCalls !== undefined && domainCalls >= 3,
    `内核内部的尝试数如实涨到 ${domainCalls}——补的那一次采样也记在里面`);
  const parentDelta = await parentModelCalls(run.runId) - budgetBefore;
  assert.equal(parentDelta, domainCalls,
    "父预算按每一次真实 provider.complete 单独计数：补的那一次采样同样记在目标上");
});

test("全批依据格式无效只修复一次，耗尽后失败，不落成材料无知识点", async () => {
  const f = await fixture(), scope = { workspaceId: f.workspaceId, userId: f.userId };
  const run = await api.create(scope, { requestId: randomUUID(), goal: "出卡", inputs: [f.input] });
  const first = await lease(scope, run.runId), advance = createAgentAdvanceStore(workerPorts, first, run.runId, 1);
  await advance.acquire();
  const child = await startCard(advance, cardArgs(f), "invalid-evidence-shape");
  await advance.release(true);
  await finishAdvance(first.id);
  const job = await claimOutboxOfType(child.execution.id, SIMPLIFIED);
  const { processCardGenerationSimplifiedJob } = await import("../card-generation-v3/handler.ts");
  const { isRetryableProviderError } = await import("../card-generation-v2/retry-classification.ts");
  const { failV2OutboxJob } = await import("../card-generation-v2/outbox-queue.ts");
  const deterministic = await import("../card-generation-v3/deterministic.ts");
  const base = deterministic.createDeterministicCardGenerateV3Provider();
  let calls = 0;
  let rejection: Error | undefined;
  const budgetBefore = await parentModelCalls(run.runId);
  await assert.rejects(processCardGenerationSimplifiedJob(job, {
    generate: { modelId: "invalid-evidence-shape", async complete(request) {
      calls += 1;
      const completion = await base.complete(request);
      const invalid = JSON.parse(completion.text);
      for (const candidate of invalid.candidates) candidate.evidenceSnapshotIds = [1];
      return { ...completion, text: JSON.stringify(invalid) };
    } },
    check: deterministic.createDeterministicCardContentCheckV3Provider(),
    rewrite: deterministic.createDeterministicCardCandidateRewriteV3Provider(),
  }), (error: unknown) => {
    if (!(error instanceof Error)) return false;
    rejection = error;
    return !isRetryableProviderError(error) && /output_shape.*evidenceSnapshotIds/.test(error.message);
  });
  assert.equal(calls, 2, "只有首次及一次内核修复，不加领域队列重放");
  assert.equal(await parentModelCalls(run.runId) - budgetBefore, 2);
  await failV2OutboxJob(job.id, job.leaseToken, rejection!.message, isRetryableProviderError(rejection));
  const [outbox] = await admin`SELECT status,attempts FROM card_generation_run_outbox_v2 WHERE id=${job.id}`;
  assert.equal(outbox.status, "failed");
  assert.equal(outbox.attempts, 1);
  assert.equal(await runStatus(child.execution.id), "needs_attention");
  assert.equal(await reviewableCount(child.execution.id), 0);
  const [events] = await admin`SELECT count(*)::int n FROM card_generation_events_v2
    WHERE run_id=${child.execution.id} AND event_type='card_generation.no_cards_recommended'`;
  assert.equal(events.n, 0, "输出协议失败不能污染为材料事实");
});

test("围栏在「provider 已返回、提交之前」翻转：迟到的那一批不许落库，也不许改动目标", async () => {
  const deterministic = await import("../card-generation-v3/deterministic.ts");
  const { processCardGenerationSimplifiedJob } = await import("../card-generation-v3/handler.ts");

  // 每一种围栏各占一个空间：一次只翻转一条，否则分不清是哪一条拦住的。
  const kinds = [
    { key: "epoch", why: "账号 epoch 在返回后变化" },
    { key: "membership", why: "成员资格在返回后被收回" },
    { key: "material", why: "冻结材料在返回后不可见" },
    { key: "revise", why: "目标在返回后被要求修订" },
    { key: "lease", why: "这一发的租约在返回后易主" },
  ] as const;

  for (const kind of kinds) {
    const local = await fixture(`${kind.key} 那一篇`);
    const localScope = { workspaceId: local.workspaceId, userId: local.userId };
    const run = await api.create(localScope, { requestId: randomUUID(), goal: "出卡", inputs: [local.input] });
    const first = await lease(localScope, run.runId), advance = createAgentAdvanceStore(workerPorts, first, run.runId, 1);
    await advance.acquire();
    const child = await startCard(advance, cardArgs(local), `provider-late-${kind.key}`);
    await advance.release(true);
    await finishAdvance(first.id);

    const job = await claimOutboxOfType(child.execution.id, SIMPLIFIED);
    const base = deterministic.createDeterministicCardGenerateV3Provider();
    const [{ epoch }] = await admin`SELECT epoch FROM user_companion_account_state WHERE user_id=${local.userId}`;

    // 真正的"返回之后、提交之前"：provider 先算出**合法**结果，再翻转围栏，最后返回。
    // 这样若围栏没接在提交前，这批卡就会真的落库 —— 否定场景才立得住。
    const lateFlip: Parameters<typeof processCardGenerationSimplifiedJob>[1]["generate"] = {
      modelId: `${base.modelId}-late-fence`,
      async complete(request: Parameters<typeof base.complete>[0]) {
        const result = await base.complete(request);
        if (kind.key === "epoch") {
          await admin`UPDATE user_companion_account_state SET epoch=epoch+1 WHERE user_id=${local.userId}`;
        } else if (kind.key === "membership") {
          await admin`UPDATE workspace_members SET left_at=now()
            WHERE workspace_id=${local.workspaceId} AND user_id=${local.userId}`;
        } else if (kind.key === "material") {
          await admin`UPDATE notes SET deleted_at=now() WHERE id=${local.noteId}`;
        } else if (kind.key === "revise") {
          await api.revise(localScope, run.runId, 1, "换个说法");
        } else {
          await admin`UPDATE card_generation_run_outbox_v2 SET lease_token=${randomUUID()} WHERE id=${job.id}`;
        }
        return result;
      },
    };

    let thrown: unknown = null;
    try {
      await processCardGenerationSimplifiedJob(job, {
        generate: lateFlip,
        check: deterministic.createDeterministicCardContentCheckV3Provider(),
        rewrite: deterministic.createDeterministicCardCandidateRewriteV3Provider(),
      });
    } catch (error) { thrown = error; }

    // 先证明**围栏真的翻了**：side effect 是在 provider 回调里做的，它有可能自己失败
    // （比如 revise 被某个前置条件挡下）。那一格会"因为别的原因绿"，等于没测。
    if (kind.key === "lease") {
      // 租约这一档翻的是**提交前的 token CAS**（fenceV2OutboxLease），不是 card_job_current
      // ——后者按父围栏判定，根本不看 lease_token。用错判据就会得到一个恒真的"前置条件"。
      const [now] = await admin`SELECT lease_token FROM card_generation_run_outbox_v2 WHERE id=${job.id}`;
      assert.notEqual(now!.lease_token, job.leaseToken, "前置条件：这一发的租约确实易主");
    } else {
      assert.equal(await cardJobCurrent(job.id, localScope.workspaceId, localScope.userId), false,
        `${kind.why}：前置条件没成立——围栏根本没翻，这一格不算数`);
    }
    if (kind.key === "revise") {
      const [moved] = await admin`SELECT revision FROM agent_runs WHERE id=${run.runId}`;
      assert.equal(moved!.revision, 2, "前置条件：目标确实被推进到了第 2 版");
    }

    // 无论它是抛错还是静默收场，判据都只有一条：**这批卡不许落库**。
    assert.equal(await reviewableCount(child.execution.id), 0,
      `${kind.why}：已经算出来的那批仍被写进了台面（thrown=${thrown instanceof Error ? thrown.message.slice(0, 60) : "none"}）`);
    assert.notEqual(await runStatus(child.execution.id), "review_ready",
      `${kind.why}：领域 run 不得被推到审核开放`);
    const [{ ops }] = await admin`SELECT count(*)::int ops FROM agent_operations WHERE run_id=${run.runId}`;
    assert.equal(ops, 1, `${kind.why}：不得凭空多出第二次操作`);

    // 能撤销的三种撤回去，确认这一格不是被别的原因卡红的；revise 撤不回去
    // （revision 只增不减），那一格靠上面的前置条件断言自证。
    if (kind.key === "epoch") {
      await admin`UPDATE user_companion_account_state SET epoch=${epoch} WHERE user_id=${local.userId}`;
    } else if (kind.key === "membership") {
      await admin`UPDATE workspace_members SET left_at=NULL
        WHERE workspace_id=${local.workspaceId} AND user_id=${local.userId}`;
    } else if (kind.key === "material") {
      await admin`UPDATE notes SET deleted_at=NULL WHERE id=${local.noteId}`;
    } else if (kind.key === "lease") {
      await admin`UPDATE card_generation_run_outbox_v2 SET lease_token=${job.leaseToken} WHERE id=${job.id}`;
    }
    if (kind.key !== "revise") {
      assert.equal(await cardJobCurrent(job.id, localScope.workspaceId, localScope.userId), true,
        `${kind.why}：撤销之后围栏确实恢复放行（否则这一格可能是被别的原因卡红的）`);
    }
  }
});
