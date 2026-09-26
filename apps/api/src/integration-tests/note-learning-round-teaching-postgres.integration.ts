/**
 * 轮次里的教学产物：真 HTTP ＋真库（39d W4-6 刀一）。
 *
 * 这一份钉的是 W4-6 刀一那六条判据（设计件 §2）：解释落库且只追加、同快照同问题重复请求
 * 返回同一条（不重付）、快照哈希变化后不复用、关卷后拒绝、预算缺额拒启动、跨用户不可见。
 *
 * 为什么必须真 HTTP：这一层有三件事只存在于路由上——**实际用哪一版正文由服务端定**
 * （请求体里没有版本这一格）、**幂等是"回 200 带回既有那条"而不是"再生成一次"**、
 * **失败分档（材料里没有可讲的 vs provider 没成）走两种状态码**。
 *
 * 角色分工照 doc 34 §1.2：夹具走 `DATABASE_URL_MIGRATOR`（超户），`issueSession` 发真令牌，
 * 请求经 `app.inject` 打到跑在 `DATABASE_URL_API`（受限角色）上的路由。
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { closeDatabase, withWorkspaceTransaction } from "../db/client.ts";
import {
  roundTeachingViewV1Schema,
  type RoundTeachingV1,
} from "@ailearn/shared/note-learning-round-contracts";
import { findReusableTeaching, listTeachings } from "../modules/note-learning-rounds/round-service.ts";
import { seedNotesOnlyWorkspace, type NotesOnlyWorkspaceFixture } from "./helpers/pure-v2-workspace-fixture.ts";

const fixtureUrl = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!fixtureUrl || !process.env.DATABASE_URL_API) {
  throw new Error("教学产物集测需要 DATABASE_URL_MIGRATOR（夹具）＋DATABASE_URL_API（受限角色，路由跑在它上面）");
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

/** 双口径清理：教学产物与计划行都是只追加（触发器连超户也拦），绕行口子只对维护路径开。 */
async function wipeRounds(wsId: string): Promise<void> {
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.allow_history_mutation', 'on', true)`;
    await tx`DELETE FROM note_learning_round_teachings WHERE workspace_id = ${wsId}`;
    await tx`DELETE FROM note_learning_round_plan_revisions WHERE workspace_id = ${wsId}`;
    await tx`DELETE FROM note_learning_rounds WHERE workspace_id = ${wsId}`;
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
    // 这一篇的正文块：两个小节，各带一段正文与一句"例如/比如"——确定性 provider 的
    // 取材是"从材料里取"，所以夹具必须真的有材料（空材料那一条单独造）。
    const blocks: Array<[number, string, string]> = [
      [1, "heading", "## 间隔重复"],
      [2, "paragraph", "**间隔重复**说的是在快要忘记的时候再见到它。"],
      [3, "paragraph", "例如把新词放在第 1、3、7 天各见一次。"],
      [4, "heading", "## 提取练习"],
      [5, "paragraph", "提取练习是**先想再查**：先自己试着说出来。"],
      [6, "paragraph", "比如合上书,把这一节讲给空气听一遍。"],
    ];
    for (const [ordinal, type, content] of blocks) {
      await tx`INSERT INTO note_blocks (id, version_id, workspace_id, ordinal, type, content)
        VALUES (${randomUUID()}, ${versionA}, ${workspaceId}, ${ordinal}, ${type}, ${content})`;
    }
  });
  app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(authRoutes);
  await app.register(noteLearningRoundRoutes);
  await app.ready();
  token = (await issueSession(userId, workspaceId)).token;
});

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

/** 开一轮（回读整份过线上合同：合同漂移要红在这里）。 */
async function createRound(question: string, noteId = noteA): Promise<Record<string, unknown>> {
  const res = await call("POST", "/v2/note-learning-rounds", {
    noteId,
    drivingQuestion: question,
    drivingQuestionSource: "suggested",
  });
  assert.equal(res.statusCode, 201, `开一轮应当成功：${res.statusCode} ${res.body}`);
  return body(res).round as Record<string, unknown>;
}

async function generateTeaching(roundId: string, expectedRevision: number, bearer = token) {
  return call("POST", `/v2/note-learning-rounds/${roundId}/teaching`, { expectedRevision }, bearer);
}

function parseView(res: { statusCode: number; body: string }) {
  assert.ok(res.statusCode === 200 || res.statusCode === 201, `回信应当是 200/201：${res.statusCode} ${res.body}`);
  return roundTeachingViewV1Schema.parse(JSON.parse(res.body));
}

async function teachingRows(roundId: string): Promise<Array<Record<string, unknown>>> {
  return fixtureSql`SELECT * FROM note_learning_round_teachings WHERE round_id = ${roundId} ORDER BY ordinal`;
}

test("生成那一发：解释取自问句点名的那一节，依据块与生成凭据都落库", async () => {
  const round = await createRound("先弄懂「提取练习」这一节在讲什么");
  const res = await generateTeaching(round.roundId as string, round.revision as number);
  assert.equal(res.statusCode, 201, res.body);
  const view = parseView(res);
  const teaching = view.teaching as RoundTeachingV1;
  assert.equal(teaching.kind, "explanation");
  assert.equal(teaching.ordinal, 1);
  assert.equal(
    teaching.content.explanation,
    "「提取练习」这一节说的是：提取练习是先想再查：先自己试着说出来。",
  );
  assert.equal(teaching.content.example, "比如合上书,把这一节讲给空气听一遍。");
  assert.deepEqual(teaching.sourceBlockOrdinals, [4, 5, 6]);
  // 生成不发生产品写入之外的副作用：轮次状态与 revision 都不动（教学产物不是"这一轮走到哪一步"）。
  assert.equal(view.round.revision, round.revision);

  const rows = await teachingRows(round.roundId as string);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.snapshot_hash, "fixture-hash");
  assert.equal(rows[0]?.driving_question_revision, 1);
  // 内核任务引用留痕（回放与审计用）：本刀是全仓第一个"走内核的 note_round 链"。
  assert.match(String(rows[0]?.kernel_task_ref ?? ""), /^note_teaching_explain_v1@v1/);
});

test("重复请求：同快照同问题回 200 与同一条（不重付），库里仍然只有一行", async () => {
  const round = await createRound("先弄懂「提取练习」这一节在讲什么");
  const first = await generateTeaching(round.roundId as string, round.revision as number);
  assert.equal(first.statusCode, 201, first.body);
  const firstView = parseView(first);

  const again = await generateTeaching(round.roundId as string, round.revision as number);
  assert.equal(again.statusCode, 200, `第二次应当是"回既有那条"：${again.statusCode} ${again.body}`);
  const againView = parseView(again);
  assert.equal(againView.teaching?.teachingId, firstView.teaching?.teachingId);
  assert.equal((await teachingRows(round.roundId as string)).length, 1);

  // GET 与生成读的是同一条（当前问题版本 + 当前快照）。
  const read = await call("GET", `/v2/note-learning-rounds/${round.roundId}/teaching`);
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(parseView(read).teaching?.teachingId, firstView.teaching?.teachingId);
});

test("改写问题之后：旧解释留着不删，新解释另起一条；未生成前 GET 如实回 null", async () => {
  const round = await createRound("先弄懂「提取练习」这一节在讲什么");
  const first = parseView(await generateTeaching(round.roundId as string, round.revision as number));

  const revised = await call("POST", `/v2/note-learning-rounds/${round.roundId}/driving-question`, {
    expectedRevision: round.revision as number,
    drivingQuestion: "先弄懂「间隔重复」这一节在讲什么",
    drivingQuestionSource: "user_rewritten",
  });
  assert.equal(revised.statusCode, 200, revised.body);
  const revisedRound = body(revised).round as Record<string, unknown>;

  // 问题换了、还没重新生成：GET 不许把上一版问题的解释摆在这一版问题下面。
  const beforeRegen = await call("GET", `/v2/note-learning-rounds/${round.roundId}/teaching`);
  assert.equal(beforeRegen.statusCode, 200, beforeRegen.body);
  assert.equal(parseView(beforeRegen).teaching, null);

  const second = parseView(await generateTeaching(round.roundId as string, revisedRound.revision as number));
  const secondTeaching = second.teaching as RoundTeachingV1;
  assert.equal(secondTeaching.ordinal, 2);
  assert.match(secondTeaching.content.explanation, /^「间隔重复」这一节说的是：/);

  const rows = await teachingRows(round.roundId as string);
  assert.deepEqual(rows.map((row) => row.ordinal), [1, 2]);
  assert.equal(String(rows[0]?.id), first.teaching?.teachingId);
});

test("关卷之后：不再生成（409 round_closed），读还是能读", async () => {
  const round = await createRound("先弄懂「提取练习」这一节在讲什么");
  const teaching = parseView(await generateTeaching(round.roundId as string, round.revision as number));
  const closed = await call("PATCH", `/v2/note-learning-rounds/${round.roundId}`, {
    expectedRevision: round.revision as number,
    action: { kind: "close", outcome: "partial" },
  });
  assert.equal(closed.statusCode, 200, closed.body);
  const closedRound = body(closed).round as Record<string, unknown>;

  const refused = await generateTeaching(round.roundId as string, closedRound.revision as number);
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(body(refused).error, "round_closed");
  assert.equal((await teachingRows(round.roundId as string)).length, 1);

  const read = await call("GET", `/v2/note-learning-rounds/${round.roundId}/teaching`);
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(parseView(read).teaching?.teachingId, teaching.teaching?.teachingId);
});

test("stale_revision：拿旧版来生成被拒，库里没有多出来的行", async () => {
  const round = await createRound("先弄懂「提取练习」这一节在讲什么");
  const stale = await generateTeaching(round.roundId as string, (round.revision as number) + 1);
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(body(stale).error, "stale_revision");
  assert.equal((await teachingRows(round.roundId as string)).length, 0);
});

test("跨用户不可见：别人的轮次生成/读取都 404，库里那一条对另一个会话也读不到", async () => {
  const round = await createRound("先弄懂「提取练习」这一节在讲什么");
  const teaching = parseView(await generateTeaching(round.roundId as string, round.revision as number));
  const peerToken = (await issueSession(peerUserId, workspaceId)).token;

  const peerPost = await generateTeaching(round.roundId as string, round.revision as number, peerToken);
  assert.equal(peerPost.statusCode, 404, peerPost.body);
  const peerGet = await call("GET", `/v2/note-learning-rounds/${round.roundId}/teaching`, undefined, peerToken);
  assert.equal(peerGet.statusCode, 404, peerGet.body);

  // 库级那一半：受限角色 + **另一个人的会话上下文** => 零行（策略是 (workspace_id, user_id) 两列）。
  // 这一条守的是"带对了上下文"（摘掉 set_config 它会红），不是"写了过滤"。
  const peerScope = { workspaceId, userId: peerUserId };
  const seen = await withWorkspaceTransaction(peerScope, (tx) => listTeachings(tx, peerScope, round.roundId as string));
  assert.deepEqual(seen, []);
  const own = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    listTeachings(tx, { workspaceId, userId }, round.roundId as string));
  assert.equal(own.length, 1, "正向对照：本人读得到（上一条零行不是『表里本来就没有』）");
  assert.equal(own[0]?.teachingId, teaching.teaching?.teachingId);
});

test("预算缺额拒启动：这一轮的模型调用预算是 0 时不生成，也不落空行", async () => {
  process.env.NOTE_ROUND_MAX_MODEL_CALLS = "0";
  try {
    const round = await createRound("先弄懂「提取练习」这一节在讲什么");
    assert.equal((round.budgets as { maxModelCalls: number }).maxModelCalls, 0);
    const refused = await generateTeaching(round.roundId as string, round.revision as number);
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(body(refused).error, "round_budget_exhausted");
    // 话术是 §6.2 那一档：不说成"学习失败"，说"已经拿到的内容不受影响"。
    assert.match(String(body(refused).message), /已经拿到的内容不受影响/);
    assert.equal((await teachingRows(round.roundId as string)).length, 0);
  } finally {
    delete process.env.NOTE_ROUND_MAX_MODEL_CALLS;
  }
});

test("只追加是 DB 层的：受限角色与超户都被触发器拒；绕行口子只对显式维护路径开放", async () => {
  const round = await createRound("先弄懂「提取练习」这一节在讲什么");
  const teaching = parseView(await generateTeaching(round.roundId as string, round.revision as number));
  const teachingId = teaching.teaching?.teachingId as string;

  // ① 受限角色（路由与被测服务跑的那一个）：改与删都拒绝，且拒绝来自**触发器**——
  //    0283 那一刀在这里踩过：dev 库没重跑 roles 时挡下来的是"permission denied"，
  //    读起来像隔离生效，其实换到 CI（roles 在迁移后跑）就是另一条路。沿 cause 链找那一句话。
  await assert.rejects(
    () => withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
      await tx.execute(sql`UPDATE note_learning_round_teachings SET kind = 'explanation' WHERE round_id = ${round.roundId as string}`);
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
  await assert.rejects(
    () => withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
      await tx.execute(sql`DELETE FROM note_learning_round_teachings WHERE round_id = ${round.roundId as string}`);
    }),
    (error: unknown) => {
      const chain: string[] = [];
      let e: unknown = error;
      while (e instanceof Error && chain.length < 6) {
        chain.push(e.message);
        e = (e as { cause?: unknown }).cause;
      }
      assert.match(chain.join(" | "), /append-only: DELETE is not allowed/, chain.join(" | "));
      return true;
    },
  );

  // ② 超户也拦（触发器对超户一样触发）；对照：带绕行口子才删得掉。
  await assert.rejects(
    fixtureSql`UPDATE note_learning_round_teachings SET kind = 'explanation' WHERE id = ${teachingId}`,
    /append-only/,
  );
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.allow_history_mutation', 'on', true)`;
    const deleted = await tx`DELETE FROM note_learning_round_teachings WHERE id = ${teachingId} RETURNING ordinal`;
    assert.equal(deleted.length, 1, "绕行口子下这一次删除必须真的删掉（BEFORE DELETE 里返回 NULL 的旧写法会静默删 0 行）");
  });
});

test("快照换了就不复用：同轮次同问题、不同快照哈希 ⇒ 复用判据返回 null，新一轮自己生成一条", async () => {
  const round = await createRound("先弄懂「提取练习」这一节在讲什么");
  const teaching = parseView(await generateTeaching(round.roundId as string, round.revision as number));

  // ① 服务层的复用键含快照哈希：换成另一个哈希就查不到那一条。
  const mismatched = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    findReusableTeaching(tx, { workspaceId, userId }, {
      roundId: round.roundId as string,
      kind: "explanation",
      drivingQuestionRevision: 1,
      snapshotHash: "ffffffffffffffffffffffffffffffff",
    }));
  assert.equal(mismatched, null);

  // ② 正文换了（新版本 + 新哈希）之后开的新一轮：不复用上一轮的产物，自己生成自己的。
  await fixtureSql.begin(async (tx) => {
    const versionId = randomUUID();
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${versionId}, ${noteB}, ${workspaceId}, 2, ${tx.json({ blocks: [] })}, 'changed-hash', ${userId})`;
    await tx`UPDATE notes SET current_version_id = ${versionId} WHERE id = ${noteB}`;
    await tx`INSERT INTO note_blocks (id, version_id, workspace_id, ordinal, type, content)
      VALUES (${randomUUID()}, ${versionId}, ${workspaceId}, 1, 'paragraph', '换了正文之后这一段才是材料。')`;
  });
  const secondRound = await createRound("这一篇在说什么", noteB);
  assert.equal(secondRound.sourceContentHash, "changed-hash");
  const secondView = parseView(await generateTeaching(secondRound.roundId as string, secondRound.revision as number));
  const secondTeaching = secondView.teaching as RoundTeachingV1;
  assert.equal(secondTeaching.ordinal, 1, "新轮次的第一条，不是复用上一轮那条");
  assert.notEqual(secondTeaching.teachingId, teaching.teaching?.teachingId);
  assert.equal(secondTeaching.content.explanation, "换了正文之后这一段才是材料。");
});
