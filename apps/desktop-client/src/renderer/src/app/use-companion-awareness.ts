import { useEffect, useRef } from "react";
import type { CompanionAwarenessContextV1, CompanionAwarenessObservationV1 } from "@astella/shared/companion-initiative-contracts";
import { useCompanionPageContext } from "./companion-chat-session-page";
import { useRoomStore } from "./room-store";
import { createRequestMeta, requireWorkspaceEpoch, unwrapGatewayResult } from "./desktop-client";
import { HUD_PAGES } from "../components/hud/hud-pages";
import { stopCompanionNotificationSpeech } from "../components/companion/companion-notification-voice";
import { isCompanionSpeechActive, subscribeCompanionSpeechActivity } from "./companion-voice-playback";
import { companionAwarenessPageState } from "./companion-awareness-page";

/** Real lifecycle and semantic arrivals. Heartbeats renew factual leases; they never call a model. */
export function useCompanionAwareness(conversationId: string | null) {
  const page = useCompanionPageContext();
  const latest = useRef({ page, conversationId }); latest.current = { page, conversationId };
  const pageKey = [page.hudPage, page.activeNoteId, page.activeSourceId, page.activeRunId,
    page.activeReviewScheduleId, page.settingsSection].filter(Boolean).join(":");
  const pageState = companionAwarenessPageState(page);
  const participationBlocked = useRoomStore(state => state.onboardingOpen || state.companionGuideOpen);
  const publishRef = useRef<((topic: CompanionAwarenessObservationV1["topic"], evidence?: CompanionAwarenessObservationV1["evidence"]) => Promise<void>) | null>(null);
  useEffect(() => {
    const api = window.astella?.companion?.initiative;
    if (!api) return;
    let closed = false, started = false, typingUntil = 0, lastInputAt = -Infinity, lastAt = performance.now();
    let identity: { version: 1; appLaunchId: string; deviceSessionId: string; host: "desktop" | "browser" } | undefined;
    let sequence = Promise.resolve();
    const context = (): CompanionAwarenessContextV1 => {
      const { page: p, conversationId: currentConversation } = latest.current;
      const currentPage = companionAwarenessPageState(p);
      const room = useRoomStore.getState();
      const foreground = document.visibilityState === "visible" && document.hasFocus() && room.windowState === "visible";
      const learning = ["note-read", "note-edit", "note-learning"].includes(p.hudPage)
        ? Boolean(p.activeNoteId && p.activeNoteVersionId)
        : ["assessment", "result"].includes(p.hudPage) ? Boolean(p.activeRunId) : p.hudPage === "queue";
      const currentPageKey = [p.hudPage, p.activeNoteId, p.activeSourceId, p.activeRunId, p.activeReviewScheduleId, p.settingsSection].filter(Boolean).join(":");
      return { foreground, unlocked: true, typing: performance.now() < typingUntil, learning, speaking:isCompanionSpeechActive(),
        participationAllowed: !room.onboardingOpen && !room.companionGuideOpen
          && !room.mutedCompanionSceneKeys.includes(room.surface ?? "room") && !room.companionFocusUntilTaskEnd,
        conversationId: currentConversation, page: { key: currentPageKey, label: HUD_PAGES[p.hudPage].title,
          revision: currentPage.revision,
          context: p.activeNoteId && ["note-read", "note-edit", "note-learning"].includes(p.hudPage)
            ? { version: 1, context: { pageKind: "note", sharing: "page_registered", noteId: p.activeNoteId, ...(p.activeNoteVersionId ? { noteVersionId: p.activeNoteVersionId } : {}) } }
            : null } };
    };
    const publish = (topic: CompanionAwarenessObservationV1["topic"], evidence?: CompanionAwarenessObservationV1["evidence"]) => {
      sequence = sequence.then(async () => {
        if (closed) return;
        try {
          const epoch = await requireWorkspaceEpoch();
          if (!identity) identity = unwrapGatewayResult(await api.identity({ meta: createRequestMeta(epoch) }));
          if (closed || latest.current.page.workspaceScopeRevision !== page.workspaceScopeRevision) return;
          const now = performance.now();
          const currentContext = context();
          const request = { ...identity, id: crypto.randomUUID(), topic, occurredAt: new Date().toISOString(),
            elapsedMs: Math.min(45_000, Math.max(0, Math.round(now - lastAt))), context: currentContext, ...(evidence ? { evidence } : {}) };
          lastAt = now;
          unwrapGatewayResult(await api.observe({ meta: createRequestMeta(epoch), request }));
          if (!started && currentContext.foreground && currentContext.participationAllowed) {
            unwrapGatewayResult(await api.observe({ meta: createRequestMeta(epoch), request: { ...request, id: crypto.randomUUID(), topic: "app.started", elapsedMs: 0 } }));
            started = true;
          }
        } catch { /* Offline observations earn no study time; the next real lease tries again. */ }
      });
      return sequence;
    };
    publishRef.current = publish;
    const foreground = () => { void publish(document.hasFocus() && document.visibilityState === "visible" ? "app.foreground" : "context.updated"); };
    const typing = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".companion-hud, .companion-interaction, .companion-history, [data-companion-composer]")) return;
      typingUntil = performance.now() + 6_000;
      stopCompanionNotificationSpeech();
      window.dispatchEvent(new Event("astella:companion-user-input"));
      if (performance.now() - lastInputAt > 1_000) { lastInputAt = performance.now(); void publish("context.updated"); }
    };
    const help = (event: Event) => { const detail = (event as CustomEvent<CompanionAwarenessObservationV1["evidence"]>).detail; if (detail) void publish("help.available", detail); };
    const result = (event: Event) => { const detail = (event as CustomEvent<CompanionAwarenessObservationV1["evidence"]>).detail; if (detail) void publish("result.available", detail); };
    const timer = window.setInterval(() => void publish("context.updated"), 15_000);
    const stopSpeechWatch = subscribeCompanionSpeechActivity(() => void publish("context.updated"));
    window.addEventListener("focus", foreground); window.addEventListener("blur", foreground);
    document.addEventListener("visibilitychange", foreground); document.addEventListener("input", typing, true);
    window.addEventListener("astella:companion-help-opportunity", help);
    window.addEventListener("astella:companion-result-available", result);
    void publish("context.updated");
    return () => {
      closed = true; publishRef.current = null; clearInterval(timer);
      stopSpeechWatch();
      window.removeEventListener("focus", foreground); window.removeEventListener("blur", foreground);
      document.removeEventListener("visibilitychange", foreground); document.removeEventListener("input", typing, true);
      window.removeEventListener("astella:companion-help-opportunity", help);
      window.removeEventListener("astella:companion-result-available", result);
    };
  }, [page.workspaceScopeRevision]);
  useEffect(() => {
    // Loading, recovery and result changes revoke the prior view before the next heartbeat.
    void publishRef.current?.("context.updated");
  }, [pageState.ready, pageState.revision]);
  useEffect(() => { void publishRef.current?.("context.updated"); }, [participationBlocked]);
  useEffect(() => {
    // Content must settle; scrolling, refreshing counters and lease renewal are not new arrivals.
    if (!pageState.ready) return;
    const timer = window.setTimeout(() => void publishRef.current?.("page.arrived"), 700);
    return () => window.clearTimeout(timer);
  }, [pageKey, pageState.ready, page.activeNoteVersionId, page.workspaceScopeRevision]);
}
