import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopSearchItem, DesktopSearchPage } from "@ailearn/shared/desktop-surface-contracts";
import { useRoomStore } from "../../../app/room-store";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../app/desktop-client";
import { readAuthenticatedSession } from "../../../app/surface-session";
import { objectKey, PAGE_SIZE, readSearchContent, type SearchContent, type SearchPreview } from "./search-presenter";

const WEAK_STATES = new Set(["unvalidated", "fragile", "needs_repair"]);

/** Results belong to a settled query; editing instantly invalidates their actions. */
export function useSearchDesk(composing = false) {
  const query = useRoomStore(state => state.searchQuery);
  const type = useRoomStore(state => state.searchTypeFilter);
  const weakOnly = useRoomStore(state => state.searchWeakOnly);
  const scope = useRoomStore(state => state.workspaceScopeRevision);
  const filter = weakOnly ? "objective" : type;
  const value = query.trim();
  const identity = JSON.stringify([scope, value, filter, weakOnly]);
  const currentIdentity = useRef(identity); currentIdentity.current = identity;
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionFailure, setSessionFailure] = useState<string | null>(null);
  const [sessionTick, setSessionTick] = useState(0);
  const epoch = useRef<number | undefined>(undefined);
  const sequence = useRef(0);
  const active = useRef(true);
  const [page, setPage] = useState<DesktopSearchPage & { identity: string } | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchFailure, setSearchFailure] = useState<string | null>(null);
  const paging = useRef(false);
  const searchTimer = useRef<number | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<SearchPreview | null>(null);
  const [previewTick, setPreviewTick] = useState(0);
  const [openingRequest, setOpeningRequest] = useState<{ key: string; identity: string } | null>(null);
  const opening = useRef<{ key: string; identity: string } | null>(null);
  const [openFailure, setOpenFailure] = useState<string | null>(null);
  const cache = useRef(new Map<string, SearchContent>());
  const reads = useRef(new Map<string, Promise<SearchContent>>());
  const resume = useRef(useRoomStore.getState().searchResume);
  const [restoring, setRestoring] = useState(Boolean(resume.current?.identity === identity));
  const [weakState, setWeakState] = useState<{ identity: string; count: number; keys: Set<string>; failure: string | null } | null>(null);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; sequence.current += 1; };
  }, []);

  useEffect(() => {
    let alive = true;
    cache.current.clear(); reads.current.clear();
    setSessionReady(false); setSessionFailure(null);
    void readAuthenticatedSession(epoch).then(() => { if (alive) setSessionReady(true); })
      .catch(error => { if (alive) setSessionFailure(gatewayErrorMessage(error)); });
    return () => { alive = false; sequence.current += 1; };
  }, [scope, sessionTick]);

  const readContent = useCallback((item: DesktopSearchItem, force = false) => {
    const key = objectKey(item);
    if (force) { cache.current.delete(key); reads.current.delete(key); }
    const saved = cache.current.get(key);
    if (saved) return Promise.resolve(saved);
    const pending = reads.current.get(key);
    if (pending) return pending;
    const requestScope = useRoomStore.getState().workspaceScopeRevision;
    const request = readSearchContent(item, epoch.current).then(content => {
      if (active.current && requestScope === useRoomStore.getState().workspaceScopeRevision) cache.current.set(key, content);
      return content;
    }).finally(() => { if (reads.current.get(key) === request) reads.current.delete(key); });
    reads.current.set(key, request);
    return request;
  }, []);

  const runSearch = useCallback(async (cursor?: string) => {
    if (!value || !sessionReady || composing || paging.current) return;
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    searchTimer.current = null;
    const seq = ++sequence.current;
    const requestedIdentity = identity;
    paging.current = true;
    setSearching(true); setSearchFailure(null);
    try {
      const response = await window.ailearn.search.global({
        meta: createRequestMeta(epoch.current), query: value, limit: PAGE_SIZE,
        ...(filter === "all" ? {} : { type: filter }), ...(cursor ? { cursor } : {}),
      });
      if (!active.current || seq !== sequence.current || currentIdentity.current !== requestedIdentity) return;
      const next = unwrapGatewayResult(response);
      if (cursor && next.nextCursor === cursor) {
        setSearchFailure("这一页的位置没有更新，请重新搜索。"); setRestoring(false); return;
      }
      setPage(current => {
        if (!cursor || current?.identity !== requestedIdentity) return { ...next, identity: requestedIdentity };
        const seen = new Set(current.items.map(objectKey));
        return { ...next, identity: requestedIdentity, items: [...current.items, ...next.items.filter(item => !seen.has(objectKey(item)))] };
      });
    } catch (error) {
      if (active.current && seq === sequence.current && currentIdentity.current === requestedIdentity) {
        setSearchFailure(gatewayErrorMessage(error)); setRestoring(false);
      }
    } finally {
      if (seq === sequence.current) { paging.current = false; setSearching(false); }
    }
  }, [value, filter, identity, sessionReady, composing]);

  useEffect(() => {
    sequence.current += 1; paging.current = false;
    setPage(null); setSearchFailure(null); setPreview(null); setOpenFailure(null); setWeakState(null);
    const saved = useRoomStore.getState().searchResume;
    resume.current = saved?.identity === identity ? saved : null;
    setSelectedKey(resume.current?.selectedKey ?? null);
    setRestoring(Boolean(resume.current));
    setSearching(Boolean(value && sessionReady));
    if (!value || !sessionReady || composing) return;
    searchTimer.current = window.setTimeout(() => { void runSearch(); }, 160);
    return () => { if (searchTimer.current !== null) window.clearTimeout(searchTimer.current); searchTimer.current = null; sequence.current += 1; paging.current = false; };
  }, [identity, runSearch, value, sessionReady, composing]);

  const currentPage = page?.identity === identity ? page : null;
  const items = currentPage?.items ?? [];
  const total = currentPage?.total ?? 0;
  const nextCursor = currentPage?.nextCursor ?? null;

  // Re-read to the saved depth, keeping only a position in the room store.
  useEffect(() => {
    if (!restoring || !currentPage || searching || searchFailure) return;
    if (items.length < (resume.current?.loadedCount ?? 0) && nextCursor) { void runSearch(nextCursor); return; }
    setRestoring(false);
  }, [restoring, currentPage, items.length, nextCursor, searching, searchFailure, runSearch]);

  // Check the actual matching cards, with four concurrent reads. There is no
  // unrelated "latest 100" sample that can silently hide an older weak card.
  useEffect(() => {
    if (!weakOnly || !currentPage) return;
    let alive = true;
    const requestedIdentity = identity;
    const objectives = items.filter(item => item.objectType === "objective");
    let cursor = 0;
    const keys = new Set<string>();
    const check = async () => {
      while (cursor < objectives.length && alive && currentIdentity.current === requestedIdentity) {
        const item = objectives[cursor++];
        const content = await readContent(item);
        if (content.kind === "objective" && WEAK_STATES.has(content.detail.personalState.state)) keys.add(objectKey(item));
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, objectives.length) }, check))
      .then(() => { if (alive) setWeakState({ identity, count: items.length, keys, failure: null }); })
      .catch(error => { if (alive) { alive = false; setWeakState({ identity, count: items.length, keys: new Set(), failure: gatewayErrorMessage(error) }); } });
    return () => { alive = false; };
  }, [weakOnly, currentPage, identity, readContent, previewTick]);

  const filterBusy = Boolean(weakOnly && currentPage && (weakState?.identity !== identity || weakState.count !== items.length));
  const filterFailure = weakOnly && weakState?.identity === identity ? weakState.failure : null;
  const visible = useMemo(() => {
    if (!currentPage) return [];
    if (!weakOnly) return currentPage.items;
    if (!weakState || weakState.identity !== identity || weakState.failure) return [];
    return currentPage.items.filter(item => weakState.keys.has(objectKey(item)));
  }, [currentPage, weakOnly, weakState, identity]);

  useEffect(() => {
    if (restoring || filterBusy) return;
    setSelectedKey(current => current && visible.some(item => objectKey(item) === current) ? current : visible[0] ? objectKey(visible[0]) : null);
  }, [visible, restoring, filterBusy]);
  const selected = visible.find(item => objectKey(item) === selectedKey) ?? null;
  const currentSelection = useRef(selectedKey); currentSelection.current = selectedKey;

  useEffect(() => {
    let alive = true;
    setOpenFailure(null);
    if (!selected) { setPreview(null); return; }
    const key = objectKey(selected);
    setPreview(cache.current.get(key) ?? { kind: "loading", key });
    void readContent(selected).then(content => { if (alive) setPreview(content); })
      .catch(error => { if (alive) setPreview({ kind: "error", key, message: gatewayErrorMessage(error) }); });
    return () => { alive = false; };
  }, [selected, readContent, previewTick]);

  const retryPreview = () => {
    if (selected) { cache.current.delete(objectKey(selected)); reads.current.delete(objectKey(selected)); }
    setPreviewTick(tick => tick + 1);
  };
  const openItem = async (item: DesktopSearchItem) => {
    if (opening.current?.identity === identity && opening.current.key === selectedKey || !currentPage || currentIdentity.current !== currentPage.identity) return;
    const key = objectKey(item), requestedIdentity = identity, requestScope = scope;
    const request = { key, identity };
    opening.current = request; setOpeningRequest(request); setOpenFailure(null);
    try {
      const store = useRoomStore.getState();
      const returnTo = { label: "返回搜索", run: () => useRoomStore.getState().invoke("search") };
      if (item.objectType === "note") {
        const content = await readContent(item);
        if (!active.current || opening.current !== request || currentSelection.current !== key || currentIdentity.current !== requestedIdentity || useRoomStore.getState().workspaceScopeRevision !== requestScope) return;
        if (content.kind !== "note" || !content.detail.currentVersionId) {
          setOpenFailure("这篇笔记暂时没有可打开的正文版本。"); return;
        }
        store.setNoteReturnTo("search");
        store.setActiveNoteRef({ noteId: content.detail.noteId, noteVersionId: content.detail.currentVersionId });
        store.invoke("open-notebook", { returnTo });
      } else if (item.objectType === "source") {
        store.setActiveSourceId(item.objectId); store.invoke("open-source", { returnTo });
      } else {
        store.setActiveObjectiveId(item.objectId); store.invoke("open-objective", { returnTo });
      }
    } catch (error) {
      if (active.current && opening.current === request && currentSelection.current === key && currentIdentity.current === requestedIdentity) setOpenFailure(gatewayErrorMessage(error));
    } finally {
      if (opening.current === request) { opening.current = null; if (active.current) setOpeningRequest(null); }
    }
  };

  return {
    query, value, filter, weakOnly, identity, sessionReady, sessionFailure,
    items, total, nextCursor, visible, selected, selectedKey, setSelectedKey,
    searching: Boolean(value && sessionReady && (!currentPage && !searchFailure || searching)),
    restoring, filterBusy, filterFailure, searchFailure, preview: preview?.key === selectedKey ? preview : null,
    openingKey: openingRequest?.identity === identity && openingRequest.key === selectedKey ? openingRequest.key : null,
    openFailure, runSearch, openItem, retryPreview,
    retryFilter: () => { cache.current.clear(); setPreviewTick(tick => tick + 1); },
    retry: () => setSessionTick(tick => tick + 1),
    settled: Boolean(currentPage && !searching && !restoring && !filterBusy),
    resume: resume.current,
  };
}
