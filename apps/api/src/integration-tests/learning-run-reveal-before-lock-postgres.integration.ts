/**
 * §16.37(a) 的**行为**判据：「先出题 → 后揭示 → 再作答」这一种必须被算作
 * 「作答时带着帮助」，而「答完 → 看卡背 → 评分稍后返回」这一种**不得**降级。
 *
 * ## 为什么源码形状守卫不够
 *
 * `learning-run-locked-answer-exposure-guard.test.ts` 判的是"那段代码里有没有
 * locked_at 截断"。它挡得住"有人把截断删了"，挡不住"截断写了但方向反了"。
 * 所以这里用真库 + **桩 Critic**（不打真模型、不花钱、结果确定）把两种顺序各跑一遍。
 *
 * ## 为什么这一对用例能隔离出评估期那道闸
 *
 * 关键在**插入 exposure 的时机**：两道闸读的是同一张表，差别只在"什么时候算"——
 * 规划期看**出题时**，评估期看**锁定时**。
 *
 *  - 揭示插在**出题之后、提交之前** ⇒ 规划期那道闸**看不到**它（run 已建好），
 *    评估期那道闸看得到且 `exposed_at < locked_at` ⇒ 期望**降级**。
 *    这正是以前唯一被漏掉的那一种。
 *  - 揭示插在**提交之后** ⇒ 两道闸都看得到，但 `exposed_at > locked_at`
 *    ⇒ 窗口不成立 ⇒ 期望**不降级**。§16.37(a) 全部的重量在这一格。
 *
 * 断言写在**结算结果**上（`outcome` / canonical envelope），而不是内部变量：
 * 降级的可观察后果是"这次不产生 mastery 事实"，那才是产品判据。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { createLearningRunForTest, seedV2Fixture } from "./helpers/v2-card-fixture.ts";

const CONN = process.env.DATABASE_URL;
if (!CONN) {
  throw new Error("§16.37(a) 行为集测要求 DATABASE_URL（要造 exposure 与 run）");
}
const sql = postgres(CONN, { max: 4 });

const { hashCanonicalV2 } = await import("@astella/shared/hash-canonical-v2");
const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const { submitArtifact, getRunPublicView } = await import("../modules/learning-runs/run-service.ts");
const tickModule = await import("../modules/learning-runs/processing/run-processing-tick.ts");
const { runLearningRunProcessingTick } = tickModule;

/** 桩 Critic：把每一条 rubric 都判 covered，让"降不降级"成为唯一变量。 */
before(() => {
  tickModule.setCriticTransportForTests({
    assess: async (input: { rubricTargetIds?: string[] }) =>
      (input.rubricTargetIds ?? ["r1"]).map((rubricItemId) => ({
        rubricItemId,
        verdict: "covered" as const,
        userFacingReason: "回答覆盖了这一条评分点。",
        confidence: 0.9,
      })),
  } as never);
});

after(async () => {
  tickModule.setCriticTransportForTests(null);
  await sql.end({ timeout: 2 });
  await closeDatabase();
});

interface Seeded {
  workspaceId: string;
  userId: string;
  cardId: string;
  objectiveId: string;
  cleanup: () => Promise<void>;
}

/** 那条被引用的正文。长度要够覆盖快照的 start_offset=0 / end_offset=12。 */
const EVIDENCE_TEXT = "间隔重复按记忆遗忘规律安排复习时点，复习间隔随成功回忆次数递增。";

/** `seedV2Fixture` 的默认 rubric 单元 id（它的 DEFAULT_SCORING_RUBRIC 里那一个）。 */
const RUBRIC_UNIT_ID = "fixture-rubric-u1";

async function seed(): Promise<Seeded> {
  const fixture = await seedV2Fixture(sql, {
    objectiveStatement: "间隔重复可以显著降低遗忘率",
    publicSummary: "间隔重复",
    front: { cue: "间隔重复", prompt: "间隔重复为什么有效？" },
  });
  // **必须**补这条依据：`seedV2Fixture` 本身不造 evidence binding，而 Critic 输入
  // 有一道 fail closed 闸「task rubric has no frozen evidence」——缺了它，run 会停在
  // checkpoint，压根走不到 `hasHintExposure`。第一版就是漏了这一句，于是两条用例
  // 都在 checkpoint 上"通过"了：一条断言"不是 demonstrated"、一条断言"是 demonstrated"
  // 互相反驳却都绿——**这类假绿比红更坏**，正是本文件开头要按住的那一类。
  // 那条依据要**指得到一个真实的正文块**。Critic 取原文那一发对 `note_blocks` 是
  // **innerJoin**（`evidence_snapshots_v2.block_id`），而 `seedObjectiveNoteEvidence`
  // 不写 `block_id`——那一行会被 join 掉，报出来的是 `evidence snapshot unavailable`。
  //
  // 这里**不**去改那张快照：它是不可变的（库上有 `immutable_v2_row` 触发器挡 UPDATE，
  // 挡得对——冻结依据事后被改正是最坏的一种坏）。改为**一开始就按正确形状插**：
  // 正文块 → 依据快照（带 block_id）→ 资格 → 绑定。
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${fixture.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${fixture.userId}, true)`;
    // 冻结依据会当场校验 `hashCanonicalV2("block", { content })` 与库里那一列一致
    // （"evidence block content changed"）——所以哈希得自己算，不能占位。
    const blockContentHash = hashCanonicalV2("block", { content: EVIDENCE_TEXT });
    // 同一段还有第二道：引用那段（start..end 切片）也要有自己的哈希。
    const quoteHash = hashCanonicalV2("evidence-quote", { quote: EVIDENCE_TEXT.slice(0, 12) });
    const [block] = await tx`INSERT INTO note_blocks (id, version_id, workspace_id, ordinal, type, content)
      VALUES (${randomUUID()}, ${fixture.noteVersionId}, ${fixture.workspaceId}, 1, 'paragraph', ${EVIDENCE_TEXT})
      RETURNING id`;
    const evidenceSnapshotId = randomUUID();
    await tx`INSERT INTO evidence_snapshots_v2
        (id, workspace_id, evidence_snapshot_id, evidence_snapshot_hash, source_snapshot_id,
         note_id, block_id, start_offset, end_offset, protected_quote_ref, quote_hash,
         modality, block_content_hash, source_content_hash)
      VALUES (gen_random_uuid(), ${fixture.workspaceId}, ${evidenceSnapshotId}, ${"b".repeat(64)},
              ${randomUUID()}, ${fixture.noteId}, ${block.id}, 0, 12,
              ${`evidence://snapshot/${evidenceSnapshotId}`}, ${quoteHash}, 'text',
              ${blockContentHash}, ${"f".repeat(64)})`;
    await tx`INSERT INTO evidence_eligibility_states_v2
        (id, workspace_id, eligibility_id, evidence_snapshot_id, status, eligibility_epoch, eligibility_vector_hash)
      VALUES (gen_random_uuid(), ${fixture.workspaceId}, ${randomUUID()}, ${evidenceSnapshotId},
              'usable', 1, ${"a".repeat(64)})`;
    await tx`INSERT INTO learning_objective_evidence_bindings_v2
        (id, workspace_id, binding_id, objective_revision_id, target_unit_kind, target_unit_id,
         evidence_snapshot_id, relation, support_strength, semantic_support_report_id,
         semantic_support_report_hash, binding_hash)
      VALUES (gen_random_uuid(), ${fixture.workspaceId}, ${randomUUID()}, ${fixture.objectiveRevisionId},
              'rubric', ${RUBRIC_UNIT_ID}, ${evidenceSnapshotId}, 'entails', 'direct',
              ${randomUUID()}, ${"c".repeat(64)}, ${"d".repeat(64)})`;
    await tx`INSERT INTO learning_objective_origins_v2
        (id, workspace_id, origin_id, objective_id, objective_revision_id, origin_kind,
         note_id, note_version_id, evidence_snapshot_ids, integrity)
      VALUES (gen_random_uuid(), ${fixture.workspaceId}, ${randomUUID()}, ${fixture.objectiveId},
              ${fixture.objectiveRevisionId}, 'note', ${fixture.noteId}, ${fixture.noteVersionId},
              ${`{${evidenceSnapshotId}}`}::uuid[], 'verified')`;
  });
  return {
    workspaceId: fixture.workspaceId,
    userId: fixture.userId,
    cardId: fixture.cardId,
    objectiveId: fixture.objectiveId,
    cleanup: fixture.cleanup,
  };
}

/** 一条 reveal exposure。`at` 就是「这次揭示发生在那时」的凭据。 */
async function insertRevealExposure(
  target: { workspaceId: string; userId: string; objectiveId: string },
  at: Date,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${target.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${target.userId}, true)`;
    await tx`INSERT INTO learning_exposures_v2
        (id, workspace_id, exposure_id, user_id, objective_id, objective_revision,
         card_id, card_revision, exposure_kind, context_hash, idempotency_key, exposed_at)
      VALUES (${randomUUID()}, ${target.workspaceId}, ${randomUUID()}, ${target.userId},
        ${target.objectiveId}, 1, ${target.objectiveId}, 1, 'answer_reveal',
        ${`ctx-${randomUUID()}`}, ${`idem-${randomUUID()}`}, ${at})`;
  });
}

interface Outcome {
  phase: string;
  outcome: string | null;
  canonicalEnvelopes: number;
}

/** 建 run → 提交一个正确答案 → 跑 tick 直到离开 assessing。 */
async function runOneAnswer(
  seeded: Seeded,
  when: "beforeSubmit" | "afterSubmit",
): Promise<Outcome> {
  const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
  const run = await withWorkspaceTransaction(scope, async (tx) =>
    createLearningRunForTest(tx, {
      ...scope,
      request: {
        originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.objectiveId },
        goal: "stabilize",
        idempotencyKey: `s1637-${randomUUID()}`,
      },
    }),
  );

  // 「出题后、锁定前」——run 已建好，此刻插一次揭示：规划期那道闸已经读完了。
  if (when === "beforeSubmit") {
    await insertRevealExposure(seeded, new Date());
  }

  const taskId = run.activeTaskId!;
  const variant = run.activeTask!.activeVariant;
  await withWorkspaceTransaction(scope, async (tx) =>
    submitArtifact(tx, {
      ...scope,
      runId: run.runId,
      taskId,
      request: {
        version: 1,
        variantId: variant.variantId,
        variantRevision: variant.revision,
        runRevision: run.revision,
        taskRevision: run.activeTask!.revision,
        inputSchemaHash: variant.inputSchemaHash,
        payload: {
          kind: "text",
          text: "因为间隔重复让复习间隔随回忆次数增长，每次都在快要遗忘时出现，于是长期保持。",
        },
        idempotencyKey: `s1637-submit-${randomUUID()}`,
      },
    }),
  );

  // 「锁定后」——答案已经 locked_at，这之后才发生的揭示不得降级它。
  if (when === "afterSubmit") {
    await insertRevealExposure(seeded, new Date());
  }

  let view = await withWorkspaceTransaction(scope, (tx) =>
    getRunPublicView(tx, { ...scope, runId: run.runId }),
  );
  for (let round = 0; round < 12 && !["completed", "cancelled", "stale", "ended"].includes(view.phase); round += 1) {
    const result = await runLearningRunProcessingTick(`s1637-worker:${randomUUID()}`, 10);
    assert.equal(result.failed, 0, `tick failed=${result.failed} round=${round} phase=${view.phase}`);
    view = await withWorkspaceTransaction(scope, (tx) =>
      getRunPublicView(tx, { ...scope, runId: run.runId }),
    );
  }

  const envelopeRows = await sql`
    SELECT count(*)::int AS n FROM canonical_learning_event_outbox WHERE run_id = ${run.runId}
  `;
  return {
    phase: view.phase,
    outcome: (view as { result?: { outcome?: string } }).result?.outcome ?? null,
    canonicalEnvelopes: Number(envelopeRows[0]?.n ?? 0),
  };
}

test("揭示发生在**锁定前**（出题后、提交前）→ 这次作答按带帮助结算，不产生 mastery 事实", async () => {
  const seeded = await seed();
  try {
    const r = await runOneAnswer(seeded, "beforeSubmit");
    assert.notEqual(r.outcome, "demonstrated",
      "锁定之前已经看过答案，却仍按独立作答结算成 demonstrated——"
      + "评估期那道闸没有接上「出题后、锁定前」这一种（§16.37(a)/§14.1.1）");
    assert.equal(r.canonicalEnvelopes, 0,
      "带帮助的作答写出了 canonical envelope：这一次观察被当成了可复用的能力事实");
  } finally {
    await seeded.cleanup();
  }
});

test("揭示发生在**锁定后**（提交之后才看卡背）→ 不得降级，仍然是独立作答（§16.37(a)）", async () => {
  const seeded = await seed();
  try {
    const r = await runOneAnswer(seeded, "afterSubmit");
    assert.equal(r.phase, "completed", `run 没走到 completed：phase=${r.phase}`);
    assert.equal(r.outcome, "demonstrated",
      "答案锁定之后才发生的那次揭示把一份**已经锁定**的独立作答降级了——"
      + "§16.37(a) 反向。这正是 2026-09-27 之前那条守卫挡住的那一格，现在它有界了。");
    assert.equal(r.canonicalEnvelopes, 1,
      "正确的独立作答没有落下 canonical Commit——降级闸是不是收得太宽了");
  } finally {
    await seeded.cleanup();
  }
});
