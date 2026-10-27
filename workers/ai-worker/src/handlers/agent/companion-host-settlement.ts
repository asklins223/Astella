import type { AgentTurnResult } from "@astella/shared";
import { companionOperationDomainTool } from "@astella/shared";
import { joinVisibleSegmentsDeduped, VISIBLE_SEGMENT_SEPARATOR } from "../turn/companion-visible-segments.ts";

/**
 * Final assembly for an honest host settlement: keep everything the user
 * already received (or that really landed), then append one host note.
 *
 * An honest note is itself a deliverable. Only a settlement with no text, no
 * rich block, no landed write and no note is truly empty; that one still
 * counts as no progress.
 */
export function assembleCompanionHostSettlement(input: {
  visibleSegments: readonly string[];
  visibleSegmentDelivered: readonly boolean[];
  richBlockCount: number;
  said: string;
  includeSaid: boolean;
  note: string;
  landedWrites: boolean;
  reasoning?: AgentTurnResult["reasoning"];
}): { text: string; empty: boolean; reasoning?: AgentTurnResult["reasoning"] } {
  const segments = [...input.visibleSegments];
  const delivered = [...input.visibleSegmentDelivered];
  if (input.includeSaid && input.said.trim()) {
    segments.push(input.said);
    delivered.push(true);
  }
  const base = joinVisibleSegmentsDeduped(segments, delivered).text.trim();
  const hasNote = input.note.trim().length > 0;
  if (!base && input.richBlockCount === 0 && !input.landedWrites && !hasNote) {
    return { text: "", empty: true };
  }
  const text = [base, input.note].filter(Boolean).join(VISIBLE_SEGMENT_SEPARATOR);
  return { text, empty: false, ...(input.reasoning && input.reasoning.length > 0 ? { reasoning: input.reasoning } : {}) };
}

/** A finish text that repeats an already-published utterance is not a second
 * answer; drop it so the bubble does not show the same sentence twice. */
export function assembleCompanionFinishText(input: {
  visibleSegments: readonly string[];
  visibleSegmentDelivered: readonly boolean[];
  utterancePublished: boolean;
  finishText: string;
}): string {
  const text = input.finishText.trim();
  const repeat = input.utterancePublished && input.visibleSegments.some(segment => segment.trim() === text);
  if (repeat || !text) return joinVisibleSegmentsDeduped(input.visibleSegments, input.visibleSegmentDelivered).text;
  return joinVisibleSegmentsDeduped([...input.visibleSegments, text], [...input.visibleSegmentDelivered, false]).text;
}

/**
 * A model step failed after a real write had already landed.
 *
 * The business result is true; the transport failure is not. Deliver what was
 * saved instead of replacing it with an error card. Returns null when there is
 * nothing to preserve, so the caller keeps its normal failure path.
 */
export function settleCompanionLandedWritesOnFailure(input: {
  messages: readonly { role: string; content: unknown }[];
  visibleSegments: readonly string[];
  visibleSegmentDelivered: readonly boolean[];
  richBlocks: readonly unknown[];
  stepEmitted: boolean;
  definitions: readonly { name: string; riskClass: string }[];
}): { text: string; receiptIds: string[] } | null {
  if (input.stepEmitted) return null;
  const writeNames = new Set(input.definitions
    .filter(definition => definition.riskClass !== "read"
      && !["companion_say", "companion_configure_turn", "companion_deepen", "companion_load_tools"].includes(definition.name))
    .map(definition => definition.name));
  const receipts: { id: string; summary: string }[] = [];
  for (const message of input.messages) {
    if (message.role !== "tool" || typeof message.content !== "string") continue;
    try {
      const receipt = JSON.parse(message.content) as { ok?: unknown; receiptId?: unknown; operation?: unknown; data?: { status?: unknown } };
      if (receipt.ok !== true || typeof receipt.receiptId !== "string") continue;
      const operation = typeof receipt.operation === "string" ? receipt.operation : "";
      const domain = companionOperationDomainTool(operation);
      if (!domain || !writeNames.has(domain)) continue;
      const status = receipt.data?.status;
      if (["failed", "not_executed", "outcome_unknown", "waiting_confirmation", "unavailable"].includes(String(status ?? ""))) continue;
      receipts.push({ id: receipt.receiptId, summary: typeof receipt.data === "object" && receipt.data
        ? String((receipt.data as { summary?: unknown }).summary ?? "") : "" });
    } catch { /* a non-JSON receipt is not evidence of a write */ }
  }
  if (receipts.length === 0) return null;
  const summary = receipts.map(receipt => receipt.summary).filter(Boolean).join("；");
  const settlement = assembleCompanionHostSettlement({
    visibleSegments: input.visibleSegments, visibleSegmentDelivered: input.visibleSegmentDelivered,
    richBlockCount: input.richBlocks.length, said: "", includeSaid: false,
    note: summary, landedWrites: true,
  });
  return settlement.empty ? null : { text: settlement.text, receiptIds: receipts.map(receipt => receipt.id) };
}
