/**
 * 笔记「速看」那一簇的状态、读写与派生。
 *
 * ## 为什么从 `notebook-surface.tsx` 拆出来（2026-09-29）
 *
 * `NotebookSurface` 单个函数有 4300 多行、91 个 state，而这些 state 按命名前缀聚得很干净
 * （overview / expansion / annotation / learning / round / recall / older / teaching 各 5–8 个）。
 * 继续往那个函数里堆会让「哪几个 state 属于哪一块」彻底看不出来，所以按簇收成 hook——
 * **判据见 `AGENTS.md` §工程结构与分层：单函数超过 400 行或 hook 超过 25 个就是信号。**
 *
 * 这是第一簇（`overview`）。它是最干净的一块：7 个 state、3 个回调、2 个 effect、
 * 2 条派生，只依赖 `note` 与 `epochRef`。
 *
 * ## 为什么对外**原名导出**
 *
 * 簇外还有 11 处引用这些名字，其中 5 处直接用 setter（换篇时 `setOverviewRows(null)`、
 * 切叶时 `setOverviewOpen(false)`）。所以 hook 返回时**沿用原名**，
 * 调用点解构之后，文件其余部分一个字都不用改——这样拆分的 diff 只包含「搬走」，
 * 不包含「顺手改写」，review 的人能一眼看出行为没变。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NoteOverviewTaskV1, NoteOverviewV1 } from "@ailearn/shared/note-overview-contracts";
import type { NoteDetailV1 } from "@ailearn/shared/note-projection-contracts";
import { createRequestMeta, unwrapGatewayResult, gatewayErrorMessage } from "../../../app/desktop-client";

export function useNotebookOverview(input: {
  readonly note: NoteDetailV1 | null;
  /** 共享的 epoch 游标：每个请求都拿它算 meta，回包里推进它。 */
  readonly epochRef: { current: number | undefined };
}) {
  const { note, epochRef } = input;

  const [overviewRows, setOverviewRows] = useState<{ noteId: string; items: NoteOverviewV1[]; nextCursor: string | null } | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const overviewRequestRef = useRef(0);
  const [overviewTask, setOverviewTask] = useState<NoteOverviewTaskV1 | null>(null);
  const [overviewTaskStarting, setOverviewTaskStarting] = useState(false);
  const [overviewTaskError, setOverviewTaskError] = useState<string | null>(null);
  const overviewTaskRequestRef = useRef(0);
  const overviewPaperRef = useRef<HTMLElement | null>(null);
  const [overviewOpen, setOverviewOpen] = useState(false);

  const loadNoteOverviews = useCallback(async (before?: string) => {
    if (!note) return;
    const api = typeof window === "undefined" ? undefined : window.ailearn;
    if (!api?.noteOverview) {
      setOverviewError("速看记录暂不可用");
      return;
    }
    const request = ++overviewRequestRef.current;
    setOverviewLoading(true);
    setOverviewError(null);
    try {
      const page = unwrapGatewayResult(await api.noteOverview.list({
        meta: createRequestMeta(epochRef.current),
        noteId: note.noteId,
        before,
      }));
      if (request !== overviewRequestRef.current) return;
      setOverviewRows((current) => before && current?.noteId === note.noteId
        ? { ...page, noteId: note.noteId, items: [...current.items, ...page.items] }
        : { ...page, noteId: note.noteId });
    } catch (error) {
      if (request === overviewRequestRef.current) setOverviewError(gatewayErrorMessage(error));
    } finally {
      if (request === overviewRequestRef.current) setOverviewLoading(false);
    }
  }, [note?.noteId, note?.currentVersionId]);

  const loadLatestNoteOverviewTask = useCallback(async () => {
    if (!note?.currentVersionId) return;
    const api = typeof window === "undefined" ? undefined : window.ailearn;
    if (!api?.noteOverview) return;
    const request = ++overviewTaskRequestRef.current;
    setOverviewTaskError(null);
    try {
      const result = unwrapGatewayResult(await api.noteOverview.latestTask({
        meta: createRequestMeta(epochRef.current),
        noteId: note.noteId,
        query: { noteVersionId: note.currentVersionId },
      }));
      if (request === overviewTaskRequestRef.current) setOverviewTask(result.task);
    } catch (error) {
      // An optional background lookup failing must not turn the note's first
      // screen into a service-error page. An explicit start still reports its
      // own failure beside the action.
      if (request === overviewTaskRequestRef.current) setOverviewTask(null);
    }
  }, [note?.noteId, note?.currentVersionId]);

  const startNoteOverviewTask = useCallback(async (hasUnsavedChanges: boolean) => {
    if (!note || !note.currentVersionId || hasUnsavedChanges || overviewTaskStarting) return;
    const api = typeof window === "undefined" ? undefined : window.ailearn;
    if (!api?.noteOverview) {
      setOverviewTaskError("速看任务暂不可用");
      return;
    }
    const request = ++overviewTaskRequestRef.current;
    setOverviewTaskStarting(true);
    setOverviewTaskError(null);
    try {
      const task = unwrapGatewayResult(await api.noteOverview.startTask({
        meta: createRequestMeta(epochRef.current),
        noteId: note.noteId,
        request: { noteVersionId: note.currentVersionId, requestId: crypto.randomUUID() },
      }));
      if (request === overviewTaskRequestRef.current) setOverviewTask(task);
    } catch (error) {
      if (request === overviewTaskRequestRef.current) setOverviewTaskError(gatewayErrorMessage(error));
    } finally {
      if (request === overviewTaskRequestRef.current) setOverviewTaskStarting(false);
    }
  }, [note?.noteId, note?.currentVersionId, overviewTaskStarting]);

  useEffect(() => {
    setOverviewTask(null);
    setOverviewTaskError(null);
    setOverviewTaskStarting(false);
    if (note?.currentVersionId) void loadLatestNoteOverviewTask();
  }, [note?.noteId, note?.currentVersionId, loadLatestNoteOverviewTask]);

  useEffect(() => {
    if (!note || !overviewTask || overviewTask.noteId !== note.noteId
      || overviewTask.noteVersionId !== note.currentVersionId
      || (overviewTask.status !== "queued" && overviewTask.status !== "running")) return;
    const api = typeof window === "undefined" ? undefined : window.ailearn;
    if (!api?.noteOverview) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = () => {
      timer = window.setTimeout(async () => {
        try {
          const task = unwrapGatewayResult(await api.noteOverview.getTask({
            meta: createRequestMeta(epochRef.current),
            noteId: note.noteId,
            taskId: overviewTask.taskId,
          }));
          if (cancelled) return;
          setOverviewTaskError(null);
          setOverviewTask(task);
          if (task.status === "ready" && task.overview) {
            setOverviewOpen(true);
            setOverviewRows((current) => {
              const base = current?.noteId === note.noteId ? current : { noteId: note.noteId, items: [], nextCursor: null };
              return { ...base, items: [task.overview!, ...base.items.filter((item) => item.overviewId !== task.overview!.overviewId)] };
            });
          } else if (task.status === "queued" || task.status === "running") {
            poll();
          }
        } catch (error) {
          if (!cancelled) {
            setOverviewTaskError(gatewayErrorMessage(error));
            poll();
          }
        }
      }, 1_600);
    };
    poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [note?.noteId, note?.currentVersionId, overviewTask?.taskId, overviewTask?.status]);

  const noteOverviews = useMemo(
    () => note && overviewRows?.noteId === note.noteId ? overviewRows.items : [],
    [note?.noteId, overviewRows],
  );
  // Earlier Companion replies remain in the history, but they never claimed
  // full-note coverage. Only a completed background task can occupy the
  // reading page's "这篇的重点" slot.
  const currentNoteOverviews = noteOverviews.filter((overview) => overview.versionState === "current"
    && overview.generationJobId !== null && overview.coverage !== null);
  const taskForCurrentVersion = overviewTask && overviewTask.noteId === note?.noteId
    && overviewTask.noteVersionId === note?.currentVersionId ? overviewTask : null;
  const latestNoteOverview = currentNoteOverviews[0]
    ?? (taskForCurrentVersion?.status === "ready" ? taskForCurrentVersion.overview : null);

  return {
    overviewRows,
    setOverviewRows,
    overviewLoading,
    setOverviewLoading,
    overviewError,
    setOverviewError,
    overviewTask,
    setOverviewTask,
    overviewTaskStarting,
    setOverviewTaskStarting,
    overviewTaskError,
    setOverviewTaskError,
    overviewOpen,
    setOverviewOpen,
    overviewPaperRef,
    loadNoteOverviews,
    startNoteOverviewTask,
    noteOverviews,
    taskForCurrentVersion,
    latestNoteOverview,
  };
}
