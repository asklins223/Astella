import { create } from "zustand";
import { noteAnnotationV1Schema, type NoteAnnotationAnchorV1, type NoteAnnotationV1 } from "@ailearn/shared/note-annotation-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../app/desktop-client";
import { useRoomStore } from "../../app/room-store";
import type { CompanionFeedNoteAnchor } from "./companion-feed";

export type NoteCompanionExplanationPhase = "preparing" | "explaining" | "saving" | "saved" | "stopped" | "interrupted" | "save-error";
export interface NoteCompanionExplanation {
  readonly id: string;
  readonly target: CompanionFeedNoteAnchor;
  readonly phase: NoteCompanionExplanationPhase;
  readonly text: string;
  readonly messageId: string | null;
  readonly error: string | null;
  readonly stopUnconfirmed: boolean;
  readonly annotation: NoteAnnotationV1 | null;
  readonly dismissed: boolean;
}

/** One immutable quote owns one attempt, independently of the current bubble or selection. */
export const useNoteCompanionExplanations = create<{
  readonly items: readonly NoteCompanionExplanation[];
  readonly activeId: string | null;
  readonly requestedOpenId: string | null;
}>(() => ({ items: [], activeId: null, requestedOpenId: null }));

export function noteAnchorsOverlap(a: NoteAnnotationAnchorV1, b: NoteAnnotationAnchorV1): boolean {
  if (a.noteVersionId !== b.noteVersionId) return false;
  const before = (block: number, offset: number, otherBlock: number, otherOffset: number) => block < otherBlock || block === otherBlock && offset <= otherOffset;
  return !before(a.endBlockOrdinal, a.endOffset, b.startBlockOrdinal, b.startOffset)
    && !before(b.endBlockOrdinal, b.endOffset, a.startBlockOrdinal, a.startOffset);
}

export function noteExplanationBusy(item: NoteCompanionExplanation): boolean {
  return item.phase === "preparing" || item.phase === "explaining" || item.phase === "saving";
}

export function pendingNoteExplanation(target: CompanionFeedNoteAnchor): NoteCompanionExplanation | undefined {
  return useNoteCompanionExplanations.getState().items.find(item => item.target.noteId === target.noteId
    && (noteExplanationBusy(item) || item.phase === "save-error") && noteAnchorsOverlap(item.target.anchor, target.anchor));
}

export function beginNoteExplanation(target: CompanionFeedNoteAnchor, id = crypto.randomUUID()): NoteCompanionExplanation {
  const pending = pendingNoteExplanation(target);
  if (pending) return pending;
  const item: NoteCompanionExplanation = { id, target, phase: "preparing", text: "", messageId: null, error: null, stopUnconfirmed: false, annotation: null, dismissed: false };
  useNoteCompanionExplanations.setState(state => ({ activeId: id, items: [item, ...state.items.map(previous =>
    previous.target.noteId === target.noteId && noteAnchorsOverlap(previous.target.anchor, target.anchor)
      ? { ...previous, dismissed: true } : previous)] }));
  return item;
}

function update(id: string, change: Partial<NoteCompanionExplanation>, accept: (item: NoteCompanionExplanation) => boolean = () => true) {
  useNoteCompanionExplanations.setState(state => ({ items: state.items.map(item => item.id === id && accept(item) ? { ...item, ...change } : item) }));
}

export function progressNoteExplanation(id: string, text: string) {
  update(id, { phase: "explaining", text }, item => item.phase === "preparing" || item.phase === "explaining");
}

export function interruptNoteExplanation(id: string, phase: "stopped" | "interrupted", error: string | null = null) {
  update(id, { phase, error }, item => item.phase === "preparing" || item.phase === "explaining");
}

export function reportNoteExplanationStopFailure(id: string, message: string | null) {
  update(id, { error: message, stopUnconfirmed: message !== null }, item => item.phase === "stopped");
}

export function dismissNoteExplanation(id: string) {
  update(id, { dismissed: true }, item => !noteExplanationBusy(item));
}

export function openNoteExplanation(id: string) {
  const item = useNoteCompanionExplanations.getState().items.find(current => current.id === id);
  if (!item) return;
  const room = useRoomStore.getState();
  if (room.hudPage !== "note-read" || room.activeNoteRef?.noteId !== item.target.noteId) {
    room.setActiveNoteRef({ noteId: item.target.noteId, noteVersionId: item.target.anchor.noteVersionId, mode: "preview" });
    room.invoke("open-notebook");
  }
  useNoteCompanionExplanations.setState({ requestedOpenId: id });
}

export function stopNoteExplanation(id: string) {
  interruptNoteExplanation(id, "stopped");
  window.dispatchEvent(new CustomEvent("ailearn:note-explanation-stop", { detail: { id } }));
}

export function noteExplanationLabel(item: NoteCompanionExplanation): string {
  switch (item.phase) {
    case "preparing": return "伴星正在准备解释";
    case "explaining": return "伴星正在解释";
    case "saving": return "正在保存批注";
    case "saved": return item.annotation?.versionState === "older" ? "解释已留在旧版批注" : "解释已贴回原句";
    case "stopped": return "解释已停止";
    case "interrupted": return "解释中断了";
    case "save-error": return "解释未保存";
  }
}

export async function completeNoteExplanation(id: string, messageId: string, text: string) {
  const item = useNoteCompanionExplanations.getState().items.find(item => item.id === id);
  if (!item || !noteExplanationBusy(item) || item.phase === "saving") return;
  if (!text.trim()) { interruptNoteExplanation(id, "interrupted", "这次没有生成可保存的解释。"); return; }
  update(id, { phase: "save-error", messageId, text, error: null });
  await saveNoteExplanation(id);
}

/** Retry uses the same final message identity; the API deduplicates that identity. Partial text never enters this path. */
export async function saveNoteExplanation(id: string) {
  const item = useNoteCompanionExplanations.getState().items.find(item => item.id === id);
  if (!item || item.phase !== "save-error" || !item.messageId) return;
  update(id, { phase: "saving", error: null });
  try {
    if (!window.ailearn?.noteAnnotation) throw new Error("批注保存暂不可用，可以稍后重试。");
    const annotation = noteAnnotationV1Schema.parse(unwrapGatewayResult(await window.ailearn.noteAnnotation.write({
      meta: createRequestMeta(), noteId: item.target.noteId,
      command: { kind: "create", anchor: item.target.anchor, explanation: item.text, sourceMessageId: item.messageId },
    })));
    if (annotation.noteId !== item.target.noteId || Object.keys(item.target.anchor).some(key => annotation.anchor[key as keyof NoteAnnotationAnchorV1] !== item.target.anchor[key as keyof NoteAnnotationAnchorV1])
      || annotation.sourceMessageId !== item.messageId) throw new Error("批注保存回执与这次解释不一致，请重试保存。");
    // A workspace reset removes the attempt: its late receipt must not enter the new workspace.
    if (!useNoteCompanionExplanations.getState().items.some(current => current.id === id)) return;
    update(id, { phase: "saved", annotation, error: null });
    window.dispatchEvent(new CustomEvent("ailearn:note-annotation-saved", { detail: { noteId: annotation.noteId, annotation } }));
  } catch (error) {
    update(id, { phase: "save-error", error: gatewayErrorMessage(error) });
  }
}

export function resetNoteExplanations() {
  useNoteCompanionExplanations.setState({ items: [], activeId: null, requestedOpenId: null });
}
