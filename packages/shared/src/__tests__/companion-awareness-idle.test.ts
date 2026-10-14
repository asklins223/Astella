import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPANION_QUIET_PRESENCE_AFTER_MS,
  createCompanionQuietPresenceTracker,
} from "../companion-awareness-idle.ts";

test("quiet presence is due once after three foreground minutes and rearms on activity", () => {
  const tracker = createCompanionQuietPresenceTracker(1_000);
  assert.equal(tracker.quietForMs(1_000 + COMPANION_QUIET_PRESENCE_AFTER_MS - 1, true), null);
  assert.equal(tracker.quietForMs(1_000 + COMPANION_QUIET_PRESENCE_AFTER_MS, true), COMPANION_QUIET_PRESENCE_AFTER_MS);
  tracker.markReported();
  assert.equal(tracker.quietForMs(1_000 + COMPANION_QUIET_PRESENCE_AFTER_MS + 15_000, true), null);
  tracker.markActivity(1_000 + COMPANION_QUIET_PRESENCE_AFTER_MS + 15_000);
  assert.equal(tracker.quietForMs(1_000 + 2 * COMPANION_QUIET_PRESENCE_AFTER_MS, true), null);
  assert.equal(tracker.quietForMs(1_000 + 2 * COMPANION_QUIET_PRESENCE_AFTER_MS + 15_000, true), COMPANION_QUIET_PRESENCE_AFTER_MS);
});

test("background time never creates a quiet-presence opportunity", () => {
  const tracker = createCompanionQuietPresenceTracker(0);
  assert.equal(tracker.quietForMs(COMPANION_QUIET_PRESENCE_AFTER_MS * 4, false), null);
  tracker.markActivity(COMPANION_QUIET_PRESENCE_AFTER_MS * 4);
  assert.equal(tracker.quietForMs(COMPANION_QUIET_PRESENCE_AFTER_MS * 5 - 1, true), null);
  assert.equal(tracker.quietForMs(COMPANION_QUIET_PRESENCE_AFTER_MS * 5, true), COMPANION_QUIET_PRESENCE_AFTER_MS);
});
