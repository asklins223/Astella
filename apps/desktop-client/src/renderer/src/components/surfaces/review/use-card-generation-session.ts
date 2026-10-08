import { useCallback, useEffect, useRef, useState } from "react";
import type { CardActivationReceiptDesktopV1, CardGenerationCandidateV1, CardGenerationExposureEligibilityV1, DesktopCandidateRevealV2, DesktopCardRejectReasonV2 } from "@astella/shared/card-generation-desktop-contracts";
import { useRoomStore } from "../../../app/room-store";
import { createCommandId, createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../app/desktop-client";
import { resetObjectiveLibraryView } from "../run/objective-library-view-state";
import { cardGenerationObservedProgress, cardGenerationProgressView, isCardGenerationInFlight, isCardGenerationReviewOpen, isCardGenerationReviewStage, practiceQuotaLabel, reviewSchedulingNotice, saveOnlyReceiptNotice } from "./card-generation-status";
import { persistedGenerationOptions } from "../notebook/notebook-generation-options";
import { isActionableUndecidedCandidate, isActivatableCandidate } from "./candidate-review-model";
import { useCardGenerationData } from "./use-card-generation-data";

/** Writes remain authoritative; animation never decides whether a card was kept. */
export function useCardGenerationSession() {
  const data = useCardGenerationData();
  const { runId, run, candidates, activeCandidateId, setActiveCandidateId, load, epochRef } = data;
  const invoke = useRoomStore((state) => state.invoke);
  const setActiveNoteRef = useRoomStore((state) => state.setActiveNoteRef);
  const setReturnTarget = useRoomStore((state) => state.setReturnTarget);
  const [activation, setActivation] = useState<{ receipt: CardActivationReceiptDesktopV1; askedForScheduling: boolean } | null>(null);
  const [actionFailure, setActionFailure] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ revisionId: string; data: DesktopCandidateRevealV2 } | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [revealFailure, setRevealFailure] = useState<string | null>(null);
  const [exposure, setExposure] = useState<CardGenerationExposureEligibilityV1 | null>(null);
  const [exposureFailure, setExposureFailure] = useState<string | null>(null);
  const actionLock = useRef(false);
  const revealLock = useRef(false);
  const identity = useRef(runId);
  identity.current = runId;

  useEffect(() => {
    setActivation(null); setActionFailure(null); setBusyAction(null); setReveal(null);
    setRevealing(false); setRevealFailure(null); actionLock.current = false; revealLock.current = false;
  }, [runId]);

  const activeCandidate = candidates.find((candidate) => candidate.candidateId === activeCandidateId) ?? candidates[0] ?? null;
  const activeCandidateIndex = activeCandidate ? candidates.indexOf(activeCandidate) : 0;
  const reviewOpen = Boolean(run && isCardGenerationReviewOpen(run.status));
  const activeReveal = reveal?.revisionId === activeCandidate?.candidateRevisionId ? reveal?.data ?? null : null;
  const activatableCount = candidates.filter(isActivatableCandidate).length;
  const actionableUndecidedCount = candidates.filter(isActionableUndecidedCandidate).length;
  const practiceQuotaView = practiceQuotaLabel(data.practiceQuota);
  const progressCounts = cardGenerationObservedProgress(run?.progress, data.landedCandidates);
  const progressView = run ? cardGenerationProgressView(run.status, progressCounts) : null;
  const canRegenerate = Boolean(run && !isCardGenerationInFlight(run.status));
  // needs_attention also covers interrupted checks with only unaudited drafts.
  const page: "candidate" | "generating" = run && isCardGenerationReviewStage(run.status)
    && (run.status !== "needs_attention" || candidates.some(candidate => candidate.qualityState === "passed"
      && candidate.publishState === "unpublished" && candidate.candidateEvidenceBindingPlanHash !== null))
    ? "candidate" : "generating";
  const receipt = activation?.receipt ?? null;
  const schedulingNotice = activation ? activation.askedForScheduling
    ? reviewSchedulingNotice(activation.receipt.scheduling ?? []) : saveOnlyReceiptNotice() : null;

  const returnToNote = useCallback(() => {
    const current = useRoomStore.getState().activeNoteRef;
    if (run && current?.noteId !== run.sourceRef.noteId) setActiveNoteRef({ noteId: run.sourceRef.noteId, noteVersionId: run.sourceRef.noteVersionId });
    useRoomStore.getState().setNoteReturnTo("generation");
    invoke("open-notebook");
  }, [run, invoke, setActiveNoteRef]);

  useEffect(() => {
    setReturnTarget({ label: "返回笔记", run: returnToNote });
    return () => setReturnTarget(null);
  }, [returnToNote, setReturnTarget]);

  const runKey = run?.runId;
  const candidateKey = activeCandidate?.candidateId;
  const revision = activeCandidate?.revision;
  useEffect(() => {
    setExposure(null); setExposureFailure(null);
    if (!runKey || !reviewOpen || !candidateKey || revision === undefined || !window.astella) return;
    let active = true;
    void (async () => {
      try {
      const response = await window.astella.note.cardGeneration.exposure({ meta: createRequestMeta(epochRef.current), runId: runKey, candidateId: candidateKey, revision });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      if (active) setExposure(unwrapGatewayResult(response));
      } catch (error) { if (active) setExposureFailure(gatewayErrorMessage(error)); }
    })();
    return () => { active = false; };
  }, [runKey, reviewOpen, candidateKey, revision, reveal, epochRef]);

  const perform = async (key: string, write: () => Promise<void>): Promise<boolean> => {
    if (!run || !window.astella || actionLock.current || revealLock.current) return false;
    const scope = run.runId;
    actionLock.current = true; setBusyAction(key); setActionFailure(null);
    try {
      await write();
      return identity.current === scope;
    } catch (error) {
      if (identity.current === scope) setActionFailure(gatewayErrorMessage(error));
      return false;
    } finally {
      if (identity.current === scope) { actionLock.current = false; setBusyAction(null); }
    }
  };

  const review = (candidate: CardGenerationCandidateV1, decision: "keep" | "reject" | "undo", reasonCode?: DesktopCardRejectReasonV2) => perform(`${candidate.candidateId}:${decision}`, async () => {
    if (!run || !window.astella) return;
    const response = await window.astella.note.cardGeneration.review({
      meta: createRequestMeta(epochRef.current), commandId: createCommandId(`card-generation-${decision}`), runId: run.runId,
      request: { version: 2, runId: run.runId, expectedReviewDraftRevision: run.reviewDraftRevision,
        action: decision === "keep" ? { type: "keep", candidateId: candidate.candidateId, expectedRevision: candidate.revision, expectedRevisionHash: candidate.candidateRevisionHash }
          : decision === "reject" ? { type: "reject", candidateId: candidate.candidateId, expectedRevision: candidate.revision, expectedRevisionHash: candidate.candidateRevisionHash, reasonCode: reasonCode ?? "not_useful" }
            : { type: "undo_decision", candidateId: candidate.candidateId, expectedRevision: candidate.revision, expectedRevisionHash: candidate.candidateRevisionHash } },
    });
    if (identity.current !== run.runId) return;
    if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
    unwrapGatewayResult(response);
    if (decision === "undo") setActiveCandidateId(candidate.candidateId);
    else {
      const index = candidates.indexOf(candidate);
      const next = candidates.slice(index + 1).find(isActionableUndecidedCandidate) ?? candidates.find((item) => item.candidateId !== candidate.candidateId && isActionableUndecidedCandidate(item));
      if (next) setActiveCandidateId(next.candidateId);
    }
    setReveal(null); setRevealFailure(null);
    await load(false);
  });

  const revealCandidate = async (candidate: CardGenerationCandidateV1): Promise<boolean> => {
    if (!run || !window.astella || revealLock.current || actionLock.current) return false;
    const scope = run.runId;
    revealLock.current = true; setRevealing(true); setRevealFailure(null);
    try {
      const response = await window.astella.note.cardGeneration.reveal({
        meta: createRequestMeta(epochRef.current), commandId: createCommandId("card-generation-reveal"), runId: run.runId, candidateId: candidate.candidateId,
        request: { candidateId: candidate.candidateId, expectedCandidateRevision: candidate.revision, expectedCandidateRevisionHash: candidate.candidateRevisionHash },
      });
      if (identity.current !== scope) return false;
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      setReveal({ revisionId: candidate.candidateRevisionId, data: unwrapGatewayResult(response) });
      return true;
    } catch (error) { if (identity.current === scope) setRevealFailure(gatewayErrorMessage(error)); return false; }
    finally { if (identity.current === scope) { revealLock.current = false; setRevealing(false); } }
  };

  const activate = (startReviewScheduling: boolean) => perform(startReviewScheduling ? "activate-scheduling" : "activate", async () => {
    if (!run || !window.astella) return;
    const selected = candidates.filter(isActivatableCandidate);
    if (!selected.length) return;
    // 这里过去有一道硬闸：`actionableUndecidedCount > 0` 直接抛错，屏上那颗
    // 「保存到卡组」也是灰的，于是**必须把这一叠逐张判完**才能交出去。
    //
    // 代价是 8 张卡至少 8 次决定，而绝大多数人只想留下那 2、3 张。41 §1.5 对
    // 「往外学」的草稿早就定了口径——「不默认勾选」「只收选中的，不丢剩余缓冲」，
    // 卡片这边却要求逐张表态，是同一族设计里的两个答案。
    //
    // 现在按「保存已保留的 N 张」走：没决定的留在这一叠里，下次进来接着看，
    // 它们既不会被创建成卡，也不会因为这一次保存而失效。真正被丢掉的只有
    // 用户明确点过「不保留」的。
    const response = await window.astella.note.cardGeneration.activate({
      meta: createRequestMeta(epochRef.current), commandId: createCommandId(startReviewScheduling ? "card-generation-activate-review" : "card-generation-activate"), runId: run.runId,
      request: { version: 1, runId: run.runId, selectedCandidates: selected.map((candidate) => ({ candidateRevisionId: candidate.candidateRevisionId, candidateId: candidate.candidateId, revision: candidate.revision, revisionHash: candidate.candidateRevisionHash, candidateEvidenceBindingPlanHash: candidate.candidateEvidenceBindingPlanHash, intent: { kind: "create_new" } })), existingLifecycleActions: [], expectedReviewDraftRevision: run.reviewDraftRevision, startReviewScheduling },
    });
    if (identity.current !== run.runId) return;
    if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
    setActivation({ receipt: unwrapGatewayResult(response), askedForScheduling: startReviewScheduling });
    await load(false);
  });

  const cancel = () => perform("cancel", async () => {
    if (!run || !window.astella) return;
    const response = await window.astella.note.cardGeneration.cancel({ meta: createRequestMeta(epochRef.current), commandId: createCommandId("card-generation-cancel"), runId: run.runId });
    unwrapGatewayResult(response); if (identity.current === run.runId) await load(false);
  });
  const close = () => perform("close", async () => {
    if (!run || !window.astella) return;
    const response = await window.astella.note.cardGeneration.close({ meta: createRequestMeta(epochRef.current), commandId: createCommandId("card-generation-close"), runId: run.runId, expectedReviewDraftRevision: run.reviewDraftRevision });
    unwrapGatewayResult(response); if (identity.current === run.runId) await load(false);
  });
  const retry = () => perform("retry", async () => {
    if (!run || !window.astella) return;
    const response = await window.astella.note.cardGeneration.retry({ meta: createRequestMeta(epochRef.current), commandId: createCommandId("card-generation-retry"), runId: run.runId });
    unwrapGatewayResult(response); if (identity.current === run.runId) await load(false);
  });

  const regenerate = () => perform("regenerate", async () => {
    if (!run || !window.astella || !canRegenerate) return;
    const api = window.astella;
    // Read the latest saved source before ending the old review. A read failure
    // leaves that review intact; a start failure still leaves a usable retry.
    const noteResponse = await api.note.get({ meta: createRequestMeta(epochRef.current), noteId: run.noteId });
    if (identity.current !== run.runId) return;
    if (noteResponse.workspaceEpoch) epochRef.current = noteResponse.workspaceEpoch;
    const note = unwrapGatewayResult(noteResponse);
    if (!note.currentVersionId) throw new Error("没有读到笔记的已保存版本，请重新检查后再生成。");
    const currentResponse = await api.note.cardGeneration.getRun({ meta: createRequestMeta(epochRef.current), runId: run.runId });
    if (identity.current !== run.runId) return;
    if (currentResponse.workspaceEpoch) epochRef.current = currentResponse.workspaceEpoch;
    const current = unwrapGatewayResult(currentResponse);
    if (isCardGenerationInFlight(current.status)) { await load(false); return; }
    if (isCardGenerationReviewOpen(current.status)) {
      const ended = await api.note.cardGeneration.close({ meta: createRequestMeta(epochRef.current), commandId: createCommandId("card-generation-regenerate-close"), runId: current.runId, expectedReviewDraftRevision: current.reviewDraftRevision });
      unwrapGatewayResult(ended);
      if (ended.workspaceEpoch) epochRef.current = ended.workspaceEpoch;
      await load(false);
      if (identity.current !== run.runId) return;
    }
    const options = persistedGenerationOptions;
    const response = await api.note.cardGeneration.start({
      meta: createRequestMeta(epochRef.current), commandId: createCommandId("card-generation-regenerate"), noteId: note.noteId,
      request: { version: 2, noteVersionId: note.currentVersionId, sourceScope: { kind: "whole_note" }, learningGoal: options.learningGoal,
        detailThreshold: options.detailThreshold, quantity: { kind: "adaptive", hardMaxCards: options.hardMaxCards },
        preferredStrategies: [...options.preferredStrategies], clientRequestId: createCommandId("card-generation-request") },
    });
    if (identity.current !== run.runId) return;
    if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
    const accepted = unwrapGatewayResult(response);
    setActiveNoteRef({ noteId: note.noteId, noteVersionId: note.currentVersionId });
    useRoomStore.getState().setActiveCardGenerationRunId(accepted.runId);
  });

  const moveCandidate = (offset: -1 | 1) => {
    const next = candidates[activeCandidateIndex + offset];
    if (next && !actionLock.current && !revealLock.current) { setActiveCandidateId(next.candidateId); setRevealFailure(null); setActionFailure(null); }
  };
  const openRecoveryNote = (sourceRef: NonNullable<typeof run>["sourceRef"]) => { setActiveNoteRef(sourceRef); invoke("open-notebook"); };
  const openCards = () => { resetObjectiveLibraryView(); invoke("open-objectives"); };

  return { ...data, page, activeCandidate, activeCandidateIndex, reviewOpen, activeReveal, activatableCount, actionableUndecidedCount,
    practiceQuotaView, progressCounts, progressView, receipt, schedulingNotice, actionFailure, busyAction, revealing, revealFailure, exposure, exposureFailure,
    canRegenerate, regenerate, review, revealCandidate, activate, cancel, close, retry, moveCandidate, returnToNote, openRecoveryNote, openCards };
}

export type CardGenerationSession = ReturnType<typeof useCardGenerationSession>;
