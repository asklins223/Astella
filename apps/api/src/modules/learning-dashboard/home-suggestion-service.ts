/**
 * 首页「只推一件」的**那一发**（39d W7-4 刀六；39 §12.1）。
 *
 * 刀四落了判据、刀五落了「本次」的落点，这一刀把两者**接起来**：读侧收候选 → 读今天
 * 已略过的 → 交给判据 → 交回 wire。两个动作也走同一发（记下去之后**顺带**算出下一件），
 * 所以屏上按一下「换一个」立刻看到另一件，而不是"空一下再刷"。
 *
 * ## 候选从哪来
 *
 * 三档来意各有一个读点，**不共用一个查询**——共用就意味着三档要并成一张表排序，而
 * §12.1 的排序是**档位**不是时间：
 *  - `user_named`：她**明确指定**的任务。落点是 `learning_runs` 里那一行
 *    `client_request_id` 带 `user_named` 标记的未完轮次（由调用方喂，理由要念得出）。
 *  - `unfinished_run`：仍愿意继续的未完轮次（`status` 还在跑或停在可继续的那几档）。
 *  - `authorized_review`：**已授权回访**——那一颗就是刀一/二/三算出来的那一批。
 *
 * **「不因一个旧暂停轮次存在就永久挡住其他需求」由判据兜住**（它滤 `pausedRun`），
 * 这一层不重复判——两处各判一次就是两处会分叉。
 */
import type { ApiTransaction } from "../../db/client.ts";
import {
  decideHomeSuggestionV2,
  type NextStepCandidateV2,
} from "@ailearn/shared/home-suggestion-v2";
import type {
  HomeSuggestionActionResultV2,
  HomeSuggestionWireV2,
} from "@ailearn/shared/review-queue-v2-contracts";
import {
  dismissedHomeItemsForTodayV2,
  recordHomeSuggestionActionV2,
  type HomeSuggestionActionV2,
} from "./home-suggestion-actions-service.ts";
import { loadLimitedBatchV2 } from "./learning-batch-service.ts";
import {
  isBatchPausedV2,
  readOrStartDailyBatchV2,
  setBatchPausedV2,
  shrinkBatchV2,
} from "./daily-batch-lock-service.ts";

export type HomeScope = { workspaceId: string; userId: string };

/**
 * **未完轮次**那一档的候选，由**调用方**读出来喂进来。
 *
 * ⚠️ **那一档的读侧还没写**。这一份**不假装它存在**：run 的读面（哪些轮次"仍愿意继续"、
 * 哪些是"明确指定"的、标题与理由从哪几列取）要按 §12.1 的语义单独读——并进
 * `buildLearningDashboardV2` 会让首页排序跟着 dashboard 的形状长，而 §12.1 的排序是
 * **档位**不是时间。所以这里收一个入参，缺省空数组 ⇒ 那一档今天不出现在首页上，
 * 而不是编一条读侧出来。**写那一档是刀七。**
 */
export interface HomeRunCandidateInputV2 {
  readonly kind: "user_named" | "unfinished_run";
  readonly itemKey: string;
  readonly headline: string;
  /** §12.1「推荐附一句理由」——必填且非空（空的在判据里会被拒，宁可空态）。 */
  readonly reasonLine: string;
  readonly updatedAt: Date;
  readonly pausedRun?: boolean;
}

/** 把判据的结果**压成 wire**：两档在这里显式分开，渲染层拿不到"忘了判 kind"的机会。 */
function toWireV2(decided: ReturnType<typeof decideHomeSuggestionV2>): HomeSuggestionWireV2 {
  if (decided.kind === "nothing_due") {
    return { kind: "nothing_due", emptyActions: [...decided.emptyActions] };
  }
  return {
    kind: "suggested",
    itemKey: decided.item.itemKey,
    kindOfItem: decided.item.kind,
    headline: decided.item.headline,
    reasonLine: decided.item.reasonLine,
    swappableCount: decided.swappableCount,
  };
}

/** 收候选。三档各一个读点，**不并成一张表排序**（§12.1 的排序是档位不是时间）。 */
async function collectCandidatesV2(
  tx: ApiTransaction,
  ctx: HomeScope & {
    timeZone: string;
    now: Date;
    runCandidates?: readonly HomeRunCandidateInputV2[];
  },
): Promise<NextStepCandidateV2[]> {
  const candidates: NextStepCandidateV2[] = [];

  // ① 明确指定的任务 ＋ 仍愿意继续的未完轮次：**由调用方读出来喂进来**（读侧未写，见上面
  //   `HomeRunCandidateInputV2` 的头注）。缺省空 ⇒ 那一档今天不出现在首页上。
  for (const run of ctx.runCandidates ?? []) {
    candidates.push({
      kind: run.kind,
      headline: run.headline,
      // 理由**必填**：§12.1「推荐附一句理由」。空的那一条在判据里会被拒（宁可空态）。
      reasonLine: run.reasonLine,
      itemKey: run.itemKey,
      updatedAt: run.updatedAt,
      pausedRun: run.pausedRun,
    });
  }

  // ② 已授权回访：刀一/二/三算出来的那一批（**经同一个读侧**），所以首页与批次是同一批。
  const lockedLength = await readOrStartDailyBatchV2(tx, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    timeZone: ctx.timeZone,
    now: ctx.now,
  });
  const batch = await loadLimitedBatchV2(tx, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    lockedLength,
    now: ctx.now,
  });
  for (const entry of batch.items) {
    candidates.push({
      kind: "authorized_review",
      headline: `继续今天这一批的回访（第 ${batch.items.indexOf(entry) + 1} 道）`,
      reasonLine: entry.reasonLine,
      itemKey: `batch:${entry.objectiveId}`,
      updatedAt: ctx.now,
    });
  }

  return candidates;
}

/** 读侧。§12.1「首页只推荐一件」的那一件，或空态的三个入口。 */
export async function readHomeSuggestionV2(
  tx: ApiTransaction,
  ctx: HomeScope & { timeZone: string; now?: Date; runCandidates?: readonly HomeRunCandidateInputV2[] },
): Promise<HomeSuggestionWireV2> {
  const now = ctx.now ?? new Date();
  const candidates = await collectCandidatesV2(tx, { ...ctx, now });
  const dismissed = await dismissedHomeItemsForTodayV2(tx, {
    workspaceId: ctx.workspaceId, userId: ctx.userId, timeZone: ctx.timeZone, now,
  });
  return toWireV2(decideHomeSuggestionV2({ candidates, dismissedThisSession: dismissed }));
}

/**
 * 「换一个」/「暂不处理」。**顺带**交回下一件——屏上按一下就要立刻看到另一件。
 *
 * 两个动作走同一发：它们只差 `action` 那一档与屏上的文案，而分开写就是两处会分叉
 * （其中一处很可能忘了把略过的那一项喂回判据）。
 */
export async function actOnHomeSuggestionV2(
  tx: ApiTransaction,
  ctx: HomeScope & {
    timeZone: string;
    itemKey: string;
    action: HomeSuggestionActionV2;
    now?: Date;
  },
): Promise<HomeSuggestionActionResultV2> {
  const now = ctx.now ?? new Date();
  await recordHomeSuggestionActionV2(tx, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    timeZone: ctx.timeZone,
    now,
    itemKey: ctx.itemKey,
    action: ctx.action,
  });
  return { action: ctx.action, suggestion: await readHomeSuggestionV2(tx, { ...ctx, now }) };
}

/**
 * 今日复习那三个动作的**那一发**（39d W7-4 刀十二；§12 表「今日复习」行）。
 *
 * 三档走**同一发**：它们只差 `action` 那一档与屏上的文案，而分成三个入口就是三处会
 * 分叉——其中一处很可能忘了把 `remaining` 原样带回判据，而那正是 §12 表「剩余需求
 * 不伪称完成」那一格要防的。
 *
 * ## `remaining` 从**库里数**，不是从入参拿
 *
 * 数法：**已锁长度 减去 已被消费掉的那几道**。也就是"这一批本来有多长、其中几道已经
 * 做了"。这个数**只能从库里数**——入参带一个数上来的话，那一句「剩下 N 道还在」就
 * 变成屏上的一句断言，而它没跟任何东西对过账。
 *
 * 减量之后再数时，**已做的那几道不因为批次变短而消失**：她已经做了的那几道是她做了
 * 的。所以 `remaining = max(0, 新长度 − 已做)`，而"已做"要按**这一批的项**数，不是按
 * 新长度截断——否则减量到 2 就会说"你做了 3 道、今天到此为止"，那是把三道做掉的事实
 * 抹成 2。
 */
export async function actOnTodayBatchV2(
  tx: ApiTransaction,
  ctx: HomeScope & {
    timeZone: string;
    action: "reduce" | "pause" | "resume";
    reduceBy?: number;
    now?: Date;
  },
): Promise<{
  action: "reduce" | "pause" | "resume";
  lockedLength: number;
  paused: boolean;
  remaining: number;
  screenLine: string;
}> {
  const now = ctx.now ?? new Date();
  const { decideTodayBatchOptionV2 } = await import("@ailearn/shared/today-batch-options-v2");
  const lockInput = { workspaceId: ctx.workspaceId, userId: ctx.userId, timeZone: ctx.timeZone, now };

  const lockedLengthBefore = await readOrStartDailyBatchV2(tx, { ...lockInput });
  // 库里数「已做」：今天这一批的项里，被消费掉的那几道。
  const doneCount = await countBatchItemsDoneV2(tx, { ...ctx, now });
  const remainingBefore = Math.max(0, lockedLengthBefore - doneCount);

  let lockedLength = lockedLengthBefore;
  let paused = (await isBatchPausedV2(tx, lockInput)).paused;
  if (ctx.action === "reduce") {
    lockedLength = (await shrinkBatchV2(tx, { ...lockInput, by: ctx.reduceBy ?? 0 })).lockedLength;
  } else {
    const set = await setBatchPausedV2(tx, { ...lockInput, paused: ctx.action === "pause" });
    lockedLength = set.lockedLength;
    paused = set.paused;
  }

  // **已做的不因为批次变短而消失**——她已经做了的那几道是她做了的。所以减量到 2 之后
  // 说"你做了 3 道"是**对的**，而把三道抹成 2 才是失真。
  const remaining = Math.max(0, lockedLength - doneCount);
  const decided = decideTodayBatchOptionV2(
    { lockedLength, remaining, paused, reduceBy: ctx.reduceBy },
    ctx.action,
  );
  return {
    action: decided.action,
    lockedLength: decided.lockedLength,
    paused: decided.paused,
    remaining: remainingBefore,
    screenLine: decided.screenLine,
  };
}

/**
 * 今天这一批里**已做**的数。
 *
 * 口径：**0305 那一行的 `created_at` 之后**被消费掉的安排数。不用"今天"做下界是因为
 * 按 UTC 切会在她的午夜前后数错，而那一次恰好是"她刚做完今天"的时候。
 *
 * 宁可多算一道不可少算：多算让"剩下 N 道"偏小（保守），少算让它偏大——**后者才是
 * "伪称完成"那一侧**。这一句写在这里，是为了让下一次收紧它的人知道现在为什么这么松。
 */
async function countBatchItemsDoneV2(
  tx: ApiTransaction,
  ctx: HomeScope & { timeZone: string; now: Date },
): Promise<number> {
  const { and, eq, gte } = await import("drizzle-orm");
  const { dailyReviewBatchesV2, reviewSchedules } = await import("@ailearn/shared/db-schema/evidence");
  const { dayKeyForV2 } = await import("./daily-batch-lock-service.ts");
  const dayRows = await tx
    .select({ createdAt: dailyReviewBatchesV2.createdAt })
    .from(dailyReviewBatchesV2)
    .where(and(
      eq(dailyReviewBatchesV2.workspaceId, ctx.workspaceId),
      eq(dailyReviewBatchesV2.userId, ctx.userId),
      eq(dailyReviewBatchesV2.dayKey, dayKeyForV2(ctx.now, ctx.timeZone)),
    ))
    .limit(1);
  if (!dayRows[0]) return 0;
  const done = await tx
    .select({ id: reviewSchedules.id })
    .from(reviewSchedules)
    .where(and(
      eq(reviewSchedules.workspaceId, ctx.workspaceId),
      eq(reviewSchedules.userId, ctx.userId),
      eq(reviewSchedules.status, "completed"),
      gte(reviewSchedules.updatedAt, dayRows[0].createdAt),
    ));
  return done.length;
}
