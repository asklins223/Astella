/**
 * 「批注」那一簇的 8 个 state：列表、任务、复核那一批、搁架开没开、以及在途与失败。
 *
 * ## 为什么只收 state、不收 handler（2026-09-29）
 *
 * `loadNoteAnnotations` / `loadLatestNoteAnnotationTask` / `startNoteAnnotationTask` /
 * `verifyNoteAnnotations` / `persistAnnotationReview` 五个 handler 各自要读
 * `note` / `epochRef` / `reload` / `activeNoteRef` —— 全是页面级的。
 *
 * ## 三条不许动
 *
 *  1. **`verification` 记的是「复核的是哪一版的哪几条」**——`noteId` + `versionId` + `ids`
 *     三样缺一不可。**只记 ids 会把上一版的复核算到这一版头上。**
 *  2. **`rows` 与 `task` 是两半**：`rows` 是「这一篇有过哪些批注」，`task` 是
 *     「正在讲解哪一条」。合成一处会出现「读完列表顺手清了任务」。
 *  3. **`shelfOpen` 管的是旧版记录那个搁架**，与当前版的那张纸不是一回事——
 *     旧版记录点开是搁架，当前版点开是就地展开。
 */
import { useState } from "react";
import type { NoteAnnotationTaskV1, NoteAnnotationV1 } from "@ailearn/shared/note-annotation-contracts";

/** 复核的那一批：版本与 ids 三样都要记（见文件头第 1 条）。 */
export type AnnotationVerificationV1 = {
  readonly noteId: string;
  readonly versionId: string;
  readonly ids: Set<string>;
};

export function useNotebookAnnotationState() {
  const [annotationRows, setAnnotationRows] = useState<{ noteId: string; items: NoteAnnotationV1[]; nextCursor: string | null } | null>(null);
  const [annotationTask, setAnnotationTask] = useState<NoteAnnotationTaskV1 | null>(null);
  const [annotationTaskStarting, setAnnotationTaskStarting] = useState(false);
  const [annotationTaskError, setAnnotationTaskError] = useState<string | null>(null);
  const [annotationShelfOpen, setAnnotationShelfOpen] = useState(false);
  const [annotationVerification, setAnnotationVerification] = useState<AnnotationVerificationV1 | null>(null);
  const [annotationLoading, setAnnotationLoading] = useState(false);
  const [annotationError, setAnnotationError] = useState<string | null>(null);

  return {
    annotationRows, setAnnotationRows,
    annotationTask, setAnnotationTask,
    annotationTaskStarting, setAnnotationTaskStarting,
    annotationTaskError, setAnnotationTaskError,
    annotationShelfOpen, setAnnotationShelfOpen,
    annotationVerification, setAnnotationVerification,
    annotationLoading, setAnnotationLoading,
    annotationError, setAnnotationError,
  };
}
