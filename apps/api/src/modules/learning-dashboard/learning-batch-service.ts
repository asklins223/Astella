/**
 * 有限的一批任务——**读侧**（39d W7-4 刀二；39 §9.4）。
 *
 * 刀一落了判据（`@ailearn/shared/limited-batch-v2` 的 `planLimitedBatchV2`），这一份
 * 负责按它要的形状收候选。两者的分界是纪律：**这一份只读库、不判**；四条规定都在
 * 纯函数里。三处各写一遍判断就是三处会分叉（屏上的批次、首页那一件、伴星读页面说的
 * 批次），而分叉的后果是"这一批里有什么"开始取决于你从哪个页面进来。
 *
 * ## 候选从哪来
 *
 * **一条 `review_schedules` 曾经被消费过**的那些目标——§9.4「已经学过但较久未观察的
 * 内容」。这是"学过"的**可判读**读点：有一条完成过的安排，就说明她被真的问过。
 * 反过来，"她建过目标"**不算**学过（§9.4「未学习的新内容不自动生成到期任务」）。
 *
 * **「最近一次观察」取被消费掉的那一格的时刻**（`review_schedules.updated_at` 的最大值，
 * 只看 `status='completed'`）。取的是**那一格**而不是"她建目标的时刻"：后者会让她
 * 刚做完的卡片永远算"很久没观察"，于是每次都进轮换抽查——而 §9.4 说的轮换是
 * "较久未观察"，不是"建得早"。
 *
 * **「源内容最近改过」取目标行的 `updated_at`**，作为"改过但没动过"那一档的依据
 * （§9.4「未经用户实际接触不作为遗忘处理」——这一档**不进**批次，所以它只用来把
 * 没观察过的候选归到 `never_observed` 而不是别处）。
 *
 * ## 为什么**不**在这里查排除
 *
 * 被「暂不安排」的目标由判据按 `reviewHold` 那一格滤掉（刀一第 3 条）。这一份照旧要
 * 读 `objective_review_holds_v2` 的**活行**——但那是**喂进去**，不是在读侧判"该不该
 * 复活"。判据那一格是唯一说了算的地方。
 */
import { and, eq, inArray, isNull, max } from "drizzle-orm";
import { reviewSchedules } from "@ailearn/shared/db-schema/evidence";
import { objectiveReviewHoldsV2 } from "@ailearn/shared/db-schema/evidence";
import { visibleObjectivesCondition } from "../note/visibility.ts";
import { learningObjectivesV2 } from "@ailearn/shared/db-schema/card-generation-v2";
import {
  planLimitedBatchV2,
  type BatchCandidateV2,
  type LimitedBatchV2,
} from "@ailearn/shared/limited-batch-v2";

export interface LoadLimitedBatchInputV2 {
  readonly workspaceId: string;
  readonly userId: string;
  /** 本批开始时锁的长度。**继续同一批时传上一次交回的 `lockedLength`**——那才是"不自动变长"。 */
  readonly lockedLength: number;
  readonly now: Date;
  /** 她点了「再来几道」才非零；这是长度的**唯一**增长入口（§9.4）。 */
  readonly userAskedForMore?: number;
}

export async function loadLimitedBatchV2(
  tx: Parameters<Parameters<typeof import("../../db/client.ts").withWorkspaceTransaction>[1]>[0],
  input: LoadLimitedBatchInputV2,
): Promise<LimitedBatchV2> {
  // ① 学过（有过被消费的安排）的目标，取每一颗最近一次被消费掉的那一刻。
  const learned = await tx
    .select({
      objectiveId: reviewSchedules.subjectId,
      lastConsumedAt: max(reviewSchedules.updatedAt),
    })
    .from(reviewSchedules)
    .where(and(
      eq(reviewSchedules.workspaceId, input.workspaceId),
      eq(reviewSchedules.userId, input.userId),
      eq(reviewSchedules.status, "completed"),
    ))
    .groupBy(reviewSchedules.subjectId);

  const observedIds = learned.map((row) => row.objectiveId).filter((id): id is string => Boolean(id));
  if (observedIds.length === 0) {
    // 一颗都没学过 ⇒ 没有可回访的内容。这一格**不**去造一批"建议学的东西"——
    // §9.4「未学习的新内容不自动生成到期任务」。
    return planLimitedBatchV2({ candidates: [], lockedLength: input.lockedLength, now: input.now, userAskedForMore: input.userAskedForMore });
  }

  // ② 这些目标当前的形态与最近一次改动（"改过但没动过"那一档的依据）。
  const objectives = await tx
    .select({
      objectiveId: learningObjectivesV2.objectiveId,
      lifecycle: learningObjectivesV2.lifecycle,
      updatedAt: learningObjectivesV2.updatedAt,
    })
    .from(learningObjectivesV2)
    .where(and(
      eq(learningObjectivesV2.workspaceId, input.workspaceId),
      inArray(learningObjectivesV2.objectiveId, observedIds),
      // 归档／被替代的目标不进回访批次：§8.5「停用卡从复习中移除但保留历史」。
      eq(learningObjectivesV2.lifecycle, "active"),
      // **可见性判据（跟着来源笔记判）**——§8.5 那一族：目标的可见性由它那些卡的
      // 来源笔记决定。这一条是 `note-visibility-read-sites` 那把守卫抓出来的：
      // 少了它，**一颗来源笔记已被保护/删掉的目标照样会进这一批**——而这一批是要
      // 在书桌上念出题面的。`lifecycle='active'` **不是**可见性判据，它只管退役。
      visibleObjectivesCondition(input.userId, learningObjectivesV2.objectiveId),
    ));
  const liveIds = objectives.map((row) => row.objectiveId);

  // ③ 被本人「暂不安排」的**活行**——喂给判据，不在读侧自己判。
  const holds = liveIds.length > 0
    ? await tx
      .select({ objectiveId: objectiveReviewHoldsV2.objectiveId, createdAt: objectiveReviewHoldsV2.createdAt })
      .from(objectiveReviewHoldsV2)
      .where(and(
        eq(objectiveReviewHoldsV2.workspaceId, input.workspaceId),
        eq(objectiveReviewHoldsV2.userId, input.userId),
        isNull(objectiveReviewHoldsV2.releasedAt),
        inArray(objectiveReviewHoldsV2.objectiveId, liveIds),
      ))
    : [];
  const heldById = new Map(holds.map((row) => [row.objectiveId, { createdAt: row.createdAt.toISOString() }]));

  const lastConsumedById = new Map(learned.map((row) => [row.objectiveId, row.lastConsumedAt]));
  const updatedById = new Map(objectives.map((row) => [row.objectiveId, row.updatedAt]));

  const candidates: BatchCandidateV2[] = liveIds.map((objectiveId) => {
    const lastConsumedAt = lastConsumedById.get(objectiveId) ?? null;
    const updatedAt = updatedById.get(objectiveId) ?? null;
    return {
      objectiveId,
      observed: Boolean(lastConsumedAt),
      lastObservedAt: lastConsumedAt,
      reviewHold: heldById.get(objectiveId) ?? null,
      // "改过但没动过"：目标行的最近改动晚于她最后一次观察。判据那一档不把它当遗忘。
      sourceChangedAt: updatedAt && lastConsumedAt && updatedAt > lastConsumedAt ? updatedAt : null,
      reasonLine: describeWhyV2(lastConsumedAt, heldById.has(objectiveId)),
    };
  });

  return planLimitedBatchV2({
    candidates,
    lockedLength: input.lockedLength,
    now: input.now,
    userAskedForMore: input.userAskedForMore,
  });
}

/**
 * §9.4「优先级理由**可解释**」的那一句文案。
 *
 * 由**读侧**给、判据逐字带过去（刀一那一份不许自己编一句）——因为"多久"这个数只有
 * 读侧知道，而"这句话该怎么说"是产品的话术，两边各写一遍就会分叉。
 */
function describeWhyV2(lastConsumedAt: Date | null, held: boolean): string {
  if (held) return "你说过先不安排它，所以这一批里没有它。";
  if (!lastConsumedAt) return "新学的内容，先提示你、不会自动排进复习。";
  const days = Math.floor((Date.now() - lastConsumedAt.getTime()) / 86_400_000);
  if (days <= 0) return "最近看过，可以再回访一次。";
  if (days < 21) return `${days} 天前看过，现在回访一次。`;
  return `${days} 天没有回访了，抽一道看看还记不记得。`;
}
