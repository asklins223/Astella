import type { CompanionHistoryPageV1 } from "@ailearn/shared/companion-memory-desktop-contracts";
import { useEffect,useLayoutEffect,useRef,useState } from "react";
import { gatewayErrorMessage,unwrapGatewayResult } from "../../../app/desktop-client";
import { useRoomStore } from "../../../app/room-store";
import { COMPANION_HISTORY_CHANGED } from "../../companion/companion-events";
import { dialogueDiscoveryRequest } from "./companion-discovery-targets";
import { DialoguePanel } from "./companion-dialogue-panel";
import { useCompanionResource } from "./use-companion-resource";
import { useDiscoveryBookmarks } from "./use-discovery-bookmarks";

type HistoryRead = CompanionHistoryPageV1 & { search: string; anchorId: string | null };
export function CompanionDialoguePage({ refreshKey, focusMessageId, onFocusConsumed, companionName }: { refreshKey: number; focusMessageId: string | null; onFocusConsumed: () => void; companionName?: string }) {
  const motionOff = useRoomStore(state => state.reducedMotion || state.motionMode === "off");
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [anchorId, setAnchorId] = useState(focusMessageId);
  const [more, setMore] = useState<CompanionHistoryPageV1 | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const resource = useCompanionResource<HistoryRead>(async meta => {
    if (appliedQuery) {
      const result = await window.ailearn.companion.history.search({ meta, query: { q: appliedQuery, limit: 50 } });
      return result.ok ? { ...result, data: { version: 1, items: result.data.items, nextCursor: null, search: appliedQuery, anchorId } } : result;
    }
    const result = await window.ailearn.companion.history.list({ meta, query: { limit: 50, ...(anchorId ? { throughMessageId: anchorId } : {}) } });
    return result.ok ? { ...result, data: { ...result.data, search: "", anchorId } } : result;
  }, [appliedQuery, anchorId, refreshKey]);
  useEffect(() => {
    const refresh = () => { void resource.reload(); };
    window.addEventListener(COMPANION_HISTORY_CHANGED, refresh);
    return () => window.removeEventListener(COMPANION_HISTORY_CHANGED, refresh);
  }, [resource.reload]);
  // Reset pagination before newly read records become interactive; a quick
  // "load earlier" click must not be invalidated by the previous read's effect.
  useLayoutEffect(() => { setMore(null); requestRef.current += 1; setLoadingMore(false); }, [resource.section, appliedQuery, anchorId]);
  useEffect(() => { if (focusMessageId) { setAnchorId(focusMessageId); setAppliedQuery(""); setQuery(""); } }, [focusMessageId]);
  const loaded = resource.section?.ok && resource.section.value.search === appliedQuery && resource.section.value.anchorId === anchorId ? resource.section.value : null;
  const changingTarget = resource.section?.ok && !loaded;
  const items = more?.items ?? loaded?.items ?? [];
  const bookmarks = useDiscoveryBookmarks(refreshKey);
  useEffect(() => {
    if (!focusMessageId || resource.loading || !loaded) return;
    const element = document.getElementById(`companion-message-${focusMessageId}`);
    if (element) { element.scrollIntoView({ block: "center", behavior: motionOff ? "auto" : "smooth" }); element.focus({ preventScroll: true }); onFocusConsumed(); }
    else if (!resource.loading) { setError("这条对话记录已不存在。"); onFocusConsumed(); }
  }, [focusMessageId, items, loaded, resource.loading, motionOff, onFocusConsumed]);
  const cursor = loaded ? (more ? more.nextCursor : loaded.nextCursor) : null;
  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    const request = ++requestRef.current; setLoadingMore(true); setError(null);
    try {
      const page = unwrapGatewayResult(await window.ailearn.companion.history.list({ meta: resource.meta(), query: { before: cursor, limit: 50 } }));
      if (request !== requestRef.current) return;
      const ids = new Set(items.map(item => item.messageId));
      setMore({ ...page, items: [...page.items.filter(item => !ids.has(item.messageId)), ...items] });
    } catch (failure) { if (request === requestRef.current) setError(gatewayErrorMessage(failure)); }
    finally { if (request === requestRef.current) setLoadingMore(false); }
  };
  return <DialoguePanel section={changingTarget ? { ok: false, message: "" } : resource.section ?? { ok: false, message: resource.failure ?? "" }} initialLoading={Boolean(changingTarget || (!resource.section && resource.loading))} historyKey={`${appliedQuery}:${anchorId ?? "latest"}`} items={changingTarget ? [] : items} cursor={cursor} query={query} appliedQuery={appliedQuery} searching={resource.loading || Boolean(changingTarget)} loadingMore={loadingMore} error={error}
    onLatest={anchorId || appliedQuery ? () => { setAnchorId(null); setQuery(""); setAppliedQuery(""); setError(null); } : undefined}
    onQuery={value => { setQuery(value); if (!value.trim()) setAppliedQuery(""); }} onSearch={() => { setError(null); setAnchorId(null); if (appliedQuery === query.trim()) void resource.reload(); else setAppliedQuery(query.trim()); }} onLoadMore={() => void loadMore()} onRetry={() => void resource.reload()} companionName={companionName} discoveryFor={item => { const request = dialogueDiscoveryRequest(item); return request ? bookmarks.forRequest(request) : null; }} />;
}
