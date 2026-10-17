import type { CompanionAccountStateV1 } from "@astella/shared/companion-shell-contracts";

export const COMPANION_RECORDS_CHANGED = "astella:companion-records-changed";
export const COMPANION_HISTORY_CHANGED = "astella:companion-history-changed";
export const COMPANION_CONVERSATION_INVALIDATED = "astella:companion-conversation-invalidated";
export const COMPANION_ACCOUNT_CHANGED = "astella:companion-account-changed";
export const COMPANION_GOAL_JOURNAL_OPEN = "astella:companion-goal-journal-open";
export function openCompanionGoalJournal(runId: string, scope: number) {
  window.dispatchEvent(new CustomEvent(COMPANION_GOAL_JOURNAL_OPEN, { detail: { runId, scope } }));
}
export function publishCompanionRecordsChanged() { window.dispatchEvent(new Event(COMPANION_RECORDS_CHANGED)); }
export function publishCompanionHistoryChanged() { window.dispatchEvent(new Event(COMPANION_HISTORY_CHANGED)); }
/**
 * 服务端把这一段会话整条删掉了（清空连续对话记录），本机握着的会话身份已经不存在。
 *
 * 为什么不复用 `publishCompanionRecordsChanged`：那条事件由收藏、日记、人格等各处发出，
 * 而接住它必须连本轮在跑的回复一起停掉（会话身份没了，那条 SSE 也没有落点）。一次收藏
 * 书签就把她正在说的话掐掉，是另一回事。
 */
export function publishCompanionConversationInvalidated() {
  window.dispatchEvent(new Event(COMPANION_CONVERSATION_INVALIDATED));
}
// 保存回执已经包含完整账号状态。传给其他入口，避免每个监听者再查账号甚至重核登录。
export function publishCompanionAccountChanged(account: CompanionAccountStateV1) {
  window.dispatchEvent(new CustomEvent(COMPANION_ACCOUNT_CHANGED, { detail: account }));
}
export function subscribeCompanionAccountChanged(listener: (account: CompanionAccountStateV1) => void) {
  const receive = (event: Event) => listener((event as CustomEvent<CompanionAccountStateV1>).detail);
  window.addEventListener(COMPANION_ACCOUNT_CHANGED, receive);
  return () => window.removeEventListener(COMPANION_ACCOUNT_CHANGED, receive);
}
