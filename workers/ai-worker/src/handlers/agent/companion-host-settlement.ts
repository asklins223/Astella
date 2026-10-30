import type { AgentTurnRequest, AgentTurnResult } from "@astella/shared";
import { companionOperationDomainTool } from "@astella/shared";
import { joinVisibleSegmentsDeduped, VISIBLE_SEGMENT_SEPARATOR } from "../turn/companion-visible-segments.ts";
import { currentCompanionSuccessfulReceipts } from "../tools/companion-tool-receipts.ts";

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
  // Explicit publications select the delivery channel. A finish receipt closes
  // the task; it must not add a confirmation bubble after the requested messages.
  if (input.utterancePublished) {
    const delivered = input.visibleSegments.filter((_segment, index) => input.visibleSegmentDelivered[index]);
    return joinVisibleSegmentsDeduped(delivered, delivered.map(() => true)).text;
  }
  if (!text) return joinVisibleSegmentsDeduped(input.visibleSegments, input.visibleSegmentDelivered).text;
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
  messages: AgentTurnRequest["messages"];
  currentRunEvidence?: AgentTurnRequest["messages"];
  visibleSegments: readonly string[];
  visibleSegmentDelivered: readonly boolean[];
  richBlocks: readonly unknown[];
  stepEmitted: boolean;
  definitions: readonly { name: string; riskClass: string }[];
}): { text: string; receiptIds: string[] } | null {
  if (input.stepEmitted) return null;
  const writeNames = new Set(input.definitions
    .filter(definition => definition.riskClass !== "read"
      && !["companion_send_message", "companion_configure_turn", "companion_deepen", "companion_load_tools"].includes(definition.name))
    .map(definition => definition.name));
  const receipts = currentCompanionSuccessfulReceipts(input.messages, input.currentRunEvidence).filter(receipt => {
    const domain = companionOperationDomainTool(receipt.operation);
    return receipt.riskClass !== "read" && domain !== null && writeNames.has(domain);
  });
  if (receipts.length === 0) return null;
  // The execution envelope owns safeSummary at its top level. Some legacy
  // payloads also have data.summary; neither is guaranteed for every write.
  const summary = receipts.map(receipt => receipt.summary.trim()
    || (typeof receipt.data.summary === "string" ? receipt.data.summary.trim() : "")).filter(Boolean).join("；");
  const settlement = assembleCompanionHostSettlement({
    visibleSegments: input.visibleSegments, visibleSegmentDelivered: input.visibleSegmentDelivered,
    richBlockCount: input.richBlocks.length, said: "", includeSaid: false,
    note: [summary || "已有操作取得成功回执。", "后续回复生成中断，其他要求尚未核对。"].join("\n\n"), landedWrites: true,
  });
  return settlement.empty ? null : { text: settlement.text, receiptIds: receipts.map(receipt => receipt.id) };
}
