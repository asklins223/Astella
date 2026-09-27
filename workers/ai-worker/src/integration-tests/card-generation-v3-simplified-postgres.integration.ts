/**
 * 制卡简化链（V3）的 job 接线集测（39d W7-1 刀b）。真 Postgres、**零模型调用**。
 *
 * 这份文件要结掉的是 §16.28 那三条判据里"只在库里看得见"的部分：
 *
 * 1. **总控翻到了简化链那一档**（W7-7 刀一）——未设 `CARD_GENERATION_CHAIN` 投
 *    `card_generation_simplified_v1`，显式 `v2` 仍完整回到旧 jobType（off 档＝改前行为）；
 * 1b. **审核台上那三档走的是同一条腿**（同一刀）：逐候选重检（`card_candidate_refine_v3`
 *    `mode:"recheck"`）、按反馈重生成（`mode:"rewrite"`，出新修订、旧的标 superseded）、
 *    整批重排（同一 jobType 带 `mode:"replan"`，上一版没激活的候选让路）；
 * 2. **普通短文本成功路径刚好 2 次语义调用**——这条读数由 handler 自己数并写进
 *    `card_generation.simplified_completed` 事件（`modelCalls`），不是进程内断言一次
 *    就完了；零候选那一路是 **1 次**（只有生成，检查没有对象）；
 * 3. **检查失败不重跑生成**——段 4 抛错时计划与首稿候选已经落库；重投必须从段 4 接上：
 *    计划行数与 `plan_revision_id` 一字不动，而生成那一发的端口调用数为 **0**。
 *
 * 另外两条是"新链产出的东西仍然被现网消费"的证据：候选带 `evidence_binding_plan_hash`
 * 且 `quality_state='passed'`（审核页判"可保留"看的就是这两格），以及现网的
 * `handleCandidateActionV2({type:"keep"})` 对它照样成立。
 *
 * 运行（一次性库，四条 DSN 全指过去；共享 dev 库上挂着别人的在制批次会造出假失败）：
 *   bash scripts/dev-disposable-db.sh ailearn_cardtest
 *   DATABASE_URL=... DATABASE_URL_MIGRATOR=... DATABASE_URL_API=... DATABASE_URL_WORKER=... \
 *     node --import tsx --test --test-timeout=240000 \
 *     workers/ai-worker/src/integration-tests/card-generation-v3-simplified-postgres.integration.ts
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";
import { assertFixtureWipeClean, wipeCardGenerationFixtures } from "./card-generation-fixture-cleanup.ts";

const ADMIN_URL = testDatabaseUrl("DATABASE_URL_MIGRATOR");
process.env.DATABASE_URL_WORKER ??= testDatabaseUrl("DATABASE_URL_WORKER");
process.env.DATABASE_URL_API ??= ADMIN_URL;
delete process.env.CARD_GENERATION_V2_LLM;

const admin = postgres(ADMIN_URL, { max: 2 });

const WORKSPACE_ID = randomUUID();
const USER_ID = randomUUID();
const OTHER_USER_ID = randomUUID();
const OTHER_WORKSPACE_ID = randomUUID();
/**
 * 失败形状那两条专用的第三个空间：它们**故意**把 run 留在在制档
 * （planning／needs_attention），放进前两个空间就等于依赖"前面那些测试都跑过并把
 * 自己的 run 推到了终态"——按名字单跑一条时会撞 `生成并发已达上限（3 个在途 Run）`。
 */
const FAIL_SHAPE_USER_ID = randomUUID();
const FAIL_SHAPE_WORKSPACE_ID = randomUUID();
/**
 * W7-7 刀一那三档（逐候选重检／按反馈重生成／整批重排）自己的第四个空间：
 * 在制 run 上限是产品策略的 3，前三个空间各自的夹具已经把额度排满了。
 */
const REFINE_USER_ID = randomUUID();
const REFINE_WORKSPACE_ID = randomUUID();
/** 全被内容门禁挡下的那一发也要一个自己的空间（在制额度是产品策略 3 个）。 */
const GATEALL_USER_ID = randomUUID();
const GATEALL_WORKSPACE_ID = randomUUID();

/** 一篇有可学正文的笔记（六句，每句都能抽出一个原子）。 */
const LEARNABLE_BLOCKS = [
  "TCP 建立连接时双方各自确认一次序号，确认完成之后才开始传数据。",
  "HTTP 是无状态协议，服务端默认不记得上一个请求发生过什么。",
  "对称加密的密钥必须事先约定好，非对称加密用公钥加密、私钥解密。",
  "DNS 解析先把域名换成 IP 地址，之后才向目标服务器发起连接。",
  "TLS 握手在应用层数据之前完成，它协商的是加密套件和会话密钥。",
  "TCP 的重传由超时或重复确认触发，不由应用层自己决定何时重发。",
];
/** 一篇抽不出可学原子的笔记（句子都短于阈值或是操作记录）：零候选是正常结果。 */
const UNLEARNABLE_BLOCKS = ["见附件。", "待定。", "TODO 补。"];

type NoteFixture = { noteId: string; versionId: string };
const notes: Record<string, NoteFixture> = {};
let simplifiedRunId = "";
let controlRunId = "";
let zeroCandidateRunId = "";
/** 每句都被内容门禁挡下的那一发（终态要带得上门码）。 */
let allGatedRunId = "";
let otherUserRunTarget = "";
let rewriteRunId = "";
let refineRunId = "";
/** 后面三档共用的主体：整批那一发跑完才落库的那张 passed 修订。 */
let refineSubjectRevisionId = "";

async function seedNote(key: string, title: string, blocks: string[], owner: { workspaceId: string; userId: string } = { workspaceId: WORKSPACE_ID, userId: USER_ID }): Promise<NoteFixture> {
  const noteId = randomUUID();
  const versionId = randomUUID();
  await admin.begin(async (tx) => {
    await tx`INSERT INTO notes (id, workspace_id, title, created_by)
      VALUES (${noteId}, ${owner.workspaceId}, ${title}, ${owner.userId})`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${versionId}, ${noteId}, ${owner.workspaceId}, 1,
              ${tx.json({ blocks: blocks.map((content) => ({ type: "paragraph", content })) })},
              ${`v3-it-${key}`}, ${owner.userId})`;
    for (const [ordinal, content] of blocks.entries()) {
      await tx`INSERT INTO note_blocks (id, version_id, workspace_id, type, content, ordinal)
        VALUES (${randomUUID()}, ${versionId}, ${owner.workspaceId}, 'paragraph', ${content}, ${ordinal + 1})`;
    }
  });
  return { noteId, versionId };
}

async function createRun(versionId: string, clientRequestId: string, owner: { workspaceId: string; userId: string } = { workspaceId: WORKSPACE_ID, userId: USER_ID }) {
  const { createGenerationRunV2 } = await import(
    "../../../../apps/api/src/modules/card-generation-v2/generation-run-service.ts"
  );
  return createGenerationRunV2(
    owner,
    versionId,
    {
      version: 2,
      noteVersionId: versionId,
      sourceScope: { kind: "whole_note" },
      learningGoal: "understand",
      detailThreshold: "balanced",
      quantity: { kind: "adaptive" },
      clientRequestId,
    },
    clientRequestId,
  );
}

async function outboxJobType(runId: string): Promise<string | null> {
  const rows = await admin`
    SELECT job_type FROM card_generation_run_outbox_v2
    WHERE run_id = ${runId} ORDER BY created_at LIMIT 1
  ` as unknown as Array<{ job_type: string }>;
  return rows[0]?.job_type ?? null;
}

async function runStatus(runId: string): Promise<string> {
  const rows = await admin`
    SELECT status FROM card_generation_runs_v2 WHERE id = ${runId} LIMIT 1
  ` as unknown as Array<{ status: string }>;
  return String(rows[0]?.status);
}

async function eventPayload(runId: string, eventType: string): Promise<Record<string, unknown>> {
  const rows = await admin`
    SELECT payload FROM card_generation_events_v2
    WHERE run_id = ${runId} AND event_type = ${eventType}
    ORDER BY event_seq DESC LIMIT 1
  ` as unknown as Array<{ payload: Record<string, unknown> }>;
  assert.ok(rows.length > 0, `事件 ${eventType} 必须落库（它是这条判据唯一的库内读数）`);
  return rows[0].payload;
}

/**
 * 认领本 run 的一条简化链 job（退回 pending 与认领写在同一事务里，见集测先例的说明）。
 *
 * 默认领整批那一发；`jobType` 给逐候选那一发用——两种 job 的认领路径必须同一份，
 * 否则测试自己造出一条生产没有的"只有整批能被认领"的形状。
 *
 * `replay: true` 是给"第一遍死在段 4"那一发用的：生产的做法是回收器发现租约过期
 * （`reapStaleV2OutboxJobs`：attempts+1 → 退避 → 回 pending），测试直接造成这个结果。
 * 只有这份夹具自己持有那条租约（一次性库、没有第二个 poller），所以敢覆盖它。
 */
async function claimSimplifiedJob(
  runId: string,
  options: { replay?: boolean; jobType?: string } = {},
) {
  const jobType = options.jobType ?? "card_generation_simplified_v1";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const leaseToken = randomUUID();
    const claimed = await admin.begin(async (tx) => {
      const states = await tx`
        SELECT status FROM card_generation_run_outbox_v2
        WHERE run_id = ${runId} AND job_type = ${jobType} FOR UPDATE
      ` as unknown as Array<{ status: string }>;
      if (states[0]?.status === "processing" && !options.replay) return null;
      await tx`
        UPDATE card_generation_run_outbox_v2
        SET status = 'pending', lease_token = NULL, lease_expires_at = NULL,
            started_at = NULL, processed_at = NULL, next_attempt_at = NULL
        WHERE run_id = ${runId} AND job_type = ${jobType} AND status <> 'completed'
      `;
      // 同一 run 同一 jobType 可以有多条（重排、逐候选那几发）——按 `created_at` 取最早
      // 那条还没跑的。`UPDATE ... ORDER BY` Postgres 不支持，所以先子查询定行。
      const rows = await tx`
        UPDATE card_generation_run_outbox_v2
        SET status = 'processing', started_at = now(),
            lease_expires_at = now() + interval '30 minutes', lease_token = ${leaseToken}
        WHERE id = (
          SELECT id FROM card_generation_run_outbox_v2
          WHERE run_id = ${runId} AND job_type = ${jobType} AND status = 'pending'
          ORDER BY created_at LIMIT 1
        )
        RETURNING id, workspace_id, run_id, job_type, payload
      ` as unknown as Array<{ id: string; workspace_id: string; run_id: string;
        job_type: string; payload: Record<string, unknown> }>;
      const row = rows[0];
      // 分发点读的是**驼峰**的 `job.jobType`：上一版把 snake_case 的行直接交出去，
      // dispatcher 看见的是 undefined，走到"未知 jobType"那一支（这一发红在夹具的
      // 映射上，不是被测链的问题——但那条映射正是这套夹具的承重件）。
      return row
        ? {
          id: row.id,
          workspaceId: row.workspace_id,
          runId: row.run_id,
          jobType: row.job_type,
          payload: row.payload,
          leaseToken,
        }
        : null;
    });
    if (claimed) return claimed;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("40 次尝试内没能认领到本 run 的简化链 job");
}

/** 两次 `build()` 共用同一个计数器：先付过几发，重投那一发要能看见它没再涨
 * （各数各的会永远读出 0，那是假绿）。 */
function countingGenerate() {
  let calls = 0;
  const build = async () => {
    const { createDeterministicCardGenerateV3Provider } = await import(
      "../card-generation-v3/deterministic.ts"
    );
    const inner = createDeterministicCardGenerateV3Provider();
    return {
      modelId: inner.modelId,
      calls: () => calls,
      async complete(request: Parameters<typeof inner.complete>[0]) {
        calls += 1;
        return inner.complete(request);
      },
    };
  };
  return build;
}

before(async () => {
  await admin.begin(async (tx) => {
    for (const id of [USER_ID, OTHER_USER_ID, FAIL_SHAPE_USER_ID, REFINE_USER_ID,
      GATEALL_USER_ID]) {
      await tx`INSERT INTO users (id, email, password_hash)
        VALUES (${id}, ${`cardgen-v3-${id}@example.invalid`}, 'unused')
        ON CONFLICT (id) DO NOTHING`;
    }
    await tx`INSERT INTO workspaces (id, owner_id, name)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'Card Gen V3 IT') ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces (id, owner_id, name)
      VALUES (${OTHER_WORKSPACE_ID}, ${OTHER_USER_ID}, 'Card Gen V3 Other IT') ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces (id, owner_id, name)
      VALUES (${FAIL_SHAPE_WORKSPACE_ID}, ${FAIL_SHAPE_USER_ID}, 'Card Gen V3 Fail Shape IT')
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces (id, owner_id, name)
      VALUES (${REFINE_WORKSPACE_ID}, ${REFINE_USER_ID}, 'Card Gen V3 Refine IT')
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces (id, owner_id, name)
      VALUES (${GATEALL_WORKSPACE_ID}, ${GATEALL_USER_ID}, 'Card Gen V3 All Gated IT')
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${GATEALL_WORKSPACE_ID}, ${GATEALL_USER_ID}, 'owner') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${REFINE_WORKSPACE_ID}, ${REFINE_USER_ID}, 'owner') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${OTHER_WORKSPACE_ID}, ${OTHER_USER_ID}, 'owner') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${FAIL_SHAPE_WORKSPACE_ID}, ${FAIL_SHAPE_USER_ID}, 'owner') ON CONFLICT DO NOTHING`;
  });

  notes.learnable = await seedNote("learnable", "网络与加密的六句话", LEARNABLE_BLOCKS);
  notes.unlearnable = await seedNote("unlearnable", "会议记录", UNLEARNABLE_BLOCKS);
  notes.control = await seedNote("control", "入口对照那一篇", LEARNABLE_BLOCKS);
  // 一篇挂在**另一个空间**的笔记：本空间的在制 run 上限是产品策略（3 个），
  // 测试要四个夹具就分开放，不去把那道闸调大。
  notes.other = await seedNote("other", "另一个空间的那一篇", LEARNABLE_BLOCKS,
    { workspaceId: OTHER_WORKSPACE_ID, userId: OTHER_USER_ID });
  notes.rewrite = await seedNote("rewrite", "另一个空间要改写那一篇", LEARNABLE_BLOCKS,
    { workspaceId: OTHER_WORKSPACE_ID, userId: OTHER_USER_ID });
  // 下面两条各自要一篇笔记（一篇笔记同时只许一批在制），放在第三个空间：
  // 那两条会把 run 故意留在在制档，占前两个空间的额度会让单跑一条时撞上限。
  notes.outofcontract = await seedNote("outofcontract", "合同形状那一发", LEARNABLE_BLOCKS,
    { workspaceId: FAIL_SHAPE_WORKSPACE_ID, userId: FAIL_SHAPE_USER_ID });
  notes.deadend = await seedNote("deadend", "不可重试那一发", LEARNABLE_BLOCKS,
    { workspaceId: FAIL_SHAPE_WORKSPACE_ID, userId: FAIL_SHAPE_USER_ID });
  notes.leasechange = await seedNote("leasechange", "跑完才发现租约易主那一发", LEARNABLE_BLOCKS,
    { workspaceId: FAIL_SHAPE_WORKSPACE_ID, userId: FAIL_SHAPE_USER_ID });
  // 检查腿那一发放回**第二个空间**：第三个空间此刻已被前三条在制档占满（上限是产品策略的
  // 3 个，这个夹具不调大那道闸），而它那两条 run 一条停在 planning、一条要停在 checking。
  notes.checkbroken = await seedNote("checkbroken", "检查那一发不合合同", LEARNABLE_BLOCKS,
    { workspaceId: OTHER_WORKSPACE_ID, userId: OTHER_USER_ID });

  // 入口对照：这一篇在**显式 `v2`** 下创建 ⇒ 投的必须是旧 jobType（off 档要能整条回到改前）。
  process.env.CARD_GENERATION_CHAIN = "v2";
  controlRunId = (await createRun(notes.control.versionId, `v3-control-${randomUUID()}`)).runId;
  delete process.env.CARD_GENERATION_CHAIN;

  // 其余都是默认档（未设总控）⇒ 简化链。
  simplifiedRunId = (await createRun(notes.learnable.versionId, `v3-main-${randomUUID()}`)).runId;
  zeroCandidateRunId = (await createRun(notes.unlearnable.versionId, `v3-zero-${randomUUID()}`)).runId;
  otherUserRunTarget = (await createRun(notes.other.versionId, `v3-other-${randomUUID()}`,
    { workspaceId: OTHER_WORKSPACE_ID, userId: OTHER_USER_ID })).runId;
  rewriteRunId = (await createRun(notes.rewrite.versionId, `v3-rewrite-${randomUUID()}`,
    { workspaceId: OTHER_WORKSPACE_ID, userId: OTHER_USER_ID })).runId;
  // W7-7 刀一的三档（逐候选重检／按反馈重生成／整批重排）共用这一条 run：它们按定义
  // 发生在"已经有一批可审核候选"之后，一条 run 连着走才看得出彼此的影响。
  // 放在**自己那一个空间**：前三个空间的在制额度已经排满（上限 3 是产品策略，不调大）。
  notes.refine = await seedNote("refine", "独立空间要逐候选处理那一篇", LEARNABLE_BLOCKS,
    { workspaceId: REFINE_WORKSPACE_ID, userId: REFINE_USER_ID });
  refineRunId = (await createRun(notes.refine.versionId, `v3-refine-${randomUUID()}`,
    { workspaceId: REFINE_WORKSPACE_ID, userId: REFINE_USER_ID })).runId;
  notes.allgated = await seedNote("allgated", "两句都被题面门挡下那一发",
    ["TCP 提供可靠有序的字节流传输。水在标准大气压下 100 摄氏度沸腾。"],
    { workspaceId: GATEALL_WORKSPACE_ID, userId: GATEALL_USER_ID });
  allGatedRunId = (await createRun(notes.allgated.versionId, `v3-allgated-${randomUUID()}`,
    { workspaceId: GATEALL_WORKSPACE_ID, userId: GATEALL_USER_ID })).runId;
});

after(async () => {
  if (process.env.V3_KEEP_FIXTURES === "1") {
    console.log("[keep-fixtures] 跳过清理：这一次是给排查用的，跑完请重跑 disposable 脚本回到干净状态");
    await admin.end({ timeout: 5 });
    return;
  }
  // 清理整体交给那份共用台子（含"删完回读计数，不干净就抛"）。这里以前是一张手写表 +
  // 每句 `.catch(() => undefined)`：删空间那句每次都失败（用户必须在前面）而没人知道。
  // 清理 → **先关池** → 再决定要不要喊（池开着就抛，会把整个文件挂在超时上）。
  let report;
  try {
    report = await wipeCardGenerationFixtures(admin,
      [WORKSPACE_ID, OTHER_WORKSPACE_ID, FAIL_SHAPE_WORKSPACE_ID, REFINE_WORKSPACE_ID,
        GATEALL_WORKSPACE_ID],
      [USER_ID, OTHER_USER_ID, FAIL_SHAPE_USER_ID, REFINE_USER_ID, GATEALL_USER_ID]);
  } finally {
    await admin.end({ timeout: 5 }).catch(() => undefined);
    const { closeDatabase: closeWorkerDatabase } = await import("../db.ts");
    await closeWorkerDatabase().catch(() => undefined);
    const { closeDatabase } = await import("../../../../apps/api/src/db/client.ts");
    await closeDatabase().catch(() => undefined);
  }
  assertFixtureWipeClean(report);
});

test("入口总控翻到了简化链那一档，而 off 档完整回到改前那条链", async () => {
  // 这两格读的是**同一个夹具里两篇只差环境变量的 run**：默认档（未设）投新链，
  // 显式 `v2` 投旧链。少了后一格，"翻默认档"与"删了旧链"在库里就分不出来。
  assert.equal(await outboxJobType(controlRunId), "card_generation_plan",
    "`CARD_GENERATION_CHAIN=v2` 这一档要能完全回到改前行为（含 jobType）");
  assert.equal(await outboxJobType(simplifiedRunId), "card_generation_simplified_v1");
  assert.equal(await outboxJobType(zeroCandidateRunId), "card_generation_simplified_v1");
});

test("端到端：两发语义调用走到 review_ready，候选带着 binding plan hash 能被保留", async () => {
  const job = await claimSimplifiedJob(simplifiedRunId);
  const { processV2OutboxJob } = await import("../handlers/card-generation-v2-handler.ts");
  await processV2OutboxJob(job);

  const diagnosed = async (label: string) => {
    const rows = await admin`
      SELECT quality_state, count(*)::int AS n FROM card_generation_candidates_v2
      WHERE run_id = ${simplifiedRunId} GROUP BY quality_state
    ` as unknown as Array<{ quality_state: string; n: number }>;
    const committedRows = await admin`
      SELECT payload FROM card_generation_events_v2
      WHERE run_id = ${simplifiedRunId} AND event_type = 'card_generation.simplified_plan_committed'
      ORDER BY event_seq DESC LIMIT 1
    ` as unknown as Array<{ payload: Record<string, unknown> }>;
    const committed = committedRows[0]?.payload ?? {};
    console.log(`[diag ${label}] candidates=`, JSON.stringify(rows),
      "droppedDrafts=", JSON.stringify(committed.droppedDrafts),
      "assemblyDropped=", JSON.stringify(committed.assemblyDropped),
      "gateRejected=", JSON.stringify(committed.gateRejected));
  };
  if (await runStatus(simplifiedRunId) !== "review_ready") await diagnosed("before-assert");
  assert.equal(await runStatus(simplifiedRunId), "review_ready");
  const completed = await eventPayload(simplifiedRunId, "card_generation.simplified_completed");
  assert.equal(completed.modelCalls, 2,
    "§16.28：普通短文本成功路径刚好 2 次语义调用（这条读数是库里的，不是进程里的）");
  // 反向一格：规模留痕**只在真截断时**才有。这一篇是六句短正文，谁要是把发射器改成
  // 无条件写、或者把上限调小到正常笔记都被截，这一格就红（正面那格在 e2e 的
  // 「长正文留痕」那条：它换到默认档之后量的就是"整批只留一条痕"）。
  const capEvents = await admin`
    SELECT count(*)::int AS n FROM card_generation_events_v2
    WHERE run_id = ${simplifiedRunId} AND event_type = 'card_generation.source_content_capped'
  ` as unknown as Array<{ n: number }>;
  assert.equal(capEvents[0]?.n, 0, "没截断就不许留痕（短正文这一批发出 0 条）");
  // 同一条事件现在带着"抽出了几个原子"。这一篇**六句只抽出五个原子**——第一次跑这条
  // 判据就是它把这件事报出来的（以前库里只看得见"3 张卡"，看不见中间少了一次）。
  // 钉成 5 而不是"等于块数"：谁改了阈值、句子或抽取规则，这一格会红并逼他重读一次。
  const planCommitted = await eventPayload(simplifiedRunId, "card_generation.simplified_plan_committed");
  assert.equal(Number(planCommitted.atomCount), 5,
    `原子数必须是量出来的那一个 5（拿到 ${String(planCommitted.atomCount)}）——这篇六句里有一句抽不出原子`);
  assert.ok(Number(planCommitted.atomCount) >= Number(planCommitted.candidateCount),
    "候选数不可能多于原子数：多于就是这两个数有一头不是从同一份算法来的");

  const planRows = await admin`
    SELECT plan_revision_id, plan_version, plan_hash, result ->> 'kind' AS kind
    FROM card_generation_plans_v2 WHERE run_id = ${simplifiedRunId}
  ` as unknown as Array<{ plan_revision_id: string; plan_version: number; plan_hash: string; kind: string }>;
  assert.equal(planRows.length, 1, "一条 run 只出一版计划（没有额外的 Planner 调用）");
  assert.equal(planRows[0]?.kind, "author_candidates");

  const candidates = await admin`
    SELECT candidate_id, candidate_revision_id, plan_hash, quality_state, review_decision,
           evidence_binding_plan_hash, hints
    FROM card_generation_candidates_v2
    WHERE run_id = ${simplifiedRunId} AND revision = 1
  ` as unknown as Array<{
    candidate_id: string; candidate_revision_id: string; plan_hash: string;
    quality_state: string; review_decision: string;
    evidence_binding_plan_hash: string | null; hints: Record<string, unknown> | null;
  }>;
  assert.ok(candidates.length > 0, "这一批该有候选");
  assert.ok(candidates.every((row) => row.plan_hash === planRows[0]!.plan_hash),
    "候选的 plan_hash 必须是计划那一份（闭包不许各算各的）");
  const passed = candidates.find((row) => row.quality_state === "passed");
  if (!passed) await diagnosed("no-passed");
  assert.ok(passed, "至少一张过了内容检查（quality_state=passed 才是审核页眼里的可保留）");
  assert.ok(passed.evidence_binding_plan_hash, "可保留的门槛是 binding plan hash 在场");
  assert.ok(passed.hints?.level1, "两级提示按兄弟列存，不并进判分内容的哈希闭包");

  const reports = await admin`
    SELECT gate_version, verdict FROM card_candidate_quality_reports_v2
    WHERE run_id = ${simplifiedRunId}
  ` as unknown as Array<{ gate_version: string; verdict: string }>;
  assert.ok(reports.length >= candidates.length, "每张候选都要有内容检查报告落库");
  assert.ok(reports.every((row) => row.gate_version === "card-content-check-v3"));

  // 现网的"保留"命令对新链产出的候选照样成立。
  const { handleCandidateActionV2 } = await import(
    "../../../../apps/api/src/modules/card-generation-v2/candidate-review-service.ts"
  );
  const runRow = (await admin`
    SELECT card_content_epoch, current_plan_version, review_draft_revision
    FROM card_generation_runs_v2 WHERE id = ${simplifiedRunId}
  ` as unknown as Array<{ card_content_epoch: number; current_plan_version: number; review_draft_revision: number }>)[0];
  const revisionRow = (await admin`
    SELECT candidate_revision_hash FROM card_generation_candidates_v2
    WHERE run_id = ${simplifiedRunId} AND candidate_revision_id = ${passed.candidate_revision_id}
  ` as unknown as Array<{ candidate_revision_hash: string }>)[0];
  const result = await handleCandidateActionV2(
    { workspaceId: WORKSPACE_ID, userId: USER_ID },
    {
      version: 2,
      runId: simplifiedRunId,
      expectedCardContentEpoch: Number(runRow!.card_content_epoch),
      expectedPlanVersion: Number(runRow!.current_plan_version),
      expectedPlanHash: planRows[0]!.plan_hash,
      expectedReviewDraftRevision: Number(runRow!.review_draft_revision),
      action: {
        type: "keep",
        candidateId: passed.candidate_id,
        expectedRevision: 1,
        expectedRevisionHash: revisionRow!.candidate_revision_hash,
      },
    },
    `v3-keep-${randomUUID()}`,
  );
  assert.ok(result, "保留这一发必须真的落下去");
  const kept = await admin`
    SELECT review_decision FROM card_generation_candidates_v2
    WHERE candidate_revision_id = ${passed.candidate_revision_id}
  ` as unknown as Array<{ review_decision: string }>;
  assert.notEqual(kept[0]?.review_decision, "undecided", "保留之后那一格要改口");
});

/**
 * 旧链那份网里"重投同一个 run 的 job 不写第二份"随链退场（39d W7-7 刀二），**判据本身搬到这里**：
 * 它判的是 outbox 的重复投递，与哪条链出题无关。
 *
 * 三条"什么都没变"不够判：安静让路与半路炸了读数一样（旧链那条当年就是这么写的）。所以这里
 * 同时钉两件事——这一发**被受理过**（那条已 completed 的 job 重新认领、又结算回 completed），
 * 以及它走的是哪条路（入口状态门认出 run 已不在可跑档就 return，不重付生成那一发）。
 */
test("重放防护（自旧链改接）：重投整批那一发不新增计划、不新增候选、不重复留痕，终态不动", async () => {
  const probe = async () => {
    const rows = await admin`
      SELECT
        (SELECT COUNT(*) FROM card_generation_plans_v2 WHERE run_id = ${simplifiedRunId}) AS plans,
        (SELECT COUNT(*) FROM card_generation_candidates_v2
           WHERE run_id = ${simplifiedRunId}) AS candidates,
        (SELECT COUNT(*) FROM card_generation_events_v2
           WHERE run_id = ${simplifiedRunId}
             AND event_type IN ('card_generation.simplified_completed',
                                'card_generation.simplified_plan_committed')) AS trace_events,
        (SELECT status FROM card_generation_runs_v2 WHERE id = ${simplifiedRunId}) AS status
    ` as unknown as Array<{ plans: string; candidates: string; trace_events: string; status: string }>;
    return rows[0]!;
  };
  const baseline = await probe();
  assert.ok(Number(baseline.candidates) >= 1, "上一发没在这条 run 上落下候选，重放无从比对");

  // 换一把新租约把**已经结算过的那条整批 job** 再投一遍：等价于回收器发现租约过期之后
  // 另一个 worker 重投这一行。
  const freshToken = randomUUID();
  const claimed = await admin`
    UPDATE card_generation_run_outbox_v2
    SET status = 'processing', started_at = now(),
        lease_expires_at = now() + interval '30 minutes', lease_token = ${freshToken}
    WHERE run_id = ${simplifiedRunId} AND job_type = 'card_generation_simplified_v1'
      AND status = 'completed'
    RETURNING id, workspace_id, run_id, job_type, payload
  ` as unknown as Array<{ id: string; workspace_id: string; run_id: string;
    job_type: string; payload: Record<string, unknown> }>;
  assert.equal(claimed.length, 1, "本 run 该有一条已完成的整批 job（上一条用例跑的就是它）");
  const { processV2OutboxJob } = await import("../handlers/card-generation-v2-handler.ts");
  await processV2OutboxJob({
    id: claimed[0]!.id, workspaceId: claimed[0]!.workspace_id, runId: claimed[0]!.run_id,
    jobType: claimed[0]!.job_type, payload: claimed[0]!.payload, leaseToken: freshToken,
  });

  const replayed = await probe();
  assert.equal(replayed.candidates, baseline.candidates, "重投写出了第二份候选");
  assert.equal(replayed.plans, baseline.plans, "重投又落了一版计划");
  assert.equal(replayed.trace_events, baseline.trace_events, "重投把生成/完成那两发留痕又发了一遍");
  assert.equal(replayed.status, baseline.status, "重投把已经定下来的终态挪走了");

  const jobState = await admin`
    SELECT status, last_error FROM card_generation_run_outbox_v2 WHERE id = ${claimed[0]!.id}
  ` as unknown as Array<{ status: string; last_error: string | null }>;
  assert.equal(jobState[0]!.status, "completed",
    `重投没有被安静让路，而是停在 ${jobState[0]!.status}：${jobState[0]!.last_error ?? "无错误信息"}`);
});

/**
 * 新链出的卡**保存得下来**（W7-1 与 W7-2 的接缝）。
 *
 * 上一条用例只走到"保留"。§16.28 那句"零候选是正常结果"讲的只是生成侧；这一发回答另一半：
 * 简化链产的候选过不过得了现网那条真实激活命令（闭包重验、binding plan 资格、发布后那道泄题闸），
 * 以及「保存并开启复习」那一档在这一发上接不接得住唯一调度边界。全程只用现网命令——
 * 上一条用例已经 `keep` 过一张，这里直接拿它激活。
 */
test("保存那一发：新链的候选过得了真实激活，并按那一档排上唯一那条安排", async (t) => {
  const kept = (await admin`
    SELECT candidate_id, candidate_revision_id, revision, candidate_revision_hash,
           evidence_binding_plan_hash, quality_state
    FROM card_generation_candidates_v2
    WHERE run_id = ${simplifiedRunId} AND review_decision = 'keep'
    ORDER BY candidate_id LIMIT 1
  ` as unknown as Array<{
    candidate_id: string; candidate_revision_id: string; revision: number;
    candidate_revision_hash: string; evidence_binding_plan_hash: string | null;
    quality_state: string;
  }>)[0];
  assert.ok(kept, "上一条用例应当留下一张已保留的候选；没有就是夹具坏了");
  assert.equal(kept.quality_state, "passed", "激活只接过了内容检查的候选");
  assert.ok(kept.evidence_binding_plan_hash, "激活重验资格看的就是这一格");

  const runRow = (await admin`
    SELECT card_content_epoch, source_snapshot_hash, semantic_spec_hash, input_snapshot_hash,
           review_draft_revision
    FROM card_generation_runs_v2 WHERE id = ${simplifiedRunId}
  ` as unknown as Array<Record<string, unknown>>)[0];
  const planRow = (await admin`
    SELECT plan_revision_id, plan_version, plan_hash FROM card_generation_plans_v2
    WHERE run_id = ${simplifiedRunId} ORDER BY plan_version DESC LIMIT 1
  ` as unknown as Array<Record<string, unknown>>)[0];
  const { computeClientReviewHashV2 } = await import(
    "../../../../packages/shared/src/card-generation-v2-hashing.ts"
  );
  const clientReviewHash = computeClientReviewHashV2({
    runId: simplifiedRunId,
    expectedReviewDraftRevision: Number(runRow!.review_draft_revision),
    selected: [{
      candidateId: kept.candidate_id,
      revision: kept.revision,
      revisionHash: kept.candidate_revision_hash,
    }],
    reviewUiContractVersion: "review-ui-v1",
  });
  const request = {
    version: 2 as const,
    runId: simplifiedRunId,
    sourceSnapshotHash: String(runRow!.source_snapshot_hash),
    semanticSpecHash: String(runRow!.semantic_spec_hash),
    inputSnapshotHash: String(runRow!.input_snapshot_hash),
    expectedCardContentEpoch: Number(runRow!.card_content_epoch),
    planRevisionId: String(planRow!.plan_revision_id),
    expectedPlanVersion: Number(planRow!.plan_version),
    planHash: String(planRow!.plan_hash),
    selectedCandidates: [{
      candidateRevisionId: kept.candidate_revision_id,
      candidateId: kept.candidate_id,
      revision: kept.revision,
      revisionHash: kept.candidate_revision_hash,
      candidateEvidenceBindingPlanHash: kept.evidence_binding_plan_hash!,
      qualityReportHashes: [],
      intent: { kind: "create_new" } as const,
    }],
    existingLifecycleActions: [],
    expectedReviewDraftRevision: Number(runRow!.review_draft_revision),
    clientReviewHash,
    startReviewScheduling: true,
  };

  const { activateCardCandidatesV2 } = await import(
    "../../../../apps/api/src/modules/card-generation-v2/activation-service.ts"
  );
  const ctx = { workspaceId: WORKSPACE_ID, userId: USER_ID };

  // ── 两道"这一发凭什么算过"，先量再走成功路径 ─────────────────────────────
  // 激活侧对依据本身做两件事：引用的证据快照此刻还得是 `usable`（§13.1），以及
  // binding plan 冻住的那份**资格向量哈希**要与当场重算的一致（§13.3）。
  // 只在成功路径上钉一句"能激活"，分不清"新链交的闭包是真的"与"那道闸被绕过了"。
  const bindingPlanRow = (await admin`
    SELECT target_unit_bindings, evidence_eligibility_vector_hash
    FROM candidate_evidence_binding_plans_v2
    WHERE run_id = ${simplifiedRunId} AND candidate_revision_id = ${kept.candidate_revision_id}
  ` as unknown as Array<{ target_unit_bindings: unknown; evidence_eligibility_vector_hash: string | null }>)[0];
  assert.ok(bindingPlanRow, "过了内容检查的候选必须留下 binding plan 行");
  const frozenVectorHash = String(bindingPlanRow!.evidence_eligibility_vector_hash ?? "");
  // 服务端对"占位形状"豁免这段比对（那是给手写夹具留的口子）。新链哪天改成写占位符，
  // 这道闸就对这条链**静默失效**——所以这里把它钉成会红的东西。
  assert.equal(/^([a-f0]{64}|0{64})$/.test(frozenVectorHash), false,
    `新链不许交回占位资格向量（得到 ${frozenVectorHash.slice(0, 8)}…）`);
  const bindings = (typeof bindingPlanRow!.target_unit_bindings === "string"
    ? JSON.parse(bindingPlanRow!.target_unit_bindings)
    : bindingPlanRow!.target_unit_bindings) as Array<Record<string, unknown>>;
  const snapshotIds = [...new Set(bindings
    .flatMap((entry) => typeof entry.evidenceSnapshotId === "string" ? [entry.evidenceSnapshotId] : []))];
  assert.ok(snapshotIds.length > 0, "读不到这张候选引用的证据快照——那下面两条拒绝用例就是瞎测");
  const [snapshotId] = snapshotIds;
  const eligibilityBefore = (await admin`
    SELECT status, eligibility_epoch, eligibility_vector_hash FROM evidence_eligibility_states_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND evidence_snapshot_id = ${snapshotId}
  ` as unknown as Array<{ status: string; eligibility_epoch: number; eligibility_vector_hash: string }>)[0];
  assert.ok(eligibilityBefore, "封存时该给被引用的快照留下一行资格状态");
  const restoreEligibility = async () => {
    await admin`
      UPDATE evidence_eligibility_states_v2
      SET status = ${eligibilityBefore!.status}, eligibility_epoch = ${eligibilityBefore!.eligibility_epoch},
          eligibility_vector_hash = ${eligibilityBefore!.eligibility_vector_hash}
      WHERE workspace_id = ${WORKSPACE_ID} AND evidence_snapshot_id = ${snapshotId}
    `;
  };
  // 半路红了也要把资格状态还回去（这个文件的 `after()` 按 workspace 删行，删不掉别人那条）。
  t.after(restoreEligibility);

  const cardCount = async () => Number((await admin`
    SELECT count(*)::int AS n FROM learning_cards_v2 WHERE workspace_id = ${WORKSPACE_ID}
  ` as unknown as Array<{ n: number }>)[0]?.n);
  const cardsBefore = await cardCount();

  // ① 依据被撤销 ⇒ 拒，并且一格都不写。
  await admin`
    UPDATE evidence_eligibility_states_v2
    SET status = 'revoked', eligibility_epoch = eligibility_epoch + 1
    WHERE workspace_id = ${WORKSPACE_ID} AND evidence_snapshot_id = ${snapshotId}
  `;
  await assert.rejects(
    () => activateCardCandidatesV2(ctx, request, `v3-revoked-${randomUUID()}`),
    (error: unknown) => (error as { code?: string }).code === "evidence_revoked",
    "依据撤销之后，新链的卡不许保存下来",
  );
  assert.equal(await cardCount(), cardsBefore, "被拒的那一发一张卡都不写（不部分提交）");
  assert.equal(await runStatus(simplifiedRunId), "review_ready", "被拒之后这一轮还停在可审核，没有半推进");
  await restoreEligibility();

  // ② 闭包被改 ⇒ 也拒：证明激活真的比对了那份向量哈希，而不是只看它在不在。
  //    挑的替身值含 `1`（不在豁免用到的 [a-f0] 里），否则会被那道豁免当成占位符放过。
  await admin`
    UPDATE candidate_evidence_binding_plans_v2
    SET evidence_eligibility_vector_hash = ${"1".repeat(64)}
    WHERE run_id = ${simplifiedRunId} AND candidate_revision_id = ${kept.candidate_revision_id}
  `;
  await assert.rejects(
    () => activateCardCandidatesV2(ctx, request, `v3-tampered-${randomUUID()}`),
    (error: unknown) => (error as { code?: string }).code === "stale_evidence",
    "资格向量对不上时不许激活",
  );
  assert.equal(await cardCount(), cardsBefore, "第二发被拒同样不留卡");
  await admin`
    UPDATE candidate_evidence_binding_plans_v2
    SET evidence_eligibility_vector_hash = ${frozenVectorHash}
    WHERE run_id = ${simplifiedRunId} AND candidate_revision_id = ${kept.candidate_revision_id}
  `;

  // ── 两道闸都咬得住之后，再走成功那一发 ──────────────────────────────────
  const receipt = await activateCardCandidatesV2(
    ctx,
    request,
    `v3-activate-${randomUUID()}`,
  );
  const mapping = receipt.mappings[0]!;
  assert.ok(mapping.cardId && mapping.objectiveId, "回执要指得出那张卡与那个目标");

  // 那张卡表认的是业务列 `card_id`（`id` 是行主键，两者不同 uuid——第一次写这里用 `id`
  // 查到 0 行，红的是我自己的查询形状，不是链）。
  const cards = await admin`
    SELECT lifecycle FROM learning_cards_v2 WHERE card_id = ${mapping.cardId} AND workspace_id = ${WORKSPACE_ID}
  ` as unknown as Array<{ lifecycle: string }>;
  assert.equal(cards.length, 1, "新链的卡真的落在现网那张卡上");
  assert.equal(cards[0]!.lifecycle, "active");

  // 「保存并开启复习」那一档在这一发上也成立：恰一条待处理安排，回执说的那天就是库里那天。
  assert.ok(receipt.scheduling, "要了那一档就要交出排期结果");
  assert.equal(receipt.scheduling[0].created, true, "第一次开启是新建，不是凭空说沿用");
  const schedules = await admin`
    SELECT id, status, next_review_at, reason_code FROM review_schedules
    WHERE workspace_id = ${WORKSPACE_ID} AND subject_id = ${mapping.objectiveId}
  ` as unknown as Array<{ id: string; status: string; next_review_at: Date; reason_code: string }>;
  assert.equal(schedules.length, 1, "新链这一发也只留一条安排（挡它的是同一条唯一索引）");
  assert.equal(schedules[0]!.status, "pending");
  assert.equal(schedules[0]!.reason_code, "activation_authorized");
  assert.equal(receipt.scheduling[0].nextReviewAt, new Date(schedules[0]!.next_review_at).toISOString());
  for (const row of schedules) {
    // 这个文件的 `after()` 原本没有卡片侧（此前没人激活过）；这一发起的账自己收。
    t.after(async () => {
      await admin`DELETE FROM review_schedules WHERE id = ${row.id} AND workspace_id = ${WORKSPACE_ID}`;
    });
  }

  // 卡组那一读说的那天，必须就是回执说的那天——这一格是**另一条 SQL**（`card-service.ts`
  // 的 `listActiveCardsV2` 自己 JOIN `review_schedules`），两处各读各的迟早分叉。
  const { listActiveCardsV2, readPublicCardV2 } = await import(
    "../../../../apps/api/src/modules/card-generation-v2/card-service.ts"
  );
  const listed = (await listActiveCardsV2(ctx, {})).items.find(
    (card: { objectiveId: string }) => card.objectiveId === mapping.objectiveId,
  ) as { nextReviewAt?: string; reviewStatus?: string } | undefined;
  assert.ok(listed, "保存下来的卡要出现在现网那份卡列表里（那条读路就是界面读的）");
  assert.equal(listed!.reviewStatus, "pending", "列表要说清这条安排是待处理");
  assert.equal(listed!.nextReviewAt, receipt.scheduling[0].nextReviewAt,
    "回执与卡列表两处读数不许各说一套");

  // 两条待处理安排可以并存（唯一键里带着观察维度），那时"下一次复习"报哪一条**必须有仲裁者**。
  // 判据拍成"最早那一条"：复习队列与目标面本来就按 `next_review_at ASC` 取（`hud-pages.ts`
  // 那句"队列按升序"），卡侧那两处原先是 `DESC` ⇒ 同一目标两处会报出不同日期。
  // 今天生产路径只写默认维度，撞不上；W7-5 一开始按维度排期就会撞上，所以现在就把它钉住。
  await admin`
    INSERT INTO review_schedules
      (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at,
       interval_days, generation, policy_version, reason_code, review_dimension, created_at, updated_at)
    VALUES (gen_random_uuid(), ${WORKSPACE_ID}, ${USER_ID}, 'card', ${mapping.objectiveId}, 'pending',
            now() + interval '10 days', 4, 1, 'discrete-v2', 'second_dimension_fixture', 'recall_probe', now(), now())
  `;
  t.after(async () => {
    await admin`
      DELETE FROM review_schedules
      WHERE workspace_id = ${WORKSPACE_ID} AND reason_code = 'second_dimension_fixture'
    `;
  });
  const listedWithSecond = (await listActiveCardsV2(ctx, {})).items.find(
    (card: { objectiveId: string }) => card.objectiveId === mapping.objectiveId,
  ) as { nextReviewAt?: string } | undefined;
  assert.equal(listedWithSecond?.nextReviewAt, receipt.scheduling[0].nextReviewAt,
    "同一目标多一条更晚的安排时，卡侧仍要报**最近的那一次**（与队列同一判据）");
  const detail = await readPublicCardV2(ctx, mapping.cardId);
  assert.equal(detail?.nextReviewAt, receipt.scheduling[0].nextReviewAt,
    "卡详情那一读要与卡列表同一判据，不许一处取最早、一处取最晚");

  // 上面那两条钉的是"展示侧"。**队列那一读才是真的会消费这一行的地方**，而 D2 §3.5 的表里
  // 只写了一句"队列本来就升序"——没有一条用例真去读过它。这里补上，并且先把一件事量清楚：
  // 队列不按目标去重，它只按"到期才给"。所以同一个目标挂四条待处理时（回执那条 +1 天、
  // 上面那条 +10 天，两条都没到期；再加两条已过点的），队列给的就是**过了点的那两条、同一张卡两次**。
  //
  // 维度名必须与上面那条夹具（`recall_probe`）不撞——0287 那把部分唯一索引管的就是
  // （空间、人、目标、维度）里同为待处理的行，撞了会当场 23505（第一次写这里就撞过一次，
  // 红的是夹具不是链）。
  //
  // **这一条是取证，不是承诺**：W7-5 那句"每目标同一次日程最多提交一次"要在队列这一发上
  // 落一个按目标的仲裁者才算数；谁落了，下面那两句"给 2 条 / 同一张卡"会红，那时改成正向断言。
  await admin`
    INSERT INTO review_schedules
      (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at,
       interval_days, generation, policy_version, reason_code, review_dimension, created_at, updated_at)
    VALUES (gen_random_uuid(), ${WORKSPACE_ID}, ${USER_ID}, 'card', ${mapping.objectiveId}, 'pending',
            now() - interval '2 days', 4, 1, 'discrete-v2', 'two_due_dimension_fixture', 'apply_probe', now(), now())
  `;
  await admin`
    INSERT INTO review_schedules
      (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at,
       interval_days, generation, policy_version, reason_code, review_dimension, created_at, updated_at)
    VALUES (gen_random_uuid(), ${WORKSPACE_ID}, ${USER_ID}, 'card', ${mapping.objectiveId}, 'pending',
            now() - interval '1 day', 4, 1, 'discrete-v2', 'two_due_dimension_fixture', 'express_probe', now(), now())
  `;
  t.after(async () => {
    await admin`
      DELETE FROM review_schedules
      WHERE workspace_id = ${WORKSPACE_ID} AND reason_code = 'two_due_dimension_fixture'
    `;
  });

  const { listReviews } = await import(
    "../../../../apps/api/src/modules/review/service.ts"
  );
  type QueueRow = {
    card: { id: string };
    objective?: { id?: string } | null;
    review: { nextReviewAt: Date; reviewDimension: string; status: string };
  };
  const queue = await listReviews(WORKSPACE_ID, { limit: 100 }, USER_ID) as unknown as
    { items: QueueRow[]; total: number };
  const forThisObjective = queue.items.filter(
    (item) => item.objective?.id === mapping.objectiveId,
  );
  assert.equal(forThisObjective.length, 2,
    `同一目标两条都到期时，队列按"行"给而不是按"目标"给（得到 ${forThisObjective.length} 条）：`
      + "这一句是 W7-5 的取证，落了按目标的仲裁者请改成正向断言（同一目标只出一条、取最早）");
  assert.equal(
    new Set(forThisObjective.map((item) => item.card.id)).size, 1,
    "那两条指向的是**同一张卡**——用户看到的会是这张卡的两次",
  );
  const queueStamps = forThisObjective.map((item) => new Date(item.review.nextReviewAt).getTime());
  assert.ok(
    queueStamps.every((value, index) => index === 0 || queueStamps[index - 1]! <= value),
    `队列要按到期升序（实际 ${queueStamps.join(" → ")}）——展示侧报最早那一条，消费侧就得最先给那一条`,
  );
  // 队列那句"一条"是**到期过滤**给的，不是去重给的：这个目标此刻库里挂着三条待处理
  // （回执那条 +1 天、上面那条 +10 天、以及两条已过点的），队列只给已过点的这两条。
  const pendingCount = await admin`
    SELECT count(*)::int AS n FROM review_schedules
    WHERE workspace_id = ${WORKSPACE_ID} AND subject_id = ${mapping.objectiveId} AND status = 'pending'
  ` as unknown as Array<{ n: number }>;
  assert.equal(pendingCount[0]!.n, 4,
    `这个目标此刻该挂着 4 条待处理（回执 1＋夹具 3，实际 ${pendingCount[0]!.n}）——`
      + "分母变了，上面那两句判据就各说不上话了");
  assert.ok(forThisObjective.every((item) => new Date(item.review.nextReviewAt).getTime() <= Date.now()),
    "队列给的每一条都必须已过点（还没到期的那两条被挡在外面，这才是它只给两条的原因）");

  // 下游消费者也收到这一发：激活后排一条 post-activation 投影任务（与旧链同一条出口）。
  const dispatched = await admin`
    SELECT count(*)::int AS n FROM card_generation_run_outbox_v2
    WHERE run_id = ${simplifiedRunId} AND job_type = 'card_v2_post_activation'
  ` as unknown as Array<{ n: number }>;
  assert.equal(dispatched[0]!.n, 1, "新链的保存也要投出那一条后置投影任务");
  assert.equal(await runStatus(simplifiedRunId), "activated");
});

test("检查失败不重跑生成：计划与首稿留着，重投从段 4 接上", async () => {
  const buildGenerate = countingGenerate();
  const {
    createDeterministicCardCandidateRewriteV3Provider,
    createDeterministicCardContentCheckV3Provider,
  } = await import("../card-generation-v3/deterministic.ts");
  const { processCardGenerationSimplifiedJob } = await import("../card-generation-v3/handler.ts");
  const generate = await buildGenerate();

  // 第一遍：检查那一发抛（可重试的网络故障形状）⇒ 整发失败，但段 3 已提交。
  const failingJob = await claimSimplifiedJob(otherUserRunTarget);
  await assert.rejects(async () => processCardGenerationSimplifiedJob(
    failingJob,
    {
      generate,
      check: {
        modelId: "failing-v3",
        async complete() { throw new Error("provider 503：检查这一发没成"); },
      },
      rewrite: await createDeterministicCardCandidateRewriteV3Provider(),
    },
  ), "provider 抛错必须让这一发失败");
  const planAfterFirst = await admin`
    SELECT plan_revision_id, plan_hash FROM card_generation_plans_v2
    WHERE run_id = ${otherUserRunTarget}
  ` as unknown as Array<{ plan_revision_id: string; plan_hash: string }>;
  assert.equal(planAfterFirst.length, 1, "计划行是第一次那发留下的，不会被重投再写一版");
  assert.equal(generate.calls(), 1, "第一次确实付了生成那一发");
  assert.equal(await runStatus(otherUserRunTarget), "checking");

  // 第二遍（重投）：生成端口一次都不许被调用，检查接上并收口。
  const replayGenerate = await buildGenerate();
  assert.equal(replayGenerate.calls(), 1, "计数器是共享的那一份：第一遍确实只付了一发");
  const job2 = await claimSimplifiedJob(otherUserRunTarget, { replay: true });
  await processCardGenerationSimplifiedJob(job2, {
    generate: replayGenerate,
    check: createDeterministicCardContentCheckV3Provider(),
    rewrite: await createDeterministicCardCandidateRewriteV3Provider(),
  });
  assert.equal(replayGenerate.calls(), 1, "重投之后计数没涨——生成那一发没再付一次（§16.28 的另一半）");
  // 库里的两条事件各自记的是**本发之内**的调用数：第一遍付了生成（记在 plan_committed），
  // 这一遍只付检查。两条相加才是这一批真付过的钱，所以两个数各钉一次——
  // 把完成事件的数写死成 2，在这里就会红。
  const firstPassPaid = await eventPayload(otherUserRunTarget, "card_generation.simplified_plan_committed");
  const secondPassPaid = await eventPayload(otherUserRunTarget, "card_generation.simplified_completed");
  assert.equal(firstPassPaid.modelCalls, 1, "第一遍那一发只付了生成");
  assert.equal(secondPassPaid.modelCalls, 1, "重投那一发只付了检查");
  assert.equal(await runStatus(otherUserRunTarget), "review_ready");
  const planAfterReplay = await admin`
    SELECT plan_revision_id, plan_hash FROM card_generation_plans_v2
    WHERE run_id = ${otherUserRunTarget}
  ` as unknown as Array<{ plan_revision_id: string; plan_hash: string }>;
  assert.deepEqual(planAfterReplay, planAfterFirst, "重投之后计划还是那一条，一字未动");
});

test("零候选是正常结果：只付一次生成，run 落在 no_cards_recommended", async () => {
  const job = await claimSimplifiedJob(zeroCandidateRunId);
  const { processV2OutboxJob } = await import("../handlers/card-generation-v2-handler.ts");
  await processV2OutboxJob(job);

  assert.equal(await runStatus(zeroCandidateRunId), "no_cards_recommended");
  const payload = await eventPayload(zeroCandidateRunId, "card_generation.no_cards_recommended");
  assert.equal(payload.chain, "simplified_v3");
  assert.equal(payload.modelCalls, 1, "没有候选可检查时不该付第二次调用的钱");
  const candidates = await admin`
    SELECT count(*)::int AS n FROM card_generation_candidates_v2 WHERE run_id = ${zeroCandidateRunId}
  ` as unknown as Array<{ n: number }>;
  assert.equal(Number(candidates[0]?.n), 0);
  const planRows = await admin`
    SELECT result ->> 'kind' AS kind, result -> 'reasonCodes' AS reasons
    FROM card_generation_plans_v2 WHERE run_id = ${zeroCandidateRunId}
  ` as unknown as Array<{ kind: string; reasons: string[] }>;
  assert.equal(planRows[0]?.kind, "no_cards_recommended");
  assert.ok(Array.isArray(planRows[0]?.reasons) && (planRows[0]?.reasons.length ?? 0) > 0,
    "零候选也要说得出为什么（折进冻结词表的那份理由码）");
});

test("别人的空间读不到这条 run（RLS＋SQL 条件两道都在）", async () => {
  const { getGenerationRunV2 } = await import(
    "../../../../apps/api/src/modules/card-generation-v2/generation-run-service.ts"
  );
  const asOther = await getGenerationRunV2(
    { workspaceId: OTHER_WORKSPACE_ID, userId: OTHER_USER_ID },
    simplifiedRunId,
  );
  assert.equal(asOther, null);
  const asOwner = await getGenerationRunV2(
    { workspaceId: WORKSPACE_ID, userId: USER_ID },
    simplifiedRunId,
  );
  assert.ok(asOwner, "正控制：本人读得到自己那一条");
});

test("增量改写：只重做被判 rewrite 的那一张，重检只看它，调用数如实涨到 4", async () => {
  const { processCardGenerationSimplifiedJob } = await import("../card-generation-v3/handler.ts");
  const {
    createDeterministicCardGenerateV3Provider,
    createDeterministicCardCandidateRewriteV3Provider,
  } = await import("../card-generation-v3/deterministic.ts");
  const checkCallsWith: number[] = [];
  const scriptedCheck = {
    modelId: "scripted-check-v3",
    async complete({ input }: { input: unknown }) {
      const typed = input as {
        candidates: Array<{ objectiveLocalId: string; candidate: { candidateRevisionId: string } }>;
        evidenceManifest: never;
      };
      checkCallsWith.push(typed.candidates.length);
      const perCandidate = [];
      for (const [index, entry] of typed.candidates.entries()) {
        // 检查腿现在只交裁决与原因；grounding 报告由任务侧按确定性合同现算（脚本桩不手写它）。
        const wantsRewrite = checkCallsWith.length === 1 && index === 0;
        perCandidate.push({
          objectiveLocalId: entry.objectiveLocalId,
          verdict: wantsRewrite ? "rewrite" : "keep",
          issues: wantsRewrite
            ? [{ code: "front_leaks_answer", severity: "soft", detail: "题面太直，改写成需要回想" }]
            : [],
        });
      }
      return { text: JSON.stringify({ perCandidate, setIssues: [] }) };
    },
  };

  const job = await claimSimplifiedJob(rewriteRunId);
  await processCardGenerationSimplifiedJob(job, {
    generate: createDeterministicCardGenerateV3Provider(),
    check: scriptedCheck,
    rewrite: createDeterministicCardCandidateRewriteV3Provider(),
  });

  // **只重检受影响的那些**：第一遍看见整批，第二遍只看见被改写的那一张。
  assert.ok(checkCallsWith.length === 2, `批量检查应该恰好两遍（首检＋重检），实到 ${checkCallsWith.length}`);
  assert.ok(checkCallsWith[0]! > 1, "第一遍要看见整批（否则这一条测不到「只重检」这一半）");
  assert.equal(checkCallsWith[1], 1, "重检只看被改写的那一张，不重跑整批");

  const rows = await admin`
    SELECT candidate_revision_id, revision, publish_state, quality_state, derived_from
    FROM card_generation_candidates_v2
    WHERE run_id = ${rewriteRunId}
    ORDER BY candidate_id, revision
  ` as unknown as Array<{
    candidate_revision_id: string; revision: number; publish_state: string;
    quality_state: string; derived_from: Array<{ revision: number }>;
  }>;
  const first = rows.filter((row) => row.revision === 1);
  const second = rows.filter((row) => row.revision === 2);
  assert.equal(second.length, 1, "被改写的那一张长出第二条修订");
  assert.equal(first.length, checkCallsWith[0], "首稿那些行一条不少（旧修订不覆盖、不删）");
  assert.ok(second[0]!.derived_from?.some((item) => item.revision === 1),
    "新修订要指得回它自己那一版的前一修订");
  const superseded = rows.filter((row) => row.publish_state === "superseded").length;
  assert.equal(superseded, 1, "只有被替换掉的那一版被标 superseded");
  assert.equal(second[0]!.quality_state, "passed", "改写后的那一版过了重检才算可保留");

  const completed = await eventPayload(rewriteRunId, "card_generation.simplified_completed");
  assert.equal(completed.modelCalls, 4,
    "生成 1＋批量检查 1＋改写 1＋重检 1：多付的那两发要如实计入，不隐藏调用");
  assert.equal(completed.rewriteCalls, 1);
  assert.equal(await runStatus(rewriteRunId), "review_ready");
  const rewrittenEvents = await admin`
    SELECT count(*)::int AS n FROM card_generation_events_v2
    WHERE run_id = ${rewriteRunId} AND event_type = 'card_candidate.rewritten'
  ` as unknown as Array<{ n: number }>;
  assert.equal(Number(rewrittenEvents[0]?.n), 1, "改写这一发要留一条能对账的事件");
});

// ── provider 选择那两道闸的形状 ──────────────────────────────────────────
//
// 这两条不碰数据库，却落在这份文件里：`resolveCardGenerationV3Providers` 住在
// `card-generation-v3/handler.ts`，那个模块（以及 `card-generation-v2/providers.ts`）
// 一被 import 就会在模块作用域开一个 postgres 连接池。纯单测文件里没人负责关它，
// 整个 worker 单测套件会挂在退出上；这份集测的 `after` 本来就关两条池。

function withEnv<T>(overrides: Record<string, string | undefined>, run: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) previous.set(key, process.env[key]);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function captureThrow(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

test("没接线的 provider 值抛的是不可重试那一类（裸 Error 会被 outbox 退避连试六轮）", async () => {
  const { resolveCardGenerationV3Providers } = await import("../card-generation-v3/handler.ts");
  const { isNonRetryableErrorLike } = await import("../card-generation-v2/retry-classification.ts");

  const error = withEnv({ CARD_GENERATION_V3_PROVIDER: "llm" },
    () => captureThrow(resolveCardGenerationV3Providers));
  assert.ok(error, "配了一个没接线的值却没抛：那等于静默回落到确定性那一版");
  assert.equal(isNonRetryableErrorLike(error), true,
    "这是配置缺失不是网络抖动。判成可重试时 outbox 会按 15/30/60/120/240s 退避连试六轮，"
    + "期间一次模型调用都没发生，界面上始终是「生成中」（V2 在 2026-09-17 为同样的形状记过一次事故）");
  assert.match(String((error as Error).message), /需要一份按治理上下文解析出来的 transport/);
});

test("生产里不许悄悄用确定性 provider 跑简化链；豁免要显式给，离线路径不受影响", async () => {
  const { resolveCardGenerationV3Providers } = await import("../card-generation-v3/handler.ts");
  const { isNonRetryableErrorLike } = await import("../card-generation-v2/retry-classification.ts");

  // ① 生产 + 没豁免 ⇒ 抛，而且是不可重试（同一套分类器）
  const blocked = withEnv({ NODE_ENV: "production", V3_ALLOW_DETERMINISTIC_PROVIDERS: undefined },
    () => captureThrow(resolveCardGenerationV3Providers));
  assert.ok(blocked, "生产里确定性 provider 没被挡住：完成事件会记下 modelCalls=2，读起来像跑过模型");
  assert.equal(isNonRetryableErrorLike(blocked), true,
    "护栏抛的也必须是不可重试那一类，否则一次配置漂移会变成六轮退避重试");

  // ①b 真模型那一档的"离线出口"此刻是**关着的**：默认档的确定性 provider 已经不算离线。
  // 唯一能挡住"把开关一翻就整批发占位内容"的，是带不带 transport 这一道（分发点在
  // `processV2OutboxJob` 里按 run 的主人与同意解析它）。这一格钉的就是那个"不静默回落"。
  const unwired = withEnv({ NODE_ENV: "development", CARD_GENERATION_V3_PROVIDER: "llm" },
    () => captureThrow(resolveCardGenerationV3Providers));
  assert.ok(unwired, "配了真模型的值却没给 transport，必须抛而不是安静回落到确定性");
  assert.match(String((unwired as Error).message), /不回落到确定性/);
  const wired = withEnv({ NODE_ENV: "development", CARD_GENERATION_V3_PROVIDER: "llm" },
    () => resolveCardGenerationV3Providers({
      transport: { modelId: "fake-v3", async chatCompletion() { return { content: "{}", usage: {} }; } },
    }));
  assert.deepEqual(Object.keys(wired).sort(), ["check", "generate", "rewrite"],
    "带着 transport 时三份端口都交得出来——真模型那一条路今天是接上的（花钱那一次另算）");

  // ② 显式豁免 ⇒ 三份 provider 照旧交出来（离线复核生产形状的库时用）
  const allowed = withEnv({ NODE_ENV: "production", V3_ALLOW_DETERMINISTIC_PROVIDERS: "1" },
    () => resolveCardGenerationV3Providers());
  assert.deepEqual(Object.keys(allowed).sort(), ["check", "generate", "rewrite"]);

  // ③ 非生产（今天的测试与开发路径）⇒ 不被挡：这条护栏不能顺手把离线路径也关死
  const offline = withEnv({ NODE_ENV: "test", V3_ALLOW_DETERMINISTIC_PROVIDERS: undefined },
    () => resolveCardGenerationV3Providers());
  assert.deepEqual(Object.keys(offline).sort(), ["check", "generate", "rewrite"]);
});

// ── 简化链的失败形状：那"一次重试"由谁执行、判成可重试与不可重试各落到什么 ──────
//
// 2026-09-27 之前这条链是 `task.execute` 直调（`runAiTask` 零调用点），任务声明的
// `budget = { maxAutoRetries: 1, stepTimeoutMs: 120_000, taskDeadlineMs: 240_000 }`
// 一格都不落地，而抛裸 Error 又让**队列**去重投六轮、每轮重新付生成那一发。四发现有
// 内核在跑：合同形状先在进程内补采样一次（预算给的那一次），还不合就判不可重试终结。
// 下面两条一头钉住这条新形状，另一头给出"分类真的决定库里的结局"的对照格。

test("生成那一发合不上合同：内核按预算补那一次采样，然后判不可重试（队列不再重付）", async () => {
  const { processCardGenerationSimplifiedJob } = await import("../card-generation-v3/handler.ts");
  const { isNonRetryableErrorLike } = await import("../card-generation-v2/retry-classification.ts");

  const paid: string[] = [];
  const outOfContractGenerate = {
    modelId: "out-of-contract-v3",
    async complete() {
      paid.push("generate");
      return { text: "这一段不是合同要求的 JSON" };
    },
  };
  const mustNotBeCalled = (name: string) => ({
    modelId: `must-not-be-called-${name}`,
    async complete(): Promise<never> {
      paid.push(name);
      throw new Error(`测试桩：${name} 这一发不该发生`);
    },
  });

  const runId = (await createRun(notes.outofcontract.versionId, `v3-outofcontract-${randomUUID()}`,
    { workspaceId: FAIL_SHAPE_WORKSPACE_ID, userId: FAIL_SHAPE_USER_ID })).runId;
  const job = await claimSimplifiedJob(runId);

  let thrown: unknown = null;
  try {
    await processCardGenerationSimplifiedJob(job, {
      generate: outOfContractGenerate,
      check: mustNotBeCalled("check"),
      rewrite: mustNotBeCalled("rewrite"),
    });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error, "输出不合合同必须让这一发失败：静默返回会被分发点记成 succeeded，"
    + "库里看着健康而一张卡都没生成（记忆抽取为同样的形状记过一次事故）");
  assert.match(thrown.message, /card_generate_v3 output rejected/);
  assert.deepEqual(paid, ["generate", "generate"],
    "恰好两发 = 首次＋内核按 `maxAutoRetries: 1` 补的那一次结构修复：多一发说明有人手工又加了一层循环，"
    + "少一发说明预算没接上（这两格在 09-27 之前都是实情的反面：一次不补，队列却补五轮）");
  assert.equal(isNonRetryableErrorLike(thrown), true,
    "合同形状是确定性失败，那一次补采样已经在进程内花掉了 ⇒ 队列再重投只是把同一笔钱再烧一遍。"
    + "判成可重试时 outbox 会按 15/30/60/120/240s 退避重投到 6 次上限");

  const planRows = await admin`
    SELECT count(*)::int AS n FROM card_generation_plans_v2 WHERE run_id = ${runId}
  ` as unknown as Array<{ n: number }>;
  const candidateRows = await admin`
    SELECT count(*)::int AS n FROM card_generation_candidates_v2 WHERE run_id = ${runId}
  ` as unknown as Array<{ n: number }>;
  assert.equal(Number(planRows[0]?.n), 0, "生成没成 ⇒ 段 3 没跑，不许留下半一份计划");
  assert.equal(Number(candidateRows[0]?.n), 0);
  assert.equal(await runStatus(runId), "planning",
    "run 由段 1 推到 planning；失败终态是分发点/回收器的事，handler 自己不许偷写");
});

test("生成那一发跑完才发现租约已易主：内核在提交前把它挡下，迟到的失败也写不动新主人的行", async () => {
  const { processCardGenerationSimplifiedJob } = await import("../card-generation-v3/handler.ts");
  const {
    createDeterministicCardCandidateRewriteV3Provider,
    createDeterministicCardGenerateV3Provider,
    createDeterministicCardContentCheckV3Provider,
  } = await import("../card-generation-v3/deterministic.ts");

  const runId = (await createRun(notes.leasechange.versionId, `v3-leasechange-${randomUUID()}`,
    { workspaceId: FAIL_SHAPE_WORKSPACE_ID, userId: FAIL_SHAPE_USER_ID })).runId;
  const job = await claimSimplifiedJob(runId);
  const newLeaseToken = randomUUID();

  let calls = 0;
  const stealingGenerate = {
    modelId: "lease-stealing-v3",
    async complete(request: Parameters<ReturnType<typeof createDeterministicCardGenerateV3Provider>["complete"]>[0]) {
      calls += 1;
      if (calls === 1) {
        // 生产的成因是回收器把超期租约交给了别人（`reapStaleV2OutboxJobs`：attempts+1
        // → 退避 → 回 pending → 另一发认领并写入新 token）。测试直接把 token 换掉，
        // 造成的就是这个结果：本进程这一次尝试从此不再作数。
        await admin`
          UPDATE card_generation_run_outbox_v2 SET lease_token = ${newLeaseToken} WHERE id = ${job.id}
        `;
      }
      return createDeterministicCardGenerateV3Provider().complete(request);
    },
  };

  let thrown: unknown = null;
  try {
    await processCardGenerationSimplifiedJob(job, {
      generate: stealingGenerate,
      check: createDeterministicCardContentCheckV3Provider(),
      rewrite: createDeterministicCardCandidateRewriteV3Provider(),
    });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error, "输出已经拿到了，但这一发不再作数 ⇒ 必须失败，不许当成功提交");
  assert.match(thrown.message, /lease_lost/,
    "**归因要落到内核那一层**：D5 §4.1 的『租约换了 ⇒ 旧尝试的输出不许提交』是 `verifyAttempt` "
    + "这个端口在做的事。段 3 事务里那道 `fenceV2OutboxLease` 也会挡（它的话是 "
    + "「V2 outbox lease lost before transaction commit」），但那已经是**跑完模型、进了事务**之后——"
    + "两个来源判的是同一件事的两端，这里要读到的是前面那一端");
  assert.equal(calls, 1,
    "钱是花出去了（这一次调用真实发生），被挡下的是提交；`lease_lost` 不在可重试那三档里，"
    + "所以内核不会拿着同一份输入再采样一次");

  const planRows = await admin`
    SELECT count(*)::int AS n FROM card_generation_plans_v2 WHERE run_id = ${runId}
  ` as unknown as Array<{ n: number }>;
  const candidateRows = await admin`
    SELECT count(*)::int AS n FROM card_generation_candidates_v2 WHERE run_id = ${runId}
  ` as unknown as Array<{ n: number }>;
  assert.equal(Number(planRows[0]?.n), 0, "旧尝试的输出不许变成库里的计划行");
  assert.equal(Number(candidateRows[0]?.n), 0);
  assert.equal(await runStatus(runId), "planning", "run 停在段 1 推到的那一档，没有迟到写入");

  const outbox = await admin`
    SELECT status, lease_token FROM card_generation_run_outbox_v2 WHERE id = ${job.id}
  ` as unknown as Array<{ status: string; lease_token: string | null }>;
  assert.equal(outbox[0]?.lease_token, newLeaseToken,
    "迟到的那次失败**写不动**新主人的行：complete/fail 都带 lease_token 的 CAS，"
    + "对不上就是 0 行（不换 token 就退化成把别人正在跑的那一发判死）");
});

test("检查那一发两次都不合合同：生成那一发不重付，首稿留着但一张都不算通过", async () => {
  const { processCardGenerationSimplifiedJob } = await import("../card-generation-v3/handler.ts");
  const { isNonRetryableErrorLike } = await import("../card-generation-v2/retry-classification.ts");
  const {
    createDeterministicCardGenerateV3Provider,
  } = await import("../card-generation-v3/deterministic.ts");

  const paid: string[] = [];
  const countingGenerate = {
    modelId: "counting-generate-v3",
    async complete(request: Parameters<ReturnType<typeof createDeterministicCardGenerateV3Provider>["complete"]>[0]) {
      paid.push("generate");
      return createDeterministicCardGenerateV3Provider().complete(request);
    },
  };
  const brokenCheck = {
    modelId: "broken-check-v3",
    async complete() {
      paid.push("check");
      return { text: "检查这一发交回的不是合同 JSON" };
    },
  };

  const runId = (await createRun(notes.checkbroken.versionId, `v3-checkbroken-${randomUUID()}`,
    { workspaceId: OTHER_WORKSPACE_ID, userId: OTHER_USER_ID })).runId;
  const job = await claimSimplifiedJob(runId);

  let thrown: unknown = null;
  try {
    await processCardGenerationSimplifiedJob(job, {
      generate: countingGenerate,
      check: brokenCheck,
      rewrite: {
        modelId: "must-not-be-called-rewrite",
        async complete(): Promise<never> {
          paid.push("rewrite");
          throw new Error("测试桩：检查都没成，改写这一发不该发生");
        },
      },
    });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error, "检查没成必须让这一发失败：安静返回会被分发点记成 succeeded，"
    + "库里留下一批从没检查过的候选而监控看着健康（记忆抽取为同样的形状记过一次事故）");
  assert.match(thrown.message, /card_content_check_v3 output rejected/);
  assert.deepEqual(paid, ["generate", "check", "check"],
    "段 4 那一发同样有内核那一次补采样（这是「两腿都要量」的原因：上一格只量了生成那一腿）；"
    + "而生成那一发**不重付**——计划已经落库，整批不从段 2 重来");
  assert.equal(isNonRetryableErrorLike(thrown), true,
    "同一句分类判据在第二腿上也成立：这一腿失败时钱已经花在「首稿＋两次检查」上，队列再重投只是"
    + "把两次检查再花一遍，而形状不合合同的输出不会更好");

  const planRows = await admin`
    SELECT count(*)::int AS n FROM card_generation_plans_v2 WHERE run_id = ${runId}
  ` as unknown as Array<{ n: number }>;
  assert.equal(Number(planRows[0]?.n), 1, "段 3 已经提交过：这一版计划留着（重投从段 4 接上的前提）");
  const states = await admin`
    SELECT quality_state, count(*)::int AS n FROM card_generation_candidates_v2
    WHERE run_id = ${runId} GROUP BY quality_state
  ` as unknown as Array<{ quality_state: string; n: number }>;
  assert.ok(states.length > 0, "首稿候选必须已经在库里——不然「一张都没通过」是空库读出来的假象");
  assert.equal(states.length, 1,
    "候选只该有一种 `quality_state`：混进 passed 或掉出牌堆都说明检查没成却有人替它判了结论");
  assert.equal(states[0]?.quality_state, "authored",
    "检查没成 ⇒ 一张都不许被记成 passed／也没被抹掉：停在 authored 等人工（§16.28 的另一半）");
  assert.equal(await runStatus(runId), "checking",
    "run 停在段 3 推到的那一档；终态由分发点写（那一转已在对照格里量过），handler 不偷写失败");

  await assert.rejects(
    () => createRun(notes.checkbroken.versionId, `v3-checkbroken-again-${randomUUID()}`,
      { workspaceId: OTHER_WORKSPACE_ID, userId: OTHER_USER_ID }),
    (error: unknown) => (error as { code?: string }).code === "note_generation_in_flight",
    "**用户在这一刻看到什么**：这一批还挂在在制档，同一篇笔记开不出第二批。放开它的是分发点把"
    + "这一发判成 `needs_attention`（`error_code` 不是 quality_gate_failed ⇒ 那道守卫认它不是活批）——"
    + "所以「不可重试终结」对用户是「可以再点一次生成」，不是「这篇永远卡住」",
  );
});

test("翻到真模型那一档但平台/同意没配好：一次都不外发，且当场终结不重投（走真分发点）", async () => {
  const { processV2OutboxJob } = await import("../handlers/card-generation-v2-handler.ts");
  const runId = (await createRun(notes.deadend.versionId, `v3-llm-refuse-${randomUUID()}`,
    { workspaceId: FAIL_SHAPE_WORKSPACE_ID, userId: FAIL_SHAPE_USER_ID })).runId;
  const job = await claimSimplifiedJob(runId);

  const previousProvider = process.env.CARD_GENERATION_V3_PROVIDER;
  process.env.CARD_GENERATION_V3_PROVIDER = "llm";
  try {
    await processV2OutboxJob(job);
  } finally {
    if (previousProvider === undefined) delete process.env.CARD_GENERATION_V3_PROVIDER;
    else process.env.CARD_GENERATION_V3_PROVIDER = previousProvider;
  }

  const rows = await admin`
    SELECT status, attempts, last_error FROM card_generation_run_outbox_v2
    WHERE id = ${job.id}
  ` as unknown as Array<{ status: string; attempts: number; last_error: string | null }>;
  assert.equal(rows[0]?.status, "failed",
    "这一档的拒绝必须是**不可重试**那一类：配置没配好不会被退避重投修好，六轮之后仍然需要处理");
  assert.equal(Number(rows[0]?.attempts), 1);
  assert.match(String(rows[0]?.last_error),
    /resolved to mock provider|consent|not configured|未配置|同意/,
    "两条拒发理由（平台没配 key / 账号没签同意）任一条成立都是同一件产品事实：没配好就不外发。"
    + `实到：${String(rows[0]?.last_error).slice(0, 160)}`);

  const audit = await admin`
    SELECT count(*)::int AS n FROM ai_audit_log WHERE workspace_id = ${FAIL_SHAPE_WORKSPACE_ID}
  ` as unknown as Array<{ n: number }>;
  assert.equal(Number(audit[0]?.n), 0,
    "**这一格真正要的那个数**：`ai_audit_log` 是模型调用的唯一写入口，0 行＝没有任何字节离开过进程");
  const planRows = await admin`
    SELECT count(*)::int AS n FROM card_generation_plans_v2 WHERE run_id = ${runId}
  ` as unknown as Array<{ n: number }>;
  const candidateRows = await admin`
    SELECT count(*)::int AS n FROM card_generation_candidates_v2 WHERE run_id = ${runId}
  ` as unknown as Array<{ n: number }>;
  assert.equal(Number(planRows[0]?.n), 0, "拒发之后库里不许有半份产出");
  assert.equal(Number(candidateRows[0]?.n), 0);
  assert.equal(await runStatus(runId), "needs_attention");
});

test("不可重试那一类经真分发点落库＝一次终结（上一条负向读数的对照格）", async () => {
  const { processV2OutboxJob } = await import("../handlers/card-generation-v2-handler.ts");
  const runId = (await createRun(notes.deadend.versionId, `v3-deadend-${randomUUID()}`,
    { workspaceId: FAIL_SHAPE_WORKSPACE_ID, userId: FAIL_SHAPE_USER_ID })).runId;
  const job = await claimSimplifiedJob(runId);

  // 走**真分发点**而不是直接调 handler：这一格要证的是"分类真的决定库里的结局"。
  // `CARD_GENERATION_V3_PROVIDER` 给一个没接线的值 ⇒ provider 解析当场抛不可重试
  // （一次模型调用都不发，所以这一格不花钱），由 catch 里那两行去回写 outbox 与 run。
  const previousProvider = process.env.CARD_GENERATION_V3_PROVIDER;
  process.env.CARD_GENERATION_V3_PROVIDER = "llm";
  try {
    await processV2OutboxJob(job);
  } finally {
    if (previousProvider === undefined) delete process.env.CARD_GENERATION_V3_PROVIDER;
    else process.env.CARD_GENERATION_V3_PROVIDER = previousProvider;
  }

  const rows = await admin`
    SELECT status, attempts, next_attempt_at, lease_token
    FROM card_generation_run_outbox_v2
    WHERE run_id = ${runId} AND job_type = 'card_generation_simplified_v1'
  ` as unknown as Array<{ status: string; attempts: number; next_attempt_at: Date | null; lease_token: string | null }>;
  assert.equal(rows[0]?.status, "failed",
    "判成不可重试 ⇒ 直接终态。回 pending 就是上一条那格读到的六轮退避：一次配置漂移"
    + "在界面上表现成长时间「生成中」而不是失败");
  assert.equal(Number(rows[0]?.attempts), 1, "只算了这一次，没有偷偷多投");
  assert.equal(rows[0]?.next_attempt_at, null, "留着下次可认领时间＝还会被认领，那就不是终结");
  assert.equal(rows[0]?.lease_token, null, "租约要交还（不交还＝本进程之外没人接得住这一行）");
  assert.equal(await runStatus(runId), "needs_attention",
    "outbox 终态与 run 的可见状态必须在同一发里落地：只写 outbox 会让界面永远停在「生成中」");

  const planRows = await admin`
    SELECT count(*)::int AS n FROM card_generation_plans_v2 WHERE run_id = ${runId}
  ` as unknown as Array<{ n: number }>;
  assert.equal(Number(planRows[0]?.n), 0, "这一发一次模型都没发，不许有任何产出");
});

// ─── W7-7 刀一：审核台上的三档（逐候选重检／按反馈重生成／整批重排）─────────────
//
// 这三格走的是**真分发点**（`processV2OutboxJob`）：要证的不是某个函数能被调起，而是
// 入口投出去的那两种 jobType 真有人领、领了之后库里留下的是同一套规则下的形状。
// 生产里这些行由 `candidate-review-service` 入队；这里直接写行是为了绕开审核草稿那一套
// 前置（它在 api 包的单测里已有覆盖），**jobType 与 payload 的字段名保持与那边一致**。

async function enqueueRefineJob(input: {
  runId: string;
  workspaceId: string;
  candidateRevisionId: string;
  mode: "recheck" | "rewrite";
  feedbackReasonCodes?: string[];
}): Promise<void> {
  await admin`
    INSERT INTO card_generation_run_outbox_v2 (id, workspace_id, run_id, job_type, payload, status)
    VALUES (${randomUUID()}, ${input.workspaceId}, ${input.runId}, 'card_candidate_refine_v3',
      ${admin.json({
        runId: input.runId,
        workspaceId: input.workspaceId,
        candidateRevisionId: input.candidateRevisionId,
        mode: input.mode,
        ...(input.feedbackReasonCodes ? { feedbackReasonCodes: input.feedbackReasonCodes } : {}),
      })}, 'pending')
  `;
}

/** 这一 run 的某一条修订的库内读数（内容哈希、发布态、质量态、修订号）。 */
async function candidateRevisionReadout(runId: string, candidateRevisionId: string) {
  const rows = await admin`
    SELECT candidate_id, revision, publish_state, quality_state, candidate_revision_hash, plan_version
    FROM card_generation_candidates_v2
    WHERE run_id = ${runId} AND candidate_revision_id = ${candidateRevisionId}
    LIMIT 1
  ` as unknown as Array<{ candidate_id: string; revision: number; publish_state: string;
    quality_state: string; candidate_revision_hash: string; plan_version: number }>;
  return rows[0] ?? null;
}

/**
 * 这一发真被领走并跑完了吗。分发点（`processV2OutboxJob`）把失败写成 outbox 行而不抛给
 * 调用方，所以只看库里的变化读不出"它根本没跑"——上面那一格就是这么漏过一次
 * NOT NULL 违例：候选没落库，测试却往下走，报出来的是"旧修订没让路"。
 */
async function assertJobCompleted(jobId: string): Promise<void> {
  const rows = await admin`
    SELECT status, last_error FROM card_generation_run_outbox_v2 WHERE id = ${jobId} LIMIT 1
  ` as unknown as Array<{ status: string; last_error: string | null }>;
  assert.equal(rows[0]?.status, "completed",
    `job 没有跑完：status=${String(rows[0]?.status)}／error=${String(rows[0]?.last_error).slice(0, 300)}`);
}

/** 这一条修订上落了几份质量报告。 */
async function countReports(candidateRevisionId: string): Promise<number> {
  const rows = await admin`
    SELECT count(*)::int AS n FROM card_candidate_quality_reports_v2
    WHERE candidate_revision_id = ${candidateRevisionId}
  ` as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

test("简化链先把这一 run 推到 review_ready（后面三档都要一个有可审核候选的 run）", async () => {
  const job = await claimSimplifiedJob(refineRunId);
  const { processV2OutboxJob } = await import("../handlers/card-generation-v2-handler.ts");
  await processV2OutboxJob(job);
  await assertJobCompleted(job.id);
  assert.equal(await runStatus(refineRunId), "review_ready");
  const passed = await admin`
    SELECT candidate_revision_id FROM card_generation_candidates_v2
    WHERE run_id = ${refineRunId} AND quality_state = 'passed' AND publish_state = 'unpublished'
    ORDER BY created_at LIMIT 1
  ` as unknown as Array<{ candidate_revision_id: string }>;
  assert.ok(passed[0], "先要有一张 passed 的候选，后面三档才有主体");
  refineSubjectRevisionId = passed[0].candidate_revision_id;
});

test("逐候选那一发·重检：只重过检查这条腿，内容一字不动、不出新修订", async () => {
  const beforeReadout = await candidateRevisionReadout(refineRunId, refineSubjectRevisionId);
  assert.ok(beforeReadout, "主体修订必须读得到，否则下面全部判据都是空集");
  const reportsBefore = await countReports(refineSubjectRevisionId);

  await enqueueRefineJob({
    runId: refineRunId,
    workspaceId: REFINE_WORKSPACE_ID,
    candidateRevisionId: refineSubjectRevisionId,
    mode: "recheck",
  });
  const job = await claimSimplifiedJob(refineRunId, { jobType: "card_candidate_refine_v3" });
  const { processV2OutboxJob } = await import("../handlers/card-generation-v2-handler.ts");
  await processV2OutboxJob(job);
  await assertJobCompleted(job.id);

  const after = await candidateRevisionReadout(refineRunId, refineSubjectRevisionId);
  assert.equal(after?.candidate_revision_hash, beforeReadout.candidate_revision_hash,
    "重检不许改用户写好的内容——那等于替他决定怎么改");
  assert.equal(Number(after?.revision), Number(beforeReadout.revision), "重检不出新修订");
  assert.equal(after?.publish_state, "unpublished", "重检通过的那一张还在审核台上");
  assert.equal(after?.quality_state, "passed");
  assert.equal(await runStatus(refineRunId), "review_ready");
  const reportsAfter = await countReports(refineSubjectRevisionId);
  assert.ok(reportsAfter === reportsBefore + 1,
    `重检要留下一份新报告（读到 ${reportsAfter}，原本 ${reportsBefore}）——没有它这条腿等于没跑`);
  const completed = await eventPayload(refineRunId, "card_generation.simplified_completed");
  assert.equal(Number(completed.modelCalls), 1,
    "重检一张只有检查这一发：读成 0 是白跑，读成 2 是多付了一发");
});

test("逐候选那一发·按反馈重生成：出新修订、旧的标 superseded，两发调用记全", async () => {
  const previous = refineSubjectRevisionId;
  const beforeReadout = await candidateRevisionReadout(refineRunId, previous);
  assert.ok(beforeReadout);

  await enqueueRefineJob({
    runId: refineRunId,
    workspaceId: REFINE_WORKSPACE_ID,
    candidateRevisionId: previous,
    mode: "rewrite",
    feedbackReasonCodes: ["too_shallow"],
  });
  const job = await claimSimplifiedJob(refineRunId, { jobType: "card_candidate_refine_v3" });
  const { processV2OutboxJob } = await import("../handlers/card-generation-v2-handler.ts");
  await processV2OutboxJob(job);
  await assertJobCompleted(job.id);

  const superseded = await candidateRevisionReadout(refineRunId, previous);
  assert.equal(superseded?.publish_state, "superseded",
    "旧修订不可变但要让路——还挂着 unpublished 就是审核台上摆出两张同目标的卡");
  const rows = await admin`
    SELECT candidate_revision_id, revision, publish_state, quality_state
    FROM card_generation_candidates_v2
    WHERE run_id = ${refineRunId} AND candidate_id = ${beforeReadout.candidate_id}
    ORDER BY revision DESC LIMIT 2
  ` as unknown as Array<{ candidate_revision_id: string; revision: number;
    publish_state: string; quality_state: string }>;
  assert.equal(Number(rows[0]?.revision), Number(beforeReadout.revision) + 1,
    "重生成必须落在**下一条修订**上，同一条 candidate_id");
  assert.equal(rows[0]?.publish_state, "unpublished");
  const rewritten = await eventPayload(refineRunId, "card_candidate.rewritten");
  assert.equal(rewritten.reason, "user_feedback",
    "事件要分得清这次改写是用户点的还是检查判的——归错了，成本就记不到人头上");
  const completed = await eventPayload(refineRunId, "card_generation.simplified_completed");
  assert.equal(Number(completed.modelCalls), 2,
    "改写一发＋检查一发；少记就是这一发没真发出去");
  refineSubjectRevisionId = String(rows[0].candidate_revision_id);
});

test("整批重排那一档：同一 run 再开一版计划，上一版没激活的候选让路", async () => {
  const planBefore = await admin`
    SELECT current_plan_version FROM card_generation_runs_v2 WHERE id = ${refineRunId} LIMIT 1
  ` as unknown as Array<{ current_plan_version: number }>;
  const previousVersion = Number(planBefore[0]?.current_plan_version);
  const stillUnpublishedBefore = await admin`
    SELECT count(*)::int AS n FROM card_generation_candidates_v2
    WHERE run_id = ${refineRunId} AND publish_state = 'unpublished'
  ` as unknown as Array<{ n: number }>;
  assert.ok(Number(stillUnpublishedBefore[0]?.n) > 0, "重排前得有没激活的候选，否则\"让路\"判据是空集");

  await admin`
    INSERT INTO card_generation_run_outbox_v2 (id, workspace_id, run_id, job_type, payload, status)
    VALUES (${randomUUID()}, ${REFINE_WORKSPACE_ID}, ${refineRunId}, 'card_generation_simplified_v1',
      ${admin.json({ runId: refineRunId, workspaceId: REFINE_WORKSPACE_ID, mode: "replan" })}, 'pending')
  `;
  const job = await claimSimplifiedJob(refineRunId);
  const { processV2OutboxJob } = await import("../handlers/card-generation-v2-handler.ts");
  await processV2OutboxJob(job);
  await assertJobCompleted(job.id);

  const planAfter = await admin`
    SELECT current_plan_version FROM card_generation_runs_v2 WHERE id = ${refineRunId} LIMIT 1
  ` as unknown as Array<{ current_plan_version: number }>;
  assert.equal(Number(planAfter[0]?.current_plan_version), previousVersion + 1,
    "重排要开新一版计划；版本号不动就是它接上了上一版（那是\"换一批\"最坏的失败形状）");
  const leftovers = await admin`
    SELECT count(*)::int AS n FROM card_generation_candidates_v2
    WHERE run_id = ${refineRunId} AND plan_version < ${previousVersion + 1}
      AND publish_state = 'unpublished'
  ` as unknown as Array<{ n: number }>;
  assert.equal(Number(leftovers[0]?.n), 0,
    "上一版没激活的候选必须全部 superseded——留着就是审核台同时摆出两批");
  const freshOnStage = await admin`
    SELECT count(*)::int AS n FROM card_generation_candidates_v2
    WHERE run_id = ${refineRunId} AND plan_version = ${previousVersion + 1}
  ` as unknown as Array<{ n: number }>;
  assert.ok(Number(freshOnStage[0]?.n) > 0, "这一版要有新候选落在台上");
  assert.equal(await runStatus(refineRunId), "review_ready");
});

// 与"零候选是正常结果"那格成一对：那一格判的是**抽不出原子**（provider 自己交回
// no_cards_recommended 并带冻结理由码）；这一格判的是**抽得出、也交了草稿，却被内容
// 门禁全数挡下**。以前这一支收口时递的是空数组，库里只剩"这篇没出卡"，
// 而 `gateRejected` 里明明写着是哪两道门挡的——原因拿在手里被丢掉。
test("每句都被内容门禁挡下的那一发：终态要带得上那两道门的名字", async () => {
  const job = await claimSimplifiedJob(allGatedRunId);
  const { processV2OutboxJob } = await import("../handlers/card-generation-v2-handler.ts");
  await processV2OutboxJob(job);

  assert.equal(await runStatus(allGatedRunId), "no_cards_recommended",
    "全被挡下也是正常收口，不许打成 needs_attention 让用户以为系统坏了");
  const candidates = await admin`
    SELECT count(*)::int AS n FROM card_generation_candidates_v2 WHERE run_id = ${allGatedRunId}
  ` as unknown as Array<{ n: number }>;
  assert.equal(Number(candidates[0]?.n), 0, "被挡下的草稿不许落库成候选");

  // 正向对照：这一篇抽得出两个原子、两道门各点名一次——少了下面这两句，
  // "终态带原因"那条判据可以被"根本没出题"混过去。
  const committed = await eventPayload(allGatedRunId, "card_generation.simplified_plan_committed");
  assert.equal(Number(committed.atomCount), 2, "这一篇抽得出两个原子");
  const rejected = committed.gateRejected as unknown[] | undefined;
  assert.ok(Array.isArray(rejected) && rejected.length === 2,
    `两道门要各点名一次（拿到 ${JSON.stringify(committed.gateRejected)}）`);

  const payload = await eventPayload(allGatedRunId, "card_generation.no_cards_recommended");
  const reasons = (payload.reasonCodes as string[]) ?? [];
  // 这一格在整网里红过（单跑绿）：红的时候光说"拿不到 []"没法定位是哪一支收的口，
  // 所以把计划的形状一起报出来——`no_cards_recommended`（压根没出题）与
  // `author_candidates`（出了题又被挡）走的是两条不同的收口。
  const planShape = await admin`
    SELECT result ->> 'kind' AS kind, result -> 'reasonCodes' AS provider_reasons
    FROM card_generation_plans_v2 WHERE run_id = ${allGatedRunId}
    ORDER BY plan_version DESC LIMIT 1
  ` as unknown as Array<{ kind: string; provider_reasons: string[] }>;
  const diagnosis = `plan=${JSON.stringify(planShape[0] ?? null)} `
    + `atomCount=${String(committed.atomCount)} 门点名=${JSON.stringify(committed.gateRejected)}`;
  assert.ok(reasons.includes("front_leaks_answer"),
    `终态要带得上门码 front_leaks_answer（拿到 ${JSON.stringify(reasons)}；${diagnosis}）`);
  assert.ok(reasons.includes("cue_is_claim_copy"),
    `终态要带得上门码 cue_is_claim_copy（拿到 ${JSON.stringify(reasons)}；${diagnosis}）`);
});
