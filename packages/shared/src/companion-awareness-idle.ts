/** Minimum foreground inactivity before the host may report a quiet-presence opportunity. */
export const COMPANION_QUIET_PRESENCE_AFTER_MS = 3 * 60_000;

/**
 * Tracks one quiet episode without using wall-clock time. Background time never
 * earns an opportunity, and any real input starts a fresh episode.
 */
export function createCompanionQuietPresenceTracker(initialActivityAt: number) {
  let lastActivityAt = initialActivityAt;
  let reported = false;

  return {
    markActivity(at: number): void {
      if (!Number.isFinite(at)) return;
      lastActivityAt = at;
      reported = false;
    },
    quietForMs(now: number, foreground: boolean): number | null {
      if (!foreground || reported || !Number.isFinite(now)) return null;
      const elapsed = Math.max(0, now - lastActivityAt);
      return elapsed >= COMPANION_QUIET_PRESENCE_AFTER_MS ? elapsed : null;
    },
    markReported(): void {
      reported = true;
    },
  };
}
