/**
 * 订阅来源分别开停（39d W7-3 刀五；39 §9.1 第一段与规则表行 1）。
 *
 * 这一档钉的是**规则表行 1 那一句**，以及它的负对照：
 * 「暂停/移除笔记订阅或卡片订阅 ⇒ **仅停用该授权来源**；其他来源仍有效时**显示原因**」。
 *
 * 三条断言，按它们被违反的代价排：
 *  1. 停掉一个来源**不碰另一个**。这是"偷偷联动"在本仓库里的形状——把 `card_review`
 *     跟着摘掉，屏上显示成"已停止安排"，而她那张卡明明还开着。
 *  2. `stillCoveredBy` 交回的是**停之后**剩下的，不是停之前的。少了这一步，停笔记
 *     订阅那一刻屏上会说"仍由卡片复习继续安排"，而真到点时没有——比"显示成已停"
 *     更坏：它让用户以为**还有**。
 *  3. 暂停**留行**、恢复**改 status**，不插第二条。所以"她什么时候授权的、范围是什么"
 *     不会因为停过一轮就丢；连点两下也长不出两份。
 *
 * 环境口径与调度边界那份一致：**夹具走 `DATABASE_URL_MIGRATOR`（超户），被测路径
 * 经 `withWorkspaceTransaction` 跑在 `DATABASE_URL_API`（受限角色）上**。全指超户时
 * RLS 那一族会**集体假通过**——RLS 根本没生效，那比红更坏
 * （39d-parallel-claims §5 第 1 条）。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import Fastify from "fastify";
import { reviewSubscriptionResultV2Schema } from "@ailearn/shared";
import { reviewRoutes } from "../modules/review/routes.ts";
import { issueSession, revokeSession } from "../modules/identity/session-service.ts";

const fixtureUrl = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!fixtureUrl || !process.env.DATABASE_URL_API) {
  throw new Error("订阅来源集测需要 DATABASE_URL_MIGRATOR（夹具）＋DATABASE_URL_API（受限角色）");
}
const fixtureSql = postgres(fixtureUrl, { max: 1 });

const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const { activateReviewSubscriptionV2, listNoteSubscriptionsV2, liveSourcesForObjectivesV2, pauseReviewSubscriptionV2, ReviewSubscriptionNoteNotFoundV2 } =
  await import("../modules/review/review-subscriptions.ts");
const { reviewSubscriptionsV2 } = await import("@ailearn/shared/db-schema/evidence");
const { eq } = await import("drizzle-orm");

const USER_ID = randomUUID();
const WORKSPACE_ID = randomUUID();
const NOTE_ID = randomUUID();
const NOTE_VERSION_ID = randomUUID();
const OBJECTIVE_ID = randomUUID();
const ctx = { workspaceId: WORKSPACE_ID, userId: USER_ID };

before(async () => {
  await fixtureSql`INSERT INTO users (id, email, password_hash)
    VALUES (${USER_ID}, ${`rs-v2-${USER_ID}@example.invalid`}, 'unused')`;
  await fixtureSql`INSERT INTO workspaces (id, owner_id, name, workspace_type)
    VALUES (${WORKSPACE_ID}, ${USER_ID}, '书房', 'personal')`;
  await fixtureSql`INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner')`;
  // `share_scope='shared'`：§9.1 的订阅是**空间里**的持续授权；私有笔记上那条读侧
  // 本来就只在本人可见范围内，写 private 会让这一格测成可见性而不是来源。
  // 先建笔记再建版本、最后回填 `current_version_id`：那条外键
  // （`notes_current_version_workspace_fk`）要求版本行已经存在，所以第一版把
  // 两个 id 一次插进去当场被拒。
  await fixtureSql`INSERT INTO notes (id, workspace_id, created_by, title, share_scope)
    VALUES (${NOTE_ID}, ${WORKSPACE_ID}, ${USER_ID}, '订阅来源那一篇', 'shared')`;
  // `content_json` 是 jsonb、`created_by` 与 `workspace_id` 都必填——照线上列写，
  // 手写一个"看起来对"的版本行只会被这些列名一条条教回来。
  await fixtureSql`INSERT INTO note_versions
      (id, note_id, workspace_id, version_no, content_json, created_by, content_hash)
    VALUES (${NOTE_VERSION_ID}, ${NOTE_ID}, ${WORKSPACE_ID}, 1, ${JSON.stringify({ blocks: [{ ordinal: 1, text: '正文' }] })}::jsonb, ${USER_ID}, ${"0".repeat(32)})`;
  await fixtureSql`UPDATE notes SET current_version_id = ${NOTE_VERSION_ID} WHERE id = ${NOTE_ID}`;
  // 血缘行：§9.1 行 1 那句「暂停笔记复习时说明**已单独开启的卡片**是否继续」要靠它
  // 判"这张卡是不是这篇的"。没有这一行，屏上会在卡明明开着时显示成已停止——
  // 这条红是第一版真的量出来的（集成档红在 `[] !== ['card_review']`）。
  // `note_version_id` 也要给：那张表有 `loo_v2_kind_fields_chk`，note 档要求
  // note_id 与 note_version_id 同时非空。第一版只给了 note_id，当场被那条约束挡下。
  await fixtureSql`INSERT INTO learning_objective_origins_v2
      (workspace_id, origin_id, objective_id, objective_revision_id, origin_kind, note_id, note_version_id)
    VALUES (${WORKSPACE_ID}, ${randomUUID()}, ${OBJECTIVE_ID}, ${randomUUID()}, 'note', ${NOTE_ID}, ${NOTE_VERSION_ID})`;
});

after(async () => {
  await closeDatabase();
  await fixtureSql.end();
});

test("W7-3 刀五：停一个来源不碰另一个，且 stillCoveredBy 交回的是停之后剩下的", async () => {
  await withWorkspaceTransaction(ctx, async (tx) => {
    const opened = await activateReviewSubscriptionV2(tx, {
      ...ctx, source: "note_subscription", subjectId: NOTE_ID,
      scopeNote: "持续回访这篇里学过的东西。",
    });
    assert.equal(opened.changed, true);
    assert.equal(opened.subscription.status, "active");
    assert.deepEqual([...opened.stillCoveredBy], ["note_subscription"]);

    const cardOpened = await activateReviewSubscriptionV2(tx, {
      ...ctx, source: "card_review", subjectId: OBJECTIVE_ID,
    });
    assert.equal(cardOpened.changed, true);

    // 停笔记订阅：卡片那一档**必须还在**，且 stillCoveredBy 交回 card_review。
    const paused = await pauseReviewSubscriptionV2(tx, {
      ...ctx, source: "note_subscription", subjectId: NOTE_ID,
    });
    assert.equal(paused.changed, true);
    assert.equal(paused.subscription.status, "paused");
    assert.ok(paused.subscription.pausedAt, "暂停要盖时间戳：屏上要能说「你什么时候停的」");
    // 这就是「其他来源仍有效时显示原因」那一格（§9.1 规则表行 1）。
    assert.deepEqual([...paused.stillCoveredBy], ["card_review"]);

    const cardRow = await tx.select().from(reviewSubscriptionsV2)
      .where(eq(reviewSubscriptionsV2.source, "card_review")).limit(1);
    assert.equal(cardRow[0]?.status, "active", "暂停笔记订阅不许把卡片订阅一起摘掉——那是 §9.1 的「偷偷联动」");

    // 目标那一格**只报卡片订阅**：笔记订阅覆盖"实际学过或已确认需要维护"的那些目标，
    // 不是"这篇底下的全部"（§9.1），所以它不按 noteId 兜底。
    const sources = await liveSourcesForObjectivesV2(tx, { ...ctx, objectiveIds: [OBJECTIVE_ID] });
    assert.deepEqual(sources.get(OBJECTIVE_ID), ["card_review"]);

    // 笔记那一屏连**暂停的**也列出来：开关要能拨回"开"，只列活着的就等于"停过的那篇
    // 从此找不到"。
    const notesList = await listNoteSubscriptionsV2(tx, ctx);
    assert.equal(notesList.length, 1);
    assert.equal(notesList[0]?.status, "paused");
  });
});

test("W7-3 刀五：连点两下不长出两份；恢复改 status 所以授权时间与范围留着", async () => {
  // 另起一颗目标：第一组已经把 OBJECTIVE_ID 开成 active 了，共用同一颗会让
  // `first.changed` 读到 false——那是**夹具串味**，不是被测逻辑在骗人。
  const ownObjectiveId = randomUUID();
  await withWorkspaceTransaction(ctx, async (tx) => {
    const first = await activateReviewSubscriptionV2(tx, {
      ...ctx, source: "card_review", subjectId: ownObjectiveId, scopeNote: "维护这张卡的提取目标。",
    });
    assert.equal(first.changed, true);
    const again = await activateReviewSubscriptionV2(tx, {
      ...ctx, source: "card_review", subjectId: ownObjectiveId, scopeNote: "维护这张卡的提取目标。",
    });
    assert.equal(again.changed, false, "已经是活着的了：连点两下不该长出两份，也不该说「刚刚开好了」");

    const cardId = randomUUID();
    await activateReviewSubscriptionV2(tx, { ...ctx, source: "card_review", subjectId: cardId });
    await pauseReviewSubscriptionV2(tx, { ...ctx, source: "card_review", subjectId: cardId });
    const pausedTwice = await pauseReviewSubscriptionV2(tx, { ...ctx, source: "card_review", subjectId: cardId });
    assert.equal(pausedTwice.changed, false, "本来就停着的：说「本来就在」，不是「刚刚停好了」");
    // 两个来源都没有 ⇒ 这一份不再被安排。屏上这时才可以说"已停止安排"。
    assert.deepEqual([...pausedTwice.stillCoveredBy], []);

    // 先停一次再恢复：恢复那一格量的是"从 paused 改回 active"，对着一份还活着的
    // 订阅调它交回的是 `changed:false`（那一档在上一段已经量过了）。
    await pauseReviewSubscriptionV2(tx, { ...ctx, source: "card_review", subjectId: ownObjectiveId });
    const resumed = await activateReviewSubscriptionV2(tx, { ...ctx, source: "card_review", subjectId: ownObjectiveId });
    assert.equal(resumed.changed, true);
    // 恢复**改 status**而不是插第二条：授权时间与那句范围说明都留着。
    assert.equal(resumed.subscription.createdAt, first.subscription.createdAt);
    assert.equal(resumed.subscription.scopeNote, "维护这张卡的提取目标。");
    const rows = await tx.select().from(reviewSubscriptionsV2)
      .where(eq(reviewSubscriptionsV2.subjectId, ownObjectiveId));
    assert.equal(rows.length, 1, "恢复不许插第二行（不只靠那把部分唯一索引）");
  });
});

test("W7-3 刀五：读不到的那一篇翻 404 那一档，不翻 500", async () => {
  await withWorkspaceTransaction(ctx, async (tx) => {
    await assert.rejects(
      () => activateReviewSubscriptionV2(tx, {
        ...ctx, source: "note_subscription", subjectId: randomUUID(),
      }),
      (error: unknown) => error instanceof ReviewSubscriptionNoteNotFoundV2,
      "订阅只能立在本人的书房里；读不到那一档要能被路由翻成 404",
    );
  });
});

test("真实订阅路由回执符合桌面合同，开启和暂停都能读到保存后的状态", async () => {
  const app = Fastify({ logger: false });
  const { token } = await issueSession(USER_ID, WORKSPACE_ID);
  try {
    await app.register(reviewRoutes);
    await app.ready();
    for (const [action, status] of [["activate", "active"], ["pause", "paused"]] as const) {
      const response = await app.inject({
        method: "POST", url: `/v2/reviews/subscriptions/${action}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { source: "note_subscription", subjectId: NOTE_ID },
      });
      assert.equal(response.statusCode, 200, response.body);
      const result = reviewSubscriptionResultV2Schema.parse(response.json());
      assert.equal(result.subscription.subjectId, NOTE_ID);
      assert.equal(result.subscription.status, status);
      const read = await app.inject({ method: "GET", url: "/v2/reviews/subscriptions/notes",
        headers: { authorization: `Bearer ${token}` } });
      assert.equal(read.json().items.find((row: { subjectId: string }) => row.subjectId === NOTE_ID)?.status, status);
    }
  } finally {
    await revokeSession(token);
    await app.close();
  }
});
