import { create } from "zustand";
import { useRoomStore } from "../../../app/home/room-store";
import type { AgentArtifactRefV1, AgentRunHistoryV1 } from "@astella/shared/agent-contracts";

export type CompanionNotePreviewTarget = {
  noteId: string; noteVersionId?: string; title: string; runId?: string;
  artifact?: AgentArtifactRefV1;
  goalRunId?: string;
  blockOrdinal?: number;
  /** A versioned source opened from a card report; closing returns to that report. */
  sourceOnly?: boolean;
};
type FocusAnchor = { messageId: string; buttonIndex: number; label: string };
type PreviewOrigin = { origin: HTMLElement | null; journalOrigin: boolean; focusAnchor?: FocusAnchor };
type PreviewTarget = CompanionNotePreviewTarget & PreviewOrigin & { scope: number; identity: string };
export type CompanionSourcePreviewTarget = { sourceId: string; title: string; segmentOrdinal?: number; runId?: string };
type SourceTarget = CompanionSourcePreviewTarget & PreviewOrigin & { scope: number; identity: string };
function previewOrigin(origin?: HTMLElement | null): PreviewOrigin {
  const message = origin?.closest<HTMLElement>("[data-message-id]");
  const messageId = message?.dataset.messageId;
  const buttonIndex = message && origin ? [...message.querySelectorAll<HTMLElement>("button")].indexOf(origin) : -1;
  return { origin: origin ?? null, journalOrigin: Boolean(origin?.closest(".companion-history")),
    ...(messageId && buttonIndex >= 0 ? { focusAnchor: { messageId, buttonIndex, label: origin?.textContent?.trim() ?? "" } } : {}) };
}
/** The journal remounts when returning from a note. Reconnect to the same
 * message control rather than trying to focus its detached previous element. */
export function restoreCompanionPreviewFocus(target: PreviewOrigin | null) {
  if (target?.origin?.isConnected) { target.origin.focus({ preventScroll: true }); return; }
  if (!target?.journalOrigin) return;
  const anchor = target.focusAnchor;
  const message = anchor && [...document.querySelectorAll<HTMLElement>(".companion-history [data-message-id]")].find(element => element.dataset.messageId === anchor.messageId);
  const button = message && anchor ? message.querySelectorAll("button")[anchor.buttonIndex] : undefined;
  if (button && button.textContent?.trim() === anchor?.label) button.focus({ preventScroll: true });
  else document.querySelector<HTMLElement>(".companion-history__list")?.focus({ preventScroll: true });
}
export const useCompanionResultPreview = create<{
  target: PreviewTarget | null;
  parentPreview: PreviewTarget | null;
  returnTo: PreviewTarget | null;
  journalTarget: { runId: string; visit: number } | null;
  positions: Map<string, number>;
  galleries: Map<string, { selected: number; expanded: Set<number> }>;
  disclosures: Map<string, boolean>;
  goalHistory: Map<string, AgentRunHistoryV1>;
  sourceTarget: SourceTarget | null;
  sourceReturnTo: SourceTarget | null;
  sourceLocation: SourceTarget | null;
}>(() => ({ target: null, parentPreview: null, returnTo: null, journalTarget: null, positions: new Map(), galleries: new Map(), disclosures: new Map(), goalHistory: new Map(), sourceTarget: null, sourceReturnTo: null, sourceLocation: null }));

export function previewCompanionNote(target: CompanionNotePreviewTarget, origin?: HTMLElement | null) {
  const scope = useRoomStore.getState().workspaceScopeRevision;
  const identity = `${scope}:${target.noteId}:${target.noteVersionId ?? "current"}:${target.artifact?.id ?? "body"}:${target.blockOrdinal ?? "top"}`;
  const current = useCompanionResultPreview.getState().target;
  const parentPreview = current?.artifact && origin?.closest(".companion-result-preview") ? current : null;
  useCompanionResultPreview.setState({ target: { ...target, scope, identity, ...previewOrigin(origin) }, parentPreview, sourceTarget: null });
}
export function previewCompanionSource(target: CompanionSourcePreviewTarget, origin?: HTMLElement | null) {
  const scope = useRoomStore.getState().workspaceScopeRevision;
  useCompanionResultPreview.setState({ target: null, parentPreview: null, sourceTarget: { ...target, scope,
    identity: `${scope}:source:${target.sourceId}:${target.segmentOrdinal ?? "whole"}`, ...previewOrigin(origin) } });
}
export function rememberCompanionNoteReturn(target: CompanionNotePreviewTarget, origin?: HTMLElement | null) {
  const scope = useRoomStore.getState().workspaceScopeRevision;
  const identity = `${scope}:${target.noteId}:${target.noteVersionId ?? "current"}:${target.artifact?.id ?? "body"}:${target.blockOrdinal ?? "top"}`;
  useCompanionResultPreview.setState({ returnTo: { ...target, scope, identity, ...previewOrigin(origin) } });
}
export function closeCompanionPreview() {
  useCompanionResultPreview.setState(state => ({ target: state.parentPreview, parentPreview: null }));
}
export function targetCompanionJournal(runId: string) {
  useCompanionResultPreview.setState(state => ({ journalTarget: { runId, visit: (state.journalTarget?.visit ?? 0) + 1 } }));
}

// UI state belongs to the workspace; late reads and return buttons cannot cross it.
useRoomStore.subscribe((state, previous) => {
  if (state.workspaceScopeRevision !== previous.workspaceScopeRevision)
    useCompanionResultPreview.setState({ target: null, parentPreview: null, returnTo: null, journalTarget: null, positions: new Map(), galleries: new Map(), disclosures: new Map(), goalHistory: new Map(), sourceTarget: null, sourceReturnTo: null, sourceLocation: null });
});
