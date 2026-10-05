export const COMPANION_RECORDS_CHANGED = "ailearn:companion-records-changed";
export const COMPANION_ACCOUNT_CHANGED = "ailearn:companion-account-changed";
export const COMPANION_GOAL_JOURNAL_OPEN = "ailearn:companion-goal-journal-open";
export function openCompanionGoalJournal(runId: string, scope: number) {
  window.dispatchEvent(new CustomEvent(COMPANION_GOAL_JOURNAL_OPEN, { detail: { runId, scope } }));
}
export function publishCompanionRecordsChanged() { window.dispatchEvent(new Event(COMPANION_RECORDS_CHANGED)); }
export function publishCompanionAccountChanged() { window.dispatchEvent(new Event(COMPANION_ACCOUNT_CHANGED)); }
