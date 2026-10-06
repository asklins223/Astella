/**
 * `@astella/card-generation` — 制卡领域服务。
 *
 * 这里是**制卡这件事本身**的实现，不属于任何宿主：API 端点、worker 的简化链
 * handler、将来的 Agent 工具都调这里那**同一份**。它不认识 Fastify、不认识
 * React、不认识 provider、不读 env、也不自己开事务——它拿到的是调用方给的
 * 那一段事务的执行器（见 `transaction.ts` 的窄端口）。
 *
 * 依赖方向只有一条：`card-generation → @astella/shared`。**没有**反向 import
 * API / worker / agent-core / agent-host，也没有第二条制卡链。
 *
 * 注意分工：这一层只负责**创建事务、来源 seal、run 事件与错误类**。审核、
 * 激活、提醒、领域事件与简化链的执行都留在各自原来的地方——它们没有跟着搬，
 * 也没有被复制。
 */

export { CardGenerationV2ServiceError } from "./errors.ts";
export { ACTIVE_GENERATION_RUN_STATUSES } from "./types.ts";
export type { RunContext } from "./types.ts";
export { insertEvent, insertEventBatch } from "./events.ts";
export {
  sealEvidenceSnapshotsV2,
  filterBlocksBySourceScope,
  computeSealedEvidenceSnapshotHashV2,
} from "./evidence-seal.ts";
export type {
  SealEvidenceResultV2,
  EvidenceSealBlock,
  SealedEvidenceEntryV2,
  EvidenceSealManifestV2,
  SealEvidenceInput,
} from "./evidence-seal.ts";
export { createGenerationRunInTransaction } from "./creation.ts";
export type { CardGenerationRunLimits } from "./creation.ts";
export type {
  CardGenerationRunCreationTx,
  CardGenerationEventTx,
  CardGenerationEvidenceSealTx,
  CardGenerationNoteQuery,
} from "./transaction.ts";