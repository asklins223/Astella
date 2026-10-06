import { Bell, Check, ChevronLeft, ChevronRight, Clock3, Download, ExternalLink, Loader2, MessageCircle, Minimize2, Sparkles, Square, Volume2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CompanionAccountStateV1 } from "@astella/shared/companion-shell-contracts";
import { isWithinQuietHours } from "@astella/shared/companion-proactive-policy";
import { gatewayErrorMessage } from "../../app/desktop-client";
import { useRoomStore } from "../../app/room-store";
import { isCompanionSpeechActive, subscribeCompanionSpeechActivity } from "../../app/companion-voice-playback";
import { useTactileSurface } from "../motion/use-tactile-surface";
import { useCompanionNotificationSources } from "./use-companion-notification-sources";
import { notificationKey, nextCompanionNotification, useCompanionNotifications, type CompanionNotification, type CompanionNotificationAction } from "./companion-notifications";
import { isCompanionMicrophoneActive, speakCompanionNotification, stopCompanionNotificationSpeech, subscribeCompanionAudioPriority, type NotificationVoicePhase } from "./companion-notification-voice";
import { placeCompanionNotification } from "./notification-placement";
import { companionLayoutBounds } from "./companion-visible-bounds";

const ICONS = { model: Download, task: Sparkles, review: Clock3, reminder: Bell, help: MessageCircle };

/** A parallel message channel. It never opens a chat turn or borrows its reply bubble. */
export function CompanionNotificationCenter(props: {
  readonly replyBusy: boolean;
  readonly blocked: boolean;
  readonly muted: boolean;
  readonly passiveMuted: boolean;
  readonly quietHours?: CompanionAccountStateV1["quietHours"];
}) {
  useCompanionNotificationSources();
  const items = useCompanionNotifications(state => state.items);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [deliveryRevision, setDeliveryRevision] = useState(0);
  const [speechBusy, setSpeechBusy] = useState(isCompanionSpeechActive);
  const [microphoneBusy, setMicrophoneBusy] = useState(isCompanionMicrophoneActive);
  const [voicePhase, setVoicePhase] = useState<NotificationVoicePhase>("silent");
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now);
  const quiet = Boolean(props.quietHours && isWithinQuietHours(props.quietHours, new Date(clock)));
  const rootRef = useRef<HTMLDivElement>(null);
  const badgeRef = useRef<HTMLButtonElement>(null);
  const seen = useRef(new Set<string>());
  const autoVoice = useRef<string | null>(null);
  const actionLock = useRef<string | null>(null);
  const selected = items.find(item => item.id === selectedId) ?? null;
  const key = selected ? notificationKey(selected) : null;
  const busy = props.replyBusy || speechBusy || microphoneBusy;
  const latest = useRef({ props, busy, key, selected, quiet }); latest.current = { props, busy, key, selected, quiet };
  const unread = items.filter(item => item.state === "unread");
  useTactileSurface(rootRef, inboxOpen ? "inbox" : key ?? "closed");
  useEffect(() => {
    if (!props.quietHours) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [props.quietHours]);

  useEffect(() => {
    const stopSpeech = subscribeCompanionSpeechActivity(() => setSpeechBusy(isCompanionSpeechActive()));
    const stopPriority = subscribeCompanionAudioPriority(() => setMicrophoneBusy(isCompanionMicrophoneActive()));
    return () => { stopSpeech(); stopPriority(); };
  }, []);

  const show = useCallback((notice: CompanionNotification, automatic = false) => {
    const nextKey = notificationKey(notice);
    seen.current.add(nextKey);
    autoVoice.current = automatic ? nextKey : null;
    setVoicePhase("silent"); setError(null); setSelectedId(notice.id); setInboxOpen(false);
    setDeliveryRevision(value => value + 1);
    if (notice.state === "unread") void Promise.resolve().then(notice.onShown).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (selectedId && !selected) setSelectedId(null);
    if (props.blocked || inboxOpen || actionLock.current) return;
    // An explicitly scheduled reminder still arrives during quiet hours.
    const eligible = quiet ? items.filter(item => item.kind === "reminder" || item.delivery === "immediate") : items;
    const next = nextCompanionNotification(eligible, seen.current, busy || props.passiveMuted);
    if (!next) return;
    if (selected && next.delivery !== "immediate") return;
    // Background delivery leaves a little space after the reply ends. Direct guidance is immediate.
    const timer = window.setTimeout(() => show(next, true), next.delivery === "immediate" ? 0 : 650);
    return () => window.clearTimeout(timer);
  }, [items, busy, props.blocked, props.passiveMuted, quiet, selected, selectedId, inboxOpen, show]);

  const narrate = useCallback((notice: CompanionNotification) => {
    if (!notice.audio) return;
    const speechKey = notificationKey(notice);
    void speakCompanionNotification({
      id: speechKey, ...notice.audio,
      allowed: () => {
        const state = latest.current;
        return state.key === speechKey && !state.props.blocked && !state.props.muted && !state.busy
          && (!state.props.passiveMuted || notice.delivery === "immediate")
          && (!state.quiet || notice.kind === "reminder" || notice.delivery === "immediate");
      },
      report: phase => { if (latest.current.key === speechKey) setVoicePhase(phase); },
    });
  }, []);
  useEffect(() => {
    if (!selected || !key) return;
    setError(null);
    if (autoVoice.current === key) { autoVoice.current = null; narrate(selected); }
    return () => stopCompanionNotificationSpeech(key);
  }, [key, deliveryRevision, narrate]);
  useEffect(() => {
    if (busy || props.blocked || props.muted || props.passiveMuted && selected?.delivery !== "immediate"
      || quiet && selected?.kind !== "reminder" && selected?.delivery !== "immediate") stopCompanionNotificationSpeech();
  }, [busy, props.blocked, props.muted, props.passiveMuted, quiet, selected?.kind, selected?.delivery]);

  const collapse = () => {
    if (actionLock.current) return;
    stopCompanionNotificationSpeech(); setSelectedId(null); setInboxOpen(false);
    badgeRef.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    // A user-opened companion surface takes attention; the notice stays in the inbox.
    if (props.blocked && !actionLock.current) { stopCompanionNotificationSpeech(); setSelectedId(null); setInboxOpen(false); }
  }, [props.blocked]);
  const dismiss = (notice: CompanionNotification) => {
    useCompanionNotifications.getState().dismiss(notice.id);
    void Promise.resolve().then(notice.onDismiss).catch(() => undefined);
    collapse();
  };
  const perform = async (notice: CompanionNotification, action: CompanionNotificationAction) => {
    if (actionLock.current || notice.expiresAt !== undefined && notice.expiresAt <= Date.now()) return;
    const operation = notificationKey(notice);
    if (!useCompanionNotifications.getState().items.some(item => notificationKey(item) === operation)
      || notice.scope !== "device" && notice.scope !== useRoomStore.getState().workspaceScopeRevision) return;
    actionLock.current = operation; setActionBusy(action.id); setError(null);
    stopCompanionNotificationSpeech(operation);
    try {
      const result = await action.run?.();
      const current = useCompanionNotifications.getState().items.find(item => notificationKey(item) === operation);
      if (current && result !== false) {
        useCompanionNotifications.getState().dismiss(notice.id);
        if (action.kind === "cancel") void Promise.resolve().then(notice.onDismiss).catch(() => undefined);
        if (latest.current.key === operation) setSelectedId(null);
      }
    } catch (failure) {
      if (latest.current.key === operation) setError(`这次操作没有完成：${gatewayErrorMessage(failure)}。可以重试。`);
    } finally {
      actionLock.current = null; setActionBusy(null);
      // Navigation owns its destination focus. Confirmation stays with the notification inbox.
      if (action.kind !== "navigate" && document.activeElement === document.body) badgeRef.current?.focus({ preventScroll: true });
    }
  };

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const position = () => {
      const paper = root.getBoundingClientRect();
      const character = document.querySelector<HTMLElement>('.companion-presence:not([aria-hidden="true"]):not([data-companion-unavailable="true"]) .window-live2d');
      const bounds = character?.getClientRects().length ? companionLayoutBounds(character) : null;
      const companion = bounds ? { left: bounds.left, top: bounds.top, width: bounds.right-bounds.left, height: bounds.bottom-bounds.top } : null;
      const obstacles = [...document.querySelectorAll<HTMLElement>('.companion-hud--floating .companion-hud__panel, .companion-hud--floating .companion-hud__reply, .companion-hud--floating .companion-hud__output, .companion-hud__controls, .companion-goal-tab')]
        .filter(node => node.getClientRects().length && !node.closest('[hidden], [inert], [aria-hidden="true"]')).map(node => node.getBoundingClientRect());
      const next = placeCompanionNotification({ viewport: { width: window.innerWidth, height: window.innerHeight }, paper, companion, obstacles, compact: !key && !inboxOpen });
      root.style.left = `${Math.round(next.left)}px`; root.style.top = `${Math.round(next.top)}px`; root.dataset.side = next.side;
    };
    position();
    const observer = new ResizeObserver(position); observer.observe(root);
    window.addEventListener("resize", position);
    const timer = window.setInterval(position, 160);
    return () => { observer.disconnect(); window.removeEventListener("resize", position); window.clearInterval(timer); };
  }, [items.length > 0, key, inboxOpen, props.blocked]);

  if (!items.length) return null;
  const Icon = selected ? ICONS[selected.kind] : Bell;
  const speaking = voicePhase === "speaking" || voicePhase === "preparing";
  const silent = props.muted || selected?.delivery !== "immediate" && (props.passiveMuted || quiet && selected?.kind !== "reminder");
  const soundNote = voicePhase === "preparing" ? "正在准备播报…" : voicePhase === "speaking" ? "正在轻声提醒你"
    : busy ? microphoneBusy ? "正在录音，本条安静送达" : "伴星正在回复，本条安静送达"
      : silent ? "安静送达" : voicePhase === "consent_required" ? "语音需要先确认 AI 数据同意，消息已送达" : voicePhase === "failed" ? "声音暂时不可用，消息已送达" : "消息已送达";
  return createPortal(<div ref={rootRef} className="companion-notifications" data-companion-owned="true" data-collapsed={!selected && !inboxOpen || undefined} hidden={props.blocked} onKeyDown={event => {
    if (event.key === "Escape" && (selected || inboxOpen)) { event.preventDefault(); event.stopPropagation(); collapse(); }
  }}>
    {selected && !inboxOpen ? <section className="companion-notification-paper" data-tactile-page data-kind={selected.kind} aria-label={`伴星通知：${selected.title}`}>
      <header className="companion-notification-paper__header">
        <span className="companion-notification-paper__seal"><Icon size={17} aria-hidden="true" /></span>
        <span>{selected.source ?? "伴星通知"}</span>
        <button type="button" aria-label="收起通知，稍后查看" disabled={Boolean(actionBusy)} onClick={collapse}><Minimize2 size={15} /></button>
        <button type="button" aria-label="关闭这条通知" disabled={Boolean(actionBusy)} onClick={() => dismiss(selected)}><X size={16} /></button>
      </header>
      <div className="companion-notification-paper__content" role="status" aria-live="polite" aria-atomic="true">
        <h2>{selected.title}</h2><p>{selected.body}</p>
      </div>
      {selected.progress ? <div className="companion-notification-paper__progress">
        <span>{selected.progress.label}<b>{selected.progress.percent}%</b></span>
        <progress max={100} value={selected.progress.percent} aria-label="语音模型下载进度" />
      </div> : null}
      {error ? <p className="companion-notification-paper__error" role="alert">{error}</p> : null}
      {selected.actions?.length ? <div className="companion-notification-paper__actions">
        {selected.actions.map(action => <button key={action.id} type="button" data-kind={action.kind} disabled={Boolean(actionBusy)} onClick={() => void perform(selected, action)}>
          {actionBusy === action.id ? <Loader2 size={14} aria-hidden="true" /> : action.kind === "navigate" ? <ExternalLink size={14} aria-hidden="true" /> : action.kind === "confirm" ? <Check size={14} aria-hidden="true" /> : null}{action.label}
        </button>)}
      </div> : null}
      <footer className="companion-notification-paper__footer">
        {selected.audio ? <button type="button" className="companion-notification-paper__voice" aria-label={speaking ? "停止通知播报" : "朗读这条通知"} disabled={!speaking && (busy || silent || Boolean(actionBusy))} onClick={() => speaking ? stopCompanionNotificationSpeech(key!) : narrate(selected)}>
          {speaking ? <Square size={13} aria-hidden="true" /> : <Volume2 size={14} aria-hidden="true" />}<span>{soundNote}</span>
        </button> : <span>{soundNote}</span>}
        {selected.snoozable ? <button type="button" disabled={Boolean(actionBusy)} onClick={() => {
          useCompanionNotifications.getState().snooze(selected.id); void Promise.resolve().then(selected.onSnooze).catch(() => undefined); collapse();
        }}><Clock3 size={13} aria-hidden="true" />10 分钟后</button> : null}
      </footer>
    </section> : null}
    {inboxOpen ? <section className="companion-notification-inbox companion-notification-paper" data-tactile-page aria-label="伴星通知列表">
      <header className="companion-notification-paper__header"><Bell size={17} aria-hidden="true" /><strong>伴星捎来的消息</strong><button type="button" aria-label="收起通知列表" onClick={collapse}><X size={16} /></button></header>
      <div className="companion-notification-inbox__list">{[...items].reverse().map(notice => <button type="button" key={notice.id} data-unread={notice.state === "unread" || undefined} onClick={() => show(notice)}>
        <span><strong>{notice.title}</strong><small>{notice.state === "snoozed" ? "稍后再提醒" : notice.state === "read" ? "已收下" : "待查看"} · {notice.source ?? "伴星通知"}</small></span><ChevronRight size={15} aria-hidden="true" />
      </button>)}</div>
    </section> : null}
    <div className="companion-notifications__rail">
      <button ref={badgeRef} type="button" className="companion-notifications__badge" disabled={Boolean(actionBusy)} aria-expanded={inboxOpen} aria-label={`查看伴星通知${unread.length ? `，${unread.length} 条待查看` : ""}`} onClick={() => { stopCompanionNotificationSpeech(); setSelectedId(null); setInboxOpen(value => !value); }}>
        <Bell size={14} aria-hidden="true" />通知{unread.length ? <b>{unread.length}</b> : null}
      </button>
      {selected && unread.length > 1 ? <button type="button" className="companion-notifications__next" disabled={Boolean(actionBusy)} onClick={() => {
        const index = unread.findIndex(notice => notice.id === selected.id); show(unread[(index + 1) % unread.length]);
      }}><ChevronLeft size={13} aria-hidden="true" />还有 {unread.filter(notice => notice.id !== selected.id).length} 条</button> : null}
    </div>
  </div>, document.body);
}
