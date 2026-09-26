/**
 * P4 结构题 practice 纵切集成测试（真实 postgres）。
 *
 * 纵切：structured 偏好创建（ordering 主 Variant + practice 上限 + text/voice
 * standby）→ 正确顺序提交 → tick 确定性评估 → practice_completed 结算 +
 * 恰好一个 practice trail event（0 canonical / 0 schedule）→ 错误顺序同样
 * practice（gap 反馈）→ 非法 payload（token 不属于题目）400 拒绝。
 *
 * 运行：DATABASE_URL_API="postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn"
 *   node --import tsx --test --test-concurrency=1 src/integration-tests/learning-runs-structured-postgres.integration.ts
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { createLearningRunForTest, seedV2Fixture } from "./helpers/v2-card-fixture.ts";
import {
  learningRunCleanupStepsV1,
  learningRunIdColumnsQueryV1,
  learningRunResidueSlotsV1,
  nonzeroResidueV1,
  renderPsqlResidueQueryV1,
  renderPsqlStatementV1,
} from "./helpers/learning-run-cleanup.ts";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";

const CONN = testDatabaseUrl("DATABASE_URL_API");
process.env.DATABASE_URL_API ??= CONN;
const sql = postgres(CONN, { max: 2 });

/**
 * 裸 SQL 校验必须带 workspace/user 上下文。
 *
 * 目标表 learning_task_private_solutions / canonical_learning_event_outbox /
 * practice_trail_event_outbox 都是 FORCE RLS：受限角色（ailearn_api）在无上下文
 * 事务里查询会命中 0 行，让"从 private solution 读正确答案"取到空数组而假失败；
 * 超级用户则绕过 RLS 让它失去隔离意义。
 */
function scoped<T>(
  scope: { workspaceId: string; userId: string },
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${scope.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${scope.userId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const { submitArtifact, getRunPublicView, revealRunTargetV2 } = await import(
  "../modules/learning-runs/run-service.ts"
);
const { runLearningRunProcessingTick, closeStructuredSolutionSql } = await import(
  "../modules/learning-runs/run-processing-tick.ts"
);

after(async () => {
  await sql.end({ timeout: 2 });
  await closeStructuredSolutionSql();
  await closeDatabase();
});

/**
 * planV2Run 的结构化规划需要显式结构（mapping/ordered_steps → ordering；
 * comparison → relation）。text 答案 + 空 relations 会静默回退 text_response
 * （2026-08-23 对齐：structured_bundle 双 part 仅存在于已退役的 V1 planner）。
 */
async function seed(kind: "mapping" | "comparison" = "mapping") {
  const fixture = await seedV2Fixture(sql, {
    objectiveStatement: "遗忘曲线表明复习间隔决定长期记忆。主动回忆比重复阅读更有效。",
    publicSummary: "遗忘曲线",
    front: { cue: "遗忘曲线", prompt: "什么是遗忘曲线？" },
    canonicalAnswerJson:
      kind === "mapping"
        ? JSON.stringify({
            kind: "mapping",
            pairs: [
              { unitId: "u-interval", left: "复习间隔", right: "长期记忆保持" },
              { unitId: "u-recall", left: "主动回忆", right: "优于重复阅读" },
            ],
          })
        : JSON.stringify({
            kind: "comparison",
            columns: ["主动回忆", "重复阅读"],
            rows: [
              { unitId: "r1", dimension: "记忆保持", values: ["长", "短"] },
              { unitId: "r2", dimension: "投入成本", values: ["高", "低"] },
            ],
          }),
  });
  return {
    workspaceId: fixture.workspaceId,
    userId: fixture.userId,
    cardId: fixture.cardId,
    keyPointId: fixture.objectiveId,
    cleanup: fixture.cleanup,
  };
}

test("P4 纵切：structured 创建 → ordering 提交 → 确定性评估 → facet 结算（facet_evidence envelope + 0 schedule）", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const run = await withWorkspaceTransaction(scope, async (tx) =>
      createLearningRunForTest(tx, {
        ...scope,
        request: {
          originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
          goal: "stabilize",
          responsePreference: "structured",
          idempotencyKey: "p4-create-1",
        },
      }),
    );
    // 2026-08-23 对齐：V2 planner（planV2Run）结构化规划产单 part 任务；
    // structured_bundle 双 part 仅存在于已退役的 V1 planner。mapping 答案
    // → ordering；§7.7 标注后 ordering ceiling=facet_eligible。
    const ordering = run.activeTask?.activeVariant.interaction as unknown as {
      kind: "ordering";
      publicTokenIds?: string[];
      publicTokenLabels?: Record<string, string>;
    };
    assert.equal(ordering.kind, "ordering");
    assert.ok((ordering.publicTokenIds ?? []).length >= 2, "ordering tokens present");
    assert.ok(ordering.publicTokenLabels && Object.keys(ordering.publicTokenLabels).length >= 2, "labels present");
    // V2 planner：结构题目前只验证一个可机械比对的答案结构，不能逐一证明冻结
    // rubric 的全部 required 能力，因此**有意**降级为 practice（run-planner.ts:
    // structuredPracticeOnly → purpose=practice / ceiling=practice_only），不得
    // 以一次结构题通过换取 canonical/schedule。本文件其余断言（outcome=
    // practice_completed、0 canonical、0 schedule）与此一致。
    assert.equal(run.activeTask?.activeVariant.purpose, "practice");
    assert.equal(run.activeTask?.activeVariant.templateTrustCeiling, "practice_only");
    // schedulePolicySummary 描述的是**调度授权**（本 run 由 usable 目标授权
    // create_initial），与 task purpose 是两个层次：实际结算仍按 practice 走
    // scheduleImpact={kind:"none",reasonCode:"practice_only"}（见下方断言）。
    assert.equal(run.schedulePolicySummary.kind, "create_on_canonical_outcome");
    // V2 planner 结构化分支不保证 text standby（与 V1 双 variant 不同），
    // 只断言 alternatives 列表存在。
    assert.ok(Array.isArray(run.activeTask?.availableAlternatives), "alternatives list present");

    const labels = ordering.publicTokenLabels ?? {};
    // 正确顺序：mapping 按 unitId 排序生成 correctTokenIds——经 label 反查
    // （复习间隔=u-interval 在前，主动回忆=u-recall 在后）。
    const byLabel = (label: string) => Object.entries(labels).find(([, v]) => v === label)?.[0] ?? "";
    const correctOrder = [byLabel("复习间隔"), byLabel("主动回忆")];

    // 提交 ordering Artifact（正确序列）。
    const submission = {
      version: 1 as const,
      variantId: run.activeTask!.activeVariant.variantId,
      variantRevision: run.activeTask!.activeVariant.revision,
      inputSchemaHash: run.activeTask!.activeVariant.inputSchemaHash,
      payload: {
        kind: "ordering" as const,
        orderedTokenIds: correctOrder,
        interactionRefs: [] as string[],
      } as never,
    };
    await withWorkspaceTransaction(scope, async (tx) =>
      submitArtifact(tx, {
        ...scope,
        runId: run.runId,
        taskId: run.activeTaskId!,
        request: {
          ...submission,
          runRevision: run.revision,
          taskRevision: run.activeTask!.revision,
          idempotencyKey: "p4-submit-1",
        },
      }),
    );
    for (let round = 0; round < 6; round += 1) {
      await runLearningRunProcessingTick(`p4-worker:${randomUUID()}`, 10);
    }
    const afterRun = await withWorkspaceTransaction(scope, async (tx) =>
      getRunPublicView(tx, { ...scope, runId: run.runId }),
    );
    assert.equal(afterRun.phase, "completed");
    // 确定性 structured 结算（2026-08-23 实证对齐）：正确提交 →
    // practice_completed（0 canonical / 0 schedule；§12.6 结构题不产 canonical）。
    assert.equal(afterRun.result?.outcome, "practice_completed");
    assert.deepEqual(afterRun.result?.scheduleImpact, { kind: "none", reasonCode: "practice_only" });

    // 0 canonical envelope / 0 schedule。
    const envelopeCount = await scoped(scope, (tx) => tx`
      SELECT count(*)::int AS n FROM canonical_learning_event_outbox WHERE run_id = ${run.runId}
    `);
    assert.equal(envelopeCount[0].n, 0);
    const schedCount = await sql`
      SELECT count(*)::int AS n FROM review_schedules WHERE workspace_id = ${seeded.workspaceId}
    `;
    assert.equal(schedCount[0].n, 0);
    // 恰好一个 practice trail event（§16.2 runId+scope 唯一）。
    const trailRows = await scoped(scope, (tx) => tx`
      SELECT event, scope FROM practice_trail_event_outbox WHERE run_id = ${run.runId}
    `);
    assert.equal(trailRows.length, 1);
    assert.equal(trailRows[0].scope, "official_user");

    // §5.4 逐位反馈：正确提交之后，除了聚合那一格，**每个位子都要有一格说"这一步放对了"**，
    // 并且点得出用户自己放在那一位的那一项（这是他自己交上来的文字，不新增答案信息）。
    const goodAssessment = await scoped(scope, (tx) => tx`
      SELECT rubric_results FROM learning_assessments WHERE run_id = ${run.runId}
    `);
    const goodEntries = goodAssessment[0].rubric_results as Array<{
      rubricItemId: string; verdict: string; userFacingReason: string;
    }>;
    const goodUnits = goodEntries.filter((item) => /#pos-\d+$/.test(item.rubricItemId));
    assert.equal(goodUnits.length, correctOrder.length, "按正确序列的位数给格");
    assert.deepEqual(goodUnits.map((item) => item.verdict), correctOrder.map(() => "covered"));
    for (const [index, unit] of goodUnits.entries()) {
      const ownLabel = Object.entries(labels).find(([id]) => id === correctOrder[index])?.[1] ?? "";
      assert.ok(
        unit.userFacingReason.includes(ownLabel),
        `第 ${index + 1} 位要点出用户放在这一位的那一项：${unit.userFacingReason}`,
      );
    }

  } finally {
    await seeded.cleanup();
  }
});

test("§5.4 逐位反馈（真 tick）：不成立的位子说不成立、一个字都不写出该放什么；结算那一档不改", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const run = await withWorkspaceTransaction(scope, async (tx) =>
      createLearningRunForTest(tx, {
        ...scope,
        request: {
          originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
          goal: "stabilize",
          responsePreference: "structured",
          idempotencyKey: "p4-create-units",
        },
      }),
    );
    const ordering = run.activeTask!.activeVariant.interaction as unknown as {
      publicTokenIds?: string[];
      publicTokenLabels?: Record<string, string>;
    };
    const labels = ordering.publicTokenLabels ?? {};
    const byLabel = (label: string) => Object.entries(labels).find(([, v]) => v === label)?.[0] ?? "";
    // 故意交**反**的那一版：这一份提交里没有一个位子是对的，两类话术都要出现才判得动。
    const reversed = [byLabel("主动回忆"), byLabel("复习间隔")];
    assert.ok(reversed.every((id) => id !== ""), "夹具的两个 label 都要能反查回 token id");

    await withWorkspaceTransaction(scope, async (tx) =>
      submitArtifact(tx, {
        ...scope,
        runId: run.runId,
        taskId: run.activeTaskId!,
        request: {
          version: 1 as const,
          variantId: run.activeTask!.activeVariant.variantId,
          variantRevision: run.activeTask!.activeVariant.revision,
          inputSchemaHash: run.activeTask!.activeVariant.inputSchemaHash,
          payload: {
            kind: "ordering" as const,
            orderedTokenIds: reversed,
            interactionRefs: [] as string[],
          } as never,
          runRevision: run.revision,
          taskRevision: run.activeTask!.revision,
          idempotencyKey: "p4-submit-units",
        },
      }),
    );
    for (let round = 0; round < 6; round += 1) {
      await runLearningRunProcessingTick(`p4-worker-units:${randomUUID()}`, 10);
    }

    const rows = await scoped(scope, (tx) => tx`
      SELECT rubric_results, trust_class FROM learning_assessments WHERE run_id = ${run.runId}
    `);
    const entries = rows[0].rubric_results as Array<{
      rubricItemId: string; verdict: string; userFacingReason: string;
    }>;
    const units = entries.filter((item) => /#pos-\d+$/.test(item.rubricItemId));
    assert.equal(units.length, reversed.length, "每个位子都要有一格");
    assert.deepEqual(units.map((item) => item.verdict), reversed.map(() => "missing"));
    for (const unit of units) {
      assert.match(unit.userFacingReason, /^第 \d+ 步还不成立/, `要说清是哪一位：${unit.userFacingReason}`);
      for (const label of Object.values(labels)) {
        assert.ok(
          !unit.userFacingReason.includes(label),
          `不成立的那一位不许写出该放什么（那是绕过曝光记账的泄题）：${unit.userFacingReason}`,
        );
      }
      assert.ok(!unit.userFacingReason.includes("tok:"), "内部 id 不许漏进文案");
    }
    // 逐位格**替掉**了聚合计数那一格，不是加在它后面：结果页那句「N 个要点里证明了 M 个」
    // 是按条目数数的（learning-run-surface.tsx:374），聚合格与它按位拆出的几格说的是同一件事，
    // 两代同屏就是把一件事数两遍。所以条目数必须恰好等于位数，且不再有那条计数文案。
    assert.equal(entries.length, reversed.length, "条目数＝位数，没有重复的那一格");
    assert.ok(
      entries.every((item) => /#pos-\d+$/.test(item.rubricItemId)),
      "ordering 的每一格都得是按位那一格",
    );
    assert.ok(
      !entries.some((item) => item.userFacingReason.includes("个位置正确")),
      "那条计数文案不能再出现第二遍",
    );
    // 档位没被逐位反馈动到：错答仍是 practice_only、仍不产 schedule。
    assert.equal(rows[0].trust_class, "practice_only");
    const afterRun = await withWorkspaceTransaction(scope, async (tx) =>
      getRunPublicView(tx, { ...scope, runId: run.runId }),
    );
    assert.equal(afterRun.phase, "completed");
    assert.equal(afterRun.result?.outcome, "practice_completed");
    assert.deepEqual(afterRun.result?.scheduleImpact, { kind: "none", reasonCode: "practice_only" });
  } finally {
    await seeded.cleanup();
  }
});

test("P4 fail closed：ordering 非法 payload（token 不属于题目）400 拒绝", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const run = await withWorkspaceTransaction(scope, async (tx) =>
      createLearningRunForTest(tx, {
        ...scope,
        request: {
          originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
          goal: "stabilize",
          responsePreference: "structured",
          idempotencyKey: "p4-create-2",
        },
      }),
    );
    const ordering = run.activeTask!.activeVariant.interaction as unknown as {
      kind: "ordering";
      publicTokenIds?: string[];
    };
    const orderingIds = ordering.publicTokenIds ?? [];

    // token 不属于题目 → 400（V2 单 part；伪造 part 引用场景随 bundle 退役）。
    await assert.rejects(
      withWorkspaceTransaction(scope, async (tx) =>
        submitArtifact(tx, {
          ...scope,
          runId: run.runId,
          taskId: run.activeTaskId!,
          request: {
            version: 1,
            variantId: run.activeTask!.activeVariant.variantId,
            variantRevision: run.activeTask!.activeVariant.revision,
            runRevision: run.revision,
            taskRevision: run.activeTask!.revision,
            inputSchemaHash: run.activeTask!.activeVariant.inputSchemaHash,
            payload: {
              kind: "ordering",
              orderedTokenIds: [...orderingIds, "tok:evil"],
              interactionRefs: [],
            },
            idempotencyKey: "p4-submit-evil-2",
          },
        }),
      ),
      (err: unknown) => (err as { code?: string }).code === "payload_variant_mismatch",
    );
  } finally {
    await seeded.cleanup();
  }
});

test("P4 relation 纵切：comparison 快照 → relation 主 Variant → 正确边提交 → facet commit（0 schedule）", async () => {
  const seeded = await seed("comparison");
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const run = await withWorkspaceTransaction(scope, async (tx) =>
      createLearningRunForTest(tx, {
        ...scope,
        request: {
          originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
          goal: "transfer",
          responsePreference: "structured",
          idempotencyKey: "p4-rel-create-1",
        },
      }),
    );
    const relation = run.activeTask!.activeVariant.interaction as {
      kind: "relation_canvas";
      publicNodeIds: string[];
      allowedEdgeKinds: string[];
      publicNodeLabels?: Record<string, string>;
    };
    assert.equal(relation.kind, "relation_canvas");
    assert.equal(relation.publicNodeIds.length, 2);
    assert.ok(relation.publicNodeLabels && Object.keys(relation.publicNodeLabels).length >= 2, "node labels present");
    // V2 planner：结构题走 practice 路径（同 test 1，见 run-planner.ts 的
    // structuredPracticeOnly 失败关闭规则）。
    assert.equal(run.activeTask?.activeVariant.purpose, "practice");
    assert.equal(run.activeTask?.activeVariant.templateTrustCeiling, "practice_only");

    // 正确边从 private solution 的 requiredEdges 确定性读取后提交。
    const solutionRows = await scoped(scope, (tx) => tx`
      SELECT s.solution FROM learning_task_private_solutions s
      WHERE s.variant_id = ${run.activeTask!.activeVariant.variantId} LIMIT 1
    `);
    const requiredEdges = (solutionRows[0]?.solution as { requiredEdges?: unknown[] }).requiredEdges ?? [];
    assert.equal(requiredEdges.length, 1);
    const edge = requiredEdges[0] as { fromNodeId: string; toNodeId: string; edgeKind: string };
    const typedEdge = {
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      edgeKind: edge.edgeKind as "supports",
    };

    await withWorkspaceTransaction(scope, async (tx) =>
      submitArtifact(tx, {
        ...scope,
        runId: run.runId,
        taskId: run.activeTaskId!,
        request: {
          version: 1,
          variantId: run.activeTask!.activeVariant.variantId,
          variantRevision: run.activeTask!.activeVariant.revision,
          runRevision: run.revision,
          taskRevision: run.activeTask!.revision,
          inputSchemaHash: run.activeTask!.activeVariant.inputSchemaHash,
          payload: { kind: "relation", edges: [typedEdge], interactionRefs: [] },
          idempotencyKey: "p4-rel-submit-1",
        },
      }),
    );
    for (let round = 0; round < 6; round += 1) {
      await runLearningRunProcessingTick(`p4-worker:${randomUUID()}`, 10);
    }
    const afterRun = await withWorkspaceTransaction(scope, async (tx) =>
      getRunPublicView(tx, { ...scope, runId: run.runId }),
    );
    assert.equal(afterRun.phase, "completed");
    // 确定性 structured 结算实证对齐：practice_completed（0 canonical / 0 schedule）。
    assert.equal(afterRun.result?.outcome, "practice_completed");
    assert.deepEqual(afterRun.result?.scheduleImpact, { kind: "none", reasonCode: "practice_only" });
    const envelopeRows = await scoped(scope, (tx) => tx`
      SELECT count(*)::int AS n FROM canonical_learning_event_outbox WHERE run_id = ${run.runId}
    `);
    assert.equal(envelopeRows[0].n, 0);
    const schedCount = await sql`
      SELECT count(*)::int AS n FROM review_schedules WHERE workspace_id = ${seeded.workspaceId}
    `;
    assert.equal(schedCount[0].n, 0);
  } finally {
    await seeded.cleanup();
  }
});

test("P4 repair 纵切：repair 偏好 → repair 主 Variant → 正确操作 → facet commit（0 schedule）", { skip: "planV2Run 的快照结构化生成（generateStructuredFromSnapshot）仅覆盖 ordering/relation；repair 任务在 V2 路径无生成入口（generateStructuredBundleTask/repair 属已退役 V1 planner）。如需复活，先补 snapshot→repair 生成器。" }, async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const run = await withWorkspaceTransaction(scope, async (tx) =>
      createLearningRunForTest(tx, {
        ...scope,
        request: {
          originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
          goal: "repair",
          responsePreference: "structured",
          idempotencyKey: "p4-rep-create-1",
        },
      }),
    );
    const repair = run.activeTask!.activeVariant.interaction as {
      kind: "repair";
      publicElementIds: string[];
      allowedOperationKinds: string[];
      replacementOptionIds: string[];
      replacementOptionLabels?: Record<string, string>;
    };
    assert.equal(repair.kind, "repair");
    assert.ok(repair.replacementOptionIds.length >= 2, "含干扰项");
    // §7.7：repair 有 facet 标注 → purpose=facet、ceiling=facet_eligible。
    assert.equal(run.activeTask?.activeVariant.purpose, "facet");
    assert.equal(run.activeTask?.activeVariant.templateTrustCeiling, "facet_eligible");

    const solutionRows = await scoped(scope, (tx) => tx`
      SELECT s.solution FROM learning_task_private_solutions s
      WHERE s.variant_id = ${run.activeTask!.activeVariant.variantId} LIMIT 1
    `);
    const signatures = (solutionRows[0]?.solution as { acceptedOperationSignatures?: string[] }).acceptedOperationSignatures ?? [];
    assert.equal(signatures.length, 1);
    const signature = signatures[0];
    // op:elementId:optionId（元素/选项 id 含冒号，取后两段为 elementId/optionId 需要按生成器格式解析：
    // replace:el:blank:opt:<hash> → elementId=el:blank，optionId=opt:<hash>）。
    const match = signature.match(/^(replace):(el:blank):(opt:[0-9a-f]{10})$/);
    assert.ok(match, `signature shape: ${signature}`);
    const op = match[1] as "replace";
    const elementId = match[2];
    const optionId = match[3];

    await withWorkspaceTransaction(scope, async (tx) =>
      submitArtifact(tx, {
        ...scope,
        runId: run.runId,
        taskId: run.activeTaskId!,
        request: {
          version: 1,
          variantId: run.activeTask!.activeVariant.variantId,
          variantRevision: run.activeTask!.activeVariant.revision,
          runRevision: run.revision,
          taskRevision: run.activeTask!.revision,
          inputSchemaHash: run.activeTask!.activeVariant.inputSchemaHash,
          payload: {
            kind: "repair",
            operations: [{ op, elementId, replacementOptionId: optionId }],
            interactionRefs: [],
          },
          idempotencyKey: "p4-rep-submit-1",
        },
      }),
    );
    for (let round = 0; round < 6; round += 1) {
      await runLearningRunProcessingTick(`p4-worker:${randomUUID()}`, 10);
    }
    const afterRun = await withWorkspaceTransaction(scope, async (tx) =>
      getRunPublicView(tx, { ...scope, runId: run.runId }),
    );
    assert.equal(afterRun.phase, "completed");
    // §7.7 标注后 repair ceiling=facet_eligible：正确操作 → facet_evidence
    // Commit（canonical facet observation + 0 schedule）。
    assert.equal(afterRun.result?.outcome, "partial");
    assert.deepEqual(afterRun.result?.gapFacets, []);
    assert.deepEqual(afterRun.result?.scheduleImpact, { kind: "none", reasonCode: "facet_only" });
    const envelopeRows = await scoped(scope, (tx) => tx`
      SELECT envelope FROM canonical_learning_event_outbox WHERE run_id = ${run.runId}
    `);
    assert.equal(envelopeRows.length, 1, "facet observation envelope 恰好一个");
    assert.equal(
      (envelopeRows[0].envelope as { fact: { disposition: string } }).fact.disposition,
      "facet_evidence",
    );
    const schedCount = await sql`
      SELECT count(*)::int AS n FROM review_schedules WHERE workspace_id = ${seeded.workspaceId}
    `;
    assert.equal(schedCount[0].n, 0, "facet 结算 0 schedule");
  } finally {
    await seeded.cleanup();
  }
});

/**
 * 按 run id 清一场 run。这一份顺序是**真窗口那一读的卡点**：
 * `probe-note-round-practice-entry.mts` 停在「练一道」之前，写的理由就是"全仓没有按 run id 清 run 的
 * 现成顺序，集成测试那套是 workspace 级清扫，会连 owner 的工作区一起删"。
 *
 * 三步各钉一件事，少任何一步这条用例都不算证明了什么：
 * ① 清之前 A **确实留下了账**（含那一笔只能靠 `idempotency_key = 'run-reveal:<runId>'` 认出的曝光）
 *    ——没有这一格，"清完是零"完全可能是读瞎（受限角色无上下文时那是一眼看不出的 0 行）；
 * ② 清之后**现扫**零残差：扫描用的列名单是从 `information_schema` 现读的（认 `*_run_id` 这个形状，
 *    不抄表名单）⇒ 将来新出现一张挂着 run id、而那份手写清单没管的表，会在这里点名，不会静默留下；
 * ③ 另一场 run B **原样留着** ⇒ 这一套不是 workspace 级清扫（那正是剧本不敢用它的理由）。
 *    这一腿**没有配变异**，而且是故意的：`renderPsqlStatementV1` 每一步的右值只能是那个 uuid
 *    （`assertLearningRunIdV1` 卡死形状），拼不出"按 workspace 删"的谓词 ⇒ 过度删除在这一套的数据形状里
 *    是**拼不出来**的，不靠用例守着。试过把它改成 `column: "workspace_id"` 来制造过度删除，
 *    结果红的不是这一腿，是"run 本体没删掉"那一腿（右值仍是 run uuid，什么都匹配不上）——
 *    这条负向读数记在这里，免得下一个人以为对照腿验过了。
 *
 * 清与扫都走带上下文的事务（`scoped`），与文件顶上那段"裸 SQL 校验必须带 workspace/user"同一条理由。
 */
test("按 run id 清一场 run：清前有账、清后零残差、且只清这一场", async () => {
  const seeded = await seed();
  const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };

  const residueSlots = async (): Promise<Array<{ table_name: string; column_name: string }>> =>
    scoped(scope, (tx) => tx.unsafe(learningRunIdColumnsQueryV1) as Promise<Array<{
      table_name: string; column_name: string;
    }>>);

  const residueFor = async (runId: string): Promise<string[]> => {
    const columns = await residueSlots();
    // 地板：发现查询读空 ⇒ 后面的"零残差"是空转，不是干净。
    assert.ok(columns.length > 10,
      `只现读到 ${columns.length} 列在挂 run id ⇒ information_schema 那一读本身空了`);
    const slots = learningRunResidueSlotsV1(
      columns.map((row) => ({ tableName: row.table_name, columnName: row.column_name })),
    );
    const rows = await scoped(scope, (tx) =>
      tx.unsafe(renderPsqlResidueQueryV1(slots, runId)) as Promise<Array<{ slot: string; remaining: string }>>);
    return nonzeroResidueV1(rows);
  };

  const cleanRun = async (runId: string): Promise<Array<{ slot: string; deleted: number }>> => {
    const report: Array<{ slot: string; deleted: number }> = [];
    for (const step of learningRunCleanupStepsV1()) {
      const deleted = await scoped(scope, async (tx) => {
        if (step.maintenanceHatch === "allow_history_mutation") {
          // 只在这一步开维护闸门（生产路径一处都不设它），且 `set_config(..., true)` 是事务级。
          await tx`SELECT set_config('app.allow_history_mutation', 'on', true)`;
        }
        const rows = await tx.unsafe(`${renderPsqlStatementV1(step, runId)} returning 1`);
        return rows.length;
      });
      report.push({ slot: step.slot, deleted });
    }
    return report;
  };

  const openRun = async (key: string) => {
    const created = await withWorkspaceTransaction(scope, async (tx) =>
      createLearningRunForTest(tx, {
        ...scope,
        request: {
          originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
          goal: "stabilize",
          responsePreference: "structured",
          idempotencyKey: key,
        },
      }),
    );
    return created;
  };

  try {
    const runA = await openRun("run-cleanup-a");
    const runB = await openRun("run-cleanup-b");

    // A 走完整一条：ordering 提交 → 确定性评估（全程不调模型）→ **结算之后**才 reveal。
    // 顺序不是随手排的：`revealRunTargetV2` 第一道门就是"这一场有没有 result"
    // （`run-service.ts:1517`，没有就 409 `reveal_not_available`），先点揭示会得到一句真拒绝。
    const ordering = runA.activeTask?.activeVariant.interaction as unknown as {
      publicTokenIds?: string[];
      publicTokenLabels?: Record<string, string>;
    };
    assert.equal(ordering.publicTokenIds?.length ?? 0, 2, "这一格要的是两位的 ordering 题");
    const labels = ordering.publicTokenLabels ?? {};
    const ordered = Object.entries(labels).sort((a, b) => (a[1] < b[1] ? -1 : 1)).map(([id]) => id);
    await withWorkspaceTransaction(scope, async (tx) =>
      submitArtifact(tx, {
        ...scope,
        runId: runA.runId,
        taskId: runA.activeTaskId!,
        request: {
          version: 1 as const,
          variantId: runA.activeTask!.activeVariant.variantId,
          variantRevision: runA.activeTask!.activeVariant.revision,
          inputSchemaHash: runA.activeTask!.activeVariant.inputSchemaHash,
          payload: { kind: "ordering" as const, orderedTokenIds: ordered, interactionRefs: [] as string[] } as never,
          runRevision: runA.revision,
          taskRevision: runA.activeTask!.revision,
          idempotencyKey: "run-cleanup-a-submit",
        },
      }),
    );
    for (let round = 0; round < 6; round += 1) {
      await runLearningRunProcessingTick(`run-cleanup-a:${randomUUID()}`, 10);
    }
    // 结算之后才揭示答案：这一步种下那一笔**只能靠 idempotency_key 认出归属**的曝光。
    await withWorkspaceTransaction(scope, async (tx) =>
      revealRunTargetV2(tx, { ...scope, runId: runA.runId }));

    // ① 清之前：A 确实留下了账，而且留下的正是那一笔认得出 run 的曝光。
    const beforeA = await residueFor(runA.runId);
    assert.ok(beforeA.length > 0, "A 什么都没留下 ⇒ 后面的『清完为零』什么都不是（读瞎的形状）");
    assert.ok(beforeA.some((item) => item.startsWith("learning_exposures_v2")),
      `A 没被现扫认到曝光那一格（它是靠 idempotency_key 挂着的）：${beforeA.join(", ")}`);

    // ② 清：每一步都报删了几行；曝光那一步必须是**真删掉了行**，不是"守卫放过去了"。
    const report = await cleanRun(runA.runId);
    const exposureStep = report.find((item) => item.slot.startsWith("learning_exposures_v2"));
    assert.ok(exposureStep && exposureStep.deleted === 1,
      `曝光那一格没删掉恰好一行：${JSON.stringify(exposureStep)} ⇒ 要么守卫没让路，要么那一笔根本不在`);
    const runStep = report.find((item) => item.slot === "learning_runs（其余 13 张 CASCADE 跟着走）");
    assert.ok(runStep && runStep.deleted === 1, `run 本体没删掉：${JSON.stringify(runStep)}`);

    const afterA = await residueFor(runA.runId);
    assert.deepEqual(afterA, [], `清完仍有残差（清单该补上这些格）：${afterA.join(", ")}`);

    // ③ 对照：B 一行不少地留在原处。
    const bResidue = await residueFor(runB.runId);
    assert.ok(bResidue.length > 0, "对照那场 run 也被清了 ⇒ 这一套其实是 workspace 级清扫");
    const bRow = await scoped(scope, (tx) => tx`
      SELECT count(*)::int AS n FROM learning_runs WHERE id = ${runB.runId}
    `);
    assert.equal(bRow[0].n, 1, "对照那场 run 的行没了");
    const bAssess = await scoped(scope, (tx) => tx`
      SELECT count(*)::int AS n FROM learning_assessments WHERE run_id = ${runB.runId}
    `);
    assert.equal(bAssess[0].n, 0, "B 只创建过、没提交过，不该有评估行（这一格钉的是夹具自己，不是清理）");
  } finally {
    await seeded.cleanup();
  }
});
