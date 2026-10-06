import type { NoteDetailV1 } from "@astella/shared/note-projection-contracts";
import { createRequestMeta, unwrapGatewayResult } from "../../../app/desktop-client";
import { useRoomStore } from "../../../app/room-store";
import { watchCompanionTask } from "../../companion/companion-notification-tasks";
import { publishCompanionRecordsChanged } from "../../companion/companion-events";

/** Capture before launching: late receipts retain their original workspace and note. */
export function prepareNotebookTaskNotification(note: Pick<NoteDetailV1, "noteId" | "currentVersionId" | "title">, epoch: number | undefined) {
  const scope = useRoomStore.getState().workspaceScopeRevision;
  const api = window.astella;
  return (task: { readonly taskId: string; readonly status: string; readonly agentRunId?: string }, kind: "overview" | "artifact" | "expansion") => {
    if (task.agentRunId) {
      if (useRoomStore.getState().workspaceScopeRevision === scope) publishCompanionRecordsChanged();
      return;
    }
    const endpoint = kind === "overview" ? api?.noteOverview : kind === "artifact" ? api?.noteLearningArtifact : api?.noteExpansion;
    if (!endpoint?.getTask) return;
    const label = kind === "overview" ? "笔记速看" : kind === "artifact" ? "互动演示" : "拓展草稿";
    watchCompanionTask({
      id: `${kind}:${task.taskId}`, scope, title: label, subject: note.title,
      read: async () => unwrapGatewayResult<{ status: string }>(await endpoint.getTask({ meta: createRequestMeta(epoch), noteId: note.noteId, taskId: task.taskId })),
      open: () => {
        const room = useRoomStore.getState();
        if (room.workspaceScopeRevision !== scope) return;
        room.setActiveNoteRef({ noteId: note.noteId, noteVersionId: note.currentVersionId,
          learningView: kind === "overview" ? "overview" : kind === "artifact" ? "history" : "expansion" });
        room.invoke("open-notebook");
      },
    });
  };
}
