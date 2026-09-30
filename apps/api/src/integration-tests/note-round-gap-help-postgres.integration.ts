/**
 * 同一关键缺口连续两次帮助、还没有改善 ⇒ 停止自动加题（39d W4-6 刀四；PRD §5.3）。
 *
 * 刀四把判据（`gap-help-policy.ts`，纯函数）接到真链路上，本文件钉的就是那条链路
 * 的两端与它的边界：
 *
 *  1. **一次帮助不停**（PRD 说的正是"两次"）：一次 `request_hint` ＋ 一次结论
 *     （`declared_unable`）之后，这一轮的读数是 1，结算到 checkpoint 时补充按钮
 *     照旧签发；
 *  2. **两次帮助就停**：同一缺口第二次帮助之后读数是 2 且 `stopped === true`，
 *     之后结算出的 checkpoint `allowedFollowupIds` 为空——不签发，但 `end` 仍在
 *     （收掉按钮不等于把 run 关死）；
 *  3. **改善会清零**：结论变成 `demonstrated` 之后计数归零、`stopped` 回到 false，
 *     按钮也随着回来；
 *  4. **跨轮隔离**：同一个目标、同一个工作区，另一轮的帮助不算这一轮的——缺口身份
 *     取自 run 的 origin，轮次边界也是身份的一部分；
 *  5. **防绕过**：按钮是停之前签发的（旧快照里还在），直接打 `activate_followup`
 *     也要被 `gap_help_stopped`（409）拒掉——签发侧不发了，不等于防线只有一层。
 *
 * 每条用例**各自一份工作区**（夹具＋目标＋对照笔记都在用例自己那份里）：轮次里的
 * 练习会把目标变成"已有一场开着"，共用一份工作区的话上一条留下的 run 会让下一条的
 * 起点读成 null，读起来像产品坏了。
 *
 * 环境口径与轮次族其他几份一致：夹具走 `DATABASE_URL_MIGRATOR`（超户），被测的路由
 * 与服务经 `withWorkspaceTransaction` 跑在 `DATABASE_URL_API`（受限角色）上；Critic
 * 的地址清掉、夹具那点证据也喂不满 Critic 输入，于是 text 提交一律 **fail closed 到
 * checkpoint**——本文件要的正是这条确定性结算路径（会签发补充按钮的那条），不测判分
 * 质量。理由码必须落在 `critic_unavailable` 上而不是 `no_frozen_evidence`：后者按
 * 审计 F28 本来就不签发按钮，认错成因会让下面那几条断言变成假绿（见各用例的断言）。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { roundTeachingViewV1Schema } from "@ailearn/shared/note-learning-round-contracts";

const fixtureUrl = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!fixtureUrl || !process.env.DATABASE_URL_API) {
  throw new Error("缺口帮助集测需要 DATABASE_URL_MIGRATOR（夹具）＋DATABASE_URL_API（受限角色，被测服务跑在它上面）");
}
process.env.DATABASE_URL_API ??= fixtureUrl;
// 与 learning-runs-postgres 同口径：run 创建会写加密的私有解与 draft；评估这一步
// 走**确定性那一档**（declared_unable / Critic 不可用的 fail closed），所以把
// Critic 的地址清掉。
delete process.env.ASSESSMENT_CRITIC_URL;
delete process.env.ASSESSMENT_CRITIC_KEY;
process.env.LEARNING_RUN_ENABLED ??= "true";
process.env.LEARNING_DRAFT_ENC_KEY ??= "a".repeat(64);
const fixtureSql = postgres(fixtureUrl, { max: 4 });

const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const { createRunV2, submitArtifact, applyAction, getRunPublicView } = await import("../modules/learning-runs/run-service.ts");
const { runLearningRunProcessingTick } = await import("../modules/learning-runs/processing/run-processing-tick.ts");
const { readRoundGapHelpV1 } = await import("../modules/learning-runs/gap-help/gap-help-service.ts");
const { LearningRunServiceError } = await import("../modules/learning-runs/run-errors.ts");
const { buildLearningRunAllowedActionsV2 } = await import("../modules/learning-runs/run-action-availability.ts");
const { seedV2Fixture, seedObjectiveNoteEvidence } = await import("./helpers/v2-card-fixture.ts");
const { default: Fastify } = await import("fastify");
const { default: sensible } = await import("@fastify/sensible");
const { authRoutes } = await import("../modules/identity/routes.ts");
const { deterministicTeachingExplainProviderV1 } = await import("../modules/note-learning-rounds/teaching/teaching-explain.ts");
const { noteLearningRoundRoutes } = await import("../modules/note-learning-rounds/routes.ts");
const { issueSession } = await import("../modules/identity/service.ts");

interface Scenario {
  seeded: Awaited<ReturnType<typeof seedV2Fixture>>;
  /** 有目标那一篇（目标绑在它名下）——第一轮开在它上面。 */
  noteWithObjective: string;
  /** 同一工作区里另一篇：用来开**第二轮**（跨轮隔离要有第二轮才测得出来）。 */
  noteWithoutObjective: string;
  token: string;
}

/** 一轮的锚点：开轮时读回来的那一份起点（第二轮没有起点，见 `startRun`）。 */
interface RoundAnchor {
  roundId: string;
  noteId: string;
  practiceStart: { goal: string; requestedTimeBudgetSeconds: number; responsePreference: string } | null;
}

let app: Awaited<ReturnType<typeof Fastify>>;

const body = (res: { body: string }): Record<string, unknown> => JSON.parse(res.body) as Record<string, unknown>;
const scopeOf = (scenario: Scenario) => ({ workspaceId: scenario.seeded.workspaceId, userId: scenario.seeded.userId });

async function call(token: string, method: "POST" | "GET", url: string, payload?: Record<string, unknown>) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload ? { payload } : {}),
  });
}

async function openRound(token: string, noteId: string, question: string): Promise<Record<string, unknown>> {
  const res = await call(token, "POST", "/v2/note-learning-rounds", {
    noteId,
    drivingQuestion: question,
    drivingQuestionSource: "suggested",
  });
  assert.equal(res.statusCode, 201, `开一轮应当成功：${res.statusCode} ${res.body}`);
  return body(res).round as Record<string, unknown>;
}

async function readTeaching(token: string, roundId: string) {
  const res = await call(token, "GET", `/v2/note-learning-rounds/${roundId}/teaching`);
  assert.equal(res.statusCode, 200, `读教学面应当成功：${res.statusCode} ${res.body}`);
  return roundTeachingViewV1Schema.parse(JSON.parse(res.body));
}

/**
 * 开一轮并把"练一道"那一份起点抄下来。
 *
 * 抄它是有意的：起点的三个值与主行动同一份来源，测试自己另拼一套就可能在错的
 * 地方绿（真链路上客户端从不拼这些值）。同一轮的后续几场直接复用这份值——
 * 教学面在"已有一场开着"时按设计不再给起点，而"同一轮里再练一场"是真实用法。
 */
async function openRoundWithAnchor(scenario: Scenario, noteId: string, question: string): Promise<RoundAnchor> {
  const round = await openRound(scenario.token, noteId, question);
  const view = await readTeaching(scenario.token, round.roundId as string);
  const practice = view.practiceStart;
  if (practice) {
    assert.deepEqual(practice.start.originV2, {
      kind: "note_round",
      roundId: round.roundId,
      noteId,
      objectiveId: scenario.seeded.objectiveId,
    }, "线上那一发的锚点必须正是本文件下面要用的 origin");
  }
  return {
    roundId: round.roundId as string,
    noteId,
    practiceStart: practice
      ? {
        goal: practice.start.goal,
        requestedTimeBudgetSeconds: practice.start.requestedTimeBudgetSeconds,
        responsePreference: practice.start.responsePreference,
      }
      : null,
  };
}

/** 没有目标的那一篇给的轮次没有起点（练习只在目标存在时开 run）；用这组值补上。 */
const FALLBACK_START = { goal: "stabilize", requestedTimeBudgetSeconds: 120, responsePreference: "adaptive" };

/** 开一场挂在某一轮上的练习（= 服务端签发起点之后客户端做的那一发）。 */
async function startRun(scenario: Scenario, anchor: RoundAnchor) {
  const scope = scopeOf(scenario);
  const start = anchor.practiceStart ?? FALLBACK_START;
  const created = await withWorkspaceTransaction(scope, (tx) => createRunV2(tx, {
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    request: {
      version: 2,
      originV2: {
        kind: "note_round",
        roundId: anchor.roundId,
        noteId: anchor.noteId,
        objectiveId: scenario.seeded.objectiveId,
      },
      goal: start.goal,
      requestedTimeBudgetSeconds: start.requestedTimeBudgetSeconds,
      responsePreference: start.responsePreference,
      idempotencyKey: `gap-help-run-${randomUUID()}`,
    },
  } as never));
  return withWorkspaceTransaction(scope, (tx) => getRunPublicView(tx, { ...scope, runId: created.runId }));
}

/** 发一次 `request_hint`（= 一次帮助；写 readRoundGapHelpV1 数的那一行事件）。 */
async function requestHint(
  scenario: Scenario,
  runId: string,
  runRevision: number,
  runtimeEpoch: number,
  level: 1 | 2,
) {
  const scope = scopeOf(scenario);
  return withWorkspaceTransaction(scope, (tx) => applyAction(tx, {
    ...scope,
    runId,
    runRevision,
    runtimeEpoch,
    action: { kind: "request_hint", level },
    idempotencyKey: `gap-help-hint-${randomUUID()}`,
  }));
}

async function submitDeclaredUnable(scenario: Scenario, runId: string) {
  const scope = scopeOf(scenario);
  const view = await withWorkspaceTransaction(scope, (tx) => getRunPublicView(tx, { ...scope, runId }));
  const task = view.activeTask!;
  const variant = task.activeVariant;
  return withWorkspaceTransaction(scope, (tx) => submitArtifact(tx, {
    ...scope,
    runId,
    taskId: view.activeTaskId!,
    request: {
      version: 1,
      variantId: variant.variantId,
      variantRevision: variant.revision,
      runRevision: view.revision,
      taskRevision: task.revision,
      inputSchemaHash: variant.inputSchemaHash,
      payload: { kind: "declared_unable", reasonCode: "cannot_recall" },
      idempotencyKey: `gap-help-unable-${randomUUID()}`,
    },
  }));
}

/** 交一份 text 作答：Critic 这条路走不通 ⇒ fail closed 到 checkpoint（会签发补充按钮的那条）。 */
async function submitText(scenario: Scenario, runId: string, text: string) {
  const scope = scopeOf(scenario);
  const view = await withWorkspaceTransaction(scope, (tx) => getRunPublicView(tx, { ...scope, runId }));
  const task = view.activeTask!;
  const variant = task.activeVariant;
  return withWorkspaceTransaction(scope, (tx) => submitArtifact(tx, {
    ...scope,
    runId,
    taskId: view.activeTaskId!,
    request: {
      version: 1,
      variantId: variant.variantId,
      variantRevision: variant.revision,
      runRevision: view.revision,
      taskRevision: task.revision,
      inputSchemaHash: variant.inputSchemaHash,
      payload: { kind: "text", text },
      idempotencyKey: `gap-help-text-${randomUUID()}`,
    },
  }));
}

/** 把这套 outbox 跑到终态（completed / checkpoint）。 */
async function driveToRest(scenario: Scenario, runId: string, label: string) {
  const scope = scopeOf(scenario);
  let view = await withWorkspaceTransaction(scope, (tx) => getRunPublicView(tx, { ...scope, runId }));
  for (let tick = 0; tick < 10; tick += 1) {
    const result = await runLearningRunProcessingTick(`gap-help-${label}-${randomUUID()}`, 10);
    assert.equal(result.failed, 0, `tick 报 failed=${result.failed}`);
    view = await withWorkspaceTransaction(scope, (tx) => getRunPublicView(tx, { ...scope, runId }));
    if (view.phase === "completed" || view.phase === "checkpoint") break;
  }
  return view;
}

function readGap(scenario: Scenario, roundId: string) {
  const scope = scopeOf(scenario);
  return withWorkspaceTransaction(scope, (tx) => readRoundGapHelpV1(tx, scope, roundId));
}

/** 每条用例一份自己的工作区（理由见文件头）。 */
async function setup(): Promise<Scenario> {
  const seeded = await seedV2Fixture(fixtureSql, {
    objectiveStatement: "同一缺口连续两次帮助之后必须先问用户下一步",
    publicSummary: "两次帮助之后先停",
    front: { cue: "缺口帮助", prompt: "为什么同一缺口帮了两次就不再自动加题？" },
  });
  // 目标要绑到**这一篇**：`listObjectiveSurfacesV3` 的 `noteId` 收窄读的是
  // `learning_objective_origins_v2.note_id`（V2 夹具本身不写 origin 行）。
  await seedObjectiveNoteEvidence(fixtureSql, seeded);

  const noteWithoutObjective = randomUUID();
  const versionOfPlainNote = randomUUID();
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
    // V2 夹具只插版本、不写 `notes.current_version_id`，而"能开一轮"的前提是
    // "这一版正文现在真的看得见"（路由经 `getNoteWithVersion` 读指针）。
    await tx`UPDATE notes SET current_version_id = ${seeded.noteVersionId} WHERE id = ${seeded.noteId}`;
    await tx`INSERT INTO notes (id, workspace_id, title, created_by)
      VALUES (${noteWithoutObjective}, ${seeded.workspaceId}, '另一篇（放第二轮）', ${seeded.userId})`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${versionOfPlainNote}, ${noteWithoutObjective}, ${seeded.workspaceId}, 1,
        ${tx.json({ blocks: [{ type: "paragraph", content: "这一篇只用来开第二轮。" }] })}, 'plain-hash-gap-help', ${seeded.userId})`;
    await tx`UPDATE notes SET current_version_id = ${versionOfPlainNote} WHERE id = ${noteWithoutObjective}`;
  });

  const token = (await issueSession(seeded.userId, seeded.workspaceId)).token;
  return { seeded, noteWithObjective: seeded.noteId, noteWithoutObjective, token };
}

async function teardown(scenario: Scenario): Promise<void> {
  // 轮次与教学产物都是只追加：先带绕行口子删它们，再让夹具的清理收尾（含 runs/事件）。
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.allow_history_mutation', 'on', true)`;
    await tx`DELETE FROM note_learning_round_teachings WHERE workspace_id = ${scenario.seeded.workspaceId}`;
    await tx`DELETE FROM note_learning_round_plan_revisions WHERE workspace_id = ${scenario.seeded.workspaceId}`;
    await tx`DELETE FROM note_learning_rounds WHERE workspace_id = ${scenario.seeded.workspaceId}`;
  });
  await scenario.seeded.cleanup();
}

before(async () => {
  app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(authRoutes);
  await app.register(noteLearningRoundRoutes, { teaching: {
    provider: deterministicTeachingExplainProviderV1(), modelId: "offline-test", external: false,
  } });
  await app.ready();
});

after(async () => {
  await app?.close();
  await fixtureSql.end();
  await closeDatabase();
});

test("一次帮助不算停：一个 request_hint ＋ 一次 declared_unable 结论之后，补充按钮照旧签发", async () => {
  const scenario = await setup();
  try {
    const anchor = await openRoundWithAnchor(scenario, scenario.noteWithObjective, "帮一次之后这一轮还加题吗？");
    const runA = await startRun(scenario, anchor);

    const hinted = await requestHint(scenario, runA.runId, runA.revision, runA.runtimeEpoch, 1);
    assert.equal(hinted.actionResult, "hint_revealed");

    const afterFirstHelp = await readGap(scenario, anchor.roundId);
    assert.equal(afterFirstHelp.stopped, false, "只有一次帮助，还没到阈值");
    assert.equal(afterFirstHelp.consecutiveHelpCount, 1);
    assert.equal(afterFirstHelp.threshold, 2);
    assert.ok(afterFirstHelp.gap, "帮助落在某条缺口上");
    assert.equal(afterFirstHelp.gap!.objectiveId, scenario.seeded.objectiveId);
    assert.ok(afterFirstHelp.gap!.intent, "缺口身份要带 intent（同一目标上不同题型不是同一条缺口）");

    // 结论走确定性那一档（declared_unable）：本用例要的是"一次帮助 + 一次结论"的
    // 读数，不是判分质量。
    await submitDeclaredUnable(scenario, runA.runId);
    const settled = await driveToRest(scenario, runA.runId, "a");
    assert.equal(settled.phase, "completed", "declared_unable 应当走到终态");
    assert.equal(settled.result?.outcome, "declared_unable");

    const afterFirstOutcome = await readGap(scenario, anchor.roundId);
    assert.equal(afterFirstOutcome.consecutiveHelpCount, 1, "「说没想起来」既不重置计数，也不触发停");
    assert.equal(afterFirstOutcome.stopped, false);

    // 同一轮里再练一场并结算到 checkpoint：这是会签发补充按钮的那条路径。
    const runB = await startRun(scenario, anchor);
    await submitText(scenario, runB.runId, "复利效应是本金产生的利息加入本金继续生息。");
    const checkpoint = await driveToRest(scenario, runB.runId, "a2");
    assert.equal(checkpoint.phase, "checkpoint");
    assert.equal(checkpoint.checkpoint?.kind, "not_assessable");
    assert.equal(
      checkpoint.checkpoint?.reasonCode,
      "critic_unavailable",
      "成因要认对：这条 fail closed 不是「系统侧缺冻结证据」——那一条按 F28 本来就不签发按钮，本条会变成假绿",
    );
    assert.deepEqual(
      checkpoint.checkpoint?.allowedFollowupIds,
      ["supplement:1"],
      "只帮过一次：补充按钮必须照旧签发",
    );
    assert.ok(
      buildLearningRunAllowedActionsV2(checkpoint).some((a) => a.kind === "activate_followup"),
      "签发要落在可用动作上，不能只是库里有个值",
    );
    assert.equal((await readGap(scenario, anchor.roundId)).stopped, false, "按钮不是上一场的残留");
  } finally {
    await teardown(scenario);
  }
});

test("同一缺口两次帮助：结算出的 checkpoint 不再签发补充按钮（出口仍在）", async () => {
  const scenario = await setup();
  try {
    const anchor = await openRoundWithAnchor(scenario, scenario.noteWithObjective, "同一道题帮两次会怎样？");
    const run = await startRun(scenario, anchor);

    const first = await requestHint(scenario, run.runId, run.revision, run.runtimeEpoch, 1);
    assert.equal(first.actionResult, "hint_revealed");
    const gapAfterFirst = await readGap(scenario, anchor.roundId);
    // text 主任务有 2 级提示（planner：wantsStructured ? 1 : 2），第二级就是第二次帮助。
    const second = await requestHint(scenario, run.runId, first.snapshot.revision, first.snapshot.runtimeEpoch, 2);
    assert.equal(second.actionResult, "hint_revealed");

    const stopped = await readGap(scenario, anchor.roundId);
    assert.equal(stopped.consecutiveHelpCount, 2);
    assert.equal(stopped.stopped, true, "到阈值且没有改善的证据 ⇒ 停");
    assert.deepEqual(stopped.gap, gapAfterFirst.gap, "两次帮助必须落在**同一条**缺口上，否则这条断言会变成假绿");

    await submitText(scenario, run.runId, "我看了两次提示，还是说不清复利效应。");
    const checkpoint = await driveToRest(scenario, run.runId, "b");
    assert.equal(checkpoint.phase, "checkpoint");
    assert.deepEqual(
      checkpoint.checkpoint?.allowedFollowupIds,
      [],
      "两次帮助之后不再自动加题",
    );
    const kinds = buildLearningRunAllowedActionsV2(checkpoint).map((a) => a.kind);
    assert.ok(!kinds.includes("activate_followup"), "按钮不许签发");
    assert.ok(kinds.includes("end"), "收掉按钮不能把 run 关死");

    const afterSettle = await readGap(scenario, anchor.roundId);
    assert.equal(afterSettle.stopped, true, "结算本身不产生改善的证据，停的状态要保持");
    assert.equal(afterSettle.consecutiveHelpCount, 2);
  } finally {
    await teardown(scenario);
  }
});

test("改善会清零：结论变成 demonstrated 之后 stopped 回到 false，按钮随之后来", async () => {
  const scenario = await setup();
  try {
    const anchor = await openRoundWithAnchor(scenario, scenario.noteWithObjective, "做出来之后还会停吗？");
    const run = await startRun(scenario, anchor);
    const first = await requestHint(scenario, run.runId, run.revision, run.runtimeEpoch, 1);
    await requestHint(scenario, run.runId, first.snapshot.revision, first.snapshot.runtimeEpoch, 2);
    await submitText(scenario, run.runId, "先随便答一段。");
    const checkpoint = await driveToRest(scenario, run.runId, "c");
    assert.deepEqual(checkpoint.checkpoint?.allowedFollowupIds, [], "先确认此刻真的停着");
    assert.equal((await readGap(scenario, anchor.roundId)).stopped, true);

    // 夹具直接把这一场的结论改成"改善"那一档：真实链路要 Critic 全 covered 才会写它，
    // 本用例测的是"改善的证据出现之后规则怎么变"，不是判分质量。
    await fixtureSql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${scenario.seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${scenario.seeded.userId}, true)`;
      await tx`UPDATE learning_runs
        SET result = ${tx.json({
          outcome: "demonstrated",
          demonstratedFacets: [],
          gapFacets: [],
          scheduleImpact: { kind: "none", reasonCode: "practice_only" },
        })}, updated_at = now()
        WHERE id = ${run.runId}`;
    });

    const improved = await readGap(scenario, anchor.roundId);
    assert.equal(improved.stopped, false, "有改善的证据 ⇒ 不再停自动加题");
    assert.equal(improved.consecutiveHelpCount, 0, "改善之前的帮助不算连续（从改善那一格清零）");

    // 按钮跟着回来：同一轮再开一场结算，checkpoint 又签发补充。
    const next = await startRun(scenario, anchor);
    await submitText(scenario, next.runId, "再答一次，这次说清了复利效应。");
    const nextCheckpoint = await driveToRest(scenario, next.runId, "c2");
    assert.deepEqual(
      nextCheckpoint.checkpoint?.allowedFollowupIds,
      ["supplement:1"],
      "改善之后应当恢复自动加题",
    );
  } finally {
    await teardown(scenario);
  }
});

test("跨轮隔离：另一轮的帮助不算这一轮的", async () => {
  const scenario = await setup();
  try {
    const roundOne = await openRoundWithAnchor(scenario, scenario.noteWithObjective, "这一轮的帮助只算这一轮吗？");
    const runOne = await startRun(scenario, roundOne);
    await requestHint(scenario, runOne.runId, runOne.revision, runOne.runtimeEpoch, 1);
    await submitText(scenario, runOne.runId, "第一轮里的一份作答。");
    const checkpointOne = await driveToRest(scenario, runOne.runId, "d1");
    assert.deepEqual(checkpointOne.checkpoint?.allowedFollowupIds, ["supplement:1"], "第一轮只帮过一次，照旧签发");

    // 第二轮开在同一工作区的**另一篇**上（一篇笔记同时只有一轮）；同一个目标、
    // 同一个工作区——能分开它们的只有轮次边界。
    const roundTwo = await openRoundWithAnchor(scenario, scenario.noteWithoutObjective, "另一轮的帮助会不会串进来？");
    const runTwo = await startRun(scenario, roundTwo);
    const first = await requestHint(scenario, runTwo.runId, runTwo.revision, runTwo.runtimeEpoch, 1);
    await requestHint(scenario, runTwo.runId, first.snapshot.revision, first.snapshot.runtimeEpoch, 2);

    const gapTwo = await readGap(scenario, roundTwo.roundId);
    const gapOne = await readGap(scenario, roundOne.roundId);
    assert.equal(gapTwo.consecutiveHelpCount, 2, "对照：第二轮自己那两次帮助确实被数到了");
    assert.equal(gapTwo.stopped, true);
    assert.equal(gapOne.consecutiveHelpCount, 1, "第一轮的读数不能把另一轮的帮助算进来");
    assert.equal(gapOne.stopped, false);
    // 两轮的缺口身份是同一份（同一目标、同一题型）：分得开靠的是轮次边界，
    // 不是"目标或题型刚好不同"。
    assert.equal(gapOne.gap?.objectiveId, scenario.seeded.objectiveId);
    assert.deepEqual(gapOne.gap, gapTwo.gap);
  } finally {
    await teardown(scenario);
  }
});

test("别的来源不受影响：today 那一场帮了两次，补充按钮照旧签发（这条规则只认轮次）", async () => {
  const scenario = await setup();
  try {
    const scope = scopeOf(scenario);
    // 今天/复习/星图那些入口没有"同一缺口"这个说法（PRD §5.3 说的是"轮次里"），
    // 所以这一场**不带** roundId：它帮两次也不该被这条规则顺手改掉。
    const created = await withWorkspaceTransaction(scope, (tx) => createRunV2(tx, {
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      request: {
        version: 2,
        originV2: { kind: "today", objectiveId: scenario.seeded.objectiveId },
        goal: "stabilize",
        idempotencyKey: `gap-help-today-${randomUUID()}`,
      },
    } as never));
    const run = await withWorkspaceTransaction(scope, (tx) => getRunPublicView(tx, { ...scope, runId: created.runId }));

    const first = await requestHint(scenario, run.runId, run.revision, run.runtimeEpoch, 1);
    assert.equal(first.actionResult, "hint_revealed");
    const second = await requestHint(scenario, run.runId, first.snapshot.revision, first.snapshot.runtimeEpoch, 2);
    assert.equal(second.actionResult, "hint_revealed");

    await submitText(scenario, run.runId, "看了两次提示，还是说不清复利效应。");
    const rest = await driveToRest(scenario, run.runId, "today");
    assert.equal(rest.phase, "checkpoint");
    assert.ok(
      (rest.checkpoint?.allowedFollowupIds ?? []).length > 0,
      "非轮次来源的那一场被这条规则连坐了：补充按钮不该消失",
    );
    const kinds = buildLearningRunAllowedActionsV2(rest).map((a) => a.kind);
    assert.ok(kinds.includes("activate_followup"), "别的 origin 上按钮必须还在");
  } finally {
    await teardown(scenario);
  }
});

test("防绕过：按钮是停之前签发的，直接打 activate_followup 也要按 gap_help_stopped 拒（409）", async () => {
  const scenario = await setup();
  try {
    const anchor = await openRoundWithAnchor(scenario, scenario.noteWithObjective, "旧按钮还能绕过去吗？");
    const runF = await startRun(scenario, anchor);
    await requestHint(scenario, runF.runId, runF.revision, runF.runtimeEpoch, 1);
    await submitText(scenario, runF.runId, "先答一份，拿到那颗按钮。");
    const checkpoint = await driveToRest(scenario, runF.runId, "e");
    assert.deepEqual(
      checkpoint.checkpoint?.allowedFollowupIds,
      ["supplement:1"],
      "前提：这颗按钮是当时签发的",
    );

    // 第二场里再帮一次：从这一刻起这一轮停了，但客户端手里那颗旧按钮不会自己消失。
    const runG = await startRun(scenario, anchor);
    await requestHint(scenario, runG.runId, runG.revision, runG.runtimeEpoch, 1);
    assert.equal((await readGap(scenario, anchor.roundId)).stopped, true);

    // 前提核对：按钮仍在授权集合里（否则拒绝会来自 followup_not_authorized），
    // 而且这一场还没有第二道题（否则会来自补位额度那一条）——拒绝只能来自新的那一层。
    assert.ok(checkpoint.checkpoint!.allowedFollowupIds.includes("supplement:1"));
    const usedRows = await fixtureSql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${scenario.seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${scenario.seeded.userId}, true)`;
      return tx`SELECT count(*)::int AS total FROM learning_tasks WHERE run_id = ${runF.runId} AND sequence >= 2`;
    });
    assert.equal(Number(usedRows[0]?.total ?? 0), 0, "前提失效：这一场已经用过补位额度");

    await assert.rejects(
      withWorkspaceTransaction(scopeOf(scenario), (tx) => applyAction(tx, {
        ...scopeOf(scenario),
        runId: runF.runId,
        runRevision: checkpoint.revision,
        runtimeEpoch: checkpoint.runtimeEpoch,
        action: { kind: "activate_followup", followupId: "supplement:1" },
        idempotencyKey: `gap-help-bypass-${randomUUID()}`,
      })),
      (err: unknown) => {
        assert.ok(err instanceof LearningRunServiceError, `应当是学习运行服务错误：${String(err)}`);
        assert.equal(err.code, "gap_help_stopped");
        assert.equal(err.statusCode, 409);
        return true;
      },
    );
  } finally {
    await teardown(scenario);
  }
});
