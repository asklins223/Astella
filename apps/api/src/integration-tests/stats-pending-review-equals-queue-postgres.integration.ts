/**
 * doc 34 L23 —— "待复习"这一句读数只许一个来源。
 *
 * 断言写成**等式**而不是我手算一个数：屏幕上"待复习"那颗数（`/stats/overview` 的
 * `pendingReviewCount`）必须**等于**用户点进复习列表看到的条数（`listReviews` 的 total）。
 * 以前它数的是"全部 pending 排程"——不判到点、不判延后、不判卡还可不可消费，
 * 于是恒大于列表，而且两份判据各写一遍、改一处不会让另一处红。
 *
 * 三条排程各属**一个不同的目标**：到点的、没到点的、到点但本人说过"稍后"的。
 *
 * 为什么不共用一个目标插三条：0287 加了
 * `review_schedules_pending_subject_dim_unique`（`WHERE status = 'pending'`），
 * 同一目标同一维度只允许一条待办。旧版夹具给**同一个**目标插三条，在 `before`
 * 里就撞 23505 —— 报出来的错看着像新功能坏了，其实是夹具早已不合法。
 * 这也顺带说明 0287 那条注释里的判断是对的：把 insert 收进单一调度边界之前，
 * "先查后写"写出来的就是这种一条一条撞索引的夹具。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const CONN = process.env.DATABASE_URL;
if (!CONN) {
  throw new Error("L23 集测要求 DATABASE_URL（要造排程行）");
}
const sql = postgres(CONN, { max: 3 });

const { seedV2Fixture, addV2ObjectiveToWorkspace } = await import("./helpers/v2-card-fixture.ts");
const { listReviews } = await import("../modules/review/service.ts");
const { getStatsOverview } = await import("../modules/stats/service.ts");

const seeded: Awaited<ReturnType<typeof seedV2Fixture>>[] = [];
/** 三条排程各自的目标：到期 / 未到期 / 到点但被"稍后"挡住。 */
let dueObjectiveId = "";
let futureObjectiveId = "";
let deferredObjectiveId = "";

async function insertSchedule(
  target: { workspaceId: string; userId: string; objectiveId: string },
  opts: { nextReviewDays: number; deferredDaysFromNow?: number },
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${target.workspaceId}, true)`;
    await tx`
      INSERT INTO review_schedules
        (id, workspace_id, user_id, subject_type, subject_id, status,
         next_review_at, user_deferred_until, interval_days, generation,
         policy_version, reason_code, created_at, updated_at)
      VALUES
        (${randomUUID()}, ${target.workspaceId}, ${target.userId}, 'card', ${target.objectiveId},
         'pending',
         now() + (${opts.nextReviewDays} * interval '1 day'),
         ${opts.deferredDaysFromNow === undefined
    ? null
    : new Date(Date.now() + opts.deferredDaysFromNow * 86_400_000)},
         1, 1, 'l23-fixture', 'fixture', now(), now())
    `;
  });
}

/** 同一个工作区里再长一个目标 + 一张活卡（0287 之后不能再靠"多插一条"造场景）。 */
async function addObjective(workspaceId: string, userId: string, label: string): Promise<string> {
  const added = await addV2ObjectiveToWorkspace(sql, workspaceId, userId, {
    objectiveStatement: `理解${label}`,
    publicSummary: label,
  });
  return added.objectiveId;
}

before(async () => {
  const target = await seedV2Fixture(sql);
  seeded.push(target);
  dueObjectiveId = target.objectiveId;
  futureObjectiveId = await addObjective(target.workspaceId, target.userId, "未来到期");
  deferredObjectiveId = await addObjective(target.workspaceId, target.userId, "被稍后挡住");

  const scope = { workspaceId: target.workspaceId, userId: target.userId };
  await insertSchedule({ ...scope, objectiveId: dueObjectiveId }, { nextReviewDays: -1 });
  await insertSchedule({ ...scope, objectiveId: futureObjectiveId }, { nextReviewDays: 2 });
  await insertSchedule(
    { ...scope, objectiveId: deferredObjectiveId },
    { nextReviewDays: -1, deferredDaysFromNow: 1 },
  );
});

after(async () => {
  for (const target of seeded) await target.cleanup();
  await sql.end();
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase();
});

test("读数对得上：只有到点且没被「稍后」挡住的那条算待复习", async () => {
  const target = seeded[0];
  const queue = await listReviews(target.workspaceId, { includeAll: false, limit: 50 }, target.userId);
  const overview = await getStatsOverview(target.workspaceId, target.userId);
  assert.equal(queue.total, 1, `夹具三条排程应当只剩 1 条到点，实际 ${queue.total} 条——队列判据变了`);
  // 还要确认"剩的那一条"确实是被留下��那条，而不是碰巧只剩某一条。
  const subjects = queue.items.map((item) => item.objective?.id ?? item.review.subjectId);
  assert.deepEqual(subjects, [dueObjectiveId], "留下的是别的目标：到点与延后判据挂到了同一处");
  assert.equal(
    overview.pendingReviewCount,
    queue.total,
    `屏幕上的"待复习"(${overview.pendingReviewCount}) 与列表条数(${queue.total}) 不是同一个数`,
  );
});

test("正向对照：把到点那条推到未来，两个数一起变成 0", async () => {
  const target = seeded[0];
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${target.workspaceId}, true)`;
    await tx`
      UPDATE review_schedules
      SET next_review_at = now() + interval '9 days', user_deferred_until = NULL
      WHERE workspace_id = ${target.workspaceId}
    `;
  });
  const queue = await listReviews(target.workspaceId, { includeAll: false, limit: 50 }, target.userId);
  const overview = await getStatsOverview(target.workspaceId, target.userId);
  assert.equal(queue.total, 0, "推到 9 天之后队列还有条数——到点那一半没判");
  assert.equal(overview.pendingReviewCount, queue.total, "两个数只在有内容时相等，边界上不成立");
});
