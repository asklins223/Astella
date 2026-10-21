import { useRoomStore, type NoteTargetRef } from "../../../../../app/home/room-store";

/** Card navigation leaves the notebook, retaining its note and parent return. */
export function openNoteLearningCard(note: NoteTargetRef) {
  const room = useRoomStore.getState();
  const parent = room.returnTarget;
  const scope = room.workspaceScopeRevision;
  room.setActiveNoteRef(note);
  room.invoke("open-note-card", {
    returnTo: {
      label: "返回笔记",
      run: () => {
        const current = useRoomStore.getState();
        if (current.workspaceScopeRevision !== scope) return;
        current.setActiveNoteRef(note);
        current.invoke("open-notebook", parent ? { returnTo: parent } : undefined);
      },
    },
  });
}
