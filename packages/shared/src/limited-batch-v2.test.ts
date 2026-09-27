/**
 * 有限批次的判据（39d W7-4 刀一；39 §9.4）。
 *
 * §9.4 那四句今天没有执法点，这一组把它们钉住。**每条都带正控制**，因为四条各自的
 * 后果都是具体的：
 *
 *  1. **批次不自动变长**（正控制：锁定后再来一批新的到期项 ⇒ 长度不变；她点「再来几道」
 *     ⇒ 才变长）。不锁的后果：她做第三题时后台一条到期任务进来，批次 5 变 6，
 *     于是「今天先到这里」永远说不出口。
 *  2. **轮换抽查已学过但较久未观察的**（正控制：给一颗"很久没被看"且**分数很好**的，
 *     它要进；而同一批里"刚看过"的不进）。只按最近挑，弱项永远排在前面。
 *  3. **被暂不安排的目标不被复活**（正控制：给一颗**已经到期**且**恰好是本批名额**的
 *     被排除目标 ⇒ 它仍然不进、且 `skipped` 里说得出 why）。这是与 W7-3 目标级排除
 *     同一事实的第二个读点。
 *  4. **未学习的新内容不自动生成到期任务；改过但没观察过的不作为遗忘处理**
 *     （正控制：两颗都没被观察过的，一个有源改动一个没有 ⇒ 都不进）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planLimitedBatchV2, type BatchCandidateV2 } from "./limited-batch-v2.ts";

const NOW = new Date("2026-09-27T09:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

function candidate(over: Partial<BatchCandidateV2> = {}): BatchCandidateV2 {
  return {
    objectiveId: "11111111-1111-4111-8111-111111111111",
    observed: true,
    lastObservedAt: ago(3),
    reviewHold: null,
    sourceChangedAt: null,
    reasonLine: "3 天前答过一次",
    ...over,
  };
}

const run = (candidates: BatchCandidateV2[], over: Record<string, unknown> = {}) =>
  planLimitedBatchV2({ candidates, lockedLength: 3, now: NOW, ...over });

test("W7-4：批次长度在开始时锁定，后台新到期不改变它", () => {
  const first = run([candidate({ objectiveId: "a", lastObservedAt: ago(1) })]);
  assert.equal(first.items.length, 1);
  assert.equal(first.lockedLength, 3, "本批锁的长度是 3");

  // 第二轮：后台又多了一条到期任务。**长度仍然是 3**（§9.4「不因后台新任务到期
  // 不断增加长度」）。
  const second = run([
    candidate({ objectiveId: "a", lastObservedAt: ago(1) }),
    candidate({ objectiveId: "b", lastObservedAt: ago(1) }),
    candidate({ objectiveId: "c", lastObservedAt: ago(2) }),
    candidate({ objectiveId: "d", lastObservedAt: ago(2) }),
  ], { lockedLength: first.lockedLength });
  assert.equal(second.items.length, 3, "候选变多了，批次长度必须**不变**");
  assert.equal(second.deferredCount, 1, "多出来的那一进「另外还有可回访内容」那一格");
});

test("W7-4 正对照：她点「再来几道」长度才增长（§9.4「用户主动加量才加入」）", () => {
  const more = run([candidate({ objectiveId: "a" }), candidate({ objectiveId: "b" }), candidate({ objectiveId: "c" })], {
    lockedLength: 1,
    userAskedForMore: 2,
  });
  assert.equal(more.lockedLength, 3, "只有她主动加量，长度才增长");
  assert.equal(more.items.length, 3);
});

test("W7-4：轮换抽查已学过但较久未观察的——**不看分数**", () => {
  // 正控制：给一颗"很久没被看"的目标（分数好与否这一层不参与），它要进轮换那一档。
  const batch = run([
    candidate({ objectiveId: "fresh", lastObservedAt: ago(1) }),
    candidate({ objectiveId: "stale", lastObservedAt: ago(60), reasonLine: "60 天前答过一次" }),
  ]);
  const reasons = Object.fromEntries(batch.items.map((item) => [item.objectiveId, item.reason]));
  assert.equal(reasons.stale, "rotation_stale", "较久未观察的那颗要进轮换那一档");
  assert.equal(reasons.fresh, "due_now", "刚看过的那颗是到期那一档，不是轮换");
});

test("W7-4 正对照：被暂不安排的目标**不被复活**，哪怕它已到期且恰好占着名额", () => {
  const batch = run([
    // 名额是 3，这里给 3 颗已到期的——其中一颗被排除。滤在前、排在后，所以被排除的
    // 不会占掉名额（先排后滤会让它把本该进来的人挤掉）。
    candidate({ objectiveId: "a", lastObservedAt: ago(1) }),
    candidate({ objectiveId: "held", lastObservedAt: ago(1), reviewHold: { createdAt: ago(2).toISOString() } }),
    candidate({ objectiveId: "b", lastObservedAt: ago(2) }),
  ]);
  assert.equal(batch.items.length, 2, "被排除的那颗不进，而名额给了别的到期项");
  assert.equal(batch.items.some((item) => item.objectiveId === "held"), false);
  const skipped = batch.skipped.find((entry) => entry.objectiveId === "held");
  assert.equal(skipped?.why, "held_by_user", "屏上要能说出「为什么这批里没有它」");
});

test("W7-4 正对照：未学习的新内容不自动生成到期任务；改过但没观察过的不作为遗忘", () => {
  const batch = run([
    candidate({ objectiveId: "brand-new", observed: false, lastObservedAt: null }),
    candidate({
      objectiveId: "changed-not-observed",
      observed: false,
      lastObservedAt: null,
      sourceChangedAt: ago(10),
    }),
  ]);
  assert.equal(batch.items.length, 0, "两颗都没被实际接触过：都不进批次");
  const whys = Object.fromEntries(batch.skipped.map((entry) => [entry.objectiveId, entry.why]));
  assert.equal(whys["brand-new"], "never_observed");
  assert.equal(whys["changed-not-observed"], "never_observed",
    "「改过但没动过」不作为遗忘处理——所以它与从没学过同档，不是「该复习了」");
});

test("W7-4：每一项都带**可解释的理由**（§9.4「优先级理由可解释」）", () => {
  const batch = run([candidate({ objectiveId: "a", reasonLine: "昨天到期，今天该回访" })]);
  assert.equal(batch.items[0]?.reasonLine, "昨天到期，今天该回访",
    "理由由读侧给，这一份逐字带过去——它不许自己编一句");
  assert.ok(batch.items[0]?.reason, "入项的档位要可枚举，屏上才能按档位分组显示");
});
