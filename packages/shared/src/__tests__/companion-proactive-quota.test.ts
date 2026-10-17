import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AMBIENT_STALE_MS,
  evaluateLearningNudgePause,
  evaluateLearningSuggestion,
  evaluateStaleAfterResume,
  learningNudgeSuppressed,
  localDateIn,
} from "../companion/companion-proactive-quota.ts";

test("学习建议只在用户选择的本地日暂停", () => {
  assert.equal(learningNudgeSuppressed({ suppressedLocalDate: "2026-10-02", todayLocalDate: "2026-10-02" }), true);
  assert.equal(learningNudgeSuppressed({ suppressedLocalDate: "2026-10-02", todayLocalDate: "2026-10-03" }), false);
  assert.equal(evaluateLearningSuggestion({ kind: "learning_suggestion", suppressedLocalDate: "2026-10-02", todayLocalDate: "2026-10-02" }).allow, false);
  assert.equal(evaluateLearningSuggestion({ kind: "arranged_reminder", suppressedLocalDate: "2026-10-02", todayLocalDate: "2026-10-02" }).allow, true);
});

test("恢复后丢弃过时的普通主动交付，保留约定提醒", () => {
  for (const kind of ["ambient", "related_recall", "diary_updated"] as const) {
    assert.equal(evaluateStaleAfterResume({ kind, ageMs: AMBIENT_STALE_MS, arrangementStillValid: true }).keep, false, kind);
  }
  assert.equal(evaluateStaleAfterResume({ kind: "ambient", ageMs: 1_000, arrangementStillValid: true }).keep, true);
  assert.equal(evaluateStaleAfterResume({ kind: "arranged_reminder", ageMs: AMBIENT_STALE_MS * 10, arrangementStillValid: false }).keep, true);
});

test("暂停日期与今天都按账号时区计算", () => {
  const at = new Date("2026-10-02T16:30:00Z");
  assert.equal(localDateIn("Asia/Shanghai", at), "2026-10-03");
  assert.equal(evaluateLearningNudgePause({ pause: { paused: true, localDate: "2026-10-03", timezone: "Asia/Shanghai" }, now: at }).suppressed, true);
});
