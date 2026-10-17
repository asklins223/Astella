import { create } from "zustand";
import { noteAnnotationPageV1Schema, noteAnnotationV1Schema, type NoteAnnotationAnchorV1, type NoteAnnotationV1 } from "@astella/shared/note-annotation-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../app/client/desktop-client";
import { useRoomStore } from "../../../app/home/room-store";
import type { CompanionFeedNoteAnchor } from "../hud/companion-feed";

export type NoteCompanionExplanationPhase = "preparing" | "explaining" | "saving" | "saved" | "stopped" | "interrupted" | "save-error";
export interface NoteCompanionExplanation {
  readonly id: string;
  readonly target: CompanionFeedNoteAnchor;
  readonly phase: NoteCompanionExplanationPhase;
  readonly text: string;
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
  const item: NoteCompanionExplanation = { id, target, phase: "preparing", text: "", error: null, stopUnconfirmed: false, annotation: null, dismissed: false };
  useNoteCompanionExplanations.setState(state => ({ activeId: id, items: [item, ...state.items.map(previous =>
    previous.target.noteId === target.noteId && noteAnchorsOverlap(previous.target.anchor, target.anchor)
      ? { ...previous, dismissed: true } : previous)] }));
  return item;
}

function update(id: string, change: Partial<NoteCompanionExplanation>, accept: (item: NoteCompanionExplanation) => boolean = () => true) {
  useNoteCompanionExplanations.setState(state => ({ items: state.items.map(item => item.id === id && accept(item) ? { ...item, ...change } : item) }));
}

export function progressNoteExplanation(id: string) {
  update(id, { phase: "explaining" }, item => item.phase === "preparing" || item.phase === "explaining");
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
  window.dispatchEvent(new CustomEvent("astella:note-explanation-stop", { detail: { id } }));
}

export function noteExplanationLabel(item: NoteCompanionExplanation): string {
  switch (item.phase) {
    case "preparing": return "伴星正在准备解释";
    case "explaining": return "伴星正在写解释";
    case "saving": return "正在读取批注";
    case "saved": return item.annotation?.versionState === "older" ? "解释已留在旧版批注" : "解释已贴回原句";
    case "stopped": return "解释已停止";
    case "interrupted": return "解释中断了";
    case "save-error": return "批注回执暂未读到";
  }
}

export function completeNoteExplanation(id: string, value: unknown): boolean {
  const item = useNoteCompanionExplanations.getState().items.find(item => item.id === id);
  const receipt = noteAnnotationV1Schema.safeParse(value);
  if (!item || !receipt.success) return false;
  const annotation = receipt.data;
  if (annotation.annotationId !== id || annotation.noteId !== item.target.noteId
    || !annotation.generationJobId || annotation.sourceMessageId !== null
    || Object.keys(item.target.anchor).some(key => annotation.anchor[key as keyof NoteAnnotationAnchorV1] !== item.target.anchor[key as keyof NoteAnnotationAnchorV1])) return false;
  if (item.phase === "saved" && item.annotation?.revision === annotation.revision) return true;
  update(id, { phase: "saved", annotation, text: annotation.explanation, error: null, stopUnconfirmed: false });
  window.dispatchEvent(new CustomEvent("astella:note-annotation-saved", { detail: { noteId: annotation.noteId, annotation } }));
  return true;
}

/** Stream reconnects and retries only read the tool-authored artifact. Speech never enters a write command. */
export async function readNoteExplanation(id: string) {
  const item = useNoteCompanionExplanations.getState().items.find(item => item.id === id);
  if (!item || item.phase === "saved" || item.phase === "stopped") return;
  update(id, { phase: "saving", error: null });
  try {
    if (!window.astella?.noteAnnotation) throw new Error("批注读取暂不可用，可以稍后重新读取。");
    let before: string | undefined;
    do {
      const page = noteAnnotationPageV1Schema.parse(unwrapGatewayResult(await window.astella.noteAnnotation.list({
        meta: createRequestMeta(), noteId: item.target.noteId, noteVersionId: item.target.anchor.noteVersionId,
        ...(before ? { before } : {}),
      })));
      const annotation = page.items.find(annotation => annotation.annotationId === id);
      if (annotation && completeNoteExplanation(id, annotation)) return;
      before = page.nextCursor ?? undefined;
    } while (before);
    update(id, { phase: "interrupted", error: "这轮没有写入原句解释。可以重新解释；聊天内容没有被当成批注保存。" }, current => current.phase !== "saved");
  } catch (error) {
    update(id, { phase: "save-error", error: gatewayErrorMessage(error) }, current => current.phase !== "saved");
  }
}

export function resetNoteExplanations() {
  useNoteCompanionExplanations.setState({ items: [], activeId: null, requestedOpenId: null });
}
