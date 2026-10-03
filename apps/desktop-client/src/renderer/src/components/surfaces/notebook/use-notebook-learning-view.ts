import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { NotebookLearningView } from "./notebook-desk";
import { useRoomStore } from "../../../app/room-store";

type Position = { block: number | null; offset: number; top: number };
const readingMemory = new Map<string, Map<string, Position>>();

/** Only a user entry changes the task. Receipts update its contents without navigating. */
export function useNotebookLearningView(input: {
  readonly noteId: string | null;
  readonly leaf: string;
  readonly recallVisit: number;
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly inReading: boolean;
  readonly ready?: boolean;
}) {
  const [view, setView] = useState<NotebookLearningView>("body");
  const key = input.leaf === "reading" ? `${view}:${view === "recall" ? input.recallVisit : ""}` : input.leaf;
  const workspaceScope = useRoomStore(state => state.workspaceScopeRevision);
  const scope = `${workspaceScope}:${input.noteId ?? ""}`;
  const positions = useRef(readingMemory.get(scope) ?? new Map<string, Position>());
  const previousScope = useRef(scope);
  if (previousScope.current !== scope) {
    positions.current = readingMemory.get(scope) ?? new Map<string, Position>();
    previousScope.current = scope;
  }
  const ready = input.ready !== false;
  const latest = useRef({ ...input, view, key, scope }); latest.current = { ...input, view, key, scope };
  const rememberReadingPosition = useCallback(() => {
    const { scrollRef, key, view, inReading, noteId, scope, ready } = latest.current;
    const scroller = scrollRef.current;
    if (!scroller || !scroller.isConnected || !noteId || ready === false) return;
    const top = scroller.getBoundingClientRect().top;
    const block = view === "body" && inReading
      ? [...scroller.querySelectorAll<HTMLElement>("#notebook-reading-leaf [data-block-ordinal]")].find(item => item.getBoundingClientRect().bottom > top)
      : null;
    positions.current.set(key, { block: block ? Number(block.dataset.blockOrdinal) : null, offset: block ? block.getBoundingClientRect().top - top : 0, top: scroller.scrollTop });
    readingMemory.set(scope, positions.current);
    if (readingMemory.size > 100) readingMemory.delete(readingMemory.keys().next().value!);
  }, []);
  useEffect(() => {
    const scroller = input.scrollRef.current;
    if (!scroller || !input.noteId || !ready) return;
    readingMemory.set(scope, positions.current);
    if (readingMemory.size > 100) readingMemory.delete(readingMemory.keys().next().value!);
    scroller.addEventListener("scroll", rememberReadingPosition, { passive: true });
    return () => scroller.removeEventListener("scroll", rememberReadingPosition);
  }, [scope, input.noteId, input.scrollRef, rememberReadingPosition, ready]);
  const setLearningView = useCallback((next: NotebookLearningView) => {
    rememberReadingPosition();
    setView(next);
  }, [rememberReadingPosition]);
  useEffect(() => { setView("body"); }, [input.noteId]);
  useLayoutEffect(() => {
    const scroller = input.scrollRef.current;
    if (!scroller || !ready) return;
    const saved = positions.current.get(key);
    const block = saved?.block === null || saved?.block === undefined ? null : scroller.querySelector<HTMLElement>(`#notebook-reading-leaf [data-block-ordinal="${saved.block}"]`);
    scroller.scrollTop = block && saved ? scroller.scrollTop + block.getBoundingClientRect().top - scroller.getBoundingClientRect().top - saved.offset : saved?.top ?? 0;
    if (scroller.closest("[hidden], [inert]")) return;
    const focus = saved && saved.top > 0 ? null : [...scroller.querySelectorAll<HTMLElement>("[data-task-focus]")].find(node => !node.closest("[hidden], [inert]"));
    (focus ?? scroller).focus({ preventScroll: true });
  }, [scope, key, input.noteId, input.scrollRef, ready]);
  return { learningView: view, setLearningView, rememberReadingPosition };
}
