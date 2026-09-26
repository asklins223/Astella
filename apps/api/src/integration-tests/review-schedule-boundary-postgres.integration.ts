/**
 * 唯一调度边界与 0287 那条部分唯一索引（39d W7-2 的前置；D2 §3.1–§3.3）。
 *
 * W7-2 的第二颗按钮（「保存并开启复习」）要成立，"建立或关联**唯一**那条安排"必须
 * 先有一件事可调用。这份集测钉的就是那一件事与它的键：
 *
 *  1. 同一 (空间, 人, 目标, 维度) 第二次调用**不再插行**，交回库里那一条的
 *     **同一 id 与实际到期时间**——报一个没人持有的日期就是假回执；
 *  2. 维度参与键：换个维度就是另一条待办（不然"同一目标的两个观察面"会互相吞掉）；
 *  3. 索引是**部分的**：终态行留历史，同一维度完成一次之后可以再排下一次；
 *  4. 挡住的不是函数而是索引：绕过边界函数裸插第二行，数据库当场拒（23505）；
 *  5. 空间/人参与键，且受限角色下**没有 session 上下文就是零行**（这一条同时是
 *     上面几条读法的正控制——读得到东西，"没涨行"才算数）。
 *
 * 环境口径与轮次族一致：夹具写走 `DATABASE_URL_MIGRATOR`（超户），被测路径经
 * `withWorkspaceTransaction` 跑在 `DATABASE_URL_API`（受限角色）上。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const fixtureUrl = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!fixtureUrl || !process.env.DATABASE_URL_API) {
  throw new Error("调度边界集测需要 DATABASE_URL_MIGRATOR（夹具）＋DATABASE_URL_API（受限角色）");
}
const fixtureSql = postgres(fixtureUrl, { max: 4 });
const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const { ensurePendingReviewScheduleV2 } = await import("../modules/review/review-schedule-boundary.ts");
const { reviewSchedules } = await import("@ailearn/shared/db-schema/evidence");
const { and, eq } = await import("drizzle-orm");

const USER_ID = randomUUID();
const WORKSPACE_A = randomUUID();
const WORKSPACE_B = randomUUID();
const SUBJECT_ID = randomUUID();
const DAY = 24 * 60 * 60 * 1000;

const ctxA = { workspaceId: WORKSPACE_A, userId: USER_ID };
const at = new Date("2026-09-26T09:00:00.000Z");

function scheduleInput(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: WORKSPACE_A,
    userId: USER_ID,
    subjectId: SUBJECT_ID,
    nextReviewAt: new Date(at.getTime() + DAY),
    intervalDays: 1,
    generation: 1,
    policyVersion: "discrete-v2",
    reasonCode: "demonstrated",
    at,
    ...overrides,
  };
}

async function pendingRows(context = ctxA) {
  return withWorkspaceTransaction(context, async (tx) => tx
    .select({
      id: reviewSchedules.id,
      dimension: reviewSchedules.reviewDimension,
      nextReviewAt: reviewSchedules.nextReviewAt,
      status: reviewSchedules.status,
    })
    .from(reviewSchedules)
    .where(and(
      eq(reviewSchedules.workspaceId, context.workspaceId),
      eq(reviewSchedules.userId, context.userId),
      eq(reviewSchedules.subjectId, SUBJECT_ID),
    )));
}

before(async () => {
  await fixtureSql`INSERT INTO users (id, email, password_hash)
    VALUES (${USER_ID}, ${`sched-boundary-${USER_ID}@example.invalid`}, 'unused')`;
  for (const workspaceId of [WORKSPACE_A, WORKSPACE_B]) {
    await fixtureSql`INSERT INTO workspaces (id, owner_id, name)
      VALUES (${workspaceId}, ${USER_ID}, ${`Sched Boundary ${workspaceId.slice(0, 8)}`})`;
    await fixtureSql`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${USER_ID}, 'owner')`;
  }
});

after(async () => {
  await fixtureSql`DELETE FROM review_schedules WHERE user_id = ${USER_ID}`;
  for (const workspaceId of [WORKSPACE_A, WORKSPACE_B]) {
    await fixtureSql`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
    await fixtureSql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
  }
  await fixtureSql`DELETE FROM users WHERE id = ${USER_ID}`;
  await fixtureSql.end({ timeout: 5 });
  await closeDatabase();
});

test("同一格第二次调用不再插行，交回的是库里那一条的 id 与实际到期时间", async () => {
  const first = await withWorkspaceTransaction(ctxA, (tx) => ensurePendingReviewScheduleV2(tx, scheduleInput()));
  assert.equal(first.created, true);
  // 第二次算出来的日期**不同**（并发送来的是另一个决策）——复用时必须交回已有那一条。
  const later = new Date(at.getTime() + 30 * DAY);
  const second = await withWorkspaceTransaction(ctxA, (tx) => ensurePendingReviewScheduleV2(tx, scheduleInput({
    nextReviewAt: later,
    intervalDays: 30,
  })));
  assert.equal(second.created, false, "第二次不该再建一份");
  assert.equal(second.scheduleId, first.scheduleId, "交回的是同一条安排");
  assert.equal(new Date(second.nextReviewAt).getTime(), new Date(first.nextReviewAt).getTime(),
    "到期时间必须是库里那一条，不是这次算出来的");
  assert.notEqual(new Date(second.nextReviewAt).getTime(), later.getTime());
  const rows = await pendingRows();
  assert.equal(rows.filter((row) => row.status === "pending").length, 1, "待处理的只有一份");
});

test("维度参与键：换一个观察维度就是另一条待办", async () => {
  const a = await withWorkspaceTransaction(ctxA, (tx) => ensurePendingReviewScheduleV2(tx,
    scheduleInput({ reviewDimension: "recall" })));
  const b = await withWorkspaceTransaction(ctxA, (tx) => ensurePendingReviewScheduleV2(tx,
    scheduleInput({ reviewDimension: "apply" })));
  assert.equal(a.created, true);
  assert.equal(b.created, true, "不同维度不该互相吞掉");
  const dimensions = (await pendingRows()).filter((row) => row.status === "pending")
    .map((row) => row.dimension).sort();
  assert.deepEqual(dimensions.filter((d) => ["recall", "apply"].includes(d)), ["apply", "recall"]);
});

test("索引是部分的：完成一次之后，同一维度可以再排下一次（终态行留历史）", async () => {
  const before = await withWorkspaceTransaction(ctxA, (tx) => ensurePendingReviewScheduleV2(tx,
    scheduleInput({ reviewDimension: "wrap" })));
  assert.equal(before.created, true);
  await fixtureSql`UPDATE review_schedules SET status = 'completed' WHERE id = ${before.scheduleId}`;
  const after = await withWorkspaceTransaction(ctxA, (tx) => ensurePendingReviewScheduleV2(tx,
    scheduleInput({ reviewDimension: "wrap", generation: 2 })));
  assert.equal(after.created, true, "上一份已经终态，这一份是新的待办");
  assert.notEqual(after.scheduleId, before.scheduleId);
  const rows = await pendingRows();
  assert.equal(rows.filter((row) => row.dimension === "wrap").length, 2, "两行历史都留着");
});

test("挡住重复的是索引不是函数：绕过边界函数裸插第二行，数据库当场拒", async () => {
  await withWorkspaceTransaction(ctxA, (tx) => ensurePendingReviewScheduleV2(tx,
    scheduleInput({ reviewDimension: "raw" })));
  // 裸 insert 走的是**列**，不是边界函数那份输入（差一个 `subjectType` 就会红成
  // 23502 not_null 而不是 23505——第一次就栽在这里，认错了会以为索引没生效）。
  await assert.rejects(() => withWorkspaceTransaction(ctxA, (tx) => tx.insert(reviewSchedules).values({
    workspaceId: WORKSPACE_A,
    userId: USER_ID,
    subjectType: "card",
    subjectId: SUBJECT_ID,
    reviewDimension: "raw",
    status: "pending",
    nextReviewAt: new Date(at.getTime() + 7 * DAY),
    intervalDays: 7,
    generation: 1,
    policyVersion: "discrete-v2",
    reasonCode: "demonstrated",
    createdAt: at,
    updatedAt: at,
  }).execute()), (error: unknown) => {
    const code = (error as { code?: string; cause?: { code?: string } }).code
      ?? (error as { cause?: { code?: string } }).cause?.code;
    assert.equal(code, "23505", `应撞 review_schedules_pending_subject_dim_unique，实到 ${code}`);
    return true;
  });
});

test("空间参与键，且不带 session 上下文时受限角色一行都读不到", async () => {
  const otherWorkspace = randomUUID();
  await fixtureSql`INSERT INTO workspaces (id, owner_id, name) VALUES (${otherWorkspace}, ${USER_ID}, 'Sched Other')`;
  await fixtureSql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${otherWorkspace}, ${USER_ID}, 'owner')`;
  const ctxB = { workspaceId: otherWorkspace, userId: USER_ID };
  const inB = await withWorkspaceTransaction(ctxB, (tx) => ensurePendingReviewScheduleV2(tx,
    scheduleInput({ workspaceId: otherWorkspace, reviewDimension: "cross" })));
  assert.equal(inB.created, true, "另一个空间同一目标可以有自己的那一份");
  const inA = await pendingRows();
  assert.ok(!inA.some((row) => row.id === inB.scheduleId), "A 空间读不到 B 空间那一条");

  // 正控制：下面那句"零行"要能区分"被 RLS 挡了"与"根本没连上/没数据"。
  const withContext = await fixtureSql`
    SELECT count(*)::int AS n FROM review_schedules
    WHERE workspace_id = ${WORKSPACE_A} AND user_id = ${USER_ID}`;
  assert.ok(Number(withContext[0].n) > 0, "夹具确实写在 A 空间名下");
  const apiUrl = process.env.DATABASE_URL_API!;
  const bare = postgres(apiUrl, { max: 1 });
  try {
    const zero = await bare`SELECT count(*)::int AS n FROM review_schedules`;
    assert.equal(Number(zero[0].n), 0, "受限角色不带 set_config 时应一行可读（RLS 生效）");
  } finally {
    await bare.end({ timeout: 5 });
    await fixtureSql`DELETE FROM review_schedules WHERE workspace_id = ${otherWorkspace}`;
    await fixtureSql`DELETE FROM workspace_members WHERE workspace_id = ${otherWorkspace}`;
    await fixtureSql`DELETE FROM workspaces WHERE id = ${otherWorkspace}`;
  }
});
