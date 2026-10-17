/**
 * 手动日期约束与自动策略的优先级（39d W7-8 刀一；39 §9.1 末两段）。
 *
 * §9.1 写死两句：
 *  - 「手动日期和通知偏好可独立调整；**在手动日期约束仍有效时，自动策略不能悄悄把
 *    提醒提前**。」
 *  - 「手动日期约束属于**本次需求版本**，不能变成永久禁止以后安排的规则；处理完成、
 *    本人再次改期或明确恢复自动安排后按相应回执结束该约束。」
 *
 * ## 这一格今天是怎么坏的
 *
 * `review_schedules` 有两列时间：`nextReviewAt`（**官方**到期）与 `user_deferred_until`
 * （展示层延后）。到期队列那一读**认**后一列（`review/service.ts:190`），所以"延后到
 * 那天之前不该出现在队列里"这一半是成立的。**另一半没有**：结算写下一档时直接落
 * `nextReviewAt: decision.nextReviewAt`（策略算出来的那一天），**不读 `user_deferred_until`**
 * ——于是她选了"下周三"，而策略算出"后天"，提醒就**悄悄提前**了。
 * 症状是她只在下周三之前看不见队列、到了那天又发现"怎么昨天就该来了"，而库里那一行
 * 明明白白写着更早的日期。
 *
 * ## 为什么是**夹紧**而不是"一律用手动日期"
 *
 * §9.1 说的是"不能**提前**"，不是"必须服从"。手动日期比策略**更早**的时候（她自己选了
 * 明天，而策略说三天后），那一档要照手动日期走——但那不是这一份要管的事：那条
 * `user_deferred_until` 本来就只挡队列，不改 `nextReviewAt`。所以这里只管"策略比手动
 * 日期更早"这一支，把它**抬**到手动日期。
 *
 * ## 约束什么时候结束（第二句话）
 *
 * 「属于**本次需求版本**」——换了一版策略、换了目标修订、或者她再次改期之后，那条约束
 * 就不再跟着走。把它做成参数而不是在这里去查库，是因为这一份是**纯函数**：
 * "本次需求有没有换版"由调用方按它自己那一发的语义回答，这一份只判优先级。
 */

/** 需求换版的那几种情形；换版即结束约束（§9.1「不能变成永久禁止以后安排的规则」）。 */
export type ManualDateConstraintEndedV2 =
  | "none"                    // 还没有手动日期
  | "bound"                   // 约束有效：策略被抬到手动日期
  | "not_binding"             // 约束有效但这次不绑定：策略本来就比手动日期晚
  | "ended_by_new_requirement"; // 本次需求换版 ⇒ 约束结束

export interface ManualDateConstraintDecisionV2 {
  /** 落进 `nextReviewAt` 的那一个。 */
  readonly nextReviewAt: Date;
  readonly constraint: ManualDateConstraintEndedV2;
  /**
   * 这次**抬过**日期吗。为真时必须写进回执（`reasonCode`／事件）——§9.1
   * 「不能悄悄」：悄悄抬与悄悄提前是同一种毛病，只是方向相反。
   */
  readonly raisedByConstraint: boolean;
}

/**
 * 纯函数：把策略算出来的到期日与手动日期约束合成一个 `nextReviewAt`。
 *
 * **不做的事**：不查库、不看模型、不改 `user_deferred_until`。那一列归延后那一发
 * （`review-defer-service.ts`），这一份只回答"下一次落到哪一天"。
 */
export function decideNextReviewAtWithManualDateV2(input: {
  /** 策略算出来的那一天。 */
  readonly policyNextReviewAt: Date;
  /** 展示层那条手动日期；null／没有 ⇒ 没有约束。 */
  readonly manualDeferredUntil: Date | null;
  /**
   * 本次需求**是否已经换版**（换了策略版本、换了目标修订、或者她再次改期）。
   * 为真 ⇒ 约束结束，照策略走。
   */
  readonly requirementChanged?: boolean;
}): ManualDateConstraintDecisionV2 {
  const manual = input.manualDeferredUntil;
  if (!manual) {
    return {
      nextReviewAt: input.policyNextReviewAt,
      constraint: "none",
      raisedByConstraint: false,
    };
  }
  if (input.requirementChanged) {
    // §9.1「手动日期约束属于本次需求版本」——换版即结束，不跟着下一版走。
    return {
      nextReviewAt: input.policyNextReviewAt,
      constraint: "ended_by_new_requirement",
      raisedByConstraint: false,
    };
  }
  if (input.policyNextReviewAt.getTime() >= manual.getTime()) {
    // 策略本来就**不早于**手动日期 ⇒ 约束有效但不绑定。**不能**在这里把日期往回拉：
    // 那等于让手动日期反向覆盖策略，而 §9.1 只说"不能提前"。
    return {
      nextReviewAt: input.policyNextReviewAt,
      constraint: "not_binding",
      raisedByConstraint: false,
    };
  }
  // 策略比手动日期早 ⇒ 抬到手动日期，并如实说"抬过"。
  return {
    nextReviewAt: new Date(manual.getTime()),
    constraint: "bound",
    raisedByConstraint: true,
  };
}
