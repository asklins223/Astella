import { useEffect, useRef } from "react";
import type { CompanionHomeProjectionV1 } from "@astella/shared/companion-home-contracts";
import type { CompanionActivityDeliveryV1 } from "@astella/shared/companion-memory-desktop-contracts";
import { createRequestMeta, unwrapGatewayResult } from "../../../app/client/desktop-client";
import { useHomeProjection, useHomeProjectionInvalidation } from "../../../app/home/home-projection";
import { useCompanionHomeProjection } from "../../../app/companion-pages/companion-home-projection";
import { useRoomStore } from "../../../app/home/room-store";
import { notifyCompanion, useCompanionNotifications } from "./companion-notifications";
import { clearCompanionTaskWatches } from "./companion-notification-tasks";
import { useVoiceModelNotifications } from "../voice/use-voice-model-notifications";
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
  if (!cue || cue.origin === "initiative" || scope !== useRoomStore.getState().workspaceScopeRevision) return;
  const reminder = cue.origin === "reminder";
  notifyCompanion({
    id: `activity:${scope}:${cue.revision}`, kind: reminder ? "reminder" : "help", scope,
    source: reminder ? "约好的提醒" : "书房消息", title: reminder ? "到你约好的时间了" : "伴星捎来一条消息", body: cue.text,
    audio: { text: cue.text }, snoozable: true,
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

/**
 * 她说过、却从未被任何设备接走的那几条（见下面那枚路标的说明）。
 *
 * 判据只有两条，都读投递自己的状态机：`kind='system_event'` + `target.kind='dialogue'`
 * 是"她真说过的那句话"（提醒类 system_event 的 target 是 `none`），
 * `state='queued' && expired` 是"过了展示窗口还没人认领"。
 */
function missedInitiativeDeliveries(
  items: readonly CompanionActivityDeliveryV1[],
): CompanionActivityDeliveryV1[] {
  return items.filter(item => item.kind === "system_event" && item.target.kind === "dialogue"
    && item.state === "queued" && item.expired);
}

export function useCompanionNotificationSources(): void {
  useVoiceModelNotifications();
  // 更新同理：设备级、有窗口级生命周期，所以挂在通知中心而不是设置页里。
  useUpdateNotifications();
  const scope = useRoomStore(state => state.workspaceScopeRevision);
  const { projection, reload } = useHomeProjection();
  const invalidation = useHomeProjectionInvalidation();
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
  /**
   * 她趁你不在时说的话，回来时至少留一枚路标（2026-10-14）。
   *
   * 展示窗口只有 `COMPANION_INITIATIVE_DELIVERY_TTL_HOURS`（shared 一处声明）。桌面没开着
   * 的时候她开的口，回到屋里时投影已经不认它了——`readProactiveCue` 只认未过期且
   * `queued`/`delivered` 的行，而首页投影这一路是唯一会让她出声的通道。实测 22 条
   * 主动投递里 13 条这样停在 `queued` 直到过期：她说了，用户回来什么也看不到，
   * 只有自己翻到「动态」才知道她说过话。
   *
   * 这里**不发她的话**（方案 56 §11：收件箱只持有消息引用，不保存第二份新交流正文），
   * 只发一枚指向真话的路标：过了展示窗口、又从未被任何设备接走（`state='queued'`——
   * 认领会写 `delivered`、露出来会写 `displayed`）的那几条，动作打开「动态」，
   * 那一页每一条都能跳到真实消息（`target.kind='dialogue'`）。
   *
   * 一枚路标管一次"你不在的时候"：id 按书房稳定、不按投递累加（§11：不能每多说一句
   * 就叠一张独立通知），条数变了只更新正文，不重新弹。
   */
  useEffect(() => {
    if (windowState !== "visible" || !window.astella?.companion?.activity) return;
    const readScope = scope;
    let cancelled = false;
    void (async () => {
      try {
        const timeline = unwrapGatewayResult(await window.astella.companion.activity.timeline({ meta: createRequestMeta() }));
        if (cancelled || readScope !== useRoomStore.getState().workspaceScopeRevision) return;
        const missed = missedInitiativeDeliveries(timeline.items).length;
        if (missed === 0) return;
        const id = `initiative-missed:${scope}`;
        const body = `你不在的时候她开了 ${missed} 次口，原话都留在对话里，还没有念给你听。`;
        const store = useCompanionNotifications.getState();
        if (store.items.some(item => item.id === id)) { store.update(id, { body }); return; }
        notifyCompanion({
          id, kind: "help", scope, source: "她留给你的话",
          title: "有几句话你还没听过", body, snoozable: true,
          actions: [{ id: "activity", label: "打开动态", kind: "navigate", run: () => {
            const room = useRoomStore.getState();
            if (room.workspaceScopeRevision !== scope) return;
            room.setCompanionCenterTarget({ tab: "activity" }); room.invoke("open-companion-center");
          } },
          { id: "later", label: "知道了", kind: "cancel" }],
        });
      } catch { /* 读不到就不提示：这不是失败路径，下一次投影失效还会再读 */ }
    })();
    return () => { cancelled = true; };
  }, [invalidation.revision, scope, windowState]);
}
