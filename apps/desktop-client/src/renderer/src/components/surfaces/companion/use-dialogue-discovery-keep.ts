import type { CompanionHistoryItemV1 } from "@ailearn/shared/companion-memory-desktop-contracts";
import type { RequestMetaV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { useEffect,useMemo,useState } from "react";
import { gatewayErrorMessage,unwrapGatewayResult } from "../../../app/desktop-client";
import { messageText } from "./companion-center-model";
import { clipDiscoveryBody,discoveryAuthorFor,discoveryIdentityKey,discoveryKindFor,readDiscoveryKeepDeclined,rememberDiscoveryKeepDeclined,resolveDiscoveryKeepState } from "./companion-discovery-offer";
import { publishCompanionRecordsChanged } from "./use-companion-resource";

export function useDialogueDiscoveryKeep(items: readonly CompanionHistoryItemV1[], meta: () => RequestMetaV1) {
  const [declined, setDeclined] = useState(readDiscoveryKeepDeclined);
  const [spent, setSpent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [collected, setCollected] = useState<ReadonlySet<string>>(() => new Set());
  const anchor = useMemo(() => [...items].filter((item): item is CompanionHistoryItemV1 & { role: "user" | "assistant" } => item.role !== "system" && item.kind !== "cancelled")
    .map(item => ({ item, body: clipDiscoveryBody(messageText(item)) })).filter(entry => entry.body.length > 0)
    .sort((a, b) => b.item.createdAt.localeCompare(a.item.createdAt))[0] ?? null, [items]);
  const request = useMemo(() => anchor ? { kind: discoveryKindFor(anchor.item.role), source: "assistant_reply" as const, sourceId: anchor.item.messageId, author: discoveryAuthorFor(anchor.item.role), body: anchor.body } : null, [anchor]);
  const identity = request ? discoveryIdentityKey(request) : null;
  useEffect(() => {
    if (!request) return;
    let active = true;
    void window.ailearn.companion.memory.discovery.state({ meta: meta(), kind: request.kind, source: request.source, sourceId: request.sourceId }).then(result => {
      if (active && unwrapGatewayResult(result).collected) setCollected(current => new Set(current).add(discoveryIdentityKey(request)));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [request, meta]);
  return {
    anchorMessageId: anchor?.item.messageId ?? null,
    state: resolveDiscoveryKeepState({ isLatestPause: identity !== null, alreadyCollected: identity !== null && collected.has(identity), declined, spent }), busy, feedback, failure,
    onKeep: () => {
      if (!request || busy) return;
      setBusy(true); setFeedback(null); setFailure(null);
      void window.ailearn.companion.memory.discovery.collect({ meta: meta(), request }).then(result => {
        const outcome = unwrapGatewayResult(result);
        setCollected(current => new Set(current).add(discoveryIdentityKey(request))); setSpent(true);
        setFeedback(outcome.status === "already_collected" ? "这一段已经在发现簿里。" : "已留在发现簿。"); publishCompanionRecordsChanged();
      }).catch(error => setFailure(`没能留在发现簿：${gatewayErrorMessage(error)}。可以再试一次。`)).finally(() => setBusy(false));
    },
    onDecline: () => { rememberDiscoveryKeepDeclined(); setDeclined(true); },
  };
}
