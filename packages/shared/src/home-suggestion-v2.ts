/**
 * 首页「只推一件」（39d W7-4 刀四；39 §12.1）。
 *
 * §12.1 写死的内容今天没有执法点：
 *   「书桌的主建议来自**统一的下一步逻辑**，优先考虑用户明确指定的任务、仍愿意继续的
 *    未完轮次和已授权回访；**不因一个旧暂停轮次存在就永久挡住其他需求**。」
 *   「推荐**附一句理由**，**可换一个**或**暂不处理**。…用户略过后**本次不反复推荐
 *    同一项**。」
 *   「没有记录不显示假统计，**没有到期需求不制造"今日任务"**。」
 *
 * ## 「统一的下一步逻辑」意味着只能有一处排序
 *
 * 书桌、伴星气泡、空态、提醒横幅都在问"现在最值得做什么"。四套排序就是四个答案，
 * 而屏上读不出来（每处各自都说得通）。所以规则在**纯函数**里，各处只喂自己的候选。
 *
 * ## 优先级是**三档**，不是"最近更新的那个"
 *
 * §12.1 把三样排了序：**用户明确指定的** > **仍愿意继续的未完轮次** > **已授权回访**。
 * 「明确指定」排第一是因为那是**她刚说的**；「已授权回访」排最后不是因为它不重要，
 * 而是因为**没到期就不该出现**（下面第三条）——把"重要"和"现在值得"混成一条排序，
 * 首页就会在没有到期需求时推一件"重要但不急"的事，那正是 §12.1 禁止的。
 */

/** §12.1 的三档来意。`kind` 的序**就是**优先级（`user_named` > `unfinished_run` > `authorized_review`）。 */
export type NextStepKindV2 = "user_named" | "unfinished_run" | "authorized_review";

export interface NextStepCandidateV2 {
  readonly kind: NextStepKindV2;
  /** 屏上那一行的主语（"接着解释昨天卡住的条件"）。 */
  readonly headline: string;
  /** §12.1「推荐附一句理由」——**必填**，空的不许进。 */
  readonly reasonLine: string;
  /**
   * 轮内唯一标识，"换一个"与"暂不处理"都按它记。**不要用 objectiveId**：
   * 同一颗目标可能既是未完轮次又是已授权回访，而「换一个」要换的是**这一项**。
   */
  readonly itemKey: string;
  /** 最近一次被改动/被指定的时刻；同档内按它排（新的在前）。 */
  readonly updatedAt: Date;
  /** 是不是一个**已暂停**的旧轮次。§12.1「不因一个旧暂停轮次存在就永久挡住其他需求」。 */
  readonly pausedRun?: boolean;
}

export type HomeSuggestionV2 =
  | {
      readonly kind: "suggested";
      readonly item: NextStepCandidateV2;
      /** 除了这一件，**同档**里还有几件可换（§12.1「可换一个」）。 */
      readonly swappableCount: number;
      /** 本次已被她「暂不处理」过的项——**本次不反复推荐**。 */
      readonly dismissedThisSession: readonly string[];
    }
  | {
      readonly kind: "nothing_due";
      /**
       * §12.1「没有到期需求**不制造"今日任务"**」——这一档**不许**塞一件"值得做的事"
       * 进去。空态给的是"新建笔记／从资料写笔记／最近阅读"，那是**入口**，不是建议。
       */
      readonly emptyActions: readonly ("new_note" | "write_from_source" | "resume_reading")[];
    };

/**
 * §12.1 的统一排序。纯函数：不查库、不改状态。
 */
export function decideHomeSuggestionV2(input: {
  readonly candidates: readonly NextStepCandidateV2[];
  /** 本次会话里她「暂不处理」过的 `itemKey`。**只影响本次**——新的一次照常推荐。 */
  readonly dismissedThisSession: readonly string[];
}): HomeSuggestionV2 {
  const dismissed = new Set(input.dismissedThisSession);
  // ① 「暂不处理」过的本次不再推（§12.1「用户略过后本次不反复推荐同一项」）。
  //    被排除的**暂停轮次**也要滤：§12.1「不因一个旧暂停轮次存在就永久挡住其他需求」
  //    ——它既不该被推荐，也不该**占位**。
  const usable = input.candidates.filter(
    (candidate) => !dismissed.has(candidate.itemKey) && !candidate.pausedRun,
  );

  if (usable.length === 0) {
    return {
      kind: "nothing_due",
      emptyActions: ["new_note", "write_from_source", "resume_reading"],
    };
  }

  // ② 三档按 `kind` 的序排（声明顺序即优先级），同档内新的在前。
  const rank: Record<NextStepKindV2, number> = {
    user_named: 0,
    unfinished_run: 1,
    authorized_review: 2,
  };
  usable.sort((a, b) => (rank[a.kind] - rank[b.kind]) || (b.updatedAt.getTime() - a.updatedAt.getTime()));

  const top = usable[0]!;
  // ③ §12.1「附一句理由」：没有理由的那一项**不许**当主建议。空理由会让首页那一行
  //    变成一句没有出处的断言——而这一档整章的用意就是"说得清为什么是这一件"。
  if (top.reasonLine.trim() === "") {
    return {
      kind: "nothing_due",
      emptyActions: ["new_note", "write_from_source", "resume_reading"],
    };
  }

  return {
    kind: "suggested",
    item: top,
    // 「可换一个」只数**同档**剩下的：跨档换会把"她刚指定的那一件"换成一件回访，
    // 而 §12.1 的排序正是为了不让那件事被顶掉。
    swappableCount: usable.filter(
      (candidate) => candidate.kind === top.kind && candidate.itemKey !== top.itemKey,
    ).length,
    dismissedThisSession: input.dismissedThisSession,
  };
}
