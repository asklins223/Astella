import type { CompanionRecentHistoryMessage } from "./companion-context-handoff.ts";

/** Frozen at the production read transaction, not at generation/retry time. */
export interface CompanionConversationClock {
  observedAt: string;
  timezone: string;
  currentMessageCreatedAt: string | null;
}

/** Only instants with an explicit offset are evidence; a bare local time is ambiguous. */
export function conversationInstant(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number) as [number, number, number];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (!days || day < 1 || day > days || Number(value.slice(11, 13)) > 23) return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? new Date(instant).toISOString() : null;
}

/** Native messages retain their full text. Metadata refers to their visible positions. */
export function renderCompanionConversationEvidence(
  history: readonly CompanionRecentHistoryMessage[], clock?: CompanionConversationClock,
): string | null {
  if (!clock && !history.some(message => message.createdAt || message.replyStatus)) return null;
  const observedAt = conversationInstant(clock?.observedAt);
  let timezone: string | null = null;
  if (clock?.timezone) {
    try { timezone = new Intl.DateTimeFormat("en", { timeZone: clock.timezone }).resolvedOptions().timeZone; } catch { /* unknown */ }
  }
  const gap = (from: unknown, to: unknown) => {
    const earlier = conversationInstant(from), later = conversationInstant(to);
    const ms = earlier && later ? Date.parse(later) - Date.parse(earlier) : null;
    return ms !== null && ms >= 0 ? ms : null;
  };
  const duration = (ms: number | null) => {
    if (ms === null) return null;
    const seconds = Math.floor(ms / 1000), minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
    if (seconds < 1) return "不足 1 秒";
    if (minutes < 1) return `${seconds} 秒`;
    if (hours < 1) return `${minutes} 分钟 ${seconds % 60} 秒`;
    if (hours < 24) return `${hours} 小时 ${minutes % 60} 分钟`;
    return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时 ${minutes % 60} 分钟`;
  };
  const replyStates: Record<string, string> = { succeeded: "已回复", failed: "回复未完成", cancelled: "用户已取消回复",
    superseded: "回复被后续消息接替", accepted: "等待回复", running: "回复中", waiting_for_confirmation: "等待用户确认" };
  const stamp = (createdAt: unknown, previousCreatedAt?: unknown) => {
    const utteredAt = conversationInstant(createdAt);
    const elapsedMs = gap(utteredAt, observedAt);
    const gapFromPreviousMs = gap(previousCreatedAt, utteredAt);
    const localDateTime = utteredAt && timezone ? new Intl.DateTimeFormat("sv-SE", { timeZone: timezone,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(utteredAt)) : null;
    return { utteredAt, localDateTime, elapsedMs, elapsed: duration(elapsedMs), gapFromPreviousMs, gapFromPrevious: duration(gapFromPreviousMs) };
  };
  return [
    "<conversation_timeline>",
    "服务器消息记录：时间指消息发送时间，不代表消息中叙述的外部事件时间。位置只对应下方原样回放的近期消息；窗口不是全部经历，两条消息相隔多久也不证明期间一直在线或一直在做某事。",
    JSON.stringify({ observedAt, timezone,
      history: history.map((message, index) => ({ position: index + 1, speaker: message.role,
        replyState: message.role === "user" ? replyStates[message.replyStatus ?? ""] ?? null : null,
        ...stamp(message.createdAt, history[index - 1]?.createdAt) })),
      current: { speaker: "user", ...stamp(clock?.currentMessageCreatedAt, history.at(-1)?.createdAt) },
    }),
    "</conversation_timeline>",
  ].join("\n");
}
