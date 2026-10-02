import { useCallback, useEffect, useState, type SetStateAction } from "react";

type SidePage = { kind: "annotation" | "companion-explanation"; id: string } | { kind: "versions" | "source" | "annotation-task" | "annotation-draft" } | null;

/** Opening a paper replaces the other paper; closing it never resets the main scroll. */
export function useNotebookSidePage(noteId: string | null) {
  const [page, setPage] = useState<SidePage>(null);
  const closeSidePage = useCallback(() => setPage(null), []);
  useEffect(() => setPage(null), [noteId]);
  const setHistoryOpen = useCallback((open: boolean) => setPage(current => open ? { kind: "versions" } : current?.kind === "versions" ? null : current), []);
  const setSourceBagOpen = useCallback((open: boolean) => setPage(current => open ? { kind: "source" } : current?.kind === "source" ? null : current), []);
  const setAnnotationTaskOpen = useCallback((open: boolean) => setPage(current => open ? { kind: "annotation-task" } : current?.kind === "annotation-task" ? null : current), []);
  const setAnnotationDraftOpen = useCallback((open: boolean) => setPage(current => open ? { kind: "annotation-draft" } : current?.kind === "annotation-draft" ? null : current), []);
  const setCompanionExplanationId = useCallback((id: string | null) => setPage(current => id ? { kind: "companion-explanation", id }
    : current?.kind === "companion-explanation" ? null : current), []);
  const setOpenAnnotationId = useCallback((update: SetStateAction<string | null>) => setPage(current => {
    const id = current?.kind === "annotation" ? current.id : null;
    const next = typeof update === "function" ? update(id) : update;
    return next ? { kind: "annotation", id: next } : current?.kind === "annotation" ? null : current;
  }), []);
  return { historyOpen: page?.kind === "versions", setHistoryOpen, sourceBagOpen: page?.kind === "source", setSourceBagOpen,
    annotationTaskOpen: page?.kind === "annotation-task", setAnnotationTaskOpen,
    annotationDraftOpen: page?.kind === "annotation-draft", setAnnotationDraftOpen,
    companionExplanationId: page?.kind === "companion-explanation" ? page.id : null, setCompanionExplanationId,
    openAnnotationId: page?.kind === "annotation" ? page.id : null, setOpenAnnotationId, closeSidePage };
}
