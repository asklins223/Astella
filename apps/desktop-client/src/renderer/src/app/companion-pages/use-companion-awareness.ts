import { useEffect, useRef } from "react";
import type { CompanionAwarenessContextV1, CompanionAwarenessObservationV1 } from "@astella/shared/companion-initiative-contracts";
import { useCompanionPageContext } from "../companion-session/companion-chat-session-page";
import { useRoomStore } from "../home/room-store";
import { createRequestMeta, requireWorkspaceEpoch, unwrapGatewayResult } from "../client/desktop-client";
import { HUD_PAGES } from "../../components/hud/hud-pages";
import { stopCompanionNotificationSpeech } from "../../components/companion/voice/companion-notification-voice";
import { isCompanionSpeechActive, subscribeCompanionSpeechActivity } from "../companion-session/companion-voice-playback";
import { companionAwarenessPageState } from "./companion-awareness-page";
import { createCompanionQuietPresenceTracker } from "@astella/shared/companion-awareness-idle";
import { markCompanionLaunchRegistered } from "./companion-launch-gate";

/** Real lifecycle and semantic arrivals. Heartbeats renew factual leases; they never call a model. */
export function useCompanionAwareness(conversationId: string | null) {
  const page = useCompanionPageContext();
  const latest = useRef({ page, conversationId }); latest.current = { page, conversationId };
  const pageKey = [page.hudPage, page.activeNoteId, page.activeSourceId, page.settingsSection].filter(Boolean).join(":");
  const pageState = companionAwarenessPageState(page);
  const participationBlocked = useRoomStore(state => state.onboardingOpen || state.companionGuideOpen);
  const publishRef = useRef<((topic: CompanionAwarenessObservationV1["topic"], evidence?: CompanionAwarenessObservationV1["evidence"]) => Promise<void>) | null>(null);
  const activityRef = useRef<(() => void) | null>(null);
  const priorPageKey = useRef(pageKey);
  useEffect(() => {
    const api = window.astella?.companion?.initiative;
    if (!api) return;
    let closed = false, started = false, typingUntil = 0, lastInputAt = -Infinity, lastAt = performance.now();
    const quietPresence = createCompanionQuietPresenceTracker(lastAt);
    let quietEpisodeVersion = 0, lastActivityObservationAt = -Infinity;
    let quietEpisodeId = crypto.randomUUID();
    let identity: Pick<CompanionAwarenessObservationV1, "version" | "appLaunchId" | "deviceSessionId" | "host"> | undefined;
    let sequence = Promise.resolve();
    const context = (): CompanionAwarenessContextV1 => {
      const { page: p, conversationId: currentConversation } = latest.current;
      const currentPage = companionAwarenessPageState(p);
      const room = useRoomStore.getState();
      const foreground = document.visibilityState === "visible" && document.hasFocus() && room.windowState === "visible";
      const learning = ["note-read", "note-edit", "note-learning"].includes(p.hudPage)
        ? Boolean(p.activeNoteId && p.activeNoteVersionId)
        : false;
      const currentPageKey = [p.hudPage, p.activeNoteId, p.activeSourceId, p.settingsSection].filter(Boolean).join(":");
      return { foreground, unlocked: true, typing: performance.now() < typingUntil, learning, speaking:isCompanionSpeechActive(),
        participationAllowed: !room.onboardingOpen && !room.companionGuideOpen
          && !room.mutedCompanionSceneKeys.includes(room.surface ?? "room") && !room.companionFocusUntilTaskEnd,
        conversationId: currentConversation, quietEpisodeId, page: { key: currentPageKey, label: HUD_PAGES[p.hudPage].title,
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
          const quietForMs = topic === "presence.quiet"
            ? quietPresence.quietForMs(now, currentContext.foreground && currentContext.unlocked
              && !currentContext.typing && currentContext.participationAllowed !== false)
            : null;
          if (topic === "presence.quiet" && quietForMs === null) return;
          const episodeVersion = quietEpisodeVersion;
          // 一段持续的安静按 90 秒一格继续上报（判据见 shared 的 companion-awareness-idle）：
          // 每次都是一个新的观察身份。只报一次的话，适中档要 3 分钟，而客户端在第 90 秒
          // 就把这一集标成"报过了"，于是"安静了 5 分钟"永远等不到自己的档位门槛。
          const request = { ...identity,
            id: crypto.randomUUID(),
            topic, occurredAt: new Date().toISOString(),
            elapsedMs: Math.min(45_000, Math.max(0, Math.round(now - lastAt))),
            context: quietForMs === null ? currentContext : { ...currentContext, quietForMs },
            ...(evidence ? { evidence } : {}) };
          lastAt = now;
          unwrapGatewayResult(await api.observe({ meta: createRequestMeta(epoch), request }));
          if (topic === "presence.quiet" && quietEpisodeVersion === episodeVersion) quietPresence.markReported(quietForMs!);
          if (!started && currentContext.foreground && currentContext.participationAllowed) {
            unwrapGatewayResult(await api.observe({ meta: createRequestMeta(epoch), request: { ...request, id: crypto.randomUUID(), topic: "app.started", elapsedMs: 0 } }));
            started = true;
            // 这次启动已经登记过宿主：服务端据此收掉上一次没被看见的启动问候，
            // 主动气泡的展示闸门到这里才开（见 companion-launch-gate.ts）。
            markCompanionLaunchRegistered();
          }
        } catch { /* Offline observations earn no study time; the next real lease tries again. */ }
      });
      return sequence;
    };
    publishRef.current = publish;
    const activity = () => {
      const now = performance.now();
      quietEpisodeVersion += 1;
      quietEpisodeId = crypto.randomUUID();
      quietPresence.markActivity(now);
      if (now - lastActivityObservationAt >= 5_000) {
        lastActivityObservationAt = now;
        void publish("context.updated");
      }
    };
    activityRef.current = activity;
    // 裸的鼠标移动**不算**活动：手放着在读同一页时，指针飘一下就把"安静"清零，
    // 她那扇门两天只开过一次（判据见 shared 的 companion-awareness-idle）。
    // 按下、敲击、滚动、触摸、翻页才算他还在做事。
    const foreground = () => {
      activity();
      void publish(document.hasFocus() && document.visibilityState === "visible" ? "app.foreground" : "context.updated");
    };
    const typing = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".companion-hud, .companion-interaction, .companion-history, [data-companion-composer]")) return;
      activity();
      typingUntil = performance.now() + 6_000;
      stopCompanionNotificationSpeech();
      window.dispatchEvent(new Event("astella:companion-user-input"));
      if (performance.now() - lastInputAt > 1_000) { lastInputAt = performance.now(); void publish("context.updated"); }
    };
    const help = (event: Event) => { const detail = (event as CustomEvent<CompanionAwarenessObservationV1["evidence"]>).detail; if (detail) void publish("help.available", detail); };
    const result = (event: Event) => { const detail = (event as CustomEvent<CompanionAwarenessObservationV1["evidence"]>).detail; if (detail) void publish("result.available", detail); };
    const timer = window.setInterval(() => {
      void publish("context.updated");
      void publish("presence.quiet");
    }, 15_000);
    const stopSpeechWatch = subscribeCompanionSpeechActivity(() => void publish("context.updated"));
    window.addEventListener("focus", foreground); window.addEventListener("blur", foreground);
    document.addEventListener("visibilitychange", foreground); document.addEventListener("input", typing, true);
    document.addEventListener("pointerdown", activity, true);
    document.addEventListener("keydown", activity, true); document.addEventListener("wheel", activity, { capture: true, passive: true });
    document.addEventListener("touchstart", activity, { capture: true, passive: true });
    window.addEventListener("astella:companion-help-opportunity", help);
    window.addEventListener("astella:companion-result-available", result);
    void publish("context.updated");
    return () => {
      closed = true; publishRef.current = null; activityRef.current = null; clearInterval(timer);
      stopSpeechWatch();
      window.removeEventListener("focus", foreground); window.removeEventListener("blur", foreground);
      document.removeEventListener("visibilitychange", foreground); document.removeEventListener("input", typing, true);
      document.removeEventListener("pointerdown", activity, true);
      document.removeEventListener("keydown", activity, true); document.removeEventListener("wheel", activity, true);
      document.removeEventListener("touchstart", activity, true);
      window.removeEventListener("astella:companion-help-opportunity", help);
      window.removeEventListener("astella:companion-result-available", result);
    };
  }, [page.workspaceScopeRevision]);
  useEffect(() => {
    // Loading, recovery and result changes revoke the prior view before the next heartbeat.
    void publishRef.current?.("context.updated");
  }, [pageState.ready, pageState.revision]);
  useEffect(() => {
    if (priorPageKey.current === pageKey) return;
    priorPageKey.current = pageKey;
    activityRef.current?.();
  }, [pageKey]);
  useEffect(() => { void publishRef.current?.("context.updated"); }, [participationBlocked]);
  useEffect(() => {
    // Content must settle; scrolling, refreshing counters and lease renewal are not new arrivals.
    if (!pageState.ready) return;
    const timer = window.setTimeout(() => void publishRef.current?.("page.arrived"), 700);
    return () => window.clearTimeout(timer);
  }, [pageKey, pageState.ready, page.activeNoteVersionId, page.workspaceScopeRevision]);
}
