import assert from "node:assert/strict";
import test from "node:test";
import { companionAwarenessContextV1Schema } from "../contracts/companion-initiative-contracts.ts";
import {
  COMPANION_QUIET_PRESENCE_AFTER_MS,
  createCompanionQuietPresenceTracker,
} from "../companion-awareness-idle.ts";

// 「闲下来」= 停止输入 + 页面稳定（判据与为什么改见 companion-awareness-idle.ts 的注释：
// 旧口径要求前台连续 3 分钟零鼠标，两天只开过一次这道门）。
test("quiet presence is due after the declared foreground pause and rearms on activity", () => {
  const tracker = createCompanionQuietPresenceTracker(1_000);
  assert.equal(tracker.quietForMs(1_000 + COMPANION_QUIET_PRESENCE_AFTER_MS - 1, true), null);
  assert.equal(tracker.quietForMs(1_000 + COMPANION_QUIET_PRESENCE_AFTER_MS, true), COMPANION_QUIET_PRESENCE_AFTER_MS);
  tracker.markReported(COMPANION_QUIET_PRESENCE_AFTER_MS);
  // 同一集里两格之间要隔满一格：15 秒一次的 tick 不能把同一段安静反复上报。
  assert.equal(tracker.quietForMs(1_000 + COMPANION_QUIET_PRESENCE_AFTER_MS + 15_000, true), null);
  tracker.markActivity(1_000 + COMPANION_QUIET_PRESENCE_AFTER_MS + 15_000);
  assert.equal(tracker.quietForMs(1_000 + 2 * COMPANION_QUIET_PRESENCE_AFTER_MS, true), null);
  assert.equal(tracker.quietForMs(1_000 + 2 * COMPANION_QUIET_PRESENCE_AFTER_MS + 15_000, true), COMPANION_QUIET_PRESENCE_AFTER_MS);
});

/**
 * 一段持续的安静按 90 秒一格继续上报——这条是 2026-10-14 补的。
 *
 * 原来报过一次就把整集关掉：客户端在第 90 秒标成"报过了"，而服务端的档位门槛
 * （适中档 3 分钟）比它高，于是"安静了 5 分钟"永远等不到自己的门槛，
 * 那条机会被静默丢掉，用户看到的是她连一次都不开口。
 */
test("a continuing quiet spell keeps reporting one window at a time so the level threshold can be reached", () => {
  const tracker = createCompanionQuietPresenceTracker(0);
  const after = (ms: number) => COMPANION_QUIET_PRESENCE_AFTER_MS + ms;
  assert.equal(tracker.quietForMs(after(0), true), COMPANION_QUIET_PRESENCE_AFTER_MS);
  tracker.markReported(COMPANION_QUIET_PRESENCE_AFTER_MS);
  // 第 90 秒那一格报过了，但安静还在继续：再过一格就是新的、值得上报的时刻。
  assert.equal(tracker.quietForMs(after(30_000), true), null);
  assert.equal(tracker.quietForMs(after(COMPANION_QUIET_PRESENCE_AFTER_MS), true), 2 * COMPANION_QUIET_PRESENCE_AFTER_MS);
  tracker.markReported(2 * COMPANION_QUIET_PRESENCE_AFTER_MS);
  // 第三格：适中档的 3 分钟门槛正好落在这一格上。
  assert.equal(tracker.quietForMs(after(2 * COMPANION_QUIET_PRESENCE_AFTER_MS), true), 3 * COMPANION_QUIET_PRESENCE_AFTER_MS);
  // 用户真的动了：整集从头开始，上一次的格数不再压着新的安静。
  tracker.markActivity(after(2 * COMPANION_QUIET_PRESENCE_AFTER_MS));
  assert.equal(tracker.quietForMs(after(2 * COMPANION_QUIET_PRESENCE_AFTER_MS) + COMPANION_QUIET_PRESENCE_AFTER_MS, true), COMPANION_QUIET_PRESENCE_AFTER_MS);
});

test("background time never creates a quiet-presence opportunity", () => {
  const tracker = createCompanionQuietPresenceTracker(0);
  assert.equal(tracker.quietForMs(COMPANION_QUIET_PRESENCE_AFTER_MS * 4, false), null);
  tracker.markActivity(COMPANION_QUIET_PRESENCE_AFTER_MS * 4);
  assert.equal(tracker.quietForMs(COMPANION_QUIET_PRESENCE_AFTER_MS * 5 - 1, true), null);
  assert.equal(tracker.quietForMs(COMPANION_QUIET_PRESENCE_AFTER_MS * 5, true), COMPANION_QUIET_PRESENCE_AFTER_MS);
});

test("fractional monotonic timestamps produce wire-valid whole milliseconds without crossing early", () => {
  const tracker = createCompanionQuietPresenceTracker(42.35);
  assert.equal(tracker.quietForMs(90_042.34, true), null);
  const quietForMs = tracker.quietForMs(90_042.45, true);
  assert.equal(quietForMs, 90_000);
  assert.equal(companionAwarenessContextV1Schema.safeParse({
    foreground: true, unlocked: true, typing: false, learning: false, conversationId: null,
    quietForMs, page: { key: "home", label: "书房", revision: null, context: null },
  }).success, true);
  tracker.markReported(quietForMs!);
  assert.equal(tracker.quietForMs(180_042.34, true), null);
  assert.equal(tracker.quietForMs(180_042.55, true), 180_000);
});
