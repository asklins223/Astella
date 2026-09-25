/**
 * `note_learning_rounds` 的真实 Postgres 契约（39d W4-5 第一刀；迁移 0282）。
 *
 * 为什么必须是集成测试：这一张表的全部承诺都是 **DB 机制**，服务层还没写，
 * 所以没有任何 mock 事务能替它证明——
 *  - 「同一篇默认只有一个进行中或暂停的轮次」（D1 §6.1 / PRD §3.2）是那条
 *    **部分唯一索引**在挡，不是应用层记得先查后写；
 *  - 「归属三件套＋那份快照引用不可改写」（§6.2、§6.4）是触发器在挡；
 *  - 「`revision` 单调」（§6.3）这里先钉 DB 那一半（不许原地覆盖、不许倒退），
 *    CAS 那半属服务层；
 *  - 「`closed` 必带终态原因」写成**双向** CHECK，"偷偷写个 outcome 但还没收尾"
 *    这种状态必须在库里表达不出来；
 *  - 「不给 worker 开跨租户读」（§6.5）是**没有 GRANT** 这一件事，钉的必须是
 *    `permission denied`，而不是"读回来 0 行"——0 行的成因可以是策略挡的、
 *    可以是没跑过、也可以是该表根本读不到，三种读数在产品上是三回事。
 *
 * 每条"应当被拒"都配了一个同形状的"应当放行"作对照（换一篇笔记、或前进一格 revision），
 * 否则一条红可以是任何别的原因红的。SQLSTATE 逐条实测过：CHECK=23514、NOT NULL=23502、
 * 唯一=23505、RLS WITH CHECK=42501、触发器=SP002（node 侧报 `P0001` 的是 RAISE 的默认 condition）。
 *
 * 角色分工照 doc 34 §1.2：**夹具走 migrator，所有断言走受限角色**。
 * 开发库的 `DATABASE_URL` 是 `ailearn`（rolbypassrls=t），拿它跑这些断言会恒绿。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { seedNotesOnlyWorkspace, type NotesOnlyWorkspaceFixture } from "./helpers/pure-v2-workspace-fixture.ts";

const fixtureUrl = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
const apiUrl = process.env.DATABASE_URL_API;
const workerUrl = process.env.DATABASE_URL_WORKER;
if (!fixtureUrl || !apiUrl || !workerUrl) {
  throw new Error(
    "轮次契约集测需要三条连接：DATABASE_URL_MIGRATOR（夹具）＋DATABASE_URL_API（受限角色，断言用）＋DATABASE_URL_WORKER（钉「没给 worker 开读」）",
  );
}

const fixtureSql = postgres(fixtureUrl, { max: 4 });
const apiSql = postgres(apiUrl, { max: 4 });
const workerSql = postgres(workerUrl, { max: 4 });

const HASH_A = "0f1e2d3c4b5a69788796a5b4c3d2e1f0"; // 真实主形状：32 位 md5（computeContentHash）

type RoundInput = {
  workspaceId: string;
  userId: string;
  noteId: string;
  noteVersionId: string;
  drivingQuestion?: string;
  drivingQuestionSource?: string;
  sourceContentHash?: string;
  maxModelCalls?: number;
  maxWallClockSeconds?: number;
  maxTasks?: number | null;
  phase?: string;
  outcome?: string | null;
  closedAt?: string | null;
};

/**
 * 以"应用"的身份插一条轮次：带 `(app.workspace_id, app.user_id)` 两个 GUC。
 * 少了这两个，写会被 RLS 的 WITH CHECK 挡下——那也算"红"，但不是产品口径的红。
 * `maxTasks: null` 那一支走一条不含 `max_tasks` 列的 INSERT，专门用来钉"没有 DEFAULT"。
 */
async function insertRound(sql: postgres.Sql, input: RoundInput): Promise<string> {
  const ctx = { workspaceId: input.workspaceId, userId: input.userId };
  const hash = input.sourceContentHash ?? HASH_A;
  const question = input.drivingQuestion ?? "判断为什么有索引，查询仍然可能慢";
  const source = input.drivingQuestionSource ?? "suggested";
  const phase = input.phase ?? "active";
  const rows = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    if (input.maxTasks === null) {
      return tx`
        INSERT INTO note_learning_rounds (
          workspace_id, user_id, note_id, note_version_id,
          driving_question, driving_question_source, source_content_hash,
          max_model_calls, max_wall_clock_seconds, phase
        ) VALUES (
          ${ctx.workspaceId}, ${ctx.userId}, ${input.noteId}, ${input.noteVersionId},
          ${question}, ${source}, ${hash},
          ${input.maxModelCalls ?? 6}, ${input.maxWallClockSeconds ?? 600}, ${phase}
        ) RETURNING id`;
    }
    return tx`
      INSERT INTO note_learning_rounds (
        workspace_id, user_id, note_id, note_version_id,
        driving_question, driving_question_source, source_content_hash,
        max_model_calls, max_wall_clock_seconds, max_tasks,
        phase, outcome, closed_at
      ) VALUES (
        ${ctx.workspaceId}, ${ctx.userId}, ${input.noteId}, ${input.noteVersionId},
        ${question}, ${source}, ${hash},
        ${input.maxModelCalls ?? 6}, ${input.maxWallClockSeconds ?? 600}, ${input.maxTasks ?? 4},
        ${phase}, ${input.outcome ?? null}, ${input.closedAt ?? null}
      ) RETURNING id`;
  });
  return String(rows[0].id);
}

async function runAs<T>(
  sql: postgres.Sql,
  ctx: { workspaceId: string; userId: string },
  body: (tx: postgres.Sql) => PromiseLike<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    return body(tx as unknown as postgres.Sql);
  }) as Promise<T>;
}

async function expectDbError(code: string, action: () => Promise<unknown>, what: string): Promise<void> {
  let caught: unknown = null;
  try {
    await action();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, `${what} 必须被拒——它通过了，说明那条约束根本没在挡`);
  const actual = (caught as { code?: string }).code;
  assert.equal(actual, code, `${what} 的 SQLSTATE（实际 ${String(actual)}）`);
}

let seeded: NotesOnlyWorkspaceFixture | null = null;
let peerWorkspace: NotesOnlyWorkspaceFixture | null = null;
let workspaceId = "";
let peerWorkspaceId = "";
let userId = "";
let noteA = "";
let versionA = "";
let noteB = "";
let versionB = "";
/** 第三篇：给"要真插进去"的正向用例用，前面那些用例已经把 A/B 的未完成名额占掉了。 */
let noteC = "";
let versionC = "";
/** 第四篇：给"两个人各占一条"那条用例用（C 已被上一条占掉）。 */
let noteD = "";
let versionD = "";
/** 第五、六篇：留给"哈希形状"那两发正向用例，不与按人算那条共用一篇（共用就会撞名额）。 */
let noteE = "";
let versionE = "";
let noteF = "";
let versionF = "";
/** 同一空间里的第二个人：§3.2 那句"同一用户、同一笔记"里的另一个"用户"。 */
let peerUserId = "";

const me = () => ({ workspaceId, userId });

before(async () => {
  seeded = await seedNotesOnlyWorkspace(fixtureSql, { noteCount: 6 });
  peerWorkspace = await seedNotesOnlyWorkspace(fixtureSql, { noteCount: 1 });
  workspaceId = seeded.workspaceId;
  peerWorkspaceId = peerWorkspace.workspaceId;
  userId = seeded.userId;
  [noteA, noteB, noteC, noteD, noteE, noteF] = seeded.noteIds;
  [versionA, versionB, versionC, versionD, versionE, versionF] = seeded.versionIds;
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
  // 0282 那道触发器只管 UPDATE 身份列，DELETE 不受限，所以按空间直接清；
  // 顺序在 fixture 的 cleanup 之前——它删 notes，而轮次带着 note_id 外键。
  for (const ws of [seeded, peerWorkspace]) {
    if (!ws) continue;
    await fixtureSql`DELETE FROM note_learning_rounds WHERE workspace_id = ${ws.workspaceId}`;
    await ws.cleanup();
  }
  if (peerUserId !== "") {
    await fixtureSql`DELETE FROM workspace_members WHERE user_id = ${peerUserId}`;
    await fixtureSql`DELETE FROM users WHERE id = ${peerUserId}`;
  }
  await fixtureSql.end();
  await apiSql.end();
  await workerSql.end();
});

async function openRoundCount(targetNoteId: string, ctx = me()): Promise<number> {
  const rows = await runAs(apiSql, ctx, (tx) => tx`
    SELECT count(*)::int AS n FROM note_learning_rounds
    WHERE note_id = ${targetNoteId} AND phase IN ('active','paused')
  `);
  return Number(rows[0].n);
}

test("部分唯一索引：同一篇的第二条未完成轮次进不来，换一篇能进来", async () => {
  await insertRound(apiSql, { ...me(), noteId: noteA, noteVersionId: versionA });
  assert.equal(await openRoundCount(noteA), 1, "前置：夹具在受限角色下写出了这一条");

  await expectDbError("23505", () => (
    insertRound(apiSql, { ...me(), noteId: noteA, noteVersionId: versionA })
  ), "同一篇的第二条 active 轮次");

  // 阳性对照：换一篇笔记就该进来——少了这一步，上面那条红可以是任何东西造成的。
  const second = await insertRound(apiSql, {
    ...me(), noteId: noteB, noteVersionId: versionB,
    drivingQuestion: "先让我试一下这一段在说什么",
  });
  assert.match(second, /^[0-9a-f-]{36}$/);
  assert.equal(await openRoundCount(noteB), 1);
});

test("封存旧轮之后槽位释放（「明确封存旧轮并新建」是物理路径，不是 UI 约定）", async () => {
  const open = await runAs(apiSql, me(), (tx) => tx`
    SELECT id FROM note_learning_rounds WHERE note_id = ${noteA} AND phase IN ('active','paused')
  `);
  assert.equal(open.length, 1);
  const openId = String(open[0].id);
  const closedAt = new Date().toISOString();

  await runAs(apiSql, me(), (tx) => tx`
    UPDATE note_learning_rounds
       SET phase = 'closed', outcome = 'superseded', closed_at = ${closedAt}, revision = revision + 1
     WHERE id = ${openId}
  `);
  assert.equal(await openRoundCount(noteA), 0, "closed 之后必须不再占用那条部分唯一索引");

  // 于是"另开一轮"这条路真能走通——上面那些是机制，这一条才是产品结论。
  await insertRound(apiSql, {
    ...me(), noteId: noteA, noteVersionId: versionA,
    drivingQuestion: "按当前内容重来这一轮", drivingQuestionSource: "user_rewritten",
  });
  assert.equal(await openRoundCount(noteA), 1);
});

test("终态双向判据：closed 没原因进不来，没 closed 却先写原因也进不来", async () => {
  // 两发都打在 noteB 上，而 noteB 此刻已经被第一条 active 占着（上一条用例种的）——
  // 判据顺序实测过：CHECK 先于那条部分唯一索引报，所以这里的 23514 不是巧合。
  await expectDbError("23514", () => (
    insertRound(apiSql, { ...me(), noteId: noteB, noteVersionId: versionB, phase: "closed" })
  ), "phase=closed 却不带 outcome（也不带 closed_at）");
  await expectDbError("23514", () => (
    insertRound(apiSql, {
      ...me(), noteId: noteB, noteVersionId: versionB, phase: "paused", outcome: "completed",
    })
  ), "还没收尾却先写了一个 outcome");
});

test("三项预算没有默认值：少给一项就建不出这一轮", async () => {
  await expectDbError("23502", () => (
    insertRound(apiSql, {
      ...me(), noteId: noteB, noteVersionId: versionB, maxTasks: null,
    })
  ), "不给 max_tasks 的一轮（D1 §3.2「三件缺一不可」，而 §18.4 的起点值还没冻结 ⇒ 故意不写 DEFAULT）");
});

test("快照引用三件：哈希列形状与「不内联正文」", async () => {
  await expectDbError("23514", () => (
    insertRound(apiSql, {
      ...me(), noteId: noteB, noteVersionId: versionB, sourceContentHash: "a".repeat(7),
      drivingQuestion: "换一句才不被那条唯一索引先挡住",
    })
  ), "7 位的 source_content_hash（D3 §2 要拦的是「没有哈希」这一件事）");
  // 真实形状能进：`note_versions.content_hash` 今天的主形状是 **32 位 md5**
  // （`computeContentHash` 用 md5，`note/content-hash.ts:25-28`；dev 库 1045 条实测）。
  // 这一条是 09-26 把 CHECK 从"=64"改宽的因由——判据写错长度时，每一篇真实笔记
  // 都开不出轮次，而这条断言用真形状（从那一版正文现算）把它钉住。
  const realHash = await fixtureSql`
    SELECT content_hash FROM note_versions WHERE id = ${versionA}
  `;
  const admissible = String(realHash[0].content_hash);
  assert.equal(admissible.length >= 8, true, `夹具那一版的哈希本身不该短于判据下界：${admissible}`);
  await insertRound(apiSql, {
    ...me(), noteId: noteE, noteVersionId: versionE, sourceContentHash: admissible,
    drivingQuestion: "用真实形状的那一份哈希开一轮",
  });
  await insertRound(apiSql, {
    ...me(), noteId: noteF, noteVersionId: versionF, sourceContentHash: "a".repeat(64),
    drivingQuestion: "将来换成 sha256 那种 64 位也收（判据拦的是没有哈希，不是某一种算法）",
  });

  // `evidence_snapshot_ids` 默认 '{}'：没有摘录是合法形状（这一轮只引用了版本与哈希），
  // 但列本身 NOT NULL——读侧要能区分"没用摘录"与"没这一列"。
  const id = await insertRound(apiSql, {
    ...me(), noteId: noteC, noteVersionId: versionC, drivingQuestion: "第三种问法",
  });
  assert.match(id, /^[0-9a-f-]{36}$/);
  // D1 §6.4（不内联副本）与 §6.7（不存聚合结论）在列上的直接体现：这些名字根本不存在。
  // `.map` 不是多余：postgres.js 的返回是 Array 的子类，`deepEqual` 严格模式比构造器。
  const names = (await fixtureSql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'note_learning_rounds'
      AND column_name IN ('content', 'body', 'plan', 'driving_question_snapshot',
                          'mastery', 'brightness', 'coverage_percent', 'open_gaps')
  `).map((row) => row.column_name);
  assert.deepEqual(names, [], "轮次不许内联正文副本，也不许长出掌握度/亮度/覆盖百分比那一类字段");
});

test("归属三件套与那份快照引用不可改写；普通字段照写", async () => {
  const rows = await runAs(apiSql, me(), (tx) => tx`
    SELECT id FROM note_learning_rounds WHERE note_id = ${noteA} AND phase = 'active'
  `);
  const target = String(rows[0].id);

  for (const [column, type] of [
    ["note_id", "uuid"],
    ["user_id", "uuid"],
    ["workspace_id", "uuid"],
    ["note_version_id", "uuid"],
    ["source_content_hash", "text"],
  ] as const) {
    const value = type === "text" ? "b".repeat(64) : randomUUID();
    await expectDbError("P0001", () => (
      runAs(apiSql, me(), (tx) => tx.unsafe(
        `UPDATE note_learning_rounds SET ${column} = '${value}'::${type} WHERE id = '${target}'`,
      ))
    ), `改写 ${column}`);
  }
  // 同一行普通字段还能写：证明上一段挡的是"身份"，不是整张表写不进去。
  await runAs(apiSql, me(), (tx) => tx`
    UPDATE note_learning_rounds
       SET driving_question = '判断为什么有索引，查询仍然可能慢。', revision = revision + 1
     WHERE id = ${target}
  `);
});

test("revision 只许前进（CAS 的 DB 那一半）", async () => {
  const rows = await runAs(apiSql, me(), (tx) => tx`
    SELECT id, revision FROM note_learning_rounds WHERE note_id = ${noteA} AND phase = 'active'
  `);
  const first = rows[0];
  for (const [label, value] of [["同值", first.revision], ["倒退", first.revision - 1]] as const) {
    await expectDbError("P0001", () => (
      runAs(apiSql, me(), (tx) => tx.unsafe(
        `UPDATE note_learning_rounds SET revision = ${value} WHERE id = '${first.id}'`,
      ))
    ), `把 revision 写成${label}`);
  }
  await runAs(apiSql, me(), (tx) => tx.unsafe(
    `UPDATE note_learning_rounds SET revision = ${first.revision + 1} WHERE id = '${first.id}'`,
  ));
});

test("RLS：同空间另一人读不到我的轮次，也冒充不了我", async () => {
  // 阳性对照：我自己读得到。少了这一步，"0 行"可以是任何原因的 0 行。
  assert.ok(await openRoundCount(noteA) >= 1, "夹具没能在受限角色下写出轮次");
  const asPeer = await runAs(apiSql, { workspaceId, userId: peerUserId }, (tx) => tx`
    SELECT count(*)::int AS n FROM note_learning_rounds WHERE workspace_id = ${workspaceId}
  `);
  assert.equal(Number(asPeer[0].n), 0, "同空间另一人必须一行都读不到");

  // 这一发要表达的错位是：**GUC 是他，行里写的 user_id 是我**。`insertRound` 把两者
  // 绑在一起（ ctx 从行取），表达不出这个错位，所以这里直接写 INSERT。
  await expectDbError("42501", () => (
    runAs(apiSql, { workspaceId, userId: peerUserId }, (tx) => tx`
      INSERT INTO note_learning_rounds (
        workspace_id, user_id, note_id, note_version_id,
        driving_question, driving_question_source, source_content_hash,
        max_model_calls, max_wall_clock_seconds, max_tasks
      ) VALUES (
        ${workspaceId}, ${userId}, ${noteC}, ${versionC},
        '冒充别人的那一行', 'suggested', ${HASH_A}, 6, 600, 4
      )
    `)
  ), "用另一人的上下文却想把 user_id 写成我（RLS 的 WITH CHECK，实测 42501 而不是 23514）");
});

/**
 * 这一条钉的是**产品读法**，不是漏洞：PRD §3.2 的原话是"同一用户在同一工作区、
 * 同一笔记默认只有一个进行中或暂停的笔记旅程"——名额按**人**算。§14.4 又给了只读成员
 * "个人适用路线"，所以同一个共享空间里两个人各自在这一篇上开一轮是设计，
 * 那条部分唯一索引也确实是按 `(workspace_id, user_id, note_id)` 建的。
 * 把它记成断言，是为了防止下一轮有人把它当 bug "收紧"成按笔记全局唯一。
 */
test("未完成名额按人算，不按笔记全局算（§3.2 的原话是「同一用户」）", async () => {
  const peerCtx = { workspaceId, userId: peerUserId };
  await insertRound(apiSql, {
    ...me(), noteId: noteD, noteVersionId: versionD, drivingQuestion: "我这一轮的问题",
  });
  await insertRound(apiSql, {
    ...peerCtx, noteId: noteD, noteVersionId: versionD, drivingQuestion: "他那一轮的问题",
  });
  // 计数走夹具那条连接：`openRoundCount` 是以"我"的身份读的，RLS 会把他那一条藏掉
  // （上一条用例钉的正是这件事），在这里读到的 1 不是"名额按人算"的反证。
  const both = await fixtureSql`
    SELECT count(*)::int AS n FROM note_learning_rounds
    WHERE note_id = ${noteD} AND phase IN ('active','paused')
  `;
  assert.equal(Number(both[0].n), 2, "两个人在同一篇上各有一条未完成轮次");
  // 但各自再开第二条仍然被挡——名额是按人一份，不是没有名额。
  await expectDbError("23505", () => (
    insertRound(apiSql, { ...peerCtx, noteId: noteD, noteVersionId: versionD, drivingQuestion: "他的第二条" })
  ), "同一人的第二条");
});

test("跨空间读不到；worker 一侧一句 GRANT 都没给", async () => {
  const rows = await runAs(apiSql, { workspaceId: peerWorkspaceId, userId: peerWorkspace!.userId }, (tx) => tx`
    SELECT count(*)::int AS n FROM note_learning_rounds
  `);
  assert.equal(Number(rows[0].n), 0, "另一个空间的上下文必须一行都读不到");

  let caught: unknown = null;
  try {
    await workerSql`SELECT count(*)::int AS n FROM note_learning_rounds`;
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "worker 读得到这张表——D1 §6.5 那句「不给 worker 开跨租户读」没落地");
  assert.equal((caught as { code?: string }).code, "42501", "应该是 permission denied，而不是 0 行");
});
