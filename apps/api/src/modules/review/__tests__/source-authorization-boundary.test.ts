/**
 * W7-8 刀三：统一写入安排的边界**真的问了来源级停用**（39 §9.1 规则表行 1）。
 *
 * ## 这一格今天为什么是空的
 *
 * 边界（`review-schedule-boundary.ts`）只问目标级排除（`liveHoldForObjectiveV2`），
 * **完全不问来源级停用**。后果很具体：用户在笔记上停掉「卡片复习」这个来源之后，
 * 结算那一发照样排期——**那颗按钮拨了等于没拨**。W7-3 刀五把来源记在库里了，
 * 但**没有任何一处读它来决定排不排**。
 *
 * ## 三格与它们的正对照
 *
 *  1. **边界问了**（`sourceAuthorizationForObjectiveV2` 在那道闸里）。
 *  2. 正对照：**两档挡、且说不同的话**——`paused_all`（她停掉了，照办）与
 *     `never_authorized`（**没人替她开过授权**，§9.1「不默认授权未来提醒」）不能并档，
 *     并了之后界面上两件不同的事会念成同一句。
 *  3. 正对照：**判定在纯函数、读侧在服务、边界只问结论**。判据里跨两张表（目标自己的
 *     卡片订阅 ＋ 它那些来源笔记的订阅），那不是边界该长出的样子。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BOUNDARY = "apps/api/src/modules/review/review-schedule-boundary.ts";
const read = (relative: string) => readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "..", "..", relative), "utf8");
const source = read(BOUNDARY);

test("W7-8 刀三：边界在**目标级排除之后**问来源级停用", () => {
  const holdAt = source.indexOf("liveHoldForObjectiveV2(tx, {");
  const authAt = source.indexOf("sourceAuthorizationForObjectiveV2(tx, {");
  assert.ok(holdAt > 0, "边界里没有目标级排除那一问了");
  assert.ok(authAt > 0, "**边界没有问来源级停用**——用户在笔记上停掉一个来源之后，"
    + "结算那一发照样排期，那颗按钮拨了等于没拨。");
  assert.ok(authAt > holdAt, "来源级那一问要在目标级之后：排除优先于一切授权来源（§9.1 行 2）");
});

test("W7-8 刀三 正对照：两档挡，且分列成两个字段", () => {
  // `held`（目标级排除）与 `sourcePaused`（来源级停用）是规则表里**不同的行**，
  // 界面上要说不同的话。并成一档之后，"她按掉了这个目标"与"她停掉了这个来源"
  // 会念成同一句。
  assert.match(source, /readonly held: boolean;/);
  assert.match(source, /readonly sourcePaused\?: boolean;/);
  assert.match(source, /readonly neverAuthorized\?: boolean;/);
  assert.match(source, /authorization\.authorization === "paused_all"/,
    "「所有来源都停着」那一档没被挡");
  assert.match(source, /authorization\.authorization === "never_authorized"/,
    "「从没开过授权」那一档没被问——§9.1「创建卡、读过笔记或结束一轮都不默认授权未来提醒」");
});

test("W7-8 刀三 正对照：判定在纯函数，读侧在服务，边界只问结论", () => {
  // 跨两张表的活（目标自己的卡片订阅 ＋ 它那些来源笔记的订阅）不是边界该长出的样子。
  // 边界一长出来，它就要知道来源表的形状，而那张表会变。
  const subscriptions = read("apps/api/src/modules/review/review-subscriptions.ts");
  assert.match(subscriptions, /export async function sourceAuthorizationForObjectiveV2/,
    "读侧那一档不在订阅服务里");
  assert.match(subscriptions, /decideSourceAuthorizationV2/,
    "读侧没有把跨表的活交给纯函数");
  // 边界自己不该查来源表。
  assert.ok(!/reviewSubscriptionsV2/.test(source),
    "边界自己去读来源表了：跨表的活该在服务里，边界只问结论");
  assert.ok(!/learningObjectiveOriginsV2/.test(source),
    "边界自己去读目标血缘了：那是为了知道「哪些来源笔记的订阅算数」，是服务那一层的活");
});

test("W7-8 刀三：两档都挡的时候**库里什么都不写**", () => {
  // 与 `held` 那一支同一形状：交回 null id，而不是报"已经有一条排着了"。
  for (const marker of ['authorization.authorization === "paused_all"', 'authorization.authorization === "never_authorized"']) {
    const at = source.indexOf(marker);
    const block = source.slice(at, at + 260);
    assert.match(block, /scheduleId: null/,
      `${marker} 那一档没有交回 null：会让调用方以为"已经有一条排着了"`);
    assert.ok(!/insert\(reviewSchedules\)/.test(block),
      `${marker} 那一档之后仍然写了库：这一发不该排`);
  }
});
