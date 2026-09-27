/**
 * 「补一节前置」的读侧（39d W4-6 刀四·正面要求那一档；PRD §16.3、§5.3、§4.3）。
 *
 * 这一份只做三件事，然后把结果交给 `prerequisite-policy.ts` 那个纯函数判：
 *   1. 读出**本轮冻结的那一版**正文块（D3 §5：内容变了就不复用旧产物，判据依据的那份
 *      正文必须是开始这一轮时的那一版，而不是"现在这一版"）；
 *   2. 读出**这一轮已经引用过哪些块**（教学行的 `source_block_ordinals`）——已经讲过的
 *      块不能再当"前置"摆出去，那一档是 `switch_explanation`；
 *   3. 把冻结阈值取出来传给判据。
 *
 * **不生成前置内容**。§5.3 说"指出缺口并提供最小补充"，而"补"那一半要真模型与一次
 * 独立教学产物——那是 W4-6 刀五往后的事。这一刀给的是"**缺哪儿、依据是哪几段、要补
 * 多少**"这三个数，界面据此才能摆出"现在补／留到以后"（§4.3），而不是一颗没有代价的
 * 承诺。把这三样说成"已经补好了"是本文件明确不做的事。
 *
 * 为什么放在 `note-learning-rounds/` 而不是 `learning-runs/`：它要读的是轮次的冻结快照，
 * 那份读取的权威实现在这一层（`loadTeachingSnapshotBlocks`）。跨层去读别处的快照会把
 * "判据依据哪一版正文"这件事复制一份——那正是 D3 反复要求只留一个来源的原因。
 */
import { and, eq } from "drizzle-orm";
import { noteLearningRoundTeachings } from "@ailearn/shared/db-schema/note-learning-rounds";
import type { ApiTransaction } from "../../db/client.ts";
import { readRound } from "./round-service.ts";
import { loadTeachingSnapshotBlocks } from "./teaching-explain.ts";
import {
  prerequisiteLargeBranchThresholdV1,
  proposePrerequisiteV1,
  type PrerequisiteCandidateBlockV1,
  type PrerequisiteProposalV1,
} from "./prerequisite-policy.ts";

export type RoundScopeV1 = { workspaceId: string; userId: string };

/** 读侧加了一层上下文，回给界面时一并给出去（那三样数就是全部的产物）。 */
export type PrerequisiteProposalViewV1 = PrerequisiteProposalV1 & {
  /** 判定用的那一条缺口（与 `readRoundGapHelpV1.gap` 同源，不是另拼的身份）。 */
  readonly gap: { readonly objectiveId: string; readonly intent: string | null } | null;
  /** 冻结阈值，界面用它说明"较大"的界线从哪来（§18.4 冻结项，不是写死的数）。 */
  readonly largeBranchThreshold: number;
};

/**
 * 本轮已引用过的块序号。
 *
 * `source_block_ordinals` 是 jsonb，形状自由：只收数组里的正整数，别的一个都不认。认错了
 * 的后果是"已经讲过的块被当成没讲过"，于是补前置那一档会摆出用户刚看过的东西。
 */
export function usedOrdinalsFromTeachings(rows: Array<{ sourceBlockOrdinals: unknown }>): Set<number> {
  const used = new Set<number>();
  for (const row of rows) {
    if (!Array.isArray(row.sourceBlockOrdinals)) continue;
    for (const value of row.sourceBlockOrdinals) {
      if (typeof value === "number" && Number.isInteger(value) && value > 0) used.add(value);
    }
  }
  return used;
}

/**
 * 读出这一轮的「补一节前置」提案。
 *
 * 轮次读不到时返回 `{ kind: "none", reason: "no_usable_material" }` 而不是抛：这一档是
 * "给你一个可选的建议"，读不到这一轮就没有建议可给，而调用方（结果/教学面）不该因为
 * 拿不到一个**建议**而失败。**但可见性仍由 `readRound` 判**（它按来源笔记判本人可见），
 * 所以这一层不会变成"用别人的轮次 id 就能拿到别人的正文块"的路。
 */
export async function readRoundPrerequisiteProposalV1(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  roundId: string,
  gap: { objectiveId: string; intent: string | null } | null,
): Promise<PrerequisiteProposalViewV1> {
  const largeBranchThreshold = prerequisiteLargeBranchThresholdV1();
  const round = await readRound(tx, scope, roundId);
  if (!round) {
    return { kind: "none", reason: "no_usable_material", gap, largeBranchThreshold };
  }

  const [blocks, teachingRows] = await Promise.all([
    loadTeachingSnapshotBlocks(tx, scope.workspaceId, round.noteVersionId),
    tx
      .select({ sourceBlockOrdinals: noteLearningRoundTeachings.sourceBlockOrdinals })
      .from(noteLearningRoundTeachings)
      .where(and(
        eq(noteLearningRoundTeachings.workspaceId, scope.workspaceId),
        eq(noteLearningRoundTeachings.userId, scope.userId),
        eq(noteLearningRoundTeachings.roundId, roundId),
      )),
  ]);
  const used = usedOrdinalsFromTeachings(teachingRows);
  const candidates: PrerequisiteCandidateBlockV1[] = blocks.map((block) => ({
    ordinal: block.ordinal,
    type: block.type,
    text: block.text,
    usedByCurrentRound: used.has(block.ordinal),
  }));

  return { ...proposePrerequisiteV1({ blocks: candidates, largeBranchThreshold }), gap, largeBranchThreshold };
}
