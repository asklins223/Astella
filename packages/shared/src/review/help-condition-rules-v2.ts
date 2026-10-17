/**
 * 帮助条件的**可对账性**与它决定的那一档（39d W5-1 主体刀一；39 §14.1.1、§5.5、§16.21、§16.37）。
 *
 * §14.1.1 是这一整块的地基："**以回答锁定先后为界，而非评分返回时间**。本次原回答锁定前
 * 已经呈现的帮助影响其条件；正常提交成功后才显示的答案、反馈或下一题讲解，不追溯降低
 * 该份已锁定回答。若帮助在提交前已经请求且可能呈现、回执却迟到，保留待核对并对账；
 * **不能只凭较晚到达的客户端时间判它发生在提交后**。"
 *
 * 接着是这一刀要解决的那一句："一直无法对账时显示「**帮助条件无法确认**」，
 * **保留回答但不签发独立证据**，不让用户永久等待或**靠自报未看过自动补签**。
 * **允许未来一次条件清楚的新尝试**。"
 *
 * 2026-09-27 量到的实情（这一刀存在的理由）：
 *  - `learning-card-v2-contracts.ts:224` 那条注释自己写着 `evidence_reveal`
 *    "七处在读、**零处生产**"——所以"锁定前是否呈现过依据"今天**判不出来**；
 *  - `run-processing-tick.ts` 三处 `calculateDiscreteV2Schedule({ …, unassistedEligibleAfter: null })`
 *    ——`unassistedEligibleAfter` 是那条**借助完成冷却**的唯一入口，三处**全写死 null**。
 *
 * 两条合起来就是 §14.1.1 说的"无法对账"，而今天它被解成了**反面**：
 * `null` 的含义是"没有需要冷却的帮助"，也就是"这次是独立表现"——
 * **判不出来的时候按独立签发**，与 §14.1.1「不签发独立证据」正好相反。
 *
 * 这一份不改动那三处排期调用（那会动到别人正在量的排期读数），
 * 它交付的是**判据与那一档的正确名字**，并把上面三处读数登记在案。
 * 接线归 W5-1 主体刀二，与 W2-6／W4-7 一起排。
 */
import { z } from "zod";

/**
 * 一次作答的帮助条件，四档。
 *
 * 关键在**第四档存在**：前三档都是"判得出来"的情形，只有第四档是"判不出来"。
 * 没有第四档的系统只有两种选择——把判不出来的当独立（错，§14.1.1 明写不许），
 * 或者把判不出来的当借助（也错：那会让"我不知道有没有被帮过"被显示成"你被帮过"，
 * 而 §14.1 要的是把接触、借助、独立**分别**存储和展示）。
 */
export type HelpConditionV2 =
  /** 锁定前没有任何帮助请求，且这一档判得出来。 */
  | "independent"
  /** 锁定前确实呈现过帮助（回执确认了先后）。 */
  | "assisted"
  /** 锁定前请求过帮助、但呈现回执始终没对上。§14.1.1 的那一档。 */
  | "unreconcilable"
  /** 这次根本没有能判的东西（没有回答锁定记录 / 没有暴露账本）。 */
  | "unknown_no_evidence";

export const helpConditionV2Schema = z.enum([
  "independent",
  "assisted",
  "unreconcilable",
  "unknown_no_evidence",
]);
export type HelpConditionV2Wire = z.infer<typeof helpConditionV2Schema>;

/**
 * 判这一份回答的帮助条件。
 *
 * **界是回答锁定时刻，不是评分返回时刻**（§14.1.1 头一句）。所以入参只有三样与时间
 * 有关的东西：锁定时刻、帮助**请求**时刻、帮助**呈现**时刻；没有"评分什么时候回来"。
 *
 * `reconcilable` 是"今天有没有能力判这件事"的开关，而不是关于这一次回答的：
 * 它由**全仓有没有暴露写入方**决定，不由本次作答决定。今天它是 `false`
 * （`evidence_reveal` 零生产者，见头注），于是**每一次**都落到后两档。
 *
 * 顺序有讲究：先判"有没有回答锁定"（没有就没什么可判），再判"锁定前有没有请求"，
 * 然后才看呈现回执——**先问数据事实、最后才问能力**。
 */
export function decideHelpConditionV2(input: {
  /** `learning_artifacts.lockedAt`。null = 这一份根本不是一份锁定的回答。 */
  answerLockedAt: Date | null;
  /** 帮助被**请求**的时刻（按钮点了、伴星被问了、语音播放开始了……）。 */
  helpRequestedAt: Date | null;
  /** 帮助**呈现**的回执时刻。没对上就是 null——迟到、丢失、没回执都落这里。 */
  helpPresentedAt: Date | null;
  /** 今天系统有没有能力把「锁定前是否呈现过帮助」判清楚。 */
  reconcilable: boolean;
}): HelpConditionV2 {
  // 没有锁定的回答：无从谈先后，直接"没有证据"——不签发任何东西。
  if (!input.answerLockedAt) return "unknown_no_evidence";

  const beforeLock = (at: Date | null) => at !== null && at.getTime() < input.answerLockedAt!.getTime();

  // 锁定前没有任何帮助请求 ⇒ 那一档是干净的独立表现。
  if (!beforeLock(input.helpRequestedAt)) return "independent";

  // 锁定前请求过帮助：
  //  - 呈现回执也确认在锁定前 ⇒ 借助完成；
  //  - 呈现回执确认在锁定**后**（或根本没回执）⇒ **判不出来**，落 §14.1.1 那一档。
  //    注意这里刻意**不**用"回执更晚"去判"帮助发生在提交后"——§14.1.1 明写
  //    「不能只凭较晚到达的客户端时间判它发生在提交后」。
  if (beforeLock(input.helpPresentedAt)) return "assisted";
  return "unreconcilable";
}

/**
 * §14.1.1 那一档的处置——**常量判据，不是判断**。
 *
 * 四条不可越过的边界，写成常量是为了让它们在单测里一眼可见：
 *  1. **保留回答**：`unreconcilable` 不是"这次不算"，它是"这次算，但我不知道它算哪一种"。
 *     丢掉回答会让用户重新答一遍，而 §14.1.1 说的是"保留待核对并对账"。
 *  2. **不签发独立证据**：这是这一档存在的全部理由。
 *  3. **不靠自报自动补签**：`userClaimsNoHelp` 进去之后结论**不变**——
 *     §14.1.1「不靠自报未看过自动补签」。
 *  4. **允许未来一次条件清楚的新尝试**：至多一次，不是无限。
 */
export function unreconcilableDispositionV2(): {
  readonly keepsAnswer: true;
  readonly issuesIndependentEvidence: false;
  readonly autoSignsFromSelfReport: false;
  readonly blocksForever: false;
  readonly freshAttemptsAllowed: 1;
  readonly userFacingLabel: "帮助条件无法确认";
} {
  return {
    keepsAnswer: true,
    issuesIndependentEvidence: false,
    autoSignsFromSelfReport: false,
    blocksForever: false,
    // §14.1.1「允许未来一次条件清楚的新尝试」——是"一次"，不是"无限次重试"。
    freshAttemptsAllowed: 1,
    userFacingLabel: "帮助条件无法确认",
  };
}

/** 排期那一侧读它：只有 `assisted` 与 `unreconcilable` 需要冷却，独立不需要。 */
export function helpConditionNeedsCooldownV2(condition: HelpConditionV2): boolean {
  return condition === "assisted" || condition === "unreconcilable";
}

/** 这一次观察能不能作为"独立表现"的证据。`unreconcilable` 与 `unknown_no_evidence` 都不能。 */
export function helpConditionCountsAsIndependentV2(condition: HelpConditionV2): boolean {
  return condition === "independent";
}

/**
 * 借助完成冷却的天数（§9.3「提示后完成 → 保留借助条件，不提升为独立成功」；
 * §9.3 同时写明「**不把延长间隔当奖励**」）。
 *
 * **两个常数而不是一个**，因为两件事的分量不同：
 *  - `assisted` 是**确凿**的借助——回执确认了呈现就在锁定之前。这次该等的时长按
 *    "用户要有机会自己再试一次"给，两天。
 *  - `unreconcilable` 是**判不出来**，不是"确凿的借助"（§14.1.1 那一档：保留回答但
 *    不签发独立证据）。它已经明确"至多允许一次条件清楚的新尝试"——冷却的作用是
 *    **让那次新尝试真的发生在条件清楚的时候**，所以要更短：一天。
 *
 * 给 `unreconcilable` 更长的冷却，等于把"我不知道"惩罚成"你被帮过"，而 §14.1.1
 * 明写「不靠自报自动补签」——同一个道理：不确定不该比确定的更重。
 *
 * **策略版本**跟着这两个数走：改它们等于改一次间隔策略，必须能被审计读出来
 * （§9.2「安排回执」要带原因，§9.3「具体间隔算法……记录策略版本」）。
 */
export const HELP_COOLDOWN_DAYS_ASSISTED = 2;
export const HELP_COOLDOWN_DAYS_UNRECONCILABLE = 1;

/**
 * 把这一档换算成 `unassistedEligibleAfter`（`calculateDiscreteV2Schedule` 的入参）。
 *
 * **返回 `null` 的两种含义必须分开看**：
 *  - `independent` —— 判得出来且确实没有帮助，**不该有冷却**；
 *  - `unknown_no_evidence` —— 连判的东西都没有，**同样不该有冷却**，
 *    但它**不签发独立证据**（那是 `helpConditionCountsAsIndependentV2` 的事，
 *    排期这一侧看不见）。把两者合成同一个 `null` 正是今天那三处写死 `null` 的病：
 *    排期只看得见 `null`，于是「判不出来」与「确凿独立」在下游**完全一样**。
 *
 * 冷却的**起算点**是本次观察的时刻 `at`，不是锁定时刻——锁定时刻已经过去，
 * 拿它加天数会算出一个过去的时间点，而 `effectiveDueDate` 取的是
 * `max(policyDue, unassistedEligibleAfter)`，传一个过去时间等于什么都没说。
 */
export function helpConditionCooldownAfterV2(input: {
  readonly condition: HelpConditionV2;
  /** 本次观察落库的时刻。冷却从它起算。 */
  readonly at: Date;
  /** 策略版本，随冷却天数一起进审计（§9.3「记录策略版本」）。 */
  readonly policyVersion?: string;
}): { readonly eligibleAfter: Date | null; readonly days: number; readonly policyVersion: string } {
  const policyVersion = input.policyVersion ?? `help-cooldown-v1`;
  const days = helpConditionNeedsCooldownV2(input.condition)
    ? input.condition === "assisted" ? HELP_COOLDOWN_DAYS_ASSISTED : HELP_COOLDOWN_DAYS_UNRECONCILABLE
    : 0;
  return {
    // `null` 才是"这一排期没有被帮助条件顶住"；给一个过去的日期等于给了个假门。
    eligibleAfter: days === 0 ? null : new Date(input.at.getTime() + days * 24 * 60 * 60 * 1000),
    days,
    policyVersion,
  };
}
