import { test } from "node:test";
import assert from "node:assert/strict";
import { companionStudyDurations } from "../participation.ts";

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
