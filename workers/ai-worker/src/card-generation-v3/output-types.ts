/**
 * 简化链两个任务的**输出类型**（39d W7-1 刀a）。
 *
 * 单独一份是为了断掉循环：`tasks.ts` 要返回这两个形状，`plan-assembly.ts` 又要调
 * `tasks.ts` 的草稿级校验，两份类型住在第三处，两个方向都只是取类型。
 */
import type {
  CardContentCheckV3Output,
  CardGenerateV3DraftOutput,
} from "@astella/shared/card-generation-v3-contracts";

export interface CardGenerateV3DroppedCandidate {
  readonly objectiveLocalId: string;
  readonly reason: string;
}

export interface CardGenerateV3TaskOutput {
  readonly parsed: CardGenerateV3DraftOutput;
  /** 程序校验剔除的候选与原因（39c §6.1：剔除留痕，不让整份输出陪葬）。 */
  readonly droppedCandidates: ReadonlyArray<CardGenerateV3DroppedCandidate>;
  /** 剔除后仍可落库的候选数；commit 据此写 plan＋候选行。 */
  readonly acceptedCount: number;
}

export interface CardContentCheckV3TaskOutput {
  readonly parsed: CardContentCheckV3Output;
  /** 批量检查没给出结论的候选（已按 `check_missing` 记为依据不足，这里只是留数）。 */
  readonly unchecked: ReadonlyArray<string>;
}
