/**
 * §9.1 那张规则表的逐条判据（39d W7-3 刀一）。
 *
 * 一条用例钉一行，且**只钉那一行**：这张表最容易出的错不是"没实现"，而是两行的后果
 * 被写成同一种（暂停来源＝停这条安排；略过建议＝取消订阅）。所以每条都要有一个反向
 * 对照格——规则不该生效的地方必须明确判成生效。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applySourcePauseV2,
  decideEnableUnderHoldV2,
  decideOngoingAuthorizationV2,
  decideOneOffReminderUnderHoldV2,
  deferScopeIsExplicitV2,
  learningDoesNotReleaseHoldV2,
  skipAffectsOnlyThisDisplayV2,
  type ObjectiveHoldV2,
} from "./review-authorization-rules-v2.ts";

const HOLD: ObjectiveHoldV2 = { objectiveId: "obj-1", reasonCode: "user_deferred_objective" };

describe("§9.1 行 2：目标排除优先于一切持续授权来源，但只管被排除的那个目标", () => {
  it("笔记订阅这一发排不到被排除的目标上", () => {
    assert.deepEqual(
      decideOngoingAuthorizationV2({ objectiveId: "obj-1", source: "note_subscription", hold: HOLD }),
      { allowed: false, reasonCode: "objective_held" },
    );
  });

  it("卡片订阅这一发同样排不到它上（两个来源都不能绕过）", () => {
    assert.equal(
      decideOngoingAuthorizationV2({ objectiveId: "obj-1", source: "card_review", hold: HOLD }).allowed,
      false,
    );
  });

  it("结算那一发也不能把被排除的目标自动加回来", () => {
    assert.equal(
      decideOngoingAuthorizationV2({ objectiveId: "obj-1", source: "learning_observed", hold: HOLD }).allowed,
      false,
      "用户点了「暂不安排」，最刺眼的违反就是下一次结算又排回来",
    );
  });

  it("没有排除时正常放行——否则上一条只是恒假", () => {
    assert.deepEqual(
      decideOngoingAuthorizationV2({ objectiveId: "obj-1", source: "card_review", hold: null }),
      { allowed: true },
    );
  });

  it("同篇笔记里别的目标不受影响（规则原话：不停止其他目标）", () => {
    assert.deepEqual(
      decideOngoingAuthorizationV2({ objectiveId: "obj-2", source: "note_subscription", hold: HOLD }),
      { allowed: true },
    );
  });
});

describe("§9.1 行 3：排除还有效时开启复习，不能暗中复活", () => {
  it("没点恢复就只是明示，不落安排", () => {
    assert.deepEqual(decideEnableUnderHoldV2({ hold: HOLD, releasesHold: false }),
      { outcome: "needs_explicit_release" });
  });

  it("点了「恢复此目标并开启」才解除并排上", () => {
    assert.deepEqual(decideEnableUnderHoldV2({ hold: HOLD, releasesHold: true }),
      { outcome: "released_and_scheduled" });
  });

  it("没有排除时直接排上（这一格挡的是恒假判据）", () => {
    assert.deepEqual(decideEnableUnderHoldV2({ hold: null, releasesHold: false }),
      { outcome: "scheduled" });
  });
});

describe("§9.1 行 1：暂停只停那个来源", () => {
  it("两个来源都在时暂停笔记订阅，卡片来源仍撑着这条安排", () => {
    assert.deepEqual(
      applySourcePauseV2({ sources: ["note_subscription", "card_review"], pausedSource: "note_subscription" }),
      { remainingSources: ["card_review"], stillCoveredBy: ["card_review"] },
    );
  });

  it("只有笔记订阅时暂停后确实没人撑了（偷偷联动与漏停在这一格分得开）", () => {
    assert.deepEqual(
      applySourcePauseV2({ sources: ["note_subscription"], pausedSource: "note_subscription" }).remainingSources,
      [],
    );
  });

  it("暂停卡片订阅不会把笔记订阅一起摘掉", () => {
    assert.deepEqual(
      applySourcePauseV2({ sources: ["note_subscription", "card_review"], pausedSource: "card_review" })
        .remainingSources,
      ["note_subscription"],
    );
  });
});

describe("§9.1 补充句：排除不动用户自己约定的一次性提醒", () => {
  it("一次性提醒仍放行，但要说明还有一条在", () => {
    assert.deepEqual(decideOneOffReminderUnderHoldV2({ hold: HOLD, reminder: "user_scheduled_once" }),
      { allowed: true, mustDiscloseCoexistingReminder: true });
  });

  it("没有排除时不必说明（否则那句提示会常年挂在屏上）", () => {
    assert.deepEqual(decideOneOffReminderUnderHoldV2({ hold: null, reminder: "user_scheduled_once" }),
      { allowed: true, mustDiscloseCoexistingReminder: false });
  });

  it("再次主动学习更新记录、不解除排除", () => {
    assert.deepEqual(learningDoesNotReleaseHoldV2(), { updatesEvidence: true, releasesHold: false });
  });
});

describe("§9.1 行 4：延后只改明确范围", () => {
  it("单次延后与按目标/维度延后都算说清楚了", () => {
    assert.deepEqual(deferScopeIsExplicitV2({ scope: "single_schedule" }), { explicit: true });
    assert.deepEqual(deferScopeIsExplicitV2({ scope: "objective_dimension" }), { explicit: true });
  });

  it("笔记级批量延后必须列出本次涉及的目标数", () => {
    assert.deepEqual(deferScopeIsExplicitV2({ scope: "note_batch" }),
      { explicit: false, reasonCode: "batch_scope_not_listed" });
    assert.deepEqual(deferScopeIsExplicitV2({ scope: "note_batch", listedObjectiveCount: 0 }),
      { explicit: false, reasonCode: "batch_scope_not_listed" });
    assert.deepEqual(deferScopeIsExplicitV2({ scope: "note_batch", listedObjectiveCount: 3 }),
      { explicit: true });
  });
});

describe("§9.1 行 5：略过只影响本次展示", () => {
  it("既不取消订阅也不记作已复习", () => {
    assert.deepEqual(skipAffectsOnlyThisDisplayV2(),
      { hidesFromPresentation: true, cancelsSubscription: false, recordsReviewEvidence: false });
  });
});
