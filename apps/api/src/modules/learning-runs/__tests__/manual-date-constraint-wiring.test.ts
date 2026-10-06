/**
 * W7-8 刀二：结算那四个写入点**真的过了**手动日期约束（39 §9.1「在手动日期约束仍有效时，
 * 自动策略不能悄悄把提醒提前」）。
 *
 * 判据本身在 `@astella/shared/review-manual-date-constraint-v2`（纯函数，单测在那份文件
 * 里）。这一组钉的是**接线**——判据再对，四个写入点没接就等于没做。
 *
 * 三格，每格带正对照：
 *  1. **四个写入点一个都不许直接落 `decision.nextReviewAt`**。少接一处就是那一条路径
 *     继续悄悄提前，而它**不会**让任何别的测试红——正因如此才要静态读。
 *  2. **正对照：夹紧那一发读的是 `user_deferred_until` 那一列**，读错列就等于没夹。
 *  3. **正对照：抬过要留痕**。§9.1「不能悄悄」——悄悄抬与悄悄提前是同一种毛病，
 *     方向相反而已；不写日志，回执与库里都看不出这一天被人动过。
 *
 * 这是一份**静态**判据（读源码），不是跑数据库的：那几个写入点在一次真实结算里才会
 * 到达，而它们各自的到达条件互不相同（facet_evidence 那一支压根不排期）。静态读
 * 换来的是"接漏了当场红"，代价是它不证明运行时行为——运行时那一半是集成档的事。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 本文件在 apps/api/src/modules/learning-runs 下，到仓库根是**五**层（learning-runs → modules → src → api → apps → 根）。数错层级的后果很阴：
// 路径全都不存在，而"断言只检查读到的内容"那条会一路绿到底——第一版就是这么错的。

const TICK = "apps/api/src/modules/learning-runs/processing/run-processing-tick.ts";
const source = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "..", "..", TICK), "utf8");

test("W7-8 刀二：四个排期写入点**没有一处**直接落策略日期", () => {
  const bare = source.match(/nextReviewAt: decision\.nextReviewAt,/g) ?? [];
  assert.deepEqual(bare, [],
    `还有 ${bare.length} 处直接落策略算出来的那一天——那就是"悄悄提前"仍然会发生的那几处。`
    + "每一处都要先过 clampToManualDateV2。");
  // 四个写入点都拿到了夹紧后的日期。
  const clamped = (source.match(/nextReviewAt: (clamped|successorClamped)\.nextReviewAt,/g) ?? []).length;
  assert.equal(clamped, 4, `应当有四处接上夹紧后的日期，实到 ${clamped} 处`);
});

test("W7-8 刀二 正对照：夹紧那一发读的是 `user_deferred_until` 那一列", () => {
  // 读错列就等于没夹：那一列是展示层延后（§18.1），而策略日期是官方到期。
  assert.match(source, /select\(\{ manualDeferredUntil: reviewSchedules\.userDeferredUntil \}\)/,
    "夹紧那一发没有读 user_deferred_until：它读的是别的列，或者根本没读。");
  assert.match(source, /manualDeferredUntil: rows\[0\]\?\.manualDeferredUntil \?\? null/,
    "读出来的那一列没有递给判据");
});

test("W7-8 刀二 正对照：抬过要留痕（§9.1「不能悄悄」）", () => {
  assert.match(source, /if \(clamped\.raisedByConstraint\)/,
    "抬过没有留痕：回执与库里都看不出这一天被人动过");
  assert.match(source, /if \(successorClamped\.raisedByConstraint\)/,
    "继任那一支抬过没有留痕");
  assert.match(source, /手动日期约束抬过了策略日期/,
    "留痕那一行不见了：没有文案就分不出这是约束抬的还是策略本来就那样");
});

test("W7-8 刀二：继任那一支按「需求已换版」处理，新建那一支不", () => {
  // §9.1「手动日期约束属于本次需求版本」：那一格被消费掉就是换版的那一刻，
  // 约束不该再压住下一轮。写反了就是"约束变成永久禁止以后安排"。
  const successorBlock = source.slice(source.indexOf("const successorClamped = await clampToManualDateV2"));
  assert.match(successorBlock.slice(0, 600), /requirementChanged: true/,
    "继任那一支没有把 requirementChanged 置真：约束会一直压着下一轮");
  const createBlock = source.slice(source.indexOf("const clamped = await clampToManualDateV2"));
  assert.match(createBlock.slice(0, 600), /requirementChanged: false/,
    "新建那一支不该当成换版：那一格还没被消费过");
});

test("W7-8 刀二：约束没有渗进唯一写入边界（两件事不许搅在一起）", () => {
  // `review-schedule-boundary.ts` 是"唯一写入安排"的边界，写的是**排期**；
  // 手动日期是**展示层延后**（§18.1/§18.3）。让边界替展示层改官方日期，就是把
  // 两件事搅成一件——本仓库反复记的同一个错。
  const boundary = readFileSync(
    join(import.meta.dirname, "..", "..", "..", "..", "..", "..", "apps/api/src/modules/review/review-schedule-boundary.ts"),
    "utf8",
  );
  assert.ok(!/user_deferred_until/.test(boundary),
    "手动日期约束渗进唯一写入边界了：边界写排期，展示层延后归延后那一发");
});
