import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { readNoteAnchorTextV1, type NoteAnnotationAnchorV1 } from "@ailearn/shared/note-annotation-contracts";
import type { NoteDetailV1, NoteBlockProjectionV1 } from "@ailearn/shared/note-projection-contracts";
import { noteBlockText } from "./surface-data";
import { noteBlockRenderedTextV1 } from "@ailearn/shared/note-doc-schema";

export function useNotebookSelection(input: {
  note: NoteDetailV1 | null; blocks: readonly NoteBlockProjectionV1[]; bodyRef: RefObject<HTMLDivElement | null>; active: boolean;
}) {
  const [selectedPassage, setSelectedPassage] = useState<{
    text: string; blockOrdinal: number; noteId: string; anchor: NoteAnnotationAnchorV1 | null; range: Range;
  } | null>(null);
  const latest = useRef(input); latest.current = input;
  const captureSelectedPassage = useCallback(() => {
    const { bodyRef, note, blocks, active } = latest.current;
    const body = bodyRef.current, selection = window.getSelection();
    if (!active || !body || !selection || !selection.rangeCount || selection.isCollapsed) { setSelectedPassage(null); return; }
    const range = selection.getRangeAt(0);
    if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) { setSelectedPassage(null); return; }
    const roots = Array.from(body.querySelectorAll<HTMLElement>("[data-block-ordinal]"))
      .map(block => ({ block, content: block.querySelector<HTMLElement>("[data-note-block-content]") ?? block }))
      .filter(({ content }) => range.intersectsNode(content) && content.textContent?.length);
    const offset = (root: HTMLElement, node: Node, at: number, fallback: number) => {
      if (!root.contains(node)) return fallback;
      const before = document.createRange(); before.selectNodeContents(root); before.setEnd(node, at); return before.toString().length;
    };
    // Whole-paragraph selections can end at the next paragraph's zero offset.
    // Keep only the text-bearing outer endpoints before producing the exact anchor.
    const selectedRoots = roots.map(({ block, content }) => ({ block, content,
      startOffset: offset(content, range.startContainer, range.startOffset, 0),
      endOffset: offset(content, range.endContainer, range.endOffset, content.textContent?.length ?? 0),
    })).filter(selected => selected.endOffset > selected.startOffset);
    while (selectedRoots.length) {
      const first = selectedRoots[0]!;
      const text = (first.content.textContent ?? "").slice(first.startOffset, first.endOffset);
      first.startOffset += text.length - text.trimStart().length;
      if (first.startOffset < first.endOffset) break;
      selectedRoots.shift();
    }
    while (selectedRoots.length) {
      const last = selectedRoots.at(-1)!;
      const text = (last.content.textContent ?? "").slice(last.startOffset, last.endOffset);
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
        && content.textContent === noteBlockRenderedTextV1(current.type, current.content);
    });
    if (note?.currentVersionId && canonical && text.length <= 2_000 && matching) {
      anchor = { noteVersionId: note.currentVersionId, ...bounds, ...canonical };
    }
    setSelectedPassage({ text: text.slice(0, 2_000), blockOrdinal: ordinal, noteId: note?.noteId ?? "", anchor, range: range.cloneRange() });
  }, []);
  useEffect(() => {
    if (!input.active) { setSelectedPassage(null); return; }
    let frame = 0;
    const changed = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(captureSelectedPassage); };
    document.addEventListener("selectionchange", changed);
    document.addEventListener("pointerup", changed);
    return () => { document.removeEventListener("selectionchange", changed); document.removeEventListener("pointerup", changed); cancelAnimationFrame(frame); };
  }, [input.active, captureSelectedPassage]);
  useEffect(() => setSelectedPassage(null), [input.note?.noteId, input.note?.currentVersionId]);
  return { selectedPassage, setSelectedPassage, captureSelectedPassage };
}
