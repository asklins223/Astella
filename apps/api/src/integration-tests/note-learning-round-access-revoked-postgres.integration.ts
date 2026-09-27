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
const rounds = await import("../modules/note-learning-rounds/round-service.ts");
// `import()` 是表达式，解构里**不能**写内联 `type` 修饰（TS1005）；类型另起一条 import type。
const { seedNotesOnlyWorkspace } = await import("./helpers/pure-v2-workspace-fixture.ts");

const HASH = "a".repeat(64);
const TEACHING_CONTENT = {
  version: 1 as const,
  blocks: [{ kind: "paragraph" as const, text: "索引不总是更快，因为回表也有代价。" }],
};

let seeded: NotesOnlyWorkspaceFixture | null = null;
let workspaceId = "";
let authorId = "";
/** 那位曾经能读、后来失权的成员。 */
let memberId = "";
let noteId = "";
let noteVersionId = "";
let roundId = "";
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
  const created = await withWorkspaceTransaction(author(), (tx) => rounds.createRound(tx, author(), {
    noteId,
    noteVersionId,
    sourceContentHash: HASH,
    evidenceSnapshotIds: [],
    drivingQuestion: "判断为什么有索引，查询仍然可能慢",
    drivingQuestionSource: "suggested",
    budgets: { maxModelCalls: 6, maxWallClockSeconds: 600, maxTasks: 4 },
  }));
  roundId = created.roundId;

  const artifact = randomUUID();
  const teaching = randomUUID();
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${authorId}, true)`;
    await tx`INSERT INTO note_learning_round_artifacts
        (id, workspace_id, user_id, round_id, kind, html, snapshot_hash)
      VALUES (${artifact}, ${workspaceId}, ${authorId}, ${roundId}, 'dynamic_explanation',
        ${'<html><body>索引不总是更快，因为回表也有代价。</body></html>'}, ${HASH})`;
    await tx`INSERT INTO note_learning_round_teachings
        (id, workspace_id, user_id, round_id, ordinal, kind, content, source_block_ordinals,
         personal_source_snapshots, snapshot_hash, driving_question_revision, artifact_id)
      VALUES (${teaching}, ${workspaceId}, ${authorId}, ${roundId}, 1, 'explanation',
        ${tx.json(TEACHING_CONTENT)}, ${`{0}`}::int[], ${tx.json([])}, ${HASH}, 1, ${artifact})`;
  });
  teachingId = teaching;
  artifactId = artifact;
});

after(async () => {
  // 顺序要紧：先子表（产物/讲解）后轮次，否则 FK 自己撞。
  if (roundId) {
    await fixtureSql`DELETE FROM note_learning_round_teachings WHERE round_id = ${roundId}`;
    await fixtureSql`DELETE FROM note_learning_round_artifacts WHERE round_id = ${roundId}`;
    await fixtureSql`DELETE FROM note_learning_rounds WHERE id = ${roundId}`;
  }
  if (memberId) {
    await fixtureSql`DELETE FROM workspace_members WHERE user_id = ${memberId}`;
    await fixtureSql`DELETE FROM users WHERE id = ${memberId}`;
  }
  if (seeded) await seeded.cleanup();
  await fixtureSql.end({ timeout: 5 });
  await closeDatabase();
});

/** 共享期间，那位成员读得到的四样东西。 */
async function readAllAsMember() {
  return withWorkspaceTransaction(member(), async (tx) => ({
    round: await rounds.readRound(tx, member(), roundId),
    openRound: await rounds.readOpenRound(tx, member(), noteId),
    reusable: await rounds.findReusableTeaching(tx, member(), {
      roundId,
      kind: "explanation",
      drivingQuestionRevision: 1,
      snapshotHash: HASH,
    }),
    list: await rounds.listTeachings(tx, member(), roundId),
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
    round: await rounds.readRound(tx, author(), roundId),
    html: await rounds.readRoundArtifactHtml(tx, author(), artifactId),
  }));
  assert.ok(asAuthor.round, "作者是 created_by，可见性判据的第二支应当放行");
  assert.ok(asAuthor.html?.includes("回表"));
});

test("重新共享之后恢复可读（判据是逐次判的，不是写死的拒绝）", async () => {
  await fixtureSql`UPDATE notes SET share_scope = 'shared' WHERE id = ${noteId}`;
  const seen = await readAllAsMember();
  assert.ok(seen.round, "重新共享之后要读得回来");
  assert.ok(seen.html?.includes("回表"));
  // 收回，保持 after 之前那一篇是私有的（不影响清理，但让状态可预测）。
  await fixtureSql`UPDATE notes SET share_scope = 'private' WHERE id = ${noteId}`;
});
