import { useRoomStore, type NoteTargetRef, type ReturnTarget } from "../../../app/room-store";

/** A list selection uses the same document route and guarded return path in both presentations. */
export function openNotebookListNote(noteId: string, fallback: NoteTargetRef | null) {
  const room = useRoomStore.getState();
  const previous = room.activeNoteRef ?? fallback;
  if (room.surface !== "notebook" || previous?.noteId === noteId) return;
  const scope = room.workspaceScopeRevision, previousReturn = room.returnTarget;
  room.setActiveNoteRef({ noteId, noteVersionId: null, mode: "preview" });
  if (!previous) return;
  const target: ReturnTarget = { label: "返回上一篇笔记", run: () => {
    const current = useRoomStore.getState();
    if (current.surface !== "notebook" || current.workspaceScopeRevision !== scope || current.returnTarget !== target) return;
    current.setActiveNoteRef(previous);
    current.setReturnTarget(previousReturn);
  } };
  room.setReturnTarget(target);
}
