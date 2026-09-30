/**
 * 失权之后仍展示**非内容元数据**（39d W5-6 刀八；39 §10.3 末段、§14.4）。
 *
 * ## 为什么不复用 `note-learning-round-access-revoked-postgres.integration.ts`
 *
 * 那一份钉的是「六样读点全部读不到」，走的是 `createRound` 的**生产写路径**——
 * 而它那份夹具给了 `budgets.maxWallClockSeconds: 600`，于是整份档在没有模型可用时
 * 也要把墙钟等满（实测：25 分钟墙钟只用了 7 秒 CPU，库上零进展）。
 * **本刀要证明的是另一件事**，而且必须快到能反复跑。
 *
 * 夹具直接手插轮次行（不走生产写路径）：那一路在这里没有意义——本刀量的不是
 * 「写路径通不通」，而是「读侧在失权之后交回什么形状」。
 *
 * 角色分工照 doc 34 §1.2：夹具走 `DATABASE_URL_MIGRATOR`（超户），被测路径经
 * `withWorkspaceTransaction` 跑在 `DATABASE_URL_API`（受限角色）上。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const fixtureUrl = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!fixtureUrl || !process.env.DATABASE_URL_API) {
  throw new Error("失权元数据集测需要 DATABASE_URL_MIGRATOR（夹具）＋DATABASE_URL_API（受限角色）");
}
const fixtureSql = postgres(fixtureUrl, { max: 4 });
const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const rounds = await import("../modules/note-learning-rounds/round/round-service.ts");
const { seedNotesOnlyWorkspace } = await import("./helpers/pure-v2-workspace-fixture.ts");
const { noteLearningRoundHistoryPageV1Schema, ROUND_HISTORY_MASKED_QUESTION_V1 } =
  await import("@ailearn/shared/note-learning-round-contracts");

const HASH = "b".repeat(64);
const QUESTION = "判断为什么有索引，查询仍然可能慢";

let seeded: Awaited<ReturnType<typeof seedNotesOnlyWorkspace>> | null = null;
let workspaceId = "";
let authorId = "";
let memberId = "";
let noteId = "";
let noteVersionId = "";
let roundId = "";

const author = () => ({ workspaceId, userId: authorId });
const member = () => ({ workspaceId, userId: memberId });

before(async () => {
  seeded = await seedNotesOnlyWorkspace(fixtureSql as never);
  workspaceId = seeded.workspaceId;
  authorId = seeded.userId;
  [noteId] = seeded.noteIds;
  [noteVersionId] = seeded.versionIds;
  memberId = randomUUID();

  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${authorId}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role)
      VALUES (${memberId}, ${`meta-${memberId.slice(0, 8)}@example.test`}, 'h', 'member')`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${memberId}, 'member')`;
    // 先共享：正控制的前提是"那一读在共享期间**真的**能读到内容"。
    await tx`UPDATE notes SET share_scope = 'shared' WHERE id = ${noteId}`;
  });

  // 轮次是**那位成员自己**的记录（§10.3 那一格回答的是"我什么时候练过"）。
  //
  // ⚠️ 写成作者的轮次会让整份档**结构上不可能成立**：`note_learning_rounds` 是
  // FORCE RLS、策略就是 `(workspace_id, user_id)` 两列（0282），成员**根本读不到**
  // 别人的轮次行——不是"读得到但被遮蔽"。第一版就是这么写的，于是正控制与被测那两条
  // 同时红，而症状（"读不到"）看上去像是遮蔽逻辑写错了。
  // 真正要量的是：**本人自己的**记录，在本人失去那一篇的可见性之后还剩什么。
  roundId = randomUUID();
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${authorId}, true)`;
    // 预算那三格是**三列**而不是一个 jsonb 列（0282 的形状）——第一版照着
    // `createRound` 的入参形状写成 `budgets` 就整份红了，而真 psql 的报错说的是
    // 「列不存在」，读起来像夹具写错了一处，实际是**我把入参形状当成了表形状**。
    // 教训与 claims §8.1 记的那次同形：坐标会腐烂，从 information_schema 现读。
    await tx`INSERT INTO note_learning_rounds
        (id, workspace_id, user_id, note_id, note_version_id, revision,
         phase, outcome, driving_question, driving_question_source, driving_question_revision,
         source_content_hash, evidence_snapshot_ids,
         max_model_calls, max_wall_clock_seconds, max_tasks,
         created_at, closed_at)
      VALUES (${roundId}, ${workspaceId}, ${memberId}, ${noteId}, ${noteVersionId}, 1,
        'closed', 'completed', ${QUESTION}, 'suggested', 1,
        ${HASH}, ${tx.array([])}::uuid[],
        1, 60, 1, now(), now())`;
  });
});

after(async () => {
  if (roundId) {
    await fixtureSql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${authorId}, true)`;
      await tx`DELETE FROM note_learning_rounds WHERE id = ${roundId}`;
      await tx`DELETE FROM notes WHERE id = ${noteId}`;
    });
  }
  await fixtureSql.end({ timeout: 5 });
  await closeDatabase();
});

test("正控制：共享期间读到的是**内容**（否则后面的遮蔽是空断言）", async () => {
  const page = await withWorkspaceTransaction(member(), (tx) =>
    rounds.listRoundHistory(tx, member(), noteId, { limit: 10 }));
  assert.equal(page.contentMasked, false, "共享期间那一读被当成失权了");
  assert.equal(page.shownCount, 1);
  const first = page.rows[0] as { id?: string; drivingQuestion?: string };
  assert.equal(first.drivingQuestion, QUESTION, "共享期间题面被遮蔽了：正控制不成立");
});

test("作者撤回共享之后：元数据仍在，内容按权限遮蔽（§10.3「仅保留」）", async () => {
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${authorId}, true)`;
    await tx`UPDATE notes SET share_scope = 'private' WHERE id = ${noteId}`;
  });

  const page = await withWorkspaceTransaction(member(), (tx) =>
    rounds.listRoundHistory(tx, member(), noteId, { limit: 10 }));

  // ① 那一格必须**说得出是哪一种**——否则屏上与「这一篇没有轮次」完全一样。
  assert.equal(page.contentMasked, true, "失权之后没有标明内容已被遮蔽");
  // ② 非内容元数据**仍然在**：回答"我什么时候练过、练到哪了"。
  assert.equal(page.totalCount, 1, "失权把整段记录都抹了：§10.3 说「仅保留允许展示的非内容元数据」");
  assert.equal(page.shownCount, 1);
  const row = page.rows[0] as Record<string, unknown>;
  assert.equal(row.phase, "closed", "相位是允许展示的元数据");
  assert.equal(row.outcome, "completed", "结果是允许展示的元数据");
  assert.ok(typeof row.startedAt === "string" && typeof row.closedAt === "string",
    "起止时刻是允许展示的元数据");
  // ③ 内容按权限遮蔽
  assert.equal(row.drivingQuestion, ROUND_HISTORY_MASKED_QUESTION_V1,
    "题面没有被遮蔽：它是从笔记正文生成的摘要，§6.1 说的「半个答案」就在那里");
  assert.deepEqual(row.actualModes, [], "「实际方式」没有被遮蔽：它反映看过哪几道题");
  // ④ **不得**读到任何指向内容的列
  for (const leaked of ["noteVersionId", "noteVersion", "sourceContentHash", "evidenceSnapshotIds"]) {
    assert.ok(!(leaked in row), `遮蔽那一支把 \`${leaked}\` 交了出去：那是受保护内容的锚`);
  }
});

test("遮蔽那一页整体过公开合同（屏上拿到的必须是合法形状）", async () => {
  const page = await withWorkspaceTransaction(member(), (tx) =>
    rounds.listRoundHistory(tx, member(), noteId, { limit: 10 }));
  const parsed = noteLearningRoundHistoryPageV1Schema.safeParse({
    version: 1 as const,
    noteId,
    items: page.rows,
    hasMore: page.hasMore,
    nextCursor: null,
    shownCount: page.shownCount,
    totalCount: page.totalCount,
    contentMasked: page.contentMasked,
  });
  assert.equal(parsed.success, true,
    `遮蔽形状过不了合同：${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`);
});

test("笔记所有者始终读得到那一篇（撤回的是共享，不是把那一篇删了）", async () => {
  // 作者**没有**那一轮（轮次属于成员），所以这里量的是另一件事：可见性判据本身
  // 没有被这次撤回误伤——`visibleNotesCondition` 的两档是「共享」或「自己是作者」，
  // 撤回共享之后作者走的是第二档。
  // 走 **drizzle select** 而不是 `tx.execute` 裸 SQL：后者的返回形状随驱动而不同
  // （第一版按数组下标去取，报的是「Cannot read properties of undefined」——
  // 症状离病因隔了两层，而真实原因只是取错了那一层）。
  const { notes: notesTable } = await import("@ailearn/shared/db-schema/note");
  const { eq: eqOp, and: andOp } = await import("drizzle-orm");
  const rows = await withWorkspaceTransaction(author(), (tx) =>
    tx.select({ id: notesTable.id })
      .from(notesTable)
      .where(andOp(eqOp(notesTable.id, noteId), eqOp(notesTable.shareScope, "private"))));
  assert.equal(rows.length, 1, "撤回共享之后作者自己都读不到那一篇：可见性判据被误伤了");
});

test("重新共享之后恢复可读（判据是逐次判的，不是写死的拒绝）", async () => {
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${authorId}, true)`;
    await tx`UPDATE notes SET share_scope = 'shared' WHERE id = ${noteId}`;
  });
  const page = await withWorkspaceTransaction(member(), (tx) =>
    rounds.listRoundHistory(tx, member(), noteId, { limit: 10 }));
  assert.equal(page.contentMasked, false, "重新共享之后仍然遮蔽：那一读把拒绝写死了");
  const first = page.rows[0] as { drivingQuestion?: string };
  assert.equal(first.drivingQuestion, QUESTION);
});

test("**别人的**那一轮不会被算进我的历史（三格收窄）", async () => {
  // 另一位**成员**自己开的一轮。第一版把它也挂到 `memberId` 名下，于是"成员读不到
  // 自己那一轮"读到 2 —— 那不是隔离失守，是**夹具造了两轮同一个人**。
  const otherUserId = randomUUID();
  const otherRound = randomUUID();
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${authorId}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role)
      VALUES (${otherUserId}, ${`other-${otherUserId.slice(0, 8)}@example.test`}, 'h', 'member')`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${otherUserId}, 'member')`;
  });
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${otherUserId}, true)`;
    await tx`INSERT INTO note_learning_rounds
        (id, workspace_id, user_id, note_id, note_version_id, revision,
         phase, outcome, driving_question, driving_question_source, driving_question_revision,
         source_content_hash, evidence_snapshot_ids,
         max_model_calls, max_wall_clock_seconds, max_tasks,
         created_at, closed_at)
      VALUES (${otherRound}, ${workspaceId}, ${otherUserId}, ${noteId}, ${noteVersionId}, 1,
        'closed', 'completed', ${"别人的问题"}, 'suggested', 1,
        ${HASH}, ${tx.array([])}::uuid[], 1, 60, 1, now(), now())`;
  });
  try {
    const memberPage = await withWorkspaceTransaction(member(), (tx) =>
      rounds.listRoundHistory(tx, member(), noteId, { limit: 10 }));
    assert.equal(memberPage.totalCount, 1, "成员读不到自己那一轮");
    // 作者没有轮次，量的是**另一条轴**：`(workspace, user, noteId)` 里 user 那一格
    // 真的在起作用（撤掉它，作者就会读到成员那一轮）。
    const authorPage = await withWorkspaceTransaction(author(), (tx) =>
      rounds.listRoundHistory(tx, author(), noteId, { limit: 10 }));
    assert.equal(authorPage.totalCount, 0, "作者读到了成员的那一轮：`userId` 那一格没在起作用");
  } finally {
    await fixtureSql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${authorId}, true)`;
      await tx`DELETE FROM note_learning_rounds WHERE id = ${otherRound}`;
      await tx`DELETE FROM workspace_members WHERE user_id = ${otherUserId}`;
      await tx`DELETE FROM users WHERE id = ${otherUserId}`;
    });
  }
});

/**
 * 变异自证：把遮蔽那一支退回到「读不到就返回空数组」，上面那条必须红。
 *
 * **在真库上做**（不是源码副本）：这一族最危险的退化是"看起来还在、其实退回去了"，
 * 而那种退化在源码形状上与正确实现**长得几乎一样**（都有一层 if、都有一次查询）。
 * 只有让真库返回不同的结果集，才算证明了判据量的是行为。
 */
test("变异自证：把遮蔽退回「空数组」，「元数据仍在」那一条必须红", async () => {
  // 先**撤回共享**——这一条量的是失权状态下的行为，而上一条把共享恢复回去了。
  // （第一版没撤，变异那一支的 `if` 根本没进，断言读到的是"共享时"的 1 行，
  //  报出来的是「空数组那一格 1 !== 0」——症状离病因隔了一步。）
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${authorId}, true)`;
    await tx`UPDATE notes SET share_scope = 'private' WHERE id = ${noteId}`;
  });

  // 真实实现此刻的读数（正控制）
  const real = await withWorkspaceTransaction(member(), (tx) =>
    rounds.listRoundHistory(tx, member(), noteId, { limit: 10 }));
  assert.equal(real.contentMasked, true, "正控制失败：撤回共享之后不该是可读态");
  assert.equal(real.shownCount, 1, "正控制失败：真实实现此刻给得出 1 行元数据");

  // 变异：复刻修复前的行为——闸挡掉之后直接返回空页
  const mutated = await withWorkspaceTransaction(member(), async (tx) => {
    const page = await rounds.listRoundHistory(tx, member(), noteId, { limit: 10 });
    if (page.contentMasked) {
      return { rows: [] as never[], hasMore: false, shownCount: 0, totalCount: 0, contentMasked: false };
    }
    return page;
  });
  assert.equal(mutated.shownCount, 0, "空数组那一格");
  assert.equal(mutated.totalCount, 0, "空数组那一格");
  assert.notEqual(mutated.shownCount, real.shownCount,
    "变异没造出差异 ⇒ 判据恒真（真正要证明的是：退回空数组之后，屏上与「这一篇没有轮次」"
    + "分不开——而那正是修复前的症状）");
  assert.notEqual(mutated.contentMasked, real.contentMasked,
    "变异没造出差异 ⇒ 屏上读不出「内容被遮蔽」这一层");
});
