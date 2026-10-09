import type { CompanionAccountStateV1 } from "@astella/shared/companion-shell-contracts";

export const COMPANION_RECORDS_CHANGED = "astella:companion-records-changed";
export const COMPANION_HISTORY_CHANGED = "astella:companion-history-changed";
export const COMPANION_ACCOUNT_CHANGED = "astella:companion-account-changed";
export const COMPANION_GOAL_JOURNAL_OPEN = "astella:companion-goal-journal-open";
export function openCompanionGoalJournal(runId: string, scope: number) {
  window.dispatchEvent(new CustomEvent(COMPANION_GOAL_JOURNAL_OPEN, { detail: { runId, scope } }));
}
export function publishCompanionRecordsChanged() { window.dispatchEvent(new Event(COMPANION_RECORDS_CHANGED)); }
export function publishCompanionHistoryChanged() { window.dispatchEvent(new Event(COMPANION_HISTORY_CHANGED)); }
// 保存回执已经包含完整账号状态。传给其他入口，避免每个监听者再查账号甚至重核登录。
export function publishCompanionAccountChanged(account: CompanionAccountStateV1) {
  window.dispatchEvent(new CustomEvent(COMPANION_ACCOUNT_CHANGED, { detail: account }));
}
export function subscribeCompanionAccountChanged(listener: (account: CompanionAccountStateV1) => void) {
  const receive = (event: Event) => listener((event as CustomEvent<CompanionAccountStateV1>).detail);
  window.addEventListener(COMPANION_ACCOUNT_CHANGED, receive);
  return () => window.removeEventListener(COMPANION_ACCOUNT_CHANGED, receive);
}
