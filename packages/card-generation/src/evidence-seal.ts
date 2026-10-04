/**
 * 方案 20 R4：Evidence Seal 的**唯一 DB 写入**（§14.1/§14.3/§10.1 step 1-2）。
 *
 * 2026-08-24（AI 设计审查 §4.4 第二批）：纯逻辑（类型/sourceScope 过滤/hash/
 * seal 计划构建）已下沉至 packages/shared 的 card-generation-v2-pipeline
 * （evidence-seal-core.ts），worker 经子路径平级消费，消除反向依赖。
 * 2026-10-04：连这层 IO 壳也从 `apps/api/src/modules/card-generation-v2/
 * evidence-seal-service.ts` 搬进制卡领域包（创建事务是它唯一的生产调用方）。
 *
 * **纯规则仍然只有 shared 那一份**——本文件只负责把 shared 计算出的
 * snapshot/eligibility 行在 source_sealing 事务内落库（幂等：onConflictDoNothing）。
 * 下面的 `filterBlocksBySourceScope` / `computeSealedEvidenceSnapshotHashV2` 是
 * 对 shared 的转出（调用点 import 这里的路径即可），不是复制。
 */
import {
  evidenceSnapshotsV2,
  evidenceEligibilityStatesV2,
  evidenceQuoteCopiesV2,
} from "@ailearn/shared/db-schema/card-generation-v2";
import {
  filterBlocksBySourceScope,
  computeSealedEvidenceSnapshotHashV2,
  planEvidenceSnapshotsV2,
  type EvidenceSealBlock,
  type SealedEvidenceEntryV2,
  type EvidenceSealManifestV2,
  type SealEvidenceInput,
} from "@ailearn/shared/card-generation-v2-pipeline";
import type { CardGenerationEvidenceSealTx } from "./transaction.ts";

export type {
  EvidenceSealBlock,
  SealedEvidenceEntryV2,
  EvidenceSealManifestV2,
  SealEvidenceInput,
};
export {
  filterBlocksBySourceScope,
  computeSealedEvidenceSnapshotHashV2,
};

/** seal 结果：manifest + sourceContentHash（与 generation-run 闭包一致）。 */
export interface SealEvidenceResultV2 {
  manifest: EvidenceSealManifestV2;
  sourceContentHash: string;
}

/**
 * §10.1 step 1-2：在 source_sealing 事务内 seal evidence snapshots + eligibility。
 *
 * 纯逻辑计算在 shared 的 planEvidenceSnapshotsV2；本壳只负责两批 INSERT。
 * 幂等策略：对同一 (workspaceId, evidenceSnapshotId) 已存在则跳过（重复 seal
 * 不产生重复 eligibility）；范围内任一 block 生成一条 snapshot。
 */
export async function sealEvidenceSnapshotsV2(
  tx: CardGenerationEvidenceSealTx,
  input: SealEvidenceInput,
): Promise<SealEvidenceResultV2> {
  const plan = planEvidenceSnapshotsV2(input);
  const { noteVersionId, sourceScope } = input;

  if (plan.snapshotRows.length > 0) {
    await tx.insert(evidenceSnapshotsV2).values(plan.snapshotRows).onConflictDoNothing();
  }
  // 0275 / doc 34 L21 §1：同一次密封把原文副本也写进去（只写一次；重复密封 DO NOTHING，
  // 绝不用后来的文本覆盖已经冻住的那一份）。
  if (plan.quoteCopyRows.length > 0) {
    await tx.insert(evidenceQuoteCopiesV2).values(plan.quoteCopyRows).onConflictDoNothing();
  }
  if (plan.eligibilityRows.length > 0) {
    await tx.insert(evidenceEligibilityStatesV2).values(plan.eligibilityRows).onConflictDoNothing();
  }

  const manifest: EvidenceSealManifestV2 = {
    workspaceId: input.workspaceId,
    sourceSnapshotId: input.sourceSnapshotId,
    noteId: input.noteId,
    noteVersionId,
    sourceScope,
    evidence: plan.manifestEvidence,
  };

  // runId 仅用于日志/审计记录；不需要写 run 表（manifest 可由
  // evidence_snapshots_v2 按 sourceSnapshotId 重算）。
  void input.runId;

  return { manifest, sourceContentHash: plan.sourceContentHash };
}