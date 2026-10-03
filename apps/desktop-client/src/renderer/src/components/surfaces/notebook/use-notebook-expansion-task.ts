import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { NoteDetailV1 } from "@ailearn/shared/note-projection-contracts";
import type { NoteAnnotationAnchorV1 } from "@ailearn/shared/note-annotation-contracts";
import { noteExpansionReviewV1Schema, type NoteExpansionDraftV1, type NoteExpansionLinkV1, type NoteExpansionTaskV1 } from "@ailearn/shared/note-expansion-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../app/desktop-client";

type TaskBuffer = { scope: string; task: NoteExpansionTaskV1 | null; revision: number; savedRevision: number };
type Lookup = { ok: true; task: NoteExpansionTaskV1 | null } | { ok: false };

/** Task receipts never replace a newer edit or a different note's buffer. */
export function useNotebookExpansionTask(input: {
  readonly note: NoteDetailV1 | null;
  readonly dirty: boolean;
  readonly epochRef: { current: number | undefined };
  readonly onConfirmed: (links: NoteExpansionLinkV1[]) => void;
}) {
  const scope = `${input.note?.noteId ?? ""}:${input.note?.currentVersionId ?? ""}`;
  const latest = useRef(input); latest.current = input;
  const buffer = useRef<TaskBuffer>({ scope, task: null, revision: 0, savedRevision: 0 });
  const [state, setState] = useState(buffer.current);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<{ scope: string; items: NoteExpansionTaskV1[]; nextCursor: string | null }>({ scope, items: [], nextCursor: null });
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const historyRequest = useRef(0);
  const readRequest = useRef(0), lookupRequest = useRef(0), actionRequest = useRef(0);
  const inFlight = useRef(false);
  const resolved = useRef(false);
  const initialRead = useRef<{ scope: string; promise: Promise<Lookup> } | null>(null);
  if (buffer.current.scope !== scope) {
    buffer.current = { scope, task: null, revision: 0, savedRevision: 0 };
    ++readRequest.current; ++lookupRequest.current; ++actionRequest.current;
    inFlight.current = false; resolved.current = false; initialRead.current = null;
  }
  const publish = (task: NoteExpansionTaskV1 | null, saved = false) => {
    const current = buffer.current;
    const replaced = task?.taskId !== current.task?.taskId;
    buffer.current = { ...current, task, revision: replaced ? 0 : current.revision,
      savedRevision: replaced ? 0 : saved ? current.revision : current.savedRevision };
    setState(buffer.current);
    if (task) setHistory(current => ({ scope: buffer.current.scope,
      items: [task, ...(current.scope === buffer.current.scope ? current.items.filter(item => item.taskId !== task.taskId) : [])],
      nextCursor: current.scope === buffer.current.scope ? current.nextCursor : null }));
  };
  const matches = (expected: TaskBuffer) => buffer.current.scope === expected.scope
    && buffer.current.task?.taskId === expected.task?.taskId && buffer.current.revision === expected.revision;
  const validateReceipt = (task: NoteExpansionTaskV1, note: NoteDetailV1, taskId?: string) => {
    if (task.noteId !== note.noteId || task.noteVersionId !== note.currentVersionId || taskId && task.taskId !== taskId) {
      throw new Error("收到的草稿不属于这篇笔记和批次，请重试读取。");
    }
    return task;
  };
  const setLocalTask: Dispatch<SetStateAction<NoteExpansionTaskV1 | null>> = useCallback(update => {
    const current = buffer.current;
    const task = typeof update === "function" ? update(current.task) : update;
    if (!task || task.taskId !== current.task?.taskId || JSON.stringify(task.drafts) === JSON.stringify(current.task.drafts)) return;
    buffer.current = { ...current, task, revision: current.revision + 1 };
    setState(buffer.current);
  }, []);

  const loadLatest = useCallback((): Promise<Lookup> => {
    const note = latest.current.note;
    const expected = { ...buffer.current };
    if (!note?.currentVersionId) return Promise.resolve({ ok: false });
    if (initialRead.current?.scope === expected.scope) return initialRead.current.promise;
    const api = window.ailearn?.noteExpansion;
    if (!api) { setError("已有草稿暂时读不到，请重试读取。"); return Promise.resolve({ ok: false }); }
    const request = ++readRequest.current, lookup = ++lookupRequest.current;
    setLoading(true); setError(null);
    const promise = (async (): Promise<Lookup> => {
      try {
        const result = unwrapGatewayResult(await api.latestTask({ meta: createRequestMeta(latest.current.epochRef.current), noteId: note.noteId, query: { noteVersionId: note.currentVersionId! } }));
        if (request !== readRequest.current || buffer.current.scope !== expected.scope) return { ok: false };
        const task = result.task ? validateReceipt(result.task, note) : null;
        if (matches(expected)) publish(task);
        resolved.current = true;
        return { ok: true, task: buffer.current.task };
      } catch (failure) {
        if (request === readRequest.current && buffer.current.scope === expected.scope) setError(`已有草稿没读到：${gatewayErrorMessage(failure)}`);
        return { ok: false };
      } finally {
        // Polling can supersede this receipt without owning the lookup's loading state.
        if (lookup === lookupRequest.current && buffer.current.scope === expected.scope) {
          setLoading(false); initialRead.current = null;
        }
      }
    })();
    initialRead.current = { scope: expected.scope, promise };
    return promise;
  }, []);

  const loadTask = useCallback(async (taskId: string, select = false) => {
    const note = latest.current.note, expected = { ...buffer.current };
    const api = window.ailearn?.noteExpansion;
    if (!note || !api || expected.revision !== expected.savedRevision) return;
    if (!select && expected.task?.status === "ready" && expected.task.taskId !== taskId) return;
    if (select && inFlight.current) return;
    const request = ++readRequest.current;
    try {
      const task = validateReceipt(unwrapGatewayResult(await api.getTask({ meta: createRequestMeta(latest.current.epochRef.current), noteId: note.noteId, taskId })), note, taskId);
      if (request !== readRequest.current || !matches(expected)) return;
      publish(task); resolved.current = true; setError(null);
    } catch (failure) { if (request === readRequest.current && matches(expected)) setError(gatewayErrorMessage(failure)); }
  }, []);

  const loadHistory = useCallback(async (before?: string) => {
    const note = latest.current.note, expectedScope = buffer.current.scope;
    const api = window.ailearn?.noteExpansion;
    if (!note?.currentVersionId || !api?.listTasks) return;
    const request = ++historyRequest.current;
    setHistoryLoading(true); setHistoryError(null);
    try {
      const page = unwrapGatewayResult(await api.listTasks({ meta: createRequestMeta(latest.current.epochRef.current), noteId: note.noteId,
        query: { noteVersionId: note.currentVersionId, ...(before ? { before } : {}) } }));
      if (request !== historyRequest.current || buffer.current.scope !== expectedScope) return;
      page.items.forEach(task => validateReceipt(task, note));
      setHistory(current => ({ scope: expectedScope, items: [...new Map([...(before && current.scope === expectedScope ? current.items : []),
        ...page.items].map(task => [task.taskId, task])).values()], nextCursor: page.nextCursor }));
    } catch (failure) { if (request === historyRequest.current && buffer.current.scope === expectedScope) setHistoryError(gatewayErrorMessage(failure)); }
    finally { if (request === historyRequest.current && buffer.current.scope === expectedScope) setHistoryLoading(false); }
  }, []);

  const start = useCallback(async (focusAnchor?: NoteAnnotationAnchorV1, useSavedVersion = false) => {
    const { note, dirty, epochRef } = latest.current;
    const expectedScope = buffer.current.scope;
    if (!note?.currentVersionId || dirty && !useSavedVersion || inFlight.current) return;
    const api = window.ailearn?.noteExpansion;
    if (!api) { setError("拓展任务暂时不可用，可以重试。"); return; }
    inFlight.current = true;
    const request = ++actionRequest.current;
    setStarting(true); setError(null);
    try {
      if (!resolved.current) {
        const result = await loadLatest();
        if (!result.ok || buffer.current.scope !== expectedScope || request !== actionRequest.current) return;
      }
      if (buffer.current.task?.status === "queued" || buffer.current.task?.status === "running") return;
      // Save pending edits before replacing the displayed batch.
      if (buffer.current.revision !== buffer.current.savedRevision) {
        setError("当前草稿还有修改未保存。先重试保存，再整理新的一批。"); return;
      }
      const expected = { ...buffer.current };
      ++readRequest.current;
      const task = validateReceipt(unwrapGatewayResult(await api.startTask({ meta: createRequestMeta(epochRef.current), noteId: note.noteId,
        request: { noteVersionId: note.currentVersionId, requestId: crypto.randomUUID(), ...(focusAnchor ? { focusAnchor } : {}) } })), note);
      if (request === actionRequest.current && buffer.current.scope === expectedScope) {
        if (matches(expected)) publish(task);
        else setError("当前草稿又有新修改，已保留在本页，请先保存。");
      }
    } catch (failure) { if (request === actionRequest.current && buffer.current.scope === expectedScope) setError(gatewayErrorMessage(failure)); }
    finally { if (request === actionRequest.current && buffer.current.scope === expectedScope) { inFlight.current = false; setStarting(false); } }
  }, [loadLatest]);


  const persist = useCallback(async (_drafts: NoteExpansionDraftV1[]) => {
    const { note, epochRef } = latest.current, expected = { ...buffer.current };
    const api = window.ailearn?.noteExpansion;
    if (!note || !expected.task || expected.task.status !== "ready" || inFlight.current || expected.revision === expected.savedRevision) return;
    const review = noteExpansionReviewV1Schema.safeParse({ drafts: expected.task.drafts.map(({ candidateId, title, blocks, selected }) => ({ candidateId, title, blocks, selected })) });
    if (!review.success) { setError("每篇草稿都需要标题和正文，正文不能超过 20000 字。补完整后重试保存。"); return; }
    if (!api) { setError("草稿还在本页，暂时没能保存，请重试。"); return; }
    const request = ++actionRequest.current;
    inFlight.current = true; setSaving(true); setError(null);
    try {
      const task = validateReceipt(unwrapGatewayResult(await api.review({ meta: createRequestMeta(epochRef.current), noteId: note.noteId, taskId: expected.task.taskId, review: review.data })), note, expected.task.taskId);
      if (request !== actionRequest.current || buffer.current.scope !== expected.scope) return;
      if (matches(expected)) publish(task, true);
      else setError("还有新的修改未保存，草稿已保留，请重试保存。");
    } catch (failure) {
      if (request === actionRequest.current && buffer.current.scope === expected.scope) setError(`草稿已保留，保存没成功：${gatewayErrorMessage(failure)}`);
    } finally { if (request === actionRequest.current && buffer.current.scope === expected.scope) { inFlight.current = false; setSaving(false); } }
  }, []);

  const confirm = useCallback(async () => {
    const { note, epochRef } = latest.current, expected = { ...buffer.current };
    const api = window.ailearn?.noteExpansion;
    if (!note || !expected.task || expected.task.status !== "ready" || inFlight.current) return;
    const candidateIds = expected.task.drafts.filter(draft => draft.selected && !expected.task!.confirmedCandidateIds?.includes(draft.candidateId)).map(draft => draft.candidateId);
    if (!candidateIds.length) return;
    const review = noteExpansionReviewV1Schema.safeParse({ drafts: expected.task.drafts.map(({ candidateId, title, blocks, selected }) => ({ candidateId, title, blocks, selected })) });
    if (!review.success) { setError("先补完整草稿的标题和正文，再确认收下。"); return; }
    if (!api) { setError("草稿还在本页，暂时不能收下，请重试。"); return; }
    const request = ++actionRequest.current;
    inFlight.current = true; setSaving(true); setError(null);
    try {
      const reviewed = validateReceipt(unwrapGatewayResult(await api.review({ meta: createRequestMeta(epochRef.current), noteId: note.noteId, taskId: expected.task.taskId, review: review.data })), note, expected.task.taskId);
      if (request !== actionRequest.current || buffer.current.scope !== expected.scope) return;
      if (!matches(expected)) { setError("草稿刚有新的修改，已保留在本页。检查后再次确认收下。"); return; }
      publish(reviewed, true);
      const saved = unwrapGatewayResult(await api.confirm({ meta: createRequestMeta(epochRef.current), noteId: note.noteId, taskId: expected.task.taskId, request: { candidateIds } }));
      if (request !== actionRequest.current || !matches(expected)) return;
      if (saved.length !== candidateIds.length || saved.some(link => link.sourceNoteId !== note.noteId || link.sourceNoteVersionId !== note.currentVersionId || link.sourceTaskId !== expected.task!.taskId)) throw new Error("收下回执与这批草稿不一致，请重新读取。");
      const confirmedCandidateIds = [...new Set([...(reviewed.confirmedCandidateIds ?? []), ...candidateIds])];
      publish({ ...reviewed, status: reviewed.drafts.every(draft => confirmedCandidateIds.includes(draft.candidateId)) ? "confirmed" : "ready", confirmedCandidateIds }, true);
      latest.current.onConfirmed(saved);
    } catch (failure) {
      if (request === actionRequest.current && buffer.current.scope === expected.scope) setError(`草稿已保留，这次没能收下：${gatewayErrorMessage(failure)}`);
    } finally { if (request === actionRequest.current && buffer.current.scope === expected.scope) { inFlight.current = false; setSaving(false); } }
  }, []);

  useEffect(() => {
    setState(buffer.current); setLoading(false); setStarting(false); setSaving(false); setError(null);
    setHistory({ scope, items: [], nextCursor: null }); setHistoryLoading(false); setHistoryError(null);
    if (input.note?.currentVersionId) { void loadLatest(); void loadHistory(); }
    return () => { ++readRequest.current; ++lookupRequest.current; ++actionRequest.current; ++historyRequest.current; inFlight.current = false; };
  }, [scope, loadLatest, loadHistory]);
  const task = state.scope === scope ? state.task : null;
  useEffect(() => {
    if (!task || task.status !== "queued" && task.status !== "running") return;
    let cancelled = false;
    let timer: number;
    const poll = () => { timer = window.setTimeout(async () => { await loadTask(task.taskId); if (!cancelled) poll(); }, 1_600); };
    poll();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [task?.taskId, task?.status, loadTask]);
  useEffect(() => {
    const started = (event: Event) => {
      const detail = (event as CustomEvent<{ noteId?: unknown; taskId?: unknown }>).detail;
      if (detail?.noteId === latest.current.note?.noteId && typeof detail?.taskId === "string") void loadTask(detail.taskId);
    };
    window.addEventListener("ailearn:note-expansion-task-started", started);
    return () => window.removeEventListener("ailearn:note-expansion-task-started", started);
  }, [loadTask]);
  return { expansionTask: task, setExpansionTask: setLocalTask, expansionTaskLoading: loading, expansionTaskStarting: starting,
    expansionReviewSaving: saving, expansionTaskError: error, expansionReviewDirty: state.scope === scope && state.revision !== state.savedRevision,
    loadLatestNoteExpansionTask: loadLatest, startNoteExpansionTask: start,
    expansionTaskHistory: history.scope === scope ? history.items : [], expansionTaskHistoryCursor: history.scope === scope ? history.nextCursor : null,
    expansionTaskHistoryLoading: historyLoading, expansionTaskHistoryError: historyError, loadNoteExpansionTaskHistory: loadHistory,
    openNoteExpansionTask: (taskId: string) => loadTask(taskId, true),
    persistNoteExpansionReview: persist, confirmNoteExpansionDrafts: confirm };
}
