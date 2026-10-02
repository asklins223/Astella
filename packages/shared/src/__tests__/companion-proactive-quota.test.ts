/**
 * 40 §8「主动表达」的额度与丢弃。
 *
 * 每条都对应一个具体的、可静默发生的错：额度绑在墙上时钟（每半小时又冒一条）、
 * 抑制写成取消安排（用户丢掉自己约好的事）、过时消息补发（回来先读一堆过期的话）、
 * 切页重置额度（§8.2 明令不重置）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  AMBIENT_QUOTA_PER_USAGE,
  AMBIENT_STALE_MS,
  USAGE_SESSION_GAP_MS,
  continuesUsageSession,
  evaluateAmbientQuota,
  evaluateLearningSuggestion,
  evaluateStaleAfterResume,
  learningNudgeSuppressed,
} from "../companion-proactive-quota.ts";

test("一次持续使用期间，普通招呼/感想最多一条", () => {
  const base = { kind: "ambient" as const, candidatesThisRound: 1, rank: 0, lastAmbientIgnored: false };
  assert.equal(evaluateAmbientQuota({ ...base, ambientDeliveredThisUsage: 0 }).allow, true);
  assert.equal(evaluateAmbientQuota({ ...base, ambientDeliveredThisUsage: 1 }).allow, false,
    "额度用掉之后又冒了一条");
  assert.equal(AMBIENT_QUOTA_PER_USAGE, 1, "首版就是一条（§8.2）");
});

test("多个普通候选只选一个，不轮流补播", () => {
  const base = { kind: "ambient" as const, ambientDeliveredThisUsage: 0, candidatesThisRound: 3, lastAmbientIgnored: false };
  assert.equal(evaluateAmbientQuota({ ...base, rank: 0 }).allow, true);
  for (const rank of [1, 2]) {
    const d = evaluateAmbientQuota({ ...base, rank });
    assert.equal(d.allow, false, `第 ${rank} 个候选也被放行了 —— 那就是轮流补播`);
    assert.equal(d.reason, "picked_another_candidate");
  }
});

test("站内切页、回首页、切窗口都不重置额度", () => {
  // 这三件事在客户端看来都只是「还在用」，在场间隔远小于阈值。
  for (const ms of [1_000, 30_000, 5 * 60_000]) {
    assert.equal(continuesUsageSession({ msSincePresence: ms }), true,
      `${ms}ms 的在场被当成离开了 —— 那切一次页就会重置额度`);
  }
  assert.equal(continuesUsageSession({ msSincePresence: USAGE_SESSION_GAP_MS }), false,
    "超过阈值仍算同一次使用");
  assert.equal(continuesUsageSession({ msSincePresence: null }), false,
    "从来没在场过 —— 那是第一次，不是续上一次");
});

test("用户忽略消息，不换一种说法再问", () => {
  const d = evaluateAmbientQuota({
    kind: "ambient", ambientDeliveredThisUsage: 0, candidatesThisRound: 1, rank: 0, lastAmbientIgnored: true,
  });
  assert.equal(d.allow, false);
  assert.equal(d.reason, "ignored_no_rewrite",
    "被忽略之后换了措辞又问了一次");
});

test("约定提醒不占那一条额度（§8.2「仍按其独立规则持久送达」）", () => {
  for (const kind of ["arranged_reminder", "related_recall", "diary_updated"] as const) {
    const d = evaluateAmbientQuota({ kind, ambientDeliveredThisUsage: 5, candidatesThisRound: 3, rank: 2, lastAmbientIgnored: true });
    assert.equal(d.allow, true, `${kind} 被额度或忽略反馈挡住了 —— 它有自己独立的规则`);
    assert.equal(d.reason, "kind_not_quota_bound");
  }
});

test("「今天别催学习」只压今天，且**不碰已授权安排**", () => {
  assert.equal(learningNudgeSuppressed({ suppressedLocalDate: "2026-10-02", todayLocalDate: "2026-10-02" }), true);
  assert.equal(learningNudgeSuppressed({ suppressedLocalDate: "2026-10-02", todayLocalDate: "2026-10-03" }), false,
    "跨天了还在压 —— 那是无限期静音");
  assert.equal(learningNudgeSuppressed({ suppressedLocalDate: null, todayLocalDate: "2026-10-02" }), false);

  const suppressed = evaluateLearningSuggestion({ kind: "learning_suggestion", suppressedLocalDate: "2026-10-02", todayLocalDate: "2026-10-02" });
  assert.equal(suppressed.allow, false);
  assert.equal(suppressed.reason, "suppressed_today");
  // 约定提醒在同一天**照常**——用户说的是"别催学习"，不是"取消我约的事"。
  const reminder = evaluateLearningSuggestion({ kind: "arranged_reminder", suppressedLocalDate: "2026-10-02", todayLocalDate: "2026-10-02" });
  assert.equal(reminder.allow, true, "「别催学习」把已授权的约定提醒也压掉了");
});

test("恢复后：普通招呼/过时感想/日记气泡直接丢弃，不形成消息债务", () => {
  const old = AMBIENT_STALE_MS + 1;
  for (const kind of ["ambient", "related_recall", "diary_updated"] as const) {
    assert.equal(evaluateStaleAfterResume({ kind, ageMs: old, arrangementStillValid: true }).keep, false,
      `${kind} 过期后被补发了`);
  }
  // 新的照常。
  assert.equal(evaluateStaleAfterResume({ kind: "ambient", ageMs: 1_000, arrangementStillValid: true }).keep, true);
});

test("约定提醒不因为过时而丢 —— 它有时间语义（§8.2「约定提醒先核对有效性」）", () => {
  const d = evaluateStaleAfterResume({ kind: "arranged_reminder", ageMs: AMBIENT_STALE_MS * 10, arrangementStillValid: false });
  assert.equal(d.keep, true, "约定提醒被按时效丢掉了");
  assert.equal(d.reason, "stale_kind_keeps_value");
});

test("【自证】判据认得出「额度绑在墙上时钟」这个真实退化", () => {
  // 退化形状：用「今天已经说过没有」当天重置，于是每半小时又冒一条。
  const wallClockQuota = (minutesSinceLast: number): boolean => minutesSinceLast >= 30;
  assert.equal(wallClockQuota(31), true, "自证样本：31 分钟后确实又放行了");
  // 正控制：真判据在同样条件下（额度已用）不放行。
  const real = evaluateAmbientQuota({
    kind: "ambient", ambientDeliveredThisUsage: 1, candidatesThisRound: 1, rank: 0, lastAmbientIgnored: false,
  });
  assert.equal(real.allow, false, "自证：真判据靠使用期间的计数，与墙上时钟无关");
});

test("【自证】判据认得出「把别催学习写成取消安排」这个更重的退化", () => {
  const degraded = (kind: string) => kind === "learning_suggestion" || kind === "arranged_reminder";
  assert.equal(degraded("arranged_reminder"), true, "自证样本：退化版连约定提醒一起压");
  const real = evaluateLearningSuggestion({
    kind: "arranged_reminder", suppressedLocalDate: "2026-10-02", todayLocalDate: "2026-10-02",
  });
  assert.equal(real.allow, true, "自证：真判据不碰约定提醒");
});
