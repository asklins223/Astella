/**
 * §16.22 的读侧那一半：**争议未决的目标不进到期复习的任何一处读数**。
 *
 * 为什么单独一份：写侧早就有闸（`scheduleBlockedByDisputeV2`，由
 * `run-processing-tick` 的 `applyDemonstratedSchedule` / `applyUnableSchedule` 调用，
 * 位置在 `consume_pending` 之前），它只挡"再排一条继任"。**已经排好的那行仍是
 * `pending` 且照样到期**——撤销只有一条路：用户勾"结束并暂不安排"，
 * `holdObjectiveFromReviewV2` 才会把它改成 `dismissed`。不结争议就永远到期。
 * 而四处到期读数此前**一条 dispute 都不读**，于是结算页已经写着"复核之前这次不推进
 * 复习"，同一件事在队列里又到期冒出来：文案与行为自相矛盾。
 *
 * 判据落在 `packages/shared/review-consumable-target.ts`——那是下面六处共用的唯一一处。
 * 本份把**六处一起**钉住，而不是只钉队列：
 *  1. `listReviews`（用户点进去看到的队列）
 *  2. `getStatsOverview().pendingReviewCount`（首页那颗数）
 *  3. `getStatsOverview().objectiveReviewDueCount`（**同一份响应里的另一个到期数**；
 *     它此前是全 `/stats/overview` 里唯一没收进共享判据的一块，于是同一份响应里
 *     两个"到期"答的不是同一件事）
 *  4. `buildLearningDashboardV2`（学习看板）
 *  5. 伴星 `readLearningStats().dueReviews`（经判据桥，**受限 worker 角色**）
 *  6.（间接）`GET /reviews/v2/queue` 的 total 与上面第 1 条同源
 * 少一处就还会出现"她说 2 项、点进队列 1 条"的老岔口。
 *
 * 负对照同样重要：`upheld`（复核维持）**必须放行**。§16.22 要挡的是死循环，
 * `decideDisputedObservationV2` 在 upheld 档返回 `use_as_is` 是刻意设计——把
 * "有争议"简化成 `status='open'` 硬判，会在这一档误杀，那才是把规则读反。
 * 只测"挡住"不测"该放的放行"，等于把判据钉成了一半。
 *
 * 环境口径与争议族一致：夹具写走 `DATABASE_URL_MIGRATOR`（超户），被测路径经
 * `withWorkspaceTransaction` 跑在 `DATABASE_URL_API`（受限角色）上。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";

const fixtureUrl = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!fixtureUrl || !process.env.DATABASE_URL_API) {
  throw new Error("争议读侧集测需要 DATABASE_URL_MIGRATOR（夹具）＋DATABASE_URL_API（受限角色）");
}
const fixtureSql = postgres(fixtureUrl, { max: 4 });
const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const disputes = await import("../modules/learning-runs/run-disputes.ts");
const { seedV2Fixture, addV2ObjectiveToWorkspace } = await import("./helpers/v2-card-fixture.ts");
const { listReviews } = await import("../modules/review/service.ts");
const { getStatsOverview } = await import("../modules/stats/service.ts");
const { buildLearningDashboardV2 } = await import("../modules/learning-dashboard/service.ts");

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const at = new Date("2026-09-27T09:00:00.000Z");

/** 被质疑的那一条（会开争议），以及一条始终干净的对照片。 */
let seeded: Awaited<ReturnType<typeof seedV2Fixture>>;
let ctx: { workspaceId: string; userId: string };
/** 对照片的目标：全程没有任何争议，任何时候都必须还在队列里。 */
let controlObjectiveId = "";
let assessmentId = "";
let artifactId = "";

/** 伴星那一侧的真读数（worker 进程、受限角色、产品自己的读事务）。 */
function companionDueReviews(workspaceId: string, userId: string): number {
  const runner = `${REPO_ROOT}workers/ai-worker/node_modules/.bin/tsx`;
  const bridge = `${REPO_ROOT}workers/ai-worker/scripts/companion-gate-eval.ts`;
  assert.ok(existsSync(runner), `判据桥的运行器不在：${runner}`);
  const out = execFileSync(runner, [
    "--tsconfig", `${REPO_ROOT}workers/ai-worker/tsconfig.json`,
    bridge,
  ], {
    input: JSON.stringify({
      mode: "stats",
      turns: [{ runId: randomUUID(), workspaceId, userId }],
    }),
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL_WORKER: testDatabaseUrl("DATABASE_URL_WORKER"),
    },
  });
  const parsed = JSON.parse(out) as {
    turns: { stats: { noteCount: number; activeCards: number; dueReviews: number } }[];
  };
  return parsed.turns[0].stats.dueReviews;
}

/** 六处读数一次性取齐，断言写成**彼此相等**而不是各写一个魔数。 */
async function readAllSix(): Promise<{
  queue: number; home: number; homeObjectiveDue: number; dashboard: number; companion: number;
}> {
  const queue = await listReviews(ctx.workspaceId, { includeAll: false, limit: 50 }, ctx.userId);
  const overview = await getStatsOverview(ctx.workspaceId, ctx.userId);
  // 看板要自己开事务（`routes.ts` 那条路由就是这么走的），所以这里照抄那条形状。
  const dashboard = await withWorkspaceTransaction(ctx, (tx) => buildLearningDashboardV2(tx, ctx));
  return {
    queue: queue.total,
    home: Number(overview.pendingReviewCount),
    // 同一个响应里的**另一个**到期数。它此前是全 `/stats/overview` 里唯一没收进
    // 共享判据的一块，于是同一份响应里两个"到期"答的不是同一件事。
    homeObjectiveDue: Number(overview.objectiveReviewDueCount),
    dashboard: Number((dashboard as { counts?: { reviewsDue?: number } })?.counts?.reviewsDue ?? -1),
    companion: companionDueReviews(ctx.workspaceId, ctx.userId),
  };
}

function assertAllFourEqual(actual: Record<string, number>, expected: number, why: string): void {
  for (const [name, value] of Object.entries(actual)) {
    assert.equal(value, expected, `${why}——「${name}」这一处读到 ${value}，应为 ${expected}`);
  }
}

/**
 * 一件 locked artifact + 一次 completed assessment，够开一份争议。
 *
 * 列是照着**当前** schema 写的，不是照抄别处的夹具：`learning_tasks` 现在要
 * `sequence` / `prompt` / `target_summary`（`ordinal` 已经没有了），
 * `learning_runs` 要 `target_fingerprint`，`learning_assessments` 在
 * `completed` 档要 `report_hash`（`learning_assessments_terminal_report_check`）。
 * 抄一份旧夹具过来会在这三处先后炸掉，而炸的是**夹具**不是被测判据。
 */
async function seedOneAssessment(objectiveId: string): Promise<void> {
  const task = randomUUID();
  const variant = randomUUID();
  const run = randomUUID();
  await fixtureSql`INSERT INTO learning_runs
      (id, workspace_id, user_id, origin, return_target, target_fingerprint, goal, phase)
    VALUES (${run}, ${ctx.workspaceId}, ${ctx.userId},
      ${fixtureSql.json({ kind: "card", objectiveId })},
      ${fixtureSql.json({ kind: "note", noteId: seeded.noteId })},
      ${`fp-s1622-${run}`}, 'repair', 'completed')`;
  await fixtureSql`INSERT INTO learning_tasks
      (id, run_id, workspace_id, user_id, sequence, intent, prompt, target_summary)
    VALUES (${task}, ${run}, ${ctx.workspaceId}, ${ctx.userId}, 1, 'explain',
      '为什么有索引仍然可能慢？', '索引的成本')`;
  await fixtureSql`INSERT INTO learning_task_variants
      (id, task_id, workspace_id, user_id, purpose, template_trust_ceiling,
       estimated_active_seconds, interaction, public_payload_hash, input_schema_hash,
       disclosure_profile_hash, private_solution_hash, safety_report_hash)
    VALUES (${variant}, ${task}, ${ctx.workspaceId}, ${ctx.userId}, 'formal', 'open',
      60, ${fixtureSql.json({ type: "short_answer" })}, ${`pp-${variant}`}, ${`ish-${variant}`},
      ${`dph-${variant}`}, ${`psh-${variant}`}, ${`srh-${variant}`})`;
  await fixtureSql`INSERT INTO learning_artifacts
      (id, run_id, task_id, variant_id, workspace_id, user_id, revision, payload, payload_hash,
       public_payload_hash, input_schema_hash, private_solution_hash, safety_report_hash,
       disclosure_profile_hash, assistance_snapshot_hash, status, locked_at)
    VALUES (${artifactId}, ${run}, ${task}, ${variant}, ${ctx.workspaceId}, ${ctx.userId}, 2,
      ${fixtureSql.json({ answer: "因为索引也要回表" })}, ${`ph-${artifactId}`}, ${`pp-${artifactId}`},
      ${`ish-${artifactId}`}, ${`psh-${artifactId}`}, ${`srh-${artifactId}`}, ${`dph-${artifactId}`},
      ${`ash-${artifactId}`}, 'locked', ${at})`;
  await fixtureSql`INSERT INTO learning_assessments
      (id, run_id, task_id, artifact_id, workspace_id, user_id, source, status,
       rubric_results, report_hash)
    VALUES (${assessmentId}, ${run}, ${task}, ${artifactId}, ${ctx.workspaceId}, ${ctx.userId},
      'assessment_critic', 'completed',
      ${fixtureSql.json([{ unitId: "u1", passed: false }])}, ${`rh-${assessmentId}`})`;
}

/** 一条已到点的待办（到期复习队列认的那一种）。 */
async function insertDueSchedule(objectiveId: string): Promise<void> {
  await fixtureSql`INSERT INTO review_schedules
      (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at,
       interval_days, generation, policy_version, reason_code, created_at, updated_at)
    VALUES (${randomUUID()}, ${ctx.workspaceId}, ${ctx.userId}, 'card', ${objectiveId},
      'pending', now() - interval '1 hour', 1, 1, 's1622-fixture', 'fixture', now(), now())`;
}

before(async () => {
  seeded = await seedV2Fixture(fixtureSql);
  ctx = { workspaceId: seeded.workspaceId, userId: seeded.userId };
  assessmentId = randomUUID();
  artifactId = randomUUID();

  // 对照片：同工作区、同一个人、同样有活卡有到期待办，只是没有争议。
  const control = await addV2ObjectiveToWorkspace(fixtureSql, ctx.workspaceId, ctx.userId, {
    objectiveStatement: "区分顺序扫描与索引扫描",
    publicSummary: "顺序扫描与索引扫描",
  });
  controlObjectiveId = control.objectiveId;

  await seedOneAssessment(seeded.objectiveId);
  await insertDueSchedule(seeded.objectiveId);
  await insertDueSchedule(controlObjectiveId);
});

after(async () => {
  await seeded.cleanup();
  await fixtureSql.end();
  await closeDatabase();
});

test("基线：两条都到点、六处读数一致且都算 2", async () => {
  const readings = await readAllSix();
  assertAllFourEqual(readings, 2, "夹具没造出两条都到点的待办，或某处读数口径已经分岔");
});

test("开一份未复核的争议：被质疑的那条从六处一起消失，对照片不动", async () => {
  await withWorkspaceTransaction(ctx, (tx) => disputes.openAssessmentDisputeV2(tx, {
    ...ctx,
    assessmentId,
    kind: "misjudged",
    statement: "我第一次就写了回表那一步，不该判成没提到。",
    at,
  }));

  const readings = await readAllSix();
  assertAllFourEqual(readings, 1, "争议未决时那一半没有被挡住（§16.22 读侧）");
  // 对照片必须还在——否则这条用例证明的是"少了一个"而不是"少了该少的那一个"。
  const queue = await listReviews(ctx.workspaceId, { includeAll: false, limit: 50 }, ctx.userId);
  const subjects = queue.items.map((item) => item.objective?.id ?? item.review.subjectId);
  assert.ok(
    subjects.includes(controlObjectiveId),
    "没争议的那条被一起挡掉了——判据按得也太宽了",
  );
  assert.ok(
    !subjects.includes(seeded.objectiveId),
    "被质疑的那条还在队列里：共享判据没接上争议",
  );
});

test("排期行本身没被动过：挡的是读侧，不是把这条待办悄悄删了", async () => {
  // §16.22 要的是"不自动重新入队 / 不反复提示"，不是把历史抹掉。用户结束争议
  // 之后仍要能查看原记录（§16.22 验收句），所以这里量的是那行仍然是 pending。
  const rows = await fixtureSql`SELECT status::text AS status
    FROM review_schedules
    WHERE workspace_id = ${ctx.workspaceId} AND subject_id = ${seeded.objectiveId}`;
  assert.equal(rows.length, 1, "待办行不见了——读侧不该改写排期数据");
  assert.equal(rows[0].status, "pending", "待办被改成非 pending 了：这不是读侧该做的事");
});

test("负对照：复核结论是 upheld 时必须放行（§16.22 挡的是死循环，不是维护）", async () => {
  await withWorkspaceTransaction(ctx, (tx) => disputes.completeDisputeRecheckV2(tx, {
    ...ctx,
    assessmentId,
    outcome: "upheld",
    reason: "复核原题原答后维持原判定。",
    reportHash: "s1622-upheld",
    at,
  }));

  const readings = await readAllSix();
  assertAllFourEqual(
    readings,
    2,
    "upheld 档被误杀了：decideDisputedObservationV2 在这一档是 use_as_is，硬判 status='open' 会把规则读反",
  );
});

test("收尾：关闭争议后读数不变（关闭本身不该让一条已维护的目标消失）", async () => {
  await withWorkspaceTransaction(ctx, (tx) => disputes.closeAssessmentDisputeV2(tx, {
    ...ctx,
    assessmentId,
    holdObjective: false,
    note: "认可复核结论。",
    at,
  }));
  const readings = await readAllSix();
  assertAllFourEqual(readings, 2, "关闭并认可之后读数变了");
});
