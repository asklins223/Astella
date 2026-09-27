/**
 * 手动日期约束的判据（39d W7-8 刀一；39 §9.1 末两段）。
 *
 * 钉的是四档，**每一档都带正控制**——这四档之间的区别全在"日期谁更晚"与
 * "需求有没有换版"两个轴上，少判一档的后果都是具体的：
 *
 *  1. **策略比手动日期早 ⇒ 抬到手动日期**，并说"抬过"。这是 §9.1 那句「自动策略不能
 *     悄悄把提醒提前」的正身。正控制：把策略日期往后挪一格 ⇒ 变成第 2 档。
 *  2. **策略不早于手动日期 ⇒ 不绑定，也不把日期往回拉**。§9.1 只说"不能提前"，
 *     没说她选了一个更近的日子就该服从策略——这一档是最容易被写成"一律用手动日期"
 *     的一格，而那会把她的选择反向覆盖掉。
 *  3. **需求换版 ⇒ 约束结束**，照策略走（§9.1「手动日期约束属于本次需求版本，不能
 *     变成永久禁止以后安排的规则」）。正控制：把 `requirementChanged` 翻过来。
 *  4. **没有手动日期 ⇒ 什么都不做**。正控制：负对照也是这一档。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideNextReviewAtWithManualDateV2 } from "./review-manual-date-constraint-v2.ts";

const DAY = 86_400_000;
const base = new Date("2026-09-27T09:00:00.000Z");
const at = (days: number) => new Date(base.getTime() + days * DAY);

test("W7-8 刀一：策略比手动日期早 ⇒ 抬到手动日期，并如实说「抬过」", () => {
  // 策略说"后天"，她选了"下周三" ⇒ 提醒不能被悄悄提前到后天。
  const decided = decideNextReviewAtWithManualDateV2({
    policyNextReviewAt: at(2),
    manualDeferredUntil: at(6),
  });
  assert.equal(decided.nextReviewAt.getTime(), at(6).getTime(), "策略早于手动日期时必须抬到手动日期");
  assert.equal(decided.constraint, "bound");
  // 「不能悄悄」：抬过就必须能说出去，否则日志与回执里看不出这一天被人动过。
  assert.equal(decided.raisedByConstraint, true);
});

test("W7-8 刀一 正对照：策略本来就不早于手动日期 ⇒ 不绑定，且**不把日期往回拉**", () => {
  // 策略说"十天"，她选了"下周三"（六天）——**更近**。§9.1 只说"不能提前"，
  // 没说她选了更近的日子就该服从策略。这里最容易写成"一律用手动日期"，
  // 那一写会把她的选择反向覆盖掉。
  const decided = decideNextReviewAtWithManualDateV2({
    policyNextReviewAt: at(10),
    manualDeferredUntil: at(6),
  });
  assert.equal(decided.nextReviewAt.getTime(), at(10).getTime(),
    "策略更晚时**不许**把日期往回拉：那是让手动日期反向覆盖策略");
  assert.equal(decided.constraint, "not_binding");
  assert.equal(decided.raisedByConstraint, false);
});

test("W7-8 刀一：需求换版 ⇒ 约束结束，照策略走（不能变成永久禁止以后安排）", () => {
  const decided = decideNextReviewAtWithManualDateV2({
    policyNextReviewAt: at(2),
    manualDeferredUntil: at(6),
    requirementChanged: true,
  });
  assert.equal(decided.nextReviewAt.getTime(), at(2).getTime(),
    "换了需求版本之后，那条手动日期约束不再跟着走（§9.1「属于本次需求版本」）");
  assert.equal(decided.constraint, "ended_by_new_requirement");
  assert.equal(decided.raisedByConstraint, false);
});

test("W7-8 刀一 负对照：没有手动日期 ⇒ 什么都不做（四个轴都不成立那一格）", () => {
  const decided = decideNextReviewAtWithManualDateV2({
    policyNextReviewAt: at(2),
    manualDeferredUntil: null,
  });
  assert.equal(decided.nextReviewAt.getTime(), at(2).getTime(), "没有手动日期就照策略走");
  assert.equal(decided.constraint, "none");
  assert.equal(decided.raisedByConstraint, false);
});

test("W7-8 刀一：恰好相等算「不绑定」——策略没有提前，就不该被记成抬过", () => {
  const decided = decideNextReviewAtWithManualDateV2({
    policyNextReviewAt: at(6),
    manualDeferredUntil: at(6),
  });
  assert.equal(decided.constraint, "not_binding");
  assert.equal(decided.raisedByConstraint, false,
    "相等的那一格记成「抬过」会让「抬过」这个读数在日志里失去意义");
});

test("W7-8 刀一：返回的日期是新对象，不会把调用方的入参改掉", () => {
  const manual = at(6);
  const decided = decideNextReviewAtWithManualDateV2({
    policyNextReviewAt: at(2),
    manualDeferredUntil: manual,
  });
  assert.notEqual(decided.nextReviewAt, manual, "交回的是新 Date：就地改会改掉调用方手里那一列的读数");
  assert.equal(manual.getTime(), at(6).getTime());
});
