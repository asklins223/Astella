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
import { sql } from "drizzle-orm";
import { closeDatabase, withWorkspaceTransaction } from "../db/client.ts";
import {
  advanceRound,
  appendPlanRevision,
  createRound,
  listPlanRevisions,
  readOpenRound,
  readRound,
  reviseDrivingQuestion,
  RoundServiceError,
  type CreateRoundInputV1,
} from "../modules/note-learning-rounds/round/round-service.ts";
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
    // 六条计划修订用例各拿一篇自己的笔记：同 (workspace,user,note) 至多一条
    // 未完成轮次（0282 的部分唯一索引），共用一篇会互相撞"round_already_open"。
    // 第七篇是 0289 级联豁免那条用例的（它也开一轮，同样不能与别人共用）。
    for (let i = 0; i < 7; i++) {
      const noteId = randomUUID();
      const versionId = randomUUID();
      await tx`INSERT INTO notes (id, workspace_id, title, created_by)
        VALUES (${noteId}, ${workspaceId}, ${`plan-fixture-${i}`}, ${userId})`;
      await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
        VALUES (${versionId}, ${noteId}, ${workspaceId}, 1,
          ${tx.json({ blocks: [{ type: "paragraph", content: "计划修订用例" }] })},
          ${HASH_A}, ${userId})`;
      planNotes.push({ noteId, versionId });
    }
  });
});

/** 每条计划修订用例的专属笔记（与索引前的注释同因）。 */
const planNotes: Array<{ noteId: string; versionId: string }> = [];

after(async () => {
  if (seeded) {
    const wsId = seeded.workspaceId;
    // 计划修订表只追加（0283 触发器连超户也拦，绕行口子 = app.allow_history_mutation）：
    // 先带口子删计划行，再删轮次，最后走夹具自己的清理（notes 级联到已空的轮次）。
    await fixtureSql.begin(async (tx) => {
      await tx`SELECT set_config('app.allow_history_mutation', 'on', true)`;
      await tx`DELETE FROM note_learning_round_plan_revisions WHERE workspace_id = ${wsId}`;
    });
    await fixtureSql`DELETE FROM note_learning_rounds WHERE workspace_id = ${wsId}`;
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

// ─── 计划本体的追加式修订（39d W4-5 第三刀；D3 §5）───────────────────────

const PLAN_V1 = {
  version: 1 as const,
  steps: [{ text: "先判断为什么有索引仍可能慢" }, { text: "对照两条访问路径的成本" }],
  expectedScale: "两三个回合",
  endCondition: "能自己说出至少两个让优化器放弃索引的条件",
};

function planInput(
  roundId: string,
  expectedRevision: number,
  overrides: Partial<{ plan: unknown; reason: string }> = {},
) {
  return {
    roundId,
    expectedRevision,
    plan: overrides.plan ?? PLAN_V1,
    reason: overrides.reason ?? "根据先试的表现收窄范围",
  };
}

test("计划修订：追加两版，读序就是「最初 → 现在」，共用计数器随写推进而 pause/resume 不产生计划行", async () => {
  const created = await withWorkspaceTransaction(me(), (tx) =>
    createRound(tx, me(), createInput(planNotes[0].noteId, planNotes[0].versionId)),
  );

  // 先来一次 pause→resume：状态变化推进共用计数器，但**不**产生计划行——
  // 状态变化与计划变化可区分，靠的就是 round_revision 在计划表里不连续。
  await withWorkspaceTransaction(me(), (tx) =>
    advanceRound(tx, me(), { roundId: created.roundId, expectedRevision: created.revision, action: { kind: "pause" } }));
  const resumed = await withWorkspaceTransaction(me(), (tx) =>
    advanceRound(tx, me(), { roundId: created.roundId, expectedRevision: created.revision + 1, action: { kind: "resume" } }));
  assert.equal(resumed.revision, 3);
  assert.deepEqual(await withWorkspaceTransaction(me(), (tx) => listPlanRevisions(tx, me(), created.roundId)), [],
    "还没提出计划时是空数组（那一轮只有一句话），不是错误");

  const first = await withWorkspaceTransaction(me(), (tx) =>
    appendPlanRevision(tx, me(), planInput(created.roundId, resumed.revision, {})));
  assert.equal(first.planOrdinal, 1);
  assert.equal(first.roundRevision, 4, "第一版计划落在共用计数器推进之后的那一格");
  assert.deepEqual(first.plan, PLAN_V1);

  const second = await withWorkspaceTransaction(me(), (tx) =>
    appendPlanRevision(tx, me(), {
      roundId: created.roundId,
      expectedRevision: first.roundRevision,
      plan: { ...PLAN_V1, steps: PLAN_V1.steps.slice(0, 1) },
      reason: "先试已经会了第二条，缩短",
    }));
  assert.equal(second.planOrdinal, 2);
  assert.equal(second.roundRevision, 5);

  const revisions = await withWorkspaceTransaction(me(), (tx) => listPlanRevisions(tx, me(), created.roundId));
  assert.equal(revisions.length, 2);
  // 变更前后由相邻两行给出：第一版原样还在，不许被第二版覆盖（D3 §5 的红线）。
  assert.equal(revisions[0].planOrdinal, 1);
  assert.deepEqual(revisions[0].plan, PLAN_V1);
  assert.equal(revisions[0].roundRevision, 4);
  assert.equal(revisions[1].planOrdinal, 2);
  assert.equal(revisions[1].plan.steps.length, 1);
  assert.equal(revisions[1].reason, "先试已经会了第二条，缩短");

  const round = await withWorkspaceTransaction(me(), (tx) => readRound(tx, me(), created.roundId));
  assert.equal(round?.revision, 5, "轮次行的 revision 被两次计划修订推到 5（D1 §6.3 共用）");
});

test("计划修订：stale expectedRevision 被拒，库里一行都没多", async () => {
  const created = await withWorkspaceTransaction(me(), (tx) =>
    createRound(tx, me(), createInput(planNotes[1].noteId, planNotes[1].versionId)));
  const result = await serviceCode(() => withWorkspaceTransaction(me(), (tx) =>
    appendPlanRevision(tx, me(), planInput(created.roundId, created.revision + 3, {}))));
  assert.equal(result.code, "stale_revision");
  const rows = await withWorkspaceTransaction(me(), (tx) => listPlanRevisions(tx, me(), created.roundId));
  assert.equal(rows.length, 0, "失败的追加不许留下半行");
});

test("计划修订：收尾之后终态只读，追加被拒", async () => {
  const created = await withWorkspaceTransaction(me(), (tx) =>
    createRound(tx, me(), createInput(planNotes[2].noteId, planNotes[2].versionId)));
  await withWorkspaceTransaction(me(), (tx) =>
    advanceRound(tx, me(), { roundId: created.roundId, expectedRevision: created.revision, action: { kind: "close", outcome: "completed" } }));
  const result = await serviceCode(() => withWorkspaceTransaction(me(), (tx) =>
    appendPlanRevision(tx, me(), planInput(created.roundId, created.revision + 1, {}))));
  assert.equal(result.code, "round_closed");
});

test("计划修订：形状与理由在触库之前就有名字地被拒", async () => {
  const created = await withWorkspaceTransaction(me(), (tx) =>
    createRound(tx, me(), createInput(planNotes[3].noteId, planNotes[3].versionId)));
  const cases: Array<[string, () => Promise<unknown>, string]> = [
    ["零步骤的计划", () => withWorkspaceTransaction(me(), (tx) =>
      appendPlanRevision(tx, me(), planInput(created.roundId, created.revision, { plan: { ...PLAN_V1, steps: [] } }))), "invalid_plan_revision"],
    ["没有理由", () => withWorkspaceTransaction(me(), (tx) =>
      appendPlanRevision(tx, me(), planInput(created.roundId, created.revision, { reason: "  " }))), "invalid_plan_revision"],
  ];
  for (const [label, run, expected] of cases) {
    const result = await serviceCode(run);
    assert.equal(result.code, expected, `${label}：${result.message}`);
  }
});

test("计划修订：只追加是 DB 层的——UPDATE/DELETE 都被触发器拒，绕行口子只对显式维护路径开放", async () => {
  const created = await withWorkspaceTransaction(me(), (tx) =>
    createRound(tx, me(), createInput(planNotes[4].noteId, planNotes[4].versionId)));
  await withWorkspaceTransaction(me(), (tx) =>
    appendPlanRevision(tx, me(), planInput(created.roundId, created.revision, {})));

  // 追加式在**触发器**上收口：迁移里只授 SELECT/INSERT，但 roles 步骤会把新表
  // 权限放宽到 ALL（与 CI fresh-migrations 同序），所以这一腿实测拦住 UPDATE 的
  // 是触发器而非表权限。drizzle 会把驱动错误包进 cause 链，沿链找那一句话。
  await assert.rejects(
    () => withWorkspaceTransaction(me(), async (tx) => {
      await tx.execute(sql`UPDATE note_learning_round_plan_revisions SET reason = '改掉' WHERE workspace_id = ${workspaceId}`);
    }),
    (error: unknown) => {
      const chain: string[] = [];
      let e: unknown = error;
      while (e instanceof Error && chain.length < 6) {
        chain.push(e.message);
        e = (e as { cause?: unknown }).cause;
      }
      assert.match(chain.join(" | "), /append-only: UPDATE is not allowed/,
        `触发器先拦：沿 cause 链找到的是 ${chain.join(" | ")}`);
      return true;
    },
  );

  // 超户也绕不过触发器：不带绕行口子的 DELETE 必须红（append-only 的语义证据，
  // 不是"权限挡的"那种假绿）。
  await assert.rejects(
    () => fixtureSql`DELETE FROM note_learning_round_plan_revisions WHERE workspace_id = ${workspaceId}`,
    /append-only/,
  );

  /**
   * 0289 那一条级联豁免的正向对照（上一格登记 P0 时说过，豁免本身没有测试读它）。
   * 判据是"祖先那一轮已经不在"，所以：删父行 ⇒ 子行跟着走；而**别的轮次的子行**
   * 一行都不许被这一发带走（否则这条豁免就成了空挡一切的口子）。
   */
  const cascadeRound = await withWorkspaceTransaction(me(), (tx) =>
    createRound(tx, me(), createInput(planNotes[6].noteId, planNotes[6].versionId)));
  await withWorkspaceTransaction(me(), (tx) =>
    appendPlanRevision(tx, me(), planInput(cascadeRound.roundId, cascadeRound.revision, {})));
  await fixtureSql`DELETE FROM note_learning_rounds WHERE id = ${cascadeRound.roundId}`;
  const goneRounds = await fixtureSql`SELECT count(*)::int AS n FROM note_learning_rounds WHERE id = ${cascadeRound.roundId}`;
  const goneRevisions = await fixtureSql`
    SELECT count(*)::int AS n FROM note_learning_round_plan_revisions WHERE round_id = ${cascadeRound.roundId}`;
  const otherRevisions = await fixtureSql`
    SELECT count(*)::int AS n FROM note_learning_round_plan_revisions WHERE round_id = ${created.roundId}`;
  assert.equal(Number(goneRounds[0].n), 0, "父行没删掉，这一条测不到级联");
  assert.equal(Number(goneRevisions[0].n), 0,
    "0289 的级联豁免没生效：删父行仍然被子表守卫挡在半路（那条 P0 的形状）");
  assert.equal(Number(otherRevisions[0].n), 1,
    "别轮次的子行被一起删了 ⇒ 这条豁免不是按'祖先还活不活'判，而是空挡了一切");

  // 带绕行口子（app.allow_history_mutation='on'）：显式维护路径删得掉——
  // 这就是 after() 清理走的同一条路。
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.allow_history_mutation', 'on', true)`;
    const deleted = await tx`DELETE FROM note_learning_round_plan_revisions WHERE round_id = ${created.roundId} RETURNING plan_ordinal`;
    assert.equal(deleted.length, 1, "绕行口子下恰好删掉这一轮的那一版");
  });
  const afterBypass = await withWorkspaceTransaction(me(), (tx) => listPlanRevisions(tx, me(), created.roundId));
  assert.equal(afterBypass.length, 0);
});

test("计划修订：别人的轮次追加不进去（不泄露存在性）", async () => {
  const created = await withWorkspaceTransaction(me(), (tx) =>
    createRound(tx, me(), createInput(planNotes[5].noteId, planNotes[5].versionId)));
  const result = await serviceCode(() => withWorkspaceTransaction(
    { workspaceId, userId: peerUserId },
    (tx) => appendPlanRevision(tx, { workspaceId, userId: peerUserId }, planInput(created.roundId, created.revision, {})),
  ));
  assert.equal(result.code, "round_not_found");
});
