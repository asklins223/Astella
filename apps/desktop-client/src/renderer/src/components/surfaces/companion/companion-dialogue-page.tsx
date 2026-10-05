import type { CompanionHistoryPageV1 } from "@ailearn/shared/companion-memory-desktop-contracts";
import { Send,Square } from "lucide-react";
import { useEffect,useRef,useState } from "react";
import { useCompanionChat } from "../../../app/companion-chat-session";
import { stopCompanionSpeech } from "../../../app/companion-voice-playback";
import { gatewayErrorMessage,unwrapGatewayResult } from "../../../app/desktop-client";
import { useRoomStore } from "../../../app/room-store";
import { shouldSendCompanionOnEnter } from "../../companion/companion-composer-key";
import { DialoguePanel } from "./companion-dialogue-panel";
import { useCompanionResource } from "./use-companion-resource";
import { useDialogueDiscoveryKeep } from "./use-dialogue-discovery-keep";

type HistoryRead = CompanionHistoryPageV1 & { search: string; anchorId: string | null };
export function CompanionDialoguePage({ refreshKey, focusMessageId, onFocusConsumed }: { refreshKey: number; focusMessageId: string | null; onFocusConsumed: () => void }) {
  const chat = useCompanionChat();
  const input = useRoomStore(state => state.companionComposerDraft);
  const setInput = useRoomStore(state => state.setCompanionComposerDraft);
  const motionOff = useRoomStore(state => state.reducedMotion || state.motionMode === "off");
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [anchorId, setAnchorId] = useState(focusMessageId);
  const [more, setMore] = useState<CompanionHistoryPageV1 | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const requestRef = useRef(0);
  const sendLock = useRef(false);
  const resource = useCompanionResource<HistoryRead>(async meta => {
    if (appliedQuery) {
      const result = await window.ailearn.companion.history.search({ meta, query: { q: appliedQuery, limit: 50 } });
      return result.ok ? { ...result, data: { version: 1, items: result.data.items, nextCursor: null, search: appliedQuery, anchorId } } : result;
    }
    const result = await window.ailearn.companion.history.list({ meta, query: { limit: 50, ...(anchorId ? { throughMessageId: anchorId } : {}) } });
    return result.ok ? { ...result, data: { ...result.data, search: "", anchorId } } : result;
  }, [appliedQuery, anchorId, refreshKey, chat.historyRevision]);
  useEffect(() => { setMore(null); requestRef.current += 1; setLoadingMore(false); }, [resource.section, appliedQuery, anchorId]);
  useEffect(() => { if (focusMessageId) { setAnchorId(focusMessageId); setAppliedQuery(""); setQuery(""); } }, [focusMessageId]);
  const loaded = resource.section?.ok && resource.section.value.search === appliedQuery && resource.section.value.anchorId === anchorId ? resource.section.value : null;
  const changingTarget = resource.section?.ok && !loaded;
  const items = more?.items ?? loaded?.items ?? [];
  const keep = useDialogueDiscoveryKeep(items, resource.meta);
  const proposalsRequested = useRef(new Set<string>());
  useEffect(() => {
    for (const item of items) for (const block of item.blocks) if (block.type === "action_ref" && !chat.proposalStates[block.proposalId] && !proposalsRequested.current.has(block.proposalId)) {
      proposalsRequested.current.add(block.proposalId); chat.retryProposal(block.proposalId);
    }
  }, [items, chat.proposalStates, chat.retryProposal]);
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
  const send = async () => {
    const text = input.trim(); if (!text || sendLock.current) return;
    sendLock.current = true;
    const scope = useRoomStore.getState().workspaceScopeRevision;
    setInput(""); setPreparing(true); setError(null);
    try {
      const selection = chat.feedSelection;
      const sent = await chat.send({ text, ...(selection ? { selection: { text: selection } } : {}), ...(chat.feedNoteAnchor ? { noteAnchor: chat.feedNoteAnchor } : {}) });
      if (sent) { chat.dismissFeedSelection(); setQuery(""); setAppliedQuery(""); setAnchorId(null); void resource.reload({ silent: true }); }
      else if (useRoomStore.getState().workspaceScopeRevision === scope) setInput(current => current || text);
    } catch (failure) { if (useRoomStore.getState().workspaceScopeRevision === scope) { setInput(current => current || text); setError(gatewayErrorMessage(failure)); } }
    finally { sendLock.current = false; setPreparing(false); }
  };
  const composer = <form className="cc-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
    {chat.feedDiaryAnchor ? <p className="cc-composer__reference">正在聊 {chat.feedDiaryAnchor.date} 的日记 · 第 {chat.feedDiaryAnchor.version} 版</p> : null}
    {chat.feedSelection ? <p className="cc-composer__reference">带入的原文：{chat.feedSelection.slice(0, 120)} <button type="button" className="cc-link" onClick={chat.dismissFeedSelection}>移除</button></p> : null}
    <textarea rows={2} value={input} maxLength={8000} onChange={event => setInput(event.currentTarget.value)} aria-label={`继续问 ${chat.companionName}`} placeholder="想说点什么？从这里接着聊…" onKeyDown={event => { if (shouldSendCompanionOnEnter(event)) { event.preventDefault(); void send(); } }} />
    <div><span>Enter 发送 · Shift + Enter 换行</span><button type="button" className="cc-link" onClick={() => chat.setMode("conversation")}>语音与轻聊</button>{chat.phase === "sending" ? <button type="button" className="cc-button" disabled={chat.cancelling} onClick={() => { stopCompanionSpeech(); void chat.cancel(); }}><Square size={13} />{chat.cancelling ? "正在停止…" : "停止"}</button> : null}<button type="submit" className="cc-button is-primary" disabled={!input.trim() || preparing}><Send size={16} />{preparing ? "正在发送…" : chat.phase === "sending" ? "发送并接替" : "发送"}</button></div>
    {chat.failure ? <p role="alert" className="cc-composer__error">{chat.failure}</p> : null}
  </form>;
  return <DialoguePanel section={changingTarget ? { ok: false, message: "" } : resource.section ?? { ok: false, message: resource.failure ?? "" }} initialLoading={Boolean(changingTarget || (!resource.section && resource.loading))} historyKey={`${appliedQuery}:${anchorId ?? "latest"}`} items={changingTarget ? [] : items} cursor={cursor} query={query} appliedQuery={appliedQuery} searching={resource.loading || Boolean(changingTarget)} loadingMore={loadingMore} error={error}
    onLatest={anchorId || appliedQuery ? () => { setAnchorId(null); setQuery(""); setAppliedQuery(""); setError(null); } : undefined}
    onQuery={value => { setQuery(value); if (!value.trim()) setAppliedQuery(""); }} onSearch={() => { setError(null); setAnchorId(null); if (appliedQuery === query.trim()) void resource.reload(); else setAppliedQuery(query.trim()); }} onLoadMore={() => void loadMore()} onContinue={() => chat.setMode("conversation")} onRetry={() => void resource.reload()} chat={chat} composer={composer} keep={keep} />;
}
