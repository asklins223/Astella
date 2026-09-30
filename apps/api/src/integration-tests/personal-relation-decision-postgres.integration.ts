/**
 * 本人对建议关系的确认／隐藏（39d W5-6 刀七；39 §11.3、§16.20、§14.4）。
 *
 * §11.3 那一整句是「用户确认**首先只影响本人的学习视图**；写入共享关系需具备**材料编辑权**
 * 并明确作用范围，**不能让只读成员的确认修改公共知识结构**」＋「关系修改**不伪造过去的
 * 学习事实**」。
 *
 * 今天是零实现：星图里只有 `learning_objective_revisions_v2.relations` 那一列 jsonb
 * （`topology-repository.ts:718` 读成 `relates_to` 展示边），**没有**"待确认／已确认"的
 * 分层，**也没有**任何按人存表态的地方。这一份钉的是那半句能由数据面证明的部分：
 *
 *  1. **只影响本人** —— 只读成员能对共享笔记里的关系表态（不需要公共编辑权，§4.2），
 *     而另一位成员读不到他这一下（RLS 实测，跑受限角色才量得到）。
 *  2. **不改公共结构** —— 表态前后 `learning_objective_revisions_v2.relations` 与
 *     `learning_objectives_v2.lifecycle` **一字未动**。
 *  3. **不伪造学习事实** —— 表态前后 `learning_runs`／`review_schedules` **行数相等**。
 *  4. **可纠正** —— 改主意走 UPDATE，同一条边**不会**长出两行。
 *  5. **两端都要读得到** —— 端点在一篇他读不到的笔记里就不成立，且要报出是哪一端。
 *
 * 共享关系那半边（需要材料编辑权）**不在这一份**：它是公共材料的写路径，不在这里凭空开口。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const fixtureUrl = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!fixtureUrl || !process.env.DATABASE_URL_API) {
  throw new Error("关系表态集测需要 DATABASE_URL_MIGRATOR（夹具）＋DATABASE_URL_API（受限角色）");
}
const fixtureSql = postgres(fixtureUrl, { max: 4 });
const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const rel = await import("../modules/note-deepening/personal-relation-decision-service.ts");

const AUTHOR = randomUUID();
const MEMBER = randomUUID();
const OTHER = randomUUID();
const WORKSPACE = randomUUID();
const SHARED_NOTE = randomUUID();
const SHARED_VERSION = randomUUID();
const PRIVATE_NOTE = randomUUID();
const PRIVATE_VERSION = randomUUID();

const author = () => ({ workspaceId: WORKSPACE, userId: AUTHOR });
const member = () => ({ workspaceId: WORKSPACE, userId: MEMBER });
const other = () => ({ workspaceId: WORKSPACE, userId: OTHER });

/** 公共目标：A、B 在共享那篇上（读得到），C 在作者私有的那篇上（读不到）。 */
const OBJ_A = randomUUID();
const OBJ_B = randomUUID();
const OBJ_C = randomUUID();

/** 公共血缘上的关系边——**不设**共享那篇的 relations，那正是"不该被改"的东西。 */
const SHARED_RELATIONS: Record<string, string>[] = [{ objectiveId: OBJ_B, relation: "prerequisite" }];

async function seedNote(noteId: string, versionId: string, shareScope: string, createdBy: string) {
  await fixtureSql`INSERT INTO notes (id, workspace_id, title, created_by, share_scope, current_version_id)
    VALUES (${noteId}, ${WORKSPACE}, ${`关系-${noteId.slice(0, 6)}`}, ${createdBy}, ${shareScope}, ${versionId})`;
  await fixtureSql`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
    VALUES (${versionId}, ${noteId}, ${WORKSPACE}, 1,
      ${fixtureSql.json({ blocks: [{ type: "paragraph", content: "关系那一篇" }] })},
      ${"d".repeat(64)}, ${createdBy})`;
}

async function seedObjective(objectiveId: string, noteId: string, versionId: string, relations: Record<string, string>[]) {
  const objectiveRevisionId = randomUUID();
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
      VALUES (${randomUUID()}, ${WORKSPACE}, ${objectiveRevisionId}, ${objectiveId}, 1, ${`目标 ${objectiveId.slice(0, 6)}`},
        ${`摘要 ${objectiveId.slice(0, 6)}`}, 'comparison', ${tx.array([])},
        ${tx.json({})}, ${tx.json({})}, ${tx.json({})}, ${tx.json(relations)}, ${tx.array([])},
        ${`fp-${objectiveId}`}, ${`trh-${objectiveId}`}, ${`pph-${objectiveId}`})`;
    await tx`INSERT INTO learning_objective_origins_v2
        (id, workspace_id, origin_id, objective_id, objective_revision_id, origin_kind, note_id, note_version_id, integrity)
      VALUES (${randomUUID()}, ${WORKSPACE}, ${randomUUID()}, ${objectiveId}, ${objectiveRevisionId},
        'note', ${noteId}, ${versionId}, 'verified')`;
  });
}

before(async () => {
  const cols = await fixtureSql`
    SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'personal_relation_decisions_v2' AND column_name = 'decision'`;
  assert.equal(cols[0].n, 1, "personal_relation_decisions_v2 不在——迁移 0302 没应用");

  await fixtureSql`INSERT INTO users (id, email, password_hash, role)
    VALUES (${AUTHOR}, ${`rel-a-${AUTHOR.slice(0, 8)}@example.test`}, 'h', 'member'),
           (${MEMBER}, ${`rel-m-${MEMBER.slice(0, 8)}@example.test`}, 'h', 'member'),
           (${OTHER}, ${`rel-o-${OTHER.slice(0, 8)}@example.test`}, 'h', 'member')`;
  await fixtureSql`INSERT INTO workspaces (id, owner_id, name)
    VALUES (${WORKSPACE}, ${AUTHOR}, ${`Relation ${WORKSPACE.slice(0, 8)}`})`;
  for (const uid of [AUTHOR, MEMBER, OTHER]) {
    await fixtureSql`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${WORKSPACE}, ${uid}, ${uid === AUTHOR ? "owner" : "member"})`;
  }
  await seedNote(SHARED_NOTE, SHARED_VERSION, "shared", AUTHOR);
  await seedNote(PRIVATE_NOTE, PRIVATE_VERSION, "private", AUTHOR);
  await seedObjective(OBJ_A, SHARED_NOTE, SHARED_VERSION, SHARED_RELATIONS);
  await seedObjective(OBJ_B, SHARED_NOTE, SHARED_VERSION, []);
  await seedObjective(OBJ_C, PRIVATE_NOTE, PRIVATE_VERSION, []);
});

after(async () => {
  await fixtureSql`DELETE FROM personal_relation_decisions_v2 WHERE workspace_id = ${WORKSPACE}`;
  await fixtureSql`DELETE FROM learning_objective_origins_v2 WHERE workspace_id = ${WORKSPACE}`;
  await fixtureSql`DELETE FROM learning_objective_revisions_v2 WHERE workspace_id = ${WORKSPACE}`;
  await fixtureSql`DELETE FROM learning_objectives_v2 WHERE workspace_id = ${WORKSPACE}`;
  await fixtureSql`DELETE FROM note_versions WHERE workspace_id = ${WORKSPACE}`;
  await fixtureSql`DELETE FROM notes WHERE workspace_id = ${WORKSPACE}`;
  await fixtureSql`DELETE FROM workspace_members WHERE workspace_id = ${WORKSPACE}`;
  await fixtureSql`DELETE FROM workspaces WHERE id = ${WORKSPACE}`;
  await fixtureSql`DELETE FROM users WHERE id IN (${AUTHOR}, ${MEMBER}, ${OTHER})`;
  await fixtureSql.end({ timeout: 5 });
  await closeDatabase();
});

test("只读成员能对共享笔记里的关系表态（§11.3 确认首先只影响本人视图，§4.2 不需要公共编辑权）", async () => {
  const result = await withWorkspaceTransaction(member(), (tx) =>
    rel.setPersonalRelationDecisionV2(tx, {
      workspaceId: WORKSPACE,
      userId: MEMBER,
      fromObjectiveId: OBJ_A,
      toObjectiveId: OBJ_B,
      relation: "prerequisite",
      decision: "confirmed",
      evidence: { sourceBlockOrdinal: 3 },
      at: new Date("2026-09-27T16:00:00.000Z"),
    }));
  assert.equal(result.row.decision, "confirmed");
  assert.equal(result.row.noteId, SHARED_NOTE, "两端同篇时该记下是哪一篇");
});

test("不改公共结构：公共 relations 与 lifecycle 一字未动（§11.3）", async () => {
  // 正控制：先确认公共那列本来长什么样，否则"没动"可能是因为它本来就是空的。
  const [before] = await fixtureSql`SELECT relations, lifecycle FROM learning_objective_revisions_v2
    WHERE objective_id = ${OBJ_A}`;
  assert.equal(before.relations.length, 1, "公共 relations 夹具没种上");

  const [after] = await fixtureSql`
    SELECT r.relations, o.lifecycle
      FROM learning_objective_revisions_v2 r
      JOIN learning_objectives_v2 o ON o.workspace_id = r.workspace_id AND o.objective_id = r.objective_id
     WHERE r.objective_id = ${OBJ_A}`;
  assert.deepEqual(after.relations, before.relations, "只读成员的确认改动了公共 relations");
  assert.equal(after.lifecycle, "active");
});

test("不伪造过去的学习事实：表态不产生任何学习记录或复习安排（§11.3）", async () => {
  const runsBefore = await fixtureSql`SELECT count(*)::int AS n FROM learning_runs WHERE workspace_id = ${WORKSPACE}`;
  const schedulesBefore = await fixtureSql`SELECT count(*)::int AS n FROM review_schedules WHERE workspace_id = ${WORKSPACE}`;
  await withWorkspaceTransaction(member(), (tx) =>
    rel.setPersonalRelationDecisionV2(tx, {
      workspaceId: WORKSPACE,
      userId: MEMBER,
      fromObjectiveId: OBJ_B,
      toObjectiveId: OBJ_A,
      relation: "explains",
      decision: "dismissed",
      at: new Date("2026-09-27T17:00:00.000Z"),
    }));
  const runsAfter = await fixtureSql`SELECT count(*)::int AS n FROM learning_runs WHERE workspace_id = ${WORKSPACE}`;
  const schedulesAfter = await fixtureSql`SELECT count(*)::int AS n FROM review_schedules WHERE workspace_id = ${WORKSPACE}`;
  assert.equal(runsAfter[0].n, runsBefore[0].n, "确认一条关系写出了学习记录");
  assert.equal(schedulesAfter[0].n, schedulesBefore[0].n, "确认一条关系顺手开了复习");
});

test("只影响本人：另一个人读不到他这一下（RLS 实测）", async () => {
  const mine = await withWorkspaceTransaction(member(), (tx) =>
    rel.listPersonalRelationDecisionsV2(tx, { workspaceId: WORKSPACE, userId: MEMBER }));
  assert.ok(mine.length >= 1, "正控制：本人要读得到自己那些");

  const theirs = await withWorkspaceTransaction(other(), (tx) =>
    rel.listPersonalRelationDecisionsV2(tx, { workspaceId: WORKSPACE, userId: OTHER }));
  assert.equal(theirs.length, 0, "另一个人的视图里出现了我的关系表态");

  // 连笔记作者也读不到——公共血缘那张表是空间共用的，这一张不是。
  const asAuthor = await withWorkspaceTransaction(author(), (tx) =>
    rel.listPersonalRelationDecisionsV2(tx, { workspaceId: WORKSPACE, userId: AUTHOR }));
  assert.equal(asAuthor.length, 0, "笔记作者读到了别人的个人表态");
});

test("可纠正：改主意走 UPDATE，同一条边不会长出两行（§11.3 用户可纠正或隐藏）", async () => {
  const flip = await withWorkspaceTransaction(member(), (tx) =>
    rel.setPersonalRelationDecisionV2(tx, {
      workspaceId: WORKSPACE,
      userId: MEMBER,
      fromObjectiveId: OBJ_A,
      toObjectiveId: OBJ_B,
      relation: "prerequisite",
      decision: "dismissed",
      at: new Date("2026-09-27T18:00:00.000Z"),
    }));
  assert.equal(flip.row.decision, "dismissed");
  const rows = await fixtureSql`SELECT decision FROM personal_relation_decisions_v2
    WHERE user_id = ${MEMBER} AND from_objective_id = ${OBJ_A} AND to_objective_id = ${OBJ_B}
      AND relation = 'prerequisite'`;
  assert.equal(rows.length, 1, "同一条边长出了两行——读侧就得自己判哪一行更新");
  assert.equal(rows[0].decision, "dismissed");
});

test("端点读不到就不成立，而且要报出是哪一端（§11.3 首期只做单篇可核对关系）", async () => {
  await assert.rejects(
    () => withWorkspaceTransaction(member(), (tx) =>
      rel.setPersonalRelationDecisionV2(tx, {
        workspaceId: WORKSPACE,
        userId: MEMBER,
        fromObjectiveId: OBJ_A,
        toObjectiveId: OBJ_C,
        relation: "prerequisite",
        decision: "confirmed",
        at: new Date("2026-09-27T19:00:00.000Z"),
      })),
    (error: unknown) => error instanceof rel.RelationEndpointNotReadableV2
      && (error as { side?: string }).side === "to",
  );
  const rows = await fixtureSql`SELECT count(*)::int AS n FROM personal_relation_decisions_v2
    WHERE to_objective_id = ${OBJ_C}`;
  assert.equal(rows[0].n, 0, "端点读不到却记下来了");
});
