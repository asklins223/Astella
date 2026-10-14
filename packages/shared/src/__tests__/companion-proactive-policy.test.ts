import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateTriggeredPush,
  isWithinQuietHours,
  PROACTIVE_CADENCE_MS,
  proactiveCadenceMs,
  routineCadenceBlocked,
} from "../companion-proactive-policy.ts";

test("例行主动间隔按账号参与档位判定", () => {
  assert.deepEqual(((["quiet", "moderate", "active"] as const).map(proactiveCadenceMs)), [10_800_000, 5_400_000, 1_800_000]);
  assert.deepEqual(PROACTIVE_CADENCE_MS, { quiet: 10_800_000, moderate: 5_400_000, active: 1_800_000 });
  assert.equal(routineCadenceBlocked({ interventionLevel: "active", msSinceLastCue: null }), false);
  assert.equal(routineCadenceBlocked({ interventionLevel: "active", msSinceLastCue: 1_799_999 }), true);
  assert.equal(routineCadenceBlocked({ interventionLevel: "active", msSinceLastCue: 1_800_000 }), false);
  assert.equal(routineCadenceBlocked({ interventionLevel: "quiet", msSinceLastCue: 7_200_000 }), true);
});

test("约定触发只检查设备状态和有效期", () => {
  assert.deepEqual(evaluateTriggeredPush({ availability: "online", expired: false }), { allow: true, reasonCode: "allowed" });
  assert.equal(evaluateTriggeredPush({ availability: "dnd", expired: false }).reasonCode, "dnd");
  assert.equal(evaluateTriggeredPush({ availability: "offline", expired: false }).reasonCode, "offline");
  assert.equal(evaluateTriggeredPush({ availability: "online", expired: true }).reasonCode, "expired");
});

test("静默时段按本地钟面处理，坏配置按静默处理", () => {
  const utcAfternoon = new Date("2026-09-18T14:30:00Z");
  assert.equal(isWithinQuietHours({ startLocal: "22:00", endLocal: "07:00", timezone: "Asia/Shanghai" }, utcAfternoon), true);
  assert.equal(isWithinQuietHours({ startLocal: "22:00", endLocal: "07:00", timezone: "Asia/Shanghai" }, new Date("2026-09-18T01:30:00Z")), false);
  assert.equal(isWithinQuietHours({ startLocal: "25:00", endLocal: "07:00", timezone: "UTC" }, utcAfternoon), true);
  assert.equal(isWithinQuietHours({ startLocal: "22:00", endLocal: "07:00", timezone: "Not/AZone" }, utcAfternoon), true);
});
