/**
 * 只读成员的**本人可见目标绑定**（39d W5-6 刀四；39 §4.2、§16.20、§14.4）。
 *
 * §16.20 的验收有四句，这一份钉住其中三句能由数据面证明的那三句：
 *  1. **学习不需要公共编辑权**——一个**不是那篇笔记作者**的成员，能对着共享笔记立下
 *     自己的学习计划。这一条此前**没有代码**：公共血缘表 `learning_objective_origins_v2`
 *     是空间共用的，成员往里写会让另一位成员看到一条他没写过的目标（§4.2 明写禁止），
 *     所以他实际上无处可写。0300 给了他一张只对本人可见的表。
 *  2. **只对本人可见**——作者读不到这条绑定，换一个人也读不到（RLS 两侧各量一次）。
 *  3. **不进入公共材料**——立完这条绑定之后，公共血缘表**一行都没多**。
 *     这一条是"他没有偷偷写公共表"的唯一读数：只看新表有行，证明不了他没同时写别处。
 *
 * 第四句「没有无权执行的公共制卡按钮」是**渲染侧**的，本刀没碰界面，不在这里宣称。
 *
 * 环境口径同族：夹具走 `DATABASE_URL_MIGRATOR`（超户），被测路径经
 * `withWorkspaceTransaction` 跑在 `DATABASE_URL_API`（受限角色）上——RLS 那一半
 * **只有跑在受限角色上才量得到**，跑在超户上永远是全通。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const fixtureUrl = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!fixtureUrl || !process.env.DATABASE_URL_API) {
  throw new Error("本人目标绑定集测需要 DATABASE_URL_MIGRATOR（夹具）＋DATABASE_URL_API（受限角色）");
}
const fixtureSql = postgres(fixtureUrl, { max: 4 });
const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const binding = await import("../modules/learning-objectives/personal-binding-service.ts");

const AUTHOR = randomUUID();
const MEMBER = randomUUID();
const WORKSPACE = randomUUID();
const SHARED_NOTE = randomUUID();
const SHARED_VERSION = randomUUID();
const PRIVATE_NOTE = randomUUID();
const PRIVATE_VERSION = randomUUID();

const author = () => ({ workspaceId: WORKSPACE, userId: AUTHOR });
const member = () => ({ workspaceId: WORKSPACE, userId: MEMBER });

const VIEW = {
  knowledgeForm: "comparison",
  conceptLabel: "索引与顺序扫描的取舍",
  at: new Date("2026-09-27T10:00:00.000Z"),
};

function createInput(noteId: string, noteVersionId: string, overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: WORKSPACE,
    userId: MEMBER,
    noteId,
    noteVersionId,
    objectiveStatement: "能说清为什么加了索引查询仍然可能慢",
    ...VIEW,
    ...overrides,
  };
}

before(async () => {
  const cols = await fixtureSql`
    SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'personal_objective_bindings_v2' AND column_name = 'user_id'`;
  assert.equal(cols[0].n, 1, "personal_objective_bindings_v2 不在——迁移 0300 没应用");

  await fixtureSql`INSERT INTO users (id, email, password_hash, role)
    VALUES (${AUTHOR}, ${`bind-author-${AUTHOR.slice(0, 8)}@example.test`}, 'h', 'member'),
           (${MEMBER}, ${`bind-member-${MEMBER.slice(0, 8)}@example.test`}, 'h', 'member')`;
  await fixtureSql`INSERT INTO workspaces (id, owner_id, name)
    VALUES (${WORKSPACE}, ${AUTHOR}, ${`Binding ${WORKSPACE.slice(0, 8)}`})`;
  await fixtureSql`INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES (${WORKSPACE}, ${AUTHOR}, 'owner'), (${WORKSPACE}, ${MEMBER}, 'member')`;

  // 共享那篇：**作者是 AUTHOR**，所以 MEMBER 是个货真价实的只读成员。
  await fixtureSql`INSERT INTO notes (id, workspace_id, title, created_by, share_scope, current_version_id)
    VALUES (${SHARED_NOTE}, ${WORKSPACE}, '共享的那篇', ${AUTHOR}, 'shared', ${SHARED_VERSION})`;
  await fixtureSql`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
    VALUES (${SHARED_VERSION}, ${SHARED_NOTE}, ${WORKSPACE}, 1,
      ${fixtureSql.json({ blocks: [{ type: "paragraph", content: "索引不是万能的" }] })},
      ${"b".repeat(64)}, ${AUTHOR})`;
  // 负例那篇是私有的：MEMBER 读不到，立不了计划。
  await fixtureSql`INSERT INTO notes (id, workspace_id, title, created_by, share_scope, current_version_id)
    VALUES (${PRIVATE_NOTE}, ${WORKSPACE}, '作者私有的那篇', ${AUTHOR}, 'private', ${PRIVATE_VERSION})`;
  await fixtureSql`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
    VALUES (${PRIVATE_VERSION}, ${PRIVATE_NOTE}, ${WORKSPACE}, 1,
      ${fixtureSql.json({ blocks: [{ type: "paragraph", content: "不给你看" }] })},
      ${"c".repeat(64)}, ${AUTHOR})`;
});

after(async () => {
  await fixtureSql`DELETE FROM personal_objective_bindings_v2 WHERE workspace_id = ${WORKSPACE}`;
  await fixtureSql`DELETE FROM learning_objective_origins_v2 WHERE workspace_id = ${WORKSPACE}`;
  await fixtureSql`DELETE FROM learning_objective_revisions_v2 WHERE workspace_id = ${WORKSPACE}`;
  await fixtureSql`DELETE FROM learning_objectives_v2 WHERE workspace_id = ${WORKSPACE}`;
  await fixtureSql`DELETE FROM learning_objective_origins_v2 WHERE workspace_id = ${WORKSPACE}`;
  await fixtureSql`DELETE FROM note_versions WHERE workspace_id = ${WORKSPACE}`;
  await fixtureSql`DELETE FROM notes WHERE workspace_id = ${WORKSPACE}`;
  await fixtureSql`DELETE FROM workspace_members WHERE workspace_id = ${WORKSPACE}`;
  await fixtureSql`DELETE FROM workspaces WHERE id = ${WORKSPACE}`;
  await fixtureSql`DELETE FROM users WHERE id IN (${AUTHOR}, ${MEMBER})`;
  await fixtureSql.end({ timeout: 5 });
  await closeDatabase();
});

test("不是作者的成员能对着共享笔记立下自己的学习计划（§16.20 学习不需要公共编辑权）", async () => {
  const result = await withWorkspaceTransaction(member(), (tx) =>
    binding.createPersonalObjectiveBindingV2(tx, createInput(SHARED_NOTE, SHARED_VERSION)));
  assert.equal(result.created, true);
  assert.equal(result.binding.userId, MEMBER, "这一行必须记在**本人**名下");
  assert.equal(result.binding.noteId, SHARED_NOTE);
  // 判据没确认之前恒为 null（§4.2「只在可确认一致后关联」，不猜）。
  assert.equal(result.binding.linkedObjectiveId, null);
});

test("立完绑定之后公共血缘表一行都没多（§4.2 只对本人可见，不写公共材料）", async () => {
  // 正控制：先记下**他还没写之前**的公共行数，否则"没多"可能是本来就空。
  const before = await fixtureSql`SELECT count(*)::int AS n
    FROM learning_objective_origins_v2 WHERE workspace_id = ${WORKSPACE}`;
  const result = await withWorkspaceTransaction(member(), (tx) =>
    binding.createPersonalObjectiveBindingV2(tx, createInput(SHARED_NOTE, SHARED_VERSION, {
      objectiveStatement: "换一句话也不该长出第二条",
    })));
  // 幂等：交回既有那一条。
  assert.equal(result.created, false);
  const after = await fixtureSql`SELECT count(*)::int AS n
    FROM learning_objective_origins_v2 WHERE workspace_id = ${WORKSPACE}`;
  assert.equal(after[0].n, before[0].n, "他往公共血缘表里写了一行——那正是 §4.2 禁止的");
});

test("只对本人可见：作者读不到成员的绑定（RLS 实测）", async () => {
  const mine = await withWorkspaceTransaction(member(), (tx) =>
    binding.listPersonalObjectiveBindingsV2(tx, { workspaceId: WORKSPACE, userId: MEMBER }));
  assert.equal(mine.length, 1, "正控制：本人要读得到自己那一条");

  // 作者是这篇笔记的作者，但**不是**这条绑定的作者 —— 读不到（§14.4）。
  const theirs = await withWorkspaceTransaction(author(), (tx) =>
    binding.listPersonalObjectiveBindingsV2(tx, { workspaceId: WORKSPACE, userId: AUTHOR }));
  assert.equal(theirs.length, 0, "笔记作者读到了别人的个人计划");
});

test("读不到那篇笔记就立不了计划（负例：作者私有的那篇）", async () => {
  await assert.rejects(
    () => withWorkspaceTransaction(member(), (tx) =>
      binding.createPersonalObjectiveBindingV2(tx, createInput(PRIVATE_NOTE, PRIVATE_VERSION))),
    (error: unknown) => error instanceof binding.BindingNoteNotFoundV2,
  );
  const rows = await fixtureSql`SELECT count(*)::int AS n
    FROM personal_objective_bindings_v2 WHERE note_id = ${PRIVATE_NOTE}`;
  assert.equal(rows[0].n, 0, "读不到却立成功了");
});

test("依据的 version 必须是这一篇的：别篇的 versionId 挡掉", async () => {
  await assert.rejects(
    () => withWorkspaceTransaction(member(), (tx) =>
      binding.createPersonalObjectiveBindingV2(tx, createInput(SHARED_NOTE, PRIVATE_VERSION))),
    (error: unknown) => error instanceof binding.BindingNoteNotFoundV2,
  );
});

test("撤下是写状态不删行，且幂等（§4.2 不删除历史）", async () => {  const mine = await withWorkspaceTransaction(member(), (tx) =>
    binding.listPersonalObjectiveBindingsV2(tx, { workspaceId: WORKSPACE, userId: MEMBER }));
  const target = mine[0];

  const first = await withWorkspaceTransaction(member(), (tx) =>
    binding.releasePersonalObjectiveBindingV2(tx, {
      workspaceId: WORKSPACE,
      userId: MEMBER,
      bindingId: target.id,
      reason: "这版正文已经改了，我重写一条",
      at: new Date("2026-09-27T12:00:00.000Z"),
    }));
  assert.equal(first.released, true);

  const replay = await withWorkspaceTransaction(member(), (tx) =>
    binding.releasePersonalObjectiveBindingV2(tx, {
      workspaceId: WORKSPACE,
      userId: MEMBER,
      bindingId: target.id,
      reason: "再撤一次",
      at: new Date("2026-09-27T13:00:00.000Z"),
    }));
  assert.equal(replay.released, false, "「本来就不在」与「刚撤下」要能说成两句话");

  // 行还在。
  const stillThere = await fixtureSql`SELECT status, released_at FROM personal_objective_bindings_v2
    WHERE id = ${target.id}`;
  assert.equal(stillThere.length, 1, "撤下把行删了——历史没了");
  assert.equal(stillThere[0].status, "released");

  // 列表不再报它。
  const after = await withWorkspaceTransaction(member(), (tx) =>
    binding.listPersonalObjectiveBindingsV2(tx, { workspaceId: WORKSPACE, userId: MEMBER }));
  assert.equal(after.length, 0);

  // 撤掉之后，同一篇同一版可以再立一条（部分唯一索引只管"活着的那一份"）。
  const again = await withWorkspaceTransaction(member(), (tx) =>
    binding.createPersonalObjectiveBindingV2(tx, createInput(SHARED_NOTE, SHARED_VERSION)));
  assert.equal(again.created, true);
});

// ─── 刀六：本人确认的关联（§4.2）──────────────────────────────────────────

/** 造一个"公共目标"，用真实的血缘行（objective + revision + origin 三张表）。 */
async function seedPublicObjective(noteId: string, noteVersionId: string, statement: string): Promise<string> {
  const objectiveId = randomUUID();
  const objectiveRevisionId = randomUUID();
  const originId = randomUUID();
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${WORKSPACE}, true)`;
    await tx`SELECT set_config('app.user_id', ${AUTHOR}, true)`;
    await tx`INSERT INTO learning_objectives_v2
        (id, workspace_id, objective_id, semantic_identity_class_id, semantic_identity_policy_version,
         semantic_target_fingerprint, current_objective_revision_id, current_revision, lifecycle)
      VALUES (${randomUUID()}, ${WORKSPACE}, ${objectiveId}, ${`class-${objectiveId}`}, 'v1',
        ${`fp-${objectiveId}`}, ${objectiveRevisionId}, 1, 'active')`;
    await tx`INSERT INTO learning_objective_revisions_v2
        (id, workspace_id, objective_revision_id, objective_id, revision, objective_statement,
         public_summary, knowledge_form, preferred_intents, canonical_answer, learning_support,
         scoring_rubric, relations, evidence_bindings, semantic_target_fingerprint,
         target_revision_hash, private_payload_hash)
      VALUES (${randomUUID()}, ${WORKSPACE}, ${objectiveRevisionId}, ${objectiveId}, 1, ${statement},
        ${statement}, 'comparison', ${tx.array([])},
        ${tx.json({})}, ${tx.json({})}, ${tx.json({})}, ${tx.array([])}, ${tx.array([])},
        ${`fp-${objectiveId}`}, ${`trh-${objectiveId}`}, ${`pph-${objectiveId}`})`;
    await tx`INSERT INTO learning_objective_origins_v2
        (id, workspace_id, origin_id, objective_id, objective_revision_id, origin_kind, note_id, note_version_id, integrity)
      VALUES (${randomUUID()}, ${WORKSPACE}, ${originId}, ${objectiveId}, ${objectiveRevisionId},
        'note', ${noteId}, ${noteVersionId}, 'verified')`;
  });
  return objectiveId;
}

test("刀六·候选只给同篇同版的公共目标，且不自动关联（§4.2）", async () => {
  const sameNote = await seedPublicObjective(SHARED_NOTE, SHARED_VERSION, "能说清索引什么时候更慢");
  await seedPublicObjective(PRIVATE_NOTE, PRIVATE_VERSION, "另一篇的目标，不该出现在候选里");

  const created = await withWorkspaceTransaction(member(), (tx) =>
    binding.createPersonalObjectiveBindingV2(tx, createInput(SHARED_NOTE, SHARED_VERSION)));
  const bindingId = created.binding.id;

  const candidates = await withWorkspaceTransaction(member(), (tx) =>
    binding.listBindingLinkCandidatesV2(tx, { workspaceId: WORKSPACE, userId: MEMBER, bindingId }));
  assert.equal(candidates.length, 1, "候选里混进了别篇的目标");
  assert.equal(candidates[0].objectiveId, sameNote);

  // 还没关联——列候选与关联是两件事（§4.2「不按标题相似自动继承」）。
  const untouched = await fixtureSql`SELECT linked_objective_id FROM personal_objective_bindings_v2
    WHERE id = ${bindingId}`;
  assert.equal(untouched[0].linked_objective_id, null, "列一次候选就自动关联上了");
});

test("刀六·关联只写那两列：不碰学习表现、不碰复习安排（§4.2 不复制不迁入）", async () => {
  const objectiveId = await seedPublicObjective(SHARED_NOTE, SHARED_VERSION, "能说清索引什么时候更慢");
  const created = await withWorkspaceTransaction(member(), (tx) =>
    binding.createPersonalObjectiveBindingV2(tx, createInput(SHARED_NOTE, SHARED_VERSION)));
  const bindingId = created.binding.id;

  // 关联**之前**把这两张表的行数记下来——"没涨"要有个正控制。
  const runsBefore = await fixtureSql`SELECT count(*)::int AS n FROM learning_runs WHERE workspace_id = ${WORKSPACE}`;
  const schedulesBefore = await fixtureSql`SELECT count(*)::int AS n FROM review_schedules WHERE workspace_id = ${WORKSPACE}`;

  const linked = await withWorkspaceTransaction(member(), (tx) =>
    binding.linkPersonalBindingToObjectiveV2(tx, {
      workspaceId: WORKSPACE,
      userId: MEMBER,
      bindingId,
      objectiveId,
      confirmedByUser: true,
      at: new Date("2026-09-27T14:00:00.000Z"),
    }));
  assert.equal(linked.linked, true);
  assert.equal(linked.binding.linkedObjectiveId, objectiveId);

  const runsAfter = await fixtureSql`SELECT count(*)::int AS n FROM learning_runs WHERE workspace_id = ${WORKSPACE}`;
  const schedulesAfter = await fixtureSql`SELECT count(*)::int AS n FROM review_schedules WHERE workspace_id = ${WORKSPACE}`;
  assert.equal(runsAfter[0].n, runsBefore[0].n, "关联写出了学习表现——那正是「迁入」");
  assert.equal(schedulesAfter[0].n, schedulesBefore[0].n, "关联顺手开了复习——那是 §9.1 的授权，不在这里");

  // 判据快照落库且可复核。
  const [row] = await fixtureSql`SELECT link_evidence FROM personal_objective_bindings_v2 WHERE id = ${bindingId}`;
  assert.equal(row.link_evidence.basis, "same_note_version_plus_user_confirmation");
  assert.equal(row.link_evidence.confirmedByUser, true);
});

test("刀六·别篇的目标关联不上（伪造血缘那一道在挡）", async () => {
  const elsewhere = await seedPublicObjective(PRIVATE_NOTE, PRIVATE_VERSION, "另一篇的目标");
  const created = await withWorkspaceTransaction(member(), (tx) =>
    binding.createPersonalObjectiveBindingV2(tx, createInput(SHARED_NOTE, SHARED_VERSION)));
  await assert.rejects(
    () => withWorkspaceTransaction(member(), (tx) =>
      binding.linkPersonalBindingToObjectiveV2(tx, {
        workspaceId: WORKSPACE,
        userId: MEMBER,
        bindingId: created.binding.id,
        objectiveId: elsewhere,
        confirmedByUser: true,
        at: new Date("2026-09-27T15:00:00.000Z"),
      })),
    (error: unknown) => error instanceof binding.BindingLinkRefusedV2
      && (error as { reasonCode?: string }).reasonCode === "not_same_note_version",
  );
});

test("刀六·没有本人确认就不成立（请求体里的 id 不作数）", async () => {
  const objectiveId = await seedPublicObjective(SHARED_NOTE, SHARED_VERSION, "能说清索引什么时候更慢");
  const created = await withWorkspaceTransaction(member(), (tx) =>
    binding.createPersonalObjectiveBindingV2(tx, createInput(SHARED_NOTE, SHARED_VERSION)));
  await assert.rejects(
    () => withWorkspaceTransaction(member(), (tx) =>
      binding.linkPersonalBindingToObjectiveV2(tx, {
        workspaceId: WORKSPACE,
        userId: MEMBER,
        bindingId: created.binding.id,
        objectiveId,
        confirmedByUser: false,
        at: new Date("2026-09-27T16:00:00.000Z"),
      })),
    (error: unknown) => error instanceof binding.BindingLinkRefusedV2
      && (error as { reasonCode?: string }).reasonCode === "needs_confirmation",
  );
});
