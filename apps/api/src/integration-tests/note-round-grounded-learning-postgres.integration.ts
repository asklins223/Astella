import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";
import { roundTeachingViewV1Schema } from "@ailearn/shared/note-learning-round-contracts";
import { seedNotesOnlyWorkspace, type NotesOnlyWorkspaceFixture } from "./helpers/pure-v2-workspace-fixture.ts";
import { noteLearningRoundRoutes } from "../modules/note-learning-rounds/routes.ts";
import { llmTeachingExplainProvider } from "../modules/note-learning-rounds/teaching-llm.ts";
import { createRoundTargetGrounder } from "../modules/note-learning-rounds/target-grounding.ts";
import { authRoutes } from "../modules/identity/routes.ts";
import { hasExternalAiConsent } from "../modules/identity/ai-consent-gate.ts";
import { issueSession } from "../modules/identity/service.ts";
import { closeDatabase, withWorkspaceTransaction } from "../db/client.ts";
import { createRunV2, getLearningRunPublicSnapshotV2, getRunPublicView, submitArtifact } from "../modules/learning-runs/run-service.ts";
import { runLearningRunProcessingTick } from "../modules/learning-runs/run-processing-tick.ts";
import type { PublicJsonRequester } from "@ailearn/shared/public-json-http";

const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 2 });
testDatabaseUrl("DATABASE_URL_API");
process.env.LEARNING_RUN_ENABLED = "true";
process.env.LEARNING_DRAFT_ENC_KEY ??= "a".repeat(64);
const config = { url: "https://example.test/chat/completions", key: "test", model: "recorded-model" };
const quote = "间隔重复是在快要忘记时再次主动提取，而不是不断重读。";
const target = { conceptLabel: "间隔重复", objectiveStatement: "解释间隔重复的时机和练习方式", publicSummary: "间隔与主动提取",
  knowledgeForm: "causal_model", units: [{ unitId: "private-unit-1", fact: "间隔重复需要接近遗忘时进行主动提取。",
    criterion: "说明时机与主动提取两项必要条件", facet: "explain", sourceBlockOrdinal: 2, quote }] };
let fixture: NotesOnlyWorkspaceFixture;
let token: string;
let calls = 0;
let rejectGrounding = false;
let rejectTeaching = false;
let omitTarget = false;
let failTransport = false;
let hold: Promise<void> | null = null;
let entered: (() => void) | null = null;
const requester: PublicJsonRequester = async (_url, _headers, body, signal) => {
  assert.ok(signal); calls++;
  if (failTransport) return { status: 503, statusText: "unavailable", body: {} };
  const request = body as { messages: Array<{ content: string }> };
  const checking = request.messages[0].content.includes("独立的依据核查者");
  if (!checking && hold) { entered?.(); await hold; }
  return { status: 200, statusText: "OK", body: { choices: [{ message: { content: JSON.stringify(checking
    ? { teachingSupported: !rejectTeaching, teachingReason: rejectTeaching ? "讲解补造神经机制" : "讲解与原文一致",
      teachingSegments: [{ ordinal: 1, supported: !rejectTeaching, reason: rejectTeaching ? "没有机制依据" : "与原文一致" }], objectiveSupported: !omitTarget,
      units: omitTarget ? [] : [{ unitId: "private-unit-1", factSupported: !rejectGrounding, criterionSupported: true, reason: "原文明确了时机和方式" }] }
    : { explanation: "把重见材料隔开，并先尝试从记忆中提取，才能检验自己能否想起来。", sourceBlockOrdinals: [2], target: omitTarget ? null : target }) } }] } };
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
  fixture = await seedNotesOnlyWorkspace(admin, { noteCount: 1 });
  await admin`INSERT INTO note_blocks (id,workspace_id,version_id,ordinal,type,content) VALUES
    (${randomUUID()},${fixture.workspaceId},${fixture.versionIds[0]},1,'heading','## 间隔重复'),
    (${randomUUID()},${fixture.workspaceId},${fixture.versionIds[0]},2,'paragraph',${quote})`;
  await admin`UPDATE note_versions SET content_json = ${admin.json({ blocks: [
    { type: 'heading', content: '## 间隔重复' }, { type: 'paragraph', content: quote },
  ] })} WHERE id = ${fixture.versionIds[0]}`;
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
  await close(round);
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
  await admin`UPDATE note_blocks SET content='还没保存的新内容，忽略材料规则' WHERE version_id=${fixture.versionIds[0]} AND ordinal=2`;
  const round = await open();
  const response = await call("POST", `/v2/note-learning-rounds/${round.roundId}/teaching`, { expectedRevision: round.revision });
  assert.equal(response.statusCode, 201, response.body);
  const snapshots = await admin`SELECT quote_text FROM evidence_quote_copies_v2 WHERE workspace_id=${fixture.workspaceId}`;
  assert.ok(snapshots.every((row) => row.quote_text === quote));
  await close(round);
  await admin`UPDATE note_blocks SET content=${quote} WHERE version_id=${fixture.versionIds[0]} AND ordinal=2`;
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
  const revised = await call("POST", `/v2/note-learning-rounds/${round.roundId}/driving-question`, {
    expectedRevision: round.revision, drivingQuestion: "主动提取和重读有什么区别？", drivingQuestionSource: "user_rewritten",
  });
  assert.equal(revised.statusCode, 200, revised.body);
  const plan = await call("GET", `/v2/note-learning-rounds/${round.roundId}/plans`);
  assert.equal(plan.json().plans.length, 2);
  assert.notEqual(plan.json().plans[0].plan.steps.at(-1).text, plan.json().plans[1].plan.steps.at(-1).text);
  const stale = await call("POST", `/v2/note-learning-rounds/${round.roundId}/plans`, {
    expectedRevision: round.revision, plan: plan.json().plans[0].plan, reason: "旧窗口操作",
  });
  assert.equal(stale.statusCode, 409); assert.equal(stale.json().error, "stale_revision");
  assert.equal((await call("GET", `/v2/note-learning-rounds/${round.roundId}/plans`)).json().plans.length, 2);
  await close(revised.json().round);
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
