import { useCallback, useEffect, useRef, useState } from "react";
import type { CardGenerationCandidateV1, CardGenerationPracticeQuotaV1, CardGenerationRunSnapshotV1 } from "@ailearn/shared/card-generation-desktop-contracts";
import { useRoomStore } from "../../../app/room-store";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../app/desktop-client";
import { isCardGenerationInFlight, isCardGenerationReviewStage, isLandedCandidate } from "./card-generation-status";

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
  const lastStatusRef = useRef<string | null>(null);

  useEffect(() => {
    if (runId || runIdHealed || !window.ailearn) return;
    let active = true;
    void (async () => {
      try {
        const session = unwrapGatewayResult(await window.ailearn.auth.getState({ meta: createRequestMeta() }));
        if (session.status !== "authenticated" || !session.workspace) return;
        const response = await window.ailearn.room.getProjection({ meta: createRequestMeta(session.workspaceEpoch) });
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
    if (!noteId || !window.ailearn) return;
    let active = true;
    void window.ailearn.note.get({ meta: createRequestMeta(epochRef.current), noteId }).then((response) => {
      if (active) setNoteTitle(unwrapGatewayResult(response).title || null);
    }).catch(() => { if (active) setNoteTitle(null); });
    return () => { active = false; };
  }, [noteId, runId]);

  const load = useCallback(async (showLoading = false): Promise<string | null> => {
    const request = ++requestRef.current;
    if (!runId || !window.ailearn) { setLoading(false); return null; }
    if (showLoading) setLoading(true);
    try {
      const response = await window.ailearn.note.cardGeneration.getRun({ meta: createRequestMeta(epochRef.current), runId });
      if (request !== requestRef.current) return null;
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      const nextRun = unwrapGatewayResult(response);
      let nextCandidates: CardGenerationCandidateV1[] = [];
      let nextQuota: CardGenerationPracticeQuotaV1 | null = null;
      if (isCardGenerationReviewStage(nextRun.status) || isCardGenerationInFlight(nextRun.status)) {
        const candidateResponse = await window.ailearn.note.cardGeneration.getCandidates({ meta: createRequestMeta(epochRef.current), runId });
        if (request !== requestRef.current) return null;
        if (candidateResponse.workspaceEpoch) epochRef.current = candidateResponse.workspaceEpoch;
        const list = unwrapGatewayResult(candidateResponse);
        nextCandidates = list.candidates;
        nextQuota = list.practiceQuota;
      }
      setRun(nextRun);
      setCandidates(nextCandidates);
      setPracticeQuota(nextQuota);
      setLandedCandidates(isCardGenerationReviewStage(nextRun.status) ? [] : nextCandidates.filter((candidate) => isLandedCandidate(candidate.qualityState)));
      setActiveCandidateId((current) => nextCandidates.some((candidate) => candidate.candidateId === current)
        ? current : nextCandidates.find((candidate) => candidate.reviewDecision === "undecided")?.candidateId ?? nextCandidates[0]?.candidateId ?? null);
      lastStatusRef.current = nextRun.status;
      setFailure(null);
      return nextRun.status;
    } catch (error) {
      if (request === requestRef.current) setFailure(gatewayErrorMessage(error));
      return null;
    } finally { if (request === requestRef.current) setLoading(false); }
  }, [runId]);

  const resync = useCallback(async () => {
    const before = lastStatusRef.current;
    const next = await load(true);
    setSyncReport({ at: new Date().toISOString(), status: next, changed: next !== null && next !== before });
  }, [load]);

  useEffect(() => {
    setRun(null); setCandidates([]); setLandedCandidates([]); setPracticeQuota(null);
    setActiveCandidateId(null); setFailure(null); setSyncReport(null);
    lastStatusRef.current = null;
    void load(true);
    return () => { requestRef.current += 1; };
  }, [load]);

  useEffect(() => {
    if (!runId || !window.ailearn) return;
    let disposed = false;
    let subscriptionId: string | null = null;
    let unsubscribe: (() => void) | undefined;
    const api = window.ailearn;
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
   * **只在"还在做"的时候跑**。终态（待审核／已完成／失败…）之后这一屏不再自己变，
   * 继续轮询就只是白白消耗——而审核台上每点一次「保留」都已经自己重读过一次了。
   *
   * 它与事件流是**并联**而不是串联：流在，它把两次重读之间的空档补上；流被限流顶回、
   * 建不上、或者中途断了，这一屏照样往前走。窗口不可见时停——看不见的时候没有人在等
   * 那一列题面，重新可见时立刻补读一次。
   */
  const inFlight = Boolean(run && isCardGenerationInFlight(run.status));
  useEffect(() => {
    if (!runId || !inFlight) return;
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
  }, [runId, inFlight, load]);

  return { runId, run, candidates, landedCandidates, practiceQuota, activeCandidateId, setActiveCandidateId,
    loading, failure, noteTitle, waitingForRun: !runId && !runIdHealed, syncReport, epochRef, load, resync };
}
