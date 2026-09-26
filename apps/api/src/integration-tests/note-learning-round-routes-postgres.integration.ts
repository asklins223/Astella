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
import {
  noteLearningRoundHistoryPageV1Schema,
  noteLearningRoundV1Schema,
  ROUND_HISTORY_MAX_LIMIT_V1,
} from "@ailearn/shared/note-learning-round-contracts";
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
let noteB = "";
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
  seeded = await seedNotesOnlyWorkspace(fixtureSql, { noteCount: 2 });
  peerWorkspace = await seedNotesOnlyWorkspace(fixtureSql, { noteCount: 1 });
  workspaceId = seeded.workspaceId;
  userId = seeded.userId;
  [noteA, noteB] = seeded.noteIds;
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
/**
 * 只追加那三张要带绕行口子一起清（同 `note-learning-round-teaching-postgres` 的 `wipeRounds`）：
 * 这一刀之前本文件只清 `note_learning_rounds`，之所以一直没红，是因为这里从没生成过教学行。
 * 今天「讲过」那一格要用真生产者种一条，于是父表那发 DELETE 在级联到子表时炸出
 * `note_learning_round_teachings is append-only` —— 顺带量出一条**产品侧的真缺陷**，
 * 已单独登记在 39d §19（外键级联被只追加触发器挡住 ⇒ 解散空间那类拆租户路径会失败）。
 */
async function wipeRounds(wsId: string): Promise<void> {
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.allow_history_mutation', 'on', true)`;
    // 次序不是风格：`teachings.artifact_id` 指向 artifacts（0285 末尾那道 ALTER），
    // 先清 artifacts 会被这条外键挡回来（23503，本轮实测过一次）。
    await tx`DELETE FROM note_learning_round_teachings WHERE workspace_id = ${wsId}`;
    await tx`DELETE FROM note_learning_round_artifacts WHERE workspace_id = ${wsId}`;
    await tx`DELETE FROM note_learning_round_plan_revisions WHERE workspace_id = ${wsId}`;
    await tx`DELETE FROM note_learning_rounds WHERE workspace_id = ${wsId}`;
  });
}

beforeEach(async () => {
  await wipeRounds(workspaceId);
});

after(async () => {
  if (seeded) {
    await wipeRounds(seeded.workspaceId);
    await seeded.cleanup();
  }
  if (peerWorkspace) {
    await wipeRounds(peerWorkspace.workspaceId);
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
async function createOn(noteId: string, question: string): Promise<Record<string, unknown>> {
  const res = await call("POST", "/v2/note-learning-rounds", {
    noteId,
    drivingQuestion: question,
    drivingQuestionSource: "suggested",
  });
  assert.equal(res.statusCode, 201, `创建应当成功：${res.statusCode} ${res.body}`);
  return noteLearningRoundV1Schema.parse(body(res).round as never) as unknown as Record<string, unknown>;
}

/** 开一轮（默认开在 A 篇上——大多数用例只关心 A 篇）。 */
function createOne(question: string): Promise<Record<string, unknown>> {
  return createOn(noteA, question);
}

/** 收尾那一发（记录里"终态那一格"要有出处，就得真有一次带 revision 的收尾）。 */
async function closeOn(roundId: string, revision: number): Promise<void> {
  const closed = await call("PATCH", `/v2/note-learning-rounds/${roundId}`, {
    expectedRevision: revision,
    action: { kind: "close", outcome: "partial" },
  });
  assert.equal(closed.statusCode, 200, closed.body);
}

async function readHistory(url: string, bearer?: string) {
  const res = await call("GET", url, undefined, bearer ?? token);
  assert.equal(res.statusCode, 200, `${url} 应当读得到：${res.statusCode} ${res.body}`);
  return noteLearningRoundHistoryPageV1Schema.parse(JSON.parse(res.body) as never);
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

// ─── 轮次记录（PRD §10.3 的读侧第一刀；39d W4-5 第四刀） ───────────────────────

test("记录：开过的每一轮都在、新的在前，终态那一格带着收尾原因", async () => {
  const first = await createOne("第一轮的那句问题");
  await closeOn(first.roundId as string, first.revision as number);
  await createOne("第二轮的那句问题");

  const history = await readHistory(`/v2/notes/${noteA}/learning-rounds`);
  assert.deepEqual(
    history.items.map((item) => item.drivingQuestion),
    ["第二轮的那句问题", "第一轮的那句问题"],
    "顺序必须是新的在前：§10.3 那一页是从最近一轮往下读的",
  );
  assert.equal(history.hasMore, false);
  // 未完成那一轮也在同一张记录里，且**没有** outcome：把「进行中」并进「部分完成」就分不开这两件事。
  assert.equal(history.items[0].phase, "active");
  assert.equal(history.items[0].outcome, null);
  assert.equal(history.items[1].phase, "closed");
  assert.equal(history.items[1].outcome, "partial");
  assert.notEqual(history.items[1].closedAt, null, "收尾过的记录必须带着那个时间");
  assert.ok(
    new Date(history.items[1].startedAt).getTime() <= new Date(history.items[1].closedAt as string).getTime(),
    "startedAt 必须不晚于 closedAt：两格若出自同一次 now()，这一页的时间就不可信",
  );
});

test("记录只属于这一篇：另一篇的那一轮不混进来（同一个人、同一个空间）", async () => {
  await createOne("记在 A 篇上的那一轮");
  await createOn(noteB, "记在 B 篇上的那一轮");

  const onA = await readHistory(`/v2/notes/${noteA}/learning-rounds`);
  const onB = await readHistory(`/v2/notes/${noteB}/learning-rounds`);
  assert.deepEqual(onA.items.map((item) => item.drivingQuestion), ["记在 A 篇上的那一轮"]);
  assert.deepEqual(onB.items.map((item) => item.drivingQuestion), ["记在 B 篇上的那一轮"]);
  assert.notEqual(onA.items[0].roundId, onB.items[0].roundId);
});

test("limit 说的是给几条，hasMore 说的是还有没有更早的", async () => {
  for (const question of ["第一句", "第二句", "第三句"]) {
    const opened = await createOn(noteB, question);
    await closeOn(opened.roundId as string, opened.revision as number);
  }

  const capped = await readHistory(`/v2/notes/${noteB}/learning-rounds?limit=2`);
  assert.deepEqual(capped.items.map((item) => item.drivingQuestion), ["第三句", "第二句"]);
  assert.equal(capped.hasMore, true, "只给了两条却说没有更早的，这一页就会静默丢历史");

  const all = await readHistory(`/v2/notes/${noteB}/learning-rounds`);
  assert.equal(all.items.length, 3);
  assert.equal(all.hasMore, false);
});

test("limit 的坏值一律 400，不进服务层（上限挡在合同那一个数上）", async () => {
  for (const bad of ["0", "-1", "abc", String(ROUND_HISTORY_MAX_LIMIT_V1 + 1)]) {
    const res = await call("GET", `/v2/notes/${noteA}/learning-rounds?limit=${bad}`);
    assert.equal(res.statusCode, 400, `limit=${bad} 应当被挡，实到 ${res.statusCode} ${res.body}`);
  }
  const extra = await call("GET", `/v2/notes/${noteA}/learning-rounds?cursor=whatever`);
  assert.equal(extra.statusCode, 400, "还没有翻页游标：多带一格就该红，而不是被静默忽略");
});

test("同空间另一个人读这一篇的记录是空的，且同一条里对照「我这里读得到」", async () => {
  await createOne("只有开的人自己看得见的那一轮");
  const peer = await readHistory(`/v2/notes/${noteA}/learning-rounds`, peerToken);
  assert.deepEqual(peer.items, [], "RLS 没挡就等于把别人的学习记录端给了另一个人");
  // 上一条那个「空」必须分得清是**拦**还是**根本读不到东西**，所以同一条里给正向对照。
  const mine = await readHistory(`/v2/notes/${noteA}/learning-rounds`);
  assert.equal(mine.items.length, 1, `本人那一发应当读得到：${JSON.stringify(mine.items)}`);
});

test("没有轮次与读不到这一篇同形：都回空表（这一条读的是历史，不是存在性）", async () => {
  const empty = await readHistory(`/v2/notes/${noteA}/learning-rounds`);
  assert.deepEqual(empty.items, []);
  assert.equal(empty.hasMore, false);
  const unknown = await readHistory(`/v2/notes/${randomUUID()}/learning-rounds`);
  assert.deepEqual(unknown.items, []);
});

/**
 * 挂在这一轮上的一场 run，带一个**已结算**的 outcome（§10.3 那两格的读法只看
 * `origin ->> 'roundId'` 与 `result ->> 'outcome'`，与 `round-activity-sweep.ts:225` 同一支）。
 * origin 四格取真生产的那一份（`routes.ts:533` 签发的形状），objectiveId 这里给一个
 * 新 uuid 是有意的：这一条测的是"锚点指得回来"，不是目标本身存在——那条已经被
 * `note-round-practice-postgres` 用真目标钉过，不在这里重复一份假 FK。
 */
async function seedRoundRun(roundId: string, noteId: string, outcome: string): Promise<void> {
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`
      INSERT INTO learning_runs (id, workspace_id, user_id, origin, return_target,
                                 target_fingerprint, goal, phase, result)
      VALUES (
        ${randomUUID()}, ${workspaceId}, ${userId},
        ${tx.json({
          kind: "note_round", roundId, noteId,
          objectiveId: randomUUID(), keyPointId: randomUUID(),
        })},
        ${tx.json({ kind: "note_round", roundId, noteId })},
        ${"a".repeat(64)}, 'stabilize', 'completed',
        ${tx.json({ outcome, demonstratedFacets: [], gapFacets: [], scheduleImpact: { kind: "none", reasonCode: "not_assessable" } })}
      )`;
  });
}

test("记录那一行的两格新事实（§10.3／W4-8 刀一）：讲过、练过、判不准各归各的来源", async () => {
  // 解释要有正文可读：这份夹具原本只建到"有版本"，教学那一发要的是块内容
  // （同一支种法见 `note-learning-round-teaching-postgres`，这里不另造第二套材料）。
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`
      INSERT INTO note_blocks (id, version_id, workspace_id, ordinal, type, content)
      VALUES (${randomUUID()}, ${versionA}, ${workspaceId}, 1, 'paragraph',
              '有索引，查询仍然可能慢：统计信息过期时优化器会选全表扫。')`;
  });
  // 同一篇同时只能开着一条，所以一轮一轮地走：开 → 造事实 → 收尾。
  const explained = await createOn(noteA, "只讲过的那一轮");
  const explainedId = explained.roundId as string;
  const taught = await call("POST", `/v2/note-learning-rounds/${explainedId}/teaching`, {
    expectedRevision: explained.revision as number,
  });
  assert.equal(taught.statusCode, 201, `生成解释应当成功：${taught.statusCode} ${taught.body}`);
  // 生成那一发会不会推进计数器由服务端定，所以收尾用**读回来的那一份** revision，
  // 不在这里猜一个数（猜错的症状是 CAS 失败，看着像"记录测不到讲过"）。
  const afterTeach = await call("GET", `/v2/notes/${noteA}/learning-round`);
  await closeOn(explainedId, (body(afterTeach).revision ?? explained.revision) as number);

  const practiced = await createOn(noteA, "练过并且判不准的那一轮");
  const practicedId = practiced.roundId as string;
  await seedRoundRun(practicedId, noteA, "not_assessable");
  await closeOn(practicedId, practiced.revision as number);

  const declared = await createOn(noteA, "她自己说不会的那一轮");
  const declaredId = declared.roundId as string;
  await seedRoundRun(declaredId, noteA, "declared_unable");
  await closeOn(declaredId, declared.revision as number);

  const untouched = await createOn(noteA, "只开了个头的那一轮");
  const untouchedId = untouched.roundId as string;
  await closeOn(untouchedId, untouched.revision as number);

  const page = await readHistory(`/v2/notes/${noteA}/learning-rounds?limit=10`);
  const byQuestion = new Map<string, Record<string, unknown>>(
    (page.items as Record<string, unknown>[]).map((item) => [item.drivingQuestion as string, item]),
  );
  assert.deepEqual(byQuestion.get("只讲过的那一轮")?.actualModes, ["explained"], "教学产物有行＝讲过，与练没练无关");
  assert.deepEqual(byQuestion.get("练过并且判不准的那一轮")?.actualModes, ["practiced"], "有锚回这一轮的 run＝练过");
  assert.equal(byQuestion.get("练过并且判不准的那一轮")?.systemUncertain, true, "not_assessable 就是系统的判不准");
  assert.equal(
    byQuestion.get("她自己说不会的那一轮")?.systemUncertain,
    false,
    "declared_unable 是她明说不会，不是我们判不了——算进来等于把她的坦白报成系统的无能",
  );
  assert.deepEqual(byQuestion.get("只开了个头的那一轮")?.actualModes, [], "两格都没发生过是一种真实状态，不是缺数据");
  assert.equal(byQuestion.get("只开了个头的那一轮")?.systemUncertain, false);
});

/**
 * §10.3 第二级（本人、跨笔记）那一页（39d W4-8 刀二）。
 * 三条各守一件事：跨不跨得开两篇、总数是不是那一份、"读不到的那一篇"是不是整行不出现。
 */
test("我的记录（跨笔记）：两篇的行都在、总数是同一份，回收站里那一篇整行不出现", async () => {
  const onA = await createOn(noteA, "跨笔记记录：这一句在 A 篇");
  await closeOn(onA.roundId as string, onA.revision as number);
  const onB = await createOn(noteB, "跨笔记记录：这一句在 B 篇");
  await closeOn(onB.roundId as string, onB.revision as number);

  const personal = (url: string, bearer = token) => call("GET", url, undefined, bearer);
  const first = body(await personal("/v2/note-learning-rounds?limit=10"));
  const items = first.items as Record<string, unknown>[];
  assert.equal(items.length, 2, `两篇各一轮应当列出两行：${JSON.stringify(first)}`);
  assert.deepEqual(new Set(items.map((item) => item.noteId)), new Set([noteA, noteB]),
    "这一级的每一行必须说得出是哪一篇，否则读的人只看到两句问题");
  assert.equal(first.totalCount, 2);
  assert.equal(first.shownCount, 2);
  for (const item of items) {
    assert.equal(typeof item.noteTitle, "string");
    assert.ok((item.noteTitle as string).length > 0, "篇名空着等于那一行没带出处");
  }

  // 游标跨篇：第一页只给一条，第二页接的是**另一篇**那一条（不是同一篇的第二轮）。
  const page1 = body(await personal("/v2/note-learning-rounds?limit=1"));
  assert.equal(page1.hasMore, true, "还有更早的不给指针，界面就剩一颗点不动的按钮");
  const page2 = body(await personal(`/v2/note-learning-rounds?limit=1&before=${page1.nextCursor as string}`));
  const ids1 = (page1.items as Record<string, unknown>[]).map((item) => item.roundId);
  const ids2 = (page2.items as Record<string, unknown>[]).map((item) => item.roundId);
  assert.equal(new Set([...ids1, ...ids2]).size, 2, "两页并起来正好两行：跨篇翻页不许重也不许漏");
  assert.equal(page2.totalCount, 2, "总数与游标无关：第二页报的还得是「一共两轮」，不是「剩下还有一轮」");
  assert.equal(page2.hasMore, false);

  // 回收站**不**挡这一级：那是一次可逆动作，为一篇收起的笔记藏掉一段真实历史，
  // 等于把"删除中"读成"没发生过"。§10.3 说的是权限，不是回收站。
  await fixtureSql`UPDATE notes SET deleted_at = now() WHERE id = ${noteB}`;
  const afterTrash = body(await personal("/v2/note-learning-rounds?limit=10"));
  assert.equal((afterTrash.items as Record<string, unknown>[]).length, 2,
    "收进回收站就把那一行抹掉了 ⇒ 记录跟着一个可逆动作缩水");
  assert.equal(afterTrash.totalCount, 2, "隐藏与否都要总数与列表吃同一份谓词");
  // 立刻放回：这份夹具的 B 篇被后面几条用例共用，留着 deleted_at 会让它们
  // 一个个报"创建应当成功：404"——红会看起来像产品坏了，其实是我漏了收尾。
  await fixtureSql`UPDATE notes SET deleted_at = NULL WHERE id = ${noteB}`;

  /**
   * 权限那一轴按房子里那一份判据（`visibleNotesCondition`）：这篇被别人收回私有
   * （不再 shared、也不是我写的）⇒ 我那一句连同篇名整行不出现。
   * 这一档是"隐藏"，不是 §10.3 末段要的"只留非内容元数据"——那需要 D6 的权限投影
   * （W5-6 名下）。在这里现造一套遮蔽规则就是第二个权限来源，比少列一行更糟，
   * 所以只做"读不到就不列"，欠的那一档写在台账里。
   */
  await fixtureSql`UPDATE notes SET share_scope = 'private', created_by = ${peerUserId} WHERE id = ${noteB}`;
  const afterUnshare = body(await personal("/v2/note-learning-rounds?limit=10"));
  const keptIds = (afterUnshare.items as Record<string, unknown>[]).map((item) => item.roundId);
  assert.deepEqual(keptIds, [onA.roundId], "别人收回私有的那一篇还在我的记录里出现");
  assert.equal(afterUnshare.totalCount, 1, "总数还在报一个列不出来的数 ⇒ 两处谓词不同源");
  await fixtureSql`UPDATE notes SET share_scope = 'shared', created_by = ${userId} WHERE id = ${noteB}`;

  // 别人的上下文读不到我的任何一行（RLS；同空间另一个人也不行）。
  const peerPage = body(await personal("/v2/note-learning-rounds?limit=10", peerToken));
  assert.deepEqual(peerPage.items, [], "另一个人读到了我的轮次记录");
});

test("路径里那个 noteId 不是合法 id 就 400，不走「一片空白」那条安静路径", async () => {
  const res = await call("GET", "/v2/notes/not-a-uuid/learning-rounds");
  assert.equal(res.statusCode, 400, res.body);
});

test("游标翻页：两页并起来不重不漏，翻到最后一页才不再给指针", async () => {
  for (const question of ["第一句", "第二句", "第三句", "第四句"]) {
    const opened = await createOn(noteB, question);
    await closeOn(opened.roundId as string, opened.revision as number);
  }

  const first = await readHistory(`/v2/notes/${noteB}/learning-rounds?limit=2`);
  assert.equal(first.items.length, 2);
  assert.equal(first.hasMore, true);
  assert.equal(first.shownCount, 2);
  assert.notEqual(first.nextCursor, null, "说还有更早的就必须给出指针");
  assert.equal(first.nextCursor, first.items[1].roundId, "游标就是本页最后那一条");

  const second = await readHistory(`/v2/notes/${noteB}/learning-rounds?limit=2&before=${first.nextCursor}`);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null, "翻到底了还给指针，界面就会留一颗点不动的按钮");

  /**
   * 总数与游标无关：这一篇一共开过 4 轮，第一页列 2 条、第二页列 2 条，
   * 两页报的总数都必须是 4。服务层那发 `count` 若写成"带游标的条件"（＝剩下还有几轮），
   * 第二页会报 2 —— 这一条当场红。合同里的 `totalCount >= shownCount` 拦不住它，
   * 因为 2 >= 2 自己成立：只有跨页对齐才看得见。
   */
  assert.equal(first.totalCount, 4, "中途那一页的总数就应当是全篇那个数");
  assert.equal(second.totalCount, first.totalCount, "总数不许随翻页变小（那是在报「剩下还有几轮」）");
  assert.equal(second.shownCount, 2, "本页条数另说：它随翻页变");

  const ids = [...first.items, ...second.items].map((item) => item.roundId);
  assert.equal(new Set(ids).size, 4, "两页并起来必须正好是这四轮：重一条或漏一条都是键集写错了");
  assert.deepEqual(
    [...second.items].map((item) => item.drivingQuestion),
    ["第二句", "第一句"],
    "第二页接着往**更早**走：新的在前，第一页吃掉最近两条",
  );
});

test("游标来路不对就 400：安静回到第一页会把「翻不动了」读成「记录少了」", async () => {
  const mine = await createOn(noteA, "记在 A 篇的那一轮");
  const onA = await readHistory(`/v2/notes/${noteA}/learning-rounds?limit=20`);
  assert.equal(onA.items[0].roundId, mine.roundId);

  // ① 同一篇上的游标用在**另一篇**上（同一空间、同一个人：RLS 拦不住这种，只能靠这一格判据）；
  // ② 一个根本不存在的 id。
  const otherNote = await call("GET", `/v2/notes/${noteB}/learning-rounds?before=${mine.roundId as string}`);
  assert.equal(otherNote.statusCode, 400, otherNote.body);
  assert.equal(body(otherNote).error, "invalid_cursor");
  const ghost = await call("GET", `/v2/notes/${noteA}/learning-rounds?before=${randomUUID()}`);
  assert.equal(ghost.statusCode, 400, ghost.body);
  assert.equal(body(ghost).error, "invalid_cursor");

  // 正控制：同一篇上自己那条的游标照样能翻。
  const okPage = await readHistory(`/v2/notes/${noteA}/learning-rounds?limit=20&before=${mine.roundId as string}`);
  assert.deepEqual(okPage.items, [], "翻过最后一条之后就是空页，不是报错");
});

test("同一时刻开出的两轮也要不重不漏地翻完（游标里那一列 id 不是装饰）", async () => {
  const opened = [];
  for (const question of ["同时第一", "同时第二", "第三句"]) {
    const created = await createOn(noteB, question);
    await closeOn(created.roundId as string, created.revision as number);
    opened.push(created.roundId as string);
  }
  // 把其中两行的 created_at 拧成**同一个瞬间**：真实里这会发生（并发首点、或时钟回拨），
  // 而单行夹具永远撞不上——撞不上就永远测不出"只按时间翻页会跳过一条"。
  // 这张表有"revision 不许原地不动"的触发器（CAS 的 DB 侧护栏），所以手工拧一列
  // 也必须同时把 revision 前移——这条用例顺带证明那道触发器真的在挡静默改写。
  await fixtureSql`UPDATE note_learning_rounds
      SET created_at = transaction_timestamp(), revision = revision + 1
      WHERE id = ${opened[0]}::uuid OR id = ${opened[1]}::uuid`;

  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 4; page += 1) {
    const res = await readHistory(
      `/v2/notes/${noteB}/learning-rounds?limit=1${cursor ? `&before=${cursor}` : ""}`,
    );
    if (res.items.length === 0) break;
    for (const item of res.items) assert.ok(!seen.includes(item.roundId), `第 ${page + 1} 页重复了 ${item.drivingQuestion}`);
    seen.push(...res.items.map((item) => item.roundId));
    cursor = res.nextCursor;
    if (!res.hasMore) break;
  }
  assert.deepEqual(new Set(seen).size, 3, `三轮都要翻到且只翻一次，实到 ${seen.length} 条`);
});
