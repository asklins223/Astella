import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { noteRecallRecordV1Schema, type NoteRecallRecordV1 } from "@astella/shared/note-recall-contracts";
import type { NoteDetailV1 } from "@astella/shared/note-projection-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../app/desktop-client";
import type { RecallActionV1, RecallBusyV1 } from "./notebook-recall-contract";

type RecallRows = { noteId: string; items: NoteRecallRecordV1[]; nextCursor: string | null };
const unique = (items: NoteRecallRecordV1[]) => [...new Map(items.map(item => [item.recallId, item])).values()];

/** Durable receipts and this visit are separate; background updates never navigate. */
export function useNotebookRecallState(input: {
  readonly note: NoteDetailV1 | null;
  readonly epochRef: { current: number | undefined };
}) {
  const { note, epochRef } = input;
  const [rows, setRows] = useState<RecallRows | null>(null);
  const [active, setActive] = useState<NoteRecallRecordV1 | null>(null);
  const [visit, setVisit] = useState(0);
  const [presentation, setPresentation] = useState<"practice" | "history">("practice");
  const [busy, setBusy] = useState<RecallBusyV1>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reflection, setReflectionValue] = useState("");
  const scope = `${note?.noteId ?? ""}:${note?.currentVersionId ?? ""}`;
  const latest = useRef({ note, active, scope }); latest.current = { note, active, scope };
  const snapshot = useRef<RecallRows | null>(null);
  const receipts = useRef(new Map<string, NoteRecallRecordV1>());
  const reflections = useRef(new Map<string, string>());
  const initialRead = useRef<{ pending: boolean; promise: Promise<NoteRecallRecordV1[] | null> } | null>(null);
  const readRequest = useRef(0);
  const actionRequest = useRef(0);
  const inFlight = useRef(false);

  const publish = (next: RecallRows | null) => { snapshot.current = next; setRows(next); };
  const load = useCallback((before?: string): Promise<NoteRecallRecordV1[] | null> => {
    if (!note) return Promise.resolve(null);
    const api = window.astella?.noteRecall;
    if (!api) { setError("回想记录暂不可用，可以重新打开。"); return Promise.resolve(null); }
    const request = ++readRequest.current;
    setLoading(true); setError(null);
    const promise = (async () => {
      try {
        const page = unwrapGatewayResult(await api.list({ meta: createRequestMeta(epochRef.current), noteId: note.noteId, before }));
        if (request !== readRequest.current || latest.current.scope !== scope) return null;
        const current = before && snapshot.current?.noteId === note.noteId ? snapshot.current.items : [];
        const items = unique([...current, ...page.items]).map(item => receipts.current.get(item.recallId) ?? item);
        // A receipt can arrive while the first page is still in flight. It must
        // survive that older list response, including records created meanwhile.
        const missing = [...receipts.current.values()].filter(item => !items.some(row => row.recallId === item.recallId));
        publish({ ...page, noteId: note.noteId, items: [...missing, ...items] });
        return snapshot.current!.items;
      } catch (failure) {
        if (request === readRequest.current) setError(gatewayErrorMessage(failure));
        return null;
      } finally {
        if (request === readRequest.current) {
          setLoading(false);
          if (!before && initialRead.current) initialRead.current.pending = false;
        }
      }
    })();
    if (!before) initialRead.current = { pending: true, promise };
    return promise;
  }, [note?.noteId, note?.currentVersionId, scope, epochRef]);

  useEffect(() => {
    ++readRequest.current; ++actionRequest.current; inFlight.current = false;
    receipts.current.clear(); reflections.current.clear(); initialRead.current = null; publish(null);
    setActive(null); setReflectionValue(""); setBusy(null); setError(null); setLoading(false);
    if (note) void load();
    return () => { ++readRequest.current; ++actionRequest.current; inFlight.current = false; };
  }, [note?.noteId, note?.currentVersionId, load]);

  const open = (record: NoteRecallRecordV1, origin: "practice" | "history" = "history") => {
    const current = receipts.current.get(record.recallId) ?? record;
    latest.current.active = current;
    setActive(current); setPresentation(origin); setVisit(value => value + 1);
    setReflectionValue(current.state === "reported" ? current.reflection ?? "" : reflections.current.get(current.recallId) ?? current.reflection ?? ""); setError(null);
  };
  const setReflection = (value: string) => {
    const record = latest.current.active;
    if (!record || record.state === "reported") return;
    reflections.current.set(record.recallId, value);
    setReflectionValue(value);
  };
  const merge = (record: NoteRecallRecordV1) => {
    receipts.current.set(record.recallId, record);
    if (record.state === "reported") {
      reflections.current.delete(record.recallId);
      if (latest.current.active?.recallId === record.recallId) setReflectionValue(record.reflection ?? "");
    }
    const base = snapshot.current?.noteId === record.noteId ? snapshot.current : { noteId: record.noteId, items: [], nextCursor: null };
    publish({ ...base, items: [record, ...base.items.filter(item => item.recallId !== record.recallId)] });
  };
  useEffect(() => {
    const saved = (event: Event) => {
      const detail = (event as CustomEvent<{ noteId?: unknown; record?: unknown }>).detail;
      const parsed = noteRecallRecordV1Schema.safeParse(detail?.record);
      if (!parsed.success || detail?.noteId !== latest.current.note?.noteId || parsed.data.noteId !== latest.current.note?.noteId) return;
      merge(parsed.data);
      if (latest.current.active?.recallId === parsed.data.recallId) setActive(parsed.data);
    };
    window.addEventListener("astella:note-recall-saved", saved);
    return () => window.removeEventListener("astella:note-recall-saved", saved);
  }, []);

  const records = useMemo(() => note && rows?.noteId === note.noteId ? rows.items : [], [note?.noteId, rows]);
  const start = async (forceNew = false) => {
    const current = latest.current.note;
    if (!current?.currentVersionId || inFlight.current) return;
    const api = window.astella?.noteRecall;
    if (!api) { setError("回想暂时没能打开，可以重试。"); return; }
    const request = ++actionRequest.current;
    inFlight.current = true; setBusy("start"); setError(null);
    try {
      if (!forceNew) {
        const loaded = initialRead.current?.pending ? await initialRead.current.promise : snapshot.current?.items ?? await load();
        if (request !== actionRequest.current || latest.current.scope !== scope) return;
        // Failed history reads must not silently create a second unfinished task.
        if (loaded === null) return;
        const resumable = snapshot.current?.items.find(record => record.noteVersionId === current.currentVersionId && record.state !== "reported");
        if (resumable) { open(resumable, "practice"); return; }
      }
      const record = unwrapGatewayResult(await api.start({ meta: createRequestMeta(epochRef.current), noteId: current.noteId,
        request: { requestId: crypto.randomUUID(), noteVersionId: current.currentVersionId } }));
      if (request !== actionRequest.current || latest.current.scope !== scope) return;
      merge(record); open(record, "practice");
    } catch (failure) { if (request === actionRequest.current) setError(gatewayErrorMessage(failure)); }
    finally { if (request === actionRequest.current) { inFlight.current = false; setBusy(null); } }
  };
  const act = async (action: RecallActionV1) => {
    const { note: current, active: record } = latest.current;
    const api = window.astella?.noteRecall;
    if (!current || !record || inFlight.current) return;
    if (!api) { setError("这一步暂时没能记下，可以重试。"); return; }
    const request = ++actionRequest.current;
    inFlight.current = true; setBusy(action.kind === "self_report" ? "report" : action.kind); setError(null);
    try {
      const updated = unwrapGatewayResult(await api.act({ meta: createRequestMeta(epochRef.current), noteId: current.noteId, recallId: record.recallId, action }));
      if (request !== actionRequest.current || latest.current.scope !== scope) return;
      merge(updated);
      if (latest.current.active?.recallId === record.recallId) setActive(updated);
    } catch (failure) { if (request === actionRequest.current) setError(gatewayErrorMessage(failure)); }
    finally { if (request === actionRequest.current) { inFlight.current = false; setBusy(null); } }
  };
  return { rows, records, active, visit, presentation, busy, loading, error, reflection, setReflection, load, start, act, open, close: () => { latest.current.active = null; setActive(null); } };
}
