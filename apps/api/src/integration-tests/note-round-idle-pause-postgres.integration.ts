/**
 * 「最后一个活跃端离开 ⇒ 服务端把进行中的轮次标成可恢复暂停」的扫描（39d W4-5 ④）。
 *
 * 为什么必须是集成测试（而判据那份纯函数已有单测）：这一刀的四个承诺里没有一个能由
 * 纯函数或 mock 事务证到——
 *  1. **活跃度那份证据只在库里**：`assistant_page_contexts` 的 30 秒租约、`revoked_at`
 *     那一格、以及"这一轮还挂着一场没走完的 run"（`origin ->> 'roundId'`）都是读库读出来的。
 *     判据②③各配了一条**负对照**（真插一份未过期的租约／真插一场非终态的 run），
 *     没有负对照的话"停了"可以是"根本没看那一格"。
 *  2. **动作只有 `advanceRound` 那一条路**：`paused_at` 记账、共用计数器前进一格、
 *     身份列不动，三件事都在 0282 的触发器与那条 CAS 底下——所以断言读的是**库里那一行**，
 *     不是扫描自己的回执（回执说停了而库里没停，正是这一族最容易假绿的地方）。
 *  3. **幂等**：第二次扫到同一条不许再推进计数器（`revision` 是状态与计划共用的那一个）。
 *  4. **绝不碰 `closed`、也不新增轮次**（PRD §3.2 明令"不新增轮次"）。
 *
 * 另外两件事由这一份钉，因为它们都只在真库上成立：
 *  - **FORCE RLS 的归属**：轮次表没有 worker 旁路（D1 §6.5），扫描必须逐 (空间,人) 带
 *    两个 GUC 去读；所以"以我的 scope 扫"不许动到同空间另一个人与另一个空间里的那一行，
 *    而"不带 scope 扫"必须真的把成员表里的空间都枚举到（少了这一条，
 *    `listSweepScopes()` 坏掉只会让上面所有用例**恰好**走定点那一发而看不见）。
 *  - **暂停出来的那一格真能接回去**：停住之后走真 HTTP 的 `resume`（带真令牌），
 *    200 且回到 active——这是 39d-w46 §9 那条顺序（先接恢复出口，再上自动暂停）的验收面。
 *
 * 种 `paused` **不硬插**：夹具只造 `active` 行与租约行，`paused` 全部由扫描自己转出来
 * （39d-w46 §9 教训 1：那张表带触发器保护，硬插会撞出不合法状态）。
 * 时间也不靠 sleep：轮次行的 `updated_at` 由夹具在 INSERT 那一刻定（十分钟后这一行
 * 本来就是这个形状），而"同一条 fresh 的行把时钟拨过宽限期就会停"那一发用扫描的 `now` 入参。
 *
 * 角色分工照 doc 34 §1.2：夹具走 `DATABASE_URL_MIGRATOR`（超户），被测的扫描经
 * `db/client.ts` 跑在 `DATABASE_URL_API`（受限角色）上——`before` 里当场量一次
 * 那条连接的 `rolbypassrls`，它是 true 的话这份文件里所有 RLS 断言都是恒绿的假读数。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  seedNotesOnlyWorkspace,
  type NotesOnlyWorkspaceFixture,
} from "./helpers/pure-v2-workspace-fixture.ts";
import { seedV2Fixture } from "./helpers/v2-card-fixture.ts";

const fixtureUrl = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
const apiUrl = process.env.DATABASE_URL_API;
if (!fixtureUrl || !apiUrl) {
  throw new Error("空闲暂停扫描需要 DATABASE_URL_MIGRATOR（夹具）＋DATABASE_URL_API（受限角色，扫描跑在它上面）");
}
const fixtureSql = postgres(fixtureUrl, { max: 4 });

const { default: Fastify } = await import("fastify");
const { default: sensible } = await import("@fastify/sensible");
const { authRoutes } = await import("../modules/identity/routes.ts");
const { deterministicTeachingExplainProviderV1 } = await import("../modules/note-learning-rounds/teaching-explain.ts");
const { noteLearningRoundRoutes } = await import("../modules/note-learning-rounds/routes.ts");
const { issueSession } = await import("../modules/identity/service.ts");
const { db, closeDatabase } = await import("../db/client.ts");
const { sweepIdleNoteRoundsForPauseV1 } = await import("../modules/note-learning-rounds/round-activity-sweep.ts");
const {
  ENV_ROUND_ACTIVITY_SWEEP_INTERVAL,
  ROUND_IDLE_PAUSE_GRACE_MS_V1,
} = await import("../modules/note-learning-rounds/round-idle-pause-policy.ts");

type Scope = { workspaceId: string; userId: string };

/** 比 90 秒宽限期更老：判据④在这条上成立，夹具不需要拨时钟。 */
const OLD_MS = ROUND_IDLE_PAUSE_GRACE_MS_V1 + 60_000;
/** 真实主形状：32 位 md5（`computeContentHash`），照轮次契约集测那份常量。 */
const HASH_A = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";

let app: Awaited<ReturnType<typeof Fastify>>;
const cleanups: Array<() => Promise<void>> = [];

/**
 * 以"应用"的身份写这一张表的行：带 `(app.workspace_id, app.user_id)` 两个 GUC。
 * 本仓库那条老坑（轮次契约集测的 `insertRound` 头上写着）——裸读裸写在这张表上
 * 不是"读不到"，而是**换一种读不到的原因**，读数就不作数了。
 */
async function asApp<T>(scope: Scope, run: (tx: postgres.Sql) => PromiseLike<T>): Promise<T> {
  return fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${scope.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${scope.userId}, true)`;
    return run(tx as unknown as postgres.Sql);
  }) as Promise<T>;
}

/**
 * 一条 `active` 轮次。列与 `round-service.ts` 的 `createRound` 那份 INSERT 一一对齐
 * （归属三件套＋快照三件＋三项预算＋phase/revision），唯一多出来的是把
 * `created_at`/`updated_at` 拨旧——那是"这一轮十分钟前开的"在库里的样子，
 * 不是服务端产不出的形状（INSERT 不经过那条 BEFORE UPDATE 触发器）。
 */
async function seedActiveRound(
  scope: Scope,
  input: { noteId: string; noteVersionId: string; question: string; ageMs?: number },
): Promise<string> {
  const ageMs = input.ageMs ?? OLD_MS;
  const at = new Date(Date.now() - ageMs).toISOString();
  const rows = await asApp(scope, (tx) => tx`
    INSERT INTO note_learning_rounds (
      workspace_id, user_id, note_id, note_version_id,
      driving_question, driving_question_source, source_content_hash,
      max_model_calls, max_wall_clock_seconds, max_tasks,
      phase, revision, created_at, updated_at
    ) VALUES (
      ${scope.workspaceId}, ${scope.userId}, ${input.noteId}, ${input.noteVersionId},
      ${input.question}, 'suggested', ${HASH_A},
      8, 900, 6,
      'active', 1, ${at}, ${at}
    ) RETURNING id`);
  return String((rows as unknown as Array<{ id: string }>)[0].id);
}

/** 一条**已经收尾**的轮次：`closed` 必带 outcome 与 closed_at（0282 的双向 CHECK）。 */
async function seedClosedRound(
  scope: Scope,
  input: { noteId: string; noteVersionId: string; question: string },
): Promise<string> {
  const rows = await asApp(scope, (tx) => tx`
    INSERT INTO note_learning_rounds (
      workspace_id, user_id, note_id, note_version_id,
      driving_question, driving_question_source, source_content_hash,
      max_model_calls, max_wall_clock_seconds, max_tasks,
      phase, outcome, closed_at, revision, created_at, updated_at
    ) VALUES (
      ${scope.workspaceId}, ${scope.userId}, ${input.noteId}, ${input.noteVersionId},
      ${input.question}, 'suggested', ${HASH_A},
      8, 900, 6,
      'closed', 'partial', now(), 3, now(), now()
    ) RETURNING id`);
  return String((rows as unknown as Array<{ id: string }>)[0].id);
}

/**
 * 一份页面租约。列形状照真合同（`context-service.ts` 那份 INSERT 与
 * `proactive-hook-postgres.integration.ts:82` 的夹具读数），30 秒租约落在
 * `expires_at = issued_at + 30s` 这一格里。
 */
async function seedPageContext(
  scope: Scope,
  input: { expiresInMs?: number; revoked?: boolean } = {},
): Promise<string> {
  const contextId = randomUUID();
  const expiresInMs = input.expiresInMs ?? 30_000;
  await asApp(scope, (tx) => tx`
    INSERT INTO assistant_page_contexts
      (id, workspace_id, user_id, page_instance_id, revision, route_ref, page_kind,
       entity_refs, interaction_state, capability_hints, sensitivity,
       issued_at, expires_at, revoked_at, created_at, updated_at)
    VALUES (
      ${contextId}, ${scope.workspaceId}, ${scope.userId}, ${`page:${contextId.slice(0, 8)}`},
      ${"a".repeat(64)}, ${{ kind: "note", noteId: randomUUID() } as never},
      'note', ${[] as never}, 'idle', ${[] as never}, 'normal',
      now(), now() + ${`${expiresInMs / 1000} seconds`}::interval, ${input.revoked ? new Date() : null}, now(), now()
    )`);
  return contextId;
}

async function updatePageContextLease(
  scope: Scope,
  contextId: string,
  patch: { expiresInMs: number; revoked?: boolean },
): Promise<void> {
  await asApp(scope, (tx) => tx`
    UPDATE assistant_page_contexts
       SET expires_at = now() + ${`${patch.expiresInMs / 1000} seconds`}::interval,
           revoked_at = ${patch.revoked ? new Date() : null},
           updated_at = now()
     WHERE id = ${contextId}::uuid`);
}

/**
 * 挂在这一轮上的一场 run。origin 取真生产的那四格（`note-round-practice` 里钉过的
 * `{kind:"note_round", roundId, noteId, objectiveId}`），`objectiveId` 用的是
 * `seedV2Fixture` 真建出来的那个目标，不是随手一个 uuid。
 */
async function seedRunOnRound(
  scope: Scope,
  input: { roundId: string; noteId: string; objectiveId: string; phase?: string },
): Promise<string> {
  const runId = randomUUID();
  await asApp(scope, (tx) => tx`
    INSERT INTO learning_runs (id, workspace_id, user_id, origin, return_target,
                               target_fingerprint, goal, phase)
    VALUES (
      ${runId}, ${scope.workspaceId}, ${scope.userId},
      ${tx.json({
        kind: "note_round", roundId: input.roundId, noteId: input.noteId,
        objectiveId: input.objectiveId, keyPointId: input.objectiveId,
      })},
      ${tx.json({ kind: "note_round", roundId: input.roundId, noteId: input.noteId })},
      ${"a".repeat(64)}, 'stabilize', ${input.phase ?? "active"}
    )`);
  return runId;
}

/** 同一空间里**不属于这一轮**的一场 run（origin 是 `today`，与生产那一份同形状）。 */
async function seedRunNotOnRound(scope: Scope, objectiveId: string): Promise<string> {
  const runId = randomUUID();
  await asApp(scope, (tx) => tx`
    INSERT INTO learning_runs (id, workspace_id, user_id, origin, return_target,
                               target_fingerprint, goal, phase)
    VALUES (
      ${runId}, ${scope.workspaceId}, ${scope.userId},
      ${tx.json({ kind: "today", objectiveId })},
      ${tx.json({ kind: "today" })},
      ${"a".repeat(64)}, 'stabilize', 'active'
    )`);
  return runId;
}

async function setRunPhase(scope: Scope, runId: string, phase: string): Promise<void> {
  await asApp(scope, (tx) => tx`
    UPDATE learning_runs SET phase = ${phase}, updated_at = now() WHERE id = ${runId}::uuid`);
}

type RoundRow = {
  phase: string;
  revision: number;
  outcome: string | null;
  pausedAt: string | null;
  updatedAt: string;
};

/** 库里那一行此刻的形状（直查库，不信扫描自己的回执）。 */
async function rowInDb(scope: Scope, roundId: string): Promise<RoundRow> {
  const rows = await asApp(scope, (tx) => tx`
    SELECT phase, revision, outcome, paused_at, updated_at
      FROM note_learning_rounds WHERE id = ${roundId}::uuid`);
  const row = (rows as unknown as Array<Record<string, unknown>>)[0];
  assert.ok(row, `库里应当有这一轮（id ${roundId}）`);
  return {
    phase: String(row.phase),
    revision: Number(row.revision),
    outcome: row.outcome === null ? null : String(row.outcome),
    pausedAt: row.paused_at ? new Date(row.paused_at as string).toISOString() : null,
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

async function countRounds(scope: Scope): Promise<{ all: number; active: number; paused: number }> {
  const rows = await asApp(scope, (tx) => tx`
    SELECT count(*)::int AS all_count,
           count(*) FILTER (WHERE phase = 'active')::int AS active_count,
           count(*) FILTER (WHERE phase = 'paused')::int AS paused_count
      FROM note_learning_rounds WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}`);
  const row = (rows as unknown as Array<Record<string, unknown>>)[0];
  return { all: Number(row.all_count), active: Number(row.active_count), paused: Number(row.paused_count) };
}

/** 一个只带笔记的空间（两篇，够摆"我的那一轮"与"另一篇上的对照轮次"）。 */
async function seedNotesScope(): Promise<NotesOnlyWorkspaceFixture & Scope> {
  const seeded = await seedNotesOnlyWorkspace(fixtureSql, { noteCount: 2 });
  cleanups.push(seeded.cleanup);
  return seeded;
}

async function callResume(token: string, roundId: string, expectedRevision: number) {
  return app.inject({
    method: "PATCH",
    url: `/v2/note-learning-rounds/${roundId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { expectedRevision, action: { kind: "resume" } },
  });
}

before(async () => {
  // 被测那一条连接必须是**不旁路 RLS** 的角色，否则下面每一条"别人的行没动"都是恒绿。
  const roleRows = await db.execute(sql`
    SELECT current_user AS who,
           (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass
  `);
  const role = (roleRows as unknown as Array<Record<string, unknown>>)[0];
  assert.equal(
    role?.bypass,
    false,
    `扫描跑在 ${String(role?.who)} 上且 rolbypassrls=${String(role?.bypass)}：`
    + "换成旁路 RLS 的角色（例如 dev 栈的 ailearn）之后，这一份文件里所有归属断言都不再是证据",
  );
  app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(authRoutes);
  await app.register(noteLearningRoundRoutes, { teaching: {
    provider: deterministicTeachingExplainProviderV1(), modelId: "offline-test", external: false,
  } });
  await app.ready();
});

after(async () => {
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch {
      // 夹具自己清不干净不覆盖真正那条读数；一次性库用完即弃。
    }
  }
  await app?.close();
  await fixtureSql.end();
  await closeDatabase();
});

test("四条判据全成立 ⇒ 那一行变成可恢复暂停，且没有新增任何轮次", async () => {
  const scope = await seedNotesScope();
  const roundId = await seedActiveRound(scope, {
    noteId: scope.noteIds[0]!, noteVersionId: scope.versionIds[0]!, question: "人不在了这一轮该停在哪",
  });
  const beforeCount = await countRounds(scope);

  const swept = await sweepIdleNoteRoundsForPauseV1({ scope });
  assert.equal(swept.enabled, true);
  assert.equal(swept.scopesScanned, 1);
  assert.equal(swept.roundsConsidered, 1);
  assert.equal(swept.paused.length, 1, "四条都成立却没停：扫描自己没跑起来");
  assert.equal(swept.paused[0]?.roundId, roundId);
  assert.deepEqual(swept.blocked, {}, "没有哪一条该挡");

  const row = await rowInDb(scope, roundId);
  assert.equal(row.phase, "paused", "回执说停了而库里没停 ⇒ 这一发根本没落");
  assert.ok(row.pausedAt, "暂停要写下时间：没有它「停过」与「一直开着」在库里同一个样子");
  assert.equal(row.revision, 2, "真的一次状态变化，状态与计划共用的那个计数器前进一格");

  const afterCount = await countRounds(scope);
  assert.equal(afterCount.all, beforeCount.all, "PRD §3.2 明令「不新增轮次」：这一发只许转态，不许开新的");
  assert.equal(afterCount.active, 0);
  assert.equal(afterCount.paused, 1);

  // 停住之后必须真能接回去（39d-w46 §9 那条顺序的验收面：先有出口，才许自动停）。
  const token = (await issueSession(scope.userId, scope.workspaceId)).token;
  const resumed = await callResume(token, roundId, row.revision);
  assert.equal(resumed.statusCode, 200, `扫描停住的那一轮应当能用真 HTTP 接回去：${resumed.body}`);
  assert.equal((await rowInDb(scope, roundId)).phase, "active");
});

test("判据②：还有一份未过期未撤销的 live 租约 ⇒ 不停；过期或撤销之后就停", async () => {
  const scope = await seedNotesScope();
  const heldRoundId = await seedActiveRound(scope, {
    noteId: scope.noteIds[0]!, noteVersionId: scope.versionIds[0]!, question: "窗口还开着的时候",
  });
  const contextId = await seedPageContext(scope, { expiresInMs: 30_000 });

  const held = await sweepIdleNoteRoundsForPauseV1({ scope });
  assert.equal(held.paused.length, 0, "有一份 live 租约还停 ⇒ 把还开着窗口的用户踢停了");
  assert.equal(held.blocked["live-page-context"], 1);
  const heldRow = await rowInDb(scope, heldRoundId);
  assert.deepEqual(
    { phase: heldRow.phase, revision: heldRow.revision, pausedAt: heldRow.pausedAt },
    { phase: "active", revision: 1, pausedAt: null },
  );

  // 负对照 A：租约**过期**了（30 秒到点）⇒ 同一条轮次就该被停。少了这一发，上面那条
  // "不停"可以是"根本没读 assistant_page_contexts"。
  await updatePageContextLease(scope, contextId, { expiresInMs: -1_000 });
  const expired = await sweepIdleNoteRoundsForPauseV1({ scope });
  assert.equal(
    expired.paused.map((r) => r.roundId).includes(heldRoundId),
    true,
    "过期租约仍挡住 ⇒ 判据②读的不是 expires_at",
  );
  assert.equal((await rowInDb(scope, heldRoundId)).phase, "paused");

  // 负对照 B：租约**未过期但被显式撤销**（`revoked_at`）⇒ 也算没有活跃端。
  // 这一条要一个新的 active 轮次：上面那一条已经停了。
  await updatePageContextLease(scope, contextId, { expiresInMs: 30_000, revoked: true });
  const revokedRoundId = await seedActiveRound(scope, {
    noteId: scope.noteIds[1]!, noteVersionId: scope.versionIds[1]!, question: "窗口刚关掉的时候",
  });
  const revokedSweep = await sweepIdleNoteRoundsForPauseV1({ scope });
  assert.equal(
    revokedSweep.paused.map((r) => r.roundId).includes(revokedRoundId),
    true,
    "未过期但已撤销的租约仍挡住 ⇒ 判据②读的不是 revoked_at",
  );
});

test("判据③：这一轮还挂着一场没走完的 run ⇒ 不停；那一场走到终态之后就停", async () => {
  // 这一份夹具带**真的学习目标**：`note_round` 的 origin 里 objectiveId 指向真实目标，
  // 不是随手一个 uuid（假夹具＝假绿那一条老坑）。
  const seeded = await seedV2Fixture(fixtureSql, { objectiveStatement: "空闲暂停的练习负对照" });
  cleanups.push(seeded.cleanup);
  const scope: Scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
  const roundId = await seedActiveRound(scope, {
    noteId: seeded.noteId, noteVersionId: seeded.noteVersionId, question: "还在做题的时候别把外面这一轮停掉",
  });
  const openRunId = await seedRunOnRound(scope, {
    roundId, noteId: seeded.noteId, objectiveId: seeded.objectiveId, phase: "active",
  });
  // 同一空间里另有一场**不属于这一轮**的 run（origin 是 `today`）：它不许挡住这一轮，
  // 下面那一步就是验这件事——那一场还开着，而这一轮已经能停了。
  const otherRunId = await seedRunNotOnRound(scope, seeded.objectiveId);

  const held = await sweepIdleNoteRoundsForPauseV1({ scope });
  assert.equal(held.paused.length, 0, "这一轮还有练习在跑就停 ⇒ 判据③没生效");
  assert.equal(held.blocked["open-learning-run"], 1);
  assert.equal((await rowInDb(scope, roundId)).phase, "active");

  await setRunPhase(scope, openRunId, "ended");
  const released = await sweepIdleNoteRoundsForPauseV1({ scope });
  assert.equal(
    released.paused.map((r) => r.roundId).includes(roundId),
    true,
    `那一场已经终态（另一场 ${otherRunId} 不属于这一轮）却还挡着 ⇒ 判据③读的不是 origin->>'roundId'`,
  );
  assert.equal((await rowInDb(scope, roundId)).phase, "paused");
});

test("判据④：改后立刻扫（宽限期内）不停，同一条把时钟拨过宽限期就停", async () => {
  const scope = await seedNotesScope();
  const roundId = await seedActiveRound(scope, {
    noteId: scope.noteIds[0]!, noteVersionId: scope.versionIds[0]!, question: "刚刚才动过的一轮", ageMs: 0,
  });

  const inside = await sweepIdleNoteRoundsForPauseV1({ scope });
  assert.equal(inside.paused.length, 0, "刚改完就被停：宽限期那一格没生效");
  assert.equal(inside.blocked["grace-period"], 1);
  assert.equal((await rowInDb(scope, roundId)).revision, 1);

  // 同一条数据、只有"现在"不同 ⇒ 挡住它的确实只有判据④（另外三条在上一条里已经成立）。
  const past = new Date(Date.now() + ROUND_IDLE_PAUSE_GRACE_MS_V1 + 5_000);
  const outside = await sweepIdleNoteRoundsForPauseV1({ scope, now: past });
  assert.equal(outside.paused.length, 1, "拨过宽限期还不停 ⇒ 这一轮永远停不下来");
  assert.equal(outside.paused[0]?.roundId, roundId);
  const row = await rowInDb(scope, roundId);
  assert.deepEqual({ phase: row.phase, revision: row.revision }, { phase: "paused", revision: 2 });
});

test("幂等：第二次扫到同一条不再推进那个共用计数器，也不再写 paused_at", async () => {
  const scope = await seedNotesScope();
  const roundId = await seedActiveRound(scope, {
    noteId: scope.noteIds[0]!, noteVersionId: scope.versionIds[0]!, question: "扫第二遍会怎样",
  });
  const first = await sweepIdleNoteRoundsForPauseV1({ scope });
  assert.equal(first.paused.length, 1);
  const firstRow = await rowInDb(scope, roundId);

  const second = await sweepIdleNoteRoundsForPauseV1({ scope });
  assert.equal(second.paused.length, 0, "第二次还在报「停了」：幂等没做出来");
  assert.equal(second.roundsConsidered, 0, "已停的行不该再被读成候选（判据①在 SQL 里就收窄）");
  assert.deepEqual(await rowInDb(scope, roundId), firstRow,
    "重复扫描把状态与计划共用的那个计数器吹大了，或把 paused_at 换成第二次的时间点");
});

test("不碰终态，也不碰别人的：closed 那一行与同空间另一个人的那一行都留在原处", async () => {
  const scope = await seedNotesScope();
  const mineRoundId = await seedActiveRound(scope, {
    noteId: scope.noteIds[0]!, noteVersionId: scope.versionIds[0]!, question: "我这一轮该停",
  });
  const closedRoundId = await seedClosedRound(scope, {
    noteId: scope.noteIds[1]!, noteVersionId: scope.versionIds[1]!, question: "昨天收尾的那一轮",
  });
  const closedBefore = await rowInDb(scope, closedRoundId);
  assert.equal(closedBefore.phase, "closed", "起点必须是终态");
  assert.equal(closedBefore.outcome, "partial", "起点带着终态原因，扫完还要是同一条");

  // 同空间另一个人：他自己的一篇笔记＋他自己的一轮。
  const peerUserId = randomUUID();
  const peerNoteId = randomUUID();
  const peerVersionId = randomUUID();
  const peerScope: Scope = { workspaceId: scope.workspaceId, userId: peerUserId };
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${scope.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${scope.userId}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role)
      VALUES (${peerUserId}, ${`idle-peer-${peerUserId.slice(0, 8)}@example.test`}, 'h', 'member')`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${scope.workspaceId}, ${peerUserId}, 'member')`;
    await tx`INSERT INTO notes (id, workspace_id, title, created_by)
      VALUES (${peerNoteId}, ${scope.workspaceId}, 'idle-pause-peer-note', ${peerUserId})`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${peerVersionId}, ${peerNoteId}, ${scope.workspaceId}, 1,
        ${tx.json({ blocks: [{ type: "paragraph", content: "另一个人的那一轮" }] })}, ${HASH_A}, ${peerUserId})`;
    await tx`UPDATE notes SET current_version_id = ${peerVersionId} WHERE id = ${peerNoteId}`;
  });
  cleanups.push(async () => {
    await fixtureSql`DELETE FROM note_learning_rounds WHERE user_id = ${peerUserId}`;
    await fixtureSql`DELETE FROM note_versions WHERE id = ${peerVersionId}`;
    await fixtureSql`DELETE FROM notes WHERE id = ${peerNoteId}`;
    await fixtureSql`DELETE FROM workspace_members WHERE user_id = ${peerUserId}`;
    await fixtureSql`DELETE FROM users WHERE id = ${peerUserId}`;
  });
  const peerRoundId = await seedActiveRound(peerScope, {
    noteId: peerNoteId, noteVersionId: peerVersionId, question: "另一个人的那一轮",
  });

  const swept = await sweepIdleNoteRoundsForPauseV1({ scope });
  assert.equal(swept.scopesScanned, 1);
  assert.equal(swept.roundsConsidered, 1, "只有我这个 (空间,人) 的那一条该被读成候选");
  assert.deepEqual(swept.paused.map((r) => r.roundId), [mineRoundId]);
  assert.equal((await rowInDb(scope, mineRoundId)).phase, "paused");
  assert.deepEqual(await rowInDb(scope, closedRoundId), closedBefore,
    "扫描碰了终态那一行：closed 之后只读（D1 §3.3），连 updated_at 都不该动");
  const peerRow = await rowInDb(peerScope, peerRoundId);
  assert.deepEqual(
    { phase: peerRow.phase, revision: peerRow.revision, pausedAt: peerRow.pausedAt },
    { phase: "active", revision: 1, pausedAt: null },
    "以我的 scope 扫却把另一个人的轮次停了 ⇒ 那条 WHERE 少了 user_id，或 GUC 没带上",
  );
});

test("归属：定点那一发只看得见自己，不带 scope 那一发才把成员空间逐个枚举到", async () => {
  const mine = await seedNotesScope();
  const other = await seedNotesScope();
  const mineRoundId = await seedActiveRound(mine, {
    noteId: mine.noteIds[0]!, noteVersionId: mine.versionIds[0]!, question: "我这一篇的这一轮",
  });
  const otherRoundId = await seedActiveRound(other, {
    noteId: other.noteIds[0]!, noteVersionId: other.versionIds[0]!, question: "另一个空间的那一轮",
  });

  // 定点：别人那一发在自己的 GUC 下**读不到**（连候选都不是），也就一个字都不动。
  const scoped = await sweepIdleNoteRoundsForPauseV1({ scope: mine });
  assert.deepEqual(scoped.paused.map((r) => r.roundId), [mineRoundId]);
  const otherAfterScoped = await rowInDb(other, otherRoundId);
  assert.equal(otherAfterScoped.phase, "active");
  assert.equal(otherAfterScoped.revision, 1);

  // 不带 scope：走 0286 那支预筛函数挑候选。少了这一发，枚举函数写坏（返回空数组）
  // 上面所有定点用例照样全绿——那才是这一刀最要命的假绿。
  const sweptAll = await sweepIdleNoteRoundsForPauseV1();
  assert.ok(sweptAll.scopesScanned >= 2, `枚举到的空间数：${sweptAll.scopesScanned}`);
  assert.equal(
    (await rowInDb(other, otherRoundId)).phase,
    "paused",
    "不带 scope 的扫描没把另一个空间收进来 ⇒ 定时任务在生产里只会扫到眼前这一个空间",
  );
});

test("预筛只回候选：扫描的事务次数＝候选数，而不是成员数", async () => {
  // 这一条钉的是 0286 那支函数**存在的理由**。少了它，把枚举改回 `workspace_members`
  // 照样能让上面所有用例全绿——因为定点那一发根本不经过枚举，而"全空间"那一条只断言
  // `>= 2`。代价（每趟 1 330 次事务）与"空空间被白扫"这两件事会一起静默回来。
  const stale = await seedNotesScope();
  const staleRound = await seedActiveRound(stale, {
    noteId: stale.noteIds[0]!, noteVersionId: stale.versionIds[0]!, question: "过宽限期的那一条",
  });
  const fresh = await seedNotesScope();
  const freshRound = await seedActiveRound(fresh, {
    noteId: fresh.noteIds[0]!, noteVersionId: fresh.versionIds[0]!, question: "还没到宽限期的那一条",
    ageMs: 1_000,
  });
  const done = await seedNotesScope();
  const closedRound = await seedClosedRound(done, {
    noteId: done.noteIds[0]!, noteVersionId: done.versionIds[0]!, question: "已经收尾的那一条",
  });
  // 两个**一个轮次都没有**的在册空间：枚举走成员表就会把它们也算进事务数。
  await seedNotesScope();
  await seedNotesScope();

  const candidates = (await asApp(stale, (tx) => tx`
    SELECT workspace_id, user_id, round_id, last_changed_at
      FROM public.ailearn_note_rounds_idle_for_pause(${ROUND_IDLE_PAUSE_GRACE_MS_V1})`
  )) as unknown as Array<{ round_id: string }>;
  const candidateIds = candidates.map((row) => row.round_id);
  assert.ok(candidateIds.includes(staleRound), "该挑的没挑出来 ⇒ 真过期的轮次等不到暂停");
  assert.ok(!candidateIds.includes(freshRound),
    "没过宽限期的也被挑出来了 ⇒ 函数在替扫描做决定，而不是只给候选");
  assert.ok(!candidateIds.includes(closedRound),
    "终态行被挑出来 ⇒ 扫描会去转一个已经收尾的轮次（PRD 禁止）");

  const swept = await sweepIdleNoteRoundsForPauseV1();
  assert.equal(swept.scopesScanned, candidateIds.length,
    `事务次数应当等于候选数：扫了 ${swept.scopesScanned} 个空间而候选只有 ${candidateIds.length} 个`
    + " ⇒ 枚举退回成员表了，空出来的空间又被白扫一遍");
  assert.ok(swept.paused.map((row) => row.roundId).includes(staleRound),
    "候选里那条真该被停住（否则事务数对了也没用）");
});

test("off 档：不建定时器之外，扫描本体被直调也一个字都不写（＝改前行为）", async () => {
  const scope = await seedNotesScope();
  const roundId = await seedActiveRound(scope, {
    noteId: scope.noteIds[0]!, noteVersionId: scope.versionIds[0]!, question: "关掉这一发的时候",
  });
  const beforeRow = await rowInDb(scope, roundId);
  const previous = process.env[ENV_ROUND_ACTIVITY_SWEEP_INTERVAL];
  process.env[ENV_ROUND_ACTIVITY_SWEEP_INTERVAL] = "off";
  try {
    const swept = await sweepIdleNoteRoundsForPauseV1({ scope });
    assert.equal(swept.enabled, false);
    assert.ok(swept.disabledReason, "关掉这件事要说得出是哪一档");
    assert.equal(swept.scopesScanned, 0);
    assert.equal(swept.paused.length, 0);
    assert.deepEqual(await rowInDb(scope, roundId), beforeRow,
      "off 档还在写库 ⇒ 这一档没有真的回到改前行为");
  } finally {
    if (previous === undefined) delete process.env[ENV_ROUND_ACTIVITY_SWEEP_INTERVAL];
    else process.env[ENV_ROUND_ACTIVITY_SWEEP_INTERVAL] = previous;
  }
});
