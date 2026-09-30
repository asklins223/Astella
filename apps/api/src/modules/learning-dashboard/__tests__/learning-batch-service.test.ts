/**
 * W7-4 刀二：读侧**只读库、不判**（39d §9.4）。
 *
 * 刀一的四条规定在 `@ailearn/shared/limited-batch-v2` 的纯函数里。这一组钉的是
 * **分界**：读侧把候选按判据要的形状收齐，然后交给判据。任何一条规定被搬到读侧，
 * 就会出现"从首页进来和从批次页进来不是同一批"——而分叉的后果是屏上读不出来
 * （两处各自都合理）。
 *
 * 三格各带正对照：
 *  1. **读侧调用了判据**，没有自己排、自己滤。
 *  2. 正对照：**排除是喂进去的**，不是在读侧判的——判据那一格是唯一说了算的地方。
 *  3. 正对照：**长度的唯一增长入口是 `userAskedForMore`**。这一格最容易被绕过
 *     （"再多来几道吧"顺手写成"把现在到期的都补上"），而绕过的后果正是 §9.4 禁止的
 *     「不因后台新任务到期不断增加长度」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVICE = readFileSync(
  join(import.meta.dirname, "..", "learning-batch-service.ts"),
  "utf8",
);

test("W7-4 刀二：读侧调用了刀一的判据", () => {
  assert.match(SERVICE, /import \{[\s\S]*planLimitedBatchV2[\s\S]*\} from "@ailearn\/shared\/limited-batch-v2"/,
    "读侧没有 import 刀一的判据：它自己在排、自己判，于是「从哪个页面进来」会影响这一批是什么。");
  assert.match(SERVICE, /return planLimitedBatchV2\(\{/,
    "读侧没有把候选交给判据");
  // 四条规定在读侧**不该**各出现一次排序/过滤的痕迹。
  assert.ok(!/\.sort\(/.test(SERVICE),
    "读侧自己排序了：批次顺序必须在判据里一处说了算");
});

test("W7-4 刀二 正对照：排除是**喂进去**的，不在读侧自己判", () => {
  // 判据第 3 条是唯一说了算的地方（"被暂不安排的目标不被复活"）。读侧照旧要读活行，
  // 但它只负责 `reviewHold: heldById.get(...) ?? null` 这一格。
  assert.match(SERVICE, /reviewHold: heldById\.get\(objectiveId\) \?\? null/,
    "活排除那一格没有喂给判据");
  assert.match(SERVICE, /isNull\(objectiveReviewHoldsV2\.releasedAt\)/,
    "读的是**活行**吗？已解除的排除不算排除——把 releasedAt 也读进来会让解除无效。」");
  assert.ok(!/reason: "held_by_user"|why: "held_by_user"/.test(SERVICE),
    "读侧自己判了排除：那一格搬到了读侧，判据那一格就成了摆设");
});

test("W7-4 刀二 正对照：长度的唯一增长入口是 `userAskedForMore`", () => {
  assert.match(SERVICE, /userAskedForMore: input\.userAskedForMore/,
    "读侧没有把加量那一格原样递给判据");
  // 读侧**不许**自己算一个"看起来该多给几道"的数。
  assert.ok(!/limit\(\s*\d+\s*\)/.test(SERVICE),
    "读侧写死了一个 limit：长度由它说了算，而不是由判据的锁定规则说了算");
  assert.match(SERVICE, /lockedLength: input\.lockedLength/,
    "读侧没有把锁定的长度原样传下去");
});

test("W7-4 刀二 正对照：候选来自**被消费过的安排**，不是「建过目标」", () => {
  // §9.4「未学习的新内容不自动生成到期任务」。"她建过目标"**不算**学过。
  assert.match(SERVICE, /eq\(reviewSchedules\.status, "completed"\)/,
    "候选不是按「被消费过的安排」收的：建过目标就当学过了，于是新内容自动进了复习。");
  assert.match(SERVICE, /observedIds\.length === 0[\s\S]{0,300}planLimitedBatchV2\(\{ candidates: \[\]/,
    "一颗都没学过时应当直接交回空批，而不是去造一批『建议学的东西』」");
});
