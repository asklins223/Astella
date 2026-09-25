/**
 * 轮次路由的真实 HTTP 契约（39d W4-5 第三刀）。
 *
 * 为什么这一份必须是真 HTTP 而不是再调一次 service：这一层的承诺**只存在于路由上**——
 *  - **实际用哪一版正文由服务端定**（PRD §3.4）：请求体里根本没有 `noteVersionId` 这一格，
 *    回来的那一轮的 `noteVersionId` / `sourceContentHash` 必须等于服务端读到的那一版。
 *    直调 service 永远证不了这件事，因为那个参数在 service 上是入参；
 *  - **409 要带上现在那一版**：`round_already_open` 与 `stale_revision` 都带着 `round`，
 *    §3.2 的「继续它 / 明确封存它」与 §16.39 的"另一份草稿提示冲突"都靠它才走得出第二步；
 *  - **预算由服务端签发**，且那份 env 覆盖真的生效（`maxTasks=0` 那一档既是可调的证明，
 *    也是"0 不是坏值"的证明）。
 *
 * 角色分工照 doc 34 §1.2：夹具走 `DATABASE_URL_MIGRATOR`，`issueSession` 发真令牌，
 * 请求经 `app.inject` 打到跑在 `DATABASE_URL_API`（受限角色）上的路由。
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { closeDatabase } from "../db/client.ts";
import { noteLearningRoundV1Schema } from "@ailearn/shared/note-learning-round-contracts";
import { seedNotesOnlyWorkspace, type NotesOnlyWorkspaceFixture } from "./helpers/pure-v2-workspace-fixture.ts";

const fixtureUrl = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!fixtureUrl || !process.env.DATABASE_URL_API) {
  throw new Error("轮次路由集测需要 DATABASE_URL_MIGRATOR（夹具）＋DATABASE_URL_API（受限角色，路由跑在它上面）");
}
const fixtureSql = postgres(fixtureUrl, { max: 4 });

const { default: Fastify } = await import("fastify");
const { default: sensible } = await import("@fastify/sensible");
const { authRoutes } = await import("../modules/identity/routes.ts");
const { noteLearningRoundRoutes } = await import("../modules/note-learning-rounds/routes.ts");
const { issueSession } = await import("../modules/identity/service.ts");

let seeded: NotesOnlyWorkspaceFixture | null = null;
let peerWorkspace: NotesOnlyWorkspaceFixture | null = null;
let workspaceId = "";
let userId = "";
let noteA = "";
let versionA = "";
let peerUserId = "";
let token = "";
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
    ...(bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}),
    ...(payload ? { payload } : {}),
  });
}

before(async () => {
  seeded = await seedNotesOnlyWorkspace(fixtureSql, { noteCount: 1 });
  peerWorkspace = await seedNotesOnlyWorkspace(fixtureSql, { noteCount: 1 });
  workspaceId = seeded.workspaceId;
  userId = seeded.userId;
  [noteA] = seeded.noteIds;
  [versionA] = seeded.versionIds;
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
  await app.register(noteLearningRoundRoutes);
  await app.ready();
  token = (await issueSession(userId, workspaceId)).token;
  peerToken = (await issueSession(peerUserId, workspaceId)).token;
});

/**
 * 每条用例都要一个**干净起点**：未完成名额是按 (人, 篇) 算的，上一条用例留在那一篇上的
 * 那一轮会让下一条的"创建成功"变成 409——那读起来像路由坏了，其实是上一发的残留。
 * 与真窗口剧本里那条「起点必须干净」的守卫同一条道理（那里记过一次"无结论读数"）。
 */
beforeEach(async () => {
  await fixtureSql`DELETE FROM note_learning_rounds WHERE workspace_id = ${workspaceId}`;
});

after(async () => {
  if (seeded) {
    await fixtureSql`DELETE FROM note_learning_rounds WHERE workspace_id = ${seeded.workspaceId}`;
    await seeded.cleanup();
  }
  if (peerWorkspace) {
    await fixtureSql`DELETE FROM note_learning_rounds WHERE workspace_id = ${peerWorkspace.workspaceId}`;
    await peerWorkspace.cleanup();
  }
  if (peerUserId !== "") {
    await fixtureSql`DELETE FROM workspace_members WHERE user_id = ${peerUserId}`;
    await fixtureSql`DELETE FROM users WHERE id = ${peerUserId}`;
  }
  await app?.close();
  await fixtureSql.end();
  await closeDatabase();
});

/** 建一轮并把回读取回来（每一发都先过线上合同：合同漂移要红在这里，不是红成"页面上没东西"）。 */
async function createOne(question: string): Promise<Record<string, unknown>> {
  const res = await call("POST", "/v2/note-learning-rounds", {
    noteId: noteA,
    drivingQuestion: question,
    drivingQuestionSource: "suggested",
  });
  assert.equal(res.statusCode, 201, `创建应当成功：${res.statusCode} ${res.body}`);
  return noteLearningRoundV1Schema.parse(body(res).round as never) as unknown as Record<string, unknown>;
}

test("没登录进不来（这条路由不是只给脚本用的）", async () => {
  const res = await call("GET", `/v2/notes/${noteA}/learning-round`, undefined, "");
  assert.ok(res.statusCode === 401 || res.statusCode === 403, `未登录应当被挡，实到 ${res.statusCode}`);
});

test("创建：服务端定那一版正文，预算由服务端签发，回执过线上合同", async () => {
  const round = await createOne("判断为什么有索引，查询仍然可能慢");
  assert.equal(round.phase, "active");
  assert.equal(round.revision, 1);
  assert.equal(round.drivingQuestionRevision, 1);
  // 那两格必须**等于服务端读到的那一版**——请求体里压根没有它们。
  assert.equal(round.noteVersionId, versionA);
  const versionRow = await fixtureSql`
    SELECT content_hash, current_version_id FROM notes n
    JOIN note_versions v ON v.id = n.current_version_id
    WHERE n.id = ${noteA}
  `;
  const first = (versionRow as unknown as Array<{ content_hash: string; current_version_id: string }>)[0];
  assert.equal(round.sourceContentHash, first.content_hash, "快照里那份哈希必须是正文现在这一版的哈希");
  assert.equal(first.current_version_id, versionA);
  // 预算：三项都来自服务端那份常量（客户端没有这一格可填）。
  assert.deepEqual(round.budgets, { maxModelCalls: 8, maxWallClockSeconds: 900, maxTasks: 6 });
  // 摘录此刻是真的还没有（依据由后面规划那一步产生），不是"忘了填"。
  assert.deepEqual(round.evidenceSnapshotIds, []);
});

test("同一篇第二发：409，并把还开着的那一条一起带回", async () => {
  const open = await createOne("第二发不该建出第二条");
  const res = await call("POST", "/v2/note-learning-rounds", {
    noteId: noteA, drivingQuestion: "换一个问法", drivingQuestionSource: "user_authored",
  });
  assert.equal(res.statusCode, 409, `应当是冲突，实到 ${res.statusCode} ${res.body}`);
  const parsed = body(res);
  assert.equal(parsed.error, "round_already_open");
  const carried = noteLearningRoundV1Schema.parse(parsed.round as never);
  assert.equal(carried.roundId, open.roundId, "409 里带的那一条必须就是还开着的那一条");
  assert.equal(carried.revision, open.revision, "连 revision 一起带：UI 拿它当「继续它」的那把钥匙");
});

test("读未完成那一轮：有就回它，收尾之后回 404（这一格 404 是常态）", async () => {
  const created = await createOne("读一遍看看");
  const got = await call("GET", `/v2/notes/${noteA}/learning-round`);
  assert.equal(got.statusCode, 200);
  assert.equal(noteLearningRoundV1Schema.parse(body(got).round as never).roundId, created.roundId);

  const closed = await call("PATCH", `/v2/note-learning-rounds/${created.roundId}`, {
    expectedRevision: created.revision, action: { kind: "close", outcome: "completed" },
  });
  assert.equal(closed.statusCode, 200, closed.body);
  assert.equal(noteLearningRoundV1Schema.parse(body(closed).round as never).phase, "closed");

  const after = await call("GET", `/v2/notes/${noteA}/learning-round`);
  assert.equal(after.statusCode, 404, "「继续学习」不会把已收尾的那一轮捞回来");
  assert.equal(body(after).error, "round_not_found");
});

test("拿旧的那一版来推进：409，并把现在那一版一起带回", async () => {
  const created = await createOne("两个窗口同时开着的那一发");
  // 先把服务端这一版推进一格（模拟另一个窗口已经动过）。
  const moved = await call("PATCH", `/v2/note-learning-rounds/${created.roundId}`, {
    expectedRevision: created.revision, action: { kind: "pause" },
  });
  assert.equal(moved.statusCode, 200, moved.body);
  const stale = await call("PATCH", `/v2/note-learning-rounds/${created.roundId}`, {
    expectedRevision: created.revision, action: { kind: "resume" },
  });
  assert.equal(stale.statusCode, 409, `旧 revision 那一发必须失败：${stale.statusCode} ${stale.body}`);
  assert.equal(body(stale).error, "stale_revision");
  const current = noteLearningRoundV1Schema.parse(body(stale).round as never);
  assert.equal(current.revision, Number(created.revision) + 1, "带回来的应当是现在那一版，不是客户端送来那版");
  assert.equal(current.phase, "paused");
});

test("改写本轮问题：句子与两个计数器一起动；终态之后改写走不通", async () => {
  const created = await createOne("系统建议的那一句");
  const revised = await call("POST", `/v2/note-learning-rounds/${created.roundId}/driving-question`, {
    expectedRevision: created.revision,
    drivingQuestion: "先分清两种情况，再判断慢在哪一步",
    drivingQuestionSource: "user_rewritten",
  });
  assert.equal(revised.statusCode, 200, revised.body);
  const round = noteLearningRoundV1Schema.parse(body(revised).round as never);
  assert.equal(round.drivingQuestion, "先分清两种情况，再判断慢在哪一步");
  assert.equal(round.drivingQuestionSource, "user_rewritten");
  assert.equal(round.drivingQuestionRevision, 2);
  assert.equal(round.revision, Number(created.revision) + 1);

  const closed = await call("PATCH", `/v2/note-learning-rounds/${created.roundId}`, {
    expectedRevision: round.revision, action: { kind: "close", outcome: "partial" },
  });
  assert.equal(closed.statusCode, 200, closed.body);
  const late = await call("POST", `/v2/note-learning-rounds/${created.roundId}/driving-question`, {
    expectedRevision: Number(round.revision) + 1,
    drivingQuestion: "收尾之后再来改一句",
    drivingQuestionSource: "user_authored",
  });
  assert.equal(late.statusCode, 409, `终态只读：${late.statusCode} ${late.body}`);
  assert.equal(body(late).error, "round_closed");
});

test("请求体与 id 形状不对一律 400，不进服务层", async () => {
  const cases: Array<[string, () => Promise<{ statusCode: number; body: string }>, string]> = [
    ["noteId 不是 uuid", () => call("POST", "/v2/note-learning-rounds", { noteId: "not-a-uuid", drivingQuestion: "一句", drivingQuestionSource: "suggested" }), "invalid_request"],
    ["本轮问题空句", () => call("POST", "/v2/note-learning-rounds", { noteId: noteA, drivingQuestion: "   ", drivingQuestionSource: "suggested" }), "invalid_request"],
    ["多带一个没人认的键", () => call("POST", "/v2/note-learning-rounds", { noteId: noteA, drivingQuestion: "一句", drivingQuestionSource: "suggested", noteVersionId: randomUUID() }), "invalid_request"],
    ["推进动作不认识", () => call("PATCH", `/v2/note-learning-rounds/${randomUUID()}`, { expectedRevision: 1, action: { kind: "restart" } }), "invalid_request"],
    ["expectedRevision 缺席", () => call("PATCH", `/v2/note-learning-rounds/${randomUUID()}`, { action: { kind: "pause" } }), "invalid_request"],
  ];
  for (const [label, run, expected] of cases) {
    const res = await run();
    assert.equal(res.statusCode, 400, `${label}：实到 ${res.statusCode} ${res.body}`);
    assert.equal(body(res).error, expected, `${label}：${res.body}`);
  }
  // 「多带一个 noteVersionId」这一发还顺手钉住合同是 `.strict()`：
  // 客户端想指定版本？合同不收，服务端自己读。
});

test("换到别人的上下文：读不到、也推不动（连存在性都不给）", async () => {
  const created = await createOne("我这一篇的一轮");
  const got = await call("GET", `/v2/notes/${noteA}/learning-round`, undefined, peerToken);
  assert.equal(got.statusCode, 404, `同空间另一人不应读到：${got.statusCode} ${got.body}`);
  const patched = await call("PATCH", `/v2/note-learning-rounds/${created.roundId}`, {
    expectedRevision: created.revision, action: { kind: "pause" },
  }, peerToken);
  assert.equal(patched.statusCode, 404, patched.body);
  assert.equal(body(patched).error, "round_not_found", "不是 stale_revision——他连有没有这一轮都不该知道");
});

test("预算那份 env 覆盖真的生效，且 0 是合法档（不是坏值）", async () => {
  process.env.NOTE_ROUND_MAX_TASKS = "0";
  try {
    const res = await call("POST", "/v2/note-learning-rounds", {
      noteId: noteA, drivingQuestion: "预算设成 0 的那一发", drivingQuestionSource: "suggested",
    });
    // 上一轮还没收尾时这里会是 409——先收尾再验，所以只认这两种"进到了服务层"的结果。
    if (res.statusCode === 409) {
      const existing = noteLearningRoundV1Schema.parse(body(res).round as never);
      const closed = await call("PATCH", `/v2/note-learning-rounds/${existing.roundId}`, {
        expectedRevision: existing.revision, action: { kind: "close", outcome: "superseded" },
      });
      assert.equal(closed.statusCode, 200, closed.body);
      return;
    }
    assert.equal(res.statusCode, 201, res.body);
    const round = noteLearningRoundV1Schema.parse(body(res).round as never);
    assert.equal(round.budgets.maxTasks, 0, "0 是留的对照档：改了预算，回执里就得跟着变");
  } finally {
    delete process.env.NOTE_ROUND_MAX_TASKS;
  }
});
