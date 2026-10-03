export const COMPANION_RECORDS_CHANGED = "ailearn:companion-records-changed";
export const COMPANION_ACCOUNT_CHANGED = "ailearn:companion-account-changed";
export function publishCompanionRecordsChanged() { window.dispatchEvent(new Event(COMPANION_RECORDS_CHANGED)); }
export function publishCompanionAccountChanged() { window.dispatchEvent(new Event(COMPANION_ACCOUNT_CHANGED)); }
