import type { CompanionJourneyAction } from "@astella/shared/companion-journey-contracts";
import type { CompanionActivityDeliveryV1 } from "@astella/shared/companion-memory-desktop-contracts";
import { useCallback,useEffect,useRef,useState } from "react";
import { useCompanionChat } from "../../../app/companion-chat-session";
import { gatewayErrorMessage,unwrapGatewayResult } from "../../../app/desktop-client";
import { useRoomStore } from "../../../app/room-store";
import { readAuthenticatedSession } from "../../../app/surface-session";
import { ActivityPanel } from "./companion-activity-panel";
import { publishCompanionRecordsChanged,useCompanionRecordsRefresh,useCompanionResource } from "./use-companion-resource";

export function CompanionActivityPage(props: { refreshKey: number; onMemory: (id: string) => void; onMessage: (id: string) => void }) {
  const chat = useCompanionChat();
  const journey = useCompanionResource(meta => window.astella.companion.journey.bootstrap({ meta }), [props.refreshKey]);
  const learning = useCompanionResource(meta => window.astella.companion.learningContext.get({ meta }), [props.refreshKey]);
  const activity = useCompanionResource(meta => window.astella.companion.activity.timeline({ meta }), [props.refreshKey]);
  const [overrides, setOverrides] = useState<Record<string, CompanionActivityDeliveryV1>>({});
  useEffect(() => { setOverrides({}); }, [activity.section]);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const presentations = useRef(new Set<string>());
  const reload = async () => { await Promise.all([journey.reload({ silent: true }), learning.reload({ silent: true }), activity.reload({ silent: true })]); };
  useCompanionRecordsRefresh(reload);
  const items = activity.section?.ok ? activity.section.value.items.map(item => overrides[item.deliveryId] ?? item) : [];
  const write = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    try { await action(); await reload(); publishCompanionRecordsChanged(); }
    catch (cause) { setError(gatewayErrorMessage(cause)); }
    finally { lock.current = false; setBusy(false); }
  };
  const start = (kind: "start_journey" | "replay") => {
    if (!journey.section?.ok) return;
    const invitation = journey.section.value.invitation;
    void write(async () => {
      const session = await readAuthenticatedSession(journey.epochRef);
      unwrapGatewayResult(await window.astella.companion.journey.actOnInvitation({ meta: journey.meta(), request: { version: 2, expectedRevision: invitation.revision, action: { kind, workspaceId: session.workspace!.workspaceId, branch: "own_material" }, idempotencyKey: crypto.randomUUID() } }));
    });
  };
  const act = (action: CompanionJourneyAction) => {
    if (!journey.section?.ok || !journey.section.value.journey) return;
    const journeyId = journey.section.value.journey.journeyId;
    void write(async () => {
      const current = unwrapGatewayResult(await window.astella.companion.journey.get({ meta: journey.meta(), journeyId }));
      unwrapGatewayResult(await window.astella.companion.journey.act({ meta: journey.meta(), journeyId, request: { version: 2, expectedRevision: current.revision, action, idempotencyKey: crypto.randomUUID() } }));
    });
  };
  const present = useCallback((item: CompanionActivityDeliveryV1) => {
    if (item.expired || !["queued", "delivered"].includes(item.state) || presentations.current.has(item.deliveryId)) return;
    presentations.current.add(item.deliveryId);
    void window.astella.companion.activity.present({ meta: activity.meta(), deliveryId: item.deliveryId, inboxSequence: item.inboxSequence }).then(result => {
      const shown = unwrapGatewayResult(result);
      setOverrides(current => ({ ...current, [shown.deliveryId]: shown }));
    }).catch(cause => { presentations.current.delete(item.deliveryId); setError(gatewayErrorMessage(cause)); });
  }, [activity.meta]);
  const deliver = (item: CompanionActivityDeliveryV1, transition: "acted" | "dismissed") => {
    void write(async () => {
      if (transition === "acted") {
        if (item.target.kind === "memory") props.onMemory(item.target.memoryId);
        else if (item.target.kind === "dialogue") props.onMessage(item.target.messageId);
        else if (item.target.kind === "proposal") { chat.retryProposal(item.target.proposalId); chat.setMode("history"); }
      }
      const updated = unwrapGatewayResult(await window.astella.companion.activity.ack({ meta: activity.meta(), request: { deliveryId: item.deliveryId, inboxSequence: item.inboxSequence, transition } }));
      setOverrides(current => ({ ...current, [updated.deliveryId]: updated }));
    });
  };
  return <ActivityPanel section={journey.section ?? { ok: false, message: journey.failure ?? "正在加载旅程" }}
    learningContextSection={learning.section ?? { ok: false, message: learning.failure ?? "正在加载学习状态" }}
    deliverySection={activity.section ?? { ok: false, message: activity.failure ?? "正在加载动态" }}
    deliveries={items} journeyLoading={journey.loading && !journey.section} learningLoading={learning.loading && !learning.section} deliveryLoading={activity.loading && !activity.section}
    busy={busy} error={error} onStart={start} onAction={act} onPresent={present} onDelivery={deliver}
    onResumeLearning={id => { const room = useRoomStore.getState(); room.setActiveRunId(id); room.invoke("validate"); }}
    onOpenObjective={id => { const room = useRoomStore.getState(); room.setActiveObjectiveId(id); room.invoke("open-objective"); }} onRetry={() => void reload()} />;
}
