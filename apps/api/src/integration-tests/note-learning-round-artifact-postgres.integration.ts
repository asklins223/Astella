/**
 * 轮次的动态产物：真 HTTP ＋真库（39d W4-6 刀五；表 0285）。
 *
 * 这一份钉刀五的六条：生成那一发连带落产物行并把 id 回写到教学行上、按 id 取整份是
 * **字节原样**（不套 JSON 信封）、`regenerate` 后两条教学各留自己的产物行（只追加、
 * 旧产物仍读得到）、跨用户不可见（HTTP 404 ＋ 别人 GUC 下库级 0 行）、只追加由触发器
 * 兜底（含 `app.allow_history_mutation` 绕行口子真能删的对照）、以及确定性
 * （同输入两次生成的 HTML 逐字节相同）。
 *
 * 为什么必须真 HTTP：这一层有三件事只存在于路由上——**产物 id 是服务端在写教学行那一刻
 * 生成的**（请求体里没有这一格）、**取整份不套信封**（消费方是桌面主进程，要字节原样落盘）、
 * **失败策略是"教学照常成功"**（这一点由"生成后产物行恰好 1 条"那条正向用例守着）。
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
import { roundTeachingViewV1Schema } from "@ailearn/shared/note-learning-round-contracts";
import {
  appendPlanRevision,
  createTeaching,
  readRoundArtifactHtml,
} from "../modules/note-learning-rounds/round-service.ts";
import { seedNotesOnlyWorkspace, type NotesOnlyWorkspaceFixture } from "./helpers/pure-v2-workspace-fixture.ts";

const fixtureUrl = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!fixtureUrl || !process.env.DATABASE_URL_API) {
  throw new Error("动态产物集测需要 DATABASE_URL_MIGRATOR（夹具）＋DATABASE_URL_API（受限角色，路由跑在它上面）");
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

/** 双口径清理：产物行与教学行都是只追加（触发器连超户也拦），绕行口子只对维护路径开。 */
async function wipeRounds(wsId: string): Promise<void> {
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.allow_history_mutation', 'on', true)`;
    await tx`DELETE FROM note_learning_round_teachings WHERE workspace_id = ${wsId}`;
    await tx`DELETE FROM note_learning_round_plan_revisions WHERE workspace_id = ${wsId}`;
    await tx`DELETE FROM note_learning_round_artifacts WHERE workspace_id = ${wsId}`;
    await tx`DELETE FROM note_learning_rounds WHERE workspace_id = ${wsId}`;
  });
}

before(async () => {
  seeded = await seedNotesOnlyWorkspace(fixtureSql, { noteCount: 1 });
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
    // 两个小节、各带一段正文与一句"例如/比如"：确定性 provider 的取材是"从材料里取"，
    // 产物要上屏的东西（解释＋例子＋计划步骤）都从这一份材料来。
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
  await fixtureSql`UPDATE note_versions v SET content_json = jsonb_build_object('blocks',
    (SELECT jsonb_agg(jsonb_build_object('type', b.type, 'content', b.content) ORDER BY b.ordinal)
     FROM note_blocks b WHERE b.version_id = v.id))
    WHERE v.workspace_id = ${workspaceId} AND EXISTS (SELECT 1 FROM note_blocks b WHERE b.version_id = v.id)`;
  app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(authRoutes);
  await app.register(noteLearningRoundRoutes, { teaching: {
    provider: deterministicTeachingExplainProviderV1(), modelId: "offline-test", external: false,
  } });
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
  if (peerUserId !== "") {
    await fixtureSql`DELETE FROM workspace_members WHERE user_id = ${peerUserId}`;
    await fixtureSql`DELETE FROM users WHERE id = ${peerUserId}`;
  }
  await app?.close();
  await fixtureSql.end();
  await closeDatabase();
});

/** 开一轮（回读整份过线上合同：合同漂移要红在这里）。 */
async function createRound(question: string): Promise<Record<string, unknown>> {
  const res = await call("POST", "/v2/note-learning-rounds", {
    noteId: noteA,
    drivingQuestion: question,
    drivingQuestionSource: "suggested",
  });
  assert.equal(res.statusCode, 201, `开一轮应当成功：${res.statusCode} ${res.body}`);
  return body(res).round as Record<string, unknown>;
}

async function generateTeaching(
  roundId: string,
  expectedRevision: number,
  payload: Record<string, unknown> = {},
  bearer = token,
) {
  return call("POST", `/v2/note-learning-rounds/${roundId}/teaching`, { expectedRevision, ...payload }, bearer);
}

function parseView(res: { statusCode: number; body: string }) {
  assert.ok(res.statusCode === 200 || res.statusCode === 201, `回信应当是 200/201：${res.statusCode} ${res.body}`);
  return roundTeachingViewV1Schema.parse(JSON.parse(res.body));
}

async function artifactRows(roundId: string): Promise<Array<Record<string, unknown>>> {
  return fixtureSql`SELECT * FROM note_learning_round_artifacts WHERE round_id = ${roundId} ORDER BY created_at, id`;
}

async function teachingRows(roundId: string): Promise<Array<Record<string, unknown>>> {
  return fixtureSql`SELECT * FROM note_learning_round_teachings WHERE round_id = ${roundId} ORDER BY ordinal`;
}

test("生成那一发：产物行恰好 1 条、teaching.artifact_id 指向它，计划步骤也进了画面", async () => {
  const round = await createRound("先弄懂「提取练习」这一节在讲什么");
  // 追加一版计划（生产写路径；今天只有服务层入口）：那几条步骤要能出现在产物里。
  const planned = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    appendPlanRevision(tx, { workspaceId, userId }, {
      roundId: round.roundId as string,
      expectedRevision: round.revision as number,
      plan: { version: 1, steps: [{ text: "先看小节标题" }, { text: "再读第一段的例子" }] },
      reason: "集测：把计划步骤喂进动态产物",
    }));

  const res = await generateTeaching(round.roundId as string, planned.roundRevision);
  assert.equal(res.statusCode, 201, res.body);
  const view = parseView(res);
  assert.ok(view.artifact, "这一屏应当带上动态版本引用（不是 null）");
  assert.equal(view.artifact.kind, "dynamic_explanation");

  const artifacts = await artifactRows(round.roundId as string);
  assert.equal(artifacts.length, 1, "一次生成恰好落一条产物行");
  const teachings = await teachingRows(round.roundId as string);
  assert.equal(teachings.length, 1);
  assert.equal(String(teachings[0]?.artifact_id), String(artifacts[0]?.id), "教学行指回它自己那份产物");
  assert.equal(view.artifact.artifactId, String(artifacts[0]?.id));
  assert.equal(String(artifacts[0]?.kind), "dynamic_explanation");
  assert.equal(String(artifacts[0]?.snapshot_hash), "fixture-hash");
  // 两行同属这一发：产物行与教学行用的是同一个 `now`。
  assert.equal(
    new Date(String(artifacts[0]?.created_at)).getTime(),
    new Date(String(teachings[0]?.created_at)).getTime(),
  );

  const html = String(artifacts[0]?.html);
  assert.match(html, /提取练习是先想再查/);
  assert.match(html, /先看小节标题/);
  assert.equal(/<script/i.test(html), false, "产物里不许出现脚本");
  // 屏数与输入对应：讲解 ＋ 例子 ＋ 2 条计划步骤。
  assert.equal((html.match(/class="ailearn-artifact-pane"/g) ?? []).length, 4);
});

test("按 id 取整份：200 ＋ text/html ＋ 与库内逐字节相同（不套 JSON 信封）", async () => {
  const round = await createRound("先弄懂「提取练习」这一节在讲什么");
  const view = parseView(await generateTeaching(round.roundId as string, round.revision as number));
  const artifactId = view.artifact?.artifactId as string;

  const res = await call("GET", `/v2/note-learning-round-artifacts/${artifactId}`);
  assert.equal(res.statusCode, 200, res.body);
  assert.match(String(res.headers["content-type"]), /^text\/html;\s*charset=utf-8$/i);
  const rows = await artifactRows(round.roundId as string);
  assert.ok(res.rawPayload.equals(Buffer.from(String(rows[0]?.html), "utf8")), "正文必须与库内逐字节相同");
  // 不套信封：第一段就是产物本身，而不是 `{"data": …}` 之类。
  assert.match(res.rawPayload.toString("utf8"), /^<section class="ailearn-artifact-pane"/);

  // 不存在的 id ⇒ 404；不是 uuid ⇒ 400（错误映射照该文件既有写法）。
  const missing = await call("GET", `/v2/note-learning-round-artifacts/${randomUUID()}`);
  assert.equal(missing.statusCode, 404, missing.body);
  assert.equal(body(missing).error, "artifact_not_found");
  const malformed = await call("GET", "/v2/note-learning-round-artifacts/not-a-uuid");
  assert.equal(malformed.statusCode, 400, malformed.body);
});

test("§16.14 回看：关卷之后取到的仍是当时那一份产物字节，且回看一个字都不写", async () => {
  const round = await createRound("先弄懂「提取练习」这一节在讲什么");
  const view = parseView(await generateTeaching(round.roundId as string, round.revision as number));
  const artifactId = view.artifact?.artifactId as string;
  const fetchBefore = await call("GET", `/v2/note-learning-round-artifacts/${artifactId}`);
  assert.equal(fetchBefore.statusCode, 200, fetchBefore.body);

  const closed = await call("PATCH", `/v2/note-learning-rounds/${round.roundId as string}`, {
    expectedRevision: round.revision as number,
    action: { kind: "close", outcome: "completed" },
  });
  assert.equal(closed.statusCode, 200, closed.body);

  // 关卷之后的那份"当时状态"：行数、内容、轮次行本身，全部以此刻为基准。
  const artifactsBefore = await artifactRows(round.roundId as string);
  const teachingsBefore = await teachingRows(round.roundId as string);
  const rowBefore = await fixtureSql`
    SELECT phase, revision, updated_at FROM note_learning_rounds WHERE id = ${round.roundId as string}`;
  const roundsForNoteBefore = await fixtureSql`
    SELECT count(*)::int AS n FROM note_learning_rounds WHERE note_id = ${round.noteId as string}`;

  // ① 回看取到的必须**还是当时那一份**：引用不换、字节不差。
  //    这一条防的是"历史不重新生成动画冒充当时内容"——重新生成会产出一行新产物，
  //    字节也可能因输入漂移而变，两种都会在这里红。
  const afterView = parseView(await call("GET", `/v2/note-learning-rounds/${round.roundId as string}/teaching`));
  assert.equal(afterView.artifact?.artifactId, artifactId,
    "关卷后回看换了一份产物 ⇒ 那是重新生成，不是回放当时那一份");
  const fetchAfter = await call("GET", `/v2/note-learning-round-artifacts/${artifactId}`);
  assert.equal(fetchAfter.statusCode, 200, fetchAfter.body);
  assert.ok(fetchAfter.rawPayload.equals(fetchBefore.rawPayload), "同一 id 两次取回不一致");

  // ② 回看不许写：两张产物/教学表一字未动，轮次行也不动（回看不推进计数器、不改时刻）。
  assert.deepEqual(await artifactRows(round.roundId as string), artifactsBefore, "回看写动了产物表");
  assert.deepEqual(await teachingRows(round.roundId as string), teachingsBefore, "回看写动了教学表");
  assert.deepEqual(
    await fixtureSql`SELECT phase, revision, updated_at FROM note_learning_rounds WHERE id = ${round.roundId as string}`,
    rowBefore,
    "回看改写了轮次行（phase/revision/updated_at 有一个动了）⇒ 回看变成了第二次结算",
  );
  // ③ 也不许多出一轮：回看不是"再练一次"。
  assert.deepEqual(
    await fixtureSql`SELECT count(*)::int AS n FROM note_learning_rounds WHERE note_id = ${round.noteId as string}`,
    roundsForNoteBefore,
    "回看之后这一篇的轮次数变了",
  );
});

test("regenerate：两条教学各留自己的产物行（只追加），旧的那份仍然读得到", async () => {
  const round = await createRound("先弄懂「提取练习」这一节在讲什么");
  const first = parseView(await generateTeaching(round.roundId as string, round.revision as number));
  const second = parseView(
    await generateTeaching(round.roundId as string, round.revision as number, { regenerate: true }),
  );
  assert.equal(second.teaching?.ordinal, 2);
  assert.notEqual(second.artifact?.artifactId, first.artifact?.artifactId);

  const artifacts = await artifactRows(round.roundId as string);
  assert.equal(artifacts.length, 2, "换解释也要有自己的产物行（同一轮可以有多份动态版本）");
  const teachings = await teachingRows(round.roundId as string);
  assert.deepEqual(
    teachings.map((row) => String(row.artifact_id)),
    [String(first.artifact?.artifactId), String(second.artifact?.artifactId)],
    "每条教学行指回自己的那一份",
  );

  // 历史回放：旧那份仍按 id 读得到（只追加的表里没有人把它覆盖掉）。
  const oldRes = await call("GET", `/v2/note-learning-round-artifacts/${first.artifact?.artifactId as string}`);
  assert.equal(oldRes.statusCode, 200, oldRes.body);
  assert.ok(oldRes.rawPayload.length > 0);
});

test("跨用户不可见：GET 404，且别人 GUC 下库级 0 行（正向对照：本人读得到）", async () => {
  const round = await createRound("先弄懂「提取练习」这一节在讲什么");
  const view = parseView(await generateTeaching(round.roundId as string, round.revision as number));
  const artifactId = view.artifact?.artifactId as string;

  const peerToken = (await issueSession(peerUserId, workspaceId)).token;
  const peer = await call("GET", `/v2/note-learning-round-artifacts/${artifactId}`, undefined, peerToken);
  assert.equal(peer.statusCode, 404, peer.body);

  // 库级那一半：受限角色 ＋ **另一个人的会话上下文** ⇒ 读不到（策略是 (workspace_id, user_id) 两列）。
  // 这一条守的是"带对了上下文"（摘掉 set_config 它会红），不是"写了过滤"。
  const peerScope = { workspaceId, userId: peerUserId };
  const seen = await withWorkspaceTransaction(peerScope, (tx) => readRoundArtifactHtml(tx, peerScope, artifactId));
  assert.equal(seen, null, "另一个人的 GUC 下这一行读不到");
  const own = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    readRoundArtifactHtml(tx, { workspaceId, userId }, artifactId));
  assert.ok(own && own.length > 0, "正向对照：本人读得到（上一条 null 不是『表里本来就没有』）");
});

test("只追加是 DB 层的：受限角色与超户都被触发器拒；绕行口子只对显式维护路径开放", async () => {
  const round = await createRound("先弄懂「提取练习」这一节在讲什么");
  const view = parseView(await generateTeaching(round.roundId as string, round.revision as number));
  const artifactId = view.artifact?.artifactId as string;

  // ① 受限角色（路由与被测服务跑的那一个）：改与删都拒绝，且拒绝来自**触发器**——
  //    0283 那一刀在这里踩过：dev 库没重跑 roles 时挡下来的是"permission denied"，
  //    读起来像隔离生效，其实换到 CI（roles 在迁移后跑）就是另一条路。沿 cause 链找那一句话。
  await assert.rejects(
    () => withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
      await tx.execute(sql`UPDATE note_learning_round_artifacts SET kind = 'dynamic_explanation' WHERE id = ${artifactId}`);
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
      await tx.execute(sql`DELETE FROM note_learning_round_artifacts WHERE id = ${artifactId}`);
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

  // ② 超户也拦（触发器对超户一样触发）。
  await assert.rejects(
    fixtureSql`UPDATE note_learning_round_artifacts SET kind = 'dynamic_explanation' WHERE id = ${artifactId}`,
    /append-only/,
  );

  // ③ 对照：带绕行口子，维护路径真的删得掉。顺序是先删引用的教学行——
  //    `artifact_id` 那条外键是 NO ACTION（在语句末尾核），先删产物会在半路被它挡下。
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.allow_history_mutation', 'on', true)`;
    const deletedTeachings = await tx`DELETE FROM note_learning_round_teachings WHERE round_id = ${round.roundId as string} RETURNING ordinal`;
    assert.equal(deletedTeachings.length, 1, "绕行口子下教学行应当真的删掉");
    const deleted = await tx`DELETE FROM note_learning_round_artifacts WHERE id = ${artifactId} RETURNING round_id`;
    assert.equal(deleted.length, 1, "绕行口子下这一次删除必须真的删掉（BEFORE DELETE 里返回 NULL 的旧写法会静默删 0 行）");
  });
});

test("动态失败不冒充教学失败：产物那一半失败 ⇒ 教学行照写、artifact_id 留空、原因进日志口子", async () => {
  const round = await createRound("先弄懂「提取练习」这一节在讲什么");
  const failures: string[] = [];

  // 走的是生产写路径（`createTeaching`），只把"产物输入"换成一个生成不出东西的：
  // 生成失败必须被圈在产物这一半里——教学行照写、请求照常成功（D4 §6.2）。
  const teaching = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    createTeaching(
      tx,
      { workspaceId, userId },
      {
        roundId: round.roundId as string,
        expectedRevision: round.revision as number,
        kind: "explanation",
        content: { explanation: "这一条解释照旧要落下来。" },
        sourceBlockOrdinals: [4],
        snapshotHash: "fixture-hash",
        drivingQuestionRevision: 1,
        kernelTaskRef: null,
        artifact: { explanation: "   ", planSteps: [" ", ""] },
      },
      { reportArtifactFailure: (message) => failures.push(message) },
    ));
  assert.equal(teaching.kind, "explanation");

  const teachings = await teachingRows(round.roundId as string);
  assert.equal(teachings.length, 1, "教学行照写（产物失败不许把它拖下水）");
  assert.equal(teachings[0]?.artifact_id, null, "artifact_id 留空 = 没有动态版本，不是失败");
  assert.equal((await artifactRows(round.roundId as string)).length, 0, "没有半份产物行");
  assert.equal(failures.length, 1, "失败原因进了日志口子");
  assert.match(failures[0] ?? "", /dynamic|empty|没有生成/);

  // 读侧那一格如实是 null（不是 500，也不是"读失败"）。
  const read = await call("GET", `/v2/note-learning-rounds/${round.roundId as string}/teaching`);
  assert.equal(read.statusCode, 200, read.body);
  const view = parseView(read);
  assert.ok(view.teaching);
  assert.equal(view.artifact, null);
});

test("确定性：同输入两次生成的 HTML 逐字节相同（收尾再开一轮、同一份输入）", async () => {
  const first = await createRound("先弄懂「提取练习」这一节在讲什么");
  const firstView = parseView(await generateTeaching(first.roundId as string, first.revision as number));
  const closed = await call("PATCH", `/v2/note-learning-rounds/${first.roundId as string}`, {
    expectedRevision: first.revision as number,
    action: { kind: "close", outcome: "completed" },
  });
  assert.equal(closed.statusCode, 200, closed.body);

  // 同一篇、同一份快照、同一句问题 ⇒ 同一份输入（没有计划步骤，两边都是空数组）。
  const second = await createRound("先弄懂「提取练习」这一节在讲什么");
  const secondView = parseView(await generateTeaching(second.roundId as string, second.revision as number));
  assert.notEqual(secondView.artifact?.artifactId, firstView.artifact?.artifactId, "两份产物是各自的行");

  const [a] = await artifactRows(first.roundId as string);
  const [b] = await artifactRows(second.roundId as string);
  assert.equal(String(a?.html), String(b?.html), "同输入两次生成必须逐字节相同（不许有时间戳/随机 id）");
  assert.equal(String(a?.snapshot_hash), String(b?.snapshot_hash));

  // 收尾之后旧产物仍读得到（历史回放不按 phase 设限）。
  const afterClose = await call("GET", `/v2/note-learning-round-artifacts/${firstView.artifact?.artifactId as string}`);
  assert.equal(afterClose.statusCode, 200, afterClose.body);
});
