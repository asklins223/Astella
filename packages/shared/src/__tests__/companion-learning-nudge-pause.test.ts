/**
 * 40 §8.2「今天别催学习」**真的生效**。
 *
 * ## 为什么不能只测判据
 *
 * `evaluateLearningNudgePause` 测过不等于用户说那句话之后她真的会闭嘴。
 * 真实形状是：用户说「今天别催学习」→ 账号上的 `suggestion_pause` 记下**本地日**
 * → 跑完一轮学习 → `hookProactiveOnRunCompleted` 读到它 → 不再推「要继续吗」。
 *
 * 每一环都可能悄悄断掉，而最要紧的一环——**投递那侧真的读它了吗**——断掉时
 * 界面上什么异常都看不到，只是"她还是催我了"。
 *
 * ## 两条最容易写错的
 *
 *  1. **本地日不是时刻**。用户 23:50 说"今天别催"，压到明天下午是错的；
 *     用户 00:10 说，压掉明天一整天也是错的。两个都差一天。
 *  2. **不碰已授权安排**。到点提醒走 `arranged_reminder`，不归这一条管——
 *     否则用户说一句"别催"就把自己约好的事也丢了。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  evaluateLearningNudgePause,
  evaluateLearningSuggestion,
  localDateIn,
} from "../companion-proactive-quota.ts";
import { companionSuggestionPauseSchema } from "../contracts/companion-shell-contracts.ts";

// 本文件在 packages/shared/src/__tests__/ 下：往上一级 src、两级 shared、
// 三级 packages、四级才是仓库根。
const API = resolve(import.meta.dirname, "..", "..", "..", "..");
// 投递钩子在 apps/api 下，不在仓库根下 —— 少了这一段就找不到。
const hook = readFileSync(
  join(API, "apps", "api", "src", "modules", "companion-conversation", "delivery", "proactive-hook.ts"), "utf8",
);

test("本地日按用户时区算 —— UTC 会把话记到隔壁那天", () => {
  // UTC+8 的 00:30：本地已是 10-03，UTC 还是 10-02。
  const at = new Date("2026-10-02T16:30:00Z");
  assert.equal(localDateIn("Asia/Shanghai", at), "2026-10-03");
  // UTC-5 的 20:00：本地已是 10-02 晚，UTC 已是 10-03。
  assert.equal(localDateIn("America/New_York", new Date("2026-10-03T01:00:00Z")), "2026-10-02");
  // 拿不到时区就退回 UTC：算错一天的代价是"少催一次"，比"多催"轻。
  assert.equal(localDateIn(null, at), "2026-10-02");
});

test("说了「今天别催学习」⇒ 今天压住", () => {
  const pause = companionSuggestionPauseSchema.parse({
    paused: true, localDate: "2026-10-03", timezone: "Asia/Shanghai", reasonCodes: ["user_asked"],
  });
  const d = evaluateLearningNudgePause({ pause, now: new Date("2026-10-03T02:00:00Z") });
  assert.equal(d.suppressed, true);
  assert.equal(d.todayLocalDate, "2026-10-03");
});

test("跨天自动失效 —— 昨天说的「今天别催」不该压今天", () => {
  const pause = companionSuggestionPauseSchema.parse({
    paused: true, localDate: "2026-10-02", timezone: "Asia/Shanghai",
  });
  const d = evaluateLearningNudgePause({ pause, now: new Date("2026-10-03T02:00:00Z") });
  assert.equal(d.suppressed, false, "跨天了还在压 —— 那是无限期静音");
});

test("没说过时不压", () => {
  for (const pause of [null, undefined, { paused: false }, { paused: true }]) {
    const d = evaluateLearningNudgePause({ pause: pause as never, now: new Date("2026-10-03T02:00:00Z") });
    assert.equal(d.suppressed, false, "没说过却压住了");
  }
});

test("压的是**主动推荐学习**，不碰已授权安排", () => {
  const base = { suppressedLocalDate: "2026-10-03", todayLocalDate: "2026-10-03" };
  // 学习建议：压。
  assert.equal(evaluateLearningSuggestion({ kind: "learning_suggestion", ...base }).allow, false);
  // 约定提醒：照常。
  const reminder = evaluateLearningSuggestion({ kind: "arranged_reminder", ...base });
  assert.equal(reminder.allow, true,
    "「别催学习」把用户自己约好的安排也压掉了 —— 他丢掉了自己约的事");
  // 普通招呼也不归这一条管。
  assert.equal(evaluateLearningSuggestion({ kind: "ambient", ...base }).allow, true);
});

test("投递那侧**真的读了**这个暂停", () => {
  // 判据的对象是"用户说别催之后她还会不会催"，不是"函数被写出来了"。
  assert.match(hook, /suggestionPause/,
    "投递钩子没读账号上的 suggestionPause —— 用户说别催之后她照样催");
  assert.match(hook, /evaluateLearningNudgePause/);
  // 而且必须在入队**之前** return null，否则 delivery 已经写进去了。
  // 这个钩子不自己入队，它**返回一个 payload** 由上层入队。所以要验的是
  // 抑制判定排在那一个 return **之前** —— 否则 payload 已经交出去了，
  // 这里的 `return null` 只是摆设。
  const gate = hook.indexOf("evaluateLearningNudgePause(");
  const payloadReturn = hook.indexOf("return {", hook.indexOf("hookProactiveOnRunCompleted"));
  assert.ok(gate > 0, "找不到抑制判定");
  assert.ok(payloadReturn > gate,
    "抑制判定排在交付 payload 的 return 之后 —— payload 已经交出去了，return null 只是摆设");

  // 光"排在前面"还不够：**压住了就必须真的不交出去**。
  //
  // 这条曾经漏掉：把 `return null` 删掉（只记一条日志然后继续往下走）时，
  // 上面那条"排在前面"仍然是绿的 —— 特征却已经回来了，9 条全过。
  // 所以要单独验**分支体内**真的有那句 return。
  const blockStart = hook.indexOf("if (pauseVerdict.suppressed) {");
  const blockEnd = hook.indexOf("\n  }", blockStart);
  assert.ok(blockStart > 0 && blockEnd > blockStart, "找不到抑制分支");
  const block = hook.slice(blockStart, blockEnd);
  assert.match(block, /return null;/,
    "压住了却没有 return null —— payload 继续往下交，用户照样被催");
});

test("投递那侧读的是**本地日**，不是 `until` 时刻", () => {
  assert.match(hook, /localDate/,
    "投递那侧没有走本地日语义 —— 用时刻会在跨天时差一天");
});

test("【自证】判据认得出「用 now+24h 代替本地日」这个真实退化", () => {
  // 退化形状：把「今天」当成"从现在起 24 小时"。
  const at = new Date("2026-10-03T15:00:00Z");
  assert.equal(localDateIn("Asia/Shanghai", at), "2026-10-03");
  // 凌晨说的那句话：now+24h 会落到**后一天**。
  const lateNight = new Date("2026-10-03T16:30:00Z"); // 上海 10-04 00:30
  assert.equal(localDateIn("Asia/Shanghai", lateNight), "2026-10-04");
  assert.equal(new Date(lateNight.getTime() + 24 * 3600_000).toISOString().slice(0, 10), "2026-10-04",
    "自证样本：两个口径在这条上恰好一致，所以要用前面那条（23:50 说过）才分得开");
  // 23:50 说过的情况才真正分得开：
  const almostMidnight = new Date("2026-10-03T15:50:00Z"); // 上海 10-03 23:50
  assert.equal(localDateIn("Asia/Shanghai", almostMidnight), "2026-10-03");
  assert.equal(new Date(almostMidnight.getTime() + 24 * 3600_000).toISOString().slice(0, 10), "2026-10-04",
    "自证：此刻两个口径差一天 —— 这正是「今天」不能当时刻的证据");
});

test("【自证】判据认得出「投递那侧完全不读暂停」这个真实退化", () => {
  // 退化形状：钩子里没有那一段。
  const degraded = "const availability = presence?.presence ?? 'online'; if (!evaluateTriggeredPush(...).allow) return null;";
  assert.ok(!/evaluateLearningNudgePause/.test(degraded), "自证样本没造好");
  assert.match(hook, /evaluateLearningNudgePause/, "自证：真钩子里确实有，所以判据今天是绿的");
});
