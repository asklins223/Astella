/**
 * 争议的**系统侧重新检查**在真库上的判据（39d W5-5；39 §8.6、§8.7、§14.2、§16.22、§16.25）。
 *
 * 这份钉的是**只有真库才验得出**的那几件：
 *
 *  1. **一次复核真的发生**：开争议之后跑 `runDisputeRecheckV2`，`assessment_disputes_v2`
 *     上 `recheck_count=1`、`recheck_outcome`／`recheck_reason`／`recheck_report_hash`
 *     三格齐（0296 的 `rechecked_has_outcome_chk` 要求它们同时在），状态从 `open` 推进。
 *  2. **模型调用时没有活动事务**（§8.7）。夹具在假 requester 里当场读一次
 *     `currentApiWorkspaceTransaction()`——不是事后推断，是**调用那一刻**的读数。
 *  3. **§8.6 角色隔离在真实请求体上成立**：发给模型的 prompt 里带着原题、原回答与依据，
 *     但**没有**原判的逐条理由（夹具给原判写了一句独一无二的 `userFacingReason`，
 *     它出现在请求体里就是漏了）。
 *  4. **「修正」那档以只追加的更正记录表达**（§14.2／§16.25）：`corrected` 落库的同时
 *     写一条 `system_misjudgment` 更正，且 `learning_assessments.rubric_results`
 *     **一字未动**、原判被快照进 `superseded_rubric_results`。
 *  5. **§16.22 不形成死循环**：第二次跑**不再发模型请求**（请求次数仍为 1），且判据
 *     给出的是"已经复核过"而不是 no-op。
 *  6. **模型/provider 失败不伪造结论**：两次都 500 ⇒ 争议仍然是 `open`、`recheck_count=0`，
 *     用户的出口（结束并暂不安排）仍然在。
 *  7. **更正只被消费一次**（§9.6）：`disputeScheduleResolutionV2` 先交回"该消费哪一条"，
 *     `markCorrectionAppliedV2` 消费之后同一目标上再问一次就是"已消费过"⇒ 挡住。
 *
 * 环境口径与同族一致：夹具写走 `DATABASE_URL_MIGRATOR`（超户），被测路径经
 * `withWorkspaceTransaction` 跑在 `DATABASE_URL_API`（受限角色）上。**每次换库名**。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { hashCanonicalV2 } from "@ailearn/shared/hash-canonical-v2";
import { assessmentDisputeViewV2Schema } from "@ailearn/shared/assessment-dispute-rules-v2";
import { ExternalCallInsideTransactionError } from "@ailearn/shared/workspace-transaction";
import { createLearningRunForTest, seedV2Fixture } from "./helpers/v2-card-fixture.ts";

const fixtureUrl = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!fixtureUrl || !process.env.DATABASE_URL_API) {
  throw new Error("争议复核集测需要 DATABASE_URL_MIGRATOR（夹具）＋DATABASE_URL_API（受限角色）");
}
const fixtureSql = postgres(fixtureUrl, { max: 4 });
const { currentApiWorkspaceTransaction, withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const disputes = await import("../modules/learning-runs/run-disputes.ts");
const recheck = await import("../modules/learning-runs/dispute-recheck.ts");

/** `seedV2Fixture` 那份默认 rubric 只有一个单元，全文都靠它。 */
const RUBRIC_UNIT_ID = "fixture-rubric-u1";
const BLOCK_CONTENT = "复利效应是本金产生利息后加入本金继续生息的现象";
/**
 * 原判那条 `verdict` 的**独一无二**指纹。
 *
 * 为什么不用 `covered`／`missing` 这类合法取值去查：那两个词**本来就要**出现在提示里
 * （判定规则与输出合同要枚举它们），那种断言要么恒红要么恒绿，两种都不量东西。
 * `rubric_results` 是 jsonb、库上没有取值 CHECK，而复核的定档只比"变了没有"，
 * 所以给一个不可能来自 critic 枚举的取值完全合法——它出现，就说明原判被塞进了请求体。
 *
 * （第一版这里查的是原判那句 `userFacingReason`，**它是查不到任何东西的**：
 * `gatherDisputeRecheckFactsV2` 只把 `rubricItemId`／`verdict` 两列读进 facts，
 * `userFacingReason` 压根没进过这条路径。变异实测把它改成"把原判插进提示词"，
 * 这一份仍然全绿——一条永远不可能红的断言比没有断言更坏。）
 */
const ORIGINAL_VERDICT_MARKER = "ORIGINAL-VERDICT-MARKER-9f2c";

/** 假 provider：记下每一次请求，答一个可编排的结果。 */
interface Captured {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: {
    model?: string;
    messages?: Array<{ role: string; content: string }>;
    response_format?: unknown;
  };
  /** 调用**那一刻**的活动事务读数（§8.7 的判据就在这里）。 */
  readonly activeTransaction: unknown;
}

function fakeProvider(script: Array<{ status: number; content: string }>) {
  const captured: Captured[] = [];
  let index = 0;
  const requester = async (
    url: string,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<{ status: number; statusText: string; body: unknown }> => {
    captured.push({
      url,
      headers,
      body: body as Captured["body"],
      activeTransaction: currentApiWorkspaceTransaction(),
    });
    const step = script[Math.min(index, script.length - 1)];
    index += 1;
    return {
      status: step.status,
      statusText: step.status === 200 ? "OK" : "Error",
      body: { choices: [{ message: { content: step.content } }] },
    };
  };
  return { captured, requester };
}

function recheckJson(outcome: string, verdicts: Array<[string, string]>): string {
  return JSON.stringify({
    outcome,
    reason: "对照原题与原回答之后得到这个结论。",
    verdicts: verdicts.map(([rubricItemId, verdict]) => ({ rubricItemId, verdict, unitReason: "这一条的依据。" })),
  });
}

/**
 * 造一份「已完成的判定 + 一份开了的争议」，外加那个目标的完整 V2 冻结闭包。
 *
 * run／task／variant／目标快照全部走**生产路径**（`createRunV2`），只有「一件锁定的
 * 原答案」与「那一行判定」是手插的——与同族那份争议集测同一取舍：要验的是复核
 * 生产者，不是提交路径（提交路径由 `learning-runs-postgres.integration.ts` 钉着）。
 */
async function seedDisputedAssessment(options: {
  readonly originalVerdicts: Array<{ rubricItemId: string; verdict: string }>;
  readonly answerText: string;
}) {
  const fixture = await seedV2Fixture(sql, {
    objectiveStatement: "说清复利效应里利息如何进入本金",
    publicSummary: "复利效应",
    front: { cue: "复利", prompt: "什么是复利效应？" },
  });
  await seedFrozenEvidence(fixture);

  const scope = { workspaceId: fixture.workspaceId, userId: fixture.userId };
  const run = await withWorkspaceTransaction(scope, (tx) => createLearningRunForTest(tx, {
    ...scope,
    request: {
      originV2: { kind: "card", cardId: fixture.cardId, objectiveId: fixture.objectiveId },
      goal: "stabilize",
      requestedTimeBudgetSeconds: 120,
      idempotencyKey: `dispute-recheck-${randomUUID()}`,
    },
  }));
  const activeTask = run.activeTask;
  assert.ok(activeTask, "正控制：这一轮要真的开出题");
  const taskId = activeTask.taskId;

  // 正控制：冻结闭包里有评分条件，且 variant 指的就是它。少了这一格下面全部是
  // `facts_unavailable`，而那也正是"静默跳过"要防的形状——所以先把它立起来。
  const variants = await fixtureSql`SELECT rubric_target_ids FROM learning_task_variants
    WHERE task_id = ${taskId}`;
  assert.deepEqual(variants[0].rubric_target_ids, [RUBRIC_UNIT_ID]);
  // 「原题」是**冻结的那一版题面**，不是夹具里随手写的字符串：出题是规划器写的
  // （`createRunV2` 内部），所以断言要对着库里那一行读出来的题面。
  const tasks = await fixtureSql`SELECT prompt FROM learning_tasks WHERE id = ${taskId}`;
  const taskPrompt = tasks[0].prompt as string;
  assert.ok(taskPrompt.length > 0);

  const artifactId = randomUUID();
  const assessmentId = randomUUID();
  const artifactPayload = { text: options.answerText };
  const payloadHash = `ph-${artifactId}`;
  await fixtureSql`INSERT INTO learning_artifacts
      (id, run_id, task_id, variant_id, workspace_id, user_id, revision, payload, payload_hash,
       public_payload_hash, input_schema_hash, private_solution_hash, safety_report_hash,
       disclosure_profile_hash, assistance_snapshot_hash, status, locked_at)
    VALUES (${artifactId}, ${run.runId}, ${taskId}, ${activeTask.activeVariant.variantId},
      ${fixture.workspaceId}, ${fixture.userId}, 1, ${fixtureSql.json(artifactPayload)}, ${payloadHash},
      'pp', 'ish', 'psh', 'srh', 'dph', 'ash', 'locked', ${new Date("2026-09-27T09:00:00.000Z")})`;
  const rubricResults = options.originalVerdicts.map((v) => ({
    rubricItemId: v.rubricItemId,
    facet: "recall",
    verdict: v.verdict,
    userFacingReason: "原判当时给用户的说法。",
  }));
  await fixtureSql`INSERT INTO learning_assessments
      (id, run_id, task_id, artifact_id, workspace_id, user_id, source, status, rubric_results, report_hash)
    VALUES (${assessmentId}, ${run.runId}, ${taskId}, ${artifactId}, ${fixture.workspaceId},
      ${fixture.userId}, 'assessment_critic', 'completed', ${fixtureSql.json(rubricResults)},
      ${`rh-${assessmentId}`})`;

  const dispute = await withWorkspaceTransaction(scope, (tx) => disputes.openAssessmentDisputeV2(tx, {
    ...scope,
    assessmentId,
    kind: "misjudged",
    statement: "我第一次就写了那一步，不该判成没提到。",
    at: new Date("2026-09-27T09:00:00.000Z"),
  }));
  // §14.2「关联原产物和版本」：锚就是争议行上冻结的那两样。
  const anchor = await withWorkspaceTransaction(scope, (tx) => recheck.readDisputeRecheckAnchorV2(tx, {
    ...scope,
    assessmentId,
  }));
  assert.ok(anchor, "正控制：锚要读得到");
  assert.equal(anchor.allowed, true);
  return {
    ...fixture,
    scope,
    runId: run.runId,
    assessmentId,
    artifactId,
    payloadHash,
    rubricResults,
    taskPrompt,
    disputeId: dispute.dispute.id,
    objectiveId: dispute.dispute.objectiveId,
    anchor: anchor as NonNullable<typeof anchor>,
  };
}

/** 给 fixture 的目标补一份**完整的冻结证据**（形状抄自仍在绿的 `learning-runs-postgres.integration.ts`）。 */
async function seedFrozenEvidence(fixture: {
  workspaceId: string;
  userId: string;
  noteId: string;
  noteVersionId: string;
  objectiveRevisionId: string;
}): Promise<void> {
  const blockId = randomUUID();
  const evidenceSnapshotId = randomUUID();
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${fixture.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${fixture.userId}, true)`;
    await tx`INSERT INTO note_blocks (id, version_id, workspace_id, ordinal, type, content)
      VALUES (${blockId}, ${fixture.noteVersionId}, ${fixture.workspaceId}, 0, 'paragraph', ${BLOCK_CONTENT})`;
    await tx`INSERT INTO evidence_snapshots_v2
      (id, workspace_id, evidence_snapshot_id, evidence_snapshot_hash, source_snapshot_id,
       note_id, block_id, start_offset, end_offset, protected_quote_ref, quote_hash,
       block_content_hash, source_content_hash, modality)
      VALUES (gen_random_uuid(), ${fixture.workspaceId}, ${evidenceSnapshotId}, ${"b".repeat(64)},
              ${randomUUID()}, ${fixture.noteId}, ${blockId}, 0, ${BLOCK_CONTENT.length},
              ${`evidence://snapshot/${evidenceSnapshotId}`},
              ${hashCanonicalV2("evidence-quote", { quote: BLOCK_CONTENT })},
              ${hashCanonicalV2("block", { content: BLOCK_CONTENT })}, ${"f".repeat(64)}, 'text')`;
    await tx`INSERT INTO evidence_eligibility_states_v2
      (id, workspace_id, eligibility_id, evidence_snapshot_id, status, eligibility_epoch, eligibility_vector_hash)
      VALUES (gen_random_uuid(), ${fixture.workspaceId}, ${randomUUID()}, ${evidenceSnapshotId},
              'usable', 1, ${"a".repeat(64)})`;
    await tx`INSERT INTO learning_objective_evidence_bindings_v2
      (id, workspace_id, binding_id, objective_revision_id, target_unit_kind, target_unit_id,
       evidence_snapshot_id, relation, support_strength, semantic_support_report_id,
       semantic_support_report_hash, binding_hash)
      VALUES (gen_random_uuid(), ${fixture.workspaceId}, ${randomUUID()}, ${fixture.objectiveRevisionId},
              'rubric', ${RUBRIC_UNIT_ID}, ${evidenceSnapshotId}, 'entails', 'direct',
              ${randomUUID()}, ${"c".repeat(64)}, ${"d".repeat(64)})`;
  });
}

const sql = fixtureSql;

test("一次重新检查真的发生：逐条重判与原判一致 ⇒ 落成「维持」，理由与报告哈希都在", async (t) => {
  const seeded = await seedDisputedAssessment({
    originalVerdicts: [{ rubricItemId: RUBRIC_UNIT_ID, verdict: "covered" }],
    answerText: "因为利息会加入本金一起继续生息。",
  });
  t.after(() => seeded.cleanup());

  const provider = fakeProvider([{ status: 200, content: recheckJson("upheld", [[RUBRIC_UNIT_ID, "covered"]]) }]);
  const result = await recheck.runDisputeRecheckV2(
    { ...provider, currentActiveTransaction: currentApiWorkspaceTransaction, url: "https://example.invalid/v1", key: "k" },
    {
      ...seeded.scope,
      assessmentId: seeded.assessmentId,
      artifactId: seeded.anchor.artifactId,
      artifactPayloadHash: seeded.anchor.artifactPayloadHash,
    },
  );
  assert.equal(result.status, "committed");
  if (result.status !== "committed") return;
  assert.equal(result.outcome, "upheld");
  assert.equal(result.correctionId, null, "维持那一档没有可更正的东西");
  assert.match(result.reportHash, /^[0-9a-f]{64}$/);
  assert.ok(result.reason.length > 0, "§14.2 要展示理由：没有理由的结论交不出来");

  const rows = await fixtureSql`SELECT status, recheck_count, recheck_outcome, recheck_reason, recheck_report_hash
    FROM assessment_disputes_v2 WHERE id = ${seeded.disputeId}`;
  assert.equal(rows[0].recheck_count, 1);
  assert.equal(rows[0].status, "recheck_upheld");
  assert.equal(rows[0].recheck_outcome, "upheld");
  assert.equal(rows[0].recheck_reason, result.reason);
  assert.equal(rows[0].recheck_report_hash, result.reportHash);
  // 更正表零行：维持不是更正。
  const corrections = await fixtureSql`SELECT count(*)::int AS n FROM assessment_corrections_v2
    WHERE dispute_id = ${seeded.disputeId}`;
  assert.equal(corrections[0].n, 0);
});

test("模型调用那一刻没有活动事务，且请求体里有原题/原回答/依据、没有原判（§8.6／§8.7）", async (t) => {
  // 这一份的夹具把原判那条 verdict 换成**独一无二**的探针值：它一旦出现在请求体里，
  // 就是"原判被塞给了复核者"，而那正是 §8.6「不得把同一次生成的自评直接当成独立
  // 评估」要挡的形状。
  const seeded = await seedDisputedAssessment({
    originalVerdicts: [{ rubricItemId: RUBRIC_UNIT_ID, verdict: ORIGINAL_VERDICT_MARKER }],
    answerText: "因为利息会加入本金一起继续生息。",
  });
  t.after(() => seeded.cleanup());

  const provider = fakeProvider([{ status: 200, content: recheckJson("upheld", [[RUBRIC_UNIT_ID, "covered"]]) }]);
  const result = await recheck.runDisputeRecheckV2(
    { ...provider, currentActiveTransaction: currentApiWorkspaceTransaction, url: "https://example.invalid/v1", key: "k" },
    {
      ...seeded.scope,
      assessmentId: seeded.assessmentId,
      artifactId: seeded.anchor.artifactId,
      artifactPayloadHash: seeded.anchor.artifactPayloadHash,
    },
  );
  assert.equal(result.status, "committed");
  assert.equal(provider.captured.length, 1);
  const request = provider.captured[0];
  // §8.7：外部调用落在活动事务里会把并发读写一起钉住。内核会拒，而这里是**读数**。
  assert.equal(request.activeTransaction, undefined, "模型调用时挂着工作区事务");
  const prompt = request.body.messages?.[1]?.content ?? "";
  assert.ok(prompt.includes(seeded.taskPrompt), "原题缺席（冻结的那一版题面）");
  assert.ok(prompt.includes("因为利息会加入本金一起继续生息。"), "原回答缺席");
  assert.ok(prompt.includes(BLOCK_CONTENT), "依据缺席");
  // §8.6：原判那一列不得出现在请求体里（探针值 + 原判的 report_hash 两条）。
  assert.ok(
    !prompt.includes(ORIGINAL_VERDICT_MARKER),
    "复核的提示里带上了原判的逐条判定：那不是独立评估，是照着原判改写（§8.6）",
  );
  assert.ok(
    !prompt.includes(`rh-${seeded.assessmentId}`),
    "复核的提示里带上了原判的 report_hash：复核者能顺着它读回原判（§8.6）",
  );
  // 身份也是分开的（§8.6「分开的任务上下文」）。
  assert.equal(request.body.messages?.[0]?.role, "system");
  assert.match(request.body.messages?.[0]?.content ?? "", /复核者/);
});

test("「修正」那档：以带理由的新记录表达，原判一字未动（§14.2／§16.25）", async (t) => {
  const seeded = await seedDisputedAssessment({
    originalVerdicts: [{ rubricItemId: RUBRIC_UNIT_ID, verdict: "missing" }],
    answerText: "利息会加入本金一起继续生息。",
  });
  t.after(() => seeded.cleanup());

  const provider = fakeProvider([{ status: 200, content: recheckJson("corrected", [[RUBRIC_UNIT_ID, "covered"]]) }]);
  const result = await recheck.runDisputeRecheckV2(
    { ...provider, currentActiveTransaction: currentApiWorkspaceTransaction, url: "https://example.invalid/v1", key: "k" },
    {
      ...seeded.scope,
      assessmentId: seeded.assessmentId,
      artifactId: seeded.anchor.artifactId,
      artifactPayloadHash: seeded.anchor.artifactPayloadHash,
    },
  );
  assert.equal(result.status, "committed");
  if (result.status !== "committed") return;
  assert.equal(result.outcome, "corrected");
  assert.ok(result.correctionId, "§14.2 末段：判成修正就要有一条更正记录");

  // §14.2「不重写历史原回答」：原判那一行必须一字未动。
  const after = await fixtureSql`SELECT rubric_results FROM learning_assessments WHERE id = ${seeded.assessmentId}`;
  assert.deepEqual(after[0].rubric_results, seeded.rubricResults);
  // 但原判被快照进更正行，读侧要叠才叠得出来。
  const corrections = await fixtureSql`SELECT kind, reason, supplement_artifact_id,
      superseded_rubric_results, corrected_rubric_results, applied_at
    FROM assessment_corrections_v2 WHERE id = ${result.correctionId}`;
  assert.equal(corrections.length, 1);
  // §16.25：这一档的依据仍是**同一份原回答**，所以不许挂新作答产物。
  assert.equal(corrections[0].kind, "system_misjudgment");
  assert.equal(corrections[0].supplement_artifact_id, null);
  assert.equal(corrections[0].reason, result.reason, "更正必须带理由");
  assert.deepEqual(corrections[0].superseded_rubric_results, seeded.rubricResults);
  assert.equal(corrections[0].corrected_rubric_results[0].verdict, "covered");
  // 写记录 ≠ 消费记录（§9.6）：此刻还没有被应用过。
  assert.equal(corrections[0].applied_at, null);

  // 读侧能念出来：界面要能看到理由与那条更正。
  const view = await withWorkspaceTransaction(seeded.scope, (tx) => disputes.getAssessmentDisputeViewV2(tx, {
    ...seeded.scope,
    assessmentId: seeded.assessmentId,
  }));
  assert.ok(view);
  const parsed = assessmentDisputeViewV2Schema.safeParse(view);
  assert.equal(parsed.success, true, "读侧形状必须仍符合 wire 合同");
  assert.equal(view.status, "recheck_corrected");
  assert.equal(view.corrections.length, 1);
});

test("更正只被消费一次：先交回该消费哪一条，消费之后同一目标再问就是「已消费过」（§9.6）", async (t) => {
  const seeded = await seedDisputedAssessment({
    originalVerdicts: [{ rubricItemId: RUBRIC_UNIT_ID, verdict: "missing" }],
    answerText: "利息会加入本金一起继续生息。",
  });
  t.after(() => seeded.cleanup());
  const objectiveId = seeded.objectiveId;
  assert.ok(objectiveId, "正控制：这一次观察挂得上目标");

  const provider = fakeProvider([{ status: 200, content: recheckJson("corrected", [[RUBRIC_UNIT_ID, "covered"]]) }]);
  const recheckResult = await recheck.runDisputeRecheckV2(
    { ...provider, currentActiveTransaction: currentApiWorkspaceTransaction, url: "https://example.invalid/v1", key: "k" },
    {
      ...seeded.scope,
      assessmentId: seeded.assessmentId,
      artifactId: seeded.anchor.artifactId,
      artifactPayloadHash: seeded.anchor.artifactPayloadHash,
    },
  );
  assert.equal(recheckResult.status, "committed");

  // 结算那一发（`disputeAllowsScheduleChange`）问的就是这个读数。
  const before = await withWorkspaceTransaction(seeded.scope, (tx) => disputes.disputeScheduleResolutionV2(tx, {
    ...seeded.scope,
    objectiveId: objectiveId as string,
  }));
  assert.equal(before.blocked, false, "修正那一档要放行并交回该消费的那条");
  if (before.blocked) return;
  assert.equal(before.correctionToApply?.assessmentId, seeded.assessmentId);

  const applied = await withWorkspaceTransaction(seeded.scope, (tx) => disputes.markCorrectionAppliedV2(tx, {
    ...seeded.scope,
    assessmentId: seeded.assessmentId,
    at: new Date("2026-09-27T10:00:00.000Z"),
  }));
  assert.equal(applied.alreadyApplied, false);
  assert.equal(applied.scheduleImpactHint, "reschedule_via_boundary");

  // §9.6「不能重复消费同一日程」：消费过一次之后不再被交回去消费。
  const after = await withWorkspaceTransaction(seeded.scope, (tx) => disputes.disputeScheduleResolutionV2(tx, {
    ...seeded.scope,
    objectiveId: objectiveId as string,
  }));
  assert.equal(after.blocked, true, "消费过之后这一次观察不再被放大（§14.2）");
  if (!after.blocked) return;
  assert.equal(after.correctionToApply, null);

  // 重放消费不重置应用时间。
  const replay = await withWorkspaceTransaction(seeded.scope, (tx) => disputes.markCorrectionAppliedV2(tx, {
    ...seeded.scope,
    assessmentId: seeded.assessmentId,
    at: new Date("2026-09-27T12:00:00.000Z"),
  }));
  assert.equal(replay.alreadyApplied, true);
  const [row] = await fixtureSql`SELECT applied_at FROM assessment_corrections_v2
    WHERE dispute_id = ${seeded.disputeId}`;
  assert.equal(row.applied_at.toISOString(), new Date("2026-09-27T10:00:00.000Z").toISOString());
});

test("§16.22：第二次跑不再发模型请求——一次就够，不形成死循环", async (t) => {
  const seeded = await seedDisputedAssessment({
    originalVerdicts: [{ rubricItemId: RUBRIC_UNIT_ID, verdict: "covered" }],
    answerText: "因为利息会加入本金一起继续生息。",
  });
  t.after(() => seeded.cleanup());

  const provider = fakeProvider([{ status: 200, content: recheckJson("upheld", [[RUBRIC_UNIT_ID, "covered"]]) }]);
  const env = { ...provider, currentActiveTransaction: currentApiWorkspaceTransaction, url: "https://example.invalid/v1", key: "k" };
  const target = {
    ...seeded.scope,
    assessmentId: seeded.assessmentId,
    artifactId: seeded.anchor.artifactId,
    artifactPayloadHash: seeded.anchor.artifactPayloadHash,
  };
  assert.equal((await recheck.runDisputeRecheckV2(env, target)).status, "committed");
  assert.equal(provider.captured.length, 1);

  const second = await recheck.runDisputeRecheckV2(env, target);
  assert.equal(second.status, "skipped");
  if (second.status === "skipped") assert.equal(second.reasonCode, "recheck_not_allowed");
  // 判据挡在**花钱之前**：第二次一个请求都没发出去。
  assert.equal(provider.captured.length, 1, "第二次复核又发了一次模型请求（§16.22 的死循环入口）");
  // 争议项**没有**被自动重新入队、也没有被排期改动。
  const rows = await fixtureSql`SELECT recheck_count, status FROM assessment_disputes_v2 WHERE id = ${seeded.disputeId}`;
  assert.equal(rows[0].recheck_count, 1);
});

test("模型两次都失败：不伪造结论，争议保持未决且用户仍有出口（§14.2）", async (t) => {
  const seeded = await seedDisputedAssessment({
    originalVerdicts: [{ rubricItemId: RUBRIC_UNIT_ID, verdict: "covered" }],
    answerText: "因为利息会加入本金一起继续生息。",
  });
  t.after(() => seeded.cleanup());

  // 两次 500：内核会重试一次（瞬时状态码归可重试那一类），两次都失败才判 failed。
  const provider = fakeProvider([{ status: 503, content: "" }]);
  const result = await recheck.runDisputeRecheckV2(
    { ...provider, currentActiveTransaction: currentApiWorkspaceTransaction, url: "https://example.invalid/v1", key: "k" },
    {
      ...seeded.scope,
      assessmentId: seeded.assessmentId,
      artifactId: seeded.anchor.artifactId,
      artifactPayloadHash: seeded.anchor.artifactPayloadHash,
    },
  );
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.reasonCode, "provider_unavailable");
  assert.equal(provider.captured.length, 2, "瞬时失败应当只重试一次（内核预算 maxAutoRetries: 1）");

  // 关键：一条结论都没落。屏上会说"复核还没做"，而**不是**显示成"维持"。
  const rows = await fixtureSql`SELECT status, recheck_count, recheck_outcome FROM assessment_disputes_v2
    WHERE id = ${seeded.disputeId}`;
  assert.equal(rows[0].recheck_count, 0);
  assert.equal(rows[0].recheck_outcome, null);
  assert.equal(rows[0].status, "open");
  // 出口仍在：用户可以自己结束并暂不安排（这一格由争议集测钉，这里只量"闸还开着"）。
  const blocked = await withWorkspaceTransaction(seeded.scope, (tx) => disputes.disputeScheduleResolutionV2(tx, {
    ...seeded.scope,
    objectiveId: seeded.objectiveId as string,
  }));
  assert.equal(blocked.blocked, true, "没有结论就不该推进间隔（§14.2）");
});

test("负对照：把这次复核放在活动事务里，内核当场拒，模型一个请求都收不到", async (t) => {
  const seeded = await seedDisputedAssessment({
    originalVerdicts: [{ rubricItemId: RUBRIC_UNIT_ID, verdict: "covered" }],
    answerText: "因为利息会加入本金一起继续生息。",
  });
  t.after(() => seeded.cleanup());

  const provider = fakeProvider([{ status: 200, content: recheckJson("upheld", [[RUBRIC_UNIT_ID, "covered"]]) }]);
  const env = { ...provider, currentActiveTransaction: currentApiWorkspaceTransaction, url: "https://example.invalid/v1", key: "k" };
  const target = {
    ...seeded.scope,
    assessmentId: seeded.assessmentId,
    artifactId: seeded.anchor.artifactId,
    artifactPayloadHash: seeded.anchor.artifactPayloadHash,
  };
  await assert.rejects(
    () => withWorkspaceTransaction(seeded.scope, (tx) => {
      void tx;
      return recheck.runDisputeRecheckV2(env, target);
    }),
    (error: unknown) => error instanceof ExternalCallInsideTransactionError,
    "在事务里发外部调用必须被内核拒（§8.7 三段纪律）",
  );
  assert.equal(provider.captured.length, 0, "被拒的那一发不许真的发出去");
});

test("输出形状不对（逐条 id 对不上冻结闭包）时 fail closed，不落任何结论", async (t) => {
  const seeded = await seedDisputedAssessment({
    originalVerdicts: [{ rubricItemId: RUBRIC_UNIT_ID, verdict: "covered" }],
    answerText: "因为利息会加入本金一起继续生息。",
  });
  t.after(() => seeded.cleanup());

  const provider = fakeProvider([{ status: 200, content: recheckJson("upheld", [["ru-not-in-closure", "covered"]]) }]);
  const result = await recheck.runDisputeRecheckV2(
    { ...provider, currentActiveTransaction: currentApiWorkspaceTransaction, url: "https://example.invalid/v1", key: "k" },
    {
      ...seeded.scope,
      assessmentId: seeded.assessmentId,
      artifactId: seeded.anchor.artifactId,
      artifactPayloadHash: seeded.anchor.artifactPayloadHash,
    },
  );
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.reasonCode, "output_shape");
  const rows = await fixtureSql`SELECT recheck_count FROM assessment_disputes_v2 WHERE id = ${seeded.disputeId}`;
  assert.equal(rows[0].recheck_count, 0, "形状不对时一条结论都不许落");
});

test("模型自述与逐条之差对不上时记「仍无法判断」，并在理由里说清为什么（§14.2）", async (t) => {
  const seeded = await seedDisputedAssessment({
    originalVerdicts: [{ rubricItemId: RUBRIC_UNIT_ID, verdict: "covered" }],
    answerText: "因为利息会加入本金一起继续生息。",
  });
  t.after(() => seeded.cleanup());

  // 模型说"已修正"，而它自己的逐条判定与原判**完全一致**——照抄就是假回执。
  const provider = fakeProvider([{ status: 200, content: recheckJson("corrected", [[RUBRIC_UNIT_ID, "covered"]]) }]);
  const result = await recheck.runDisputeRecheckV2(
    { ...provider, currentActiveTransaction: currentApiWorkspaceTransaction, url: "https://example.invalid/v1", key: "k" },
    {
      ...seeded.scope,
      assessmentId: seeded.assessmentId,
      artifactId: seeded.anchor.artifactId,
      artifactPayloadHash: seeded.anchor.artifactPayloadHash,
    },
  );
  assert.equal(result.status, "committed");
  if (result.status !== "committed") return;
  assert.equal(result.outcome, "undetermined");
  assert.equal(result.correctionId, null, "没有可更正的东西就不许写更正");
  assert.match(result.reason, /对不上/);
  const corrections = await fixtureSql`SELECT count(*)::int AS n FROM assessment_corrections_v2
    WHERE dispute_id = ${seeded.disputeId}`;
  assert.equal(corrections[0].n, 0);
});

/**
 * **真模型那一发**（39d W5-5；§8.6「不得把同一次生成的自评直接当成独立评估」要有一个
 * 真的独立模型站在对面才算数）。
 *
 * 闸与同族一致：`REAL_MODEL_BATCH=1` **且**凭据齐了才跑，CI 永不设这个变量。理由写在
 * `learning-runs-demonstrated-postgres.integration.ts` 顶上——"配了凭据"不构成花钱的理由。
 *
 * 它量的是**真读数**，不是"跑通"：延迟、模型自己说的三档结论、落库那一行、以及
 * 调用那一刻的活动事务读数（用包一层 requester 的办法在**真的** HTTP 调用上取，
 * 而不是拿假 provider 顶）。夹具刻意把原判写成 `missing` 而原回答其实写到了那一步，
 * 所以"修正"是可能的答案——但**不**预设它一定发生：模型判"维持"或"仍无法判断"
 * 都是合法读数，如实报。
 */
const realModelConfigured =
  process.env.REAL_MODEL_BATCH === "1"
  && Boolean(process.env.ASSESSMENT_CRITIC_URL?.trim())
  && Boolean(
    process.env.ASSESSMENT_CRITIC_KEY?.trim() || process.env.DASHSCOPE_API_KEY?.trim(),
  );

test("真模型：一次真实的独立复核（真实读数，不是跑通就算）", { skip: realModelConfigured ? false : "需要 REAL_MODEL_BATCH=1 ＋ ASSESSMENT_CRITIC_* 凭据" }, async (t) => {
  const seeded = await seedDisputedAssessment({
    originalVerdicts: [{ rubricItemId: RUBRIC_UNIT_ID, verdict: "missing" }],
    answerText: "利息会加入本金，之后每一期的利息都按新的本金来算，所以越滚越大。",
  });
  t.after(() => seeded.cleanup());

  const { postJsonToPublicEndpoint } = await import("@ailearn/shared/public-json-http");
  const observed: { activeTransaction: unknown; status: number; raw: string; elapsedMs: number }[] = [];
  const started = Date.now();
  const result = await recheck.runDisputeRecheckV2(
    {
      currentActiveTransaction: currentApiWorkspaceTransaction,
      // 真的出网，但**包一层**：取调用那一刻的活动事务读数、状态码与原始正文。
      requester: async (url, headers, body, signal) => {
        const at = Date.now();
        const response = await postJsonToPublicEndpoint(url, headers, body, signal);
        observed.push({
          activeTransaction: currentApiWorkspaceTransaction(),
          status: response.status,
          raw: JSON.stringify(response.body).slice(0, 1200),
          elapsedMs: Date.now() - at,
        });
        return response;
      },
    },
    {
      ...seeded.scope,
      assessmentId: seeded.assessmentId,
      artifactId: seeded.anchor.artifactId,
      artifactPayloadHash: seeded.anchor.artifactPayloadHash,
    },
  );
  const totalMs = Date.now() - started;

  console.log("[dispute-recheck 真模型]", JSON.stringify({
    modelCalls: observed.length,
    httpStatus: observed[0]?.status,
    perCallMs: observed.map((o) => o.elapsedMs),
    totalMs,
    activeTransactionAtCall: observed[0]?.activeTransaction === undefined ? "none" : "ACTIVE",
    rawFirst: observed[0]?.raw,
    result,
  }, null, 2));

  assert.equal(observed.length, 1, "一次复核只发一次请求（真读数上也不许多发）");
  assert.equal(observed[0]?.activeTransaction, undefined, "真调用那一刻也不许有活动事务");
  assert.equal(observed[0]?.status, 200);
  assert.equal(result.status, "committed");
  if (result.status !== "committed") return;
  assert.ok(result.reason.length > 0);
  const rows = await fixtureSql`SELECT recheck_count, recheck_outcome, length(recheck_reason) AS reason_len
    FROM assessment_disputes_v2 WHERE id = ${seeded.disputeId}`;
  assert.equal(rows[0].recheck_count, 1);
  assert.equal(rows[0].recheck_outcome, result.outcome);
  assert.ok(Number(rows[0].reason_len) > 0);
});

/**
 * 真模型第二发：**原判给了达成、复核者看原回答不达成**那一支。
 *
 * 为什么要单独打一发：§14.2 的三档里，"维持"与"仍无法判断"是另两档，而
 * `decideRecheckVerdictDiffV2` 对"变差"的处理（归「仍无法判断」、不归「修正」）
 * 是一条**设计决定**，只有真模型站在对面才知道它会不会真的走那一支。
 * 夹具：原判 `covered`，而原回答只写了一句与评分条件无关的话。
 */
test("真模型第二发：原判达成、原回答其实不达成的那一档（§14.2 不强行选一方）", { skip: realModelConfigured ? false : "需要 REAL_MODEL_BATCH=1 ＋ ASSESSMENT_CRITIC_* 凭据" }, async (t) => {
  const seeded = await seedDisputedAssessment({
    originalVerdicts: [{ rubricItemId: RUBRIC_UNIT_ID, verdict: "covered" }],
    answerText: "记不清了。",
  });
  t.after(() => seeded.cleanup());

  const { postJsonToPublicEndpoint } = await import("@ailearn/shared/public-json-http");
  const observed: { activeTransaction: unknown; status: number; raw: string; elapsedMs: number }[] = [];
  const started = Date.now();
  const result = await recheck.runDisputeRecheckV2(
    {
      currentActiveTransaction: currentApiWorkspaceTransaction,
      requester: async (url, headers, body, signal) => {
        const at = Date.now();
        const response = await postJsonToPublicEndpoint(url, headers, body, signal);
        observed.push({
          activeTransaction: currentApiWorkspaceTransaction(),
          status: response.status,
          raw: JSON.stringify(response.body).slice(0, 1200),
          elapsedMs: Date.now() - at,
        });
        return response;
      },
    },
    {
      ...seeded.scope,
      assessmentId: seeded.assessmentId,
      artifactId: seeded.anchor.artifactId,
      artifactPayloadHash: seeded.anchor.artifactPayloadHash,
    },
  );
  const totalMs = Date.now() - started;
  console.log("[dispute-recheck 真模型·第二发]", JSON.stringify({
    modelCalls: observed.length,
    httpStatus: observed[0]?.status,
    perCallMs: observed.map((o) => o.elapsedMs),
    totalMs,
    activeTransactionAtCall: observed[0]?.activeTransaction === undefined ? "none" : "ACTIVE",
    rawFirst: observed[0]?.raw,
    result,
  }, null, 2));
  assert.equal(result.status, "committed");
  if (result.status !== "committed") return;
  // 「修正」的定义是"原来没达成的那些，原回答其实达成了"：原判已经达成而复核说不达成，
  // 那一支绝不能被记成 corrected（§16.25 的更正会改写这一次观察的正式结论）。
  assert.notEqual(result.outcome, "corrected");
  assert.equal(result.correctionId, null);
});

test.after(async () => {
  await fixtureSql.end({ timeout: 5 });
  await closeDatabase();
});
