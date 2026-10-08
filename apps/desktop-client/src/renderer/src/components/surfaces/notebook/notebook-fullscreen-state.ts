import { useLayoutEffect, useRef } from "react";
import { create } from "zustand";
import { useRoomStore, type NoteTargetRef, type ReturnTarget } from "../../../app/room-store";

/** A presentation for this notebook visit, shared by linked notes and their loading states. */
export const useNotebookFullscreenState = create<{ active: boolean }>(() => ({ active: false }));

export function useNotebookFullscreenActive() {
  const active = useNotebookFullscreenState(state => state.active);
  const surface = useRoomStore(state => state.surface);
  return surface === "notebook" && active;
}

/** The page owns the visit; a document can unmount while the next note is being read. */
export function useNotebookFullscreenSession(currentNote: NoteTargetRef | null = null) {
  const fallback = useRef(currentNote); fallback.current = currentNote;
  useLayoutEffect(() => {
    const reset = () => useNotebookFullscreenState.setState({ active: false });
    let returning = false;
    const unsubscribe = useRoomStore.subscribe((next, previous) => {
      if (next.surface !== "notebook" || next.workspaceScopeRevision !== previous.workspaceScopeRevision) { reset(); return; }
      // Direct note routes (including companion results) get the same return path as library links.
      const previousNote = previous.activeNoteRef ?? fallback.current;
      if (returning || !useNotebookFullscreenState.getState().active || previous.surface !== "notebook"
        || !previousNote || !next.activeNoteRef || next.activeNoteRef.noteId === previousNote.noteId) return;
      const scope = next.workspaceScopeRevision, previousReturn = previous.returnTarget;
      const target: ReturnTarget = { label: "返回上一篇笔记", run: () => {
        const room = useRoomStore.getState();
        if (room.surface !== "notebook" || room.workspaceScopeRevision !== scope || room.returnTarget !== target) return;
        returning = true;
        try { room.setActiveNoteRef(previousNote); room.setReturnTarget(previousReturn); }
        finally { returning = false; }
      } };
      next.setReturnTarget(target);
    });
    return () => { unsubscribe(); reset(); };
  }, []);
}

/** 全屏是这次笔记访问的显示模式：速看、回想、往外学、演示、记录与这一轮学习都留在同一个整窗纸面里，换视图不退出。 */
export function useNotebookFullscreen() {
  const active = useNotebookFullscreenState(state => state.active);
  return {
    fullscreen: active,
    setFullscreen: (open: boolean) => useNotebookFullscreenState.setState({ active: open && useRoomStore.getState().surface === "notebook" }),
  };
}
