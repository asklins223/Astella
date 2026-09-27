/**
 * 争议与更真的数据面集成测试（39d W5-5；39 §14.2、§16.11、§16.22、§16.25）。
 *
 * 这份钉的是**只有真库才验得出的那几件事**——服务层单测和 shared 判据单测都替不了：
 *  1. **一个判定至多一份争议**（0296 的无条件唯一索引）。刻意用"已结束"的那一条再撞一次：
 *     写成 `WHERE closed_at IS NULL` 的话第二次能插进去，而 §16.22 的出口是
 *     "结束并暂不安排"、不是"再开一轮"。绕过服务层裸插 23505 才是索引真的在。
 *  2. **复核至多一次**（`recheck_count <= 1`）。服务层已经挡住第二次，这里量的是
 *     绕过服务层的写路径也被挡下——只留判据时一次重试就能多跑一轮模型。
 *  3. **更正只追加、不改原判**：写完一条更正之后，`learning_assessments.rubric_results`
 *     必须**一字未动**（§14.2「不重写历史原回答」），且同一次争议写第二条更正被唯一索引挡下。
 *  4. **§16.25 两档不混算**：`user_supplement` 必挂一次新作答、`system_misjudgment`
 *     必不挂——由 `assessment_corrections_v2_supplement_shape_chk` 在库里挡，
 *     两种错法都撞 23514。
 *  5. **§14.4 个人数据**：受限角色下换个 user 读，读得到东西才是"没读到他"的前提；
 *     另一个工作区同样零行。
 *  6. **结束并暂不安排**真的落到 0295 那张排除表上，并连带撤下此刻排着的那一条待办。
 *
 * 环境口径与调度边界族一致：夹具写走 `DATABASE_URL_MIGRATOR`（超户），
 * 被测路径经 `withWorkspaceTransaction` 跑在 `DATABASE_URL_API`（受限角色）上。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const fixtureUrl = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!fixtureUrl || !process.env.DATABASE_URL_API) {
  throw new Error("争议集测需要 DATABASE_URL_MIGRATOR（夹具）＋DATABASE_URL_API（受限角色）");
}
const fixtureSql = postgres(fixtureUrl, { max: 4 });
const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const disputes = await import("../modules/learning-runs/run-disputes.ts");
// 刻意**不** import 那几张表的 drizzle 定义：这份的读侧全部走裸 SQL，
// 这样"库上真的挡下了"是读出来的，不是被同一份 schema 定义复述一遍。
// 被测路径（withWorkspaceTransaction + run-disputes）才是走生产代码的那一段。

const USER_ID = randomUUID();
const OTHER_USER_ID = randomUUID();
const WORKSPACE_A = randomUUID();
const WORKSPACE_B = randomUUID();
const NOTE_ID = randomUUID();
const OBJECTIVE_ID = randomUUID();
/** 手动来源的目标：没有 `origin_kind='note'` 的绑定，所以"暂不安排"挂不上笔记。 */
const UNBOUND_OBJECTIVE_ID = randomUUID();
const REASON_CODE = "demonstrated";
const at = new Date("2026-09-27T09:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const ctxA = { workspaceId: WORKSPACE_A, userId: USER_ID };
const ctxOtherUser = { workspaceId: WORKSPACE_A, userId: OTHER_USER_ID };
const ctxOtherWorkspace = { workspaceId: WORKSPACE_B, userId: USER_ID };

/** 一个 run + 一件 locked artifact + 一次 assessment，够开一份争议。 */
let runId = "";
let artifactId = "";
let assessmentId = "";
/** 补答那一档要挂的"用户后来补的那次作答"（另一件 artifact）。 */
let supplementArtifactId = "";
/** 每次开争议要换一个新的判定，否则会撞 0296 那个无条件唯一索引。 */
let seq = 0;

async function seedOneAssessment(
  objectiveId: string = OBJECTIVE_ID,
): Promise<{ assessmentId: string; artifactId: string }> {
  const assessment = randomUUID();
  const artifact = randomUUID();
  const task = randomUUID();
  const variant = randomUUID();
  const run = randomUUID();
  await fixtureSql`INSERT INTO learning_runs
      (id, workspace_id, user_id, origin, return_target, goal, phase)
    VALUES (${run}, ${WORKSPACE_A}, ${USER_ID},
      ${fixtureSql.json({ kind: "card", objectiveId })}
      ${fixtureSql.json({ kind: "note", noteId: NOTE_ID })}, 'repair', 'completed')`;
  await fixtureSql`INSERT INTO learning_tasks (id, run_id, workspace_id, user_id, ordinal, intent)
    VALUES (${task}, ${run}, ${WORKSPACE_A}, ${USER_ID}, 1, 'explain')`;
  await fixtureSql`INSERT INTO learning_task_variants
      (id, task_id, run_id, workspace_id, user_id, revision, prompt, input_schema)
    VALUES (${variant}, ${task}, ${run}, ${WORKSPACE_A}, ${USER_ID}, 1, '为什么加索引仍然可能慢？',
      ${fixtureSql.json({ type: "object" })})`;
  await fixtureSql`INSERT INTO learning_artifacts
      (id, run_id, task_id, variant_id, workspace_id, user_id, revision, payload, payload_hash,
       public_payload_hash, input_schema_hash, private_solution_hash, safety_report_hash,
       disclosure_profile_hash, assistance_snapshot_hash, status, locked_at)
    VALUES (${artifact}, ${run}, ${task}, ${variant}, ${WORKSPACE_A}, ${USER_ID}, 2,
      ${fixtureSql.json({ answer: "因为索引也要回表" })}, ${`ph-${artifact}`}, ${`pp-${artifact}`},
      ${`ish-${artifact}`}, ${`psh-${artifact}`}, ${`srh-${artifact}`}, ${`dph-${artifact}`},
      ${`ash-${artifact}`}, 'locked', ${at})`;
  await fixtureSql`INSERT INTO learning_assessments
      (id, run_id, task_id, artifact_id, workspace_id, user_id, source, status, rubric_results, report_hash)
    VALUES (${assessment}, ${run}, ${task}, ${artifact}, ${WORKSPACE_A}, ${USER_ID},
      'assessment_critic', 'completed',
      ${fixtureSql.json([{ unitId: "u1", passed: false }])}, ${`rh-${assessment}`})`;
  seq += 1;
  return { assessmentId: assessment, artifactId: artifact };
}

/** 开一份争议（走服务层），顺带把这一发需要的两个 id 记下来。 */
async function openDispute(
  ctx: { workspaceId: string; userId: string },
  kind: "misjudged" | "misunderstood" = "misjudged",
) {
  return withWorkspaceTransaction(ctx, (tx) => disputes.openAssessmentDisputeV2(tx, {
    ...ctx,
    assessmentId,
    kind,
    statement: "我第一次就写了回表那一步，不该判成没提到。",
    at,
  }));
}

before(async () => {
  await fixtureSql`INSERT INTO users (id, email, password_hash)
    VALUES (${USER_ID}, ${`dispute-${USER_ID}@example.invalid`}, 'unused')`;
  await fixtureSql`INSERT INTO users (id, email, password_hash)
    VALUES (${OTHER_USER_ID}, ${`dispute-other-${OTHER_USER_ID}@example.invalid`}, 'unused')`;
  for (const [workspaceId, userId] of [[WORKSPACE_A, USER_ID], [WORKSPACE_B, USER_ID]] as const) {
    await fixtureSql`INSERT INTO workspaces (id, owner_id, name)
      VALUES (${workspaceId}, ${userId}, ${`Dispute ${workspaceId.slice(0, 8)}`})`;
    await fixtureSql`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${userId}, 'owner')`;
  }
  await fixtureSql`INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES (${WORKSPACE_A}, ${OTHER_USER_ID}, 'member')`;
  await fixtureSql`INSERT INTO notes (id, workspace_id, title, created_by)
    VALUES (${NOTE_ID}, ${WORKSPACE_A}, '争议那一篇', ${USER_ID})`;
  // 目标→笔记的绑定（"暂不安排"要靠它挂上真 notes 行）。
  await fixtureSql`INSERT INTO learning_objective_origins_v2
      (workspace_id, origin_id, objective_id, objective_revision_id, origin_kind, note_id, integrity)
    VALUES (${WORKSPACE_A}, ${randomUUID()}, ${OBJECTIVE_ID}, ${randomUUID()}, 'note', ${NOTE_ID}, 'verified')`;

  const first = await seedOneAssessment();
  runId = (await fixtureSql`SELECT run_id FROM learning_assessments WHERE id = ${first.assessmentId}`)[0].run_id;
  artifactId = first.artifactId;
  assessmentId = first.assessmentId;

  // 补答那一档要挂的"用户后来补的那次作答"：同一 run 下第二件 artifact。
  supplementArtifactId = randomUUID();
  const [task] = await fixtureSql`SELECT id FROM learning_tasks WHERE run_id = ${runId}`;
  const [variant] = await fixtureSql`SELECT id FROM learning_task_variants WHERE run_id = ${runId}`;
  await fixtureSql`INSERT INTO learning_artifacts
      (id, run_id, task_id, variant_id, workspace_id, user_id, revision, payload, payload_hash,
       public_payload_hash, input_schema_hash, private_solution_hash, safety_report_hash,
       disclosure_profile_hash, assistance_snapshot_hash, status, locked_at)
    VALUES (${supplementArtifactId}, ${runId}, ${task.id}, ${variant.id}, ${WORKSPACE_A}, ${USER_ID}, 3,
      ${fixtureSql.json({ answer: "补充：小表时可能改走顺序扫描" })}, ${`ph-${supplementArtifactId}`},
      ${`pp-${supplementArtifactId}`}, ${`ish-${supplementArtifactId}`}, ${`psh-${supplementArtifactId}`},
      ${`srh-${supplementArtifactId}`}, ${`dph-${supplementArtifactId}`}, ${`ash-${supplementArtifactId}`},
      'locked', ${at})`;
});

after(async () => {
  // 顺序要紧：子表先删，否则 FK 自己撞 23503。
  await fixtureSql`DELETE FROM assessment_corrections_v2 WHERE user_id IN (${USER_ID}, ${OTHER_USER_ID})`;
  await fixtureSql`DELETE FROM assessment_disputes_v2 WHERE user_id IN (${USER_ID}, ${OTHER_USER_ID})`;
  await fixtureSql`DELETE FROM objective_review_holds_v2 WHERE user_id IN (${USER_ID}, ${OTHER_USER_ID})`;
  await fixtureSql`DELETE FROM review_schedules WHERE user_id IN (${USER_ID}, ${OTHER_USER_ID})`;
  await fixtureSql`DELETE FROM learning_objective_origins_v2 WHERE objective_id = ${OBJECTIVE_ID}`;
  await fixtureSql`DELETE FROM learning_runs WHERE user_id IN (${USER_ID}, ${OTHER_USER_ID})`;
  await fixtureSql`DELETE FROM notes WHERE id = ${NOTE_ID}`;
  for (const workspaceId of [WORKSPACE_A, WORKSPACE_B]) {
    await fixtureSql`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
    await fixtureSql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
  }
  await fixtureSql`DELETE FROM users WHERE id IN (${USER_ID}, ${OTHER_USER_ID})`;
  await fixtureSql.end({ timeout: 5 });
  await closeDatabase();
});

test("开争议时把原产物的版本与内容哈希冻结进争议行（§14.2 关联原产物和版本）", async () => {
  const { dispute, created } = await openDispute(ctxA);
  assert.equal(created, true);
  assert.equal(dispute.artifactId, artifactId);
  // 冻结的是"当时那一版"，不是 join 出来的现值。
  assert.equal(dispute.artifactRevision, 2);
  assert.equal(dispute.artifactPayloadHash, `ph-${artifactId}`);
  // 目标取自 run 的 origin；取不到时存 null 而不是猜一个。
  assert.equal(dispute.objectiveId, OBJECTIVE_ID);
  assert.equal(dispute.recheckCount, 0);
  assert.equal(dispute.recheckOutcome, null);
});

test("一个判定至多一份争议，且已结束的那一条也不能再开（§16.22 出口是收尾不是重开）", async () => {
  await assert.rejects(
    () => openDispute(ctxA),
    (error: unknown) => error instanceof disputes.AssessmentDisputeAlreadyOpenV2,
  );
  // 绕过服务层裸插：数据库当场拒（23505），索引是**无条件**的那一条。
  await assert.rejects(
    () => fixtureSql`INSERT INTO assessment_disputes_v2
      (workspace_id, user_id, assessment_id, artifact_id, artifact_revision, artifact_payload_hash,
       kind, statement)
      VALUES (${WORKSPACE_A}, ${USER_ID}, ${assessmentId}, ${artifactId}, 2, ${`ph-${artifactId}`},
        'misjudged', '再来一次')`,
    (error: unknown) => (error as { code?: string }).code === "23505",
  );
  // 收尾之后同样开不出来。
  await withWorkspaceTransaction(ctxA, (tx) => disputes.closeAssessmentDisputeV2(tx, {
    ...ctxA,
    assessmentId,
    holdObjective: false,
    at,
  }));
  await assert.rejects(
    () => openDispute(ctxA),
    (error: unknown) => error instanceof disputes.AssessmentDisputeAlreadyOpenV2,
  );
});

test("复核只发生一次，第二次被服务层与库各挡一次（§16.22）", async () => {
  const fresh = await seedOneAssessment();
  await openDisputeFor(fresh.assessmentId, ctxA);
  const first = await withWorkspaceTransaction(ctxA, (tx) => disputes.completeDisputeRecheckV2(tx, {
    ...ctxA,
    assessmentId: fresh.assessmentId,
    outcome: "upheld",
    reason: "对照原题与原回答：评分条件里没有回表那一步，维持。",
    reportHash: "recheck-hash-1",
    at,
  }));
  assert.equal(first.dispute.recheckCount, 1);
  assert.equal(first.dispute.status, "recheck_upheld");

  // 第二次：服务层按判据挡（给出可念的原因）。
  await assert.rejects(
    () => withWorkspaceTransaction(ctxA, (tx) => disputes.completeDisputeRecheckV2(tx, {
      ...ctxA,
      assessmentId: fresh.assessmentId,
      outcome: "corrected",
      reason: "换个说法再问一次",
      reportHash: "recheck-hash-2",
      at,
    })),
    (error: unknown) => error instanceof disputes.AssessmentDisputeRecheckExhaustedV2,
  );
  // 绕过服务层把计数推到 2：数据库当场拒（23514）。
  await assert.rejects(
    () => fixtureSql`UPDATE assessment_disputes_v2 SET recheck_count = 2
      WHERE assessment_id = ${fresh.assessmentId}`,
    (error: unknown) => (error as { code?: string }).code === "23514",
  );
});

test("更正只追加：原判一字未动，同一次争议写第二条更正被挡（§14.2 / §16.25）", async () => {
  const fresh = await seedOneAssessment();
  await openDisputeFor(fresh.assessmentId, ctxA);
  await withWorkspaceTransaction(ctxA, (tx) => disputes.completeDisputeRecheckV2(tx, {
    ...ctxA,
    assessmentId: fresh.assessmentId,
    outcome: "corrected",
    reason: "重新检查发现原回答本身已满足原评分条件。",
    reportHash: "recheck-hash-corrected",
    at,
  }));

  const before = await fixtureSql`SELECT rubric_results FROM learning_assessments WHERE id = ${fresh.assessmentId}`;
  const written = await withWorkspaceTransaction(ctxA, (tx) => disputes.recordAssessmentCorrectionV2(tx, {
    ...ctxA,
    assessmentId: fresh.assessmentId,
    kind: "system_misjudgment",
    reason: "原判把已经写出的那一步算成了未提及。",
    correctedRubricResults: [{ unitId: "u1", passed: true }],
    at,
  }));
  assert.equal(written.created, true);
  assert.equal(written.correction.supplementArtifactId, null, "系统误判这一档依据的仍是同一份原回答");

  // §14.2「不重写历史原回答」：原判那一行必须一字未动。
  const after = await fixtureSql`SELECT rubric_results FROM learning_assessments WHERE id = ${fresh.assessmentId}`;
  assert.deepEqual(after[0].rubric_results, before[0].rubric_results);
  // 但原判被**快照**进更正行，读侧才叠得出来。
  assert.deepEqual(written.correction.supersededRubricResults, before[0].rubric_results);

  // 同一次争议写第二条：服务层挡。
  await assert.rejects(
    () => withWorkspaceTransaction(ctxA, (tx) => disputes.recordAssessmentCorrectionV2(tx, {
      ...ctxA,
      assessmentId: fresh.assessmentId,
      kind: "system_misjudgment",
      reason: "再改一次",
      at,
    })),
    (error: unknown) => error instanceof disputes.AssessmentCorrectionAlreadyRecordedV2,
  );
  const count = await fixtureSql`SELECT count(*)::int AS n FROM assessment_corrections_v2
    WHERE dispute_id = ${written.correction.disputeId}`;
  assert.equal(count[0].n, 1, "重复消费同一次更正＝界面上两次表现");
});

test("§16.25 两档不混算：补答必挂新作答、系统误判必不挂（库里挡，23514）", async () => {
  const fresh = await seedOneAssessment();
  await openDisputeFor(fresh.assessmentId, ctxA);
  await withWorkspaceTransaction(ctxA, (tx) => disputes.completeDisputeRecheckV2(tx, {
    ...ctxA,
    assessmentId: fresh.assessmentId,
    outcome: "corrected",
    reason: "重新检查后确认。",
    reportHash: "recheck-hash-two-shapes",
    at,
  }));
  const disputeId = (await fixtureSql`SELECT id FROM assessment_disputes_v2
    WHERE assessment_id = ${fresh.assessmentId}`)[0].id;

  // 服务层：补答没指明补充后的那次作答 ⇒ 422 那一档。
  await assert.rejects(
    () => withWorkspaceTransaction(ctxA, (tx) => disputes.recordAssessmentCorrectionV2(tx, {
      ...ctxA,
      assessmentId: fresh.assessmentId,
      kind: "user_supplement",
      reason: "看到反馈后我补了一个条件。",
      at,
    })),
    (error: unknown) => error instanceof disputes.AssessmentCorrectionShapeV2,
  );
  // 绕过服务层写两档错法，数据库各挡一次。
  for (const [kind, supplement] of [
    ["user_supplement", null],
    ["system_misjudgment", supplementArtifactId],
  ] as const) {
    await assert.rejects(
      () => fixtureSql`INSERT INTO assessment_corrections_v2
        (workspace_id, user_id, dispute_id, assessment_id, kind, reason, supplement_artifact_id)
        VALUES (${WORKSPACE_A}, ${USER_ID}, ${disputeId}, ${fresh.assessmentId}, ${kind},
          '绕过服务层', ${supplement})`,
      (error: unknown) => (error as { code?: string }).code === "23514",
    );
  }
  // 合法那一档写得进去。
  const ok = await withWorkspaceTransaction(ctxA, (tx) => disputes.recordAssessmentCorrectionV2(tx, {
    ...ctxA,
    assessmentId: fresh.assessmentId,
    kind: "user_supplement",
    reason: "看到反馈后我补了一个条件；这是新的一次解释，第一次照旧。",
    supplementArtifactId,
    at,
  }));
  assert.equal(ok.correction.supplementArtifactId, supplementArtifactId);
});

test("更正只许应用一次，重放不重置应用时间（§9.6 不重复消费）", async () => {
  const fresh = await seedOneAssessment();
  await openDisputeFor(fresh.assessmentId, ctxA);
  await withWorkspaceTransaction(ctxA, (tx) => disputes.completeDisputeRecheckV2(tx, {
    ...ctxA,
    assessmentId: fresh.assessmentId,
    outcome: "corrected",
    reason: "重新检查后确认。",
    reportHash: "recheck-hash-apply",
    at,
  }));
  await withWorkspaceTransaction(ctxA, (tx) => disputes.recordAssessmentCorrectionV2(tx, {
    ...ctxA,
    assessmentId: fresh.assessmentId,
    kind: "system_misjudgment",
    reason: "纠正系统误判。",
    at,
  }));

  const later = new Date(at.getTime() + 2 * DAY);
  const first = await withWorkspaceTransaction(ctxA, (tx) => disputes.markCorrectionAppliedV2(tx, {
    ...ctxA,
    assessmentId: fresh.assessmentId,
    at: later,
  }));
  assert.equal(first.alreadyApplied, false);
  assert.equal(first.scheduleImpactHint, "reschedule_via_boundary");

  const replay = await withWorkspaceTransaction(ctxA, (tx) => disputes.markCorrectionAppliedV2(tx, {
    ...ctxA,
    assessmentId: fresh.assessmentId,
    at: new Date(at.getTime() + 5 * DAY),
  }));
  assert.equal(replay.alreadyApplied, true);
  const [row] = await fixtureSql`SELECT applied_at FROM assessment_corrections_v2
    WHERE assessment_id = ${fresh.assessmentId}`;
  assert.equal(row.applied_at.toISOString(), later.toISOString(), "重放不重置应用时间");
});

test("结束并暂不安排真的落到 0295 那张排除表，并撤下此刻排着的待办（§14.2 / §9.1）", async () => {
  const fresh = await seedOneAssessment();
  await openDisputeFor(fresh.assessmentId, ctxA);
  // 先排一条待办，让"点下去要看得见的后果"有东西可撤。
  await fixtureSql`INSERT INTO review_schedules
      (workspace_id, user_id, subject_type, subject_id, status, next_review_at, interval_days,
       generation, policy_version, reason_code, review_dimension)
    VALUES (${WORKSPACE_A}, ${USER_ID}, 'card', ${OBJECTIVE_ID}, 'pending', ${new Date(at.getTime() + DAY)},
      1, 1, 'discrete-v2', ${REASON_CODE}, '')`;

  const outcome = await withWorkspaceTransaction(ctxA, (tx) => disputes.closeAssessmentDisputeV2(tx, {
    ...ctxA,
    assessmentId: fresh.assessmentId,
    holdObjective: true,
    note: "先放着，我不想再被问这一条。",
    at,
  }));
  assert.equal(outcome.outcome, "hold_objective");
  assert.equal(outcome.dismissedPendingSchedules, 1, "不撤的话下一到期还会从队列里冒出来");

  const holds = await fixtureSql`SELECT objective_id, reason_code, released_at
    FROM objective_review_holds_v2 WHERE objective_id = ${OBJECTIVE_ID} AND released_at IS NULL`;
  assert.equal(holds.length, 1);
  assert.equal(holds[0].reason_code, "dispute_unresolved");
  const pending = await fixtureSql`SELECT count(*)::int AS n FROM review_schedules
    WHERE subject_id = ${OBJECTIVE_ID} AND status = 'pending'`;
  assert.equal(pending[0].n, 0);
});

test("排不出可挂笔记的目标：争议照样结束，但如实说「没能落排除」（不卡死、不假回执）", async () => {
  const fresh = await seedOneAssessment(UNBOUND_OBJECTIVE_ID);
  await openDisputeFor(fresh.assessmentId, ctxA);
  const outcome = await withWorkspaceTransaction(ctxA, (tx) => disputes.closeAssessmentDisputeV2(tx, {
    ...ctxA,
    assessmentId: fresh.assessmentId,
    holdObjective: true,
    at,
  }));
  // §14.2 的出口是"可结束"——让用户走不掉是更坏的失败，所以争议必须已结束。
  assert.equal(outcome.outcome, "hold_unavailable");
  assert.ok(outcome.dispute.closedAt, "争议必须真的结束了");
  // 但也不能显示成"已暂不安排"：库里一条排除都不该有。
  assert.equal(outcome.dismissedPendingSchedules, 0);
  const holds = await fixtureSql`SELECT count(*)::int AS n FROM objective_review_holds_v2
    WHERE objective_id = ${UNBOUND_OBJECTIVE_ID}`;
  assert.equal(holds[0].n, 0, "挂不上笔记时不能挂一篇猜出来的");
});

test("结算闸：争议未决时挡排期，复核「维持」后放行（§14.2 不持续放大结论）", async () => {
  const input = { workspaceId: WORKSPACE_A, userId: USER_ID, objectiveId: OBJECTIVE_ID };

  // 0. 没有争议 ⇒ 放行（正控制：下面几条"挡"才不是恒真）。
  assert.deepEqual(
    await withWorkspaceTransaction(ctxA, (tx) => disputes.scheduleBlockedByDisputeV2(tx, input)),
    { blocked: false },
  );

  // 1. 刚开、还没复核 ⇒ 挡。
  const fresh = await seedOneAssessment();
  await openDisputeFor(fresh.assessmentId, ctxA);
  assert.deepEqual(
    await withWorkspaceTransaction(ctxA, (tx) => disputes.scheduleBlockedByDisputeV2(tx, input)),
    { blocked: true, reasonCode: "assessment_disputed" },
  );

  // 2. 复核"仍无法判断" ⇒ 仍然挡。§14.2「判断仍不可靠时维持争议状态，
  //    不强行选一方作为事实」——没有结论就不该推进间隔。
  await withWorkspaceTransaction(ctxA, (tx) => disputes.completeDisputeRecheckV2(tx, {
    ...ctxA,
    assessmentId: fresh.assessmentId,
    outcome: "undetermined",
    reason: "仍无法确定当时指的是哪一种，维持争议。",
    reportHash: "recheck-hash-gate",
    at,
  }));
  assert.equal(
    (await withWorkspaceTransaction(ctxA, (tx) => disputes.scheduleBlockedByDisputeV2(tx, input))).blocked,
    true,
  );

  // 3. 结束争议并暂不安排 ⇒ 排除接管，这道闸交回放行。
  //    （暂不安排是 0295 排除表在管，§9.1 规则表行 2；这一档不是本闸的职责。）
  await withWorkspaceTransaction(ctxA, (tx) => disputes.closeAssessmentDisputeV2(tx, {
    ...ctxA,
    assessmentId: fresh.assessmentId,
    holdObjective: true,
    at,
  }));
  assert.deepEqual(
    await withWorkspaceTransaction(ctxA, (tx) => disputes.scheduleBlockedByDisputeV2(tx, input)),
    { blocked: false },
  );

  // 4. 另一份争议被复核「维持」⇒ 放行。冻着不放就成了 §16.22 那条
  //    "反复要求用户接受同一判定"。
  const upheld = await seedOneAssessment();
  await openDisputeFor(upheld.assessmentId, ctxA);
  await withWorkspaceTransaction(ctxA, (tx) => disputes.completeDisputeRecheckV2(tx, {
    ...ctxA,
    assessmentId: upheld.assessmentId,
    outcome: "upheld",
    reason: "对照原题与原回答：评分条件成立，维持。",
    reportHash: "recheck-hash-upheld",
    at,
  }));
  assert.deepEqual(
    await withWorkspaceTransaction(ctxA, (tx) => disputes.scheduleBlockedByDisputeV2(tx, input)),
    { blocked: false },
  );
});

test("争议是个人数据：换一个人、换一个工作区都读不到（§14.4）", async () => {
  // 正控制：本人读得到、且读得到更正行。"读得到东西"才让下面两条零行算数。
  const mine = await withWorkspaceTransaction(ctxA, (tx) => disputes.getAssessmentDisputeViewV2(tx, {
    ...ctxA,
    assessmentId,
  }));
  assert.ok(mine, "正控制：本人这一份要读得到");
  assert.equal(mine.version, 2);
  assert.equal(mine.artifactRevision, 2);

  const theirs = await withWorkspaceTransaction(ctxOtherUser, (tx) => disputes.getAssessmentDisputeViewV2(tx, {
    ...ctxOtherUser,
    assessmentId,
  }));
  assert.equal(theirs, null, "同一空间里的另一位成员读不到");

  const elsewhere = await withWorkspaceTransaction(ctxOtherWorkspace, (tx) => disputes.getAssessmentDisputeViewV2(tx, {
    ...ctxOtherWorkspace,
    assessmentId,
  }));
  assert.equal(elsewhere, null, "换一个工作区读不到");
});

test("读侧把理由与更正一起交回，界面能直接念（§14.2 展示理由）", async () => {
  const fresh = await seedOneAssessment();
  await openDisputeFor(fresh.assessmentId, ctxA, "misunderstood");
  await withWorkspaceTransaction(ctxA, (tx) => disputes.submitDisputeSupplementV2(tx, {
    ...ctxA,
    assessmentId: fresh.assessmentId,
    supplement: "我说的不是没有回表，是回表那一步被合并掉了。",
    at,
  }));
  await withWorkspaceTransaction(ctxA, (tx) => disputes.completeDisputeRecheckV2(tx, {
    ...ctxA,
    assessmentId: fresh.assessmentId,
    outcome: "undetermined",
    reason: "原题与原回答都读过了，仍无法确定当时指的是哪一种；维持争议，不强行选一方。",
    reportHash: "recheck-hash-undetermined",
    at,
  }));
  await withWorkspaceTransaction(ctxA, (tx) => disputes.recordAssessmentCorrectionV2(tx, {
    ...ctxA,
    assessmentId: fresh.assessmentId,
    kind: "user_supplement",
    reason: "我把当时的意思补写了一遍。",
    supplementArtifactId,
    at,
  }));

  const view = await withWorkspaceTransaction(ctxA, (tx) => disputes.getAssessmentDisputeViewV2(tx, {
    ...ctxA,
    assessmentId: fresh.assessmentId,
  }));
  assert.ok(view);
  assert.equal(view.status, "recheck_undetermined");
  assert.equal(view.recheckOutcome, "undetermined");
  assert.ok(view.recheckReason && view.recheckReason.length > 0, "没有理由的结论交不出来");
  assert.equal(view.corrections.length, 1);
  assert.equal(view.corrections[0].kind, "user_supplement");
  assert.equal(view.corrections[0].supplementArtifactId, supplementArtifactId);
  // 补充说明**不**重开复核：recheckCount 仍是一次。
  const [row] = await fixtureSql`SELECT recheck_count FROM assessment_disputes_v2
    WHERE assessment_id = ${fresh.assessmentId}`;
  assert.equal(row.recheck_count, 1);
});

/** 换一条判定开争议（每条判定只能有一份，无条件唯一）。 */
async function openDisputeFor(
  targetAssessmentId: string,
  ctx: { workspaceId: string; userId: string },
  kind: "misjudged" | "misunderstood" = "misjudged",
) {
  return withWorkspaceTransaction(ctx, (tx) => disputes.openAssessmentDisputeV2(tx, {
    ...ctx,
    assessmentId: targetAssessmentId,
    kind,
    statement: "我不同意这一次判定。",
    at,
  }));
}
