import { test } from "node:test";
import assert from "node:assert/strict";
import { companionStudyDurations, isAwarenessLearning, isStudySessionContinuing } from "../participation.ts";

test("foreground study merges overlapping devices and excludes background gaps", () => {
  const now = Date.parse("2026-10-13T08:00:00Z"), minute = 60_000;
  const span = (a: number, b: number) => ({ started_at: new Date(now + a * minute), ended_at: new Date(now + b * minute) });
  const result = companionStudyDurations([span(-60, -45), span(-50, -40), span(-30, -20), span(-3, 0)], now);
  assert.equal(result.foregroundStudyMs, 33 * minute);
  assert.equal(result.continuousStudyMs, 3 * minute);
  assert.equal(result.estimated, true);
  assert.equal("fatigued" in result, false);
});
test("sleep/background does not create study time and old spans expire", () => {
  const now = Date.parse("2026-10-13T08:00:00Z");
  assert.equal(companionStudyDurations([], now).continuousStudyMs, 0);
  const durations = companionStudyDurations([{ started_at: new Date(now - 6 * 3_600_000), ended_at: new Date(now - 5 * 3_600_000) }], now);
  assert.equal(durations.foregroundStudyMs, 0);
});

test("「还在学」要看前台、未锁屏、宿主报告学习页三件事都成立", () => {
  const base = { foreground: true, unlocked: true, learning: true };
  assert.equal(isAwarenessLearning(base), true);
  assert.equal(isAwarenessLearning({ ...base, unlocked: false }), false, "锁屏那一刻就不是在学了");
  assert.equal(isAwarenessLearning({ ...base, foreground: false }), false, "切到后台不算继续");
  assert.equal(isAwarenessLearning({ ...base, learning: false }), false, "宿主没报学习页就不算");
});

/**
 * 2026-10-14 实测的重复主动提示：同一条学习时段里两声心跳隔 59 秒，
 * 旧判据拿 45 秒（心跳新鲜度）当「同一段」的边界，于是第二声被判成「又开始学了」，
 * 同一段学习给用户连着推了两条一模一样的「好，学起来了。我不打扰，就露个面…」。
 * 段的边界只有一处：离开超过 STUDY_SESSION_GAP_MS 才是新的一段。
 */
test("同一段学习里的下一声心跳不算重新开始（59 秒那条实测）", () => {
  const now = Date.parse("2026-10-14T05:13:14Z");
  const learning = { foreground: true, unlocked: true, learning: true };
  const previous = { context: { ...learning, typing: false, speaking: false } as never, updated_at: new Date(now - 59_000) };

  assert.equal(isStudySessionContinuing(previous, now), true,
    "隔 59 秒的心跳仍在同一段里——这正是实测重复的那一次");

  const afterGap = { ...previous, updated_at: new Date(now - 6 * 60_000) };
  assert.equal(isStudySessionContinuing(afterGap, now), false, "离开超过五分钟后回来是新的一段");
});

test("上一声不在学习，或根本没有上一声：都是新的开始", () => {
  const now = Date.parse("2026-10-14T05:13:14Z");
  assert.equal(isStudySessionContinuing(null, now), false, "第一次心跳没有上一声可比");
  assert.equal(isStudySessionContinuing(undefined, now), false);
  const idle = { context: { foreground: true, unlocked: true, learning: false } as never, updated_at: new Date(now - 10_000) };
  assert.equal(isStudySessionContinuing(idle, now), false, "上一声还在首页，这次进学习页是新开始");
  const locked = { context: { foreground: true, unlocked: false, learning: true } as never, updated_at: new Date(now - 10_000) };
  assert.equal(isStudySessionContinuing(locked, now), false, "上一声锁着屏，回来是新开始");
});

