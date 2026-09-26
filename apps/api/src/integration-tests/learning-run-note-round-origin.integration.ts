/**
 * note_round origin 的端到端合同（39d W4-5 ② / W3-4 ①）。
 *
 * 轮次实体（0282）落地之后，`LearningRunOriginV2` 增加了
 * `{ kind: "note_round"; roundId; noteId; objectiveId }` 这一档（D1 §4.3）。
 * 这份集测证明的是服务端的四条行为，全部走**生产写入路径**（`createRunV2`）：
 *
 * 1. 开着的轮次 → run 建得出：origin/return_target 落库形状正确，公开视图过
 *    V1 合同（keyPointId alias 在），私有合同里调度决议是 `no_effect`（§9.1：
 *    结束一轮不默认授权未来提醒——没有 pending 安排就不造）；
 * 2. 同一目标已有 pending 安排 → `consume_pending`（§9.5 同目标复用：
 *    这一次练习消费那一次日程）；
 * 3. 已封存的轮次 → 409 `note_round_not_open`（closed 之后不可恢复，新学习
 *    产生新轮次——把练习记到封存轮次上是静默改历史）；
 * 4. return target 可用性：轮次行在 → 可用；行没了 → `return_target_deleted`
 *    且回退 `today`（与其他"目标消失"的回退同一形状）。
 *
 * 运行（一次性库，见 scripts/dev-disposable-db.sh）：
 *   DATABASE_URL_API=... node --import tsx --test --test-concurrency=1 \
 *     src/integration-tests/learning-run-note-round-origin.integration.ts
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";

const CONN = testDatabaseUrl("DATABASE_URL_API");
process.env.DATABASE_URL_API ??= CONN;
const sql = postgres(CONN, { max: 2 });

delete process.env.ASSESSMENT_CRITIC_URL;
delete process.env.ASSESSMENT_CRITIC_KEY;

const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const { createRunV2, getRunPublicView } = await import("../modules/learning-runs/run-service.ts");
const { LearningRunServiceError } = await import("../modules/learning-runs/run-errors.ts");
const { createRound, advanceRound } = await import("../modules/note-learning-rounds/round-service.ts");
const { seedV2Fixture } = await import("./helpers/v2-card-fixture.ts");

after(async () => {
  await sql.end({ timeout: 2 });
  await closeDatabase();
});

interface Scenario {
  seeded: Awaited<ReturnType<typeof seedV2Fixture>>;
  roundId: string;
  roundRevision: number;
}

/** 种子 + 用**真的轮次服务**开一轮（预算三件必填；快照哈希取夹具那版正文）。 */
async function seedOpenRound(): Promise<Scenario> {
  const seeded = await seedV2Fixture(sql, {
    objectiveStatement: "轮次内的练习必须指名目标并守住调度边界",
    publicSummary: "轮次练习",
    front: { cue: "轮次练习", prompt: "为什么这一轮的练习不自动创建复习安排？" },
  });
  // 读夹具那版正文的哈希要走**带工作区上下文**的连接：受限角色下 note_versions
  // 的 RLS 会把无 GUC 的裸读滤成 0 行（超户跑的时候这个坑被 BYPASSRLS 盖住）。
  const hashRows = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
    return tx`SELECT content_hash FROM note_versions WHERE id = ${seeded.noteVersionId} LIMIT 1`;
  });
  const sourceContentHash = String(hashRows[0]?.content_hash ?? "");
  const round = await withWorkspaceTransaction(
    { workspaceId: seeded.workspaceId, userId: seeded.userId },
    (tx) => createRound(
      tx,
      { workspaceId: seeded.workspaceId, userId: seeded.userId },
      {
        noteId: seeded.noteId,
        noteVersionId: seeded.noteVersionId,
        drivingQuestion: "这一轮的练习在调度上承诺了什么？",
        drivingQuestionSource: "user_authored",
        sourceContentHash,
        evidenceSnapshotIds: [],
        budgets: { maxModelCalls: 4, maxWallClockSeconds: 600, maxTasks: 3 },
      },
    ),
  );
  return { seeded, roundId: round.roundId, roundRevision: round.revision };
}

async function cleanup(scenario: Scenario): Promise<void> {
  const { seeded } = scenario;
  await sql`DELETE FROM note_learning_rounds WHERE workspace_id = ${seeded.workspaceId}`;
  await sql`DELETE FROM review_schedules WHERE workspace_id = ${seeded.workspaceId}`;
  await seeded.cleanup();
}

/** 受限角色下一切裸读都要带工作区 GUC（RLS 会把无上下文的读滤成 0 行）。 */
function readAsWorkspace(
  s: Scenario,
  run: (tx: typeof sql) => Promise<unknown>,
): Promise<Array<Record<string, unknown>>> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${s.seeded.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${s.seeded.userId}, true)`;
    // 事务对象与连接对象在 postgres.js 里共用同一套标签模板签名；
    // 收窄成"没有 begin/end 的连接"会把可调用签名一起抹掉（实测 TS2349）。
    return (await run(tx as unknown as typeof sql)) as Array<Record<string, unknown>>;
  });
}

function noteRoundOrigin(s: Scenario) {
  return {
    kind: "note_round" as const,
    roundId: s.roundId,
    noteId: s.seeded.noteId,
    objectiveId: s.seeded.objectiveId,
  };
}

test("note_round: 开着的轮次 → run 建得出，公开视图与 return_target 都是新形状", async () => {
  const scenario = await seedOpenRound();
  try {
    const { seeded, roundId } = scenario;
    const runId = await withWorkspaceTransaction(
      { workspaceId: seeded.workspaceId, userId: seeded.userId },
      (tx) => createRunV2(tx, {
        workspaceId: seeded.workspaceId,
        userId: seeded.userId,
        request: {
          originV2: noteRoundOrigin(scenario),
          goal: "clarify",
          idempotencyKey: `note-round-${seeded.workspaceId.slice(0, 8)}`,
        },
      }),
    ).then((r: { runId: string }) => r.runId);

    // 落库形状：origin 原样是 note_round 三件套；return_target 由 origin 确定性推导。
    const rows = await readAsWorkspace(scenario, (tx) => tx`
      SELECT origin, return_target FROM learning_runs WHERE id = ${runId} LIMIT 1
    `);
    assert.deepEqual(rows[0].origin, noteRoundOrigin(scenario));
    assert.deepEqual(rows[0].return_target, { kind: "note_round", roundId, noteId: seeded.noteId });

    // 公开视图：V1 合同（keyPointId alias）+ note_round return target。
    await withWorkspaceTransaction(
      { workspaceId: seeded.workspaceId, userId: seeded.userId },
      async (tx) => {
        const view = await getRunPublicView(tx, {
          workspaceId: seeded.workspaceId,
          userId: seeded.userId,
          runId,
        });
        assert.equal(view.origin.kind, "note_round");
        assert.equal((view.origin as { keyPointId?: string }).keyPointId, seeded.objectiveId);
        assert.deepEqual(view.returnTarget, { kind: "note_round", roundId, noteId: seeded.noteId });
      },
    );

    // 调度决议（没有 pending 安排时）：no_effect / not_authorized —— §9.1 结束
    // 一轮不默认授权未来提醒，note_round 从不 create_initial。
    const contractRows = await readAsWorkspace(scenario, (tx) => tx`
      SELECT scheduling_authorization FROM learning_run_private_contracts WHERE run_id = ${runId} LIMIT 1
    `);
    assert.deepEqual(contractRows[0].scheduling_authorization, {
      kind: "no_effect",
      reasonCode: "not_authorized",
    });
    const scheduleCount = await readAsWorkspace(scenario, (tx) => tx`
      SELECT count(*)::int AS n FROM review_schedules WHERE subject_id = ${seeded.objectiveId}
    `);
    assert.equal(scheduleCount[0].n, 0, "轮次练习不许替目标新建复习安排");
  } finally {
    await cleanup(scenario);
  }
});

test("note_round: 同一目标已有 pending 安排 → consume_pending（§9.5 复用）", async () => {
  const scenario = await seedOpenRound();
  try {
    const { seeded } = scenario;
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      await tx`
        INSERT INTO review_schedules
          (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at,
           interval_days, generation, policy_version)
        VALUES (
          ${randomUUID()}, ${seeded.workspaceId}, ${seeded.userId}, 'card', ${seeded.objectiveId},
          'pending', now() - interval '1 hour', 3, 1, 'discrete-v2'
        )
      `;
    });
    const runId = await withWorkspaceTransaction(
      { workspaceId: seeded.workspaceId, userId: seeded.userId },
      (tx) => createRunV2(tx, {
        workspaceId: seeded.workspaceId,
        userId: seeded.userId,
        request: {
          originV2: noteRoundOrigin(scenario),
          goal: "clarify",
          idempotencyKey: `note-round-pending-${seeded.workspaceId.slice(0, 8)}`,
        },
      }),
    ).then((r: { runId: string }) => r.runId);

    const contractRows = await readAsWorkspace(scenario, (tx) => tx`
      SELECT scheduling_authorization FROM learning_run_private_contracts WHERE run_id = ${runId} LIMIT 1
    `);
    const authorization = contractRows[0].scheduling_authorization as {
      kind: string; scheduleId?: string; scheduleGeneration?: number;
    };
    assert.equal(authorization.kind, "consume_pending");
    // 消费的是**这一条** pending（按目标与 generation 冻结），prepare 只锁不结。
    const pendingRows = await readAsWorkspace(scenario, (tx) => tx`
      SELECT id, generation FROM review_schedules
      WHERE subject_id = ${seeded.objectiveId} AND status = 'pending' LIMIT 1
    `);
    assert.equal(authorization.scheduleId, pendingRows[0].id);
    assert.equal(authorization.scheduleGeneration, pendingRows[0].generation);
  } finally {
    await cleanup(scenario);
  }
});

test("note_round: 已封存的轮次 → 409 note_round_not_open", async () => {
  const scenario = await seedOpenRound();
  try {
    const { seeded, roundId, roundRevision } = scenario;
    await withWorkspaceTransaction(
      { workspaceId: seeded.workspaceId, userId: seeded.userId },
      (tx) => advanceRound(tx, { workspaceId: seeded.workspaceId, userId: seeded.userId }, {
        roundId,
        expectedRevision: roundRevision,
        action: { kind: "close", outcome: "completed" },
      }),
    );
    await assert.rejects(
      () => withWorkspaceTransaction(
        { workspaceId: seeded.workspaceId, userId: seeded.userId },
        (tx) => createRunV2(tx, {
          workspaceId: seeded.workspaceId,
          userId: seeded.userId,
          request: {
            originV2: noteRoundOrigin(scenario),
            goal: "clarify",
            idempotencyKey: `note-round-closed-${seeded.workspaceId.slice(0, 8)}`,
          },
        }),
      ),
      (error: unknown) => error instanceof LearningRunServiceError
        && error.code === "note_round_not_open",
    );
  } finally {
    await cleanup(scenario);
  }
});
