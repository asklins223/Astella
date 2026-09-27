/**
 * 有限的一批任务（39d W7-4 刀一；39 §9.4）。
 *
 * §9.4 写死了四件今天没有执法点的事，这一份把它们变成**可跑的判据**而不是屏上的
 * 一段排序代码：
 *
 *  1. **「批次一旦开始，不因后台新任务到期不断增加长度；用户主动加量才加入新的任务。」**
 *     —— 长度在批次**开始时**锁定。背后的新任务到期不改变它；只有她点了「再来几道」
 *     才变长。不锁的后果很具体：她正在做第三题，后台一条到期任务进来，批次从 5 变 6，
 *     于是「今天先到这里」这句话永远说不出口。
 *  2. **「批次不能永远只追最近的薄弱点：在用户愿意的有限范围内，轮换抽查已经学过但
 *     较久未观察的内容。」** —— 抽查那一支**不看她最近的分数**，看的是"多久没被观察"。
 *     只按最近挑，弱项会永远排在前面，而 §9.4 明写那不是目的。
 *  3. **「用户明确暂不安排的目标不被抽查规则复活。」** —— 这一条与 W7-3 的目标级排除
 *     是**同一个事实的两个读点**。所以入参里带 `reviewHold`，而不是在这里再查一次库。
 *  4. **「未学习的新内容不自动生成到期任务。新改内容先提示可学习，未经用户实际接触
 *     不作为『遗忘』处理。」** —— 候选里一个都没被观察过的不进批次（那是"新内容"，
 *     不是"该复习的"），而"改过但没动过"的既不算已观察、也不当遗忘。
 *
 * ## 为什么是纯函数
 *
 * 「批次不自动变长」「轮换」「不复活被排除的」这三条，每一条都能被写成"读库 + 判断"，
 * 而三处各写一遍就是三处会分叉。做成纯函数之后：屏上的批次、首页那一件、伴星读页面
 * 说的批次，是**同一批**。
 *
 * 不做的事：不查库、不算分数、不写任何状态。读侧把候选按这三条的输入喂进来。
 */

/** 一个候选目标在这四条规则下要带的全部信息。 */
export interface BatchCandidateV2 {
  readonly objectiveId: string;
  /**
   * 被观察过没有（最近一次正式作答 / 回忆确认）。**没被观察过的不进批次**——
   * §9.4「未学习的新内容不自动生成到期任务」。`unobserved` 那一档是"她还没学过"，
   * 不是"该忘了"。
   */
  readonly observed: boolean;
  /** 最近一次观察的时间；null 与 `observed: false` 同时出现（没观察过就没有那一刻）。 */
  readonly lastObservedAt: Date | null;
  /**
   * §9.1 行 2：这一颗被本人设成「暂不安排」了吗。**被抽查规则复活是明确禁止的**，
   * 所以它与"到期"是两件事——到期只说明"到点了"，不说明"她还想被提醒"。
   */
  readonly reviewHold: { readonly createdAt: string } | null;
  /**
   * 来源内容最近一次变化的时刻（无则 null）。**改过但从没观察过**的那一档，
   * §9.4 明写"不作为遗忘处理"——所以它不进抽查那一支，也不进"久未观察"那一支。
   */
  readonly sourceChangedAt: Date | null;
  /** 屏上要念出来的理由（§9.4「优先级理由可解释」）。由读侧给，这一份不编。 */
  readonly reasonLine: string;
}

/** 每一项进批次时**为什么**进——可解释的那一列（§9.4「优先级理由可解释」）。 */
export type BatchInclusionReasonV2 =
  /** 到期：该回访了。 */
  | "due_now"
  /** 轮换抽查：学过但较久没被观察。 */
  | "rotation_stale"
  /** 她主动加量：后台新到期但批次已锁定，只有她点了加量才进来。 */
  | "user_asked_more";

export interface BatchItemV2 {
  readonly objectiveId: string;
  readonly reason: BatchInclusionReasonV2;
  readonly reasonLine: string;
}

export interface LimitedBatchV2 {
  /** 本批的项。**长度由 `limit` 与锁定规则决定，不由"现在有多少到期"决定**。 */
  readonly items: readonly BatchItemV2[];
  /**
   * 本批**开始时**锁的长度。下一轮再来时它还是这个数——直到她点「再来几道」。
   */
  readonly lockedLength: number;
  /** 这一轮里被**排除**的目标与原因（屏上要能说"为什么这批里没有它"）。 */
  readonly skipped: ReadonlyArray<{ readonly objectiveId: string; readonly why: "held_by_user" | "never_observed" | "over_limit" }>;
  /** §9.4 末段那句"今天先到这里；另外还有可回访内容"：还有多少**没进这一批**。 */
  readonly deferredCount: number;
}

export interface LimitedBatchInputV2 {
  readonly candidates: readonly BatchCandidateV2[];
  /** 本批开始时锁的长度。**继续同一批时传上一次交回的 `lockedLength`。** */
  readonly lockedLength: number;
  /** 她的时区日历日；跨日另起一批（§9.4「本批」的边界是"今天"）。 */
  readonly now: Date;
  /** 这一批开始时的时刻——用于"锁定"的那一格（可省，默认 `now`）。 */
  readonly batchStartedAt?: Date;
  /**
   * 她有没有点「再来几道」。**只有为真时长度才增长**——这是 §9.4「用户主动加量才加入
   * 新的任务」唯一的入口。
   */
  readonly userAskedForMore?: number;
}

const DAY_MS = 86_400_000;

/**
 * §9.4「轮换抽查已经学过但**较久未观察**」的那一档阈值。
 *
 * 写死一个可改的参数而不是"最近一次分数最低的那几道"：首期 §9.4 明写「采用可解释规则
 * 和**可配置参数**，不先建设黑箱个性化推荐模型」。而**不看分数**是这一档的定义——
 * 按分数挑就退回"永远追最近薄弱点"了。
 */
export const ROTATION_STALE_DAYS_V2 = 21;

/**
 * 算一批。纯函数：不查库、不改状态。
 *
 * **顺序是纪律**：先滤掉**不许进**的（被排除的、没观察过的），再排，最后按锁定长度截断。
 * 反过来做（先排后滤）会在名额被不合格的占满之后，把本来该进来的挤掉——而那正是
 * §9.4「用户明确暂不安排的目标不被抽查规则复活」想防的那一类。
 */
export function planLimitedBatchV2(input: LimitedBatchInputV2): LimitedBatchV2 {
  const now = input.now.getTime();
  const limit = Math.max(
    0,
    input.lockedLength + (input.userAskedForMore && input.userAskedForMore > 0 ? input.userAskedForMore : 0),
  );

  const eligible: Array<{ candidate: BatchCandidateV2; reason: BatchInclusionReasonV2; dueAt: number; staleDays: number }> = [];
  const skipped: Array<{ objectiveId: string; why: "held_by_user" | "never_observed" | "over_limit" }> = [];

  for (const candidate of input.candidates) {
    // ① 被本人「暂不安排」的**不复活**（§9.4 末段）。它排在最前是因为这是**她的话**，
    // 比任何到期读数都优先。
    if (candidate.reviewHold) {
      skipped.push({ objectiveId: candidate.objectiveId, why: "held_by_user" });
      continue;
    }
    // ② 没观察过的新内容不自动生成到期任务（§9.4）。改过但没观察过的同样不进——
    // 「未经用户实际接触不作为遗忘处理」。
    if (!candidate.observed) {
      skipped.push({ objectiveId: candidate.objectiveId, why: "never_observed" });
      continue;
    }
    const lastObserved = candidate.lastObservedAt ? candidate.lastObservedAt.getTime() : now;
    const dueAt = candidate.sourceChangedAt
      ? Math.max(candidate.sourceChangedAt.getTime(), lastObserved)
      : lastObserved;
    const staleDays = Math.floor((now - dueAt) / DAY_MS);
    eligible.push({
      candidate,
      // 轮换那一档按"多久没被观察"分，不按分数——§9.4「不能永远只追最近的薄弱点」。
      reason: staleDays >= ROTATION_STALE_DAYS_V2 ? "rotation_stale" : "due_now",
      dueAt,
      staleDays,
    });
  }

  // 到期在前（同一天里早的在前），轮换那一档按"最久没观察"在前。两者都不是分数。
  eligible.sort((a, b) => {
    if (a.reason !== b.reason) return a.reason === "due_now" ? -1 : 1;
    return a.reason === "due_now" ? a.dueAt - b.dueAt : b.dueAt - a.dueAt;
  });

  const items: BatchItemV2[] = [];
  for (const entry of eligible) {
    if (items.length >= limit) {
      skipped.push({ objectiveId: entry.candidate.objectiveId, why: "over_limit" });
      continue;
    }
    items.push({
      objectiveId: entry.candidate.objectiveId,
      reason: entry.reason,
      reasonLine: entry.candidate.reasonLine,
    });
  }

  return {
    items,
    lockedLength: limit,
    skipped,
    // §9.4 末段：「今天先到这里；另外还有可回访内容」——屏上要能说出"还有多少"。
    deferredCount: eligible.length - items.length,
  };
}
