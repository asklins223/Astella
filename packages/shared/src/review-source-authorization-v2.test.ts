/**
 * 来源级停用的判据（39d W7-8 刀三；39 §9.1 规则表行 1）。
 *
 * 这一份是本轮查出来的缺口的**判定侧**：统一写入安排的边界今天只问目标级排除，
 * **完全不问来源级停用**——于是用户在笔记上停掉「卡片复习」之后，结算那一发照样排期，
 * **那颗按钮拨了等于没拨**。
 *
 * 三档各自带正控制，因为它们的**后果不同**，合成一档之后就会出现"她从没开过"与
 * "她开了又停了"走同一条路的情形——而 §9.1 把它们说成两件不同的事：
 *  1. **covered**（还有活的来源）：该排。停一个来源**不误删另一个**（行 1）。
 *  2. **paused_all**（所有相关来源都停着）：这一发不该排，库里什么都不写。
 *  3. **never_authorized**（一份授权都没有）：§9.1「创建卡、读过笔记或结束一轮都
 *     **不默认授权**未来提醒」——这一格要**问**，不许默默替她开。第三档最容易被漏，
 *     专门为它留了一条正控制。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideSourceAuthorizationV2 } from "./review-authorization-rules-v2.ts";

test("W7-8 刀三：还有活的来源 ⇒ 该排（停一个来源不误删另一个）", () => {
  const decided = decideSourceAuthorizationV2({
    // 卡片订阅被停了，但来源笔记的订阅还开着 ⇒ 仍然覆盖。
    cardReview: "paused",
    noteSubscriptions: ["active"],
  });
  assert.equal(decided.authorization, "covered");
  assert.equal(decided.activeSources, 1);
  assert.equal(decided.pausedSources, 1, "停掉的那一档也要数出来：屏上要念「仍由谁撑着」");
});

test("W7-8 刀三：所有相关来源都停着 ⇒ 这一发不该排", () => {
  const decided = decideSourceAuthorizationV2({
    cardReview: "paused",
    noteSubscriptions: ["paused"],
  });
  assert.equal(decided.authorization, "paused_all");
  assert.equal(decided.activeSources, 0);
});

test("W7-8 刀三 正控制：一份授权都没有 ⇒ 「从没开过」，不是「她停掉了」", () => {
  // §9.1「创建卡、读过笔记或结束一轮都不默认授权未来提醒」。这一格与上一档合成一条的
  // 后果是：用户从没用过订阅，却在结算里被安静地排了期。
  const decided = decideSourceAuthorizationV2({
    cardReview: null,
    noteSubscriptions: [],
  });
  assert.equal(decided.authorization, "never_authorized");
  assert.equal(decided.pausedSources, 0, "她没停过任何东西：停用数不该是 1");
});

test("W7-8 刀三：卡片订阅开着 ⇒ 覆盖，与来源笔记那一档无关", () => {
  const decided = decideSourceAuthorizationV2({
    cardReview: "active",
    noteSubscriptions: ["paused", "paused"],
  });
  assert.equal(decided.authorization, "covered", "停了笔记订阅不该把还开着的卡片订阅一起摘掉");
  assert.equal(decided.activeSources, 1);
  assert.equal(decided.pausedSources, 2);
});

test("W7-8 刀三：同一颗目标有多篇来源笔记时，一篇停着不够", () => {
  // 读侧给的是**全部**来源笔记的档位（去重前）。两篇一篇停一篇开 ⇒ 仍然覆盖。
  assert.equal(
    decideSourceAuthorizationV2({ cardReview: null, noteSubscriptions: ["paused", "active"] }).authorization,
    "covered",
  );
  assert.equal(
    decideSourceAuthorizationV2({ cardReview: null, noteSubscriptions: ["paused", "paused"] }).authorization,
    "paused_all",
  );
});
