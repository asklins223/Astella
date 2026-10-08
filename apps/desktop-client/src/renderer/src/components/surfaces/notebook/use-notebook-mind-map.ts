import { useRoomStore } from "../../../app/room-store";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NoteMindMapTaskV1, NoteMindMapV1 } from "@astella/shared/note-mind-map-contracts";
import type { NoteDetailV1 } from "@astella/shared/note-projection-contracts";
import { createRequestMeta, unwrapGatewayResult, gatewayErrorMessage } from "../../../app/desktop-client";
import { prepareNotebookTaskNotification } from "./notebook-task-notifications";

export function useNotebookMindMap(input: {
  readonly note: NoteDetailV1 | null;
  /** 共享的 epoch 游标：每个请求都拿它算 meta，回包里推进它。 */
  readonly epochRef: { current: number | undefined };
  /** undefined: normal gallery; null: an explicitly selected result is not loaded. */
  readonly requestedMindMap?: NoteMindMapV1 | null;
}) {
  const { note, epochRef, requestedMindMap } = input;
  const scope = useRoomStore(state => state.workspaceScopeRevision);
  const [storedScope, setStoredScope] = useState(scope);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [mindMapRows, setMindMapRows] = useState<{ noteId: string; items: NoteMindMapV1[]; nextCursor: string | null } | null>(null);
  const [mindMapLoading, setMindMapLoading] = useState(false);
  const [mindMapError, setMindMapError] = useState<string | null>(null);
  const mindMapRequestRef = useRef(0);
  const [mindMapTask, setMindMapTask] = useState<NoteMindMapTaskV1 | null>(null);
  const [mindMapTaskStarting, setMindMapTaskStarting] = useState(false);
  const [mindMapTaskError, setMindMapTaskError] = useState<string | null>(null);
  const mindMapTaskRequestRef = useRef(0);
  const startingRef = useRef(false);
  const mindMapPaperRef = useRef<HTMLElement | null>(null);
  const [mindMapOpen, setMindMapOpen] = useState(false);

  const loadNoteMindMaps = useCallback(async (before?: string) => {
    if (!note) return;
    const api = typeof window === "undefined" ? undefined : window.astella;
    if (!api?.noteMindMap) {
      setMindMapError("速看记录暂不可用");
      return;
    }
    const request = ++mindMapRequestRef.current;
    setMindMapLoading(true);
    setMindMapError(null);
    try {
      const page = unwrapGatewayResult(await api.noteMindMap.list({
        meta: createRequestMeta(epochRef.current),
        noteId: note.noteId,
        before,
      }));
      if (request !== mindMapRequestRef.current) return;
      setMindMapRows((current) => before && current?.noteId === note.noteId
        ? { ...page, noteId: note.noteId, items: [...current.items, ...page.items] }
        : { ...page, noteId: note.noteId });
      return page;
    } catch (error) {
      if (request === mindMapRequestRef.current) setMindMapError(gatewayErrorMessage(error));
    } finally {
      if (request === mindMapRequestRef.current) setMindMapLoading(false);
    }
  }, [note?.noteId, note?.currentVersionId, scope]);

  const loadLatestNoteMindMapTask = useCallback(async () => {
    if (!note?.currentVersionId) return;
    const api = typeof window === "undefined" ? undefined : window.astella;
    if (!api?.noteMindMap) return;
    const request = ++mindMapTaskRequestRef.current;
    setMindMapTaskError(null);
    const notifyTask = prepareNotebookTaskNotification(note, epochRef.current);
    try {
      const result = unwrapGatewayResult(await api.noteMindMap.latestTask({
        meta: createRequestMeta(epochRef.current),
        noteId: note.noteId,
        query: { noteVersionId: note.currentVersionId },
      }));
      if (result.task && ["queued", "running"].includes(result.task.status)) notifyTask(result.task, "mindMap");
      if (request === mindMapTaskRequestRef.current) setMindMapTask(result.task);
      return result;
    } catch (error) {
      if (request === mindMapTaskRequestRef.current) setMindMapTaskError(gatewayErrorMessage(error));
    }
  }, [note?.noteId, note?.currentVersionId, scope]);

  const startNoteMindMapTask = useCallback(async (hasUnsavedChanges: boolean) => {
    if (!note || !note.currentVersionId || hasUnsavedChanges || startingRef.current
      || mindMapTask?.status === "queued" || mindMapTask?.status === "running") return;
    const api = typeof window === "undefined" ? undefined : window.astella;
    if (!api?.noteMindMap) {
      setMindMapTaskError("速看任务暂不可用");
      return;
    }
    const request = ++mindMapTaskRequestRef.current;
    startingRef.current = true;
    setMindMapTaskStarting(true);
    setMindMapTaskError(null);
    const notifyTask = prepareNotebookTaskNotification(note, epochRef.current);
    try {
      const task = unwrapGatewayResult(await api.noteMindMap.startTask({
        meta: createRequestMeta(epochRef.current),
        noteId: note.noteId,
        request: { noteVersionId: note.currentVersionId, requestId: crypto.randomUUID() },
      }));
      notifyTask(task, "mindMap");
      if (request === mindMapTaskRequestRef.current) { setSelectedId(null); setMindMapTask(task); }
    } catch (error) {
      if (request === mindMapTaskRequestRef.current) setMindMapTaskError(gatewayErrorMessage(error));
    } finally {
      if (request === mindMapTaskRequestRef.current) { startingRef.current = false; setMindMapTaskStarting(false); }
    }
  }, [note?.noteId, note?.currentVersionId, scope, mindMapTask?.status]);

  useEffect(() => {
    setStoredScope(scope); setMindMapRows(null); setSelectedId(null); setMindMapError(null);
    void loadNoteMindMaps();
    return () => { ++mindMapRequestRef.current; };
  }, [note?.noteId, note?.currentVersionId, scope, loadNoteMindMaps]);

  useEffect(() => {
    ++mindMapTaskRequestRef.current; startingRef.current = false;
    setMindMapTask(null);
    setMindMapTaskError(null);
    setMindMapTaskStarting(false);
    if (note?.currentVersionId) void loadLatestNoteMindMapTask();
    return () => { ++mindMapTaskRequestRef.current; startingRef.current = false; };
  }, [note?.noteId, note?.currentVersionId, scope, loadLatestNoteMindMapTask]);

  useEffect(() => {
    if (!note || !mindMapTask || mindMapTask.noteId !== note.noteId
      || mindMapTask.noteVersionId !== note.currentVersionId
      || (mindMapTask.status !== "queued" && mindMapTask.status !== "running")) return;
    const api = typeof window === "undefined" ? undefined : window.astella;
    if (!api?.noteMindMap) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = () => {
      timer = window.setTimeout(async () => {
        try {
          const task = unwrapGatewayResult(await api.noteMindMap.getTask({
            meta: createRequestMeta(epochRef.current),
            noteId: note.noteId,
            taskId: mindMapTask.taskId,
          }));
          if (cancelled) return;
          setMindMapTaskError(null);
          setMindMapTask(task);
          if (task.status === "ready" && task.mindMap) {
            setMindMapRows((current) => {
              const base = current?.noteId === note.noteId ? current : { noteId: note.noteId, items: [], nextCursor: null };
              return { ...base, items: [task.mindMap!, ...base.items.filter((item) => item.mindMapId !== task.mindMap!.mindMapId)] };
            });
          } else if (task.status === "queued" || task.status === "running") {
            poll();
          }
        } catch (error) {
          if (!cancelled) {
            setMindMapTaskError(gatewayErrorMessage(error));
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
  }, [note?.noteId, note?.currentVersionId, scope, mindMapTask?.taskId, mindMapTask?.status]);

  const noteMindMaps = useMemo(
    () => storedScope === scope && note && mindMapRows?.noteId === note.noteId ? mindMapRows.items : [],
    [note?.noteId, mindMapRows, storedScope, scope],
  );
  const taskForCurrentVersion = storedScope === scope && mindMapTask && mindMapTask.noteId === note?.noteId
    && mindMapTask.noteVersionId === note?.currentVersionId ? mindMapTask : null;
  const selected = noteMindMaps.find(map => map.mindMapId === selectedId);
  const latestNoteMindMap = requestedMindMap !== undefined ? requestedMindMap : selected
    ?? (taskForCurrentVersion?.status === "ready" ? taskForCurrentVersion.mindMap : null)
    ?? noteMindMaps.find(map => map.noteVersionId === note?.currentVersionId) ?? noteMindMaps[0] ?? null;

  return {
    selectMindMap: (map: NoteMindMapV1) => setSelectedId(map.mindMapId),
    mindMapRows,
    setMindMapRows,
    mindMapLoading,
    setMindMapLoading,
    mindMapError,
    setMindMapError,
    mindMapTask,
    setMindMapTask,
    mindMapTaskStarting,
    setMindMapTaskStarting,
    mindMapTaskError,
    setMindMapTaskError,
    mindMapOpen,
    setMindMapOpen,
    mindMapPaperRef,
    loadNoteMindMaps,
    loadLatestNoteMindMapTask,
    startNoteMindMapTask,
    noteMindMaps,
    taskForCurrentVersion,
    latestNoteMindMap,
  };
}
