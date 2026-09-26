/**
 * 轮次里的练习（39d W4-6 刀三）。
 *
 * 刀一给了教学产物（讲），刀三把"练"接上 `LearningRun`，并把连接**读回来**：
 * W4-5 ② 只落了 `note_round` 这个 origin 与三条调度语义，但**没有任何地方读得出**
 * "这一轮里做过一次练习"——这一份钉的就是那笔 producer 欠账的两半：
 *
 *  1. **起点由服务端签发**（`practiceStart`）：锚点在这一轮（`originV2.kind = note_round`），
 *     而 `goal` / 时长 / 怎么答三个值与目标的主行动同一份来源；
 *  2. **没有目标就没有起点**：`practiceStart = null`（练习只在目标存在时开 run），
 *     而且目标必须是**这一篇**的——同一工作区里别的笔记的 active 目标不算数；
 *  3. **练过的在轮次读侧看得见**：`practices` 里按开出顺序列出，结算之后带上结论；
 *  4. **结算不重开轮次、不重播奖励**：run 走完终态之后，轮次那一行的 phase/revision
 *     一个字没动，也没有第二条轮次冒出来，更不会凭空生成一条教学产物。
 *
 * 每条用例**各自一份工作区**（夹具＋目标绑定＋对照笔记都在用例自己那份里）：练习会把
 * 目标变成"已有一场开着"，那之后主行动是 `resume_run`——共用一份工作区的话，上一条
 * 留下的 run 会让下一条的 `practiceStart` 按设计变成 null，读起来像产品坏了。
 *
 * 口径与轮次族其他几份一致：夹具走 `DATABASE_URL_MIGRATOR`（超户），被测的路由与
 * 服务经 `withWorkspaceTransaction` 跑在 `DATABASE_URL_API`（受限角色）上。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { roundTeachingViewV1Schema } from "@ailearn/shared/note-learning-round-contracts";

const fixtureUrl = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!fixtureUrl || !process.env.DATABASE_URL_API) {
  throw new Error("轮次练习集测需要 DATABASE_URL_MIGRATOR（夹具）＋DATABASE_URL_API（受限角色，路由跑在它上面）");
}
process.env.DATABASE_URL_API ??= fixtureUrl;
// 与 learning-runs-postgres 同口径：run 创建会写加密的私有解与 draft；评估这一步
// 走**确定性那一档**（declared_unable），所以把 Critic 的地址清掉。
delete process.env.ASSESSMENT_CRITIC_URL;
delete process.env.ASSESSMENT_CRITIC_KEY;
process.env.LEARNING_RUN_ENABLED ??= "true";
process.env.LEARNING_DRAFT_ENC_KEY ??= "a".repeat(64);
const fixtureSql = postgres(fixtureUrl, { max: 4 });

const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const { createRunV2, submitArtifact, getRunPublicView } = await import("../modules/learning-runs/run-service.ts");
const { runLearningRunProcessingTick } = await import("../modules/learning-runs/run-processing-tick.ts");
const { seedV2Fixture, seedObjectiveNoteEvidence } = await import("./helpers/v2-card-fixture.ts");
const { default: Fastify } = await import("fastify");
const { default: sensible } = await import("@fastify/sensible");
const { authRoutes } = await import("../modules/identity/routes.ts");
const { noteLearningRoundRoutes } = await import("../modules/note-learning-rounds/routes.ts");
const { issueSession } = await import("../modules/identity/service.ts");

interface Scenario {
  seeded: Awaited<ReturnType<typeof seedV2Fixture>>;
  /** 有目标那一篇（目标绑在它名下）。 */
  noteWithObjective: string;
  /** 同一工作区里另一篇：名下没有目标（noteId 收窄的对照）。 */
  noteWithoutObjective: string;
  token: string;
}

let app: Awaited<ReturnType<typeof Fastify>>;

const body = (res: { body: string }): Record<string, unknown> => JSON.parse(res.body) as Record<string, unknown>;

async function call(token: string, method: "POST" | "GET", url: string, payload?: Record<string, unknown>) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload ? { payload } : {}),
  });
}

/** 开一轮（走真 HTTP），回那一份线上合同解析过的轮次。 */
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

/** 用服务端签发的那份起点开一场 run（客户端在线上做的就是这一发）。 */
async function startPractice(
  scenario: Scenario,
  practiceStart: { objectiveId: string; start: { originV2: unknown; goal: string; requestedTimeBudgetSeconds: number; responsePreference: string } },
) {
  const scope = { workspaceId: scenario.seeded.workspaceId, userId: scenario.seeded.userId };
  return withWorkspaceTransaction(scope, (tx) => createRunV2(tx, {
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    request: {
      version: 2,
      originV2: practiceStart.start.originV2,
      goal: practiceStart.start.goal,
      requestedTimeBudgetSeconds: practiceStart.start.requestedTimeBudgetSeconds,
      responsePreference: practiceStart.start.responsePreference,
      // 线上那一发是 `commandId`（用户的一次动作一个键）；一次用例只开一场，
      // 随机键即可——真正要钉的幂等重放在学习运行那一族自己的集测里。
      idempotencyKey: `w46-practice-${randomUUID()}`,
    },
  } as never));
}

/** 每条用例一份自己的工作区（理由见文件头）。 */
async function setup(): Promise<Scenario> {
  const seeded = await seedV2Fixture(fixtureSql, {
    objectiveStatement: "轮次里的练习必须挂在这一轮上",
    publicSummary: "轮次里的练习",
    front: { cue: "轮次练习", prompt: "这一轮的练习为什么必须指名目标？" },
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
      VALUES (${noteWithoutObjective}, ${seeded.workspaceId}, '没有目标的那一篇', ${seeded.userId})`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${versionOfPlainNote}, ${noteWithoutObjective}, ${seeded.workspaceId}, 1,
        ${tx.json({ blocks: [{ type: "paragraph", content: "这一篇只用来对照。" }] })}, 'plain-hash-0001', ${seeded.userId})`;
    await tx`UPDATE notes SET current_version_id = ${versionOfPlainNote} WHERE id = ${noteWithoutObjective}`;
  });

  const token = (await issueSession(seeded.userId, seeded.workspaceId)).token;
  return { seeded, noteWithObjective: seeded.noteId, noteWithoutObjective, token };
}

async function teardown(scenario: Scenario): Promise<void> {
  // 轮次与教学产物都是只追加：先带绕行口子删它们，再让夹具的清理收尾（含 runs/快照）。
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
  await app.register(noteLearningRoundRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  await fixtureSql.end();
  await closeDatabase();
});

test("有目标的轮次：教学面带回「练一道」的起点，锚点在这一轮上、参数与主行动同一份", async () => {
  const scenario = await setup();
  try {
    const round = await openRound(scenario.token, scenario.noteWithObjective, "这一轮的练习挂在哪里？");
    const view = await readTeaching(scenario.token, round.roundId as string);

    assert.equal(view.practices.length, 0, "还没练过就是空数组（不是读失败）");
    const practice = view.practiceStart;
    assert.ok(practice, "有 active 目标时应当给出起点");
    assert.equal(practice.objectiveId, scenario.seeded.objectiveId);
    // 锚点是**这一轮**：kind/roundId/noteId/objectiveId 四格都在（W4-5 ② 合同要求 objectiveId 必填）。
    assert.deepEqual(practice.start.originV2, {
      kind: "note_round",
      roundId: round.roundId,
      noteId: scenario.noteWithObjective,
      objectiveId: scenario.seeded.objectiveId,
    });
    // 其余三个值与主行动同一份来源（`action-resolver` 的 startPayload）：这里只钉形状，
    // 不把数值抄成第二份期望值——抄了就会在参数调整时两处一起改错。
    assert.equal(practice.start.version, 2);
    assert.equal(practice.start.goal, "stabilize");
    assert.ok(practice.start.requestedTimeBudgetSeconds >= 30 && practice.start.requestedTimeBudgetSeconds <= 180);
    assert.ok(["adaptive", "voice", "text", "structured"].includes(practice.start.responsePreference));
  } finally {
    await teardown(scenario);
  }
});

test("拿那一发起点开一场 run：练习在轮次读侧看得见，而「练一道」那一格跟着让位", async () => {
  const scenario = await setup();
  try {
    const round = await openRound(scenario.token, scenario.noteWithObjective, "练一道会不会出现在这一轮里？");
    const before = await readTeaching(scenario.token, round.roundId as string);
    const created = await startPractice(scenario, before.practiceStart!);

    const after = await readTeaching(scenario.token, round.roundId as string);
    assert.equal(after.practices.length, 1, "刚开出来的那一场必须出现在这一轮的练习里");
    assert.equal(after.practices[0].runId, created.runId);
    assert.equal(after.practices[0].outcome, null, "还没结算就没有结论");
    assert.ok(
      ["preparing", "active", "assessing", "checkpoint", "committing", "paused"].includes(after.practices[0].phase),
      `刚开出来的那一场不该是终态：${after.practices[0].phase}`,
    );
    // 目标已经有一场开着 ⇒ 主行动是 `resume_run`，这一格如实变 null：再开一场会同时
    // 两场进行中（那件不该发生的事）。"继续那一场"由主行动那颗按钮负责，
    // 教学面不重复摆一颗会把两件事都说糊的按钮。
    assert.equal(after.practiceStart, null, "已有一场开着时不该再给一份新起点");

    // 负对照：**同一目标的另一场 run**（origin 不是这一轮）不算这一轮的练习——
    // 少了它，上面那条"长度 1"在"根本没按 roundId 过滤"的实现上也会绿。
    const scope = { workspaceId: scenario.seeded.workspaceId, userId: scenario.seeded.userId };
    await withWorkspaceTransaction(scope, (tx) => createRunV2(tx, {
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      request: {
        version: 2,
        originV2: { kind: "today", objectiveId: scenario.seeded.objectiveId },
        goal: "stabilize",
        idempotencyKey: `w46-other-${randomUUID()}`,
      },
    } as never));
    const withOther = await readTeaching(scenario.token, round.roundId as string);
    assert.equal(withOther.practices.length, 1, "别的来源的那一场混进了这一轮的练习里");
    assert.equal(withOther.practices[0].runId, created.runId);
  } finally {
    await teardown(scenario);
  }
});

test("结算回轮次：结论读得出来，且轮次一个字没动（不重开、不重播、不生成解释）", async () => {
  const scenario = await setup();
  try {
    const round = await openRound(scenario.token, scenario.noteWithObjective, "练完之后这一轮会怎样？");
    const before = await readTeaching(scenario.token, round.roundId as string);
    const created = await startPractice(scenario, before.practiceStart!);
    const scope = { workspaceId: scenario.seeded.workspaceId, userId: scenario.seeded.userId };

    // 走确定性那一档（declared_unable）：这一段要测的是"结算之后轮次读侧看得见什么"，
    // 不是判分质量。
    const view = await withWorkspaceTransaction(scope, (tx) => getRunPublicView(tx, { ...scope, runId: created.runId }));
    const task = view.activeTask!;
    const variant = task.activeVariant;
    const receipt = await withWorkspaceTransaction(scope, (tx) => submitArtifact(tx, {
      ...scope,
      runId: created.runId,
      taskId: view.activeTaskId!,
      request: {
        version: 1,
        variantId: variant.variantId,
        variantRevision: variant.revision,
        runRevision: view.revision,
        taskRevision: task.revision,
        inputSchemaHash: variant.inputSchemaHash,
        payload: { kind: "declared_unable", reasonCode: "cannot_recall" },
        idempotencyKey: `w46-practice-${randomUUID()}`,
      },
    })) as { artifactStatus: string };
    assert.equal(receipt.artifactStatus, "locked");

    let phase = "";
    for (let tick = 0; tick < 8; tick += 1) {
      const result = await runLearningRunProcessingTick(`w46-practice-${randomUUID()}`, 10);
      assert.equal(result.failed, 0, `tick 报 failed=${result.failed}`);
      const probe = await withWorkspaceTransaction(scope, (tx) => getRunPublicView(tx, { ...scope, runId: created.runId }));
      phase = probe.phase;
      if (phase === "completed" || phase === "checkpoint") break;
    }
    assert.equal(phase, "completed", "这一场练习走不到终态");

    const after = await readTeaching(scenario.token, round.roundId as string);
    assert.equal(after.practices.length, 1);
    assert.equal(after.practices[0].outcome, "declared_unable", "结算的结论要能读得出来");

    // 轮次一个字没动：phase 还是 active、revision 还是开出来的那一版、问题没有被改写。
    const rows = await fixtureSql`
      SELECT phase, revision, driving_question_revision FROM note_learning_rounds WHERE id = ${round.roundId as string}`;
    const row = (rows[0] ?? {}) as Record<string, unknown>;
    assert.equal(row.phase, "active");
    assert.equal(Number(row.revision), Number(round.revision));
    assert.equal(Number(row.driving_question_revision), 1);

    // 结算不重开轮次：这一篇名下仍然只有这一轮。
    const rounds = await fixtureSql`SELECT count(*)::int AS total FROM note_learning_rounds WHERE note_id = ${scenario.noteWithObjective}`;
    assert.equal(Number(rounds[0]?.total ?? 0), 1, "结算之后冒出了第二条轮次");

    // 结算不重播奖励／不生成解释：练习是练习，不会顺手产出一条教学产物。
    const teachings = await fixtureSql`SELECT count(*)::int AS total FROM note_learning_round_teachings WHERE round_id = ${round.roundId as string}`;
    assert.equal(Number(teachings[0]?.total ?? 0), 0, "一场练习不该生成教学产物");
  } finally {
    await teardown(scenario);
  }
});

test("没有目标的轮次：不给「练一道」的起点（练习只在目标存在时开 run）", async () => {
  const scenario = await setup();
  try {
    const round = await openRound(scenario.token, scenario.noteWithoutObjective, "这一篇没有目标还能练吗？");
    const view = await readTeaching(scenario.token, round.roundId as string);
    assert.equal(view.practiceStart, null, "这一篇没有 active 目标 ⇒ 不该给起点");
    assert.equal(view.practices.length, 0);
    // 对照：同一个工作区里**有** active 目标（在另一篇名下）——那条收窄是按 noteId 判的，
    // 不是"这个工作区有没有目标"。这条对照让上面那个 null 不是"因为库里没有目标"。
    const rows = await fixtureSql`
      SELECT count(*)::int AS total FROM learning_objectives_v2
      WHERE workspace_id = ${scenario.seeded.workspaceId} AND lifecycle = 'active'`;
    assert.ok(Number(rows[0]?.total ?? 0) >= 1, "对照失效：这个工作区里根本没有 active 目标");
  } finally {
    await teardown(scenario);
  }
});
