export const COMPANION_RECORDS_CHANGED = "astella:companion-records-changed";
export const COMPANION_HISTORY_CHANGED = "astella:companion-history-changed";
export const COMPANION_ACCOUNT_CHANGED = "astella:companion-account-changed";
export const COMPANION_GOAL_JOURNAL_OPEN = "astella:companion-goal-journal-open";
export function openCompanionGoalJournal(runId: string, scope: number) {
  window.dispatchEvent(new CustomEvent(COMPANION_GOAL_JOURNAL_OPEN, { detail: { runId, scope } }));
}
export function publishCompanionRecordsChanged() { window.dispatchEvent(new Event(COMPANION_RECORDS_CHANGED)); }
export function publishCompanionHistoryChanged() { window.dispatchEvent(new Event(COMPANION_HISTORY_CHANGED)); }
export function publishCompanionAccountChanged() { window.dispatchEvent(new Event(COMPANION_ACCOUNT_CHANGED)); }
