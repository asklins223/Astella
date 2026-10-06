import { useEffect, useRef } from "react";
import type { CompanionHomeProjectionV1 } from "@astella/shared/companion-home-contracts";
import { createRequestMeta, unwrapGatewayResult } from "../../app/desktop-client";
import { useHomeProjection } from "../../app/home-projection";
import { useCompanionHomeProjection } from "../../app/companion-home-projection";
import { useRoomStore } from "../../app/room-store";
import { notifyCompanion, useCompanionNotifications } from "./companion-notifications";
import { clearCompanionTaskWatches } from "./companion-notification-tasks";
import { useVoiceModelNotifications } from "./use-voice-model-notifications";
import { useUpdateNotifications } from "./use-update-notifications";

async function reportActivity(scope: number, sequence: number, transition: "displayed" | "acted" | "dismissed"): Promise<void> {
  const api = window.astella?.companion?.activity;
  if (!api || scope !== useRoomStore.getState().workspaceScopeRevision) return;
  const timeline = unwrapGatewayResult(await api.timeline({ meta: createRequestMeta() }));
  const delivery = timeline.items.find(item => item.inboxSequence === sequence);
  if (!delivery || scope !== useRoomStore.getState().workspaceScopeRevision) return;
  if (transition === "displayed") {
    unwrapGatewayResult(await api.present({ meta: createRequestMeta(), deliveryId: delivery.deliveryId, inboxSequence: sequence }));
  } else {
    unwrapGatewayResult(await api.ack({ meta: createRequestMeta(), request: { deliveryId: delivery.deliveryId, inboxSequence: sequence, transition } }));
  }
}

function deliverActivityCue(cue: CompanionHomeProjectionV1["proactiveCue"], scope: number): void {
  if (!cue || cue.origin === "thought" || scope !== useRoomStore.getState().workspaceScopeRevision) return;
  const reminder = cue.origin === "reminder";
  notifyCompanion({
    id: `activity:${scope}:${cue.revision}`, kind: reminder ? "reminder" : "help", scope,
    source: reminder ? "约好的提醒" : "书房消息", title: reminder ? "到你约好的时间了" : "伴星捎来一条消息", body: cue.text,
    audio: { text: cue.text.slice(0, 120) }, snoozable: true,
    onShown: () => reportActivity(scope, cue.revision, "displayed"),
    onDismiss: () => reportActivity(scope, cue.revision, "dismissed"),
    actions: [{ id: "ok", label: "知道了", kind: "confirm", run: () => reportActivity(scope, cue.revision, "acted") },
      { id: "activity", label: "打开动态", kind: "navigate", run: async () => {
        await reportActivity(scope, cue.revision, "acted");
        const room = useRoomStore.getState(); if (room.workspaceScopeRevision !== scope) return;
        room.setCompanionCenterTarget({ tab: "activity" }); room.invoke("open-companion-center");
      } }],
  });
}

export function useCompanionNotificationSources(): void {
  useVoiceModelNotifications();
  // 更新同理：设备级、有窗口级生命周期，所以挂在通知中心而不是设置页里。
  useUpdateNotifications();
  const scope = useRoomStore(state => state.workspaceScopeRevision);
  const { projection, reload } = useHomeProjection();
  const companion = useCompanionHomeProjection();
  const projectionScopes = useRef(new WeakMap<object, number>());
  const belongsHere = (value: object | null) => {
    if (!value) return false;
    if (!projectionScopes.current.has(value)) projectionScopes.current.set(value, scope);
    return projectionScopes.current.get(value) === scope;
  };
  const homeCurrent = belongsHere(projection);
  const companionCurrent = belongsHere(companion.projection);
  const surface = useRoomStore(state => state.surface);
  const windowState = useRoomStore(state => state.windowState);
  useEffect(() => {
    useCompanionNotifications.getState().clearWorkspace(scope);
    clearCompanionTaskWatches(scope);
  }, [scope]);
  useEffect(() => {
    const timer = window.setInterval(() => useCompanionNotifications.getState().tick(Date.now()), 15_000);
    return () => { window.clearInterval(timer); clearCompanionTaskWatches(); };
  }, []);
  // Due dates can cross while the room stays open. Reuse the authenticated room read.
  useEffect(() => {
    if (surface || windowState !== "visible") return;
    const timer = window.setInterval(reload, 60_000);
    return () => window.clearInterval(timer);
  }, [surface, windowState, reload]);
  const summary = projection?.sanitizedReviewSummary;
  const due = summary?.state === "data" ? summary.data.dueCount : 0;
  useEffect(() => {
    if (!due || !projection || !homeCurrent || surface) return;
    const date = new Date().toLocaleDateString("en-CA");
    notifyCompanion({
      id: `review:${scope}:${date}`, kind: "review", scope, source: "今日复习", title: `${due} 项知识等你温习`,
      body: "有些学过的内容到了回想的时间。趁现在还熟悉，花一点时间把它们巩固下来吧。",
      expiresAt: new Date(new Date().setHours(24, 0, 0, 0)).getTime(), snoozable: true,
      audio: { clip: "review-due", text: "今天有学过的知识到了复习时间。方便的时候，和我一起温习一下吧。" },
      actions: [{ id: "review", label: "去温习", kind: "navigate", run: () => useRoomStore.getState().invoke("review") },
        { id: "later", label: "今天先不提醒", kind: "cancel" }],
    });
  }, [due, projection, homeCurrent, scope, surface]);
  const cue = companion.projection?.proactiveCue;
  useEffect(() => {
    if (companionCurrent) deliverActivityCue(cue ?? null, scope);
  }, [cue, companionCurrent, scope]);
  // The room projection is lazy on task pages; reminders still need their real event path.
  useEffect(() => {
    const api = window.astella;
    if (!surface || !api?.subscriptions) return;
    let active = true;
    let reading = false;
    let pendingEpoch: number | null = null;
    const cleanups: Array<() => void> = [];
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        while (active && pendingEpoch !== null) {
          const epoch = pendingEpoch; pendingEpoch = null;
          const projection = unwrapGatewayResult(await api.companion.home.getProjection({ meta: createRequestMeta(epoch) }));
          if (active && useRoomStore.getState().workspaceScopeRevision === scope) deliverActivityCue(projection.proactiveCue, scope);
        }
      } catch { /* The next gateway event or returning home retries the read. */ }
      finally { reading = false; }
    };
    void api.subscriptions.subscribe({ meta: createRequestMeta(), topic: { kind: "runtime" } }).then(response => {
      const subscription = unwrapGatewayResult(response);
      const unsubscribe = () => { void api.subscriptions.unsubscribe({ meta: createRequestMeta(), subscriptionId: subscription.subscriptionId }).catch(() => undefined); };
      if (!active) { unsubscribe(); return; }
      cleanups.push(unsubscribe, api.subscriptions.onEvent(subscription.subscriptionId, event => {
        if (event.data.kind === "companion_activity_changed") { pendingEpoch = event.workspaceEpoch; void read(); }
      }));
    }).catch(() => undefined);
    return () => { active = false; for (const cleanup of cleanups.reverse()) cleanup(); };
  }, [scope, surface]);
}
