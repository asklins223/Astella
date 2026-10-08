import { useCallback, useEffect, useRef, useState } from "react";
import type { CardGenerationCandidateV1, CardGenerationPracticeQuotaV1, CardGenerationRunSnapshotV1 } from "@astella/shared/card-generation-desktop-contracts";
import { useRoomStore } from "../../../app/room-store";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../app/desktop-client";
import { isCardGenerationInFlight, isCardGenerationReviewStage, isLandedCandidate } from "./card-generation-status";
import { isActionableUndecidedCandidate } from "./candidate-review-model";

/**
 * 在途轮询的间隔。
 *
 * 事件流是"有事件才推"，所以它给的是**延迟**而不是**节奏**；而这一屏要的恰恰是节奏
 * ——"正在做一套学习卡"下面那道计数与那一列写好的题面，要自己往前走。
 *
 * 这一层存在的理由是**流会没有**：服务端的每用户 SSE 上限是 5，而主进程那一侧曾经
 * 漏过连接（建连句柄到手之前重复建流、窗口重新加载后订阅表没清），占满之后每一次
 * 订阅都被 429 顶回。流一断，这屏就停在原地不动，只有手动按「刷新状态」才动一下
 * （2026-10-04 实测）。轮询是那道兜底：它不依赖任何一条长连接，代价是每两秒一次
 * `getRun`（终态后停），而这正是这一屏本来就要做的那次读。
 */
const IN_FLIGHT_POLL_MS = 2000;

/** The generation and review read the same records, including live partial cards. */
export function useCardGenerationData() {
  const runId = useRoomStore((state) => state.activeCardGenerationRunId);
  const scope = useRoomStore((state) => state.workspaceScopeRevision);
  const setRunId = useRoomStore((state) => state.setActiveCardGenerationRunId);
  const [run, setRun] = useState<CardGenerationRunSnapshotV1 | null>(null);
  const [candidates, setCandidates] = useState<CardGenerationCandidateV1[]>([]);
  const [landedCandidates, setLandedCandidates] = useState<CardGenerationCandidateV1[]>([]);
  const [practiceQuota, setPracticeQuota] = useState<CardGenerationPracticeQuotaV1 | null>(null);
  const [activeCandidateId, setActiveCandidateId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [noteTitle, setNoteTitle] = useState<string | null>(null);
  const [runIdHealed, setRunIdHealed] = useState(false);
  const [syncReport, setSyncReport] = useState<{ at: string; status: string | null; changed: boolean } | null>(null);
  const epochRef = useRef<number | undefined>(undefined);
  const requestRef = useRef(0);
  const pendingRef = useRef<{ again: boolean; promise: Promise<string | null> } | null>(null);
  const lastStatusRef = useRef<string | null>(null);

  useEffect(() => {
    if (runId || runIdHealed || !window.astella) return;
    let active = true;
    void (async () => {
      try {
        const session = unwrapGatewayResult(await window.astella.auth.getState({ meta: createRequestMeta() }));
        if (session.status !== "authenticated" || !session.workspace) return;
        const response = await window.astella.room.getProjection({ meta: createRequestMeta(session.workspaceEpoch) });
        if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
        const projection = unwrapGatewayResult(response);
        const generations = projection.activeGenerationSummary.state === "data" ? projection.activeGenerationSummary.data : [];
        if (active && generations[0]) setRunId(generations[0].runId);
      } catch { /* The empty paper has a real route back to the note. */ }
      finally { if (active) setRunIdHealed(true); }
    })();
    return () => { active = false; };
  }, [runId, runIdHealed, setRunId]);

  const noteId = run?.noteId;
  useEffect(() => {
    setNoteTitle(null);
    if (!noteId || !window.astella) return;
    let active = true;
    void window.astella.note.get({ meta: createRequestMeta(epochRef.current), noteId }).then((response) => {
      if (active) setNoteTitle(unwrapGatewayResult(response).title || null);
    }).catch(() => { if (active) setNoteTitle(null); });
    return () => { active = false; };
  }, [noteId, runId]);

  const load = useCallback((showLoading = false): Promise<string | null> => {
    if (showLoading) setLoading(true);
    if (pendingRef.current) {
      pendingRef.current.again = true;
      return pendingRef.current.promise;
    }
    const request = ++requestRef.current;
    const current = () => request === requestRef.current && useRoomStore.getState().workspaceScopeRevision === scope
      && useRoomStore.getState().activeCardGenerationRunId === runId;
    const flight = { again: false, promise: Promise.resolve<string | null>(null) };
    pendingRef.current = flight;
    const read = async (): Promise<string | null> => {
      if (!runId || !window.astella) { setLoading(false); return null; }
      try {
        const response = await window.astella.note.cardGeneration.getRun({ meta: createRequestMeta(epochRef.current), runId });
        if (!current()) return null;
        if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
        const nextRun = unwrapGatewayResult(response);
        // The run snapshot is already authoritative even if the separate
        // candidate read fails or takes longer. Keep the stage moving.
        setRun(nextRun);
        lastStatusRef.current = nextRun.status;
        let nextCandidates: CardGenerationCandidateV1[] = [];
        let nextQuota: CardGenerationPracticeQuotaV1 | null = null;
        if (isCardGenerationReviewStage(nextRun.status) || isCardGenerationInFlight(nextRun.status)) {
          const candidateResponse = await window.astella.note.cardGeneration.getCandidates({ meta: createRequestMeta(epochRef.current), runId });
          if (!current()) return null;
          if (candidateResponse.workspaceEpoch) epochRef.current = candidateResponse.workspaceEpoch;
          const list = unwrapGatewayResult(candidateResponse);
          nextCandidates = list.candidates;
          nextQuota = list.practiceQuota;
        }
        if (!current()) return null;
        setCandidates(nextCandidates);
        setPracticeQuota(nextQuota);
        setLandedCandidates(isCardGenerationReviewStage(nextRun.status) && nextRun.status !== "needs_attention"
          ? [] : nextCandidates.filter((candidate) => candidate.publishState === "unpublished" && isLandedCandidate(candidate.qualityState)));
        setActiveCandidateId((current) => nextCandidates.some((candidate) => candidate.candidateId === current)
          ? current : nextCandidates.find(isActionableUndecidedCandidate)?.candidateId ?? nextCandidates[0]?.candidateId ?? null);
        setFailure(null);
        return nextRun.status;
      } catch (error) {
        if (current()) setFailure(gatewayErrorMessage(error));
        return null;
      } finally { if (current()) setLoading(false); }
    };
    // Finish each snapshot before reading the next. A poll/event burst must not
    // invalidate every response on a slow connection and freeze the progress.
    flight.promise = read().finally(() => {
      if (pendingRef.current !== flight) return;
      pendingRef.current = null;
      if (flight.again && current()) void load(false);
    });
    return flight.promise;
  }, [runId, scope]);

  const resync = useCallback(async () => {
    const before = lastStatusRef.current;
    const next = await load(true);
    setSyncReport({ at: new Date().toISOString(), status: next, changed: next !== null && next !== before });
  }, [load]);

  useEffect(() => {
    pendingRef.current = null;
    epochRef.current = undefined;
    setRun(null); setCandidates([]); setLandedCandidates([]); setPracticeQuota(null);
    setActiveCandidateId(null); setFailure(null); setSyncReport(null);
    lastStatusRef.current = null;
    void load(true);
    return () => { requestRef.current += 1; };
  }, [load]);

  useEffect(() => {
    if (!runId || !window.astella) return;
    let disposed = false;
    let subscriptionId: string | null = null;
    let unsubscribe: (() => void) | undefined;
    const api = window.astella;
    void (async () => {
      try {
      const response = await api.subscriptions.subscribe({ meta: createRequestMeta(epochRef.current), topic: { kind: "cardGeneration", runId } });
      const id = unwrapGatewayResult(response).subscriptionId;
      if (disposed) { void api.subscriptions.unsubscribe({ meta: createRequestMeta(epochRef.current), subscriptionId: id }); return; }
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      subscriptionId = id;
      unsubscribe = api.subscriptions.onEvent(id, () => { void load(false); });
      } catch { /* The in-flight poll below carries this screen on its own. */ }
    })();
    return () => {
      disposed = true; unsubscribe?.();
      if (subscriptionId) void api.subscriptions.unsubscribe({ meta: createRequestMeta(epochRef.current), subscriptionId });
    };
  }, [runId, load]);

  /**
   * 在途轮询：后台还在做这一批的时候，自己按节奏重读一次。
   *
   * 后台还在做、首次状态未读到或读数失败时继续重试。完整读取终态后停，
   * 审核台上的用户操作会自己重读结果。
   *
   * 它与事件流是**并联**而不是串联：流在，它把两次重读之间的空档补上；流被限流顶回、
   * 建不上、或者中途断了，这一屏照样往前走。窗口不可见时停——看不见的时候没有人在等
   * 那一列题面，重新可见时立刻补读一次。
   */
  const shouldPoll = !run || isCardGenerationInFlight(run.status) || Boolean(failure);
  useEffect(() => {
    if (!runId || !shouldPoll) return;
    let timer: number | null = null;
    const read = () => { void load(false); };
    const start = (): void => {
      if (timer !== null) return;
      timer = window.setInterval(() => {
        if (document.visibilityState === "hidden") return;
        read();
      }, IN_FLIGHT_POLL_MS);
    };
    const onVisibility = (): void => { if (document.visibilityState === "visible") read(); };
    document.addEventListener("visibilitychange", onVisibility);
    start();
    return () => {
      if (timer !== null) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [runId, shouldPoll, load]);

  return { runId, run, candidates, landedCandidates, practiceQuota, activeCandidateId, setActiveCandidateId,
    loading, failure, noteTitle, waitingForRun: !runId && !runIdHealed, syncReport, epochRef, load, resync };
}
