/**
 * 制卡简化链（V3）的 job 接线集测（39d W7-1 刀b）。真 Postgres、**零模型调用**。
 *
 * 这份文件要结掉的是 §16.28 那三条判据里"只在库里看得见"的部分：
 *
 * 1. **入口总控是真的**——不设 `CARD_GENERATION_CHAIN` 时投的仍是旧 jobType（完全回到
 *    改前行为），设成 `simplified_v3` 才投 `card_generation_simplified_v1`；
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

const ADMIN_URL = testDatabaseUrl("DATABASE_URL_MIGRATOR");
process.env.DATABASE_URL_WORKER ??= testDatabaseUrl("DATABASE_URL_WORKER");
process.env.DATABASE_URL_API ??= ADMIN_URL;
delete process.env.CARD_GENERATION_V2_LLM;

const admin = postgres(ADMIN_URL, { max: 2 });

const WORKSPACE_ID = randomUUID();
const USER_ID = randomUUID();
const OTHER_USER_ID = randomUUID();
const OTHER_WORKSPACE_ID = randomUUID();

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
let otherUserRunTarget = "";
let rewriteRunId = "";

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
 * 认领本 run 的简化链 job（退回 pending 与认领写在同一事务里，见集测先例的说明）。
 *
 * `replay: true` 是给"第一遍死在段 4"那一发用的：生产的做法是回收器发现租约过期
 * （`reapStaleV2OutboxJobs`：attempts+1 → 退避 → 回 pending），测试直接造成这个结果。
 * 只有这份夹具自己持有那条租约（一次性库、没有第二个 poller），所以敢覆盖它。
 */
async function claimSimplifiedJob(runId: string, options: { replay?: boolean } = {}) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const leaseToken = randomUUID();
    const claimed = await admin.begin(async (tx) => {
      const states = await tx`
        SELECT status FROM card_generation_run_outbox_v2
        WHERE run_id = ${runId} AND job_type = 'card_generation_simplified_v1' FOR UPDATE
      ` as unknown as Array<{ status: string }>;
      if (states[0]?.status === "processing" && !options.replay) return null;
      await tx`
        UPDATE card_generation_run_outbox_v2
        SET status = 'pending', lease_token = NULL, lease_expires_at = NULL,
            started_at = NULL, processed_at = NULL, next_attempt_at = NULL
        WHERE run_id = ${runId} AND job_type = 'card_generation_simplified_v1'
      `;
      const rows = await tx`
        UPDATE card_generation_run_outbox_v2
        SET status = 'processing', started_at = now(),
            lease_expires_at = now() + interval '30 minutes', lease_token = ${leaseToken}
        WHERE run_id = ${runId} AND job_type = 'card_generation_simplified_v1' AND status = 'pending'
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
    for (const id of [USER_ID, OTHER_USER_ID]) {
      await tx`INSERT INTO users (id, email, password_hash)
        VALUES (${id}, ${`cardgen-v3-${id}@example.invalid`}, 'unused')
        ON CONFLICT (id) DO NOTHING`;
    }
    await tx`INSERT INTO workspaces (id, owner_id, name)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'Card Gen V3 IT') ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces (id, owner_id, name)
      VALUES (${OTHER_WORKSPACE_ID}, ${OTHER_USER_ID}, 'Card Gen V3 Other IT') ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${OTHER_WORKSPACE_ID}, ${OTHER_USER_ID}, 'owner') ON CONFLICT DO NOTHING`;
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

  // 入口对照：不设总控 ⇒ 仍投旧 jobType。
  controlRunId = (await createRun(notes.control.versionId, `v3-control-${randomUUID()}`)).runId;

  // 打开总控 ⇒ 三条简化链的 run。
  process.env.CARD_GENERATION_CHAIN = "simplified_v3";
  simplifiedRunId = (await createRun(notes.learnable.versionId, `v3-main-${randomUUID()}`)).runId;
  zeroCandidateRunId = (await createRun(notes.unlearnable.versionId, `v3-zero-${randomUUID()}`)).runId;
  otherUserRunTarget = (await createRun(notes.other.versionId, `v3-other-${randomUUID()}`,
    { workspaceId: OTHER_WORKSPACE_ID, userId: OTHER_USER_ID })).runId;
  rewriteRunId = (await createRun(notes.rewrite.versionId, `v3-rewrite-${randomUUID()}`,
    { workspaceId: OTHER_WORKSPACE_ID, userId: OTHER_USER_ID })).runId;
});

after(async () => {
  if (process.env.V3_KEEP_FIXTURES === "1") {
    console.log("[keep-fixtures] 跳过清理：这一次是给排查用的，跑完请重跑 disposable 脚本回到干净状态");
    await admin.end({ timeout: 5 });
    return;
  }
  const wipe = async (table: string) => {
    for (const workspaceId of [WORKSPACE_ID, OTHER_WORKSPACE_ID]) {
      await admin.unsafe(`DELETE FROM ${table} WHERE workspace_id = '${workspaceId}'`).catch(() => undefined);
    }
  };
  for (const table of [
    "card_generation_run_progress_v2",
    "card_generation_events_v2",
    "card_candidate_quality_reports_v2",
    "candidate_evidence_binding_plans_v2",
    "card_generation_candidates_v2",
    "card_generation_run_outbox_v2",
    "card_generation_plans_v2",
    "card_generation_runs_v2",
  ]) {
    await wipe(table);
  }
  await admin`DELETE FROM evidence_snapshots_v2 WHERE workspace_id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM source_snapshots_v2 WHERE workspace_id = ${WORKSPACE_ID}`.catch(() => undefined);
  for (const note of Object.values(notes)) {
    if (!note) continue;
    await admin`DELETE FROM note_blocks WHERE version_id = ${note.versionId}`.catch(() => undefined);
    await admin`DELETE FROM note_versions WHERE id = ${note.versionId}`.catch(() => undefined);
    await admin`DELETE FROM notes WHERE id = ${note.noteId}`.catch(() => undefined);
  }
  await admin`DELETE FROM workspace_members WHERE workspace_id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM workspaces WHERE id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM workspace_members WHERE workspace_id = ${OTHER_WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM workspaces WHERE id = ${OTHER_WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM users WHERE id = ${USER_ID}`.catch(() => undefined);
  await admin`DELETE FROM users WHERE id = ${OTHER_USER_ID}`.catch(() => undefined);
  await admin.end({ timeout: 5 });
  const { closeDatabase: closeWorkerDatabase } = await import("../db.ts");
  await closeWorkerDatabase().catch(() => undefined);
  const { closeDatabase } = await import("../../../../apps/api/src/db/client.ts");
  await closeDatabase().catch(() => undefined);
});

test("入口总控：不设开关仍走旧链，设了才投简化链的 jobType", async () => {
  assert.equal(await outboxJobType(controlRunId), "card_generation_plan",
    "默认档必须完全回到改前行为");
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
  const { runDeterministicGroundingContract } = await import(
    "@ailearn/shared/card-generation-v2-pipeline"
  );

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
        const grounding = await runDeterministicGroundingContract(
          entry.candidate as never, typed.evidenceManifest,
        );
        // 第一遍的第 1 张判"需要改写"，其余（含重检那一遍的所有张）判可保留。
        const wantsRewrite = checkCallsWith.length === 1 && index === 0;
        perCandidate.push({
          objectiveLocalId: entry.objectiveLocalId,
          verdict: wantsRewrite ? "rewrite" : "keep",
          issues: wantsRewrite
            ? [{ code: "front_leaks_answer", severity: "soft", detail: "题面太直，改写成需要回想" }]
            : [],
          grounding,
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
