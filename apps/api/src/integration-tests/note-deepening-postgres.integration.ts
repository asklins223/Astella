/**
 * 星图三层展开的**真库读数**（39d W8-1、W8-3；39 §11.2、§11.4、§11.5、§16.12）。
 *
 * 单测钉的是形状（纯函数与源码形状），**它证明不了"读得对"**——那要真库。
 * 这一份在一次性 PostgreSQL 上跑，把三件事量出来：
 *
 *  1. **§11.2 五格真的读得到**：一条 locked 作答 → 原回答、反馈、日期、材料依据；
 *     挂一张卡 → 可选卡片那一格不再是 `null`。
 *  2. **§11.2 逐字「有正文的笔记无需制卡即可出现」**：那篇笔记**一张卡都没有**，
 *     但层二与层三照样读得出来。这一条是本份的**主目标**——单测里"把制卡当前提"
 *     的实现是绿的（它只在**渲染**时藏），只有真库能证明读侧照样把记录端出来。
 *  3. **§11.4 三轴分开**：跑出来的 `axes` 就是三个具名事实，且把记录条数放大十倍
 *     之后**三轴逐字不动**（数量不许改写任一轴）。
 *
 * 外加两条读侧的诚实性：**读不到就抛**（不是空的一份），**截断如实回报**。
 *
 * 跑法：一次性库（`bash scripts/dev-disposable-db.sh <名字>`），夹具走
 * `DATABASE_URL_MIGRATOR`，被测走 `DATABASE_URL_API`。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

/** postgres.js 的 `json()` 收的类型；照抄一份，免得把整个夹具退化成 `any`。 */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const fixtureUrl = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!fixtureUrl || !process.env.DATABASE_URL_API) {
  throw new Error("三层展开集测需要 DATABASE_URL_MIGRATOR（夹具）＋DATABASE_URL_API（被测）");
}
const fixtureSql = postgres(fixtureUrl, { max: 4 });
const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const service = await import("../modules/understanding-v3/note-deepening-service.ts");

const AUTHOR = randomUUID();
const WORKSPACE = randomUUID();
/** 零卡那篇：§11.2/§16.12 的主目标。 */
const BARE_NOTE = randomUUID();
const BARE_VERSION = randomUUID();
/** 有卡那篇：用来证明"可选卡片"那一格真的会被填上（正对照，不是必需条件）。 */
const CARDED_NOTE = randomUUID();
const CARDED_VERSION = randomUUID();

const BARE_OBJECTIVE = randomUUID();
const CARDED_OBJECTIVE = randomUUID();
const PREREQUISITE = randomUUID();
const EVIDENCE = randomUUID();
const CARD = randomUUID();

/**
 * 两条真判据的**承重夹具**：全部作答落在**同一天**，且这条目标**一条证据都没挂**。
 *
 * 为什么必须是同一天：「跨时间有重复证据」这一档问的是**跨日**。如果夹具本身
 * 就跨了两天，那么"记录条数也参与了跨日计数"这一个错误实现会**恰好蒙对**——
 * 条数从 1 涨到 10，跨日数从 2 涨到 11，两边都 ≥2，轴不动，判据空转。
 * 同一天这一支让"条数"与"天数"成为两个可分辨的量。
 *
 * 为什么一条证据都不挂：那样每条记录的 `materialBasis` 真的会是空数组，
 * "读不到就补一句'来自这一篇的材料'"这个错误实现才会真的被触发。
 */
const SINGLE_DAY_NOTE = randomUUID();
const SINGLE_DAY_VERSION = randomUUID();
const SINGLE_DAY_OBJECTIVE = randomUUID();
const SINGLE_DAY_RUN_1 = randomUUID();

const author = () => ({ workspaceId: WORKSPACE, userId: AUTHOR });

async function seedNote(noteId: string, versionId: string) {
  // 两张表互相引用（notes.current_version_id → note_versions，note_versions.note_id → notes），
  // 唯一键都是 NOT DEFERRABLE，所以走三步：先建没有当前版本的笔记，再建版本，再指回去。
  // 这也是产品那边真实的写入顺序。
  await fixtureSql`INSERT INTO notes (id, workspace_id, title, created_by, share_scope)
    VALUES (${noteId}, ${WORKSPACE}, ${`三层-${noteId.slice(0, 6)}`}, ${AUTHOR}, 'private')`;
  await fixtureSql`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
    VALUES (${versionId}, ${noteId}, ${WORKSPACE}, 1,
      ${fixtureSql.json({ blocks: [{ type: "paragraph", content: "有正文的这一篇" }] })},
      ${"e".repeat(64)}, ${AUTHOR})`;
  await fixtureSql`UPDATE notes SET current_version_id = ${versionId} WHERE id = ${noteId}`;
}

async function seedObjective(objectiveId: string, noteId: string, versionId: string, evidenceIds: string[]) {
  const revisionId = randomUUID();
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${WORKSPACE}, true)`;
    await tx`SELECT set_config('app.user_id', ${AUTHOR}, true)`;
    await tx`INSERT INTO learning_objectives_v2
        (id, workspace_id, objective_id, semantic_identity_class_id, semantic_identity_policy_version,
         semantic_target_fingerprint, current_objective_revision_id, current_revision, lifecycle)
      VALUES (${randomUUID()}, ${WORKSPACE}, ${objectiveId}, ${`class-${objectiveId}`}, 'v1',
        ${`fp-${objectiveId}`}, ${revisionId}, 1, 'active')`;
    await tx`INSERT INTO learning_objective_revisions_v2
        (id, workspace_id, objective_revision_id, objective_id, revision, objective_statement,
         public_summary, concept_label, knowledge_form, preferred_intents, canonical_answer,
         learning_support, scoring_rubric, relations, evidence_bindings, semantic_target_fingerprint,
         target_revision_hash, private_payload_hash)
      VALUES (${randomUUID()}, ${WORKSPACE}, ${revisionId}, ${objectiveId}, 1, ${`目标 ${objectiveId.slice(0, 6)}`},
        ${`公开摘要 ${objectiveId.slice(0, 6)}`}, ${`概念 ${objectiveId.slice(0, 6)}`}, 'comparison',
        ${tx.array([])}, ${tx.json({})}, ${tx.json({})}, ${tx.json({})}, ${tx.json([])}, ${tx.array([])},
        ${`fp-${objectiveId}`}, ${`trh-${objectiveId}`}, ${`pph-${objectiveId}`})`;
    // `::uuid[]` 靠**字面量**而不是驱动推断：postgres.js 把 `tx.array([...])`
    // 发成一个 text[] 参数，包进 `ARRAY[...]` 得到的是 `ARRAY[text[]]`。
    await tx`INSERT INTO learning_objective_origins_v2
        (id, workspace_id, origin_id, objective_id, objective_revision_id, origin_kind, note_id, note_version_id, integrity, evidence_snapshot_ids)
      VALUES (${randomUUID()}, ${WORKSPACE}, ${randomUUID()}, ${objectiveId}, ${revisionId},
        'note', ${noteId}, ${versionId}, 'verified', ${`{${evidenceIds.join(",")}}`}::uuid[])`;
  });
}

/** 一次作答：locked artifact ＋ 完成的评估（§11.2 第三行前两格的事实来源）。 */
async function seedAnswer(options: {
  objectiveId: string;
  runId: string;
  at: string;
  answer: Json;
  rubric: Json[];
}) {
  const taskId = randomUUID();
  const artifactId = randomUUID();
  const variantId = randomUUID();
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${WORKSPACE}, true)`;
    await tx`SELECT set_config('app.user_id', ${AUTHOR}, true)`;
    await tx`INSERT INTO learning_runs
        (id, workspace_id, user_id, origin, return_target, target_fingerprint, goal, phase, created_at, updated_at)
      VALUES (${options.runId}, ${WORKSPACE}, ${AUTHOR},
        ${tx.json({ kind: "card", objectiveId: options.objectiveId })},
        ${tx.json({ kind: "note", noteId: BARE_NOTE })}, ${`tf-${options.runId}`}, 'stabilize', 'completed',
        ${options.at}, ${options.at})`;
    await tx`INSERT INTO learning_tasks
        (id, run_id, workspace_id, user_id, sequence, intent, prompt, target_summary)
      VALUES (${taskId}, ${options.runId}, ${WORKSPACE}, ${AUTHOR}, 1, 'explain',
        ${`题面 ${taskId.slice(0, 6)}`}, ${`目标 ${options.objectiveId.slice(0, 6)}`})`;
    await tx`INSERT INTO learning_task_variants
        (id, task_id, workspace_id, user_id, purpose, template_trust_ceiling, estimated_active_seconds,
         interaction, public_payload_hash, input_schema_hash, disclosure_profile_hash,
         private_solution_hash, safety_report_hash)
      VALUES (${variantId}, ${taskId}, ${WORKSPACE}, ${AUTHOR}, 'formal', 'open', 60,
        ${tx.json({ type: "short_answer" })}, ${`pp-${variantId}`}, ${`ish-${variantId}`},
        ${`dph-${variantId}`}, ${`psh-${variantId}`}, ${`srh-${variantId}`})`;
    await tx`INSERT INTO learning_artifacts
        (id, run_id, task_id, variant_id, workspace_id, user_id, revision, payload, payload_hash,
         public_payload_hash, input_schema_hash, private_solution_hash, safety_report_hash,
         disclosure_profile_hash, assistance_snapshot_hash, status, locked_at, created_at)
      VALUES (${artifactId}, ${options.runId}, ${taskId}, ${variantId}, ${WORKSPACE}, ${AUTHOR}, 1,
        ${tx.json(options.answer)}, ${"a".repeat(64)}, ${"b".repeat(64)}, ${"c".repeat(64)},
        ${"d".repeat(64)}, ${"f".repeat(64)}, ${"0".repeat(64)}, ${"1".repeat(64)},
        'locked', ${options.at}, ${options.at})`;
    if (options.rubric.length > 0) {
      await tx`INSERT INTO learning_assessments
          (id, run_id, task_id, artifact_id, workspace_id, user_id, source, status,
           rubric_results, trust_class, report_hash, created_at, updated_at)
        VALUES (${randomUUID()}, ${options.runId}, ${taskId}, ${artifactId}, ${WORKSPACE}, ${AUTHOR},
          'assessment_critic', 'completed', ${tx.json(options.rubric)}, 'verified', ${"2".repeat(64)},
          ${options.at}, ${options.at})`;
    }
    // canonical 事件：证明"这一次被正式结算过"（§11.4「某次独立用过」的凭据之一）。
    await tx`INSERT INTO canonical_learning_event_outbox
        (id, commit_id, canonical_event_id, workspace_id, user_id, run_id, envelope, status, created_at)
      VALUES (${randomUUID()}, ${randomUUID()}, ${`ce-${options.runId}`}, ${WORKSPACE}, ${AUTHOR},
        ${options.runId}, ${tx.json({ version: 1 })}, 'published', ${options.at})`;
  });
}

const BARE_RUN_1 = randomUUID();
const BARE_RUN_2 = randomUUID();
const CARDED_RUN = randomUUID();

before(async () => {
  await fixtureSql`INSERT INTO users (id, email, password_hash, role)
    VALUES (${AUTHOR}, ${`deepen-${AUTHOR.slice(0, 8)}@example.test`}, 'h', 'member')`;
  await fixtureSql`INSERT INTO workspaces (id, owner_id, name)
    VALUES (${WORKSPACE}, ${AUTHOR}, ${`Deepening ${WORKSPACE.slice(0, 8)}`})`;
  await fixtureSql`INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES (${WORKSPACE}, ${AUTHOR}, 'owner')`;

  await seedNote(BARE_NOTE, BARE_VERSION);
  await seedNote(CARDED_NOTE, CARDED_VERSION);
  await seedNote(SINGLE_DAY_NOTE, SINGLE_DAY_VERSION);
  await seedObjective(BARE_OBJECTIVE, BARE_NOTE, BARE_VERSION, [EVIDENCE]);
  await seedObjective(PREREQUISITE, BARE_NOTE, BARE_VERSION, []);
  await seedObjective(CARDED_OBJECTIVE, CARDED_NOTE, CARDED_VERSION, [EVIDENCE]);
  await seedObjective(SINGLE_DAY_OBJECTIVE, SINGLE_DAY_NOTE, SINGLE_DAY_VERSION, []);

  await fixtureSql`INSERT INTO evidence_snapshots_v2
      (id, workspace_id, evidence_snapshot_id, evidence_snapshot_hash, source_snapshot_id,
       source_content_hash, support_description)
    VALUES (${randomUUID()}, ${WORKSPACE}, ${EVIDENCE}, ${"3".repeat(64)}, ${randomUUID()},
      ${"4".repeat(64)}, ${`材料依据 ${EVIDENCE.slice(0, 6)}`})`;

  // 零卡那篇：两条作答，**跨两个自然日**（§11.4「跨时间有重复证据」）。
  await seedAnswer({
    objectiveId: BARE_OBJECTIVE,
    runId: BARE_RUN_1,
    at: "2026-09-18T09:00:00.000Z",
    answer: { kind: "text", text: "索引把要扫的行数降下来了，但还要看它捞出来多少行。" },
    rubric: [{ rubricItemId: "r1", facet: "explain", verdict: "partial", userFacingReason: "结果规模那一半还没有自己的例子。" }],
  });
  await seedAnswer({
    objectiveId: BARE_OBJECTIVE,
    runId: BARE_RUN_2,
    at: "2026-09-20T09:00:00.000Z",
    answer: { kind: "choice", selectedOptionId: "b", interactionRefs: [] },
    rubric: [{ rubricItemId: "r1", facet: "explain", verdict: "covered", userFacingReason: "这次说到了结果规模。" }],
  });

  // 有卡那篇：挂一张 active 卡，证"可选卡片"那一格会被填上。
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${WORKSPACE}, true)`;
    await tx`INSERT INTO learning_cards_v2
        (id, workspace_id, card_id, objective_id, card_revision, current_publication_revision, lifecycle,
         front, public_summary, knowledge_form, strategy, presentation_hash)
      VALUES (${randomUUID()}, ${WORKSPACE}, ${CARD}, ${CARDED_OBJECTIVE}, 1, 1, 'active',
        ${tx.json({ prompt: "为什么有索引仍然可能慢？" })},
        ${"卡片摘要"}, 'comparison', 'recall', ${"5".repeat(64)})`;
  });
  await seedAnswer({
    objectiveId: CARDED_OBJECTIVE,
    runId: CARDED_RUN,
    at: "2026-09-19T09:00:00.000Z",
    answer: { kind: "text", text: "有卡那篇的一次作答。" },
    rubric: [{ rubricItemId: "r1", facet: "explain", verdict: "covered", userFacingReason: "讲到了。" }],
  });

  // 同一天那条：第一条作答，**零证据**。
  await seedAnswer({
    objectiveId: SINGLE_DAY_OBJECTIVE,
    runId: SINGLE_DAY_RUN_1,
    at: "2026-09-19T13:00:00.000Z",
    answer: { kind: "text", text: "同一天的第一条作答。" },
    rubric: [{ rubricItemId: "r1", facet: "explain", verdict: "covered", userFacingReason: "讲到了。" }],
  });
});

after(async () => {
  // `evidence_snapshots_v2` 与 `learning_objective_revisions_v2` 都走不可变触发器：
  // 没有维护口子时 DELETE 直接 RAISE，而那一发失败会**把后面所有清理一起吞掉**
  // （症状是"库没清干净"而不是"清理撞上不可变"）。所以整段清理都走同一个口子。
  await fixtureSql.begin(async (tx) => {
    await tx`SELECT set_config('app.allow_history_mutation', 'on', true)`;
    await tx`DELETE FROM learning_assessments WHERE workspace_id = ${WORKSPACE}`;
    await tx`DELETE FROM canonical_learning_event_outbox WHERE workspace_id = ${WORKSPACE}`;
    await tx`DELETE FROM learning_artifacts WHERE workspace_id = ${WORKSPACE}`;
    await tx`DELETE FROM learning_task_variants WHERE workspace_id = ${WORKSPACE}`;
    await tx`DELETE FROM learning_tasks WHERE workspace_id = ${WORKSPACE}`;
    await tx`DELETE FROM learning_runs WHERE workspace_id = ${WORKSPACE}`;
    await tx`DELETE FROM learning_cards_v2 WHERE workspace_id = ${WORKSPACE}`;
    await tx`DELETE FROM evidence_snapshots_v2 WHERE workspace_id = ${WORKSPACE}`;
    await tx`DELETE FROM learning_objective_origins_v2 WHERE workspace_id = ${WORKSPACE}`;
    await tx`DELETE FROM learning_objective_revisions_v2 WHERE workspace_id = ${WORKSPACE}`;
    await tx`DELETE FROM learning_objectives_v2 WHERE workspace_id = ${WORKSPACE}`;
    await tx`DELETE FROM note_versions WHERE workspace_id = ${WORKSPACE}`;
    await tx`DELETE FROM notes WHERE workspace_id = ${WORKSPACE}`;
    await tx`DELETE FROM workspace_members WHERE workspace_id = ${WORKSPACE}`;
    await tx`DELETE FROM workspaces WHERE id = ${WORKSPACE}`;
    await tx`DELETE FROM users WHERE id = ${AUTHOR}`;
  });
  await fixtureSql.end({ timeout: 5 });
  await closeDatabase();
});

test("§11.2 五格真读得到：原回答、反馈、日期、材料依据、可选卡片", async () => {
  const bare = await withWorkspaceTransaction(author(), (tx) =>
    service.readNoteDeepeningV3(tx, author(), BARE_NOTE));
  assert.equal(bare.records.length, 2, "两次 locked 作答应当都在");
  const prose = bare.records.find((record) => record.answerForm === "prose");
  assert.ok(prose, "散文那一档没有被读出来");
  assert.equal(prose!.answerText, "索引把要扫的行数降下来了，但还要看它捞出来多少行。");
  assert.deepEqual(prose!.feedback, [
    { verdict: "partial", reason: "结果规模那一半还没有自己的例子。" },
  ]);
  assert.equal(prose!.occurredAt, "2026-09-18T09:00:00.000Z", "日期是这一次作答的落库时刻");
  assert.equal(prose!.materialBasis.length, 1);
  assert.match(prose!.materialBasis[0].supportSummary, /^材料依据 /);
  assert.equal(prose!.cardId, null, "零卡那一篇的 cardId 如实是空的（§11.2 把它写成可选项）");

  // 结构化作答那一格如实是空的——不替她造一句"用户完成了这一步"。
  const structured = bare.records.find((record) => record.answerForm === "structured");
  assert.ok(structured, "结构化作答被整条丢掉了（它也是一次真实的作答）");
  assert.equal(structured!.answerText, null);

  // 正对照：有卡那篇的 cardId 被填上了。
  const carded = await withWorkspaceTransaction(author(), (tx) =>
    service.readNoteDeepeningV3(tx, author(), CARDED_NOTE));
  assert.equal(carded.records[0].cardId, CARD, "挂着的卡没有出现在'可选卡片'那一格");
});

test("§11.2 / §16.12 逐字：有正文的笔记无需制卡即可展开（真库读数）", async () => {
  // 正控制：这一篇**确实一张卡都没有**，且确实有正文、两个目标、两次作答。
  const cards = await fixtureSql`SELECT count(*)::int AS n FROM learning_cards_v2 c
     JOIN learning_objective_origins_v2 o ON o.workspace_id = c.workspace_id AND o.objective_id = c.objective_id
    WHERE o.note_id = ${BARE_NOTE}`;
  assert.equal(cards[0].n, 0, "正控制失效：零卡那篇居然有卡，这条判据就空转了");

  const out = await withWorkspaceTransaction(author(), (tx) =>
    service.readNoteDeepeningV3(tx, author(), BARE_NOTE));
  assert.equal(out.hasBody, true, "有正文的笔记被判成没正文");
  assert.equal(out.local.objectives.length, 2, "零卡那篇的目标没读出来");
  assert.equal(out.records.length, 2, "零卡那篇的作答没读出来——把制卡当成了读记录的前置");
});

test("§11.4：三轴分开，且**记录条数改写不了任何一轴**", async () => {
  const out = await withWorkspaceTransaction(author(), (tx) =>
    service.readNoteDeepeningV3(tx, author(), BARE_NOTE));
  assert.deepEqual(Object.keys(out.axes).sort(), ["applicability", "nextStep", "performance"]);
  for (const value of Object.values(out.axes)) {
    assert.equal(typeof value, "string", `${JSON.stringify(value)} 不是具名事实`);
  }
  // 两次作答跨两个自然日且都被正式结算过 ⇒ 「跨时间有重复证据」。
  assert.equal(out.axes.performance, "repeated_over_time");
  // **放大十倍**（塞九条同一天的作答）：三轴必须逐字不动。
  for (let index = 0; index < 8; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    await seedAnswer({
      objectiveId: BARE_OBJECTIVE,
      runId: randomUUID(),
      at: "2026-09-20T11:00:00.000Z",
      answer: { kind: "text", text: `同一天的又一条 ${index}` },
      rubric: [{ rubricItemId: "r1", facet: "explain", verdict: "covered", userFacingReason: "讲到了。" }],
    });
  }
  const many = await withWorkspaceTransaction(author(), (tx) =>
    service.readNoteDeepeningV3(tx, author(), BARE_NOTE));
  assert.equal(many.records.length, 10, "正控制失效：条数没涨上去，'条数无关'这条判据就空转了");
  assert.deepEqual(many.axes, out.axes,
    "记录从 2 条涨到 10 条之后三轴变了——那正是'用证据条数画理解度'");
  assert.equal(JSON.stringify(many).includes("%"), false, "整份读里出现了一个百分号");
});

test("§11.4：条数与天数是两个量——同一天练十次仍然是「独立用过一次」那一档", async () => {
  // **这一条是上面那条的承重副证**。上面那个夹具本来就跨了两天，于是"把记录条数
  // 也加进跨日计数"这个错误实现会**恰好蒙对**（2 天和 11 天都 ≥2），判据空转。
  // 全部落在同一天，条数与天数第一次变得可分辨。
  const before = await withWorkspaceTransaction(author(), (tx) =>
    service.readNoteDeepeningV3(tx, author(), SINGLE_DAY_NOTE));
  assert.equal(before.records.length, 1);
  assert.equal(before.axes.performance, "used_independently");

  for (let index = 0; index < 9; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    await seedAnswer({
      objectiveId: SINGLE_DAY_OBJECTIVE,
      runId: randomUUID(),
      at: "2026-09-19T14:00:00.000Z",
      answer: { kind: "text", text: `同一天的又一条 ${index}` },
      rubric: [{ rubricItemId: "r1", facet: "explain", verdict: "covered", userFacingReason: "讲到了。" }],
    });
  }
  const after = await withWorkspaceTransaction(author(), (tx) =>
    service.readNoteDeepeningV3(tx, author(), SINGLE_DAY_NOTE));
  assert.equal(after.records.length, 10, "正控制失效：条数没涨上去");
  assert.deepEqual(after.axes, before.axes,
    "同一天从 1 条练到 10 条就升级成'跨时间重复证据'——那正是 §11.4 禁的'按数量画理解度'");
});

test("§11.2：读不到材料就如实说没有，不补一句'来自这一篇的材料'", async () => {
  const out = await withWorkspaceTransaction(author(), (tx) =>
    service.readNoteDeepeningV3(tx, author(), SINGLE_DAY_NOTE));
  for (const record of out.records) {
    assert.deepEqual(record.materialBasis, [],
      "这一条一条证据都没挂——补一句材料依据就是让屏上出现一句没有出处的话");
  }
});

test("§11.2 不伪造：读不到那一篇就抛，不回一份'空的那一份'", async () => {
  await assert.rejects(
    () => withWorkspaceTransaction(author(), (tx) =>
      service.readNoteDeepeningV3(tx, author(), randomUUID())),
    /note_not_readable/,
    "读不到一篇笔记却回了一份空的——空的那一份与'这一篇真的什么都没有'在屏上长得一样",
  );
});

test("§11.5 截断诚实：limit 装不下时如实回报，不静默少列", async () => {
  const page = await withWorkspaceTransaction(author(), (tx) =>
    service.readNoteDeepeningV3(tx, author(), BARE_NOTE, { limit: 3 }));
  assert.equal(page.records.length, 3);
  assert.equal(page.recordsComplete, false, "被护栏截断了却没说——屏上会拿本页条数冒充总数");
  const full = await withWorkspaceTransaction(author(), (tx) =>
    service.readNoteDeepeningV3(tx, author(), BARE_NOTE));
  assert.equal(full.recordsComplete, true);
});
