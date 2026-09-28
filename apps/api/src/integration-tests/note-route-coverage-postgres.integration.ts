/**
 * 跨轮聚合的读侧（39d W4-5 ③；PRD §4.4、§16.23）。
 *
 * 这一份钉的是**四条案例验收**里属于 W4-5 的那几条，以及它们各自依赖的边界：
 *
 *  - **§16.23 完整路线跨轮结束与内容新增**（主用例）：三轮走完纳入的核心问题，
 *    其中一处借助帮助完成；另一个问题因材料矛盾未能学习 ⇒ 跨轮进展可汇总、
 *    借助完成如实保留、**未解决的材料矛盾不假装已覆盖**、缩小路线范围须说明。
 *  - **§16.17 内容未变，路线重新组织**：同一篇再开一轮时复用已有目标 ⇒ 分母不膨胀
 *    （一个目标被两轮走过仍然只算**一条**），而"新内容"才让分母加一。
 *  - **§16.14 中断、重试与回放**：暂停/未完的一轮**不**把问题算成已覆盖；
 *    重跑同一轮不产生第二条路线记录。
 *  - **§16.39 普通问答与多端继续**：一个**不属于本篇**的 run（origin 指别的笔记）
 *    不许混进这一篇的分母——否则"这一篇走到哪"会算上别人的进度。
 *
 * 口径与轮次族其他几份一致：夹具走 `DATABASE_URL_MIGRATOR`（超户），被测的读侧经
 * `withWorkspaceTransaction` 跑在 `DATABASE_URL_API`（受限角色）上。
 *
 * **不调用真实模型**：讲解走确定性 provider，作答的结论是**直接写进 `learning_runs.result`
 * 的夹具**——跨轮聚合这一层只读事实，不判分，所以不需要跑评估链，也不声称
 * 「用户真的答了」。这是夹具边界，交付说明里照写。
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { noteRouteCoverageV1Schema } from "@ailearn/shared/note-route-coverage-v2";

const fixtureUrl = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!fixtureUrl || !process.env.DATABASE_URL_API) {
  throw new Error("跨轮聚合集测需要 DATABASE_URL_MIGRATOR（夹具）＋DATABASE_URL_API（受限角色，读侧跑在它上面）");
}
process.env.DATABASE_URL_API ??= fixtureUrl;
const fixtureSql = postgres(fixtureUrl, { max: 4 });

const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const { readNoteRouteCoverageV1 } = await import("../modules/note-learning-rounds/route-coverage.ts");
const { seedV2Fixture, seedObjectiveNoteEvidence } = await import("./helpers/v2-card-fixture.ts");
const { advanceRound, appendPlanRevision, createRound, readRound } = await import("../modules/note-learning-rounds/round-service.ts");
const { roundBudgetsV1 } = await import("../modules/note-learning-rounds/round-budgets.ts");

interface Scenario {
  seeded: Awaited<ReturnType<typeof seedV2Fixture>>;
  noteId: string;
  /** 同一工作区里另一篇（§16.39 的负对照：别的笔记的 run 不许混进来）。 */
  otherNoteId: string;
  /** 这一版正文的哈希（`note_versions.content_hash` 的真值，不编一个）。 */
  contentHash: string;
  scope: { workspaceId: string; userId: string };
}

after(async () => {
  await fixtureSql.end();
  await closeDatabase();
});

/** 一份全新的工作区：跨轮聚合的用例会写目标绑定与 run，共用会互相污染。 */
async function setup(): Promise<Scenario> {
  const seeded = await seedV2Fixture(fixtureSql, {
    objectiveStatement: "跨轮聚合要按核心问题归并",
    publicSummary: "跨轮聚合",
    front: { cue: "跨轮聚合", prompt: "跨轮聚合的归属点在哪里？" },
  });
  await seedObjectiveNoteEvidence(fixtureSql, seeded);
  const otherNoteId = randomUUID();
  const otherVersionId = randomUUID();
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
    await tx`UPDATE notes SET current_version_id = ${seeded.noteVersionId} WHERE id = ${seeded.noteId}`;
    await tx`INSERT INTO notes (id, workspace_id, title, created_by)
      VALUES (${otherNoteId}, ${seeded.workspaceId}, '对照用的另一篇', ${seeded.userId})`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${otherVersionId}, ${otherNoteId}, ${seeded.workspaceId}, 1,
        ${tx.json({ blocks: [{ type: "paragraph", content: "这一篇只用来对照。" }] })}, 'other-hash-01', ${seeded.userId})`;
    await tx`UPDATE notes SET current_version_id = ${otherVersionId} WHERE id = ${otherNoteId}`;
  });
  const hashRows = await fixtureSql`SELECT content_hash FROM note_versions WHERE id = ${seeded.noteVersionId}`;
  return {
    seeded, noteId: seeded.noteId, otherNoteId, contentHash: String(hashRows[0]?.content_hash ?? ""),
    scope: { workspaceId: seeded.workspaceId, userId: seeded.userId },
  };
}

async function teardown(scenario: Scenario): Promise<void> {
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${scenario.scope.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${scenario.scope.userId}, true)`;
    await tx`SELECT set_config('app.allow_history_mutation', 'on', true)`;
    // 次序是 0292/0283 两条只追加触发器定的，不是这里选的：
    //  · `note_learning_round_targets` **没有** `ON DELETE CASCADE`，而它的触发器
    //    只在「那一轮已经不存在」时放行 DELETE —— 所以**必须先删轮次**，
    //    再删绑定行（反过来删会在轮次还在时被挡下）。
    //  · 计划修订（0283）有 `app.allow_history_mutation` 绕行口子，任意次序都行。
    await tx`DELETE FROM note_learning_round_plan_revisions WHERE workspace_id = ${scenario.scope.workspaceId}`;
    await tx`DELETE FROM note_learning_rounds WHERE workspace_id = ${scenario.scope.workspaceId}`;
    await tx`DELETE FROM note_learning_round_targets WHERE workspace_id = ${scenario.scope.workspaceId}`;
  });
  await scenario.seeded.cleanup();
}

async function readRoute(scenario: Scenario, noteId = scenario.noteId) {
  const facts = await withWorkspaceTransaction(scenario.scope, (tx) => readNoteRouteCoverageV1(tx, scenario.scope, noteId));
  return noteRouteCoverageV1Schema.parse(facts.coverage);
}

/** 开一轮并写一条计划（走真服务，走 CAS 那条路）。 */
async function openRound(scenario: Scenario, question: string, steps = 4) {
  const round = await withWorkspaceTransaction(scenario.scope, (tx) => createRound(tx, scenario.scope, {
    noteId: scenario.noteId,
    noteVersionId: scenario.seeded.noteVersionId,
    sourceContentHash: scenario.contentHash,
    evidenceSnapshotIds: [],
    drivingQuestion: question,
    drivingQuestionSource: "suggested",
    budgets: roundBudgetsV1(),
  }));
  await withWorkspaceTransaction(scenario.scope, (tx) => appendPlanRevision(tx, scenario.scope, {
    roundId: round.roundId,
    expectedRevision: round.revision,
    plan: { version: 1, steps: planSteps(steps), endCondition: "能说明白这一节在讲什么" },
    reason: "最初的路线",
  }));
  // 写计划会推进那个共用计数器，所以把最新的一版读回来给调用方（后面封存要用它）。
  return (await withWorkspaceTransaction(scenario.scope, (tx) => readRound(tx, scenario.scope, round.roundId)))!;
}

/**
 * 封存上一轮，让下一轮开得出来。
 *
 * 这不是绕过产品规则，而是**按它走**：0282 的部分唯一索引保证同
 * `(workspace,user,note)` 至多一条 `active/paused`，所以"同一篇开第二轮"在产品上
 * 必须先收尾上一轮（§4.4「用户可以调整」也是这么发生的）。跨轮聚合正是在这种
 * 真实的「收尾 → 再开」序列上读出来的。
 */
async function closeRound(scenario: Scenario, roundId: string, expectedRevision: number, outcome: "completed" | "partial" = "completed") {
  return withWorkspaceTransaction(scenario.scope, (tx) => advanceRound(tx, scenario.scope, {
    roundId, expectedRevision, action: { kind: "close", outcome },
  }));
}

function planSteps(count: number): { text: string }[] {
  return Array.from({ length: count }, (_, index) => ({ text: `第 ${index + 1} 步：读懂这一段并找依据` }));
}

/** 把这一轮的某个目标绑定写进去（模拟 `persistRoundTarget` 落的那一行）。 */
async function bindTarget(scenario: Scenario, roundId: string, objectiveId: string, revisionId: string) {
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${scenario.scope.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${scenario.scope.userId}, true)`;
    await tx`INSERT INTO note_learning_round_targets
      (workspace_id, user_id, round_id, driving_question_revision, objective_id, objective_revision_id)
      VALUES (${scenario.scope.workspaceId}, ${scenario.scope.userId}, ${roundId}, 1, ${objectiveId}, ${revisionId})`;
  });
}

/**
 * 造一发"做过一次练习"的 run 事实。
 *
 * **只写事实、不判分**：`learning_runs.result` 那一格是结算真落库的地方
 * （`run-processing-tick` 写它），跨轮聚合这一层只读它。所以这里直接按那个形状写，
 * 并**如实声明这是夹具**——它不声称用户真的答了任何东西。
 */
async function seedRunAttempt(
  scenario: Scenario,
  input: {
    roundId: string | null;
    objectiveId: string;
    outcome: "demonstrated" | "partial" | "skipped" | "not_assessable" | "needs_repair" | "practice_completed" | "declared_unable" | null;
    lockedAt: Date | null;
    settledAt: Date | null;
    noteId?: string;
  },
): Promise<string> {
  const runId = randomUUID();
  const settledAt = input.settledAt?.toISOString() ?? null;
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${scenario.scope.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${scenario.scope.userId}, true)`;
    await tx`INSERT INTO learning_runs
      (id, workspace_id, user_id, origin, return_target, target_fingerprint, goal, phase, result)
      VALUES (
        ${runId}, ${scenario.scope.workspaceId}, ${scenario.scope.userId},
        ${tx.json({
          version: 2, kind: "note_round",
          roundId: input.roundId, noteId: input.noteId ?? scenario.noteId, objectiveId: input.objectiveId,
        })},
        ${tx.json({ kind: "note_round", roundId: input.roundId })},
        'fp-cross-round', 'clarify',
        ${input.outcome === null ? "active" : "completed"},
        ${input.outcome === null ? null : tx.json({ version: 1, outcome: input.outcome, settledAt })}
      )`;
    if (input.lockedAt !== null) {
      const taskId = randomUUID();
      const variantId = randomUUID();
      const artifactId = randomUUID();
      await tx`INSERT INTO learning_tasks
        (id, run_id, workspace_id, user_id, sequence, intent, prompt, target_summary, status, revision)
        VALUES (${taskId}, ${runId}, ${scenario.scope.workspaceId}, ${scenario.scope.userId}, 1,
          'explain', '这一轮的问题是什么？', '跨轮聚合', 'completed', 1)`;
      // **列形状从 `information_schema` 量出来的，不照抄 0116 或任何一份夹具清单**
      // （39d claims §8.1 那条教训：「坐标会腐烂，量出来的东西不会」）。实测这条表上
      // `private_solution_hash` / `safety_report_hash` 是 NOT NULL——0116 建表时还没有它们。
      await tx`INSERT INTO learning_task_variants
        (id, task_id, workspace_id, user_id, purpose, template_trust_ceiling, estimated_active_seconds,
         interaction, public_payload_hash, input_schema_hash, disclosure_profile_hash,
         private_solution_hash, safety_report_hash, rubric_target_ids, revision, status)
        VALUES (${variantId}, ${taskId}, ${scenario.scope.workspaceId}, ${scenario.scope.userId},
          'formal', 'mastery_eligible', 30, ${tx.json({ kind: "open_ended" })},
          'pph', 'ish', 'dsh', 'vpsh', 'srh', ${tx.json([])}, 1, 'active')`;
      await tx`INSERT INTO learning_artifacts
        (id, run_id, task_id, variant_id, workspace_id, user_id, revision, payload, payload_hash,
         public_payload_hash, input_schema_hash, private_solution_hash, safety_report_hash,
         disclosure_profile_hash, assistance_snapshot_hash, status, locked_at)
        VALUES (${artifactId}, ${runId}, ${taskId}, ${variantId}, ${scenario.scope.workspaceId},
          ${scenario.scope.userId}, 1, ${tx.json({})}, 'ph', 'pph', 'ish', 'psh', 'srh', 'dsh', 'ash',
          'locked', ${input.lockedAt})`;
    }
  });
  return runId;
}

/** 记一笔答案级暴露（`learning_exposures_v2`）。 */
async function seedExposure(scenario: Scenario, objectiveId: string, at: Date, kind = "answer_reveal") {
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${scenario.scope.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${scenario.scope.userId}, true)`;
    await tx`INSERT INTO learning_exposures_v2
      (workspace_id, exposure_id, user_id, objective_id, objective_revision, exposure_kind, context_hash,
       idempotency_key, exposed_at)
      VALUES (${scenario.scope.workspaceId}, ${randomUUID()}, ${scenario.scope.userId}, ${objectiveId}, 1,
        ${kind}, 'ctx', ${`cross-round-${randomUUID()}`}, ${at})`;
  });
}

/** 写一条带待核对警示的教学产物行（那一档在分母里，靠的就是它）。 */
async function seedTeachingWithSuspectClaim(
  scenario: Scenario,
  roundId: string,
  claim: { unitId: string; sourceQuote: string; reason: string },
) {
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${scenario.scope.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${scenario.scope.userId}, true)`;
    await tx`INSERT INTO note_learning_round_teachings
      (id, workspace_id, user_id, round_id, ordinal, kind, content, source_block_ordinals,
       snapshot_hash, driving_question_revision)
      VALUES (${randomUUID()}, ${scenario.scope.workspaceId}, ${scenario.scope.userId}, ${roundId}, 1,
        'explanation',
        ${tx.json({
          // **不带 `version`**：`roundTeachingContentV1Schema` 是 `strictObject`，正文那一层
          // 没有版本格（版本由 0284 行的 `driving_question_revision` 与 `snapshot_hash` 承担）。
          // 第一版顺手写了个 `version: 1`，于是**整条教学行在读侧被 safeParse 丢掉**，
          // 待核对那一档跟着整个消失——症状是"分母里少一条"，而原因在夹具上。
          explanation: "这一节先讲一个能站住的结论。",
          suspectClaims: [{
            unitIds: [claim.unitId], sourceBlockOrdinal: 3, sourceQuote: claim.sourceQuote,
            reason: claim.reason,
          }],
        })},
        ARRAY[1,2,3]::integer[], 'snapshot-hash-01', 1)`;
  });
}

test("§16.23 前置：这一篇还没有纳入过任何核心问题时是「不承诺覆盖」，不是「已完成」", async () => {
  const scenario = await setup();
  try {
    const route = await readRoute(scenario);
    // 变异自证：空集合也发 route_complete ⇒ 本条红。
    assert.equal(route.verdict.kind, "no_questions");
    assert.equal(route.summary.totalCount, 0);
    assert.deepEqual(route.verdict.uncovered, []);
  } finally { await teardown(scenario); }
});

test("§16.23：跨轮进展可汇总；独立做过与借助完成分别如实保留", async () => {
  const scenario = await setup();
  try {
    const objectiveId = scenario.seeded.objectiveId;
    const revisionId = scenario.seeded.objectiveRevisionId;
    const roundOne = await openRound(scenario, "第一轮：先弄懂机制");
    // §4.4 的多轮就是这样发生的：收尾上一轮再开下一轮（0282 的部分唯一索引也要求如此）。
    await closeRound(scenario, roundOne.roundId, roundOne.revision);
    const roundTwo = await openRound(scenario, "第二轮：换个情境用一次");
    // 两轮都绑**同一个**目标（§4.2 复用身份）⇒ 归并成一条，不是两条。
    await bindTarget(scenario, roundOne.roundId, objectiveId, revisionId);
    await bindTarget(scenario, roundTwo.roundId, objectiveId, revisionId);

    const assistedAt = new Date("2026-09-27T09:00:00.000Z");
    const lockedAt = new Date("2026-09-27T10:00:00.000Z");
    // 第一轮：只答了一半（还差着）。
    await seedRunAttempt(scenario, {
      roundId: roundOne.roundId, objectiveId, outcome: "partial",
      lockedAt: new Date("2026-09-20T10:00:00.000Z"), settledAt: new Date("2026-09-20T10:05:00.000Z"),
    });
    // 第二轮：锁定前看过答案 ⇒ 借助完成。
    await seedExposure(scenario, objectiveId, assistedAt);
    await seedRunAttempt(scenario, {
      roundId: roundTwo.roundId, objectiveId, outcome: "demonstrated",
      lockedAt, settledAt: new Date("2026-09-27T10:05:00.000Z"),
    });

    const route = await readRoute(scenario);
    assert.equal(route.questions.length, 1, "同一个目标被两轮走过仍然只算一条（§4.2 复用身份）");
    const question = route.questions[0]!;
    assert.equal(question.state, "learned_with_help", "借助完成要如实保留，不冒充独立");
    assert.equal(question.stateHelpCondition, "assisted");
    assert.equal(question.attempts.length, 2, "两轮各一发都在，§5.6 那种「展开到实际作答」要拿得到");
    assert.equal(question.roundIds.length, 2, "两轮都要能点回去");
    assert.equal(route.summary.assistedCount, 1);
    assert.equal(route.summary.independentCount, 0);
    // 变异自证：把 lockedAt 那一列换成 settledAt（评分返回时间）⇒ 本条红。
  } finally { await teardown(scenario); }
});

test("§16.23：锁定**前**的暴露让这一次落成借助，锁定**后**的那一笔不追溯", async () => {
  const scenario = await setup();
  try {
    const objectiveId = scenario.seeded.objectiveId;
    const round = await openRound(scenario, "这一轮：先看线索再作答");
    await bindTarget(scenario, round.roundId, objectiveId, scenario.seeded.objectiveRevisionId);
    const lockedAt = new Date("2026-09-27T10:00:00.000Z");
    await seedExposure(scenario, objectiveId, new Date("2026-09-27T09:30:00.000Z"));
    await seedExposure(scenario, objectiveId, new Date("2026-09-27T10:30:00.000Z"), "evidence_reveal");
    await seedRunAttempt(scenario, {
      roundId: round.roundId, objectiveId, outcome: "demonstrated",
      lockedAt, settledAt: new Date("2026-09-27T10:05:00.000Z"),
    });
    const route = await readRoute(scenario);
    // 09:30 那笔在锁定前 ⇒ 借助；10:30 那笔是提交后的反馈，**不**追溯。
    // 变异自证：改成只看最后一笔 ⇒ 本条红（会读成 independent）。
    assert.equal(route.questions[0]?.state, "learned_with_help");
  } finally { await teardown(scenario); }
});

test("§16.23：因材料矛盾没能学的那一条**不假装已覆盖**（它留在分母里）", async () => {
  const scenario = await setup();
  try {
    const objectiveId = scenario.seeded.objectiveId;
    const round = await openRound(scenario, "这一轮：材料里有一处自相矛盾");
    await bindTarget(scenario, round.roundId, objectiveId, scenario.seeded.objectiveRevisionId);
    await seedTeachingWithSuspectClaim(scenario, round.roundId, {
      unitId: "unit-cross-round-7", sourceQuote: "写入一定比批量慢。", reason: "同一段里两句话给出的结论相反",
    });
    await seedRunAttempt(scenario, {
      roundId: round.roundId, objectiveId, outcome: "demonstrated",
      lockedAt: new Date("2026-09-27T10:00:00.000Z"), settledAt: new Date("2026-09-27T10:05:00.000Z"),
    });

    const route = await readRoute(scenario);
    // 变异自证：把待核对那一档从分母里滤掉 ⇒ 本条红（`questions.length` 与
    // `verdict.kind` 两处同时会变，而正是这一处让"已走完"被说出口）。
    assert.equal(route.questions.length, 2, "待核对的那一条必须在分母里");
    const blocked = route.questions.find((q) => q.kind === "material_conflict");
    assert.ok(blocked, "待核对那一档要能被读到");
    assert.equal(blocked!.state, "blocked_by_material_conflict");
    assert.equal(blocked!.conflictReason, "同一段里两句话给出的结论相反");
    assert.equal(route.verdict.kind, "route_incomplete", "还有一条没覆盖，就不能说已走完");
    assert.equal(route.verdict.uncovered.length, 1);
  } finally { await teardown(scenario); }
});

test("§4.4：范围被缩小过时结论注明按调整后的范围完成，且未覆盖的照旧列着", async () => {
  const scenario = await setup();
  try {
    const objectiveId = scenario.seeded.objectiveId;
    const round = await openRound(scenario, "这一轮：路线中途被缩小过", 4);
    await bindTarget(scenario, round.roundId, objectiveId, scenario.seeded.objectiveRevisionId);
    await seedRunAttempt(scenario, {
      roundId: round.roundId, objectiveId, outcome: "demonstrated",
      lockedAt: new Date("2026-09-27T10:00:00.000Z"), settledAt: new Date("2026-09-27T10:05:00.000Z"),
    });
    // 计划从四步改成两步（D3 §5 要求带理由）。
    const current = await withWorkspaceTransaction(scenario.scope, (tx) => readRound(tx, scenario.scope, round.roundId));
    await withWorkspaceTransaction(scenario.scope, (tx) => appendPlanRevision(tx, scenario.scope, {
      roundId: round.roundId,
      expectedRevision: current!.revision,
      plan: { version: 1, steps: planSteps(2), endCondition: "能说明白这一节在讲什么" },
      reason: "这次时间不够，只走前两段",
    }));

    const route = await readRoute(scenario);
    // 变异自证：把 `< previous` 改成 `!== previous`（改措辞也算缩小）⇒ 本条红。
    assert.equal(route.verdict.kind, "route_complete_within_adjusted_scope");
    assert.equal(route.verdict.scopeAdjustmentReason, "这次时间不够，只走前两段");
    assert.equal(route.questions.length, 1, "缩小范围不许动分母");
  } finally { await teardown(scenario); }
});

test("§4.4：步数没变的计划修订**不**改结论口径", async () => {
  const scenario = await setup();
  try {
    const round = await openRound(scenario, "这一轮：计划只改了措辞", 3);
    const current = await withWorkspaceTransaction(scenario.scope, (tx) => readRound(tx, scenario.scope, round.roundId));
    await withWorkspaceTransaction(scenario.scope, (tx) => appendPlanRevision(tx, scenario.scope, {
      roundId: round.roundId, expectedRevision: current!.revision,
      plan: { version: 1, steps: planSteps(3).map((s) => ({ text: `${s.text}（换个说法）` })), endCondition: "能说明白这一节在讲什么" },
      reason: "只是把措辞改得更好读",
    }));
    const route = await readRoute(scenario);
    assert.equal(route.verdict.scopeAdjustedAt, null, "同一份范围不该改结论口径");
    // 变异自证：改成"步数只要不等于就算缩小"⇒ 本条红。
  } finally { await teardown(scenario); }
});

test("§16.14：暂停/未完的一轮**不**把问题算成已覆盖", async () => {
  const scenario = await setup();
  try {
    const objectiveId = scenario.seeded.objectiveId;
    const round = await openRound(scenario, "这一轮：还在进行中");
    await bindTarget(scenario, round.roundId, objectiveId, scenario.seeded.objectiveRevisionId);
    // 还在跑：没有锁定回答，也还没有结论。
    await seedRunAttempt(scenario, { roundId: round.roundId, objectiveId, outcome: null, lockedAt: null, settledAt: null });
    const route = await readRoute(scenario);
    // §5.5：「系统故障与评分待返回是附加原因，不作为『不会』的终态」。
    assert.equal(route.questions[0]?.state, "in_progress");
    assert.equal(route.verdict.kind, "route_incomplete");
    // 变异自证：把 in_progress 归进 not_attempted 或已覆盖 ⇒ 本条红。
  } finally { await teardown(scenario); }
});

test("§16.39：不属于本篇的 run 不许混进这一篇的分母", async () => {
  const scenario = await setup();
  try {
    const objectiveId = scenario.seeded.objectiveId;
    const round = await openRound(scenario, "这一轮：正题");
    await bindTarget(scenario, round.roundId, objectiveId, scenario.seeded.objectiveRevisionId);
    // 同一篇的目标，但这一发锚在**对照那一篇**的轮次上——不该被算进这一篇。
    await seedRunAttempt(scenario, {
      roundId: null, objectiveId, outcome: "demonstrated",
      lockedAt: new Date("2026-09-27T10:00:00.000Z"), settledAt: new Date("2026-09-27T10:05:00.000Z"),
      noteId: scenario.otherNoteId,
    });
    const route = await readRoute(scenario);
    // §16.39：两个窗口/两个入口恢复的是同一轮；别的笔记的进度不是这一篇的进度。
    // 变异自证：把 origin 的筛选摘掉 ⇒ 本条红。
    assert.equal(route.questions[0]?.state, "not_attempted", "锚在别的笔记上的那一发不算这一篇练过");
    const otherRoute = await readRoute(scenario, scenario.otherNoteId);
    assert.equal(otherRoute.verdict.kind, "no_questions", "那一篇自己没有轮次，就是没有路线");
  } finally { await teardown(scenario); }
});

test("§16.17：同一篇再开一轮时复用已有目标，分母不膨胀", async () => {
  const scenario = await setup();
  try {
    const objectiveId = scenario.seeded.objectiveId;
    const revisionId = scenario.seeded.objectiveRevisionId;
    const before = await readRoute(scenario);
    // 先走一轮把目标纳进来。
    const roundOne = await openRound(scenario, "第一轮：先弄懂");
    await bindTarget(scenario, roundOne.roundId, objectiveId, revisionId);
    await seedRunAttempt(scenario, {
      roundId: roundOne.roundId, objectiveId, outcome: "demonstrated",
      lockedAt: new Date("2026-09-20T10:00:00.000Z"), settledAt: new Date("2026-09-20T10:05:00.000Z"),
    });
    const afterOne = await readRoute(scenario);
    assert.equal(afterOne.questions.length, 1);

    // 内容未变，**再开一轮**（§4.2：先匹配复用适用目标，不另建身份）。
    await closeRound(scenario, roundOne.roundId, roundOne.revision);
    const roundTwo = await openRound(scenario, "第二轮：换个角度再看一次");
    await bindTarget(scenario, roundTwo.roundId, objectiveId, revisionId);
    const afterTwo = await readRoute(scenario);
    // 变异自证：按 (round, objective) 分组而不是按 objective ⇒ 本条红。
    assert.equal(afterTwo.questions.length, 1, "同一个目标被两轮走过仍只算一条");
    assert.equal(afterTwo.questions[0]?.roundIds.length, 2);
    assert.equal(afterTwo.summary.totalCount, afterOne.summary.totalCount);
    assert.equal(afterOne.verdict.kind, "route_complete");
    assert.equal(afterTwo.verdict.kind, "route_complete");
    assert.ok(before.verdict.kind === "no_questions");
  } finally { await teardown(scenario); }
});

test("读侧是**只读**的：读两次结果逐字相同，且库里的行数一个都没多", async () => {
  const scenario = await setup();
  try {
    const objectiveId = scenario.seeded.objectiveId;
    const round = await openRound(scenario, "这一轮：先看看路线");
    await bindTarget(scenario, round.roundId, objectiveId, scenario.seeded.objectiveRevisionId);
    await seedRunAttempt(scenario, {
      roundId: round.roundId, objectiveId, outcome: "demonstrated",
      lockedAt: new Date("2026-09-27T10:00:00.000Z"), settledAt: new Date("2026-09-27T10:05:00.000Z"),
    });
    const countRows = async () => {
      const rows = await fixtureSql.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${scenario.scope.workspaceId}, true)`;
        await tx`SELECT set_config('app.user_id', ${scenario.scope.userId}, true)`;
        return tx`SELECT (SELECT count(*) FROM note_learning_rounds)::int AS rounds,
                       (SELECT count(*) FROM note_learning_round_targets)::int AS targets,
                       (SELECT count(*) FROM learning_runs)::int AS runs`;
      });
      return JSON.stringify(rows[0]);
    };
    const before = await countRows();
    const first = await readRoute(scenario);
    const second = await readRoute(scenario);
    const after = await countRows();
    // §6.7：聚合结论不落库，所以读一次与读两次逐字相同。
    // 变异自证：在读侧里写一行 ⇒ 本条红。
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(before, after, "读这一层不许写任何一行");
  } finally { await teardown(scenario); }
});
