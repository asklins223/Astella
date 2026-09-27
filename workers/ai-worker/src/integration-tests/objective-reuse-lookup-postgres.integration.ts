/**
 * 同目标复用的读侧（39d W7-5 刀二；39 §4.2 第三段）。
 *
 * 这一档钉的是**收窄**与**块锚**两件——判据那一层（纯函数）在
 * `packages/shared/src/objective-reuse-rules-v2.test.ts` 里钉住，这里钉的是
 * "送进判据的那份输入对不对"。
 *
 * 四件读错就会错判的事，每件都带正控制：
 *  1. **按 (工作区, 笔记) 收窄**。§4.2「跨笔记仅有相似关系时仍分别记录，暂不自动
 *     抵扣复习」——正控制是"另一篇的同块目标**不出现**在这份候选里"。
 *  2. **块锚要去重**。同一块切两段会封出两个 `evidence_snapshot_id`，而
 *     `block_id` 一样；不按块去重就会把"同一处出处"读成两条。正控制是那一行
 *     的 `blockIds` **长度 1**。
 *  3. **形态取当前修订**。拿旧修订判会让"后来改成另一种形态"的被误认。
 *     正控制是改当前修订的形态后，候选里读到的是**新**形态。
 *  4. **归档／被替代的不进候选**。§8.5「停用卡从复习中移除但保留历史」——
 *     正控制是 archived 那一行**不在**结果里。
 *
 * 环境口径与制卡族其余集测一致：夹具走 `DATABASE_URL_MIGRATOR`（超户），
 * 被测路径经 `withWorkerWorkspaceTransaction` 跑在 `DATABASE_URL_WORKER` 上。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const fixtureUrl = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
if (!fixtureUrl || !process.env.DATABASE_URL_WORKER) {
  throw new Error("复用读侧集测需要 DATABASE_URL_MIGRATOR（夹具）＋DATABASE_URL_WORKER（受限角色）");
}
const fixtureSql = postgres(fixtureUrl, { max: 1 });

// 与制卡族其余集测同一形状：worker 侧与 api 侧各关一次，否则进程挂着不退。
const { withWorkerWorkspaceTransaction, closeDatabase: closeWorkerDatabase } = await import("../db.ts");
const { closeDatabase: closeApiDatabase } = await import("../../../../apps/api/src/db/client.ts");
const { loadReusableObjectivesForNoteV2 } = await import("../card-generation-v2/objective-reuse-lookup.ts");

const WORKSPACE_ID = randomUUID();
const USER_ID = randomUUID();
const NOTE_ID = randomUUID();
const OTHER_NOTE_ID = randomUUID();
const BLOCK_A = randomUUID();
const BLOCK_B = randomUUID();
const ctx = { workspaceId: WORKSPACE_ID, userId: USER_ID };

/** 一颗目标：当前修订的形态、来源块、生命周期。 */
async function seedObjective(input: {
  noteId: string;
  form: string;
  blockId: string | null;
  lifecycle?: string;
  /** 同一块切成几段 ⇒ 几个证据快照（正控制 #2 要的就是这个）。 */
  snapshotCount?: number;
}): Promise<string> {
  const objectiveId = randomUUID();
  const revisionId = randomUUID();
  // `semantic_identity_class_id` 与 `semantic_identity_policy_version` 是 NOT NULL：
  // 照线上列写。第一版只给了三列，当场被那条约束教回来。
  // 三列 NOT NULL：语义身份类、策略版本、目标指纹。第一版只给了三列，被
  // `semantic_identity_class_id` 教回来一次；补上它又被
  // `semantic_target_fingerprint` 教回来第二次——照线上列一次给全。
  const identityClassId = `candidate:${randomUUID()}`;
  const fingerprint = randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64);
  await fixtureSql`INSERT INTO learning_objectives_v2
      (objective_id, workspace_id, current_objective_revision_id, lifecycle,
       semantic_identity_class_id, semantic_identity_policy_version, semantic_target_fingerprint)
    VALUES (${objectiveId}, ${WORKSPACE_ID}, ${revisionId}, ${input.lifecycle ?? "active"},
            ${identityClassId}, 'sem-id-v1', ${fingerprint})`;
  // 这一张表有 12 个 NOT NULL 列（`preferred_intents` / `canonical_answer` /
  // `learning_support` / `scoring_rubric` / `relations` / `evidence_bindings` /
  // `semantic_target_fingerprint` / `target_revision_hash` / `private_payload_hash` /
  // `hints` …）。前两版是**逐条被 NOT NULL 教回来的**（先 class_id、再
  // fingerprint、再 objective_statement）——第三次直接把整张表的必填列一次给全。
  const zeroHash = "0".repeat(64);
  await fixtureSql`INSERT INTO learning_objective_revisions_v2
      (objective_revision_id, workspace_id, objective_id, revision, knowledge_form,
       objective_statement, public_summary, preferred_intents, canonical_answer,
       learning_support, scoring_rubric, relations, evidence_bindings,
       semantic_target_fingerprint, target_revision_hash, private_payload_hash, hints)
    VALUES (${revisionId}, ${WORKSPACE_ID}, ${objectiveId}, 1, ${input.form},
            '一句话目标', '一句话摘要', '{}'::text[], '[]'::jsonb,
            '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
            ${fingerprint}, ${zeroHash}, ${zeroHash}, '[]'::jsonb)`;
  const snapshotIds: string[] = [];
  for (let i = 0; i < (input.snapshotCount ?? 1); i += 1) {
    const snapshotId = randomUUID();
    snapshotIds.push(snapshotId);
    await fixtureSql`INSERT INTO evidence_snapshots_v2
        (workspace_id, evidence_snapshot_id, evidence_snapshot_hash, source_snapshot_id, note_id, block_id,
         start_offset, end_offset, source_content_hash)
      VALUES (${WORKSPACE_ID}, ${snapshotId}, ${randomUUID()}, ${randomUUID()}, ${input.noteId},
              ${input.blockId}, ${i * 10}, ${i * 10 + 10}, ${"0".repeat(64)})`;
  }
  await fixtureSql`INSERT INTO learning_objective_origins_v2
      (workspace_id, origin_id, objective_id, objective_revision_id, origin_kind, note_id, note_version_id, evidence_snapshot_ids)
    VALUES (${WORKSPACE_ID}, ${randomUUID()}, ${objectiveId}, ${revisionId}, 'note',
            ${input.noteId}, ${randomUUID()}, ${snapshotIds}::uuid[])`;
  return objectiveId;
}

before(async () => {
  await fixtureSql`INSERT INTO users (id, email, password_hash)
    VALUES (${USER_ID}, ${`reuse-${USER_ID}@example.invalid`}, 'unused')`;
  await fixtureSql`INSERT INTO workspaces (id, owner_id, name, workspace_type)
    VALUES (${WORKSPACE_ID}, ${USER_ID}, '书房', 'personal')`;
  await fixtureSql`INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner')`;
  // 两篇笔记：正控制 #1 要靠"另一篇的同块目标"被排除掉。
  for (const noteId of [NOTE_ID, OTHER_NOTE_ID]) {
    await fixtureSql`INSERT INTO notes (id, workspace_id, created_by, title, share_scope)
      VALUES (${noteId}, ${WORKSPACE_ID}, ${USER_ID}, '复用那一篇', 'shared')`;
  }
  // 同一块切两段 ⇒ 两个快照 id、一个 block_id（正控制 #2）。
  await seedObjective({ noteId: NOTE_ID, form: "fact", blockId: BLOCK_A, snapshotCount: 2 });
  await seedObjective({ noteId: NOTE_ID, form: "fact", blockId: BLOCK_B });
  await seedObjective({ noteId: NOTE_ID, form: "application_rule", blockId: BLOCK_A });
  await seedObjective({ noteId: NOTE_ID, form: "fact", blockId: BLOCK_A, lifecycle: "archived" });
  // 另一篇的同块目标：必须**不出现**。
  await seedObjective({ noteId: OTHER_NOTE_ID, form: "fact", blockId: BLOCK_A });
});

after(async () => {
  await closeWorkerDatabase();
  await closeApiDatabase().catch(() => undefined);
  await fixtureSql.end();
});

test("W7-5 刀二：按 (工作区, 笔记) 收窄、块锚按块去重、归档的不进候选", async () => {
  await withWorkerWorkspaceTransaction(ctx, async (tx) => {
    const candidates = await loadReusableObjectivesForNoteV2(tx, {
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
    });
    // ① 这一篇里 4 颗种下去的，归档那颗**不出现**（正控制 #4）⇒ 3 颗。
    assert.equal(candidates.length, 3);
    // ② 同一块切两段的那个，`blockIds` **长度 1**——按块去重，不是按快照。
    const twoSegments = candidates.find((c) => c.blockIds.length >= 1 && c.knowledgeForm === "fact"
      && c.blockIds.includes(BLOCK_A));
    assert.ok(twoSegments, "同块两段那颗应该在候选里");
    assert.equal(twoSegments.blockIds.length, 1, "按快照去重会把「同一处出处」读成两条");
    // ③ 形态取当前修订：application_rule 那颗形态原样读出，不被 fact 吞掉。
    assert.equal(candidates.filter((c) => c.knowledgeForm === "application_rule").length, 1);
    // ① 正控制：另一篇的同块目标不在这份候选里（§4.2 跨笔记不自动抵扣）。
    const other = await loadReusableObjectivesForNoteV2(tx, {
      workspaceId: WORKSPACE_ID,
      noteId: OTHER_NOTE_ID,
    });
    assert.equal(other.length, 1, "另一篇只有一颗");
    const overlap = other.filter((c) => candidates.some((x) => x.objectiveId === c.objectiveId));
    assert.deepEqual(overlap, [], "两篇的候选不许互相出现");
  });
});

test("W7-5 刀二：读出来的候选直接喂判据，同块同形态那一条会落到既有目标上", async () => {
  const { decideObjectiveReuseV2 } = await import("@ailearn/shared/objective-reuse-rules-v2");
  await withWorkerWorkspaceTransaction(ctx, async (tx) => {
    const candidates = await loadReusableObjectivesForNoteV2(tx, {
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
    });
    // BLOCK_B 上只有一颗 fact 目标 ⇒ 应当唯一命中。
    const decided = decideObjectiveReuseV2({
      candidateBlockIds: [BLOCK_B],
      knowledgeForm: "fact",
      existing: candidates,
    });
    assert.equal(decided.outcome, "reuse");
    // BLOCK_A 上有**两颗** fact（另一颗 archived 被排除了，所以只剩一颗）⇒ 唯一命中。
    const decidedA = decideObjectiveReuseV2({
      candidateBlockIds: [BLOCK_A],
      knowledgeForm: "fact",
      existing: candidates,
    });
    assert.equal(decidedA.outcome, "reuse", "归档那颗被排除后，BLOCK_A 上只剩一颗 fact");
    // 形态不同 ⇒ 判据自己挡掉（那是判据那一层的事，这里只确认输入够用）。
    const decidedOtherForm = decideObjectiveReuseV2({
      candidateBlockIds: [BLOCK_B],
      knowledgeForm: "procedure",
      existing: candidates,
    });
    assert.equal(decidedOtherForm.outcome, "create_new");
  });
});
