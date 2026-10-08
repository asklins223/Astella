import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopNoteListItem } from "@astella/shared/desktop-surface-contracts";
import { useRoomStore } from "../../../app/room-store";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../app/desktop-client";
import { readAuthenticatedSession } from "../../../app/surface-session";

/** Keep the index alive while the document changes; late pages belong to their original space. */
export function useNotebookNoteList(scope: number) {
  const [items, setItems] = useState<DesktopNoteListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const requestRef = useRef(0);
  const busyRef = useRef(false);
  const epochRef = useRef<number | undefined>(undefined);
  const cursorRef = useRef<string | null>(null);
  const lastReadResetRef = useRef(true);

  const read = useCallback(async (reset: boolean) => {
    if (busyRef.current || (!reset && !cursorRef.current)) return;
    const request = ++requestRef.current;
    lastReadResetRef.current = reset;
    busyRef.current = true;
    setLoading(true); setFailure(null);
    try {
      const session = await readAuthenticatedSession(epochRef);
      const page = unwrapGatewayResult(await window.astella.note.list({
        meta: createRequestMeta(session.workspaceEpoch), limit: 60, trashed: false,
        ...(!reset && cursorRef.current ? { cursor: cursorRef.current } : {}),
      }));
      if (request !== requestRef.current || scope !== useRoomStore.getState().workspaceScopeRevision) return;
      setItems(previous => {
        const merged = new Map((reset ? [] : previous).map(item => [item.id, item]));
        page.items.forEach(item => merged.set(item.id, item));
        return [...merged.values()];
      });
      setTotal(page.total);
      cursorRef.current = page.nextCursor;
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (request === requestRef.current && scope === useRoomStore.getState().workspaceScopeRevision) setFailure(gatewayErrorMessage(error));
    } finally {
      if (request === requestRef.current) { busyRef.current = false; setLoading(false); }
    }
  }, [scope]);

  useEffect(() => {
    void read(true);
    return () => { ++requestRef.current; busyRef.current = false; };
  }, [read]);
  return { items, total, nextCursor, loading, failure, reload: useCallback(() => read(true), [read]), loadMore: useCallback(() => read(false), [read]), retry: useCallback(() => read(lastReadResetRef.current), [read]) };
}
