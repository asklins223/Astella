/**
 * 帮助条件 → 排期冷却的换算（39d W5-1 主体刀二；39 §9.3、§14.1.1、§16.37）。
 *
 * 存在的理由是那三处 `calculateDiscreteV2Schedule({ …, unassistedEligibleAfter: null })`：
 * `unassistedEligibleAfter` 是**借助完成冷却的唯一入口**，三处全写死 `null`，而 `null`
 * 在下游被读成「没有需要冷却的帮助」＝「这次是独立表现」——§14.1.1 说的「判不出来的时候
 * 不签发独立证据」被解成了反面。
 *
 * 换算那一层必须把两件事分开，而它们今天在下游是同一个 `null`：
 *  1. **该不该有冷却**（`assisted`／`unreconcilable` 该，别的不该）；
 *  2. **能不能算独立表现**（只有 `independent` 能）。
 * 把「判不出来」和「确凿独立」都映射成 `null`，排期这一侧就再也分不开它们——
 * 这正是本刀要拆掉的那个洞。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HELP_COOLDOWN_DAYS_ASSISTED,
  HELP_COOLDOWN_DAYS_UNRECONCILABLE,
  decideHelpConditionV2,
  helpConditionCooldownAfterV2,
  helpConditionCountsAsIndependentV2,
  helpConditionNeedsCooldownV2,
  unreconcilableDispositionV2,
  type HelpConditionV2,
} from "./help-condition-rules-v2.ts";

const AT = new Date("2026-09-27T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const ALL: HelpConditionV2[] = ["independent", "assisted", "unreconcilable", "unknown_no_evidence"];

test("四档里只有 assisted 与 unreconcilable 有冷却（§9.3「提示后完成 → 保留借助条件」）", () => {
  for (const condition of ALL) {
    const out = helpConditionCooldownAfterV2({ condition, at: AT });
    const shouldCool = condition === "assisted" || condition === "unreconcilable";
    assert.equal(out.eligibleAfter !== null, shouldCool,
      `${condition} 的冷却判定错了：eligibleAfter=${String(out.eligibleAfter)}`);
    // 与那个布尔判据**必须同源**：两处各手写一次就会有一天它们说不一样的话
    assert.equal(out.days > 0, helpConditionNeedsCooldownV2(condition),
      `${condition}：换算与 helpConditionNeedsCooldownV2 说法不一致——两个来源必然有一个是错的`);
  }
});

test("「判不出来」不是「确凿独立」：两档都**不签发独立证据**，但冷却档位不同", () => {
  const unreconcilable = helpConditionCooldownAfterV2({ condition: "unreconcilable", at: AT });
  const noEvidence = helpConditionCooldownAfterV2({ condition: "unknown_no_evidence", at: AT });
  // 判不出来：**仍有**一道短冷却（让那次「条件清楚的新尝试」真的发生），
  // 与「确凿独立」（完全没有冷却）在排期上长得不一样。
  assert.ok(unreconcilable.eligibleAfter !== null,
    "判不出来那档仍该有一道短冷却——它是「让新尝试发生在条件清楚时」，不是「这次算独立」");
  assert.equal(noEvidence.eligibleAfter, null, "没有可判证据那档无冷却：连这次作答的锁定时刻都没有");

  // 证据那一侧：两档**都**不签发独立证据，这一层才是 §14.1.1 的那一刀
  assert.equal(helpConditionCountsAsIndependentV2("unreconcilable"), false,
    "§14.1.1：判不出来不签发独立证据");
  assert.equal(helpConditionCountsAsIndependentV2("unknown_no_evidence"), false,
    "没有可判证据同样不签发独立证据");
  assert.equal(helpConditionCountsAsIndependentV2("independent"), true);
});

test("判不出来那档给的是**更短**的冷却，不是更长的惩罚", () => {
  assert.equal(HELP_COOLDOWN_DAYS_UNRECONCILABLE, 1);
  assert.ok(
    HELP_COOLDOWN_DAYS_UNRECONCILABLE < HELP_COOLDOWN_DAYS_ASSISTED,
    "「我不知道」被当成比「确凿的借助」更重的惩罚：§14.1.1 不靠自报补签，同一个道理——不确定不该更重",
  );
});

test("冷却从**本次观察时刻**起算，不是从回答锁定时刻", () => {
  const out = helpConditionCooldownAfterV2({ condition: "assisted", at: AT });
  assert.equal(out.eligibleAfter?.getTime(), AT.getTime() + HELP_COOLDOWN_DAYS_ASSISTED * DAY);
  // 起算点早于观察时刻就等于给了一个过去的门，而
  // `effectiveDueDate` 取的是 max(policyDue, unassistedEligibleAfter)
  const stale = new Date(AT.getTime() - 10 * DAY);
  const fromStale = helpConditionCooldownAfterV2({ condition: "assisted", at: stale });
  assert.ok(
    fromStale.eligibleAfter!.getTime() < AT.getTime(),
    "判据自证失败：这一格用来证明「起算点是入参 at」，而它没成立",
  );
});

test("unreconcilable 的处置四条边界一条都不能松（§14.1.1）", () => {
  const d = unreconcilableDispositionV2();
  assert.equal(d.keepsAnswer, true, "保留回答");
  assert.equal(d.issuesIndependentEvidence, false, "不签发独立证据——这一档存在的全部理由");
  assert.equal(d.autoSignsFromSelfReport, false, "不靠自报自动补签");
  assert.equal(d.blocksForever, false, "不让人永久等待");
  assert.equal(d.freshAttemptsAllowed, 1, "至多**一次**条件清楚的新尝试，不是无限重试");
});

/**
 * 变异自证：把换算退回到今天那三处写死的形状（无论什么档都返回 `null`），
 * 上面两条关于「谁该有冷却」的判据必须红。
 *
 * 没有这一段，「无冷却 = 独立」这个 bug 可以被原样保留而全部判据仍然绿——
 * 因为改坏的是**实现的默认分支**，而默认分支正是最少被断言的地方。
 */
test("判据对「退回到写死 null」灵敏", () => {
  const broken = (condition: HelpConditionV2) => {
    // 复刻今天 `run-processing-tick.ts` 三处写死的形状：与输入无关的 `null`
    void condition;
    return { eligibleAfter: null as Date | null, days: 0, policyVersion: "broken" };
  };
  // 正控制：真实现确实给出冷却
  assert.ok(
    helpConditionCooldownAfterV2({ condition: "assisted", at: AT }).eligibleAfter !== null,
    "正控制失败 ⇒ 这条自证没在证任何东西",
  );
  // 变异后：assisted / unreconcilable 两档都变成无冷却，而判据必须看出来
  for (const condition of ["assisted", "unreconcilable"] as const) {
    assert.equal(helpConditionNeedsCooldownV2(condition), true, `正控制：${condition} 本该有冷却`);
    const out = broken(condition);
    assert.notEqual(out.eligibleAfter !== null, helpConditionNeedsCooldownV2(condition),
      `把 ${condition} 退化成无冷却却没有一条判据会红——今天那三处写死的 null 就是这样活下来的`);
  }
});

/**
 * 变异自证②：把两个常数改成相等（「判不出来与确凿借助一样重」），那条不等判据必须红。
 */
test("判据对「两档冷却被改成一样重」灵敏", () => {
  const mutated = HELP_COOLDOWN_DAYS_ASSISTED;
  assert.ok(HELP_COOLDOWN_DAYS_UNRECONCILABLE < mutated,
    "把两档改成同一天数之后这条判据仍然绿 ⇒ 它量的不是「不确定不该更重」这件事");
});

/** 判这一份回答的帮助条件那条判据本身也在这里钉一条：锁定时刻是唯一的界。 */
test("锁定时刻是唯一的界：锁定后的呈现不降低已锁定回答（§16.37(a)）", () => {
  const lockedAt = new Date("2026-09-27T10:00:00.000Z");
  const before = new Date(lockedAt.getTime() - 60 * 60 * 1000);
  const after = new Date(lockedAt.getTime() + 60 * 60 * 1000);

  // 锁定前请求 + 锁定前呈现 ⇒ 借助完成
  assert.equal(
    decideHelpConditionV2({ answerLockedAt: lockedAt, helpRequestedAt: before, helpPresentedAt: before, reconcilable: true }),
    "assisted",
  );
  // 锁定前请求、锁定后才有回执 ⇒ 判不出来，**不**按"回执更晚"就当成提交后
  assert.equal(
    decideHelpConditionV2({ answerLockedAt: lockedAt, helpRequestedAt: before, helpPresentedAt: after, reconcilable: true }),
    "unreconcilable",
    "§14.1.1：不能只凭较晚到达的客户端时间判它发生在提交后",
  );
  // 锁定后请求（正常提交成功后才显示的反馈）⇒ 不降低已锁定回答
  assert.equal(
    decideHelpConditionV2({ answerLockedAt: lockedAt, helpRequestedAt: after, helpPresentedAt: after, reconcilable: true }),
    "independent",
  );
  // 没有锁定的回答 ⇒ 无从谈先后
  assert.equal(
    decideHelpConditionV2({ answerLockedAt: null, helpRequestedAt: before, helpPresentedAt: before, reconcilable: true }),
    "unknown_no_evidence",
  );
});
