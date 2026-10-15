import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMPANION_QUIET_PRESENCE_MIN_MS,
  evaluateTriggeredPush,
  isWithinQuietHours,
  PROACTIVE_CADENCE_MS,
  proactiveCadenceMs,
  routineCadenceBlocked,
} from "../companion-proactive-policy.ts";

test("例行主动间隔按账号参与档位判定", () => {
  // 2026-10-14：3 小时 / 90 分 / 30 分收到 90 分 / 30 分 / 10 分。
  // 同一轮把"安静结束的那次考虑"从计里去掉（判据在 companion-initiative.ts，
  // 那里只数真的产出了 assistant 消息的运行）——数字变小与口径变化是同一次用户决定。
  assert.deepEqual(((["quiet", "moderate", "active"] as const).map(proactiveCadenceMs)), [5_400_000, 1_800_000, 600_000]);
  assert.deepEqual(PROACTIVE_CADENCE_MS, { quiet: 5_400_000, moderate: 1_800_000, active: 600_000 });
  assert.equal(routineCadenceBlocked({ interventionLevel: "active", msSinceLastCue: null }), false);
  assert.equal(routineCadenceBlocked({ interventionLevel: "active", msSinceLastCue: 599_999 }), true);
  assert.equal(routineCadenceBlocked({ interventionLevel: "active", msSinceLastCue: 600_000 }), false);
  assert.equal(routineCadenceBlocked({ interventionLevel: "quiet", msSinceLastCue: 3_600_000 }), true);
  // 活跃档比安静档更容易开口：三档必须严格递减，否则"活跃"这个词在界面上是假的。
  assert.ok(proactiveCadenceMs("quiet") > proactiveCadenceMs("moderate"));
  assert.ok(proactiveCadenceMs("moderate") > proactiveCadenceMs("active"));
});

test("陪着的时候的安静门槛按档位严格递减，且活跃档等于客户端能观察到的最早时刻", () => {
  assert.deepEqual(COMPANION_QUIET_PRESENCE_MIN_MS, { quiet: 600_000, moderate: 180_000, active: 90_000 });
  assert.ok(COMPANION_QUIET_PRESENCE_MIN_MS.quiet > COMPANION_QUIET_PRESENCE_MIN_MS.moderate);
  assert.ok(COMPANION_QUIET_PRESENCE_MIN_MS.moderate > COMPANION_QUIET_PRESENCE_MIN_MS.active);
  // 客户端的 90 秒上报门槛（COMPANION_QUIET_PRESENCE_AFTER_MS）必须不低于档位里最小的那个：
  // 反过来的话，活跃档永远等不到自己的门槛，那档就是空的。
  assert.equal(COMPANION_QUIET_PRESENCE_MIN_MS.active, 90_000);
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
