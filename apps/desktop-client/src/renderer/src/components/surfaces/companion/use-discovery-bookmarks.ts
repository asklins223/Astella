import { useEffect, useMemo, useRef, useState } from "react";
import { gatewayErrorMessage, unwrapGatewayResult } from "../../../app/desktop-client";
import { useRoomStore } from "../../../app/room-store";
import { discoveryIdentityKey, type DiscoveryKeepProps, type DiscoveryKeepRequest } from "./companion-discovery-offer";
import { publishCompanionRecordsChanged, useCompanionRecordsRefresh, useCompanionResource } from "./use-companion-resource";

/** Dialogue and diary use the same persisted identity and refresh after any bookmark change. */
export function useDiscoveryBookmarks(refreshKey: number) {
  const scope = useRoomStore(state => state.workspaceScopeRevision);
  const book = useCompanionResource(meta => window.ailearn.companion.memory.discovery.get({ meta }), [refreshKey]);
  useCompanionRecordsRefresh(book.reload);
  const [receipts, setReceipts] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ identity: string; message: string } | null>(null);
  const [feedback, setFeedback] = useState<{ identity: string; message: string } | null>(null);
  const lock = useRef(false);
  const collected = useMemo(() => new Set(book.section?.ok ? book.section.value.entries.map(discoveryIdentityKey) : []), [book.section]);
  useEffect(() => { if (book.section?.ok) setReceipts(new Map()); }, [book.section]);
  useEffect(() => { setReceipts(new Map()); setFailure(null); setFeedback(null); }, [scope]);

  const write = async (request: DiscoveryKeepRequest, remove: boolean) => {
    if (lock.current) return;
    lock.current = true;
    const identity = discoveryIdentityKey(request);
    const currentScope = scope;
    setBusy(identity); setFailure(null); setFeedback(null);
    try {
      if (remove) {
        unwrapGatewayResult(await window.ailearn.companion.memory.discovery.uncollect({ meta: book.meta(), request: { kind: request.kind, source: request.source, sourceId: request.sourceId } }));
      } else {
        unwrapGatewayResult(await window.ailearn.companion.memory.discovery.collect({ meta: book.meta(), request }));
      }
      if (useRoomStore.getState().workspaceScopeRevision !== currentScope) return;
      setReceipts(current => new Map(current).set(identity, !remove));
      setFeedback({ identity, message: remove ? "已取消收藏，原话仍然保留。" : "已留在发现簿。" });
      publishCompanionRecordsChanged();
    } catch (cause) {
      if (useRoomStore.getState().workspaceScopeRevision === currentScope) setFailure({ identity, message: gatewayErrorMessage(cause) });
    } finally { lock.current = false; setBusy(null); }
  };
  return {
    forRequest(request: DiscoveryKeepRequest): DiscoveryKeepProps {
      const identity = discoveryIdentityKey(request);
      return {
        state: (receipts.get(identity) ?? collected.has(identity)) ? "kept" : "offer",
        busy: busy === identity, disabled: busy !== null, failure: failure?.identity === identity ? failure.message : null,
        feedback: feedback?.identity === identity ? feedback.message : null,
        onKeep: () => { void write(request, false); }, onRemove: () => { void write(request, true); },
      };
    },
  };
}
