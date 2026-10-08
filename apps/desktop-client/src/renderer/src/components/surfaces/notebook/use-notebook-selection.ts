import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { readNoteAnchorTextV1, type NoteAnnotationAnchorV1 } from "@astella/shared/note-annotation-contracts";
import type { NoteDetailV1, NoteBlockProjectionV1 } from "@astella/shared/note-projection-contracts";
import { noteBlockText } from "./surface-data";
import { noteBlockRenderedTextV1 } from "@astella/shared/note-doc-schema";
import { noteReadingOffset, noteReadingText } from "./note-reading-text";

export function useNotebookSelection(input: {
  note: NoteDetailV1 | null; blocks: readonly NoteBlockProjectionV1[]; bodyRef: RefObject<HTMLDivElement | null>; active: boolean;
}) {
  const [selectedPassage, setSelectedPassage] = useState<{
    text: string; blockOrdinal: number; noteId: string; anchor: NoteAnnotationAnchorV1 | null; range: Range;
  } | null>(null);
  const latest = useRef(input); latest.current = input;
  const passage = useRef(selectedPassage); passage.current = selectedPassage;
  const gesture = useRef<{ pointerId: number | null; keys: Set<string> }>({ pointerId: null, keys: new Set() });
  const captureSelectedPassage = useCallback(() => {
    // selectionchange fires throughout a drag. Publish only its settled range.
    if (gesture.current.pointerId !== null || gesture.current.keys.size) return;
    const { bodyRef, note, blocks, active } = latest.current;
    const body = bodyRef.current, selection = window.getSelection();
    if (!active || !body || !selection || !selection.rangeCount || selection.isCollapsed) { setSelectedPassage(null); return; }
    const range = selection.getRangeAt(0);
    if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) { setSelectedPassage(null); return; }
    const roots = Array.from(body.querySelectorAll<HTMLElement>("[data-block-ordinal]"))
      .map(block => ({ block, content: block.querySelector<HTMLElement>("[data-note-block-content]") ?? block }))
      .filter(({ content }) => range.intersectsNode(content) && content.textContent?.length);
    // Whole-paragraph selections can end at the next paragraph's zero offset.
    // Keep only the text-bearing outer endpoints before producing the exact anchor.
    const selectedRoots = roots.map(({ block, content }) => ({ block, content,
      startOffset: noteReadingOffset(content, range.startContainer, range.startOffset, 0, "start"),
      endOffset: noteReadingOffset(content, range.endContainer, range.endOffset, noteReadingText(content).length, "end"),
    })).filter(selected => selected.endOffset > selected.startOffset);
    while (selectedRoots.length) {
      const first = selectedRoots[0]!;
      const text = noteReadingText(first.content).slice(first.startOffset, first.endOffset);
      first.startOffset += text.length - text.trimStart().length;
      if (first.startOffset < first.endOffset) break;
      selectedRoots.shift();
    }
    while (selectedRoots.length) {
      const last = selectedRoots.at(-1)!;
      const text = noteReadingText(last.content).slice(last.startOffset, last.endOffset);
      last.endOffset -= text.length - text.trimEnd().length;
      if (last.endOffset > last.startOffset) break;
      selectedRoots.pop();
    }
    const start = selectedRoots[0], end = selectedRoots.at(-1);
    const ordinal = Number(start?.block.dataset.blockOrdinal), endOrdinal = Number(end?.block.dataset.blockOrdinal);
    if (!start || !end || !Number.isInteger(ordinal) || !Number.isInteger(endOrdinal)) { setSelectedPassage(null); return; }
    const startOffset = start.startOffset, endOffset = end.endOffset;
    const bounds = { startBlockOrdinal: ordinal, endBlockOrdinal: endOrdinal, startOffset, endOffset };
    const canonical = readNoteAnchorTextV1(blocks, bounds);
    const text = canonical?.excerpt ?? range.toString().trim();
    if (!text) { setSelectedPassage(null); return; }
    let anchor: NoteAnnotationAnchorV1 | null = null;
    const matching = selectedRoots.every(({ block, content }) => {
      const at = Number(block.dataset.blockOrdinal), current = blocks.find(item => item.ordinal === at);
      const frozen = note?.currentVersion.blocks.find(item => item.ordinal === at);
      return current && frozen && current.type === frozen.type && noteBlockText(current.content) === noteBlockText(frozen.content)
        && noteReadingText(content) === noteBlockRenderedTextV1(current.type, current.content);
    });
    if (note?.currentVersionId && canonical && text.length <= 2_000 && matching) {
      anchor = { noteVersionId: note.currentVersionId, ...bounds, ...canonical };
    }
    setSelectedPassage({ text, blockOrdinal: ordinal, noteId: note?.noteId ?? "", anchor, range: range.cloneRange() });
  }, []);
  useEffect(() => {
    if (!input.active) { setSelectedPassage(null); return; }
    let frame = 0;
    const changed = () => {
      cancelAnimationFrame(frame);
      if (gesture.current.pointerId === null && !gesture.current.keys.size) frame = requestAnimationFrame(captureSelectedPassage);
    };
    const pointerdown = (event: PointerEvent) => {
      if (event.button > 0 || event.isPrimary === false || !(event.target instanceof Node) || !latest.current.bodyRef.current?.contains(event.target)) return;
      gesture.current.pointerId = event.pointerId;
      cancelAnimationFrame(frame); setSelectedPassage(null);
    };
    const pointerup = (event: PointerEvent) => {
      if (gesture.current.pointerId === null || gesture.current.pointerId !== event.pointerId) return;
      gesture.current.pointerId = null; changed();
    };
    const keydown = (event: KeyboardEvent) => {
      const body = latest.current.bodyRef.current;
      const paper = body?.closest(".notebook-desk__scroll") ?? body;
      if (!(event.target instanceof Node) || !paper?.contains(event.target)) return;
      if (event.key === "Escape" && passage.current && !document.querySelector("dialog[open], [aria-modal='true']")
        && !(event.target instanceof Element && event.target.closest("[data-note-selection-action]"))) {
        event.preventDefault(); setSelectedPassage(null); window.getSelection()?.removeAllRanges(); return;
      }
      const extendsSelection = event.shiftKey && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key);
      const selectsAll = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a";
      if (!extendsSelection && !selectsAll) return;
      gesture.current.keys.add(event.key);
      cancelAnimationFrame(frame); setSelectedPassage(null);
    };
    const keyup = (event: KeyboardEvent) => { if (gesture.current.keys.delete(event.key)) changed(); };
    const cancel = () => {
      gesture.current.pointerId = null; gesture.current.keys.clear();
      cancelAnimationFrame(frame); setSelectedPassage(null);
    };
    document.addEventListener("selectionchange", changed);
    document.addEventListener("pointerdown", pointerdown, true);
    document.addEventListener("pointerup", pointerup, true);
    document.addEventListener("pointercancel", cancel, true);
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("keyup", keyup, true);
    window.addEventListener("blur", cancel);
    return () => {
      document.removeEventListener("selectionchange", changed);
      document.removeEventListener("pointerdown", pointerdown, true);
      document.removeEventListener("pointerup", pointerup, true);
      document.removeEventListener("pointercancel", cancel, true);
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("keyup", keyup, true);
      window.removeEventListener("blur", cancel);
      cancelAnimationFrame(frame); gesture.current.pointerId = null; gesture.current.keys.clear();
    };
  }, [input.active, captureSelectedPassage]);
  useEffect(() => setSelectedPassage(null), [input.note?.noteId, input.note?.currentVersionId]);
  return { selectedPassage, setSelectedPassage, captureSelectedPassage };
}
