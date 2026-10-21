/**
 * 伴星提示的"已看过"记录——本机记忆，重启后仍然成立。
 *
 * 为什么需要它：通知中心此前只把"已展示过"记在组件内存里（`seen` 那枚 ref）。
 * 于是每次启动，收件箱里凡是还没被"收下"的条目都会重新自动展开一次。用户看到的
 * 表现是「一打开应用/一进笔记，右下角就冒出一张纸」，而那张纸的内容往往两天前就
 * 读过了——它不是新消息，只是没人记得它已经被看过。
 *
 * 口径：
 * - 只记**身份**，不记正文。键是通知自己的稳定 id（外加落库的修订号），
 *   正文仍以服务端投递为准。
 * - 按账号隔离（`userId`）。同一台机器换账号时，甲看过的提示不该替乙吞掉。
 * - 写不进去（配额满、隐私模式）不挡通知：读不出来只是回到"会再展开一次"的旧行为。
 * - 只保留最近若干条，避免无限增长。
 */
const SEEN_KEY = "astella:companion-notice-seen";
const MAX_SEEN = 200;

type SeenStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): SeenStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

type SeenLedger = Record<string, string[]>;

function readLedger(storage: SeenStorage | null): SeenLedger {
  if (!storage) return {};
  try {
    const raw = storage.getItem(SEEN_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: SeenLedger = {};
    for (const [owner, keys] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(keys)) out[owner] = keys.filter((key): key is string => typeof key === "string");
    }
    return out;
  } catch {
    return {};
  }
}

/** 读过就记为已看；同一身份重复记录不会增长。 */
export function rememberSeenNotice(owner: string | null | undefined, key: string, storage: SeenStorage | null = defaultStorage()): void {  if (!owner || !key || !storage) return;
  const ledger = readLedger(storage);
  const keys = ledger[owner] ?? [];
  if (keys.includes(key)) return;
  ledger[owner] = [...keys, key].slice(-MAX_SEEN);
  try { storage.setItem(SEEN_KEY, JSON.stringify(ledger)); } catch { /* 写不进去就只影响这一次 */ }
}

/** 这台设备上、这个账号已经看过的通知身份。 */
export function seenNotices(owner: string | null | undefined, storage: SeenStorage | null = defaultStorage()): Set<string> {
  if (!owner) return new Set();
  return new Set(readLedger(storage)[owner] ?? []);
}

/** 清掉某个账号的记录（退出登录、删除账号时）。 */
export function forgetSeenNotices(owner: string | null | undefined, storage: SeenStorage | null = defaultStorage()): void {
  if (!owner || !storage) return;
  const ledger = readLedger(storage);
  if (!(owner in ledger)) return;
  delete ledger[owner];
  try { storage.setItem(SEEN_KEY, JSON.stringify(ledger)); } catch { /* 同上 */ }
}
