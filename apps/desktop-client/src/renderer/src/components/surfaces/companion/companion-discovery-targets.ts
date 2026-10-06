import type { CompanionDailySummaryV1, CompanionHistoryItemV1 } from "@astella/shared/companion-memory-desktop-contracts";
import type { CompanionDiscoveryEntryV1 } from "@astella/shared/desktop-ipc-contracts";
import { messageText } from "./companion-center-model";
import { clipDiscoveryBody, discoveryKindFor, type DiscoveryKeepRequest } from "./companion-discovery-offer";

export function dialogueDiscoveryRequest(item: CompanionHistoryItemV1): DiscoveryKeepRequest | null {
  if (item.role === "system" || item.kind === "cancelled") return null;
  const body = clipDiscoveryBody(messageText(item));
  return body ? { kind: discoveryKindFor(item.role), source: "assistant_reply", sourceId: item.messageId, author: item.role, body } : null;
}

export function diaryDiscoveryParagraphs(daily: CompanionDailySummaryV1) {
  if (daily.status !== "generated" || !daily.date) return [];
  const date = daily.date;
  return daily.blocks.flatMap((block, blockIndex) => block.type !== "text" ? [] : block.text.split(/\n\s*\n/).map(text => text.trim()).filter(Boolean).map((text, paragraphIndex) => ({
    text, blockIndex, paragraphIndex,
    sourceId: `${date}:v${daily.revision}:b${blockIndex}:p${paragraphIndex}`,
    request: { kind: "diary_excerpt", source: "diary", sourceId: `${date}:v${daily.revision}:b${blockIndex}:p${paragraphIndex}`, author: "assistant", body: clipDiscoveryBody(text) } satisfies DiscoveryKeepRequest,
  })));
}

export type DiscoverySourceTarget =
  | { kind: "dialogue"; messageId: string }
  | { kind: "diary"; date: string; revision?: number; sourceId: string }
  | { kind: "memory"; memoryId: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function discoverySourceTarget(entry: Pick<CompanionDiscoveryEntryV1, "source" | "sourceId">): DiscoverySourceTarget | null {
  if (entry.source === "assistant_reply" && UUID.test(entry.sourceId)) return { kind: "dialogue", messageId: entry.sourceId };
  if (entry.source === "memory" && UUID.test(entry.sourceId)) return { kind: "memory", memoryId: entry.sourceId };
  if (entry.source === "diary") {
    const match = /^(\d{4}-\d{2}-\d{2})(?::v([1-9]\d*):b\d+:p\d+)?$/.exec(entry.sourceId);
    const date = match ? new Date(`${match[1]}T00:00:00Z`) : null;
    if (match && date && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === match[1]) return { kind: "diary", date: match[1], ...(match[2] ? { revision: Number(match[2]) } : {}), sourceId: entry.sourceId };
  }
  return null;
}
