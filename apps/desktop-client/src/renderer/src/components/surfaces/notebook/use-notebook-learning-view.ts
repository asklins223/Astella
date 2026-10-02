import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { NotebookLearningView } from "./notebook-desk";

type Position = { block: number | null; offset: number; top: number };

/** Only a user entry changes the task. Receipts update its contents without navigating. */
export function useNotebookLearningView(input: {
  readonly noteId: string | null;
  readonly leaf: string;
  readonly recallVisit: number;
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly inReading: boolean;
}) {
  const [view, setView] = useState<NotebookLearningView>("body");
  const key = input.leaf === "reading" ? `${view}:${view === "recall" ? input.recallVisit : ""}` : input.leaf;
  const positions = useRef(new Map<string, Position>());
  const previousNote = useRef(input.noteId);
  const latest = useRef({ ...input, view, key }); latest.current = { ...input, view, key };
  const rememberReadingPosition = useCallback(() => {
    const { scrollRef, key, view, inReading } = latest.current;
    const scroller = scrollRef.current;
    if (!scroller) return;
    const top = scroller.getBoundingClientRect().top;
    const block = view === "body" && inReading
      ? [...scroller.querySelectorAll<HTMLElement>("#notebook-reading-leaf [data-block-ordinal]")].find(item => item.getBoundingClientRect().bottom > top)
      : null;
    positions.current.set(key, { block: block ? Number(block.dataset.blockOrdinal) : null, offset: block ? block.getBoundingClientRect().top - top : 0, top: scroller.scrollTop });
  }, []);
  const setLearningView = useCallback((next: NotebookLearningView) => {
    rememberReadingPosition();
    setView(next);
  }, [rememberReadingPosition]);
  useEffect(() => { setView("body"); }, [input.noteId]);
  useLayoutEffect(() => {
    if (previousNote.current !== input.noteId) {
      positions.current.clear();
      previousNote.current = input.noteId;
    }
    const scroller = input.scrollRef.current;
    if (!scroller) return;
    const saved = positions.current.get(key);
    const block = saved?.block === null || saved?.block === undefined ? null : scroller.querySelector<HTMLElement>(`#notebook-reading-leaf [data-block-ordinal="${saved.block}"]`);
    scroller.scrollTop = block && saved ? scroller.scrollTop + block.getBoundingClientRect().top - scroller.getBoundingClientRect().top - saved.offset : saved?.top ?? 0;
    if (scroller.closest("[hidden], [inert]")) return;
    const focus = [...scroller.querySelectorAll<HTMLElement>("[data-task-focus]")].find(node => !node.closest("[hidden], [inert]"));
    (focus ?? scroller).focus({ preventScroll: true });
  }, [key, input.noteId, input.scrollRef]);
  return { learningView: view, setLearningView, rememberReadingPosition };
}
