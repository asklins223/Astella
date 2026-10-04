import { useCallback, useEffect, useState } from "react";
import type { NoteOverviewV1 } from "@ailearn/shared/note-overview-contracts";
import type { NoteLearningArtifactV1 } from "@ailearn/shared/note-learning-artifact-contracts";
import type { NoteTargetRef } from "../../../app/room-store";
import { useRoomStore } from "../../../app/room-store";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../app/desktop-client";

type SavedResult = { kind: "note_overview"; overview: NoteOverviewV1 } | { kind: "note_dynamic_artifact"; artifact: NoteLearningArtifactV1 };
/** Exact receipt loading is independent of a paginated gallery and of the current note version. */
export function useNotebookGoalResult(noteId: string | undefined, requested: NoteTargetRef["learningResult"], epochRef: { current: number | undefined }) {
  const scope = useRoomStore(state => state.workspaceScopeRevision);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  const key = `${scope}:${noteId}:${requested?.kind}:${requested?.taskId}:${requested?.artifactId}:${attempt}`;
  const [saved, setSaved] = useState<{ key: string; result: SavedResult | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!noteId || !requested || requested.kind === "note_expansion") return;
    let obsolete = false;
    void (async () => {
      try {
        const input = { meta: createRequestMeta(epochRef.current), noteId, taskId: requested.taskId };
        let result: SavedResult;
        if (requested.kind === "note_overview") {
          const task = unwrapGatewayResult(await window.ailearn.noteOverview.getTask(input));
          if (task.taskId !== requested.taskId || task.noteId !== noteId || !task.overview || task.overview.overviewId !== requested.artifactId) {
            throw new Error("这份速看暂时没有读到，可以重新读取。");
          }
          result = { kind: "note_overview", overview: task.overview };
        } else {
          const task = unwrapGatewayResult(await window.ailearn.noteLearningArtifact.getTask(input));
          if (task.taskId !== requested.taskId || task.noteId !== noteId || !task.artifact || task.artifact.artifactId !== requested.artifactId) {
            throw new Error("这份互动演示暂时没有读到，可以重新读取。");
          }
          result = { kind: "note_dynamic_artifact", artifact: task.artifact };
        }
        if (!obsolete && useRoomStore.getState().workspaceScopeRevision === scope) setSaved({ key, result, error: null });
      } catch (error) {
        if (!obsolete && useRoomStore.getState().workspaceScopeRevision === scope) setSaved({ key, result: null, error: gatewayErrorMessage(error) });
      }
    })();
    return () => { obsolete = true; };
  }, [key]);
  const current = saved?.key === key ? saved : { key, result: null, error: null };
  return { ...current, loading: Boolean(noteId && requested && requested.kind !== "note_expansion" && saved?.key !== key), retry };
}
