/**
 * 轮次服务的真实 Postgres 契约（39d W4-5 第二刀）。
 *
 * 这一份钉的是**服务层那半**，0282 那份集测钉的是库层机制，两份不重复：
 *  - `readOpenRound` 在两种角色下都只认未终结的两档（§3.2「继续学习只恢复未终结轮次」）；
 *  - CAS 的两道（`expectedRevision` 比一次、写的 `WHERE revision` 再比一次）真的会挡下
 *    拿旧版来写的那一发，**并且库里什么都没变**——只断言"报了错"是不够的，
 *    失败却写了一半才是这一族最难看的形状；
 *  - noop（重复 pause／同文字改写）**不推进** `revision`：这条计数器是状态与计划修订
 *    共用的（§6.3），把它吹大就等于让"什么都没变"看起来像"改过一次"；
 *  - 服务把库里那两条机制翻译成调用方认得出的码：撞部分唯一索引 ⇒ `round_already_open`
 *    并带回还开着的那一条；终态之后 ⇒ `round_closed`。
 *
 * 连接分工照 doc 34 §1.2：夹具走 `DATABASE_URL_MIGRATOR`，**被测服务经
 * `withWorkspaceTransaction` 跑在 `DATABASE_URL_API`（受限角色）上**——
 * 用超级用户跑这一份，跨用户那两条断言会恒绿。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { closeDatabase, withWorkspaceTransaction } from "../db/client.ts";
import {
  advanceRound,
  createRound,
  readOpenRound,
  readRound,
  reviseDrivingQuestion,
  RoundServiceError,
  type CreateRoundInputV1,
} from "../modules/note-learning-rounds/round-service.ts";
import { seedNotesOnlyWorkspace, type NotesOnlyWorkspaceFixture } from "./helpers/pure-v2-workspace-fixture.ts";

const fixtureUrl = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!fixtureUrl || !process.env.DATABASE_URL_API) {
  throw new Error(
    "轮次服务集测需要 DATABASE_URL_MIGRATOR（夹具）＋DATABASE_URL_API（受限角色，被测服务跑在它上面）",
  );
}
const fixtureSql = postgres(fixtureUrl, { max: 4 });

const HASH_A = "0f1e2d3c4b5a69788796a5b4c3d2e1f0"; // 真实主形状：32 位 md5（computeContentHash）

let seeded: NotesOnlyWorkspaceFixture | null = null;
let workspaceId = "";
let userId = "";
let noteA = "";
let versionA = "";
let noteB = "";
let versionB = "";
let peerUserId = "";

function createInput(noteId: string, noteVersionId: string, overrides: Partial<CreateRoundInputV1> = {}): CreateRoundInputV1 {
  return {
    noteId,
    noteVersionId,
    sourceContentHash: HASH_A,
    evidenceSnapshotIds: [],
    drivingQuestion: "判断为什么有索引，查询仍然可能慢",
    drivingQuestionSource: "suggested",
    budgets: { maxModelCalls: 6, maxWallClockSeconds: 600, maxTasks: 4 },
    ...overrides,
  };
}

const me = () => ({ workspaceId, userId });

before(async () => {
  seeded = await seedNotesOnlyWorkspace(fixtureSql, { noteCount: 2 });
  workspaceId = seeded.workspaceId;
  userId = seeded.userId;
  [noteA, noteB] = seeded.noteIds;
  [versionA, versionB] = seeded.versionIds;
  peerUserId = randomUUID();
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role)
      VALUES (${peerUserId}, ${`peer-${peerUserId.slice(0, 8)}@example.test`}, 'h', 'member')`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${peerUserId}, 'member')`;
  });
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
  await fixtureSql.end();
  await closeDatabase();
});

/** 抓服务抛的码，顺带把消息留下（消息里带着"哪一轮还开着"这件事本身是判据）。 */
async function serviceCode(action: () => Promise<unknown>): Promise<{ code: string | null; message: string }> {
  try {
    await action();
  } catch (err) {
    if (err instanceof RoundServiceError) return { code: err.code, message: err.message };
    return { code: (err as { code?: string }).code ?? "unknown", message: String((err as Error).message) };
  }
  return { code: null, message: "" };
}

test("create：三件快照引用、三份预算、phase/revision 都按 D1 的形状落下来", async () => {
  const created = await withWorkspaceTransaction(me(), (tx) =>
    createRound(tx, me(), createInput(noteA, versionA)),
  );
  assert.equal(created.phase, "active");
  assert.equal(created.revision, 1);
  assert.equal(created.drivingQuestionRevision, 1);
  assert.equal(created.outcome, null);
  assert.equal(created.pausedAt, null);
  assert.deepEqual(created.budgets, { maxModelCalls: 6, maxWallClockSeconds: 600, maxTasks: 4 });
  // 快照引用三件逐件回读：少了哈希，"内容变没变"就只剩一个会跟着自动保存走的版本指针。
  assert.equal(created.noteVersionId, versionA);
  assert.equal(created.sourceContentHash, HASH_A);
  assert.deepEqual(created.evidenceSnapshotIds, []);

  const reopened = await withWorkspaceTransaction(me(), (tx) => readOpenRound(tx, me(), noteA));
  assert.equal(reopened?.roundId, created.roundId, "readOpenRound 必须就是刚建的那一条");
  assert.equal(reopened?.revision, 1);
});

test("同一篇的第二轮进不来，并报出还开着的那一条；换一篇能进来", async () => {
  const existing = await withWorkspaceTransaction(me(), (tx) => readOpenRound(tx, me(), noteA));
  assert.ok(existing, "前置：上一条用例建的那一条还在");

  const first = await withWorkspaceTransaction(me(), (tx) =>
    createRound(tx, me(), createInput(noteA, versionA, { drivingQuestion: "换一个问法也要挡住" })),
  ).then(() => null).catch((err) => err as RoundServiceError);
  assert.ok(first instanceof RoundServiceError);
  assert.equal(first.code, "round_already_open");
  assert.ok(first.message.includes(existing!.roundId), `消息里要带着那一条的 id，调用方才给得出「继续它」或「封存它」：${first.message}`);

  // 阳性对照：名额是按 (人, 篇) 算的，换一篇必须建得出来。
  const other = await withWorkspaceTransaction(me(), (tx) => createRound(tx, me(), createInput(noteB, versionB)));
  assert.notEqual(other.roundId, existing!.roundId);
});

test("暂停→恢复：时间各记各的；重复暂停不推进那个共用计数器", async () => {
  const round = await withWorkspaceTransaction(me(), (tx) => readOpenRound(tx, me(), noteA));
  assert.ok(round);

  const paused = await withWorkspaceTransaction(me(), (tx) =>
    advanceRound(tx, me(), { roundId: round.roundId, expectedRevision: round.revision, action: { kind: "pause" } }),
  );
  assert.equal(paused.phase, "paused");
  assert.equal(paused.revision, round.revision + 1);
  assert.ok(paused.pausedAt, "暂停要写下时间，否则「可恢复暂停」没有凭据");

  // 重复 pause：noop，库里那一行一个字段都不动。
  const again = await withWorkspaceTransaction(me(), (tx) =>
    advanceRound(tx, me(), { roundId: round.roundId, expectedRevision: paused.revision, action: { kind: "pause" } }),
  );
  assert.equal(again.revision, paused.revision, "重复的暂停不许把 revision 吹大");
  assert.equal(again.pausedAt, paused.pausedAt, "也不许把暂停时间换成第二次的时间点");

  const resumed = await withWorkspaceTransaction(me(), (tx) =>
    advanceRound(tx, me(), { roundId: round.roundId, expectedRevision: again.revision, action: { kind: "resume" } }),
  );
  assert.equal(resumed.phase, "active");
  assert.ok(resumed.resumedAt);
  assert.equal(resumed.pausedAt, paused.pausedAt, "暂停过是历史，回来了也不能抹掉");
});

test("拿旧的那一版来写：报 stale_revision，并且库里什么都没变", async () => {
  const round = await withWorkspaceTransaction(me(), (tx) => readOpenRound(tx, me(), noteB));
  assert.ok(round);

  const code = await serviceCode(() => withWorkspaceTransaction(me(), (tx) =>
    advanceRound(tx, me(), {
      roundId: round.roundId,
      expectedRevision: round.revision + 7,
      action: { kind: "close", outcome: "completed" },
    }),
  ));
  assert.equal(code.code, "stale_revision");

  const after = await withWorkspaceTransaction(me(), (tx) => readRound(tx, me(), round.roundId));
  assert.equal(after?.revision, round.revision, "失败的那一发必须一个字段都没写——只报个错是不够的");
  assert.equal(after?.phase, "active");
  assert.equal(after?.closedAt, null);
});

test("改写本轮问题：句子与两个计数器一起动；原样再发是一次 noop", async () => {
  const round = await withWorkspaceTransaction(me(), (tx) => readOpenRound(tx, me(), noteB));
  assert.ok(round);

  const revised = await withWorkspaceTransaction(me(), (tx) =>
    reviseDrivingQuestion(tx, me(), {
      roundId: round.roundId,
      expectedRevision: round.revision,
      drivingQuestion: "先分清两种情况，再判断慢在哪一步",
      drivingQuestionSource: "user_rewritten",
    }),
  );
  assert.equal(revised.drivingQuestion, "先分清两种情况，再判断慢在哪一步");
  assert.equal(revised.drivingQuestionSource, "user_rewritten");
  assert.equal(revised.drivingQuestionRevision, round.drivingQuestionRevision + 1, "这一句话改了几次要数得出来");
  assert.equal(revised.revision, round.revision + 1, "状态与计划修订共用那一个计数器（D1 §6.3）");

  const same = await withWorkspaceTransaction(me(), (tx) =>
    reviseDrivingQuestion(tx, me(), {
      roundId: round.roundId,
      expectedRevision: revised.revision,
      drivingQuestion: "先分清两种情况，再判断慢在哪一步",
      drivingQuestionSource: "user_rewritten",
    }),
  );
  assert.equal(same.revision, revised.revision, "原样再发不许算第二次修改");
});

test("收尾之后：终态只读，且不会被「继续学习」捞回来", async () => {
  const round = await withWorkspaceTransaction(me(), (tx) => readOpenRound(tx, me(), noteB));
  assert.ok(round);

  const closed = await withWorkspaceTransaction(me(), (tx) =>
    advanceRound(tx, me(), { roundId: round.roundId, expectedRevision: round.revision, action: { kind: "close", outcome: "partial" } }),
  );
  assert.equal(closed.phase, "closed");
  assert.equal(closed.outcome, "partial");
  assert.ok(closed.closedAt);

  // 「继续学习」只恢复未终结轮次（§3.2）：这一篇现在没有可恢复的那一条了。
  assert.equal(await withWorkspaceTransaction(me(), (tx) => readOpenRound(tx, me(), noteB)), null);
  // 但那一行本身还在（历史，不是被删掉）：终态只读不等于终态消失。
  assert.ok(await withWorkspaceTransaction(me(), (tx) => readRound(tx, me(), round.roundId)));

  assert.equal(await serviceCode(() => withWorkspaceTransaction(me(), (tx) =>
    advanceRound(tx, me(), { roundId: round.roundId, expectedRevision: closed.revision, action: { kind: "pause" } }),
  )).then((r) => r.code), "round_closed");
  assert.equal(await serviceCode(() => withWorkspaceTransaction(me(), (tx) =>
    reviseDrivingQuestion(tx, me(), {
      roundId: round.roundId, expectedRevision: closed.revision,
      drivingQuestion: "改写已经收尾的那一轮", drivingQuestionSource: "user_authored",
    }),
  )).then((r) => r.code), "round_closed");
});

test("跨用户：别人的轮次读不到，也推不动（不泄露存在性）", async () => {
  const mine = await withWorkspaceTransaction(me(), (tx) => readOpenRound(tx, me(), noteA));
  assert.ok(mine, "前置：这一篇上我有一条未完成的");
  const peerScope = { workspaceId, userId: peerUserId };

  assert.equal(await withWorkspaceTransaction(peerScope, (tx) => readRound(tx, peerScope, mine.roundId)), null);
  assert.equal(await withWorkspaceTransaction(peerScope, (tx) => readOpenRound(tx, peerScope, noteA)), null);
  const code = await serviceCode(() => withWorkspaceTransaction(peerScope, (tx) =>
    advanceRound(tx, peerScope, { roundId: mine.roundId, expectedRevision: mine.revision, action: { kind: "pause" } }),
  ));
  // 是 not_found 而不是 stale_revision／permission denied：他连"有没有这一轮"都不该知道。
  assert.equal(code.code, "round_not_found");
});

test("服务层的入参判据给得出名字，而不是让库里的 CHECK 冒成 500", async () => {
  // `tx` 传 null 是**故意的**：这四发都必须在触库之前就被挡下来。
  // 真到了库里，症状是那条 CHECK 的 23514 冒成一个没有名字的 500——
  // 用户看到的是"服务暂时没有返回可确认的结果"，而我们知道的是"什么都没写"。
  const cases: Array<[string, () => Promise<unknown>, string]> = [
    ["负预算", () => createRound(null as never, me(), createInput(noteA, versionA, {
      budgets: { maxModelCalls: -1, maxWallClockSeconds: 60, maxTasks: 1 },
    })), "invalid_budget"],
    ["空问题", () => createRound(null as never, me(), createInput(noteA, versionA, { drivingQuestion: "   " })), "invalid_driving_question"],
    ["超长问题", () => createRound(null as never, me(), createInput(noteA, versionA, { drivingQuestion: "长".repeat(501) })), "invalid_driving_question"],
    ["短到不像哈希", () => createRound(null as never, me(), createInput(noteA, versionA, { sourceContentHash: "abc" })), "invalid_snapshot"],
  ];
  for (const [label, run, expected] of cases) {
    const result = await serviceCode(run);
    assert.equal(result.code, expected, `${label}：${result.message}`);
  }
});
