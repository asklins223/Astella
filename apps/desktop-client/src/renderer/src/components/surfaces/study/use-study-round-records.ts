import { useEffect, useMemo, useRef, useState } from "react";
import type { NoteLearningRoundPersonalHistoryV1 } from "@astella/shared/note-learning-round-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../app/desktop-client";
import { useRoomStore } from "../../../app/room-store";
import { useSurfaceProjection } from "../notebook/surface-data.tsx";
import { studyRoundReadingDepth } from "./use-study-journal-position";

/** First-page refresh and older pages belong to the same history snapshot. */
export function useStudyRoundRecords() {
  const scope = useRoomStore(state => state.workspaceScopeRevision);
  const restoreDepth = useRef(studyRoundReadingDepth(scope));
  const previousScope = useRef(scope);
  const first = useSurfaceProjection<NoteLearningRoundPersonalHistoryV1>(async ({ workspaceEpoch }) =>
    unwrapGatewayResult(await window.astella.noteLearningRound.personalHistory({ meta: createRequestMeta(workspaceEpoch) })), [scope]);
  const [older, setOlder] = useState<NoteLearningRoundPersonalHistoryV1 | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);

  useEffect(() => {
    if (previousScope.current !== scope) {
      restoreDepth.current = 0; previousScope.current = scope;
    }
    generation.current++; inFlight.current = false;
    setOlder(null); setBusy(false); setFailure(null);
  }, [first.data, scope]);
  useEffect(() => () => { generation.current++; }, []);

  const items = useMemo(() => [...new Map([
    ...(first.data?.items ?? []), ...(older?.items ?? []),
  ].map(item => [item.roundId, item])).values()], [first.data, older]);
  const hasMore = older?.hasMore ?? first.data?.hasMore ?? false;
  const cursor = older ? older.nextCursor : first.data?.nextCursor;
  const restoring = previousScope.current === scope && !first.loading && !first.refreshing
    && !first.failure && !failure && hasMore && items.length < restoreDepth.current;
  const loadOlder = async () => {
    if (!hasMore || !cursor || inFlight.current) return;
    inFlight.current = true; setBusy(true); setFailure(null);
    const request = ++generation.current;
    try {
      const page = unwrapGatewayResult(await window.astella.noteLearningRound.personalHistory({
        meta: createRequestMeta(first.epochRef.current), before: cursor,
      }));
      if (request !== generation.current) return;
      setOlder(previous => ({ ...page, items: [...(previous?.items ?? []), ...page.items] }));
    } catch (error) {
      if (request === generation.current) setFailure(gatewayErrorMessage(error));
    } finally {
      if (request === generation.current) { setBusy(false); inFlight.current = false; }
    }
  };
  const reload = () => {
    restoreDepth.current = Math.max(restoreDepth.current, items.length);
    generation.current++; inFlight.current = false;
    setOlder(null); setBusy(false); setFailure(null);
    void first.reload({ silent: true });
  };
  // Re-read the previously expanded depth before the journal restores its scroll.
  // No records are cached; failures stop automatic paging and expose the retry.
  useEffect(() => {
    if (restoring && !busy) void loadOlder();
  });
  return { items, total: older?.totalCount ?? first.data?.totalCount ?? 0,
    hasMore, busy, failure: first.failure ?? first.refreshFailure ?? failure,
    loading: first.loading, restoring, loadOlder, reload };
}
