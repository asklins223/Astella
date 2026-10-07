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
  if (!clock && !history.some(message => message.createdAt)) return null;
  const observedAt = conversationInstant(clock?.observedAt);
  let timezone: string | null = null;
  if (clock?.timezone) {
    try { timezone = new Intl.DateTimeFormat("en", { timeZone: clock.timezone }).resolvedOptions().timeZone; } catch { /* unknown */ }
  }
  const stamp = (createdAt: unknown) => {
    const utteredAt = conversationInstant(createdAt);
    const elapsedMs = observedAt && utteredAt ? Date.parse(observedAt) - Date.parse(utteredAt) : null;
    return { utteredAt, elapsedMs: elapsedMs !== null && elapsedMs >= 0 ? elapsedMs : null };
  };
  return [
    "<conversation_timeline>",
    "服务器消息记录：时间指消息发送时间，不代表消息中叙述的外部事件时间。位置只对应下方原样回放的近期消息；窗口不是全部经历，两条消息相隔多久也不证明期间一直在线或一直在做某事。",
    JSON.stringify({ observedAt, timezone,
      history: history.map((message, index) => ({ position: index + 1, speaker: message.role, ...stamp(message.createdAt) })),
      current: { speaker: "user", ...stamp(clock?.currentMessageCreatedAt) },
    }),
    "</conversation_timeline>",
  ].join("\n");
}
