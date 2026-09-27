/**
 * 「继续这一轮」这条路的真实 HTTP 契约（39d W4-5 ④ 的前置）。
 *
 * 为什么这一份必须存在（而 service 层那份集测已经调过 `advanceRound` 一次）：
 * 桌面侧新接的那一发走的是**线上那个 PATCH**，它承诺的四件事里没有任何一件
 * 由 reducer 的单测或直调 service 证得了——
 *  1. **恢复之后屏上那一份要与服务端读回的同一版**：桌面那一发在推进之后接着读
 *     `GET /:roundId/teaching`，所以那里回来的 `round` 必须已经是 active 那一版
 *     （读回来还是 paused，界面就会摆出一颗点不动的「继续这一轮」）；
 *  2. **带旧的那一版来恢复要失败并拿到现在那一版**（§16.39：两个窗口同时开着，
 *     后到的那一发不许覆盖先到的那次状态变化）；
 *  3. **`closed` 之后恢复走不通**（D1 §3.3 终态只读；昨天收尾的那一轮可以做下一轮起点，
 *     但不重开原轮）；
 *  4. **重复恢复是什么都不改的 noop**：`revision` 是状态与计划修订**共用**的那一个计数器
 *     （D1 §6.3），重复请求都 +1 的话"改了点什么"与"什么都没变"就分不出来了。
 *     这条语义在 reducer 里有单测、在直调 service 的集测里钉过 pause 那一半，
 *     线上那一发**从没被钉过**——而界面按下去发出去的就是线上这一发。
 *
 * 角色分工照 doc 34 §1.2：夹具走 `DATABASE_URL_MIGRATOR`（超户），`issueSession` 发真令牌，
 * 请求经 `app.inject` 打到跑在 `DATABASE_URL_API`（受限角色）上的路由。
 * 每条"应当被拒"都带着"同一条此刻在库里到底是什么形状"的读数：409 之后那一行**没被动过**
 * 才是结论，只看回信状态码的话，"拒了但顺手改了一半"这种形状读不出来。
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  noteLearningRoundV1Schema,
  roundTeachingViewV1Schema,
} from "@ailearn/shared/note-learning-round-contracts";
import { seedNotesOnlyWorkspace, type NotesOnlyWorkspaceFixture } from "./helpers/pure-v2-workspace-fixture.ts";

const fixtureUrl = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!fixtureUrl || !process.env.DATABASE_URL_API) {
  throw new Error("恢复那一发需要 DATABASE_URL_MIGRATOR（夹具）＋DATABASE_URL_API（受限角色，路由跑在它上面）");
}
const fixtureSql = postgres(fixtureUrl, { max: 4 });

const { default: Fastify } = await import("fastify");
const { default: sensible } = await import("@fastify/sensible");
const { authRoutes } = await import("../modules/identity/routes.ts");
const { deterministicTeachingExplainProviderV1 } = await import("../modules/note-learning-rounds/teaching-explain.ts");
const { noteLearningRoundRoutes } = await import("../modules/note-learning-rounds/routes.ts");
const { issueSession } = await import("../modules/identity/service.ts");

let seeded: NotesOnlyWorkspaceFixture | null = null;
let workspaceId = "";
let userId = "";
let noteA = "";
let token = "";
let peerUserId = "";
let peerToken = "";
let app: Awaited<ReturnType<typeof Fastify>>;

const body = (res: { body: string }): Record<string, unknown> => JSON.parse(res.body) as Record<string, unknown>;

async function call(
  method: "POST" | "GET" | "PATCH",
  url: string,
  payload?: Record<string, unknown>,
  bearer = token,
) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${bearer}` },
    ...(payload ? { payload } : {}),
  });
}

/** 那一行此刻的形状（直查库，不信任何一份回执）。受限角色读不到，所以走夹具那条连接。 */
async function rowInDb(roundId: string): Promise<{ phase: string; revision: number; pausedAt: string | null; resumedAt: string | null; updatedAt: string }> {
  const rows = await fixtureSql`
    SELECT phase, revision, paused_at, resumed_at, updated_at
      FROM note_learning_rounds WHERE id = ${roundId}::uuid
  `;
  const row = (rows as unknown as Array<Record<string, unknown>>)[0];
  assert.ok(row, `库里应当有这一轮（id ${roundId}）`);
  return {
    phase: String(row.phase),
    revision: Number(row.revision),
    pausedAt: row.paused_at ? new Date(row.paused_at as string).toISOString() : null,
    resumedAt: row.resumed_at ? new Date(row.resumed_at as string).toISOString() : null,
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

async function createRound(question: string): Promise<Record<string, unknown>> {
  const res = await call("POST", "/v2/note-learning-rounds", {
    noteId: noteA, drivingQuestion: question, drivingQuestionSource: "suggested",
  });
  assert.equal(res.statusCode, 201, `开一轮应当成功：${res.statusCode} ${res.body}`);
  return noteLearningRoundV1Schema.parse(body(res).round as never) as unknown as Record<string, unknown>;
}

/** 把这一轮停住（恢复那一发的起点）。今天界面上没有这颗按钮，所以这一步只能由 HTTP 造。 */
async function pause(roundId: string, revision: number): Promise<Record<string, unknown>> {
  const res = await call("PATCH", `/v2/note-learning-rounds/${roundId}`, {
    expectedRevision: revision, action: { kind: "pause" },
  });
  assert.equal(res.statusCode, 200, `暂停应当成功（它就是这一份集测的起点）：${res.statusCode} ${res.body}`);
  return noteLearningRoundV1Schema.parse(body(res).round as never) as unknown as Record<string, unknown>;
}

async function resume(roundId: string, expectedRevision: number, bearer = token) {
  return call("PATCH", `/v2/note-learning-rounds/${roundId}`, {
    expectedRevision, action: { kind: "resume" },
  }, bearer);
}

before(async () => {
  seeded = await seedNotesOnlyWorkspace(fixtureSql, { noteCount: 1 });
  workspaceId = seeded.workspaceId;
  userId = seeded.userId;
  [noteA] = seeded.noteIds;
  peerUserId = randomUUID();
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role)
      VALUES (${peerUserId}, ${`peer-${peerUserId.slice(0, 8)}@example.test`}, 'h', 'member')`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${peerUserId}, 'member')`;
  });
  app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(authRoutes);
  await app.register(noteLearningRoundRoutes, { teaching: {
    provider: deterministicTeachingExplainProviderV1(), modelId: "offline-test", external: false,
  } });
  await app.ready();
  token = (await issueSession(userId, seeded.workspaceId)).token;
  peerToken = (await issueSession(peerUserId, seeded.workspaceId)).token;
});

/**
 * 每条用例都要一个干净起点：未完成名额按 (人, 篇) 算（§3.2），上一条留在这一篇上的
 * 那一轮会让下一条的"开一轮"变成 409——那读起来像路由坏了，其实是上一发的残留。
 */
beforeEach(async () => {
  await fixtureSql`DELETE FROM note_learning_rounds WHERE workspace_id = ${seeded?.workspaceId ?? "00000000-0000-0000-0000-000000000000"}`;
});

after(async () => {
  if (seeded) {
    await fixtureSql`DELETE FROM note_learning_rounds WHERE workspace_id = ${seeded.workspaceId}`;
    await seeded.cleanup();
  }
  if (peerUserId !== "") {
    await fixtureSql`DELETE FROM workspace_members WHERE user_id = ${peerUserId}`;
    await fixtureSql`DELETE FROM users WHERE id = ${peerUserId}`;
  }
  await app?.close();
  await fixtureSql.end();
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase();
});

test("paused → resume：库里那一行回到 active、resumed_at 有值、共用计数器前进一步", async () => {
  const created = await createRound("停住之后怎么接着走");
  const roundId = created.roundId as string;
  const paused = await pause(roundId, created.revision as number);
  assert.equal(paused.phase, "paused");
  assert.ok(paused.pausedAt, "起点必须是真停住的那一条（暂停要写下时间）");

  const res = await resume(roundId, paused.revision as number);
  assert.equal(res.statusCode, 200, `恢复应当成功：${res.statusCode} ${res.body}`);
  const resumed = noteLearningRoundV1Schema.parse(body(res).round as never);
  assert.equal(resumed.phase, "active");
  assert.ok(resumed.resumedAt, "恢复要写下时间：没有它「停过又回来」与「一直开着」在库里同一个样子");
  assert.equal(resumed.revision, Number(paused.revision) + 1, "这是真的一次状态变化，共用计数器该前进一格");
  // 暂停过是历史：回来了不能把它抹掉（§10.3 那一格读的就是"停过没有"）。
  assert.equal(resumed.pausedAt, paused.pausedAt);

  const row = await rowInDb(roundId);
  assert.equal(row.phase, "active", "回执说了 active 而库里还是 paused ⇒ 这一发根本没落");
  assert.notEqual(row.resumedAt, null);
  assert.equal(row.revision, Number(paused.revision) + 1);
});

test("恢复之后读教学面：那一块回来的是 active 那一版（桌面那一发读的就是这一份）", async () => {
  const created = await createRound("恢复之后屏上那一份是谁的");
  const roundId = created.roundId as string;
  const paused = await pause(roundId, created.revision as number);
  const resumed = await resume(roundId, paused.revision as number);
  assert.equal(resumed.statusCode, 200, resumed.body);

  // 桌面侧 `resume` 那一发在推进之后接着读这一发（恢复之后屏上那一整块只由服务端读回）。
  // 它读到 paused 就是缺陷：界面会摆出一颗刚按下过、却还点得动的「继续这一轮」。
  const view = await call("GET", `/v2/note-learning-rounds/${roundId}/teaching`);
  assert.equal(view.statusCode, 200, view.body);
  const parsed = roundTeachingViewV1Schema.parse(JSON.parse(view.body));
  assert.equal(parsed.round.phase, "active");
  assert.equal(parsed.round.revision, Number(paused.revision) + 1, "读回的必须是推进之后那一版，不是停住那一版");
});

test("带旧的那一版来恢复：409，并把现在那一版一起带回", async () => {
  const created = await createRound("两个窗口同时点下去的那一发");
  const roundId = created.roundId as string;
  const paused = await pause(roundId, created.revision as number);
  // 另一个窗口先把它恢复了（服务端那一版又前进一格），本窗口手里还是停住那一版。
  const byOtherWindow = await resume(roundId, paused.revision as number);
  assert.equal(byOtherWindow.statusCode, 200, byOtherWindow.body);

  const stale = await resume(roundId, paused.revision as number);
  assert.equal(stale.statusCode, 409, `旧 revision 那一发必须失败：${stale.statusCode} ${stale.body}`);
  assert.equal(body(stale).error, "stale_revision");
  const current = noteLearningRoundV1Schema.parse(body(stale).round as never);
  assert.equal(current.revision, Number(paused.revision) + 1, "带回来的应当是现在那一版，不是客户端送来那版");
  assert.equal(current.phase, "active");
  // 被拒的那一发一个字都没改：现在那一版就是另一个窗口恢复出来的那一版。
  assert.deepEqual(await rowInDb(roundId), {
    phase: "active",
    revision: Number(paused.revision) + 1,
    pausedAt: paused.pausedAt,
    resumedAt: current.resumedAt,
    updatedAt: current.updatedAt,
  });
});

test("对已收尾的那一轮恢复：409 round_closed，那一行仍是终态", async () => {
  const created = await createRound("昨天收尾的那一轮");
  const roundId = created.roundId as string;
  const closed = await call("PATCH", `/v2/note-learning-rounds/${roundId}`, {
    expectedRevision: created.revision, action: { kind: "close", outcome: "partial" },
  });
  assert.equal(closed.statusCode, 200, closed.body);
  const beforeRow = await rowInDb(roundId);
  assert.equal(beforeRow.phase, "closed", "起点必须是终态");

  const late = await resume(roundId, Number(created.revision) + 1);
  assert.equal(late.statusCode, 409, `终态只读：${late.statusCode} ${late.body}`);
  assert.equal(body(late).error, "round_closed");
  assert.deepEqual(await rowInDb(roundId), beforeRow, "被拒的恢复不许把终态那一行碰一下");
  // 这一轮不再占用 §6.1 那个名额：另开一轮是这条路，重开原轮不是。
  const reopened = await createRound("按当前内容另开一轮");
  assert.notEqual(reopened.roundId, roundId);
});

test("重复恢复 = 什么都不改的 noop：不写库、不推进那个共用计数器", async () => {
  const created = await createRound("连点两次的那一发");
  const roundId = created.roundId as string;
  const paused = await pause(roundId, created.revision as number);
  const first = noteLearningRoundV1Schema.parse(body(await resume(roundId, paused.revision as number)).round as never);
  const firstRow = await rowInDb(roundId);

  // 第二次带的是**现在**那一版（不是旧 revision），所以它过得了 CAS——
  // 挡住它的必须是"状态本来就已经是 active"这条判据，而不是并发保护。
  const again = await resume(roundId, first.revision);
  assert.equal(again.statusCode, 200, `重复的恢复不是冲突：${again.statusCode} ${again.body}`);
  const second = noteLearningRoundV1Schema.parse(body(again).round as never);
  assert.equal(second.phase, "active");
  assert.equal(second.revision, first.revision, "noop 不许把状态与计划共用的那个计数器吹大");
  assert.equal(second.resumedAt, first.resumedAt, "也不许把恢复时间换成第二次的时间点");
  assert.deepEqual(await rowInDb(roundId), firstRow, "noop 那一发不该写库（连 updated_at 都不动）");
});

test("同空间另一个人恢复不了我这一轮：连存在性都不给，那一行照旧停着", async () => {
  const created = await createRound("只有开的人能继续的那一轮");
  const roundId = created.roundId as string;
  const paused = await pause(roundId, created.revision as number);
  assert.equal(paused.phase, "paused");

  const stolen = await resume(roundId, paused.revision as number, peerToken);
  assert.equal(stolen.statusCode, 404, `同空间另一人不应推得动：${stolen.statusCode} ${stolen.body}`);
  assert.equal(body(stolen).error, "round_not_found", "不是 stale_revision——他连有没有这一轮都不该知道");
  assert.equal((await rowInDb(roundId)).phase, "paused", "被拦下之后那一行必须还停在原处");

  // 正向对照：同一发由开的人来打就通（否则上面的 404 可以是任何原因的 404）。
  const mine = await resume(roundId, paused.revision as number);
  assert.equal(mine.statusCode, 200, mine.body);
  assert.equal((await rowInDb(roundId)).phase, "active");
});

test("恢复那一发在本机合同上就没有「暂停」那一格的形状：多带 outcome 一律 400", async () => {
  const created = await createRound("动作那一格不收多余的键");
  const roundId = created.roundId as string;
  const paused = await pause(roundId, created.revision as number);
  const withOutcome = await call("PATCH", `/v2/note-learning-rounds/${roundId}`, {
    expectedRevision: paused.revision, action: { kind: "resume", outcome: "completed" },
  });
  assert.equal(withOutcome.statusCode, 400, withOutcome.body);
  assert.equal(body(withOutcome).error, "invalid_request");
  assert.equal((await rowInDb(roundId)).phase, "paused", "被挡下的那一发不该动到那一行");
});
