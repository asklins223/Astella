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
const { reviewSchedules } = await import("@astella/shared/db-schema/evidence");
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
  // 排除那一篇要挂在真 notes 行上（`objective_review_holds_v2.note_id` 是指向它的外键），
  // 所以种在同一个钩子里、用户与工作区之后——两个 `before` 分开写会撞 users 的外键。
  await fixtureSql`INSERT INTO notes (id, workspace_id, title, created_by)
    VALUES (${NOTE_ID}, ${WORKSPACE_A}, '暂不安排那一篇', ${USER_ID})`;
});

after(async () => {
  // 排除那一篇是本文件自己种的（`notes.created_by` 是指向 users 的外键），
  // 所以必须在删用户**之前**删掉——否则这一发 cleanup 自己撞 23503，
  // 而残留的行会让下一次跑这份文件时读到别人的夹具。
  await fixtureSql`DELETE FROM notes WHERE id = ${NOTE_ID}`;
  await fixtureSql`DELETE FROM objective_review_holds_v2 WHERE user_id = ${USER_ID}`;
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
  // 没被排除的那一发必须有日期（`held` 那一档才允许没有，见边界函数的返回类型）。
  const dueOf = (result: { nextReviewAt: Date | null }): Date => {
    assert.ok(result.nextReviewAt, "这一发不该读到 held，必须有实际到期时间");
    return result.nextReviewAt;
  };
  assert.equal(dueOf(second).getTime(), dueOf(first).getTime(),
    "到期时间必须是库里那一条，不是这次算出来的");
  assert.notEqual(dueOf(second).getTime(), later.getTime());
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

// ─── W7-3 刀一：目标级「暂不安排」的执法就在这个边界里（39 §9.1 行 2、行 3）──────
//
// 这一族判据的共同形状都是"库里少一行/多一行"，所以每一格都自带正控制：
// 同一发在没有排除时必须有东西落库，否则"零增长"是读瞎。

const NOTE_ID = randomUUID();
const OTHER_OBJECTIVE = randomUUID();

async function scheduleCountFor(context: { workspaceId: string; userId: string }, subjectId: string) {
  return withWorkspaceTransaction(context, async (tx) => {
    const rows = await tx.select({ id: reviewSchedules.id }).from(reviewSchedules)
      .where(and(
        eq(reviewSchedules.workspaceId, context.workspaceId),
        eq(reviewSchedules.userId, context.userId),
        eq(reviewSchedules.subjectId, subjectId),
        eq(reviewSchedules.status, "pending"),
      ));
    return rows.length;
  });
}


test("排除挡住建立：报的是 held，不是「沿用已有那一条」，库里零增长", async () => {
  const { holdObjectiveFromReviewV2 } = await import("../modules/review/objective-review-holds.ts");
  // 正控制：同一发在没有排除时确实排得上（否则下面的"零增长"是恒真）。
  const control = await withWorkspaceTransaction(ctxA, (tx) =>
    ensurePendingReviewScheduleV2(tx, scheduleInput({ subjectId: OTHER_OBJECTIVE })));
  assert.equal(control.created, true);
  assert.equal(await scheduleCountFor(ctxA, OTHER_OBJECTIVE), 1);

  const held = await withWorkspaceTransaction(ctxA, async (tx) => {
    await holdObjectiveFromReviewV2(tx, {
      workspaceId: WORKSPACE_A, userId: USER_ID, noteId: NOTE_ID, objectiveId: SUBJECT_ID,
    });
    return ensurePendingReviewScheduleV2(tx, scheduleInput());
  });
  assert.equal(held.held, true, "被本人那句「暂不安排」挡住");
  assert.equal(held.created, false);
  assert.equal(held.scheduleId, null, "什么都没建 ⇒ 不能交回一个没人持有的 id");
  assert.equal(held.nextReviewAt, null, "沿用已有那一条与根本不许排是两句话，别混");
  assert.equal(await scheduleCountFor(ctxA, SUBJECT_ID), 0, "被排除的这一发不许在库里留下待办");
  assert.equal(await scheduleCountFor(ctxA, OTHER_OBJECTIVE), 1,
    "规则原话是「不停止其他目标」：同一个人别的目标照旧");
});

test("点下去有看得见的后果：这个目标已排着的那一条从队列撤下，历史行不删", async () => {
  const { holdObjectiveFromReviewV2 } = await import("../modules/review/objective-review-holds.ts");
  const objective = randomUUID();
  await withWorkspaceTransaction(ctxA, async (tx) => {
    await ensurePendingReviewScheduleV2(tx, scheduleInput({ subjectId: objective }));
    assert.equal(await scheduleCountFor(ctxA, objective), 1, "先要真的排着一条");
    // 同一个人的另一个目标也排着，用来挡"顺手把别的也撤了"这一支错。
    await ensurePendingReviewScheduleV2(tx, scheduleInput({ subjectId: OTHER_OBJECTIVE }));
  });

  const result = await withWorkspaceTransaction(ctxA, (tx) => holdObjectiveFromReviewV2(tx, {
    workspaceId: WORKSPACE_A, userId: USER_ID, noteId: NOTE_ID, objectiveId: objective,
  }));
  assert.equal(result.dismissedPendingSchedules, 1,
    "「暂不安排」必须把她下一次照面里那条待办也撤掉，不然这句话只挡未来、不挡现在");
  assert.equal(await scheduleCountFor(ctxA, objective), 0);
  assert.equal(await scheduleCountFor(ctxA, OTHER_OBJECTIVE), 1, "别的目标一条都不许动");

  const history = await fixtureSql`
    SELECT status FROM review_schedules WHERE subject_id = ${objective}
  ` as unknown as Array<{ status: string }>;
  assert.equal(history.length, 1, "历史行留在表里（§9.1：不删除历史）");
  assert.equal(history[0]?.status, "dismissed");
});

test("解除是显式动作：恢复之后同一发才排得上，且活/历史两份读数分得开", async () => {
  const {
    holdObjectiveFromReviewV2, releaseObjectiveHoldV2, liveHoldForObjectiveV2,
  } = await import("../modules/review/objective-review-holds.ts");
  const objective = randomUUID();
  await withWorkspaceTransaction(ctxA, (tx) => holdObjectiveFromReviewV2(tx, {
    workspaceId: WORKSPACE_A, userId: USER_ID, noteId: NOTE_ID, objectiveId: objective,
  }));
  // 连点两下：只有一份活行（部分唯一索引挡住第二份，交回的是那一条）。
  const again = await withWorkspaceTransaction(ctxA, (tx) => holdObjectiveFromReviewV2(tx, {
    workspaceId: WORKSPACE_A, userId: USER_ID, noteId: NOTE_ID, objectiveId: objective,
  }));
  assert.equal(again.created, false, "第二次不该说「这次才立上」");

  const blocked = await withWorkspaceTransaction(ctxA, (tx) =>
    ensurePendingReviewScheduleV2(tx, scheduleInput({ subjectId: objective })));
  assert.equal(blocked.held, true);

  const released = await withWorkspaceTransaction(ctxA, (tx) => releaseObjectiveHoldV2(tx, {
    workspaceId: WORKSPACE_A, userId: USER_ID, objectiveId: objective,
    releaseReason: "user_resumed_objective", at: new Date(),
  }));
  assert.equal(released.released, true);
  const stillHeld = await withWorkspaceTransaction(ctxA, (tx) => liveHoldForObjectiveV2(tx, {
    workspaceId: WORKSPACE_A, userId: USER_ID, objectiveId: objective,
  }));
  assert.equal(stillHeld, null, "解除之后不该还有活行");

  const scheduled = await withWorkspaceTransaction(ctxA, (tx) =>
    ensurePendingReviewScheduleV2(tx, scheduleInput({ subjectId: objective })));
  assert.equal(scheduled.created, true, "恢复了就该排得上——这一格挡的是「解了等于没解」");

  const rows = await fixtureSql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE released_at IS NULL)::int AS live
    FROM objective_review_holds_v2 WHERE objective_id = ${objective}
  ` as unknown as Array<{ total: number; live: number }>;
  assert.equal(Number(rows[0]?.live), 0, "没有活的排除");
  assert.equal(Number(rows[0]?.total), 1,
    `解除留的是历史行而不是删行（读到 ${String(rows[0]?.total)} 行）——"她什么时候恢复的"要读得出来`);
});
