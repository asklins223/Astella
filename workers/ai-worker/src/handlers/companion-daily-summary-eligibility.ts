import { sql } from "drizzle-orm";
import type { WorkerTransaction } from "../db.ts";

export interface DayScope {
  workspaceId: string;
  userId: string;
  date: string;
  timezone: string;
  diaryEnabledSince: Date;
}

/** A scheduler activity signal is not enough: only a grounded, positive-weight moment merits a model call. */
export function hasDiaryWorthyMaterial(input: {
  quietDay: boolean;
  candidateCount: number;
}): boolean {
  return !input.quietDay && input.candidateCount > 0;
}

/**
 * Local-day boundaries with an explicit diary-enabled material floor.
 * Cast DATE to timestamp before AT TIME ZONE: DATE AT TIME ZONE first passes
 * through the session timezone and shifts the local day window.
 */
export function dayStart(scope: DayScope) {
  return sql`GREATEST(
    ${scope.date}::date::timestamp AT TIME ZONE ${scope.timezone},
    ${scope.diaryEnabledSince.toISOString()}::timestamptz
  )`;
}

export function dayEnd(scope: DayScope) {
  return sql`(${scope.date}::date + 1)::timestamp AT TIME ZONE ${scope.timezone}`;
}

/** Local wall-clock time for a timestamp column. */
export function clockOf(scope: DayScope, column: string) {
  return sql`to_char(${sql.raw(column)} AT TIME ZONE ${scope.timezone}, 'HH24:MI')`;
}

async function readEnabledPeriod(tx: WorkerTransaction, userId: string): Promise<Date | null> {
  const rows = await tx.execute<{
    global_enabled: boolean;
    diary_enabled: boolean;
    diary_enabled_since: Date | string | null;
  }>(sql`
    SELECT global_enabled, diary_enabled, diary_enabled_since
    FROM user_companion_account_state
    WHERE user_id = ${userId}
  `);
  const account = (Array.isArray(rows) ? rows : [])[0];
  if (!account?.global_enabled || !account.diary_enabled || !account.diary_enabled_since) return null;
  const diaryEnabledSince = new Date(account.diary_enabled_since);
  return Number.isFinite(diaryEnabledSince.valueOf()) ? diaryEnabledSince : null;
}

export function currentDiaryMaterialStart(tx: WorkerTransaction, userId: string): Promise<Date | null> {
  return readEnabledPeriod(tx, userId);
}

export async function diaryMaterialStartIsCurrent(
  tx: WorkerTransaction,
  userId: string,
  expected: Date,
): Promise<boolean> {
  const current = await readEnabledPeriod(tx, userId);
  return current !== null && current.valueOf() === expected.valueOf();
}
