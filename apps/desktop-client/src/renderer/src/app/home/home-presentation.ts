import type { RoomProjectionV1, RoomSectionStatusV1 } from "@astella/shared/room-projection-contracts";
import type { RoomIntent } from "./room-machine";

type NoteRef = { readonly noteId: string; readonly noteVersionId: string; readonly title: string };

function roomIntent(value: RoomIntent | null): RoomIntent | null {
  return value;
}

/** Home copy is derived only from the note projection and its explicit section states. */
export function homePresentation(projection: RoomProjectionV1 | null, loading: boolean, failure: string | null) {
  const blockingLoading = loading && !projection;
  const recentActivity = projection?.recentActivitySummary;
  const sectionLoading = recentActivity?.state === "loading";
  const sectionError = recentActivity?.state === "error";
  const refreshing = Boolean(projection && (loading || sectionLoading));
  const primaryFailed = Boolean(failure && !projection);
  const retry = primaryFailed;
  const note: NoteRef | null = projection?.recentNote
    ? {
        noteId: projection.recentNote.noteId,
        noteVersionId: projection.recentNote.noteVersionId,
        title: projection.recentNote.title,
      }
    : null;

  let title: string;
  let detail: string;
  let primaryLabel: string;
  let primaryIntent: RoomIntent | null;
  if (blockingLoading) {
    title = "正在整理今天的书桌…";
    detail = "学习空间正在读取你的笔记";
    primaryLabel = "正在准备";
    primaryIntent = null;
  } else if (primaryFailed) {
    title = "笔记暂未送达";
    detail = failure || "首页暂时无法读取你的笔记";
    primaryLabel = retry ? "重新读取" : "看看今天";
    primaryIntent = null;
  } else if (note) {
    title = note.title;
    detail = "上次停在这里，接着往下读";
    primaryLabel = "接着读";
    primaryIntent = "continue";
  } else {
    title = "从一份真正想弄懂的材料开始";
    detail = "书桌上有今天真正停下的位置";
    primaryLabel = "看看今天";
    primaryIntent = null;
  }

  const sectionStates: Readonly<Record<keyof RoomProjectionV1["sectionStates"], RoomSectionStatusV1 | null>> = {
    recentActivitySummary: recentActivity?.state ?? null,
  };
  const notebookState: "syncing" | "attention" | "ready" | "empty" = blockingLoading
    ? "syncing"
    : primaryFailed
      ? "attention"
      : projection?.mode === "notes"
        ? "ready"
        : "empty";
  const shelfState: "syncing" | "unknown" | "filled" = blockingLoading
    ? "syncing"
    : note
      ? "filled"
      : "unknown";

  return {
    title,
    detail,
    primaryLabel,
    primaryIntent: roomIntent(primaryIntent),
    retry,
    blockingLoading,
    primaryLoading: blockingLoading,
    refreshing,
    sectionLoading,
    sectionError,
    sectionStates,
    note,
    hasFocus: false,
    actionAvailable: null,
    captureState: projection?.captureCapability.state ?? "unavailable",
    snapshotAt: projection?.snapshotAt ?? null,
    degraded: Boolean(projection?.degradation || (projection && failure) || sectionError),
    notebookState,
    shelfState,
  };
}
