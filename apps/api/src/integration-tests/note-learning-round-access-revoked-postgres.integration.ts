/**
 * 失权之后**不能靠旧快照继续学习**（39d W5-6 刀一；39 §16.13、§14.4）。
 *
 * 这一份钉的是一件此前**没有任何读点管**的事：作者把共享撤回之后，那位成员
 * 仍然读得到本轮问题、缓存讲解与整份讲解 HTML。冻结快照成了绕过权限的通道——
 * §16.13 的验收原话是"失权后不能靠旧快照继续学习"，§14.4 是"共享撤销或成员退出时，
 * 停止受保护内容的展示、练习与外发"。
 *
 * 为什么这件事之前是绿的：`note-visibility-read-sites.test.ts` 那条棘轮靠匹配
 * `from(notes)` 定位读点，而这几个读点**根本不碰 `notes` 表**——内容是经
 * `roundId → noteLearningRounds.noteId → notes` 间接取到的，判据一个 token 都没匹配上。
 * **守卫是绿的而产品规则已破**，那比缺功能更难发现，所以那份棘轮也一并在
 * `note-visibility-read-sites.test.ts` 里扩了一族。
 *
 * 角色分工照 doc 34 §1.2 与同族一致：夹具走 `DATABASE_URL_MIGRATOR`（超户），
 * 被测路径经 `withWorkspaceTransaction` 跑在 `DATABASE_URL_API`（受限角色）上。
 *
 * 每条"应当拿不到"都配一条**正控制**（同一发在共享期间确实拿得到）。没有正控制的话，
 * "全部返回 null"也可能只是夹具压根没种上——那种假绿正是本仓反复记的那类失败。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { NotesOnlyWorkspaceFixture } from "./helpers/pure-v2-workspace-fixture.ts";

const fixtureUrl = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!fixtureUrl || !process.env.DATABASE_URL_API) {
  throw new Error("失权集测需要 DATABASE_URL_MIGRATOR（夹具）＋DATABASE_URL_API（受限角色）");
}
const fixtureSql = postgres(fixtureUrl, { max: 4 });
const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const rounds = await import("../modules/note-learning-rounds/round/round-service.ts");
// `import()` 是表达式，解构里**不能**写内联 `type` 修饰（TS1005）；类型另起一条 import type。
const { seedNotesOnlyWorkspace } = await import("./helpers/pure-v2-workspace-fixture.ts");

const HASH = "a".repeat(64);
// 正文形状照 `roundTeachingContentV1Schema`（`{explanation}`），块序号 1 起
// （`sourceBlockOrdinals: z.number().int().min(1)`）。
// 此前这里写的是 `{version, blocks}`——那是**快照块**的形状，不是教学产物正文的；
// 读侧 `toTeachingContract` 用 strictObject 一解析就抛 ZodError，于是
// `findReusableTeaching` 在正控制那一发当场炸掉（2026-10-06 实测）。
const TEACHING_CONTENT = {
  explanation: "索引不总是更快，因为回表也有代价。",
};

let seeded: NotesOnlyWorkspaceFixture | null = null;
let workspaceId = "";
let authorId = "";
/** 那位曾经能读、后来失权的成员。 */
let memberId = "";
let noteId = "";
let noteVersionId = "";
/** 作者自己那一轮：撤回共享不影响它（证明闸只针对失权的那一方）。 */
let authorRoundId = "";
/** 失权的那一轮——轮次是**本人对自己那一篇**的学习记录，所以这一轮属于成员。 */
let memberRoundId = "";
let teachingId = "";
let artifactId = "";

const author = () => ({ workspaceId, userId: authorId });
const member = () => ({ workspaceId, userId: memberId });

before(async () => {
  seeded = await seedNotesOnlyWorkspace(fixtureSql, { noteCount: 1 });
  workspaceId = seeded.workspaceId;
  authorId = seeded.userId;
  [noteId] = seeded.noteIds;
  [noteVersionId] = seeded.versionIds;
  memberId = randomUUID();

  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${authorId}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role)
      VALUES (${memberId}, ${`revoked-${memberId.slice(0, 8)}@example.test`}, 'h', 'member')`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${memberId}, 'member')`;
    // 关键一步：先把这一篇**共享出去**，那位成员才真的读得到（正控制的前提）。
    await tx`UPDATE notes SET share_scope = 'shared' WHERE id = ${noteId}`;
  });

  // 轮次、讲解、动态产物都走**生产写路径**建，不手插：手插会造出产品写不出来的形状，
  // 那样测出来的"读得到"并不能证明这条路真的通。
  //
  // **两轮分属两人**，这不是为了凑数：轮次表带 `user_id`，未完成名额按
  // (workspace, user, note) 唯一——轮次是**本人对自己那一篇的学习记录**，
  // 共享笔记上的成员开的是自己那一轮（路由侧 `getNoteWithVersion` 判得了可见性，
  // `createRound` 用 `scope.userId` 落 `user_id`）。
  //
  // 此前这份夹具只建了作者那一轮、然后让成员去读它，于是正控制永远不成立
  // （`readRound` 按 `user_id = scope.userId` 过滤），后面那条"撤回后六样全读不到"
  // 就成了**空断言**：它为真的唯一原因是"本来就一样都读不到"。
  // 2026-10-06 实测：正控制与"重新共享后恢复可读"两条红，正控制一红，
  // 那条空断言就没人拦了——而这正是本文件自己开头警告的假绿。
  const budget = { maxModelCalls: 6, maxWallClockSeconds: 600, maxTasks: 4 };
  authorRoundId = (await withWorkspaceTransaction(author(), (tx) => rounds.createRound(tx, author(), {
    noteId,
    noteVersionId,
    sourceContentHash: HASH,
    evidenceSnapshotIds: [],
    drivingQuestion: "判断为什么有索引，查询仍然可能慢",
    drivingQuestionSource: "suggested",
    budgets: budget,
  }))).roundId;

  memberRoundId = (await withWorkspaceTransaction(member(), (tx) => rounds.createRound(tx, member(), {
    noteId,
    noteVersionId,
    sourceContentHash: HASH,
    evidenceSnapshotIds: [],
    drivingQuestion: "我该按什么顺序把回表这件事弄明白",
    drivingQuestionSource: "user_authored",
    budgets: budget,
  }))).roundId;

  // 讲解与动态产物属于**成员那一轮**——冻结快照要挂在会失权的那个人名下，
  // 才能量到"撤回之后旧快照不再是通道"。
  const artifact = randomUUID();
  const teaching = randomUUID();
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${memberId}, true)`;
    await tx`INSERT INTO note_learning_round_artifacts
        (id, workspace_id, user_id, round_id, kind, html, snapshot_hash)
      VALUES (${artifact}, ${workspaceId}, ${memberId}, ${memberRoundId}, 'dynamic_explanation',
        ${'<html><body>索引不总是更快，因为回表也有代价。</body></html>'}, ${HASH})`;
    await tx`INSERT INTO note_learning_round_teachings
        (id, workspace_id, user_id, round_id, ordinal, kind, content, source_block_ordinals,
         personal_source_snapshots, snapshot_hash, driving_question_revision, artifact_id)
      VALUES (${teaching}, ${workspaceId}, ${memberId}, ${memberRoundId}, 1, 'explanation',
        ${tx.json(TEACHING_CONTENT)}, ${`{1}`}::int[], ${tx.json([])}, ${HASH}, 1, ${artifact})`;
  });
  teachingId = teaching;
  artifactId = artifact;
});

after(async () => {
  // 顺序要紧：先子表（产物/讲解）后轮次，否则 FK 自己撞。
  //
  // 讲解表是只追加的（0284 的 BEFORE UPDATE OR DELETE 触发器，**超级用户也拦**），
  // 所以删除必须走它自己留的绕行口子 `app.allow_history_mutation`——和
  // note-learning-round-teaching-postgres 的 `wipeRounds` 同一形状。此前这里用
  // 裸 `fixtureSql` 直接删，于是 `after` 抛
  // `note_learning_round_teachings is append-only: DELETE is not allowed`，
  // 整个文件红在夹具清理上，测试用例一条都没跑到（2026-10-05 CI 实测）。
  const roundIds = [memberRoundId, authorRoundId].filter(Boolean);
  if (roundIds.length > 0) {
    await fixtureSql.begin(async (tx) => {
      await tx`SELECT set_config('app.allow_history_mutation', 'on', true)`;
      for (const id of roundIds) {
        await tx`DELETE FROM note_learning_round_teachings WHERE round_id = ${id}`;
        await tx`DELETE FROM note_learning_round_artifacts WHERE round_id = ${id}`;
        await tx`DELETE FROM note_learning_rounds WHERE id = ${id}`;
      }
    });
  }
  if (memberId) {
    await fixtureSql`DELETE FROM workspace_members WHERE user_id = ${memberId}`;
    await fixtureSql`DELETE FROM users WHERE id = ${memberId}`;
  }
  if (seeded) await seeded.cleanup();
  await fixtureSql.end({ timeout: 5 });
  await closeDatabase();
});

/** 共享期间，那位成员读得到的六样东西（都是**他自己那一轮**）。 */
async function readAllAsMember() {
  return withWorkspaceTransaction(member(), async (tx) => ({
    round: await rounds.readRound(tx, member(), memberRoundId),
    openRound: await rounds.readOpenRound(tx, member(), noteId),
    reusable: await rounds.findReusableTeaching(tx, member(), {
      roundId: memberRoundId,
      kind: "explanation",
      drivingQuestionRevision: 1,
      snapshotHash: HASH,
    }),
    list: await rounds.listTeachings(tx, member(), memberRoundId),
    artifactRef: await rounds.readTeachingArtifactRef(tx, member(), teachingId),
    html: await rounds.readRoundArtifactHtml(tx, member(), artifactId),
  }));
}

test("正控制：共享期间那位成员六样全读得到（否则后面的「读不到」是空断言）", async () => {
  const seen = await readAllAsMember();
  assert.ok(seen.round, "轮次要读得到");
  assert.ok(seen.openRound, "未完轮次要读得到");
  assert.ok(seen.reusable, "缓存讲解要复用得到");
  assert.equal(seen.list.length, 1);
  assert.ok(seen.artifactRef, "产物指针要拿得到");
  assert.ok(seen.html?.includes("回表"), "讲解 HTML 正文要读得到");
});

test("作者撤回共享之后，六样全部读不到（§16.13 失权后不能靠旧快照继续学习）", async () => {
  await fixtureSql`UPDATE notes SET share_scope = 'private' WHERE id = ${noteId}`;
  const seen = await readAllAsMember();
  assert.equal(seen.round, null, "轮次（含本轮问题）不该再读得到");
  assert.equal(seen.openRound, null, "未完轮次不该再读得到");
  assert.equal(seen.reusable, null, "缓存讲解不该再复用得到");
  assert.deepEqual(seen.list, [], "讲解列表不该再列得出来");
  assert.equal(seen.artifactRef, null, "产物指针不该再递出去——拿到它就能取 HTML");
  assert.equal(seen.html, null, "整份讲解 HTML 不该再读得到");
});

test("作者自己始终读得到：撤回的是共享，不是那篇笔记", async () => {
  const asAuthor = await withWorkspaceTransaction(author(), async (tx) => ({
    round: await rounds.readRound(tx, author(), authorRoundId),
    openRound: await rounds.readOpenRound(tx, author(), noteId),
  }));
  assert.ok(asAuthor.round, "作者是 created_by，可见性判据的第二支应当放行");
  assert.ok(asAuthor.openRound, "作者自己那一轮不该被共享状态影响");
});

test("重新共享之后恢复可读（判据是逐次判的，不是写死的拒绝）", async () => {
  await fixtureSql`UPDATE notes SET share_scope = 'shared' WHERE id = ${noteId}`;
  const seen = await readAllAsMember();
  assert.ok(seen.round, "重新共享之后要读得回来");
  assert.ok(seen.html?.includes("回表"));
  // 收回，保持 after 之前那一篇是私有的（不影响清理，但让状态可预测）。
  await fixtureSql`UPDATE notes SET share_scope = 'private' WHERE id = ${noteId}`;
});
