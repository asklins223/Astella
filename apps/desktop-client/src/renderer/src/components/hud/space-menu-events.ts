/**
 * The open menu owns `workspace.list`, but it does not own the events that
 * change that list — the gate's workspace subscription does. When one arrives
 * while the menu is open, the gate asks the menu to re-read its data before it
 * re-verifies the session, so a non-invalidating update still lands as fresh
 * rows instead of a stale list.
 */
export const SPACE_MENU_REFRESH_EVENT = "astella:space-menu-refresh";

export function requestSpaceMenuRefresh(): void {
  window.dispatchEvent(new CustomEvent(SPACE_MENU_REFRESH_EVENT));
}
