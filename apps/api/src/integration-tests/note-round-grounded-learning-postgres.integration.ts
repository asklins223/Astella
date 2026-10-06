import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { roundTeachingViewV1Schema } from "@astella/shared/note-learning-round-contracts";
import { seedNotesOnlyWorkspace, type NotesOnlyWorkspaceFixture } from "./helpers/pure-v2-workspace-fixture.ts";
import { noteLearningRoundRoutes } from "../modules/note-learning-rounds/routes.ts";
import { llmTeachingExplainProvider } from "../modules/note-learning-rounds/teaching/teaching-llm.ts";
import { createRoundTargetGrounder } from "../modules/note-learning-rounds/target-grounding.ts";
import { authRoutes } from "../modules/identity/routes.ts";
import { hasExternalAiConsent } from "../modules/identity/ai-consent-gate.ts";
import { readObjectiveNoteChangeImpactV1 } from "../modules/learning-objectives/change-impact-service.ts";
import { issueSession } from "../modules/identity/service.ts";
import { closeDatabase, withWorkspaceTransaction } from "../db/client.ts";
import { createRunV2, getLearningRunPublicSnapshotV2, getRunPublicView, submitArtifact } from "../modules/learning-runs/run-service.ts";
import { activateReviewSubscriptionV2 } from "../modules/review/review-subscriptions.ts";
import { scheduleStudiedNoteTargetsV2 } from "../modules/review/note-subscription-schedule.ts";
import { listSanitizedReviews, projectReviewQueueV2 } from "../modules/review/service.ts";
import { runLearningRunProcessingTick } from "../modules/learning-runs/processing/run-processing-tick.ts";
import type { PublicJsonRequester } from "@astella/shared/public-json-http";

const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 2 });
testDatabaseUrl("DATABASE_URL_API");
process.env.LEARNING_RUN_ENABLED = "true";
process.env.LEARNING_DRAFT_ENC_KEY ??= "a".repeat(64);
const config = { url: "https://example.test/chat/completions", key: "test", model: "recorded-model" };
const quote = "间隔重复是在快要忘记时再次主动提取，而不是不断重读。";
const safeQuote = "先遮住答案，再从记忆中回想。";
const applicationScenario = "你读完一份新资料后，第二天要检验自己是否还记得重点。你会怎样安排这一次回顾？";
const editedQuote = "间隔重复通常在接近遗忘时主动提取，具体时机还要结合材料难度。";
const supplementedEvidenceQuote = "复习间隔应结合材料类型、预期保持时长与学习者基础确定。";
const indexSuspectQuote = "复合索引缺少最左列条件就无法使用索引";
const indexSafeQuote = "小表或匹配行数很多时，查询优化器可能选择顺序扫描。";
const indexSuspectUnit = { unitId: "suspect-index-unit", fact: indexSuspectQuote,
  criterion: "判断复合索引的使用条件", facet: "explain", sourceBlockOrdinal: 2, quote: indexSuspectQuote };
const indexSafeUnit = { unitId: "safe-index-unit", fact: indexSafeQuote,
  criterion: "说明小表或大量匹配行时选择顺序扫描的原因", facet: "explain", sourceBlockOrdinal: 3, quote: indexSafeQuote };
const indexClaimTarget = { conceptLabel: "数据库索引", objectiveStatement: "解释复合索引条件与顺序扫描选择",
  publicSummary: "索引适用条件与查询计划", knowledgeForm: "causal_model", units: [indexSuspectUnit, indexSafeUnit] };
const target = { conceptLabel: "间隔重复", objectiveStatement: "解释间隔重复的时机和练习方式", publicSummary: "间隔与主动提取",
  knowledgeForm: "causal_model", units: [{ unitId: "private-unit-1", fact: "间隔重复需要接近遗忘时进行主动提取。",
    criterion: "说明时机与主动提取两项必要条件", facet: "explain", sourceBlockOrdinal: 2, quote }] };
const recheckedTarget = { ...target, units: [{ ...target.units[0], fact: "间隔重复的时机还需结合材料难度。",
  criterion: "说明时机与材料难度的关系", quote: editedQuote }] };
const sourceRecheckedTarget = { ...target, units: [{ ...target.units[0], fact: "复习间隔取决于材料类型、预期保持时长与学习者基础。",
  criterion: "指出设定间隔要考虑的三个条件", quote: supplementedEvidenceQuote }] };
const safeUnit = { unitId: "safe-unit-2", fact: "检索练习先遮住答案，再从记忆中回想。", criterion: "指出先回想再核对", facet: "explain",
  sourceBlockOrdinal: 3, quote: safeQuote };
let fixture: NotesOnlyWorkspaceFixture;
let token: string;
let calls = 0;
let rejectGrounding = false;
let rejectTeaching = false;
let omitTarget = false;
let applicationCase = false;
let suspectClaim = false;
let suspectOnly = false;
let proposeExistingSafeUnit = false;
let indexClaimJourney = false;
let recheckingEditedSuspect = false;
let supplementingSuspect = false;
let failTransport = false;
let hold: Promise<void> | null = null;
let entered: (() => void) | null = null;
const requester: PublicJsonRequester = async (_url, _headers, body, signal) => {
  assert.ok(signal); calls++;
  if (failTransport) return { status: 503, statusText: "unavailable", body: {} };
  const request = body as { messages: Array<{ content: string }> };
  const checking = request.messages[0].content.includes("独立的依据核查者");
  if (!checking && (recheckingEditedSuspect || supplementingSuspect)) {
    assert.match(request.messages[0].content, /suspectRechecks/);
    assert.match(request.messages[0].content, /private-unit-1/);
  }
  if (checking && supplementingSuspect) assert.match(request.messages[0].content, new RegExp(supplementedEvidenceQuote));
  if (!checking && hold) { entered?.(); await hold; }
  const activeSuspect = suspectClaim && !recheckingEditedSuspect && !supplementingSuspect;
  const activeTarget = indexClaimJourney ? indexClaimTarget
    : applicationCase ? { ...target, units: [{ ...target.units[0], facet: "apply",
      criterion: "针对给出的新资料回顾情境，说明何时主动提取，并指出为何不是持续重读" }] }
    : supplementingSuspect ? sourceRecheckedTarget : recheckingEditedSuspect ? recheckedTarget
    : proposeExistingSafeUnit ? { ...target, units: [safeUnit] } : target;
  const proposedUnits = indexClaimJourney
    ? (suspectOnly ? [indexSuspectUnit] : [indexSuspectUnit, indexSafeUnit])
    : [activeTarget.units[0], ...(activeSuspect && !suspectOnly ? [safeUnit] : [])];
  const suspectUnitId = indexClaimJourney ? indexSuspectUnit.unitId : "private-unit-1";
  const suspectQuote = indexClaimJourney ? indexSuspectQuote : quote;
  return { status: 200, statusText: "OK", body: { choices: [{ message: { content: JSON.stringify(checking
    ? { teachingSupported: !rejectTeaching, teachingReason: rejectTeaching ? "讲解补造神经机制" : "讲解与原文一致",
      teachingSegments: [{ ordinal: 1, supported: !rejectTeaching, reason: rejectTeaching ? "没有机制依据" : "与原文一致" }], objectiveSupported: !omitTarget,
      publicQuestionSafe: true,
      applicationScenarioSupported: applicationCase,
      units: omitTarget ? [] : proposedUnits.map((unit) => ({
        unitId: unit.unitId, factSupported: !rejectGrounding, criterionSupported: true, reason: "本轮原文支持这个知识点",
      })),
      suspectClaims: activeSuspect ? [{ unitIds: [suspectUnitId], sourceBlockOrdinal: 2, sourceQuote: suspectQuote,
        reason: "这条主张看起来省略了可能改变结论的条件，值得再核对。" }] : [] }
      : { explanation: "把重见材料隔开，并先尝试从记忆中提取，才能检验自己能否想起来。", sourceBlockOrdinals: [2, ...(activeSuspect && !suspectOnly ? [3] : [])],
      ...(applicationCase ? { applicationScenario } : {}),
      target: omitTarget ? null : activeSuspect
        ? { ...activeTarget, units: proposedUnits }
        : activeTarget }) } }] } };
};
const app = Fastify({ logger: false });
const scope = () => ({ workspaceId: fixture.workspaceId, userId: fixture.userId });
const call = (method: "POST" | "GET" | "PATCH", url: string, payload?: object) => app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
async function open(noteId = fixture.noteIds[0]) {
  const res = await call("POST", "/v2/note-learning-rounds", { noteId });
  assert.equal(res.statusCode, 201, res.body); return res.json().round as { roundId: string; revision: number; drivingQuestion: string };
}
async function close(round: { roundId: string; revision: number }) {
  const res = await call("PATCH", `/v2/note-learning-rounds/${round.roundId}`, { expectedRevision: round.revision, action: { kind: "close", outcome: "partial" } });
  assert.equal(res.statusCode, 200, res.body);
}

before(async () => {
  fixture = await seedNotesOnlyWorkspace(admin, { noteCount: 2 });
  await admin`INSERT INTO note_blocks (id,workspace_id,version_id,ordinal,type,content) VALUES
    (${randomUUID()},${fixture.workspaceId},${fixture.versionIds[0]},1,'heading','## 间隔重复'),
    (${randomUUID()},${fixture.workspaceId},${fixture.versionIds[0]},2,'paragraph',${quote}),
    (${randomUUID()},${fixture.workspaceId},${fixture.versionIds[0]},3,'paragraph',${safeQuote})`;
  await admin`UPDATE note_versions SET content_json = ${admin.json({ blocks: [
    { type: 'heading', content: '## 间隔重复' }, { type: 'paragraph', content: quote }, { type: 'paragraph', content: safeQuote },
  ] })} WHERE id = ${fixture.versionIds[0]}`;
  await admin`INSERT INTO note_blocks (id,workspace_id,version_id,ordinal,type,content) VALUES
    (${randomUUID()},${fixture.workspaceId},${fixture.versionIds[1]},1,'heading','## 间隔重复'),
    (${randomUUID()},${fixture.workspaceId},${fixture.versionIds[1]},2,'paragraph',${quote}),
    (${randomUUID()},${fixture.workspaceId},${fixture.versionIds[1]},3,'paragraph',${safeQuote})`;
  await admin`UPDATE note_versions SET content_json = ${admin.json({ blocks: [
    { type: 'heading', content: '## 间隔重复' }, { type: 'paragraph', content: quote }, { type: 'paragraph', content: safeQuote },
  ] })} WHERE id = ${fixture.versionIds[1]}`;
  await app.register(sensible); await app.register(authRoutes);
  await app.register(noteLearningRoundRoutes, { teaching: { provider: llmTeachingExplainProvider({ config, requester }), modelId: config.model, external: false },
    targetGrounder: createRoundTargetGrounder(config, requester) });
  await app.ready(); token = (await issueSession(fixture.userId, fixture.workspaceId)).token;
});
after(async () => {
  try { await app.close(); await fixture?.cleanup(); }
  finally { await closeDatabase(); await admin.end(); }
});

test("fresh saved note → default question and plan → grounded explanation → real cardless practice", async () => {
  const round = await open(); assert.match(round.drivingQuestion, /间隔重复/);
  const plan = await call("GET", `/v2/note-learning-rounds/${round.roundId}/plans`);
  assert.equal(plan.json().plans.length, 1);
  const response = await call("POST", `/v2/note-learning-rounds/${round.roundId}/teaching`, { expectedRevision: round.revision });
  assert.equal(response.statusCode, 201, response.body);
  const view = roundTeachingViewV1Schema.parse(response.json());
  assert.ok(view.practiceStart); assert.equal(view.plans.length, 1); assert.equal(calls, 2);
  assert.ok(!response.body.includes("private-unit-1")); assert.ok(!response.body.includes("canonicalAnswer"));
  const counts = await admin`SELECT
    (SELECT count(*) FROM learning_cards_v2 WHERE workspace_id=${fixture.workspaceId}) AS cards,
    (SELECT count(*) FROM review_schedules WHERE workspace_id=${fixture.workspaceId}) AS schedules`;
  assert.equal(Number(counts[0].cards), 0); assert.equal(Number(counts[0].schedules), 0);
  const replay = await call("POST", `/v2/note-learning-rounds/${round.roundId}/teaching`, { expectedRevision: round.revision });
  assert.equal(replay.statusCode, 200); assert.equal(calls, 2, "replay does not pay again");
  const created = await withWorkspaceTransaction(scope(), (tx) => createRunV2(tx, { ...scope(),
    request: { ...view.practiceStart!.start, idempotencyKey: `grounded-${round.roundId}` } }));
  assert.equal(created.frozen.snapshot.target.cardId, null); assert.ok(created.frozen.snapshot.target.evidence.length > 0);
  assert.equal(created.frozen.snapshot.planningExposure.sameCueRecentlyRevealed, true);
  const run = await withWorkspaceTransaction(scope(), (tx) => getLearningRunPublicSnapshotV2(tx, { ...scope(), runId: created.runId }));
  assert.ok(run); assert.equal(run.target.objectiveId, view.practiceStart.objectiveId);
  const privateView = await withWorkspaceTransaction(scope(), (tx) => getRunPublicView(tx, { ...scope(), runId: created.runId }));
  const task = privateView.activeTask!; const variant = task.activeVariant;
  await withWorkspaceTransaction(scope(), (tx) => submitArtifact(tx, { ...scope(), runId: created.runId,
    taskId: privateView.activeTaskId!, request: { version: 1, variantId: variant.variantId, variantRevision: variant.revision,
      runRevision: privateView.revision, taskRevision: task.revision, inputSchemaHash: variant.inputSchemaHash,
      payload: { kind: "declared_unable", reasonCode: "cannot_recall" }, idempotencyKey: `answer-${round.roundId}` } }));
  let phase = "";
  for (let index = 0; index < 8; index++) {
    await runLearningRunProcessingTick(`grounded-${randomUUID()}`, 10);
    phase = (await withWorkspaceTransaction(scope(), (tx) => getRunPublicView(tx, { ...scope(), runId: created.runId }))).phase;
    if (phase === "completed" || phase === "checkpoint") break;
  }
  assert.equal(phase, "completed");
  const settled = await call("GET", `/v2/note-learning-rounds/${round.roundId}/teaching`);
  assert.equal(settled.json().practices[0].outcome, "declared_unable");
  assert.equal(settled.json().round.roundId, round.roundId); assert.equal(settled.json().round.revision, round.revision);
  const attempts = await admin`SELECT model_calls,status FROM note_learning_round_model_attempts WHERE round_id=${round.roundId}`;
  assert.equal(attempts[0].model_calls, 2); assert.equal(attempts[0].status, "succeeded");

  // 轮次读回应把同一轮目标的引用变化一并带回。单独移动正文版本只够触发
  // contentMoved；这里让同 ordinal 引文内容也变动，核实恢复读回复用 D3 的依据判定。
  const impactedObjectiveId = view.practiceStart!.objectiveId;
  await withWorkspaceTransaction(scope(), async (tx) => {
    await activateReviewSubscriptionV2(tx, { ...scope(), source: "note_subscription", subjectId: fixture.noteIds[0] });
    await scheduleStudiedNoteTargetsV2(tx, { ...scope(), noteId: fixture.noteIds[0], at: new Date() });
    // Repeated activation must reuse the target-level pending requirement.
    await scheduleStudiedNoteTargetsV2(tx, { ...scope(), noteId: fixture.noteIds[0], at: new Date() });
  });
  const scheduled = await admin`SELECT id FROM review_schedules
    WHERE workspace_id=${fixture.workspaceId} AND user_id=${fixture.userId}
      AND subject_id=${impactedObjectiveId} AND status='pending'`;
  assert.equal(scheduled.length, 1, "笔记订阅为已学的无卡目标建立唯一回访");
  const impactedScheduleId = String(scheduled[0].id);
  await admin`UPDATE review_schedules SET next_review_at=now() - interval '1 minute'
    WHERE id=${impactedScheduleId}`;
  const reviewQueue = await withWorkspaceTransaction(scope(), async (tx) =>
    projectReviewQueueV2(await listSanitizedReviews(fixture.workspaceId, { status: "pending" }, fixture.userId, tx)));
  assert.equal(reviewQueue.items.find((item) => item.objectiveId === impactedObjectiveId)?.cardId, null,
    "今日回访以 objective/schedule 身份进入队列，不凭空制造学习卡");
  const inFlightReview = await withWorkspaceTransaction(scope(), (tx) => createRunV2(tx, { ...scope(), request: {
    originV2: { kind: "review", scheduleId: impactedScheduleId, objectiveId: impactedObjectiveId, scheduleGeneration: 1 },
    goal: "stabilize",
    idempotencyKey: `in-flight-note-change-${impactedScheduleId}`,
  } }));
  const inFlightView = await withWorkspaceTransaction(scope(), (tx) => getRunPublicView(tx, { ...scope(), runId: inFlightReview.runId }));
  const inFlightTask = inFlightView.activeTask;
  const inFlightTaskId = inFlightView.activeTaskId;
  if (!inFlightTask || !inFlightTaskId) throw new Error("in-flight review run lacks an active task");
  await withWorkspaceTransaction(scope(), (tx) => submitArtifact(tx, { ...scope(), runId: inFlightReview.runId,
    taskId: inFlightTaskId, request: { version: 1, variantId: inFlightTask.activeVariant.variantId,
      variantRevision: inFlightTask.activeVariant.revision, runRevision: inFlightView.revision,
      taskRevision: inFlightTask.revision, inputSchemaHash: inFlightTask.activeVariant.inputSchemaHash,
      payload: { kind: "declared_unable", reasonCode: "cannot_recall" }, idempotencyKey: `in-flight-answer-${impactedScheduleId}` } }));
  const changedVersion = randomUUID();
  const changedQuote = "间隔重复是在快要忘记时开始主动回想，而不是不断重读。";
  await admin`
    INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
    VALUES (${changedVersion}, ${fixture.noteIds[0]}, ${fixture.workspaceId}, 4244,
      ${admin.json({ blocks: [
        { type: "heading", content: "## 间隔重复" },
        { type: "paragraph", content: changedQuote },
      ] })}, 'round-impact-current', ${fixture.userId})`;
  await admin`INSERT INTO note_blocks (id, workspace_id, version_id, ordinal, type, content)
    VALUES (${randomUUID()}, ${fixture.workspaceId}, ${changedVersion}, 1, 'heading', '## 间隔重复'),
      (${randomUUID()}, ${fixture.workspaceId}, ${changedVersion}, 2, 'paragraph', ${changedQuote})`;
  await admin`UPDATE notes SET current_version_id=${changedVersion} WHERE id=${fixture.noteIds[0]}`;
  try {
    const restored = await call("GET", `/v2/notes/${fixture.noteIds[0]}/learning-round`);
    assert.equal(restored.statusCode, 200, restored.body);
    const roundView = restored.json();
    assert.equal(roundView.contentMoved, true);
    assert.equal(roundView.noteChangeImpact?.status, "affected");
    assert.equal(roundView.noteChangeImpact?.reasonCode, "quoted_text_changed");
    assert.equal(roundView.noteChangeImpact?.evidenceDetails?.[0]?.previousQuote, quote);
    assert.equal(roundView.noteChangeImpact?.evidenceDetails?.[0]?.currentQuote, changedQuote);

    const runCountBefore = await admin`SELECT count(*)::int AS count FROM learning_runs WHERE workspace_id=${fixture.workspaceId}`;
    await assert.rejects(
      withWorkspaceTransaction(scope(), (tx) => createRunV2(tx, { ...scope(), request: {
        originV2: { kind: "review", scheduleId: impactedScheduleId, objectiveId: impactedObjectiveId, scheduleGeneration: 1 },
        goal: "stabilize",
        idempotencyKey: `blocked-changed-note-${impactedScheduleId}`,
      } })),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "review_note_evidence_changed");
        return true;
      },
    );
    const [scheduleAfter] = await admin`SELECT status FROM review_schedules WHERE id=${impactedScheduleId}`;
    const runCountAfter = await admin`SELECT count(*)::int AS count FROM learning_runs WHERE workspace_id=${fixture.workspaceId}`;
    assert.equal(scheduleAfter.status, "pending", "evidence check leaves the scheduled review available for verification");
    assert.equal(runCountAfter.count, runCountBefore.count, "blocked review does not create a run");

    let settledPhase = "";
    for (let attempt = 0; attempt < 8; attempt++) {
      await runLearningRunProcessingTick(`note-impact-${randomUUID()}`, 10);
      settledPhase = (await withWorkspaceTransaction(scope(), (tx) => getRunPublicView(tx, { ...scope(), runId: inFlightReview.runId }))).phase;
      if (settledPhase === "completed" || settledPhase === "checkpoint") break;
    }
    assert.equal(settledPhase, "completed");
    const settledInFlightReview = await withWorkspaceTransaction(scope(), (tx) => getRunPublicView(tx, { ...scope(), runId: inFlightReview.runId }));
    assert.deepEqual(settledInFlightReview.result?.scheduleImpact, { kind: "none", reasonCode: "note_evidence_changed" });
    const schedulesAfterSettlement = await admin`SELECT status, generation FROM review_schedules WHERE workspace_id=${fixture.workspaceId} AND subject_id=${impactedObjectiveId}`;
    assert.equal(schedulesAfterSettlement.length, 1, "changed evidence creates no successor schedule");
    assert.equal(schedulesAfterSettlement[0].status, "pending", "changed evidence does not consume the in-flight schedule");
  } finally {
    // 一次**按 workspace 清**，不是只删 `impactedScheduleId`：
    // 那一条是笔记订阅建的那行；而上面那次无卡练习 run 结算完成后，`learning_runs`
    // 那条路径**自己也建了一行后继复习**（实测 pending / generation=1，subject 指向
    // 本轮那个目标）。只删订阅那一行，这行就漏进下一个用例——本文件里下一条
    // `suspect factual claim …` 断言的是「这个 workspace 一行复习都没有」，
    // 于是被前一条的残留判红（2026-10-06 实测）。夹具 workspace 本来就是本文件
    // `before` 里现种、`after` 里整个删掉的，整块清掉才是它的真实生命周期。
    await admin`DELETE FROM review_schedules WHERE workspace_id=${fixture.workspaceId}`;
    await admin`UPDATE notes SET current_version_id=${fixture.versionIds[0]} WHERE id=${fixture.noteIds[0]}`;
    await close(round);
  }
});

test("先试 prepares a private target without teaching or answer exposure, then marks a later explanation", async () => {
  // A separate note identity avoids borrowing the first test's genuine prior reveal.
  const round = await open(fixture.noteIds[1]);
  try {
    const initial = roundTeachingViewV1Schema.parse((await call("GET", `/v2/note-learning-rounds/${round.roundId}/teaching`)).json());
    assert.equal(initial.teaching, null);
    assert.equal(initial.practiceStart, null);
    assert.equal(initial.nextStep.kind, "explain");

    const beforeCalls = calls;
    const preparedResponse = await call("POST", `/v2/note-learning-rounds/${round.roundId}/practice-preparation`,
      { expectedRevision: round.revision });
    assert.equal(preparedResponse.statusCode, 201, preparedResponse.body);
    const prepared = roundTeachingViewV1Schema.parse(preparedResponse.json());
    assert.equal(prepared.teaching, null);
    assert.ok(prepared.practiceStart);
    assert.equal(prepared.nextStep.kind, "attempt");
    assert.equal(calls - beforeCalls, 2, "one generation and one independent grounding call");
    assert.ok(!preparedResponse.body.includes("private-unit-1"));
    assert.ok(!preparedResponse.body.includes("canonicalAnswer"));

    const [privateState] = await admin`SELECT
      (SELECT count(*)::int FROM note_learning_round_teachings WHERE round_id=${round.roundId}) AS teachings,
      (SELECT count(*)::int FROM learning_exposures_v2
        WHERE idempotency_key=${`round-teaching:${round.roundId}:1`}) AS reveals`;
    assert.equal(privateState.teachings, 0);
    assert.equal(privateState.reveals, 0);
    const replay = await call("POST", `/v2/note-learning-rounds/${round.roundId}/practice-preparation`,
      { expectedRevision: round.revision });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(calls - beforeCalls, 2, "replay reuses the frozen private target");

    const firstTry = await withWorkspaceTransaction(scope(), (tx) => createRunV2(tx, { ...scope(),
      request: { ...prepared.practiceStart!.start, idempotencyKey: `first-try-${round.roundId}` } }));
    assert.equal(firstTry.frozen.snapshot.target.cardId, null);
    assert.equal(firstTry.frozen.snapshot.planningExposure.sameCueRecentlyRevealed, false);

    const explanation = await call("POST", `/v2/note-learning-rounds/${round.roundId}/teaching`,
      { expectedRevision: round.revision });
    assert.equal(explanation.statusCode, 201, explanation.body);
    assert.ok(roundTeachingViewV1Schema.parse(explanation.json()).teaching);
    const [revealed] = await admin`SELECT count(*)::int AS count FROM learning_exposures_v2
      WHERE idempotency_key=${`round-teaching:${round.roundId}:1`}`;
    assert.equal(revealed.count, 1);
  } finally { await close(round); }
});

test("checked application setting is frozen on the round target and appears in the Run task", async () => {
  applicationCase = true;
  const round = await open();
  try {
    const preparedResponse = await call("POST", `/v2/note-learning-rounds/${round.roundId}/practice-preparation`,
      { expectedRevision: round.revision });
    assert.equal(preparedResponse.statusCode, 201, preparedResponse.body);
    const prepared = roundTeachingViewV1Schema.parse(preparedResponse.json());
    assert.ok(prepared.practiceStart);
    assert.ok(!preparedResponse.body.includes(applicationScenario), "the future setting stays private during the first try");
    const [bound] = await admin`SELECT application_scenario FROM note_learning_round_targets WHERE round_id=${round.roundId}`;
    assert.equal(bound.application_scenario, applicationScenario);
    const applicationRun = await withWorkspaceTransaction(scope(), (tx) => createRunV2(tx, { ...scope(),
      request: { ...prepared.practiceStart!.start, goal: "transfer",
        idempotencyKey: `application-${round.roundId}` } }));
    const view = await withWorkspaceTransaction(scope(), (tx) => getRunPublicView(tx, { ...scope(), runId: applicationRun.runId }));
    assert.equal(view.activeTask?.intent, "apply");
    assert.ok(view.activeTask?.prompt.includes(applicationScenario));
    assert.ok(!view.activeTask?.prompt.includes("请换一个与刚才笔记示例不同"));
  } finally { applicationCase = false; await close(round); }
});

test("先试 without a grounded target does not publish a fake question or teaching", async () => {
  rejectGrounding = true;
  const round = await open();
  try {
    const response = await call("POST", `/v2/note-learning-rounds/${round.roundId}/practice-preparation`,
      { expectedRevision: round.revision });
    assert.equal(response.statusCode, 422, response.body);
    assert.equal(response.json().error, "practice_target_unavailable");
    const view = roundTeachingViewV1Schema.parse((await call("GET", `/v2/note-learning-rounds/${round.roundId}/teaching`)).json());
    assert.equal(view.teaching, null);
    assert.equal(view.practiceStart, null);
    assert.equal(view.nextStep.kind, "explain");
    const [state] = await admin`SELECT
      (SELECT count(*)::int FROM note_learning_round_targets WHERE round_id=${round.roundId}) AS targets,
      (SELECT count(*)::int FROM note_learning_round_teachings WHERE round_id=${round.roundId}) AS teachings`;
    assert.equal(state.targets, 0);
    assert.equal(state.teachings, 0);
  } finally { rejectGrounding = false; await close(round); }
});

test("failed grounding retains teaching and creates no new objective or round target", async () => {
  rejectGrounding = true;
  const round = await open(); const before = await admin`SELECT count(*) AS n FROM learning_objectives_v2 WHERE workspace_id=${fixture.workspaceId}`;
  const response = await call("POST", `/v2/note-learning-rounds/${round.roundId}/teaching`, { expectedRevision: round.revision });
  assert.equal(response.statusCode, 201, response.body); assert.ok(response.json().teaching);
  const afterCount = await admin`SELECT count(*) AS n FROM learning_objectives_v2 WHERE workspace_id=${fixture.workspaceId}`;
  assert.equal(afterCount[0].n, before[0].n);
  const bindings = await admin`SELECT 1 FROM note_learning_round_targets WHERE round_id=${round.roundId}`;
  assert.equal(bindings.length, 0);
  assert.equal(response.json().practiceStart, null, "rejected target must not borrow an older note objective");
  assert.equal((await call("GET", `/v2/note-learning-rounds/${round.roundId}/teaching`)).json().practiceStart, null);
  rejectGrounding = false; await close(round);
});

test("suspect factual claim stays visible while only the independently safe unit becomes practiceable", async () => {
  const round = await open();
  suspectClaim = true;
  const before = await admin`SELECT count(*)::int AS n FROM learning_objectives_v2 WHERE workspace_id=${fixture.workspaceId}`;
  try {
    const response = await call("POST", `/v2/note-learning-rounds/${round.roundId}/teaching`, { expectedRevision: round.revision });
    assert.equal(response.statusCode, 201, response.body);
    const view = roundTeachingViewV1Schema.parse(response.json());
    assert.ok(view.teaching);
    assert.equal(view.teaching.content.suspectClaims?.[0]?.sourceQuote, quote);
    assert.equal(view.teaching.content.suspectClaims?.[0]?.sourceBlockOrdinal, 2);
    assert.ok(view.practiceStart, "the unrelated supported unit remains practiceable");
    const after = await admin`SELECT count(*)::int AS n FROM learning_objectives_v2 WHERE workspace_id=${fixture.workspaceId}`;
    assert.equal(after[0].n, before[0].n + 1);
    const objectives = await admin`
      SELECT revision.canonical_answer, revision.scoring_rubric
      FROM note_learning_round_targets AS binding
      JOIN learning_objective_revisions_v2 AS revision
        ON revision.objective_revision_id = binding.objective_revision_id
      WHERE binding.round_id=${round.roundId}`;
    assert.equal(objectives.length, 1);
    assert.deepEqual(objectives[0].canonical_answer.items.map((item: { unitId: string }) => item.unitId), ["safe-unit-2"]);
    assert.deepEqual(objectives[0].scoring_rubric.units.map((item: { rubricUnitId: string }) => item.rubricUnitId), ["safe-unit-2"]);
    // 按**这一轮绑定的目标**问，而不是"整个 workspace 有没有复习行"。
    // 原写法是 workspace 全量计数，于是本文件里任何一条用例留下的残留都能把它判红
    // ——断言变成了测执行顺序，而不是测"可疑主张没有被排进复习"这件事本身。
    const schedules = await admin`
      SELECT 1 FROM review_schedules AS schedule
      WHERE schedule.workspace_id=${fixture.workspaceId}
        AND schedule.subject_id IN (
          SELECT binding.objective_id FROM note_learning_round_targets AS binding
          WHERE binding.round_id=${round.roundId})`;
    assert.equal(schedules.length, 0, "可疑主张不该被排进复习队列");
    const reread = await call("GET", `/v2/note-learning-rounds/${round.roundId}/teaching`);
    assert.equal(reread.json().teaching.content.suspectClaims?.[0]?.reason, "这条主张看起来省略了可能改变结论的条件，值得再核对。");
  } finally { suspectClaim = false; await close(round); }
});

test("a next-day suspect-only revisit gets no formal grading target and leaves the safe unit's interval alone", async () => {
  const indexVersionId = randomUUID();
  const scheduleId = randomUUID();
  let activeRound: { roundId: string; revision: number } | null = null;
  let safeObjectiveId = "";
  const indexNoteId = fixture.noteIds[1];
  const originalVersionId = fixture.versionIds[1];
  await admin`
    INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
    VALUES (${indexVersionId}, ${indexNoteId}, ${fixture.workspaceId}, 4247,
      ${admin.json({ blocks: [
        { type: 'heading', content: '## 复合索引与执行计划' },
        { type: 'paragraph', content: indexSuspectQuote },
        { type: 'paragraph', content: indexSafeQuote },
      ] })}, 'next-day-index-claim-fixture', ${fixture.userId})`;
  await admin`INSERT INTO note_blocks (id, workspace_id, version_id, ordinal, type, content) VALUES
    (${randomUUID()}, ${fixture.workspaceId}, ${indexVersionId}, 1, 'heading', '## 复合索引与执行计划'),
    (${randomUUID()}, ${fixture.workspaceId}, ${indexVersionId}, 2, 'paragraph', ${indexSuspectQuote}),
    (${randomUUID()}, ${fixture.workspaceId}, ${indexVersionId}, 3, 'paragraph', ${indexSafeQuote})`;
  await admin`UPDATE notes SET current_version_id=${indexVersionId} WHERE id=${indexNoteId}`;
  indexClaimJourney = true;
  suspectClaim = true;
  suspectOnly = false;
  try {
    // Day one: the explanation may lead into the independently supported query-planner unit,
    // but the absolute composite-index claim itself must be removed from the frozen target.
    activeRound = await open(indexNoteId);
    const dayOne = await call("POST", `/v2/note-learning-rounds/${activeRound.roundId}/teaching`, { expectedRevision: activeRound.revision });
    assert.equal(dayOne.statusCode, 201, dayOne.body);
    const dayOneView = roundTeachingViewV1Schema.parse(dayOne.json());
    assert.equal(dayOneView.teaching?.content.suspectClaims?.[0]?.sourceQuote, indexSuspectQuote);
    assert.ok(dayOneView.practiceStart, "the independent safe unit can still be practised");
    safeObjectiveId = dayOneView.practiceStart.objectiveId;
    const safeTarget = await admin`
      SELECT revision.canonical_answer, objective.current_objective_revision_id
      FROM learning_objectives_v2 AS objective
      JOIN learning_objective_revisions_v2 AS revision
        ON revision.objective_revision_id = objective.current_objective_revision_id
      WHERE objective.workspace_id=${fixture.workspaceId} AND objective.objective_id=${safeObjectiveId}`;
    assert.deepEqual(safeTarget[0].canonical_answer.items.map((item: { unitId: string }) => item.unitId), ["safe-index-unit"]);
    const safeRevisionId = safeTarget[0].current_objective_revision_id;
    await admin`INSERT INTO review_schedules
      (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at, interval_days, generation, policy_version, reason_code, created_at, updated_at)
      VALUES (${scheduleId}, ${fixture.workspaceId}, ${fixture.userId}, 'card', ${safeObjectiveId}, 'pending', now() + interval '3 days', 3, 2, 'discrete-v2', 'initial_validation', now(), now())`;
    await close(activeRound);
    const dayOneRoundId = activeRound.roundId;
    activeRound = null;
    // Give the second visit a reproducible one-day gap without waiting in real time. This mutates
    // only this isolated fixture row and leaves its frozen note/version reference untouched.
    await admin.begin(async (tx) => {
      await tx`SELECT set_config('app.allow_history_mutation', 'on', true)`;
      await tx`UPDATE note_learning_rounds SET created_at=created_at - interval '1 day',
        updated_at=updated_at - interval '1 day', revision=revision + 1 WHERE id=${dayOneRoundId}`;
    });

    // Day two is a suspect-only revisit. This route does not collect a user's answer; it proves
    // the stronger boundary that no formal target or scoring run is issued for this claim, so no
    // correct verdict or interval transition can be created from repeating it here.
    suspectOnly = true;
    activeRound = await open(indexNoteId);
    const objectivesBefore = await admin`SELECT count(*)::int AS n FROM learning_objectives_v2 WHERE workspace_id=${fixture.workspaceId}`;
    const runsBefore = await admin`SELECT count(*)::int AS n FROM learning_runs WHERE workspace_id=${fixture.workspaceId}`;
    const secondVisit = await call("POST", `/v2/note-learning-rounds/${activeRound.roundId}/teaching`, { expectedRevision: activeRound.revision });
    assert.equal(secondVisit.statusCode, 201, secondVisit.body);
    const dayTwoView = roundTeachingViewV1Schema.parse(secondVisit.json());
    assert.equal(dayTwoView.teaching?.content.suspectClaims?.[0]?.sourceQuote, indexSuspectQuote);
    assert.equal(dayTwoView.practiceStart, null, "the accurately repeated suspect claim has no assessment entry");
    const binding = await admin`SELECT 1 FROM note_learning_round_targets WHERE round_id=${activeRound.roundId}`;
    assert.equal(binding.length, 0, "there is no hidden assessment target to score");
    const objectivesAfter = await admin`SELECT count(*)::int AS n FROM learning_objectives_v2 WHERE workspace_id=${fixture.workspaceId}`;
    assert.equal(objectivesAfter[0].n, objectivesBefore[0].n, "repetition does not mint a formal objective");
    const runsAfter = await admin`SELECT count(*)::int AS n FROM learning_runs WHERE workspace_id=${fixture.workspaceId}`;
    assert.equal(runsAfter[0].n, runsBefore[0].n, "a suspect-only revisit cannot issue a grading run");
    const safeAfter = await admin`SELECT current_objective_revision_id FROM learning_objectives_v2
      WHERE workspace_id=${fixture.workspaceId} AND objective_id=${safeObjectiveId}`;
    assert.equal(safeAfter[0].current_objective_revision_id, safeRevisionId, "the unrelated safe target is unchanged");
    const scheduleAfter = await admin`SELECT status, interval_days, generation FROM review_schedules WHERE id=${scheduleId}`;
    assert.deepEqual(scheduleAfter[0], { status: "pending", interval_days: 3, generation: 2 },
      "the unrelated safe unit keeps its existing interval unchanged");
  } finally {
    indexClaimJourney = false;
    suspectClaim = false;
    suspectOnly = false;
    if (activeRound) await close(activeRound);
    await admin`DELETE FROM review_schedules WHERE id=${scheduleId}`;
    await admin`UPDATE notes SET current_version_id=${originalVersionId} WHERE id=${indexNoteId}`;
  }
});

test("when every proposed unit is suspect, the round has no objective or practice schedule", async () => {
  const round = await open();
  suspectClaim = true;
  suspectOnly = true;
  const before = await admin`SELECT count(*)::int AS n FROM learning_objectives_v2 WHERE workspace_id=${fixture.workspaceId}`;
  const beforeSchedules = await admin`SELECT count(*)::int AS n FROM review_schedules WHERE workspace_id=${fixture.workspaceId}`;
  try {
    const response = await call("POST", `/v2/note-learning-rounds/${round.roundId}/teaching`, { expectedRevision: round.revision });
    assert.equal(response.statusCode, 201, response.body);
    const view = roundTeachingViewV1Schema.parse(response.json());
    assert.ok(view.teaching?.content.suspectClaims?.length);
    assert.equal(view.practiceStart, null, "待核对的唯一主张不签发正式练习入口");
    const after = await admin`SELECT count(*)::int AS n FROM learning_objectives_v2 WHERE workspace_id=${fixture.workspaceId}`;
    assert.equal(after[0].n, before[0].n, "不能为待核对主张创建正式能力目标");
    const bindings = await admin`SELECT 1 FROM note_learning_round_targets WHERE round_id=${round.roundId}`;
    assert.equal(bindings.length, 0);
    const afterSchedules = await admin`SELECT count(*)::int AS n FROM review_schedules WHERE workspace_id=${fixture.workspaceId}`;
    assert.equal(afterSchedules[0].n, beforeSchedules[0].n, "没有目标就没有可推进的复习间隔");
  } finally {
    suspectClaim = false;
    suspectOnly = false;
    await close(round);
  }
});

test("a suspect-only round cannot borrow an older safe objective as its assessment target", async () => {
  const safeRound = await open();
  proposeExistingSafeUnit = true;
  let suspectRound: { roundId: string; revision: number } | null = null;
  let safeObjectiveId = "";
  try {
    const safeTeaching = await call("POST", `/v2/note-learning-rounds/${safeRound.roundId}/teaching`, { expectedRevision: safeRound.revision });
    assert.equal(safeTeaching.statusCode, 201, safeTeaching.body);
    const safeView = roundTeachingViewV1Schema.parse(safeTeaching.json());
    assert.ok(safeView.practiceStart, "the earlier, independently supported unit has a normal practice entry");
    safeObjectiveId = safeView.practiceStart.objectiveId;
    const original = await admin`
      SELECT objective.lifecycle, objective.current_objective_revision_id, revision.canonical_answer
      FROM learning_objectives_v2 AS objective
      JOIN learning_objective_revisions_v2 AS revision
        ON revision.objective_revision_id = objective.current_objective_revision_id
      WHERE objective.workspace_id=${fixture.workspaceId} AND objective.objective_id=${safeObjectiveId}`;
    assert.equal(original.length, 1);
    assert.deepEqual(original[0].canonical_answer.items.map((item: { unitId: string }) => item.unitId), ["safe-unit-2"]);

    await close(safeRound);
    proposeExistingSafeUnit = false;
    suspectClaim = true;
    suspectOnly = true;
    suspectRound = await open();
    const beforeObjectives = await admin`SELECT count(*)::int AS n FROM learning_objectives_v2 WHERE workspace_id=${fixture.workspaceId}`;
    const beforeSchedules = await admin`SELECT count(*)::int AS n FROM review_schedules WHERE workspace_id=${fixture.workspaceId}`;

    const suspectTeaching = await call("POST", `/v2/note-learning-rounds/${suspectRound.roundId}/teaching`, { expectedRevision: suspectRound.revision });
    assert.equal(suspectTeaching.statusCode, 201, suspectTeaching.body);
    const suspectView = roundTeachingViewV1Schema.parse(suspectTeaching.json());
    assert.ok(suspectView.teaching?.content.suspectClaims?.length);
    assert.equal(suspectView.practiceStart, null, "a prior safe target cannot stand in for this suspect-only round");
    const roundTargets = await admin`SELECT 1 FROM note_learning_round_targets WHERE round_id=${suspectRound.roundId}`;
    assert.equal(roundTargets.length, 0);
    const afterObjectives = await admin`SELECT count(*)::int AS n FROM learning_objectives_v2 WHERE workspace_id=${fixture.workspaceId}`;
    const afterSchedules = await admin`SELECT count(*)::int AS n FROM review_schedules WHERE workspace_id=${fixture.workspaceId}`;
    assert.equal(afterObjectives[0].n, beforeObjectives[0].n, "the suspect unit must not create a second formal objective");
    assert.equal(afterSchedules[0].n, beforeSchedules[0].n, "repeating the suspect unit must not create or advance a review interval");
    const preserved = await admin`
      SELECT objective.lifecycle, objective.current_objective_revision_id, revision.canonical_answer
      FROM learning_objectives_v2 AS objective
      JOIN learning_objective_revisions_v2 AS revision
        ON revision.objective_revision_id = objective.current_objective_revision_id
      WHERE objective.workspace_id=${fixture.workspaceId} AND objective.objective_id=${safeObjectiveId}`;
    assert.equal(preserved[0].lifecycle, original[0].lifecycle);
    assert.equal(preserved[0].current_objective_revision_id, original[0].current_objective_revision_id);
    assert.deepEqual(preserved[0].canonical_answer, original[0].canonical_answer, "the older safe target remains unchanged");
  } finally {
    proposeExistingSafeUnit = false;
    suspectClaim = false;
    suspectOnly = false;
    if (suspectRound) await close(suspectRound);
    else await close(safeRound);
  }
});

test("editing a warned source rechecks only that unit and leaves the safe target and schedule untouched", async () => {
  let activeRound: { roundId: string; revision: number } | null = await open();
  const originalRound = activeRound;
  suspectClaim = true;
  recheckingEditedSuspect = false;
  const scheduleId = randomUUID();
  let safeObjectiveId = "";
  let safeRevisionId = "";
  try {
    const first = await call("POST", `/v2/note-learning-rounds/${activeRound.roundId}/teaching`, { expectedRevision: activeRound.revision });
    assert.equal(first.statusCode, 201, first.body);
    const firstView = roundTeachingViewV1Schema.parse(first.json());
    assert.equal(firstView.teaching?.content.suspectClaims?.[0]?.sourceQuote, quote);
    assert.ok(firstView.practiceStart);
    safeObjectiveId = firstView.practiceStart.objectiveId;
    const safeBefore = await admin`SELECT current_objective_revision_id FROM learning_objectives_v2
      WHERE workspace_id=${fixture.workspaceId} AND objective_id=${safeObjectiveId}`;
    safeRevisionId = safeBefore[0].current_objective_revision_id;
    await admin`INSERT INTO review_schedules
      (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at, interval_days, generation, policy_version, reason_code, created_at, updated_at)
      VALUES (${scheduleId}, ${fixture.workspaceId}, ${fixture.userId}, 'card', ${safeObjectiveId}, 'pending', now() + interval '3 days', 3, 2, 'discrete-v2', 'initial_validation', now(), now())`;

    const changedVersion = randomUUID();
    await admin`
      INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${changedVersion}, ${fixture.noteIds[0]}, ${fixture.workspaceId}, 4245,
        ${admin.json({ blocks: [
          { type: 'heading', content: '## 间隔重复' }, { type: 'paragraph', content: editedQuote },
          { type: 'paragraph', content: safeQuote },
        ] })}, 'edited-suspect-source', ${fixture.userId})`;
    await admin`INSERT INTO note_blocks (id, workspace_id, version_id, ordinal, type, content) VALUES
      (${randomUUID()}, ${fixture.workspaceId}, ${changedVersion}, 1, 'heading', '## 间隔重复'),
      (${randomUUID()}, ${fixture.workspaceId}, ${changedVersion}, 2, 'paragraph', ${editedQuote}),
      (${randomUUID()}, ${fixture.workspaceId}, ${changedVersion}, 3, 'paragraph', ${safeQuote})`;
    await admin`UPDATE notes SET current_version_id=${changedVersion} WHERE id=${fixture.noteIds[0]}`;

    const safeImpact = await withWorkspaceTransaction(scope(), (tx) => readObjectiveNoteChangeImpactV1(
      tx, scope(), safeObjectiveId, { includeUnchanged: true },
    ));
    assert.equal(safeImpact?.status, "unaffected", "the other unit still cites its unchanged block");

    await close(activeRound);
    activeRound = null;
    recheckingEditedSuspect = true;
    suspectClaim = false;
    activeRound = await open();
    const rechecked = await call("POST", `/v2/note-learning-rounds/${activeRound.roundId}/teaching`, { expectedRevision: activeRound.revision });
    assert.equal(rechecked.statusCode, 201, rechecked.body);
    const recheckedView = roundTeachingViewV1Schema.parse(rechecked.json());
    assert.ok(recheckedView.practiceStart, "the edited claim becomes practiceable after independent support");
    assert.equal(recheckedView.teaching?.content.suspectClaims, undefined);
    const newTarget = await admin`
      SELECT revision.canonical_answer
      FROM note_learning_round_targets AS binding
      JOIN learning_objective_revisions_v2 AS revision ON revision.objective_revision_id = binding.objective_revision_id
      WHERE binding.round_id=${activeRound.roundId}`;
    assert.deepEqual(newTarget[0].canonical_answer.items.map((item: { unitId: string }) => item.unitId), ["private-unit-1"]);
    const safeAfter = await admin`SELECT current_objective_revision_id FROM learning_objectives_v2
      WHERE workspace_id=${fixture.workspaceId} AND objective_id=${safeObjectiveId}`;
    assert.equal(safeAfter[0].current_objective_revision_id, safeRevisionId);
    const scheduleAfter = await admin`SELECT status, generation FROM review_schedules WHERE id=${scheduleId}`;
    assert.equal(scheduleAfter[0].status, "pending");
    assert.equal(scheduleAfter[0].generation, 2);
    const oldWarning = await call("GET", `/v2/note-learning-rounds/${originalRound.roundId}/teaching`);
    assert.equal(oldWarning.json().teaching.content.suspectClaims[0].sourceQuote, quote, "the immutable old warning is retained");
  } finally {
    suspectClaim = false;
    recheckingEditedSuspect = false;
    if (activeRound) await close(activeRound);
    await admin`DELETE FROM review_schedules WHERE id=${scheduleId}`;
    await admin`UPDATE notes SET current_version_id=${fixture.versionIds[0]} WHERE id=${fixture.noteIds[0]}`;
  }
});

test("adding a checked source excerpt beside a warned claim rechecks only that unit", async () => {
  let activeRound: { roundId: string; revision: number } | null = await open();
  const originalRound = activeRound;
  suspectClaim = true;
  recheckingEditedSuspect = false;
  supplementingSuspect = false;
  const scheduleId = randomUUID();
  let safeObjectiveId = "";
  let safeRevisionId = "";
  try {
    const first = await call("POST", `/v2/note-learning-rounds/${activeRound.roundId}/teaching`, { expectedRevision: activeRound.revision });
    assert.equal(first.statusCode, 201, first.body);
    const firstView = roundTeachingViewV1Schema.parse(first.json());
    assert.equal(firstView.teaching?.content.suspectClaims?.[0]?.sourceQuote, quote);
    assert.ok(firstView.practiceStart);
    safeObjectiveId = firstView.practiceStart.objectiveId;
    const safeBefore = await admin`SELECT current_objective_revision_id FROM learning_objectives_v2
      WHERE workspace_id=${fixture.workspaceId} AND objective_id=${safeObjectiveId}`;
    safeRevisionId = safeBefore[0].current_objective_revision_id;
    await admin`INSERT INTO review_schedules
      (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at, interval_days, generation, policy_version, reason_code, created_at, updated_at)
      VALUES (${scheduleId}, ${fixture.workspaceId}, ${fixture.userId}, 'card', ${safeObjectiveId}, 'pending', now() + interval '3 days', 3, 2, 'discrete-v2', 'initial_validation', now(), now())`;

    const supplementedVersion = randomUUID();
    const supplementedBlock = `${quote}\n已核对来源摘录：${supplementedEvidenceQuote}`;
    await admin`
      INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${supplementedVersion}, ${fixture.noteIds[0]}, ${fixture.workspaceId}, 4246,
        ${admin.json({ blocks: [
          { type: 'heading', content: '## 间隔重复' }, { type: 'paragraph', content: supplementedBlock },
          { type: 'paragraph', content: safeQuote },
        ] })}, 'supplemented-suspect-source', ${fixture.userId})`;
    await admin`INSERT INTO note_blocks (id, workspace_id, version_id, ordinal, type, content) VALUES
      (${randomUUID()}, ${fixture.workspaceId}, ${supplementedVersion}, 1, 'heading', '## 间隔重复'),
      (${randomUUID()}, ${fixture.workspaceId}, ${supplementedVersion}, 2, 'paragraph', ${supplementedBlock}),
      (${randomUUID()}, ${fixture.workspaceId}, ${supplementedVersion}, 3, 'paragraph', ${safeQuote})`;
    await admin`UPDATE notes SET current_version_id=${supplementedVersion} WHERE id=${fixture.noteIds[0]}`;

    const safeImpact = await withWorkspaceTransaction(scope(), (tx) => readObjectiveNoteChangeImpactV1(
      tx, scope(), safeObjectiveId, { includeUnchanged: true },
    ));
    assert.equal(safeImpact?.status, "unaffected", "the other unit still cites its unchanged block");

    await close(activeRound);
    activeRound = null;
    recheckingEditedSuspect = true;
    supplementingSuspect = true;
    suspectClaim = false;
    activeRound = await open();
    const rechecked = await call("POST", `/v2/note-learning-rounds/${activeRound.roundId}/teaching`, { expectedRevision: activeRound.revision });
    assert.equal(rechecked.statusCode, 201, rechecked.body);
    const recheckedView = roundTeachingViewV1Schema.parse(rechecked.json());
    assert.ok(recheckedView.practiceStart, "new source material is checked before the claim becomes practiceable");
    assert.equal(recheckedView.teaching?.content.suspectClaims, undefined);
    const targets = await admin`
      SELECT revision.canonical_answer
      FROM note_learning_round_targets AS binding
      JOIN learning_objective_revisions_v2 AS revision ON revision.objective_revision_id = binding.objective_revision_id
      WHERE binding.round_id=${activeRound.roundId}`;
    assert.deepEqual(targets[0].canonical_answer.items.map((item: { unitId: string }) => item.unitId), ["private-unit-1"]);
    const safeAfter = await admin`SELECT current_objective_revision_id FROM learning_objectives_v2
      WHERE workspace_id=${fixture.workspaceId} AND objective_id=${safeObjectiveId}`;
    assert.equal(safeAfter[0].current_objective_revision_id, safeRevisionId);
    const scheduleAfter = await admin`SELECT status, generation FROM review_schedules WHERE id=${scheduleId}`;
    assert.equal(scheduleAfter[0].status, "pending");
    assert.equal(scheduleAfter[0].generation, 2);
    const oldWarning = await call("GET", `/v2/note-learning-rounds/${originalRound.roundId}/teaching`);
    assert.equal(oldWarning.json().teaching.content.suspectClaims[0].sourceQuote, quote, "the immutable old warning is retained");
  } finally {
    suspectClaim = false;
    recheckingEditedSuspect = false;
    supplementingSuspect = false;
    if (activeRound) await close(activeRound);
    await admin`DELETE FROM review_schedules WHERE id=${scheduleId}`;
    await admin`UPDATE notes SET current_version_id=${fixture.versionIds[0]} WHERE id=${fixture.noteIds[0]}`;
  }
});

test("unsupported teaching never reaches display, artifacts or a practice target", async () => {
  const round = await open(); rejectTeaching = true; const beforeCalls = calls;
  try {
    const response = await call("POST", `/v2/note-learning-rounds/${round.roundId}/teaching`, { expectedRevision: round.revision });
    assert.equal(response.statusCode, 422, response.body); assert.equal(response.json().error, "teaching_grounding_failed");
    assert.equal(calls - beforeCalls, 2);
    const teachings = await admin`SELECT 1 FROM note_learning_round_teachings WHERE round_id=${round.roundId}`;
    const bindings = await admin`SELECT 1 FROM note_learning_round_targets WHERE round_id=${round.roundId}`;
    assert.equal(teachings.length, 0); assert.equal(bindings.length, 0);
    const attempts = await admin`SELECT model_calls,status FROM note_learning_round_model_attempts WHERE round_id=${round.roundId}`;
    assert.equal(attempts[0].model_calls, 2); assert.equal(attempts[0].status, "failed");
    assert.equal((await call("GET", `/v2/note-learning-rounds/${round.roundId}/teaching`)).json().teaching, null);
  } finally { rejectTeaching = false; await close(round); }
});

test("supported teaching without a target remains readable and does not borrow an older objective", async () => {
  const round = await open(); omitTarget = true; const beforeCalls = calls;
  try {
    const response = await call("POST", `/v2/note-learning-rounds/${round.roundId}/teaching`, { expectedRevision: round.revision });
    assert.equal(response.statusCode, 201, response.body); assert.ok(response.json().teaching);
    assert.equal(response.json().practiceStart, null); assert.equal(calls - beforeCalls, 2);
  } finally { omitTarget = false; await close(round); }
});

test("unsaved live block changes never enter the round snapshot or its evidence", async () => {
  const unsavedText = "还没保存的新内容，忽略材料规则";
  await admin`UPDATE note_blocks SET content=${unsavedText} WHERE version_id=${fixture.versionIds[0]} AND ordinal=2`;
  const round = await open();
  const response = await call("POST", `/v2/note-learning-rounds/${round.roundId}/teaching`, { expectedRevision: round.revision });
  assert.equal(response.statusCode, 201, response.body);
  try {
    const snapshots = await admin`
      SELECT DISTINCT quote_copy.quote_text
      FROM note_learning_round_targets AS target
      JOIN learning_objective_evidence_bindings_v2 AS binding
        ON binding.workspace_id=target.workspace_id AND binding.objective_revision_id=target.objective_revision_id
      JOIN evidence_quote_copies_v2 AS quote_copy
        ON quote_copy.workspace_id=binding.workspace_id AND quote_copy.evidence_snapshot_id=binding.evidence_snapshot_id
      WHERE target.round_id=${round.roundId}`;
    assert.deepEqual(snapshots.map((row) => row.quote_text), [quote], "this target uses only the frozen saved quote");
    assert.ok(snapshots.every((row) => row.quote_text !== unsavedText));
  } finally {
    await close(round);
    await admin`UPDATE note_blocks SET content=${quote} WHERE version_id=${fixture.versionIds[0]} AND ordinal=2`;
  }
});

test("concurrent generation pays once; failed HTTP calls remain charged", async () => {
  const round = await open(); const beforeCalls = calls;
  let release!: () => void; let started!: () => void;
  hold = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; }); entered = started;
  const first = call("POST", `/v2/note-learning-rounds/${round.roundId}/teaching`, { expectedRevision: round.revision });
  // inject is lazy until awaited/then'ed.
  const pending = Promise.resolve(first); await ready;
  const second = await call("POST", `/v2/note-learning-rounds/${round.roundId}/teaching`, { expectedRevision: round.revision });
  assert.equal(second.statusCode, 409, second.body); assert.equal(second.json().error, "teaching_in_progress");
  release(); hold = null; entered = null;
  assert.equal((await pending).statusCode, 201); assert.equal(calls - beforeCalls, 2);
  failTransport = true;
  const failed = await call("POST", `/v2/note-learning-rounds/${round.roundId}/teaching`, { expectedRevision: round.revision, regenerate: true });
  assert.equal(failed.statusCode, 503);
  const attempts = await admin`SELECT model_calls,status FROM note_learning_round_model_attempts WHERE round_id=${round.roundId} ORDER BY started_at`;
  assert.equal(attempts[1].model_calls, 2); assert.equal(attempts[1].status, "failed");
  failTransport = false; await close(round);
});


test("failed calls exhaust the round budget even with no successful teaching", async () => {
  process.env.NOTE_ROUND_MAX_MODEL_CALLS = "2";
  const round = await open();
  delete process.env.NOTE_ROUND_MAX_MODEL_CALLS;
  const beforeCalls = calls; failTransport = true;
  const first = await call("POST", `/v2/note-learning-rounds/${round.roundId}/teaching`, { expectedRevision: round.revision });
  assert.equal(first.statusCode, 503); assert.equal(calls - beforeCalls, 2);
  const again = await call("POST", `/v2/note-learning-rounds/${round.roundId}/teaching`, { expectedRevision: round.revision });
  assert.equal(again.json().error, "round_budget_exhausted"); assert.equal(calls - beforeCalls, 2);
  failTransport = false; await close(round);
});

test("revised question appends a new plan and stale plan edits do not rewrite history", async () => {
  const round = await open();
  let closedRound = false;
  try {
    const before = await call("GET", `/v2/note-learning-rounds/${round.roundId}/plans`);
    const original = before.json().plans[0];
    const revised = await call("POST", `/v2/note-learning-rounds/${round.roundId}/driving-question`, {
      expectedRevision: round.revision, drivingQuestion: "主动提取和重读有什么区别？", drivingQuestionSource: "user_rewritten",
    });
    assert.equal(revised.statusCode, 200, revised.body);
    const plan = await call("GET", `/v2/note-learning-rounds/${round.roundId}/plans`);
    assert.equal(plan.json().plans.length, 2, "改写本轮问题只**追加**一版计划，不就地改写");
    // 旧的那一版逐字不动——这是「追加不是改写」真正要钉的东西。
    //
    // 此前这里断言的是「新旧两版最后一步文案不同」。那条已经**过期**：
    // `buildRoundReadingPlan` 在 2026-10 那次重写后刻意不再复述问题句（收尾那一步
    // 是固定文案「用一个具体例子检验理解…」），而阅读步骤只按**问题点名了哪几个
    // 小节**变化。夹具只有一个小节「间隔重复」，改写后的问题没点到别的小节，
    // 于是两版计划**本就该逐字相同**——断言文案不同，量到的是重构前的旧行为。
    assert.deepEqual(plan.json().plans[0], original, "旧计划那一版原样留着，没被就地改写");
    assert.equal(plan.json().plans[1].planOrdinal, 2, "新计划是追加出来的第二版");
    const stale = await call("POST", `/v2/note-learning-rounds/${round.roundId}/plans`, {
      expectedRevision: round.revision, plan: original.plan, reason: "旧窗口操作",
    });
    assert.equal(stale.statusCode, 409); assert.equal(stale.json().error, "stale_revision");
    assert.equal((await call("GET", `/v2/note-learning-rounds/${round.roundId}/plans`)).json().plans.length, 2);
    await close(revised.json().round);
    closedRound = true;
  } finally {
    // 中途失败也要把轮次收掉：留下一个 open 轮次，下一条 `open()` 只会拿到
    // 409 round_already_open，于是**一条真失败伪装成下一条失败**（2026-10-06 实测）。
    //
    // 但收尾**不能把真正的失败盖掉**：上面已经正常收过的那一次，这里再 PATCH 就是
    // 409 stale_revision。所以已经关着的轮次不当失败——只有"既没收到 200、
    // 轮次也还开着"才是真的收不掉。
    if (!closedRound) {
      const res = await call("PATCH", `/v2/note-learning-rounds/${round.roundId}`, {
        expectedRevision: round.revision, action: { kind: "close", outcome: "partial" },
      });
      if (res.statusCode !== 200 && res.json()?.round?.phase !== "closed") {
        assert.equal(res.statusCode, 200, res.body);
      }
    }
  }
});


test("AI consent reads the authenticated user under the restricted API role", async () => {
  assert.equal(await hasExternalAiConsent(scope()), false);
  await admin`INSERT INTO user_ai_settings (user_id,consent_version,consent_at)
    VALUES (${fixture.userId},'integration-v1',now())
    ON CONFLICT (user_id) DO UPDATE SET consent_version=excluded.consent_version,consent_at=excluded.consent_at`;
  assert.equal(await hasExternalAiConsent(scope()), true);
  const peer = await seedNotesOnlyWorkspace(admin, { noteCount: 1 });
  try { assert.equal(await hasExternalAiConsent({ workspaceId: peer.workspaceId, userId: peer.userId }), false); }
  finally { await peer.cleanup(); }
});


test("loss of note visibility blocks plans, teaching reuse and question changes before external calls", async () => {
  const round = await open();
  const generated = await call("POST", `/v2/note-learning-rounds/${round.roundId}/teaching`, { expectedRevision: round.revision });
  assert.equal(generated.statusCode, 201, generated.body);
  const beforeCalls = calls;
  await admin`UPDATE notes SET deleted_at=now() WHERE id=${fixture.noteIds[0]}`;
  try {
    for (const response of [
      await call("GET", `/v2/note-learning-rounds/${round.roundId}/plans`),
      await call("GET", `/v2/note-learning-rounds/${round.roundId}/teaching`),
      await call("POST", `/v2/note-learning-rounds/${round.roundId}/teaching`, { expectedRevision: round.revision }),
      await call("POST", `/v2/note-learning-rounds/${round.roundId}/driving-question`, {
        expectedRevision: round.revision, drivingQuestion: "新问题", drivingQuestionSource: "user_authored",
      }),
    ]) { assert.equal(response.statusCode, 404, response.body); assert.equal(response.json().error, "note_not_found"); }
    assert.equal(calls, beforeCalls);
  } finally { await admin`UPDATE notes SET deleted_at=null WHERE id=${fixture.noteIds[0]}`; await close(round); }
});
