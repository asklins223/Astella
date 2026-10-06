/**
 * Plan 23 W2-01/W2-02/W2-09/W2-10/W2-17：Origin 写/读 + Surface 装配集成测试。
 *
 * 在纯 V2 fixture 工作区（4f825f38-…）上验证：
 *  - Surface 可读、可行动、无私有泄漏（findPrivatePayloadLeaks=0）；
 *  - Origin 幂等创建（第二次 created=false）；
 *  - Origin 写入后 Surface 的 sources 立即反映（missingOrigin=false）；
 *  - 不存在的 objective revision 被拒绝（跨 workspace/幽灵绑定防护）。
 *
 * 运行：DATABASE_URL=postgres://astella:astella_dev@localhost:5432/astella
 *   node --import tsx --test src/integration-tests/learning-objectives-surface.integration.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { findPrivatePayloadLeaks } from "@astella/shared";
import { hashCanonicalV2 } from "@astella/shared/hash-canonical-v2";
import { objectiveListItemV3Schema } from "@astella/shared/learning-objective-surface-contracts";
import { eq, and } from "drizzle-orm";
import {
  evidenceQuoteCopiesV2,
  evidenceSnapshotsV2,
  learningObjectivesV2,
  learningObjectiveOriginsV2,
} from "@astella/shared/db-schema/card-generation-v2";
import { noteBlocks, noteVersions, notes } from "@astella/shared/db-schema/note";

// db client 在 import 时读取 DATABASE_URL；必须先设置再动态 import。
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
process.env.DATABASE_URL ??= testDatabaseUrl("DATABASE_URL");
// 自播种纯 V2 工作区（替代被 0176 清库抹掉的手工工作区 4f825f38-…）。
const pgSql = (await import("postgres")).default(process.env.DATABASE_URL, { max: 1 });
const { seedPureV2Workspace } = await import("./helpers/pure-v2-workspace-fixture.ts");
const pureV2 = await seedPureV2Workspace(pgSql, { objectiveCount: 3 });
const FIXTURE_WORKSPACE = pureV2.workspaceId;
const SYSTEM_USER = pureV2.userId;
const [{ withWorkspaceTransaction }, { assembleObjectiveSurfaceV3, toObjectiveListItemV3 }, { createObjectiveOrigin, listOriginsByObjective }, { readNoteChangeImpactsV1 }] =
  await Promise.all([
    import("../db/client.ts"),
    import("../modules/learning-objectives/surface-service.ts"),
    import("../modules/learning-objectives/origin-service.ts"),
    import("../modules/learning-objectives/change-impact-service.ts"),
  ]);

after(async () => {
  await pureV2.cleanup();
  await pgSql.end({ timeout: 2 });
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase();
});

async function firstActiveObjectiveId(): Promise<string> {
  return withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    async (tx) => {
      const rows = await tx
        .select({ objectiveId: learningObjectivesV2.objectiveId })
        .from(learningObjectivesV2)
        .where(and(
          eq(learningObjectivesV2.workspaceId, FIXTURE_WORKSPACE),
          eq(learningObjectivesV2.lifecycle, "active"),
        ))
        .limit(1);
      assert.ok(rows[0], "fixture 工作区必须有 active Objective");
      return rows[0].objectiveId;
    },
  );
}

test("W2-17: 纯 V2 fixture 的 active Objective 可装配为可行动、无泄漏 Surface", async () => {
  const objectiveId = await firstActiveObjectiveId();
  const assembled = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) =>
      assembleObjectiveSurfaceV3(
        tx,
        { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
        objectiveId,
      ),
  );
  assert.equal(assembled.objectiveId, objectiveId);
  assert.equal(assembled.version, 3);
  assert.ok(assembled.content.publicSummary.length > 0, "publicSummary 必须非空");
  assert.equal(assembled.content.lifecycle, "active");
  // 尚无 Origin backfill → missingOrigin=true；action 必须可行动
  assert.equal(assembled.sources.missingOrigin, true);
  assert.ok(
    assembled.primaryAction.kind === "create_run" || assembled.primaryAction.kind === "resume_run",
    "纯 V2 fixture 主行动必须可执行（create/resume），实际 " + assembled.primaryAction.kind,
  );
  assert.deepEqual(findPrivatePayloadLeaks(assembled), []);
  const serialized = JSON.stringify(assembled);
  assert.ok(!serialized.includes("canonicalAnswer"));
  assert.ok(!serialized.includes("scoringRubric"));
});

test("W2-01/W2-02: Origin 幂等创建 + Surface sources 立即反映 + revision 校验", async () => {
  const objectiveId = await firstActiveObjectiveId();
  const revisionId = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    async (tx) => {
      const rows = await tx
        .select({ revisionId: learningObjectivesV2.currentObjectiveRevisionId })
        .from(learningObjectivesV2)
        .where(eq(learningObjectivesV2.objectiveId, objectiveId))
        .limit(1);
      assert.ok(rows[0].revisionId, "fixture objective 必须有 current revision");
      return rows[0].revisionId!;
    },
  );

  const originId = randomUUID();
  const first = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) =>
      createObjectiveOrigin(tx, FIXTURE_WORKSPACE, {
        originId,
        objectiveId,
        objectiveRevisionId: revisionId,
        kind: "manual",
      }),
  );
  assert.equal(first.created, true);
  assert.equal(first.origin.kind, "manual");

  // 幂等：同一 originId 再次创建 → created=false
  const second = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) =>
      createObjectiveOrigin(tx, FIXTURE_WORKSPACE, {
        originId,
        objectiveId,
        objectiveRevisionId: revisionId,
        kind: "manual",
      }),
  );
  assert.equal(second.created, false);
  assert.equal(second.origin.originId, originId);

  // 不存在的 revision → 拒绝（防跨 workspace/幽灵绑定）
  await assert.rejects(
    withWorkspaceTransaction(
      { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
      (tx) =>
        createObjectiveOrigin(tx, FIXTURE_WORKSPACE, {
          originId: randomUUID(),
          objectiveId,
          objectiveRevisionId: randomUUID(),
          kind: "manual",
        }),
    ),
    /does not exist in workspace/,
  );

  // Surface sources 立即反映
  const assembled = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) =>
      assembleObjectiveSurfaceV3(
        tx,
        { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
        objectiveId,
      ),
  );
  assert.equal(assembled.sources.missingOrigin, false);
  assert.equal(assembled.sources.origins.length, 1);
  assert.equal(assembled.sources.origins[0].kind, "manual");

  // 按 objective 读
  const byObjective = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) => listOriginsByObjective(tx, FIXTURE_WORKSPACE, objectiveId),
  );
  assert.equal(byObjective.length, 1);

  // 清理测试数据
  await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) =>
      tx
        .delete(learningObjectiveOriginsV2)
        .where(and(
          eq(learningObjectiveOriginsV2.workspaceId, FIXTURE_WORKSPACE),
          eq(learningObjectiveOriginsV2.originId, originId),
        )),
  );
});

test("D3: note-filtered objective list distinguishes preserved, changed, and unavailable evidence", async () => {
  const objectiveId = await firstActiveObjectiveId();
  const noteId = randomUUID();
  const oldVersionId = randomUUID();
  const currentVersionId = randomUUID();
  const oldBlockId = randomUUID();
  const currentBlockId = randomUUID();
  const evidenceWithCopyId = randomUUID();
  const evidenceWithoutCopyId = randomUUID();
  const sourceSnapshotId = randomUUID();
  const quote = "甲句子不变。";
  const oldBlockContent = `${quote}旧段落`;
  const changedBlockContent = "甲句子改了。旧段落";
  const quoteHash = hashCanonicalV2("evidence-quote", { quote });

  const objectiveRevisionId = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    async (tx) => {
      const [objective] = await tx.select({ revisionId: learningObjectivesV2.currentObjectiveRevisionId })
        .from(learningObjectivesV2)
        .where(and(eq(learningObjectivesV2.workspaceId, FIXTURE_WORKSPACE), eq(learningObjectivesV2.objectiveId, objectiveId)))
        .limit(1);
      assert.ok(objective?.revisionId);

      await tx.insert(notes).values({
        id: noteId,
        workspaceId: FIXTURE_WORKSPACE,
        title: "D3 影响判定夹具",
        createdBy: SYSTEM_USER,
        shareScope: "private",
      });
      await tx.insert(noteVersions).values([
        { id: oldVersionId, noteId, workspaceId: FIXTURE_WORKSPACE, versionNo: 1,
          contentJson: { blocks: [{ type: "paragraph", content: oldBlockContent }] },
          contentHash: "11111111111111111111111111111111", createdBy: SYSTEM_USER },
        { id: currentVersionId, noteId, workspaceId: FIXTURE_WORKSPACE, versionNo: 2,
          contentJson: { blocks: [{ type: "paragraph", content: changedBlockContent }] },
          contentHash: "22222222222222222222222222222222", createdBy: SYSTEM_USER },
      ]);
      await tx.update(notes).set({ currentVersionId }).where(eq(notes.id, noteId));
      await tx.insert(noteBlocks).values([
        { id: oldBlockId, versionId: oldVersionId, workspaceId: FIXTURE_WORKSPACE, ordinal: 1, type: "paragraph", content: oldBlockContent },
        { id: currentBlockId, versionId: currentVersionId, workspaceId: FIXTURE_WORKSPACE, ordinal: 1, type: "paragraph", content: changedBlockContent },
      ]);
      await tx.insert(evidenceSnapshotsV2).values([
        { workspaceId: FIXTURE_WORKSPACE, evidenceSnapshotId: evidenceWithCopyId, evidenceSnapshotHash: "a".repeat(64),
          sourceSnapshotId, noteId, blockId: oldBlockId, startOffset: 0, endOffset: quote.length,
          quoteHash, blockContentHash: hashCanonicalV2("block", { content: oldBlockContent }), sourceContentHash: "b".repeat(64) },
        { workspaceId: FIXTURE_WORKSPACE, evidenceSnapshotId: evidenceWithoutCopyId, evidenceSnapshotHash: "c".repeat(64),
          sourceSnapshotId, noteId, blockId: oldBlockId, startOffset: 0, endOffset: quote.length,
          quoteHash, blockContentHash: hashCanonicalV2("block", { content: oldBlockContent }), sourceContentHash: "b".repeat(64) },
      ]);
      await tx.insert(evidenceQuoteCopiesV2).values({
        workspaceId: FIXTURE_WORKSPACE, evidenceSnapshotId: evidenceWithCopyId, quoteText: quote, quoteHash,
      });
      await createObjectiveOrigin(tx, FIXTURE_WORKSPACE, {
        originId: randomUUID(), objectiveId, objectiveRevisionId: objective.revisionId,
        kind: "note", noteId, noteVersionId: oldVersionId,
        evidenceSnapshotIds: [evidenceWithCopyId, evidenceWithoutCopyId],
      });
      return objective.revisionId;
    },
  );
  assert.ok(objectiveRevisionId);

  const readImpact = () => withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) => readNoteChangeImpactsV1(tx, { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER }, noteId, [objectiveId]),
  );

  const changed = (await readImpact()).get(objectiveId);
  assert.equal(changed?.status, "affected");
  assert.equal(changed?.layer, 3);
  assert.equal(changed?.changedEvidenceCount, 1);
  assert.equal(changed?.uncertainEvidenceCount, 1, "缺原文副本的那条依据必须保留为不确定");
  assert.equal(changed?.reasonCode, "mixed_evidence");
  assert.ok(changed);
  const changedSurface = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) => assembleObjectiveSurfaceV3(tx, { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER }, objectiveId),
  );
  assert.equal(changedSurface.noteChangeImpact?.status, "affected");
  assert.equal(changedSurface.noteChangeImpact?.reasonCode, "mixed_evidence");
  assert.equal(changedSurface.noteChangeImpact?.evidenceDetails[0]?.currentQuote, "甲句子改了。");
  const changedItem = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    async () => objectiveListItemV3Schema.parse(toObjectiveListItemV3(changedSurface, changed)),
  );
  assert.equal(changedItem.noteChangeImpact?.status, "affected");
  assert.equal(changedItem.freshness, "source_outdated", "内容新鲜度与目标证据影响必须分开提供");

  await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) => tx.update(noteBlocks).set({ content: oldBlockContent }).where(eq(noteBlocks.id, currentBlockId)),
  );
  const preserved = (await readImpact()).get(objectiveId);
  assert.equal(preserved?.status, "unaffected");
  assert.equal(preserved?.layer, 2, "同序号块哈希相同是最高确定度的未受影响证据");
  const preservedSurface = await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) => assembleObjectiveSurfaceV3(tx, { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER }, objectiveId),
  );
  assert.equal(preservedSurface.noteChangeImpact, null, "unchanged evidence does not add a pause notice to the objective detail");

  await withWorkspaceTransaction(
    { workspaceId: FIXTURE_WORKSPACE, userId: SYSTEM_USER },
    (tx) => tx.update(noteBlocks).set({ content: `${quote}新添例子` }).where(eq(noteBlocks.id, currentBlockId)),
  );
  const missingCopy = (await readImpact()).get(objectiveId);
  assert.equal(missingCopy?.status, "uncertain", "引用仍在但旧副本缺失时不能替它宣告未受影响");
  assert.equal(missingCopy?.layer, 4);
});
