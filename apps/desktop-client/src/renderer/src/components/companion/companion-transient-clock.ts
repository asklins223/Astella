/** Floating UI expires independently of durable conversation records. */
export interface CompanionTransientEntry {
  remainingMs: number;
  activityUntil: number;
}

export const COMPANION_ACTIVE_GRACE_MS = 2_500;

export function advanceCompanionTransient(
  entry: CompanionTransientEntry,
  elapsedMs: number,
  now: number,
  paused: boolean,
): boolean {
  if (!paused && now >= entry.activityUntil) entry.remainingMs -= Math.max(0, elapsedMs);
  return entry.remainingMs <= 0;
}

export function noteCompanionTransientActivity(entry: CompanionTransientEntry, now: number): void {
  entry.activityUntil = now + COMPANION_ACTIVE_GRACE_MS;
}
