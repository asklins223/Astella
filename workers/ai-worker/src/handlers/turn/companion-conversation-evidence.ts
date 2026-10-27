import type { CompanionRecentHistoryMessage } from "../context/companion-context-handoff.ts";

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

/** One formatter for replay and retrieved history. The frozen account clock
 * supplies timezone and observation time; the model need not do date arithmetic. */
export function companionConversationTimeEvidence(clock?: Pick<CompanionConversationClock, "observedAt" | "timezone">) {
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
    const tail = seconds % 60 ? ` ${seconds % 60} 秒` : "";
    if (hours < 24) return `${hours} 小时 ${minutes % 60} 分钟${tail}`;
    return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时 ${minutes % 60} 分钟${tail}`;
  };
  const stamp = (createdAt: unknown, previousCreatedAt?: unknown) => {
    const utteredAt = conversationInstant(createdAt);
    const elapsedMs = gap(utteredAt, observedAt);
    const gapFromPreviousMs = gap(previousCreatedAt, utteredAt);
    const localDateTime = utteredAt && timezone ? new Intl.DateTimeFormat("sv-SE", { timeZone: timezone,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(utteredAt)) : null;
    return { utteredAt, localDateTime, elapsedMs, elapsed: duration(elapsedMs), gapFromPreviousMs, gapFromPrevious: duration(gapFromPreviousMs) };
  };
  return { observedAt, timezone, stamp };
}

/** Native messages retain their full text. Metadata refers to their visible positions. */
export function renderCompanionConversationEvidence(
  history: readonly CompanionRecentHistoryMessage[], clock?: CompanionConversationClock,
  currentSource: "user" | "host_observation" = "user",
): string | null {
  if (!clock && !history.some(message => message.createdAt || message.replyStatus)) return null;
  const { observedAt, timezone, stamp } = companionConversationTimeEvidence(clock);
  const replyStates: Record<string, string> = { succeeded: "已回复", failed: "回复已结束（失败）", cancelled: "用户已取消回复",
    superseded: "回复被后续消息接替", accepted: "等待回复", running: "回复中", waiting_for_confirmation: "等待用户确认" };
  // Full per-message time evidence only for the recent window. Older positions
  // stay visible as a range: the model needs their order, not a second copy of
  // their timestamps. A 69-message history used to spend ~18k characters here.
  const detailedFrom = Math.max(0, history.length - 8);
  const earlier = history.slice(0, detailedFrom);
  return [
    "<conversation_timeline>",
    "服务器消息记录：时间指消息发送时间，不代表消息中叙述的外部事件时间。位置只对应下方原样回放的近期消息；窗口不是全部经历，两条消息相隔多久也不证明期间一直在线或一直在做某事。",
    JSON.stringify({ observedAt, timezone,
      earlier: earlier.length > 0 ? {
        positions: [1, earlier.length],
        count: earlier.length,
        note: "更早的回放消息只保留位置范围；需要具体原话或时间时用 companion_observe（action=history） 按 seq 取回。",
      } : null,
      history: history.slice(detailedFrom).map((message, index) => ({ position: detailedFrom + index + 1, speaker: message.role,
        replyState: message.role === "user" ? replyStates[message.replyStatus ?? ""] ?? null : null,
        replyTerminal: message.role === "user" && message.replyStatus
          ? ["succeeded", "failed", "cancelled", "superseded"].includes(message.replyStatus) : null,
        ...stamp(message.createdAt, history[detailedFrom + index - 1]?.createdAt) })),
      current: { speaker: currentSource === "host_observation" ? "host" : "user",
        source: currentSource, ...stamp(currentSource === "user" ? clock?.currentMessageCreatedAt : null, history.at(-1)?.createdAt) },
    }),
    "</conversation_timeline>",
  ].join("\n");
}
