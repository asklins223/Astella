/**
 * 「AI 动态演示」这一刀的真库集测（39d W4-1 尾；39 §6.1／§6.2／§6.3／§16.4；迁移 0304）。
 *
 * 为什么必须真 HTTP ＋真库：这一层有**三件**只在真路径上才存在的事，单测替不了。
 *
 *  1. **留痕真的落库**（§16.4 第一句）。`artifact-failure.ts` 早就写好了
 *     `recordArtifactFailureV1`，而"写了"与"落库了"是两件事——`stage`/`reason` 的组合要
 *     过 0304 那条 CHECK 才算落得下去。**0304 没应用的话，这一条会在 23514 上红**，
 *     而这正是它该红的样子（迁移与判据脱钩了）。
 *  2. **模型调用真的在事务外**。provider 是注进去的，所以它能读到
 *     `currentApiWorkspaceTransaction()`：只要那一格非 `undefined`，就是持着业务行锁在
 *     等模型（D5 §5.2 那条实测过的故障）。这条在真路径上是**可观测**的，单测里只能靠
 *     故意塞一个假作用域去撞内核那道闸。
 *  3. **`generator_ref` 与 `snapshot_hash` 真的在产物行上**（§6.3「保存实际使用版本／
 *     与本轮快照绑定」）。画面上那一行是给人看的，库里这一列才是事后按生成器分组用的。
 *
 * 角色分工照 doc 34 §1.2：夹具走 `DATABASE_URL_MIGRATOR`（超户），请求经 `app.inject`
 * 打到跑在 `DATABASE_URL_API`（**受限角色**）上的路由。四条 URL 不许全指超户——那会让
 * 这一族连带 RLS 一起假通过。
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { closeDatabase, withWorkspaceTransaction } from "../db/client.ts";
import {
  appendPlanRevision,
  createRound,
  readRoundArtifactHtml,
} from "../modules/note-learning-rounds/round-service.ts";
import { buildRoundReadingPlan } from "../modules/note-learning-rounds/learning-plan.ts";
import { roundBudgetsV1 } from "../modules/note-learning-rounds/round-budgets.ts";
import { seedNotesOnlyWorkspace, type NotesOnlyWorkspaceFixture } from "./helpers/pure-v2-workspace-fixture.ts";

const fixtureUrl = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!fixtureUrl || !process.env.DATABASE_URL_API) {
  throw new Error("动态产物生成集测需要 DATABASE_URL_MIGRATOR（夹具）＋DATABASE_URL_API（受限角色，路由跑在它上面）");
}
const fixtureSql = postgres(fixtureUrl, { max: 4 });

const { default: Fastify } = await import("fastify");
const { default: sensible } = await import("@fastify/sensible");
const { authRoutes } = await import("../modules/identity/routes.ts");
const { deterministicTeachingExplainProviderV1 } = await import("../modules/note-learning-rounds/teaching-explain.ts");
const { noteLearningRoundRoutes } = await import("../modules/note-learning-rounds/routes.ts");
const { issueSession } = await import("../modules/identity/service.ts");
const { currentApiWorkspaceTransaction } = await import("../db/client.ts");
const { DYNAMIC_ARTIFACT_GENERATOR_VERSION_V1 } = await import(
  "../modules/note-learning-rounds/round-artifact-render.ts"
);
const { ARTIFACT_ILLUSTRATION_NOTICE_V1 } = await import(
  "../modules/note-learning-rounds/round-artifact-measure.ts"
);

let seeded: NotesOnlyWorkspaceFixture | null = null;
let workspaceId = "";
let userId = "";
let versionA = "";
let noteA = "";
let peerUserId = "";
let token = "";
let peerToken = "";
let app: Awaited<ReturnType<typeof Fastify>>;

/** 注进去的 artifact provider 那一发：每次调用都记一笔，供断言用。 */
const calls: Array<{ activeTransaction: unknown; nodeCount: number }> = [];
let nextOutcome: (input: { nodes: readonly { title: string; text: string }[] }) => unknown = () => ({});

function recordingArtifactProvider() {
  return async (input: { nodes: readonly { title: string; text: string }[] }) => {
    calls.push({ activeTransaction: currentApiWorkspaceTransaction(), nodeCount: input.nodes.length });
    return { ok: true, output: nextOutcome(input) } as never;
  };
}

const body = (res: { body: string }): Record<string, unknown> => JSON.parse(res.body) as Record<string, unknown>;

async function call(method: "POST" | "GET", url: string, payload?: Record<string, unknown>, bearer = token) {
  return app.inject({
    method,
    url,
    ...(bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}),
    ...(payload ? { payload } : {}),
  });
}

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
    const blocks: Array<[number, string, string]> = [
      [1, "heading", "## 提取练习"],
      [2, "paragraph", "提取练习是**先想再查**：先自己试着说出来。"],
      [3, "paragraph", "比如合上书，把这一节讲给空气听一遍。"],
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
  await app.register(noteLearningRoundRoutes, {
    teaching: { provider: deterministicTeachingExplainProviderV1(), modelId: "offline-test", external: false },
    artifact: { provider: recordingArtifactProvider(), modelId: "offline-test" },
  });
  await app.ready();
  token = (await issueSession(userId, workspaceId)).token;
  peerToken = (await issueSession(peerUserId, workspaceId)).token;
});

after(async () => {
  await wipeRounds(workspaceId);
  await app.close();
  await closeDatabase();
  await fixtureSql.end({ timeout: 5 });
});

beforeEach(() => { calls.length = 0; });

/** 开一轮（短事务）并返回轮次视图。 */
async function openRound(): Promise<{ roundId: string; revision: number }> {
  const created = await withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    const round = await createRound(tx, { workspaceId, userId }, {
      noteId: noteA, noteVersionId: versionA, sourceContentHash: await readHash(),
      evidenceSnapshotIds: [], drivingQuestion: "先弄懂提取练习", drivingQuestionSource: "suggested",
      budgets: roundBudgetsV1(),
    });
    await appendPlanRevision(tx, { workspaceId, userId }, {
      roundId: round.roundId, expectedRevision: round.revision,
      plan: buildRoundReadingPlan("先弄懂提取练习", []), reason: "集测初始计划",
    });
    return round;
  });
  return { roundId: created.roundId, revision: await currentRevision(created.roundId) };
}

/** 这一轮现在的 revision（经 HTTP 读，与界面上看到的那一版同源）。 */
async function currentRevision(roundId: string): Promise<number> {
  const res = await call("GET", `/v2/note-learning-rounds/${roundId}/plans`);
  assert.equal(res.statusCode, 200, res.body);
  const view = body(res);
  return Number((view.round as { revision: number }).revision);
}

async function readHash(): Promise<string> {
  const rows = await fixtureSql`SELECT content_hash FROM note_versions WHERE id = ${versionA}`;
  const hash = rows[0]?.content_hash;
  assert.ok(hash, "夹具的 note_versions 上没有 content_hash");
  return hash;
}

async function generateTeaching(roundId: string, revision: number, regenerate = false) {
  return call("POST", `/v2/note-learning-rounds/${roundId}/teaching`, {
    expectedRevision: revision, regenerate,
  });
}

test("成功路径：模型分镜渲染出的整份 HTML 落进产物行，生成器版本与快照哈希都在", async () => {
  await wipeRounds(workspaceId);
  const { roundId, revision } = await openRound();
  nextOutcome = (input) => ({
    form: "flow",
    title: "提取练习三步",
    subject: "先想再查的做法",
    caution: "只按这一轮材料示意。",
    steps: input.nodes.map((node) => ({ narration: `这一步讲「${node.title}」。` })),
  });

  const res = await generateTeaching(roundId, revision);
  assert.equal(res.statusCode, 201, res.body);
  const view = body(res);
  const artifact = view.artifact as { artifactId: string; kind: string } | null;
  assert.ok(artifact, "这一发没有产物：模型分镜渲染成功却没落成产物行");
  assert.equal(artifact.kind, "dynamic_explanation");

  // 落库那一行：快照哈希与生成器版本（§6.3「保存实际使用版本」）
  const rows = await fixtureSql`
    SELECT a.snapshot_hash, a.generator_ref, a.kind, char_length(a.html) AS len, t.artifact_id
    FROM note_learning_round_artifacts a
    JOIN note_learning_round_teachings t ON t.artifact_id = a.id
    WHERE a.workspace_id = ${workspaceId} AND a.id = ${artifact.artifactId}`;
  const row = rows[0];
  assert.ok(row, "产物行读不到");
  assert.equal(row.generator_ref, `${DYNAMIC_ARTIFACT_GENERATOR_VERSION_V1} (offline-test)`,
    "generator_ref 没落库：事后没法按生成器分组，而画面上那一行不算数据面");
  assert.equal(row.kind, "dynamic_explanation");
  assert.equal(row.artifact_id, artifact.artifactId);
  const expectedHash = await readHash();
  assert.equal(row.snapshot_hash, expectedHash, "产物行没绑到这一轮冻结的那一版正文");
  // 存的是**渲染器**那份（有自己的舞台与播放器），不是确定性构建器那一份
  const html = await readRoundArtifactHtmlFor(artifact.artifactId);
  assert.match(html, /data-artifact-root/);
  assert.match(html, /window\.__artifact/);
  assert.match(html, new RegExp(ARTIFACT_ILLUSTRATION_NOTICE_V1.slice(0, 12)));
  assert.equal(/ailearn-artifact-pane/.test(html), false,
    "存进去的是确定性构建器那一份：模型生成的那一刀根本没生效");
});

test("模型调用真的在事务外：注进去的 provider 读到的活动事务是空的", async () => {
  await wipeRounds(workspaceId);
  const { roundId, revision } = await openRound();
  nextOutcome = (input) => ({
    form: "sequence", title: "t", subject: "s", caution: "c",
    steps: input.nodes.map((node) => ({ narration: `讲「${node.title}」。` })),
  });
  const res = await generateTeaching(roundId, revision);
  assert.equal(res.statusCode, 201, res.body);
  assert.ok(calls.length >= 1, "artifact provider 一次都没被调用");
  for (const call of calls) {
    assert.equal(call.activeTransaction, undefined,
      "artifact provider 被调用时有一个活动事务：那正是持业务行锁等模型（D5 §5.2）");
  }
  assert.ok(calls[0]!.nodeCount > 0, "provider 拿到的节点数是 0");
});

test("§16.4 生成失败真的落库：教学行照常成功、产物不给、失败原因事后读得到", async () => {
  await wipeRounds(workspaceId);
  const { roundId, revision } = await openRound();
  const res = await generateTeaching(roundId, revision);
  assert.equal(res.statusCode, 201, res.body);
  // 把这一条讲解的产物引用抹掉并插入一条 generate 失败留痕，走**生产写路径**
  // （`createTeaching` 的回传那一格）。
  const result = await withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    const scope = { workspaceId, userId };
    const round = await import("../modules/note-learning-rounds/round-service.ts");
    const view = await round.readRound(tx, scope, roundId);
    assert.ok(view);
    const teaching = await round.createTeaching(tx, scope, {
      roundId, expectedRevision: view.revision, kind: "explanation",
      content: { explanation: "先想再查。" },
      sourceBlockOrdinals: [2], snapshotHash: view.sourceContentHash,
      drivingQuestionRevision: view.drivingQuestionRevision,
      kernelTaskRef: "note_round_dynamic_artifact_v1@v1",
      // 一次真实的生成失败：回传给服务层，在教学行落库之后补记。
      artifactGenerationFailure: { reason: "model_failed", detail: "transport: connection reset" },
    }, { reportArtifactFailure: () => {} });
    return teaching;
  });

  // 教学行落了、artifact_id 留空（D4 §6.2：动态失败不冒充教学失败）
  const teachingRows = await fixtureSql`
    SELECT id, artifact_id FROM note_learning_round_teachings
    WHERE workspace_id = ${workspaceId} AND id = ${result.teachingId}`;
  assert.ok(teachingRows[0], "教学行没落库");
  assert.equal(teachingRows[0].artifact_id, null, "生成失败却给了产物：失败不冒充成功");

  // 失败留痕落库了，而且挂在**那一条讲解**上
  const failureRows = await fixtureSql`
    SELECT stage, reason, detail, teaching_id, snapshot_hash
    FROM note_learning_round_artifact_failures
    WHERE workspace_id = ${workspaceId} AND teaching_id = ${result.teachingId}
    ORDER BY created_at DESC`;
  const failure = failureRows[0];
  assert.ok(failure, "失败原因没有落库：只进 req.log 的话进程一重启就没了（§16.4 第一句）");
  assert.equal(failure.stage, "generate");
  assert.equal(failure.reason, "model_failed");
  assert.equal(failure.teaching_id, result.teachingId);
  assert.match(failure.detail, /connection reset/);
});

test("0304 真的拓宽了 CHECK：`contract_rejected` 这一档过得了 23514", async () => {
  await wipeRounds(workspaceId);
  const { roundId, revision } = await openRound();
  await generateTeaching(roundId, revision);
  const result = await withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    const round = await import("../modules/note-learning-rounds/round-service.ts");
    const scope = { workspaceId, userId };
    const view = await round.readRound(tx, scope, roundId);
    assert.ok(view);
    return round.createTeaching(tx, scope, {
      roundId, expectedRevision: view.revision, kind: "explanation",
      content: { explanation: "先想再查。" },
      sourceBlockOrdinals: [2], snapshotHash: view.sourceContentHash,
      drivingQuestionRevision: view.drivingQuestionRevision,
      kernelTaskRef: "note_round_dynamic_artifact_v1@v1:completion_unmet",
      artifactGenerationFailure: { reason: "contract_rejected", detail: "步数对不上" },
    }, { reportArtifactFailure: () => {} });
  });
  const rows = await fixtureSql`
    SELECT stage, reason FROM note_learning_round_artifact_failures
    WHERE workspace_id = ${workspaceId} AND teaching_id = ${result.teachingId}`;
  assert.deepEqual(rows.map((r) => [r.stage, r.reason]), [["generate", "contract_rejected"]]);
});

test("对照：库里的 CHECK 仍然**拒绝**两列各自合法而组合不存在的那一档", async () => {
  await assert.rejects(
    () => fixtureSql`
      INSERT INTO note_learning_round_artifact_failures
        (workspace_id, user_id, round_id, stage, reason, detail, snapshot_hash)
      SELECT workspace_id, user_id, id, 'generate', 'over_quota', 'x', 'hash-12345678'
      FROM note_learning_rounds WHERE workspace_id = ${workspaceId} LIMIT 1`,
    /nlraf_stage_reason_chk/,
    "库接受了 generate + over_quota：那一条路开着，「这是哪一类失败」就没意义了",
  );
});

test("读侧：整份 HTML 按 id 字节原样取回，别人（同一空间的另一个成员）取不到", async () => {
  await wipeRounds(workspaceId);
  const { roundId, revision } = await openRound();
  nextOutcome = (input) => ({
    form: "bars", title: "对比", subject: "s", caution: "c",
    steps: input.nodes.map((node) => ({ narration: `讲「${node.title}」。` })),
  });
  const view = body(await generateTeaching(roundId, revision));
  const artifactId = (view.artifact as { artifactId: string }).artifactId;

  const mine = await call("GET", `/v2/note-learning-round-artifacts/${artifactId}`);
  assert.equal(mine.statusCode, 200);
  assert.match(mine.body, /data-form="bars"/);
  assert.equal(typeof mine.body, "string", "取整份必须字节原样（桌面主进程要直接落盘）");

  // 另一个成员：路由 404
  const peer = await call("GET", `/v2/note-learning-round-artifacts/${artifactId}`, undefined, peerToken);
  assert.equal(peer.statusCode, 404);
});

test("§6.2 没配模型 ≠ 失败：那一档退回确定性产物，且**不留** generate 失败", async () => {
  await wipeRounds(workspaceId);
  const offline = Fastify({ logger: false });
  await offline.register(sensible);
  await offline.register(authRoutes);
  await offline.register(noteLearningRoundRoutes, {
    teaching: { provider: deterministicTeachingExplainProviderV1(), modelId: "offline-test", external: false },
    // 没配模型：这一发压根不该发出去
    artifact: { provider: recordingArtifactProvider(), modelId: "unconfigured" },
  });
  await offline.ready();

  const created = await withWorkspaceTransaction({ workspaceId, userId }, async (tx) => createRound(tx, { workspaceId, userId }, {
    noteId: noteA, noteVersionId: versionA, sourceContentHash: await readHash(),
    evidenceSnapshotIds: [], drivingQuestion: "先弄懂提取练习", drivingQuestionSource: "suggested",
    budgets: roundBudgetsV1(),
  }));
  const revision = await currentRevision(created.roundId);
  const res = await offline.inject({
    method: "POST", url: `/v2/note-learning-rounds/${created.roundId}/teaching`,
    headers: { authorization: `Bearer ${token}` }, payload: { expectedRevision: revision },
  });
  assert.equal(res.statusCode, 201, res.body);
  const out = body(res);
  const artifact = out.artifact as { artifactId: string } | null;
  assert.ok(artifact, "没配模型时这一条应当退回确定性产物，而不是没有动态版本");

  const rows = await fixtureSql`
    SELECT stage, reason FROM note_learning_round_artifact_failures
    WHERE workspace_id = ${workspaceId}`;
  // 比长度而不是 deepEqual：postgres.js 回的是 RowList（数组子类），比原型会平白地红。
  assert.equal(rows.length, 0,
    `没配模型却留下了 ${rows.length} 行 generate 失败：那是把「压根没请求过」说成了「请求了但失败」（§6.2）`);
  const artifactRows = await fixtureSql`
    SELECT generator_ref FROM note_learning_round_artifacts
    WHERE workspace_id = ${workspaceId} AND id = ${artifact.artifactId}`;
  assert.equal(artifactRows[0].generator_ref, "", "确定性那一支没有模型版本，不该编一个");
  await offline.close();
});

async function readRoundArtifactHtmlFor(artifactId: string): Promise<string> {
  const html = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    readRoundArtifactHtml(tx, { workspaceId, userId }, artifactId));
  assert.ok(html !== null, `产物 ${artifactId} 读不到：这一条用例后面全在查它`);
  return html;
}
