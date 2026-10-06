import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  GripVertical,
  Link2,
  Lightbulb,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type {
  ArtifactPayload,
  LearningDraftPayload,
  LearningRendererDraftState,
  LearningTaskPublic,
  RelationEdgeKindV1,
  RepairOperationV1,
  StructuredPartAnswerV1,
  StructuredPartPublicV1,
} from "@ailearn/shared/learning-run-contracts";
import {
  ChoiceEditor,
  InteractionEditor,
  MatchingEditor,
  OrderingEditor,
  PartEditor,
  StructuredBundleEditor,
  TrueFalseEditor,
} from "./run-task-editors.tsx";
import type {
  GetLearningRunResultResponseV2,
  LearningRunAllowedActionV2,
  LearningRunPublicSnapshotV2,
  LearningRunReturnContractV2,
  LearningRunTargetRevealV2,
} from "@ailearn/shared/learning-run-v2-contracts";
import type { DesktopLearningRunActionRequestV2, DesktopRouteV1 } from "@ailearn/shared/desktop-ipc-contracts";
import {
  createCommandId,
  createRequestMeta,
  gatewayErrorMessage,
  RendererGatewayError,
  unwrapGatewayResult,
} from "../../../app/desktop-client";
import { AssessmentDisputeStrip } from "../review/assessment-dispute-strip.tsx";
import { useRoomStore } from "../../../app/room-store";
import { useCompanionHomeProjection } from "../../../app/companion-home-projection";
import { speakCompanionLine, type CompanionSpeechHandle } from "../../../app/companion-voice-playback";
import { HudPage } from "../../hud/HudPage";
import { useHudPage } from "../../hud/use-hud-page";
import { usePageReadableView } from "../../hud/use-page-readable-view";
import { HUD_PAGES } from "../../hud/hud-pages";
import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";
import { reviewTargetFromReturnContract } from "../../review-focus";
import { resultPollDelayMs } from "../../result-polling";
import { indexedPublicLabel } from "../../learning-run-labels";
import {
  activateLearningRunRequestFence,
  captureLearningRunRequest,
  createLearningRunRequestFence,
  deactivateLearningRunRequestFence,
  editorRevisionMatchesRequest,
  isLearningRunRequestCurrent,
  isLearningRunResultQueryCurrent,
  isLearningRunSnapshotResponseCurrent,
  learningRunResultMatchesRun,
  shouldClearPendingResultForSnapshot,
  shouldConfirmCompanionForOutcome,
  shouldPlayResultCeremony,
  shouldPollLearningRunResult,
  snapshotRequiresResolvedLearningResult,
} from "../../learning-run-result-policy";
import {
  ACTIVITY_LEASE_INTERVAL_MS,
  buildActivityLeaseWindow,
  isActivityLeaseEligible,
  type ActivityLeaseWindow,
} from "../../learning-run-activity-lease";
import { SurfaceDataState } from "../notebook/surface-data.tsx";
import { formatObjectiveDay } from "./objective-state-copy.ts";
import { ObjectiveProgressBand } from "./ObjectiveProgressBand.tsx";
import { progressSegmentForOutcome } from "./objective-progress-band.ts";
import { VoiceTeachbackEditor } from "./run-voice-input.tsx";
import { LearningRunCeremony } from "./LearningRunCeremony.tsx";
import { microphoneAvailabilityCopy, probeMicrophone, type MicrophoneAvailability } from "../../voice-capability";
import { companionResultFeedbackAllowed, ceremonyPresentation, learningDiscoveryCard, learningRunFeedback } from "./objective-quest-presentation.ts";
import {
  PlayerFailure,
  PlayerRecovery,
  ResultState,
  SEALLESS_OUTCOMES,
  TargetRevealState,
  actionIcon,
  actionKey,
  actionLabel,
  actionRequestFor,
  answerPreview,
  companionResultLine,
  editorFromDraft,
  eligibilityLabel,
  emptyEditor,
  facetLabels,
  facetText,
  formatClock,
  interactionLabel,
  needsLearningRunResync,
  outcomeSeal,
  payloadIsReady,
  phaseLabels,
  processingHeadlineFor,
  provenLedgerText,
  rendererStateFor,
  returnTargetLabel,
  routeForReturnTarget,
  runOriginLabel,
  scheduleImpactText,
  switchActionLabel,
  terminalCopy,
  thisTimeVerdicts,
  toDraftPayload,
  useLocalActiveClock,
  releaseRunThroughMainV1,
  verdictLabels,
} from "./learning-run-copy.tsx";
import { RunConfirmations } from "./run-confirmations.tsx";
import { LearningRunDiscovery } from "./learning-run-discovery.tsx";
import { LearningRunHint } from "./learning-run-hint.tsx";
import { LearningRunNextStep, LearningRunResultRubric } from "./learning-run-result-tail.tsx";
import { NoteRunReceipt } from "../notebook/note-run-receipt.tsx";
import { LearningRunArrival, LearningRunArrivalEvidence } from "./learning-run-arrival.tsx";
import { LearningRunEvidenceBand } from "./learning-run-evidence-band.tsx";
import { useTactileSurface } from "../../motion/use-tactile-surface";
import { useCardVisibleArrival } from "../../motion/card-object-spring";
import { LearningRunDock } from "./learning-run-dock.tsx";
import { LearningRunFocusRail, LearningRunQuestionHeading } from "./learning-run-focus-header.tsx";
import {
  LearningRunCheckpointNotice,
  LearningRunPreparing,
  LearningRunResultPending,
  LearningRunUnresolvedResult,
} from "./learning-run-wait-notice.tsx";

/**
 * 对外仍从这里引的三个名字——**保持既有 import 路径不变**。
 *
 * `ResumableSurface` / `notebook-surface` 一直是从 `./learning-run-surface` 引它们的。
 * 它们现在住在 `learning-run-copy` 里；这里转发一次，比去改三个调用方更小，
 * 也比在每个调用方改 import 路径更不容易漏。
 *
 * （按 `AGENTS.md`「没有需要维护的生产兼容性」那条，这里本可以直接改调用方。
 * 但转发的是**当前仍在用的调用方**，不是已废弃链路——转发到它们跑通之后再收更稳。）
 */
export { learningPhaseLabel, releaseRunThroughMainV1 } from "./learning-run-copy.tsx";

type LearningRunBodyProps = {
  readonly runId: string;
  readonly onExit: (request?: { route: DesktopRouteV1; objectiveId?: string; reflectionRoundId?: string }) => void;
  readonly onPageChange: (page: "assessment" | "result") => void;
};

  /**
   * 拆分去向（2026-09-29）与**还差什么**。
   *
   * ✅ 已搬走：1-709 行的 39 个纯函数/文案表/类型 → `learning-run-copy.tsx`；
   *   两个确认框（看提示 / 要停下来吗）→ `run-confirmations.tsx`；
   *   8 个任务型编辑器 → `run-task-editors.tsx`。
   *
   * ❌ **按 state 聚簇这条路在这个组件上不成立**——这是量出来的，不是猜的：
   *   34 个 useState 里 **26 个是孤立的**（没有同前缀的同伴），
   *   而仅有的三簇（`pending` / `draft` / `result`）的 setter **各散 5~12 个区段**：
   *   `result` 那一簇从 201 一直散到 1172，跨过整个取数—轮询—提交—回执的链路。
   *   把它们收进 hook 就要把这些链路一起搬，那是**重新设计**，不是拆分。
   *
   * 所以接下来只能按 **JSX 区块**切：外���符号少的那些（`learning-run-primary-content`
   * 18 行 / 13 符号就是当前最少的一个）。
   */

export function LearningRunBody({ runId, onExit, onPageChange }: LearningRunBodyProps) {
  const setActiveReviewTarget = useRoomStore((state) => state.setActiveReviewTarget);
  const setCompanionMoment = useRoomStore((state) => state.setCompanionMoment);
  const masterMuted = useRoomStore((state) => state.masterMuted);
  const companionTemporarilyHidden = useRoomStore((state) => state.companionTemporarilyHidden);
  const companionHome = useCompanionHomeProjection();
  const companionFeedbackAllowed = companionResultFeedbackAllowed({
    masterMuted,
    temporarilyHidden: companionTemporarilyHidden,
    activeness: companionHome.projection?.profileSummary.activeness ?? null,
    proactiveMuted: companionHome.projection?.roomProfile.proactiveMuted === true,
    allowPlayful: companionHome.projection?.profileSummary.boundaries.allowPlayful === true,
  });
  const [snapshot, setSnapshot] = useState<LearningRunPublicSnapshotV2 | null>(null);
  /**
   * 秒表与到点自动结束（复盘 #13）。
   *
   * 必须留在条件 return 之前的 hook 区里；`dispatchAction` 定义在后面，用 ref 转接
   * （渲染期赋值，定时器真正触发时必然已就绪）。
   */
  const autoEndedRef = useRef(false);
  const activityLeaseFlushRef = useRef<(() => Promise<void>) | null>(null);
  const dispatchActionRef = useRef<((action: LearningRunAllowedActionV2, bypassConfirmation?: boolean) => Promise<void>) | null>(null);
  const autoEndRun = useCallback(() => {
    if (autoEndedRef.current) return;
    autoEndedRef.current = true;
    const exit = (snapshot?.allowedActions ?? []).find(
      (action) => action.kind === "skip_run" || action.kind === "end",
    );
    // 到点自动结束不等用户再确认一次：这一刻可能根本没有人看着。
    if (exit) void dispatchActionRef.current?.(exit, true);
  }, [snapshot?.allowedActions]);
  const clock = useLocalActiveClock(
    snapshot?.phase === "active",
    snapshot?.activeSecondsUsed ?? 0,
    autoEndRun,
  );
  const [editor, setEditor] = useState<ArtifactPayload | null>(null);
  const [draftRevision, setDraftRevision] = useState(0);
  const [draftStatus, setDraftStatus] = useState("尚未输入");
  const [dirty, setDirty] = useState(false);
  const [draftWriteBusy, setDraftWriteBusy] = useState(false);
  const [draftWriteBlocked, setDraftWriteBlocked] = useState(false);
  const [orderingTouched, setOrderingTouched] = useState(false);
  const [structuredReviewReady, setStructuredReviewReady] = useState(false);
  const [restoredStructuredDraft, setRestoredStructuredDraft] = useState(false);
  const [voiceEditorBusy, setVoiceEditorBusy] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [resultState, setResultState] = useState<ResultState>({ kind: "idle" });
  const [targetReveal, setTargetReveal] = useState<TargetRevealState>({ kind: "idle" });
  const [returnContract, setReturnContract] = useState<LearningRunReturnContractV2 | null>(null);
  /**
   * 已放行的提示，按层级累积展示（2026-09-20 实走复盘 #11）。
   *
   * 此前第二级提示是一条**独立按钮**，还被塞进「更多选择」的 details 里——
   * 用户看到的就是"提示里面又套一层提示"。现在只有一个按钮：点一次放一级，
   * 文案跟着变，放到最后一级就禁用。downgraded 记录服务端是否因此把本卡
   * 计分降级为练习分（回执给了就必须说）。
   */
  const [hints, setHints] = useState<Array<{ level: number; text: string; downgraded: boolean }>>([]);
  const [failure, setFailure] = useState<PlayerFailure | null>(null);
  const [recovery, setRecovery] = useState<PlayerRecovery | null>(null);
  const [loading, setLoading] = useState(true);
  const [resyncing, setResyncing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pendingAction, setPendingAction] = useState<LearningRunAllowedActionV2 | null>(null);
  const [pendingHintAction, setPendingHintAction] = useState<Extract<LearningRunAllowedActionV2, { kind: "request_hint" }> | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [resultPollTick, setResultPollTick] = useState(0);
  const [resultQueryBusy, setResultQueryBusy] = useState(false);
  const [resultQueryBudgetExhausted, setResultQueryBudgetExhausted] = useState(false);
  /**
   * 等待评估期间的两样东西（2026-09-20 实走复盘 #6）：交上去的答案本身要留在屏上，
   * 以及"已经等了多久"。此前这段时间界面只剩一行字，提交按钮立刻变成"返回"，
   * 用户完全无法判断是在算还是死了。
   */
  const [lockedAnswer, setLockedAnswer] = useState<string | null>(null);
  const [waitingSeconds, setWaitingSeconds] = useState(0);
  const [resultQueryFailure, setResultQueryFailure] = useState<PlayerFailure | null>(null);
  const [resultAcknowledgementActive, setResultAcknowledgementActive] = useState(false);
  const [discoveryRevealed, setDiscoveryRevealed] = useState(false);
  const assessmentPending = resultState.kind === "pending"
    || snapshot?.phase === "assessing" || snapshot?.phase === "committing";
  /**
   * 答案锁定、进入评估之后，编辑区必须让位给等待面板（2026-09-20 实走复盘 #6）。
   * 服务端此时已经收下这份答案，界面却还留着可编辑的框和"提交回答"：再点一次只会
   * 撞上过期 revision 的 409，看起来就像"提交没反应"。
   */
  const canAnswerNow = !assessmentPending
    && snapshot !== null
    && snapshot.phase === "active"
    && snapshot.activeTask !== null;

  useEffect(() => {
    if (!assessmentPending) {
      setWaitingSeconds(0);
      return;
    }
    const timer = window.setInterval(() => setWaitingSeconds((current) => current + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [assessmentPending]);
  /**
   * 麦克风可用性：真探测，不再读主进程那个恒真的通道名检查（复盘 #8）。
   * `null` = 还没探完，此时先不下结论。
   */
  const [microphone, setMicrophone] = useState<MicrophoneAvailability | null>(null);
  const runRequestFenceRef = useRef(createLearningRunRequestFence(runId));
  const snapshotRequestGenerationRef = useRef(0);
  const acceptedSnapshotRef = useRef<{ runId: string; runRevision: number; snapshotId: string } | null>(null);
  const resultPollGenerationRef = useRef(0);
  const resultAcknowledgementEligibleRef = useRef(false);
  const acknowledgedResultKeyRef = useRef<string | null>(null);
  const resultSpeechRef = useRef<CompanionSpeechHandle | null>(null);
  const pendingResultFeedbackRef = useRef<{ line: string; moment: "confirm" | "encourage" } | null>(null);
  const draftWriteGenerationRef = useRef(0);
  const epochRef = useRef<number | undefined>(undefined);
  const taskKeyRef = useRef<string | null>(null);
  const editorRevisionRef = useRef(0);
  const dirtyRef = useRef(false);
  const activeSubscriptionRef = useRef<{ id: string; stop: () => void } | null>(null);
  const primaryHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const focusKeyRef = useRef<string | null>(null);
  const confirmationHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const hintConfirmationHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const confirmationReturnFocusRef = useRef<HTMLElement | null>(null);
  const recoveryHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const unavailableHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const primaryContentRef = useRef<HTMLDivElement | null>(null);
  const tactileRootRef = useRef<HTMLDivElement>(null);
  useTactileSurface(tactileRootRef, `${snapshot?.phase ?? "loading"}:${snapshot?.activeTask?.taskId ?? "none"}:${snapshot?.activeTask?.activeVariant.variantId ?? "none"}:${resultState.kind}`);
  useCardVisibleArrival(tactileRootRef, snapshot && snapshot.originV2.kind !== "note_round"
    ? `${snapshot.phase}:${snapshot.activeTask?.taskId ?? "none"}:${snapshot.activeTask?.activeVariant.variantId ?? "none"}:${resultState.kind}` : null);
  const discoveryResultKey = resultState.kind === "result"
    ? `${resultState.value.runId}:${resultState.value.result.snapshotId}:${resultState.value.result.outcome}`
    : null;
  const showResult = resultState.kind === "result" || resultState.kind === "terminal";
  const finishResultCeremony = useCallback(() => {
    setResultAcknowledgementActive(false);
  }, []);
  const playPendingResultFeedback = useCallback(() => {
    const cue = pendingResultFeedbackRef.current;
    pendingResultFeedbackRef.current = null;
    if (!cue || !companionFeedbackAllowed) return;
    setCompanionMoment(cue.moment);
    resultSpeechRef.current?.stop();
    // The voice is requested in the same result-frame as the visual arrival.
    // The shared audio host will speak only when unlocked, visible and unmuted.
    resultSpeechRef.current = speakCompanionLine(cue.line);
    if (cue.moment === "confirm") {
      window.dispatchEvent(new CustomEvent("ailearn:home-v2-sound", { detail: { kind: "success" } }));
    }
  }, [companionFeedbackAllowed, setCompanionMoment]);

  useEffect(() => {
    if (resultState.kind === "result" && !resultAcknowledgementActive) playPendingResultFeedback();
  }, [playPendingResultFeedback, resultAcknowledgementActive, resultState]);

  useEffect(() => {
    onPageChange(showResult ? "result" : "assessment");
  }, [onPageChange, showResult]);

  useEffect(() => {
    setDiscoveryRevealed(false);
  }, [discoveryResultKey]);

  useLayoutEffect(() => {
    const activeFence = activateLearningRunRequestFence(runRequestFenceRef.current, runId);
    runRequestFenceRef.current = activeFence;
    const mountedToken = captureLearningRunRequest(activeFence);

    return () => {
      if (isLearningRunRequestCurrent(mountedToken, runRequestFenceRef.current)) {
        runRequestFenceRef.current = deactivateLearningRunRequestFence(runRequestFenceRef.current);
      }
      // Clear the global presentation during the same commit that switches or
      // unmounts the run. A late response from this run cannot revive it.
      setCompanionMoment("idle");
    };
  }, [runId, setCompanionMoment]);

  const applyReturnContract = useCallback((contract: LearningRunReturnContractV2 | null) => {
    setReturnContract(contract);
    setActiveReviewTarget(contract ? reviewTargetFromReturnContract(contract) : null);
  }, [setActiveReviewTarget]);

  const requestSnapshotRefresh = useCallback(() => {
    // Invalidate any GET that started before the event requesting this refresh.
    snapshotRequestGenerationRef.current += 1;
    setRefreshTick((value) => value + 1);
  }, []);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    if (companionFeedbackAllowed) return;
    pendingResultFeedbackRef.current = null;
    resultSpeechRef.current?.stop();
    resultSpeechRef.current = null;
    setCompanionMoment("idle");
  }, [companionFeedbackAllowed, setCompanionMoment]);

  useEffect(() => () => {
    resultSpeechRef.current?.stop();
    resultSpeechRef.current = null;
  }, []);

  useEffect(() => {
    taskKeyRef.current = null;
    editorRevisionRef.current = 0;
    focusKeyRef.current = null;
    confirmationReturnFocusRef.current = null;
    resultAcknowledgementEligibleRef.current = false;
    acknowledgedResultKeyRef.current = null;
    pendingResultFeedbackRef.current = null;
    resultSpeechRef.current?.stop();
    resultSpeechRef.current = null;
    snapshotRequestGenerationRef.current += 1;
    acceptedSnapshotRef.current = null;
    draftWriteGenerationRef.current += 1;
    setSnapshot(null);
    setEditor(null);
    setDraftWriteBusy(false);
    setDraftWriteBlocked(false);
    setOrderingTouched(false);
    setStructuredReviewReady(false);
    setRestoredStructuredDraft(false);
    setVoiceEditorBusy(false);
    setReturnContract(null);
    setResultState({ kind: "idle" });
    setResultAcknowledgementActive(false);
    setResultQueryBusy(false);
    setResultQueryBudgetExhausted(false);
    setResultQueryFailure(null);
    setRecovery(null);
    setResyncing(false);
    setSubmitting(false);
    setActionBusy(false);
    setPendingAction(null);
    setPendingHintAction(null);
    setHints([]);
    setActiveReviewTarget(null);
    setCompanionMoment("idle");
  }, [runId, setActiveReviewTarget, setCompanionMoment]);

  useEffect(() => {
    let active = true;
    const probe = () => { void probeMicrophone().then((result) => { if (active) setMicrophone(result); }); };
    probe();
    // 用户去系统设置里授权后回到窗口就该恢复，不必重开这一题。
    window.addEventListener("focus", probe);
    return () => {
      active = false;
      window.removeEventListener("focus", probe);
    };
  }, [runId]);

  useEffect(() => {
    const content = primaryContentRef.current;
    if (!content) return;
    if (pendingAction || pendingHintAction) content.setAttribute("inert", "");
    else content.removeAttribute("inert");
    return () => content.removeAttribute("inert");
  }, [pendingAction, pendingHintAction]);

  useEffect(() => {
    if (!snapshot) return;
    const activeTask = snapshot.activeTask;
    const focusKey = resultState.kind === "result"
      ? "result"
      : resultState.kind === "terminal"
        ? "terminal"
        : resultQueryFailure && snapshotRequiresResolvedLearningResult(snapshot.phase)
          ? `result-error:${snapshot.phase}`
        : resultState.kind === "pending" || ["assessing", "committing"].includes(snapshot.phase)
          ? `processing:${snapshot.phase}`
          : activeTask && snapshot.phase === "active"
            ? `task:${activeTask.taskId}:${activeTask.revision}:${activeTask.activeVariant.variantId}:${activeTask.activeVariant.revision}`
            : `phase:${snapshot.phase}`;
    if (resultState.kind === "result" && resultAcknowledgementActive) return;
    if (focusKeyRef.current === focusKey || !primaryHeadingRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const heading = primaryHeadingRef.current;
      // A confirmation or result ceremony may have opened since this frame was queued.
      if (!heading || heading.closest('[inert], [aria-hidden="true"]')) return;
      focusKeyRef.current = focusKey;
      heading.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [resultAcknowledgementActive, resultQueryFailure, resultState, snapshot]);

  useEffect(() => {
    if (!recovery) return;
    const frame = window.requestAnimationFrame(() => recoveryHeadingRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [recovery]);

  useEffect(() => {
    if (snapshot || !failure) return;
    const frame = window.requestAnimationFrame(() => unavailableHeadingRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [failure, snapshot]);

  const loadSnapshot = useCallback(async (forceTaskResync = false) => {
    if (!window.ailearn) {
      throw new Error("desktop API is unavailable");
    }
    const requestToken = captureLearningRunRequest(runRequestFenceRef.current);
    const requestGeneration = snapshotRequestGenerationRef.current + 1;
    snapshotRequestGenerationRef.current = requestGeneration;
    const response = await window.ailearn.learningRun.get({ meta: createRequestMeta(epochRef.current), runId }).catch((error: unknown) => {
      if (requestGeneration !== snapshotRequestGenerationRef.current
        || !isLearningRunRequestCurrent(requestToken, runRequestFenceRef.current)) return null;
      throw error;
    });
    if (!response) return false;
    if (requestGeneration !== snapshotRequestGenerationRef.current
      || !isLearningRunRequestCurrent(requestToken, runRequestFenceRef.current)) return false;
    const next = unwrapGatewayResult(response);
    if (next.runId !== requestToken.runId) throw new Error("LearningRun snapshot binding does not match the requested run");
    const accepted = acceptedSnapshotRef.current?.runId === requestToken.runId ? acceptedSnapshotRef.current : null;
    if (!isLearningRunSnapshotResponseCurrent({
      token: requestToken,
      fence: runRequestFenceRef.current,
      requestGeneration,
      currentRequestGeneration: snapshotRequestGenerationRef.current,
      responseRunId: next.runId,
      responseRunRevision: next.runRevision,
      acceptedRunRevision: accepted?.runRevision ?? null,
    })) return false;
    if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
    acceptedSnapshotRef.current = { runId: next.runId, runRevision: next.runRevision, snapshotId: next.snapshotId };
    if (next.phase === "assessing" || next.phase === "committing") {
      resultAcknowledgementEligibleRef.current = true;
    }
    if (shouldClearPendingResultForSnapshot(next.phase)) {
      setResultState((current) => current.kind === "pending" ? { kind: "idle" } : current);
      setResultQueryFailure(null);
      setResultQueryBudgetExhausted(false);
    }
    setSnapshot(next);
    setFailure(null);

    const activeTask = next.activeTask;
    if (!activeTask) return true;
    const previousTaskKey = taskKeyRef.current;
    if (forceTaskResync) taskKeyRef.current = null;
    const taskKey = `${activeTask.taskId}:${activeTask.revision}:${activeTask.activeVariant.variantId}:${activeTask.activeVariant.revision}`;
    if (taskKeyRef.current === taskKey) return true;
    // 同步（forceTaskResync）落在同一个任务上、且本地还有未保存输入时，
    // 保留编辑器内容，只对齐服务端草稿 revision——否则同步会清掉用户输入。
    const preserveLocalInput = previousTaskKey === taskKey && dirtyRef.current && editorRevisionRef.current > 0;
    taskKeyRef.current = taskKey;
    setHints([]);
    draftWriteGenerationRef.current += 1;
    setDraftWriteBusy(false);
    setDraftWriteBlocked(false);
    if (!preserveLocalInput) {
      editorRevisionRef.current = 0;
      setEditor(emptyEditor(activeTask));
      setDraftRevision(0);
      setDraftStatus("尚未输入");
      setDirty(false);
      setOrderingTouched(false);
      setStructuredReviewReady(false);
      setRestoredStructuredDraft(false);
      setVoiceEditorBusy(false);
    }
    const draftEditorRevision = editorRevisionRef.current;

    const draftResponse = await window.ailearn.learningRun.getDraft({ meta: createRequestMeta(epochRef.current), runId, taskId: activeTask.taskId }).catch((error: unknown) => {
      if (requestGeneration !== snapshotRequestGenerationRef.current
        || !isLearningRunRequestCurrent(requestToken, runRequestFenceRef.current)
        || acceptedSnapshotRef.current?.snapshotId !== next.snapshotId) return null;
      throw error;
    });
    if (!draftResponse) return false;
    if (requestGeneration !== snapshotRequestGenerationRef.current
      || !isLearningRunRequestCurrent(requestToken, runRequestFenceRef.current)
      || acceptedSnapshotRef.current?.snapshotId !== next.snapshotId) return false;
    if (taskKeyRef.current !== taskKey) return true;
    if (draftResponse.workspaceEpoch) epochRef.current = draftResponse.workspaceEpoch;
    const draft = unwrapGatewayResult(draftResponse);
    if (draft) {
      if (draft.runId !== next.runId
        || draft.taskId !== activeTask.taskId
        || draft.variantId !== activeTask.activeVariant.variantId
        || draft.taskRevision !== activeTask.revision) {
        throw new Error("LearningRun draft binding does not match the accepted snapshot");
      }
      setDraftRevision(draft.draftRevision);
      if (preserveLocalInput) {
        setDirty(true);
        setDraftStatus("已保留本地未同步输入，正在继续保存…");
      } else if (editorRevisionMatchesRequest(draftEditorRevision, editorRevisionRef.current)) {
        setDraftStatus("已找回你没写完的草稿");
        if (draft.payload) {
          setEditor(editorFromDraft(draft.payload));
          if (draft.payload.kind === "ordering") setOrderingTouched(true);
          if (draft.payload.kind === "structured_bundle") setRestoredStructuredDraft(true);
        }
      } else {
        setDraftStatus("已取回草稿；你刚写的还没存上");
      }
    } else if (preserveLocalInput) {
      setDraftRevision(0);
      setDirty(true);
      setDraftStatus("已保留本地未同步输入，正在继续保存…");
    }
    return true;
  }, [runId]);

  const resyncLearningRun = useCallback(async (kind: PlayerRecovery) => {
    if (!window.ailearn || resyncing) return;
    setResyncing(true);
    setLoading(true);
    setFailure(null);
    try {
      const loaded = await loadSnapshot(true);
      if (!loaded) return;
      if (kind !== "draft") setResultPollTick((value) => value + 1);
      setRecovery(null);
      focusKeyRef.current = null;
      if (!dirtyRef.current) setDraftStatus(kind === "draft" ? "草稿已存好" : "进度已存好");
    } catch (error) {
      setFailure({ message: gatewayErrorMessage(error), retryable: error instanceof RendererGatewayError && error.retry !== "never" });
    } finally {
      setResyncing(false);
      setLoading(false);
    }
  }, [loadSnapshot, resyncing]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void loadSnapshot()
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.log("SCRATCH-LOADFAIL", error);
        if (!active) return;
        setFailure({ message: gatewayErrorMessage(error), retryable: error instanceof RendererGatewayError && error.retry !== "never" });
      })
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [loadSnapshot, refreshTick]);

  useEffect(() => {
    let active = true;
    let subscriptionId: string | null = null;
    const subscribe = async () => {
      if (!window.ailearn) return;
      try {
        const response = await window.ailearn.subscriptions.subscribe({ meta: createRequestMeta(epochRef.current), topic: { kind: "learningRun", runId } });
        if (!active) return;
        if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
        subscriptionId = unwrapGatewayResult(response).subscriptionId;
        const stop = window.ailearn.subscriptions.onEvent(subscriptionId, requestSnapshotRefresh);
        activeSubscriptionRef.current = { id: subscriptionId, stop };
      } catch {
        // GET/resync remains authoritative. A missing stream never creates a
        // fake result or unlocks Companion context.
      }
    };
    void subscribe();
    return () => {
      active = false;
      activeSubscriptionRef.current?.stop();
      if (subscriptionId && window.ailearn) {
        void window.ailearn.subscriptions.unsubscribe({ meta: createRequestMeta(epochRef.current), subscriptionId });
      }
      activeSubscriptionRef.current = null;
    };
  }, [requestSnapshotRefresh, runId]);

  useEffect(() => {
    const activeSnapshot = snapshot;
    const activeTask = activeSnapshot?.activeTask;
    if (!activeSnapshot || activeSnapshot.phase !== "active" || !activeTask || !window.ailearn) return;

    let active = true;
    let activeWindowStartedAtMs: number | null = null;
    let sending: Promise<void> | null = null;
    const pendingWindows: ActivityLeaseWindow[] = [];

    const drain = (): Promise<void> => {
      if (sending) return sending;
      if (pendingWindows.length === 0 || !window.ailearn) return Promise.resolve();
      sending = (async () => {
        while (pendingWindows.length && window.ailearn) {
          const next = pendingWindows[0];
          try {
            const response = await window.ailearn.learningRun.recordActivityLease({
              meta: createRequestMeta(epochRef.current),
              runId,
              request: {
                version: 2,
                snapshotId: activeSnapshot.snapshotId,
                runRevision: activeSnapshot.runRevision,
                runtimeEpoch: activeSnapshot.runtimeEpoch,
                startedAt: next.startedAt,
                endedAt: next.endedAt,
              },
            });
            if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
            unwrapGatewayResult(response);
          } catch {
            // Keep the exact segment for the next eligible tick. An accounting
            // failure must not prevent the user from submitting their answer.
            break;
          }
          if (pendingWindows[0] === next) pendingWindows.shift();
          if (active) requestSnapshotRefresh();
        }
      })().finally(() => { sending = null; });
      return sending;
    };

    const enqueueWindow = (startedAtMs: number, endedAtMs: number) => {
      const next = buildActivityLeaseWindow(startedAtMs, endedAtMs, endedAtMs);
      if (!next) return;
      pendingWindows.push(next);
      void drain();
    };

    const flushActiveWindow = () => {
      if (activeWindowStartedAtMs === null) return;
      const startedAtMs = activeWindowStartedAtMs;
      activeWindowStartedAtMs = null;
      enqueueWindow(startedAtMs, Date.now());
    };
    const flushBeforeCommand = async () => {
      flushActiveWindow();
      await drain();
      if (active && document.visibilityState === "visible" && document.hasFocus()) {
        activeWindowStartedAtMs ??= Date.now();
      }
    };
    activityLeaseFlushRef.current = flushBeforeCommand;

    const syncEligibility = () => {
      const eligible = isActivityLeaseEligible({
        phase: activeSnapshot.phase,
        hasActiveTask: activeSnapshot.activeTask !== null,
        visibilityState: document.visibilityState,
        documentFocused: typeof document.hasFocus === "function" ? document.hasFocus() : true,
      });
      const nowMs = Date.now();
      if (!eligible) {
        flushActiveWindow();
        return;
      }
      if (activeWindowStartedAtMs === null) {
        activeWindowStartedAtMs = nowMs;
      } else if (nowMs - activeWindowStartedAtMs >= ACTIVITY_LEASE_INTERVAL_MS) {
        const startedAtMs = activeWindowStartedAtMs;
        activeWindowStartedAtMs = nowMs;
        enqueueWindow(startedAtMs, nowMs);
      }
      void drain();
    };

    syncEligibility();
    const timer = window.setInterval(syncEligibility, ACTIVITY_LEASE_INTERVAL_MS);
    const onVisibilityChange = () => syncEligibility();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", syncEligibility);
    window.addEventListener("blur", syncEligibility);

    return () => {
      active = false;
      if (activityLeaseFlushRef.current === flushBeforeCommand) activityLeaseFlushRef.current = null;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", syncEligibility);
      window.removeEventListener("blur", syncEligibility);
      flushActiveWindow();
      void drain();
    };
  }, [requestSnapshotRefresh, runId, snapshot?.activeTask?.revision, snapshot?.activeTask?.taskId, snapshot?.phase, snapshot?.runRevision, snapshot?.runtimeEpoch, snapshot?.snapshotId]);

  useEffect(() => {
    const activeTask = snapshot?.activeTask;
    if (!dirty || !editor || !activeTask || snapshot.phase !== "active" || loading || draftWriteBusy || draftWriteBlocked || submitting || resyncing || recovery === "draft") return;
    const revision = editorRevisionRef.current;
    const requestToken = captureLearningRunRequest(runRequestFenceRef.current);
    const taskKey = `${activeTask.taskId}:${activeTask.revision}:${activeTask.activeVariant.variantId}:${activeTask.activeVariant.revision}`;
    const timer = window.setTimeout(async () => {
      if (revision !== editorRevisionRef.current || !window.ailearn) return;
      const payload = toDraftPayload(editor);
      if (!payload) return;
      const writeGeneration = draftWriteGenerationRef.current + 1;
      draftWriteGenerationRef.current = writeGeneration;
      setDraftWriteBusy(true);
      setDraftStatus("正在保存草稿…");
      try {
        const response = await window.ailearn.learningRun.saveDraft({
          meta: createRequestMeta(epochRef.current),
          commandId: createCommandId("draft"),
          runId,
          taskId: activeTask.taskId,
          request: {
            version: 2,
            snapshotId: snapshot.snapshotId,
            variantId: activeTask.activeVariant.variantId,
            variantRevision: activeTask.activeVariant.revision,
            taskRevision: activeTask.revision,
            expectedDraftRevision: draftRevision,
            payload,
            rendererState: rendererStateFor(editor),
          },
        });
        if (!isLearningRunRequestCurrent(requestToken, runRequestFenceRef.current)
          || taskKeyRef.current !== taskKey) return;
        if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
        const receipt = unwrapGatewayResult(response);
        if (receipt.runId !== requestToken.runId
          || receipt.snapshotId !== snapshot.snapshotId
          || receipt.taskId !== activeTask.taskId
          || receipt.variantId !== activeTask.activeVariant.variantId
          || receipt.taskRevision !== activeTask.revision) {
          throw new Error("LearningRun draft receipt binding does not match the write request");
        }
        setDraftRevision(receipt.draftRevision);
        if (editorRevisionMatchesRequest(revision, editorRevisionRef.current)) {
          setDirty(false);
          setDraftWriteBlocked(false);
          setDraftStatus("草稿已保存");
          setRecovery(null);
        } else {
          // Keep the newer editor state dirty. Updating draftRevision causes
          // this effect to schedule its next write against the exact receipt.
          setDirty(true);
          setDraftStatus("有更新修改，正在继续保存…");
        }
      } catch (error) {
        if (!isLearningRunRequestCurrent(requestToken, runRequestFenceRef.current)
          || taskKeyRef.current !== taskKey) return;
        if (needsLearningRunResync(error)) {
          setDraftWriteBlocked(true);
          setRecovery("draft");
          setFailure({ message: gatewayErrorMessage(error), retryable: false });
          setDraftStatus("草稿没存上，先重新读一次再继续");
        } else {
          setDraftWriteBlocked(true);
          setDraftStatus(gatewayErrorMessage(error));
        }
      } finally {
        if (writeGeneration === draftWriteGenerationRef.current
          && isLearningRunRequestCurrent(requestToken, runRequestFenceRef.current)
          && taskKeyRef.current === taskKey) {
          setDraftWriteBusy(false);
        }
      }
    }, 650);
    return () => window.clearTimeout(timer);
  }, [dirty, draftRevision, draftWriteBlocked, draftWriteBusy, editor, loading, recovery, resyncing, runId, snapshot, submitting]);

  const queryResult = useCallback(async (pollGeneration: number) => {
    if (!window.ailearn) return true;
    const requestToken = captureLearningRunRequest(runRequestFenceRef.current);
    const requestIsCurrent = () => isLearningRunResultQueryCurrent(
      requestToken,
      runRequestFenceRef.current,
      pollGeneration,
      resultPollGenerationRef.current,
    );
    const response = await window.ailearn.learningRun.getResult({ meta: createRequestMeta(epochRef.current), runId });
    if (!requestIsCurrent()) return true;
    if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
    const value = unwrapGatewayResult(response);
    if (!learningRunResultMatchesRun(value, requestToken.runId)) {
      throw new Error("LearningRun result binding does not match the requested run");
    }
    setResultQueryFailure(null);
    if (value.status === "pending") {
      if (shouldClearPendingResultForSnapshot(value.phase)) {
        setResultState({ kind: "idle" });
        setResultQueryBudgetExhausted(false);
        requestSnapshotRefresh();
        return true;
      }
      if (value.phase === "assessing" || value.phase === "committing") {
        resultAcknowledgementEligibleRef.current = true;
      }
      setResultState({ kind: "pending", phase: value.phase });
      return false;
    }
    setResultQueryBudgetExhausted(false);
    if (value.status === "learning_result") {
      setResultState({ kind: "result", value });
      const resultKey = `${value.runId}:${value.result.snapshotId}:${value.result.outcome}`;
      const isFreshResult = resultAcknowledgementEligibleRef.current
        && acknowledgedResultKeyRef.current !== resultKey;
      const notePractice = snapshot?.originV2.kind === "note_round";
      const playsCeremony = !notePractice && isFreshResult && shouldPlayResultCeremony(value.result.outcome);
      const confirmsCompanion = shouldConfirmCompanionForOutcome(value.result.outcome);
      const hasPositiveCompanionFeedback = ["demonstrated", "practice_completed", "partial"].includes(value.result.outcome);
      if (isFreshResult) {
        acknowledgedResultKeyRef.current = resultKey;
        setResultAcknowledgementActive(playsCeremony);
        if (!notePractice && companionFeedbackAllowed && hasPositiveCompanionFeedback) {
          pendingResultFeedbackRef.current = {
            moment: confirmsCompanion ? "confirm" : "encourage",
            line: companionResultLine(value.result, snapshot?.target.publicSummary ?? "这张学习卡", resultKey),
          };
        } else {
          pendingResultFeedbackRef.current = null;
          resultSpeechRef.current?.stop();
          resultSpeechRef.current = null;
          setCompanionMoment("idle");
        }
      } else {
        // skipped / declared_unable / repair and restored terminal results are
        // deliberately neutral and never reuse the success presentation.
        setResultAcknowledgementActive(false);
        pendingResultFeedbackRef.current = null;
        setCompanionMoment("idle");
      }
    } else {
      setResultState({ kind: "terminal", value });
      setResultAcknowledgementActive(false);
      pendingResultFeedbackRef.current = null;
      setCompanionMoment("idle");
    }
    if (!requestIsCurrent()) return true;
    try {
      const returnResponse = await window.ailearn.learningRun.getReturnContract({ meta: createRequestMeta(epochRef.current), runId });
      if (!requestIsCurrent()) return true;
      if (returnResponse.workspaceEpoch) epochRef.current = returnResponse.workspaceEpoch;
      const contract = unwrapGatewayResult(returnResponse);
      if (contract.runId !== requestToken.runId) throw new Error("LearningRun return binding does not match the requested run");
      applyReturnContract(contract);
    } catch {
      if (requestIsCurrent()) applyReturnContract(null);
    }
    return true;
  }, [applyReturnContract, companionFeedbackAllowed, requestSnapshotRefresh, runId, setCompanionMoment, snapshot?.originV2.kind, snapshot?.target.publicSummary]);

  useEffect(() => {
    if (!snapshot || snapshot.runId !== runId || !shouldPollLearningRunResult(snapshot.phase)) return;
    let active = true;
    const pollGeneration = resultPollGenerationRef.current + 1;
    resultPollGenerationRef.current = pollGeneration;
    const startedAt = Date.now();
    let timer: number | undefined;
    setResultQueryBudgetExhausted(false);
    const poll = async (attempt: number) => {
      if (!active) return;
      setResultQueryBusy(true);
      try {
        const complete = await queryResult(pollGeneration);
        if (!active || complete) return;
        const delay = resultPollDelayMs(attempt, Date.now() - startedAt);
        if (delay === null) {
          setResultQueryBudgetExhausted(true);
          return;
        }
        timer = window.setTimeout(() => void poll(attempt + 1), delay);
      } catch (error) {
        if (active) setResultQueryFailure({ message: gatewayErrorMessage(error), retryable: true });
      } finally {
        if (active) setResultQueryBusy(false);
      }
    };
    void poll(0);
    return () => {
      active = false;
      if (resultPollGenerationRef.current === pollGeneration) resultPollGenerationRef.current += 1;
      if (timer) window.clearTimeout(timer);
    };
  }, [queryResult, resultPollTick, runId, snapshot?.phase, snapshot?.runId]);

  const updateEditor = (next: ArtifactPayload) => {
    editorRevisionRef.current += 1;
    setEditor(next);
    if (next.kind === "ordering") setOrderingTouched(true);
    if (next.kind === "structured_bundle") setStructuredReviewReady(false);
    setDirty(true);
    setDraftWriteBlocked(false);
    setDraftStatus(recovery === "draft" ? "先把草稿存上，再继续写" : "有未保存修改");
  };

  const submit = async (payload: ArtifactPayload) => {
    if (!snapshot?.activeTask || !window.ailearn || submitting || resyncing || recovery !== null || (payload.kind === "voice" && voiceEditorBusy)) return;
    if (payload.kind === "ordering" && !orderingTouched) {
      setDraftStatus("先调整一次顺序，确认这不是题目给出的随机初始排列");
      return;
    }
    if (payload.kind === "structured_bundle" && !structuredReviewReady) {
      setDraftStatus("先完成全部片段并复核整组答案，再提交");
      return;
    }
    if (payload.kind !== "declared_unable" && !payloadIsReady(payload, snapshot.activeTask)) {
      setDraftStatus("先完成当前任务，再提交可信证据");
      return;
    }
    const requestToken = captureLearningRunRequest(runRequestFenceRef.current);
    setSubmitting(true);
    setFailure(null);
    try {
      await activityLeaseFlushRef.current?.();
      if (!isLearningRunRequestCurrent(requestToken, runRequestFenceRef.current)) return;
      const response = await window.ailearn.learningRun.submit({
        meta: createRequestMeta(epochRef.current),
        commandId: createCommandId("submit"),
        runId,
        taskId: snapshot.activeTask.taskId,
        request: {
          version: 2,
          snapshotId: snapshot.snapshotId,
          variantId: snapshot.activeTask.activeVariant.variantId,
          variantRevision: snapshot.activeTask.activeVariant.revision,
          runRevision: snapshot.runRevision,
          taskRevision: snapshot.activeTask.revision,
          inputSchemaHash: snapshot.activeTask.activeVariant.inputSchemaHash,
          payload,
        },
      });
      if (!isLearningRunRequestCurrent(requestToken, runRequestFenceRef.current)) return;
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      const receipt = unwrapGatewayResult(response);
      if (receipt.runId !== requestToken.runId
        || receipt.snapshotId !== snapshot.snapshotId
        || receipt.taskId !== snapshot.activeTask.taskId
        || receipt.taskRevision !== snapshot.activeTask.revision) {
        throw new Error("LearningRun submission receipt binding does not match the request");
      }
      const accepted = acceptedSnapshotRef.current?.runId === receipt.runId ? acceptedSnapshotRef.current : null;
      if (!accepted || receipt.runRevision >= accepted.runRevision) {
        acceptedSnapshotRef.current = {
          runId: receipt.runId,
          runRevision: receipt.runRevision,
          snapshotId: receipt.snapshotId,
        };
      }
      setDirty(false);
      setLockedAnswer(answerPreview(payload));
      setDraftStatus("回答已锁定，正在评估");
      setRecovery(null);
      resultAcknowledgementEligibleRef.current = true;
      setResultPollTick((value) => value + 1);
      setResultState({ kind: "pending", phase: "assessing" });
      setResultQueryBudgetExhausted(false);
      requestSnapshotRefresh();
    } catch (error) {
      if (!isLearningRunRequestCurrent(requestToken, runRequestFenceRef.current)) return;
      const shouldResync = needsLearningRunResync(error);
      if (shouldResync) {
        setRecovery("submit");
        setDraftStatus("上一次提交没回音，先重新读一次再操作");
      }
      setFailure({ message: gatewayErrorMessage(error), retryable: !shouldResync && error instanceof RendererGatewayError && error.retry !== "never" });
    } finally {
      if (isLearningRunRequestCurrent(requestToken, runRequestFenceRef.current)) setSubmitting(false);
    }
  };

  const dispatchAction = async (action: LearningRunAllowedActionV2, bypassConfirmation = false) => {
    if (!snapshot || !window.ailearn || actionBusy || resyncing || recovery !== null) return;
    if (!bypassConfirmation && "confirmationRequired" in action && action.confirmationRequired) {
      confirmationReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setPendingAction(action);
      return;
    }
    const requestToken = captureLearningRunRequest(runRequestFenceRef.current);
    setActionBusy(true);
    try {
      await activityLeaseFlushRef.current?.();
      if (!isLearningRunRequestCurrent(requestToken, runRequestFenceRef.current)) return;
      const response = await window.ailearn.learningRun.action({
        meta: createRequestMeta(epochRef.current),
        commandId: createCommandId("action"),
        runId,
        request: {
          version: 2,
          snapshotId: snapshot.snapshotId,
          runRevision: snapshot.runRevision,
          ...(snapshot.activeTask ? { taskRevision: snapshot.activeTask.revision } : {}),
          runtimeEpoch: snapshot.runtimeEpoch,
          action: actionRequestFor(action),
        },
      });
      if (!isLearningRunRequestCurrent(requestToken, runRequestFenceRef.current)) return;
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      const value = unwrapGatewayResult(response);
      const accepted = acceptedSnapshotRef.current?.runId === value.snapshot.runId ? acceptedSnapshotRef.current : null;
      if (accepted && value.snapshot.runRevision < accepted.runRevision) {
        requestSnapshotRefresh();
        return;
      }
      snapshotRequestGenerationRef.current += 1;
      acceptedSnapshotRef.current = {
        runId: value.snapshot.runId,
        runRevision: value.snapshot.runRevision,
        snapshotId: value.snapshot.snapshotId,
      };
      if (value.snapshot.phase === "assessing" || value.snapshot.phase === "committing") {
        resultAcknowledgementEligibleRef.current = true;
      }
      if (shouldClearPendingResultForSnapshot(value.snapshot.phase)) {
        setResultState((current) => current.kind === "pending" ? { kind: "idle" } : current);
        setResultQueryFailure(null);
        setResultQueryBudgetExhausted(false);
      }
      setFailure(null);
      setRecovery(null);
      if (value.actionResult.kind === "hint_revealed") {
        const revealed = value.actionResult;
        setHints((current) => [
          ...current.filter((entry) => entry.level !== revealed.level),
          {
            level: revealed.level,
            text: revealed.text,
            downgraded: revealed.resultingTrustCeiling === "practice_only",
          },
        ].sort((left, right) => left.level - right.level));
      }
      if (action.kind === "end" || action.kind === "skip_run") setResultPollTick((value) => value + 1);
      const changedTask = action.kind === "switch_variant"
        || action.kind === "activate_followup";
      await loadSnapshot(changedTask);
    } catch (error) {
      if (!isLearningRunRequestCurrent(requestToken, runRequestFenceRef.current)) return;
      const shouldResync = needsLearningRunResync(error);
      if (shouldResync) {
        setRecovery("action");
        setDraftStatus("上一步没回音，先重新读一次再操作");
      }
      setFailure({ message: gatewayErrorMessage(error), retryable: !shouldResync && error instanceof RendererGatewayError && error.retry !== "never" });
    } finally {
      if (isLearningRunRequestCurrent(requestToken, runRequestFenceRef.current)) {
        setActionBusy(false);
        setPendingAction(null);
      }
    }
  };
  dispatchActionRef.current = dispatchAction;

  const closeConfirmation = () => {
    const returnFocus = confirmationReturnFocusRef.current;
    confirmationReturnFocusRef.current = null;
    setPendingAction(null);
    window.requestAnimationFrame(() => {
      const canRestore = returnFocus
        && returnFocus.isConnected
        && returnFocus !== document.body
        && returnFocus !== document.documentElement
        && !returnFocus.closest("[inert], [aria-hidden='true']");
      if (canRestore) {
        returnFocus.focus({ preventScroll: true });
      } else {
        primaryHeadingRef.current?.focus({ preventScroll: true });
      }
    });
  };

  const confirmPendingAction = async () => {
    const action = pendingAction;
    if (!action) return;
    setPendingAction(null);
    await dispatchAction(action, true);
  };

  const closeHintConfirmation = () => {
    setPendingHintAction(null);
    window.requestAnimationFrame(() => primaryHeadingRef.current?.focus({ preventScroll: true }));
  };

  const confirmHint = async () => {
    const action = pendingHintAction;
    if (!action) return;
    setPendingHintAction(null);
    await dispatchAction(action, true);
  };

  const handleConfirmationKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeConfirmation();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [confirmationHeadingRef.current, ...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled)")]
      .filter((element): element is HTMLElement => Boolean(element));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  useEffect(() => {
    if (!pendingAction) return;
    const frame = window.requestAnimationFrame(() => confirmationHeadingRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [pendingAction]);

  useEffect(() => {
    if (!pendingHintAction) return;
    const frame = window.requestAnimationFrame(() => hintConfirmationHeadingRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [pendingHintAction]);

  /**
   * 语音替代项在麦克风不可用时**保留但禁用**，并把原因写在旁边（复盘 #8）：
   * 直接把它藏起来，用户只会以为"根本没有换一种方式这回事"。
   */
  const microphoneUnavailable = microphone !== null && microphone.state !== "ready";
  const microphoneReason = microphoneUnavailable ? microphoneAvailabilityCopy(microphone!) : "";
  const blockedSwitchIds = new Set(microphoneUnavailable
    ? (snapshot?.activeTask?.availableAlternatives ?? [])
      .filter((alternative) => alternative.family === "voice")
      .map((alternative) => alternative.alternativeId)
    : []);
  const alternativeActions = useMemo(
    () => snapshot?.allowedActions.filter((action) => action.kind === "switch_variant") ?? [],
    [snapshot?.allowedActions],
  );
  /** 备选 id → 模态，供按钮写出「改做选择题」这类具体文案（方案 §3 D5）。 */
  const alternativeKindById = useMemo(
    () => new Map((snapshot?.activeTask?.availableAlternatives ?? [])
      .map((alternative) => [alternative.alternativeId, alternative.interactionKind])),
    [snapshot?.activeTask?.availableAlternatives],
  );
  const canSubmitUnable = snapshot?.activeTask !== null && snapshot?.phase === "active";
  const retryResultQuery = () => {
    setFailure(null);
    setResultQueryFailure(null);
    setResultQueryBudgetExhausted(false);
    setResultPollTick((value) => value + 1);
  };
  const openObjective = () => {
    if (!snapshot) return;
    onExit({ route: { kind: "room.home" }, objectiveId: snapshot.target.objectiveId });
  };

  // 审计 F26：这三块边界必须**现在就**给出退路。曾经的现场是点了恢复之后任务区
  // 一直空白——既没有题目也没有错误态，屏上没有一个可点的东西（>15 秒），而唯一
  // 的出路是一枚不在这一屏里的返回胶囊。
  const leaveToHome = (
    <button type="button" className="button" onClick={() => { void onExit({ route: { kind: "room.home" } }); }}>
      先离开，回书桌
    </button>
  );

  /**
   * 学习页／结果页登记给伴星读的可读视图（doc 37 / 39d W2-2 的 P4-a）。
   *
   * **必须放在下面那个 `if (!snapshot)` 提前 return 之前**：React 要求 hook 顺序恒定，
   * 而这个组件下面有提前 return——放在它之后会得到 `Rendered more hooks than during the
   * previous render`（本文件真踩过一次，测试逮住的）。所以它只能依赖"提前 return 之前
   * 就存在"的东西：`resultState`（`:1386`）、`showResult`（`:1469`）、`snapshot`（`:1340`）。
   *
   * **两屏互斥**：顶层 `{result || terminal ? (A) : (B)}` 在 `:2580` 与它的 `:2760` 分叉，
   * A 段 = result 屏（`:2655` 的 `<b>本次掌握</b>` = `provenLedgerText(result)`）、
   * B 段 = assessment 屏（`:2781` 的 `<h2>`）。`showResult` 与 `result || terminal` 同一件事
   * ——`:1492` 那个 effect 就是按 `showResult` 通知外层切 page 的。
   *
   * 字段只登记核过渲染处的那几个；`metrics` 故意留空（这一屏的计数与步进字没逐个核，
   * 少登记的后果只是她读不到那一项，登记错的后果是她读到一个屏幕上根本没有的说法）。
   */
  const readableView = useMemo<PageReadableV1 | null>(() => {
    const resultValue = resultState.kind === "result" ? resultState.value.result : null;
    if (showResult) {
      if (!resultValue) return null;
      return {
        pageId: "result",
        title: HUD_PAGES.result.title.slice(0, 120),
        statusLine: provenLedgerText(resultValue).slice(0, 160),
      };
    }
    if (!snapshot) return null;
    const phase = resultState.kind === "pending" ? resultState.phase : snapshot.phase;
    const headline = snapshot.activeTask !== null && phase === "active"
      ? snapshot.target.publicSummary
      : processingHeadlineFor(phase);
    return {
      pageId: "assessment",
      title: HUD_PAGES.assessment.title.slice(0, 120),
      statusLine: headline.slice(0, 160),
    };
  }, [resultState, showResult, snapshot]);
  usePageReadableView(readableView);

  if (!snapshot) {
    if (loading) {
      return (
        <SurfaceDataState
          kind="loading"
          message="正在打开这一轮"
          detail="正在读取这一轮学到哪了；读到了就直接接着作答。"
          action={leaveToHome}
        />
      );
    }
    // 原来这条路径是 `return null`：一旦落到"没报错也没内容"，任务区就是一块
    // 合法的空白。现在它与失败态走同一个节点，退路一定在。
    return (
      <SurfaceDataState
        kind="error"
        message={failure ? "暂时无法打开这条学习旅程" : "这一轮没有打开"}
        detail={failure
          ? failure.message
          : "读取已经结束，但没有拿到可继续的状态。可以先回书桌，再重新进来一次。"}
        onRetry={!failure || failure.retryable ? requestSnapshotRefresh : undefined}
        action={leaveToHome}
      />
    );
  }

  const activeTask = snapshot.activeTask;
  const result = resultState.kind === "result" ? resultState.value.result : null;
  /**
   * 结算页"你交过的原文"从哪来（审计 F29）。
   *
   * 以前只有 `lockedAnswer` 一个内存态：提交那一刻写进去，刷新、从历史重进、结算后
   * 再进来就没了——于是那颗"看这次的答案与解释"的按钮在大多数时候承诺一件手里
   * 没有的事。服务端现在随结果载荷带回 `submitted`（本轮**已锁**的原文），所以
   * 优先读它；同一次会话里刚交完还没刷新时，本地那份也照样能用。
   */
  // 只认服务端那一份：`answerPreview` 对 text/voice 算出来的就是同一句原文，
  // 留两条来源只会让"刚交完"和"刷新之后"两屏长得不一样——而那正是 F29 的病。
  // 结构化作答（顺序/连线/选择）不在这条里：把它摊成一句人话是另一件事。
  const answerSources: Array<{ key: string; label: string; text: string }> = (result?.submitted ?? [])
    .map((answer, index, all) => ({
      key: `${answer.taskId}:${answer.sequence}`,
      label: all.length > 1 ? `第 ${index + 1} 次交的回答` : "你提交的回答",
      text: answer.text,
    }));
  const terminal = resultState.kind === "terminal" ? resultState.value : null;
  const resultSeed = result ? `${runId}:${result.snapshotId}:${result.outcome}` : null;
  const rawDiscoveryCard = result && resultSeed ? learningDiscoveryCard(result, resultSeed) : null;
  // 安静模式仍保留真实学习发现，但不能把它包装成“伴星在说话”。这是学习反馈，
  // 不是角色主动打扰；声音、动作和角色口吻都由 companionFeedbackAllowed 单独关掉。
  const discoveryCard = rawDiscoveryCard && !companionFeedbackAllowed && rawDiscoveryCard.eyebrow === "伴星发现"
    ? { ...rawDiscoveryCard, eyebrow: "本次闪光点" as const }
    : rawDiscoveryCard;
  const companionFeedbackLine = result && resultSeed
    ? companionResultLine(result, snapshot.target.publicSummary, resultSeed)
    : null;

  const loadTargetReveal = () => {
    if (targetReveal.kind === "loading" || targetReveal.kind === "ready") return;
    setTargetReveal({ kind: "loading" });
    void window.ailearn.learningRun.revealTarget({ meta: createRequestMeta(epochRef.current), runId })
      .then((response) => {
        setTargetReveal({ kind: "ready", reveal: unwrapGatewayResult(response) });
      })
      .catch((error: unknown) => {
        setTargetReveal({ kind: "unavailable", message: gatewayErrorMessage(error) });
      });
  };
  const unresolvedResultFailure = resultState.kind === "idle"
    && snapshotRequiresResolvedLearningResult(snapshot.phase)
    ? resultQueryFailure
    : null;
  const processingFailure = resultQueryFailure ?? failure;
  const processingPhase = resultState.kind === "pending" ? resultState.phase : snapshot.phase;
  const contractTarget = returnContract?.status === "unavailable"
    ? returnContract.fallbackTargetV2
    : returnContract?.returnTargetV2 ?? null;
  const returnTarget = contractTarget ?? snapshot.returnTargetV2;
  const exitRoute = routeForReturnTarget(returnTarget);
  const exitDestinationLabel = exitRoute.kind === "review.queue" ? "回到复习队列"
    : exitRoute.kind === "note.detail" ? "回到这篇笔记" : "返回学习空间";
  const returnsToCard = returnTarget.kind === "card" && Boolean(snapshot.target.cardId);
  const nextChallengeLabel = result?.outcome === "declared_unable"
    ? "先回研究册把这条看懂，再回来验证"
    : result && result.gapFacets.length
      ? `先补上「${facetText(result.gapFacets.slice(0, 1), "")}」`
      : returnTargetLabel(returnTarget);
  const recoveryHeading = recovery === "draft" ? "草稿版本需要同步" : "上一动作结果需要确认";
  const processingHeadline = processingHeadlineFor(processingPhase);
  const busy = pendingAction !== null || pendingHintAction !== null || actionBusy || resyncing || recovery !== null;
  const actionLinks = [
    ...alternativeActions,
    ...snapshot.allowedActions.filter((action) => ["pause", "resume", "request_hint", "activate_followup", "finish_current_evidence", "finish_without_commit", "retry_prepare", "retry_assessment", "retry_commit"].includes(action.kind)),
    // §5.5「停止本次评估」此前**根本进不了 actionLinks**：这一行是白名单式的
    // `filter(...includes)`，漏掉一档就等于服务端宣告了而屏上没有——和 wire 那一侧
    // 漏 `cancel_assessment` 是同一个病的两个器官（都在"合法地少一档"的地方）。
    ...snapshot.allowedActions.filter((action) => action.kind === "cancel_assessment"),
    ...snapshot.allowedActions.filter((action) => ["skip_run", "end"].includes(action.kind)),
  ];
  const switchAction = actionLinks.find((action) => action.kind === "switch_variant");
  const phaseAction = actionLinks.find((action) => action.kind === "pause" || action.kind === "resume");
  /**
   * 提示阶梯：服务端按 `hintLevels` 签发 1..N 个 request_hint，界面上只有**一个**
   * 按钮，每次放行下一层；放行到最后一层后禁用（复盘 #11）。
   */
  const hintLadder = actionLinks
    .filter((action): action is Extract<LearningRunAllowedActionV2, { kind: "request_hint" }> => action.kind === "request_hint")
    .sort((left, right) => left.level - right.level);
  const nextHintAction = hintLadder.find((action) => !hints.some((entry) => entry.level === action.level));
  const hintsExhausted = hintLadder.length > 0 && nextHintAction === undefined;
  /**
   * 退出动作必须摆在明面上（复盘 #12）：此前 `更多选择` 的 details 折叠了「稍后再做」，
   * 用户在无障碍树里根本找不到它——折叠区里的东西对键盘和读屏都不存在。
   * `end` 在其它阶段是唯一出口，同样直给。
   *
   * **这里曾经是一颗（`find`）而不是一组**，拆分见下面 `quickActions.push(...)` 的注释。
   */
  /**
   * checkpoint 的下一步（补充证据 / 结束但不改变复习 / 结算当前证据）是**用户的选择**，
   * 不是后台在准备什么——它们必须在明面上（2026-09-21 实机截图：藏在「更多选择」里，
   * 屏上只剩「安全退出」，用户以为要一直等下去）。
   */
  const checkpointActions = actionLinks.filter((action) =>
    action.kind === "activate_followup"
    || action.kind === "finish_current_evidence"
    || action.kind === "finish_without_commit");
  const checkpointPrimaryAction = checkpointActions.find((action) => action.kind === "finish_current_evidence")
    ?? checkpointActions.find((action) => action.kind === "activate_followup")
    ?? checkpointActions.find((action) => action.kind === "finish_without_commit")
    ?? null;
  const checkpointUnassessable = checkpointActions.some((action) => action.kind === "finish_without_commit");
  /**
   * 审计 F28：`not_assessable` 有两种完全不同的原因。系统侧缺冻结证据时，服务端
   * 已经不再签发 `activate_followup`（补回答补不上），这里再把它说明白——否则
   * 用户读到的仍然是"我答得不够好"，而正确的心智模型是"这条目标现在判不了"。
   */
  const checkpointEvidenceGap = snapshot.checkpointReason === "no_frozen_evidence";
  const quickActions: LearningRunAllowedActionV2[] = [];
  if (switchAction) quickActions.push(switchAction);
  if (phaseAction) quickActions.push(phaseAction);
  if (nextHintAction) quickActions.push(nextHintAction);
  else if (hintLadder.length > 0) quickActions.push(hintLadder[hintLadder.length - 1]!);
  quickActions.push(...checkpointActions);
  // 出口是**一组**而不是一颗。评估在途时服务端会同时宣告 `cancel_assessment` 与 `end`，
  // 此前这里是 `find(...)` 单数，只有一颗能进 `quickActions`；另一颗连「更多选择」都
  // 进不去（`moreActions` 用 `-quickActionKeys` 过滤，而它压根不在 `quickActions` 里）。
  // §5.5「结束活动、取消 AI 任务和撤销未来复习授权是三个独立动作」要求出口这一排
  // **同时**承载它们，否则评估在途时用户为了不等下去只能放弃刚答完的那道题。
  // 判据内联而不是复用下面的 `isExitAction`：那一条定义在这一行之后（`const` 不提升）。
  quickActions.push(...actionLinks.filter((action) => action.kind === "skip_run" || action.kind === "cancel_assessment" || action.kind === "end"));
  const quickActionKeys = new Set(quickActions.map(actionKey));
  /**
   * 出口（离开这次作答）与求助（换个走法继续）是两类东西，此前却和主按钮平铺在
   * 同一个 flex-wrap 行里：控件一多，状态文字被挤到 74px 宽折成两行、主按钮掉到
   * 第二排（31 号文档 P19，1440×810 实测 dock 高 123px、两排在 y=625 与 y=693）。
   * 现在分成定死的两排——出口在上、主按钮在下排右端，不再靠换行碰运气。
   */
  const isExitAction = (action: LearningRunAllowedActionV2) => action.kind === "skip_run" || action.kind === "cancel_assessment" || action.kind === "end";
  /**
   * 「停止本次评估」放在出口那一排，且**排在 `end` 前面**。
   *
   * 理由是 §5.5 那一段的原话：评估在途时，屏上原本只有「安全退出」一颗出口，而那一颗
   * 要 `abandonLockedEvidence: true`——用户为了不等下去，只能把刚答完的那道题扔掉。
   * §5.5 明确「结束活动、取消 AI 任务和撤销未来复习授权是三个独立动作」，所以第三条
   * 出路必须**看得见**，而不是塞进「更多选择」让人以为只能等。
   *
   * 顺序也是语义：先停这一次判定（作答留着，之后还能「重新评估」），再谈放弃作答。
   * 两个都摆在同一排时，把轻的放前面，重的读起来才是"升级"而不是"倒退"。
   */
  const exitActions = quickActions.filter(isExitAction).sort((a, b) => (a.kind === "end" ? 1 : 0) - (b.kind === "end" ? 1 : 0));
  const helpActions = quickActions.filter((action) => !isExitAction(action) && action !== checkpointPrimaryAction);
  const quickButton = (action: LearningRunAllowedActionV2, primary = false) => {
    const isHint = action.kind === "request_hint";
    const isSwitch = action.kind === "switch_variant";
    const blockedSwitch = isSwitch && blockedSwitchIds.has(action.alternativeId);
    const label = isSwitch
      ? switchActionLabel(alternativeKindById.get(action.alternativeId))
      : !isHint
        ? actionLabel(action)
        : hints.length === 0
          ? "给我一点提示"
          : hintsExhausted
            ? "提示已经给完"
            : "再看一层提示";
    return (
      <button
        key={actionKey(action)}
        type="button"
        className={`button${primary ? " primary" : ""}${blockedSwitch ? " learning-run-alt-disabled" : ""}`}
        disabled={busy || (isHint && hintsExhausted) || blockedSwitch}
        aria-describedby={blockedSwitch ? "learning-run-switch-note" : undefined}
        title={blockedSwitch ? microphoneReason : undefined}
        onClick={() => {
          const needsDowngradeConfirmation = isHint
            && hints.length === 0
            && snapshot.publishedTargetEligibility === "eligible"
            && Boolean(activeTask?.assistancePolicy.exposureLowersTrust);
          if (needsDowngradeConfirmation && action.kind === "request_hint") {
            setPendingHintAction(action);
            return;
          }
          void dispatchAction(action);
        }}
      >
        {actionIcon(action)}
        <span>{label}{isHint && hints.length === 0 && snapshot.publishedTargetEligibility === "eligible" && activeTask?.assistancePolicy.exposureLowersTrust ? <small className="learning-run-action-cost">使用后转为练习</small> : null}</span>
      </button>
    );
  };
  // request_hint 一律由那**一个**阶梯按钮代表：服务端按 hintLevels 签发了 1..N 个
  // 动作，若只把"下一个"放进快捷区、其余留在更多菜单里，用户看到的还是两个提示
  // 按钮（复盘 #11 的原始形态）。
  const moreActions = actionLinks.filter((action) =>
    action.kind !== "request_hint" && !quickActionKeys.has(actionKey(action)));
  const thisTime = thisTimeVerdicts(result ?? undefined);
  const feedback = result ? learningRunFeedback(result) : null;
  const ceremony = feedback ? ceremonyPresentation(feedback) : null;
  const runModeLabel = snapshot.publishedTargetEligibility === "eligible" && !hints.some((entry) => entry.downgraded)
    ? "正式挑战"
    : snapshot.publishedTargetEligibility === "blocked"
      ? "暂不计入掌握"
      : snapshot.originV2.kind === "note_round" ? "本轮练习" : "练习关";

  return (
    <div className="learning-run-experience" ref={tactileRootRef}>
      <div ref={primaryContentRef} data-tactile-page={snapshot.originV2.kind === "note_round" ? true : undefined} data-run-origin={snapshot.originV2.kind} className="learning-run-primary-content" aria-hidden={pendingAction || pendingHintAction ? true : undefined}>
      {result || terminal ? (
        <>
        {returnTarget.kind === "note_round" ? <NoteRunReceipt
          target={returnTarget}
          declaredUnable={result?.outcome === "declared_unable"}
          hasResult={Boolean(result)}
          targetSummary={snapshot.target.publicSummary}
          feedbackAchievement={feedback?.achievement ?? null}
          feedbackGap={feedback?.gap ?? null}
          hasGapFacets={Boolean(result?.gapFacets.length)}
          onExit={onExit}
          headingRef={primaryHeadingRef}
        /> : <>
        {result && feedback && ceremony ? <LearningRunCeremony active={resultAcknowledgementActive} stamp={ceremony.stamp} eyebrow={ceremony.eyebrow} headline={feedback.headline} achievement={feedback.achievement} companionLine={companionFeedbackAllowed ? companionFeedbackLine : null} onStart={playPendingResultFeedback} onFinish={finishResultCeremony} /> : null}
        <section className="learning-run-result-board" inert={resultAcknowledgementActive || undefined} data-outcome={result ? result.outcome : "no_result"} data-tone={feedback?.tone ?? "neutral"} data-acknowledgement={resultAcknowledgementActive ? "active" : "idle"}>
          <LearningRunArrival
            outcome={result?.outcome}
            seal={feedback?.seal ?? null}
            headline={feedback?.headline ?? null}
            practiceWithoutCoverage={result?.outcome === "practice_completed" && !thisTime.coveredCount}
            targetSummary={snapshot.target.publicSummary}
            origin={snapshot.originV2}
            elapsedSeconds={clock.seconds}
            headingRef={primaryHeadingRef}
          />
          {feedback ? (
              <LearningRunArrivalEvidence
                feedback={feedback}
                practiceWithoutCoverage={result?.outcome === "practice_completed" && !thisTime.coveredCount}
                nextChallengeLabel={nextChallengeLabel}
              />
          ) : null}
          <details className="learning-run-result-report">
            <summary>查看这次作答与详细判定<span aria-hidden="true">＋</span></summary>
            <div className="learning-run-result-report__body">
            {feedback && companionFeedbackAllowed ? (
              <div className="learning-run-result-companion" role="status">
                <Sparkles size={17} aria-hidden="true" />
                <p>
                  <strong>{feedback.tone === "success" ? "伴星回来庆祝了" : feedback.tone === "neutral" ? "这次线索已收好" : "伴星为这次进展点点头"}</strong>
                  <span>{companionFeedbackLine ?? feedback.achievement}</span>
                </p>
              </div>
            ) : null}
            {discoveryCard ? (
              <LearningRunDiscovery
                card={discoveryCard}
                revealed={discoveryRevealed}
                onReveal={() => setDiscoveryRevealed(true)}
              />
            ) : null}
            <LearningRunEvidenceBand
              hasResult={Boolean(result)}
              feedback={feedback ?? null}
              practiceWithoutCoverage={result?.outcome === "practice_completed" && !thisTime.coveredCount}
              provenText={result ? provenLedgerText(result) : ""}
              scheduleText={result ? scheduleImpactText(result.scheduleImpact, result.assessment?.rubricResults ?? []) : ""}
              terminalReasonLine={terminal ? terminalCopy[terminal.reasonCode] : null}
            />
            {/* 判定的异议（§14.2、§16.11、§16.25）。挂在结算纸面**外面**而不是
                「学习状态变化」那一格里：那一格是**系统在陈述结果**，而这一条是
                **用户对结果的回答**，两者同格会让"我不同意"看起来像结论的一部分。
                id 取 `result.assessment.assessmentId`（服务端刚补上的投影）——没有它
                就不给入口：那意味着没有一次**具体判定**可争议（§14.2 争议挂在一次
                判定上），而拿一个猜出来的 id 去提交申诉比不给按钮更坏。 */}
            {result?.assessment?.assessmentId ? (
              <AssessmentDisputeStrip
                assessmentId={result.assessment.assessmentId}
                workspaceEpoch={epochRef.current}
                onWorkspaceEpoch={(next) => { epochRef.current = next; }}
              />
            ) : null}
            {result?.assessment?.rubricResults.length ? (
              <LearningRunResultRubric rows={result.assessment.rubricResults} />
            ) : null}
            {result ? (
              <div className="learning-run-result-reveal">
                {targetReveal.kind === "idle" ? (
                  /**
                   * 审计 F29：这颗按钮写的是"看这次的答案与解释"，而展开后只有参考
                   * 要点——本轮提交的正文只在内存里（`lockedAnswer`），刷新或从历史
                   * 重进就没了，客户端从没向服务端取过"这一轮交过什么"。在服务端把
                   * 正文送出来之前，按钮只能说它真的给的东西。
                   */
                  <button type="button" className="button" onClick={loadTargetReveal}>
                    {answerSources.length > 0 ? "看这次的答案与解释" : "看参考答案与解释"}
                  </button>
                ) : null}
                {targetReveal.kind === "loading" ? <p className="small">正在读取答案…</p> : null}
                {targetReveal.kind === "ready" ? (
                  <div className="learning-run-result-reveal__body">
                    {answerSources.length > 0 ? (
                      <section className="learning-run-result-comparison" aria-label="提交回答与参考要点对照">
                        {answerSources.map((answer) => (
                          <div key={answer.key}>
                            <span>{answer.label}</span>
                            <p>{answer.text}</p>
                          </div>
                        ))}
                        <div>
                          <span>这次想考的是</span>
                          <p className="learning-run-result-reveal__answer">{targetReveal.reveal.answerText}</p>
                        </div>
                      </section>
                    ) : (
                      <>
                        <h3 className="serif">这次想考的是</h3>
                        <p className="learning-run-result-reveal__answer">{targetReveal.reveal.answerText}</p>
                      </>
                    )}
                    {targetReveal.reveal.support.explanation ? <p>{targetReveal.reveal.support.explanation}</p> : null}
                    {targetReveal.reveal.support.boundary ? <p><b>边界</b>　{targetReveal.reveal.support.boundary}</p> : null}
                    {targetReveal.reveal.support.misconception ? <p><b>常见误解</b>　{targetReveal.reveal.support.misconception}</p> : null}
                    {targetReveal.reveal.support.workedExample ? <p><b>示例</b>　{targetReveal.reveal.support.workedExample}</p> : null}
                  </div>
                ) : null}
                {targetReveal.kind === "unavailable" ? <p className="small">{targetReveal.message}</p> : null}
              </div>
            ) : null}
            <LearningRunNextStep
              nextChallengeLabel={nextChallengeLabel}
              declaredUnable={result?.outcome === "declared_unable"}
              returnContract={returnContract}
            />
            </div>
          </details>
          <div className="actions learning-run-result-actions">
            {returnsToCard ? <>
              <button type="button" className="button primary" onClick={openObjective}><ArrowLeft size={15} aria-hidden="true" />回到学习卡</button>
              <button type="button" className="button" onClick={() => onExit({ route: exitRoute })}>{exitDestinationLabel}</button>
            </> : <>
              <button type="button" className="button primary" onClick={() => onExit({ route: exitRoute })}><ArrowLeft size={15} aria-hidden="true" />{exitDestinationLabel}</button>
              {snapshot.target.cardId ? <button type="button" className="button" onClick={openObjective}>查看学习卡</button> : null}
            </>}
          </div>
        </section></>}
        </>
      ) : (
        <section className="learning-run-focus" data-origin={snapshot.originV2.kind} data-phase={snapshot.phase} data-interaction={activeTask?.activeVariant.interaction.kind ?? "none"}>
          <LearningRunFocusRail
            header={{
              modeLabel: runModeLabel,
              phase: processingPhase,
              eligibility: snapshot.publishedTargetEligibility,
              targetSummary: snapshot.target.publicSummary,
              isNoteRound: snapshot.originV2.kind === "note_round",
            }}
            activeTask={activeTask}
            interactionLabel={activeTask ? interactionLabel(activeTask) : null}
            elapsedSeconds={clock.seconds}
            clockPaused={clock.paused}
          />
          <div className="learning-run-focus__body">
          <section className="learning-run-paper">
            <div className="learning-run-paper__scroll">
            <LearningRunQuestionHeading
              activeTask={activeTask}
              interactionLabel={activeTask ? interactionLabel(activeTask) : null}
              isAnswering={snapshot.phase === "active"}
              isNoteRound={snapshot.originV2.kind === "note_round"}
              draftStatus={draftStatus}
              targetSummary={snapshot.target.publicSummary}
              processingHeadline={processingHeadline}
              phase={processingPhase}
              prompt={activeTask?.prompt ?? null}
              headingRef={primaryHeadingRef}
              intentLabel={activeTask ? facetLabels[activeTask.intent] ?? null : null}
            />
            {/* P21（B4）：求助面板从左侧导航栏搬进题面区。此前提示文字落在侧栏里
                207px 宽的一栏、9px 字号，而"看过提示这轮只计练习分"那句只有 **7.5px**
                ——全链路最小、却是最该看清的一句；求助信息和它要帮的题还隔着 250px。 */}
            {hints.length > 0 ? <LearningRunHint entries={hints} isNoteRound={snapshot.originV2.kind === "note_round"} /> : null}
            <div className="learning-run-response">
              {canAnswerNow ? <div className="learning-run-response__heading"><span aria-hidden="true">✎</span><strong>{activeTask?.activeVariant.interaction.kind === "text_response" ? "把你想起的写在这里" : "动手试一试"}</strong></div> : null}
              {canAnswerNow && activeTask ? (
                <InteractionEditor
                  task={activeTask}
                  value={editor ?? emptyEditor(activeTask)}
                  onChange={updateEditor}
                  restoredStructuredDraft={restoredStructuredDraft}
                  onStructuredReviewStateChange={setStructuredReviewReady}
                  onVoiceBusyChange={setVoiceEditorBusy}
                />
            ) : unresolvedResultFailure ? (
              <LearningRunUnresolvedResult message={unresolvedResultFailure.message} />
            ) : resultState.kind === "pending" || ["assessing", "committing"].includes(snapshot.phase) ? (
              <LearningRunResultPending
                headline={processingHeadline}
                waitingSeconds={waitingSeconds}
                lockedAnswer={lockedAnswer}
                resultQueryBudgetExhausted={resultQueryBudgetExhausted}
                processingFailure={processingFailure}
              />
            ) : snapshot.phase === "checkpoint" ? (
              <LearningRunCheckpointNotice
                evidenceGap={checkpointEvidenceGap}
                unassessable={checkpointUnassessable}
                failure={failure}
              />
            ) : (
              <LearningRunPreparing
                title={activeTask ? activeTask.prompt : phaseLabels[snapshot.phase]}
                paused={snapshot.phase === "paused"}
                failure={failure}
              />
            )}
          </div>
            </div>
          <LearningRunDock
            statusLine={recovery
              ? recoveryHeading
              : activeTask && snapshot.phase === "active"
                ? `回答不会自动提交 · ${draftStatus}`
                : resultState.kind === "pending" || ["assessing", "committing"].includes(snapshot.phase)
                  ? "回答已提交 · 等待结果"
                  : draftStatus}
            exitActions={exitActions.map((action) => quickButton(action))}
            canSubmitUnable={canSubmitUnable}
            submitting={submitting}
            busy={busy}
            onSubmitUnable={() => void submit({ kind: "declared_unable", reasonCode: "cannot_recall" })}
            showResync={Boolean(recovery)}
            resyncing={resyncing}
            onResync={() => void resyncLearningRun(recovery!)}
            showRetryResult={!recovery && Boolean(resultQueryBudgetExhausted || processingFailure)}
            resultQueryBusy={resultQueryBusy}
            onRetryResultQuery={retryResultQuery}
            helpActions={helpActions.map((action) => quickButton(action))}
            moreMenu={moreActions.length > 0 ? (
              <details className="learning-run-more">
                <summary>更多选择</summary>
                <div className="learning-run-more__menu">
                  {moreActions.map((action) => (
                    <button type="button" key={actionKey(action)} disabled={busy} onClick={() => void dispatchAction(action)}>
                      {actionIcon(action)}<span>{actionLabel(action)}</span>
                    </button>
                  ))}
                </div>
              </details>
            ) : null}
            canSubmit={Boolean(canAnswerNow)}
            submitDisabled={busy
              || submitting
              || voiceEditorBusy
              || !editor
              || (editor.kind !== "declared_unable" && !payloadIsReady(editor, activeTask))
              || (editor.kind === "ordering" && !orderingTouched)
              || (editor.kind === "structured_bundle" && !structuredReviewReady)}
            onSubmit={() => editor && void submit(editor)}
            checkpointPrimary={checkpointPrimaryAction ? { node: quickButton(checkpointPrimaryAction, true) } : null}
            onExit={() => onExit({ route: exitRoute })}
            resultReturnLabel={exitDestinationLabel}
            switchNote={blockedSwitchIds.size > 0 ? `现在还不能改用语音讲解：${microphoneReason}` : ""}
          />
          </section>
          </div>
        </section>
      )}
      </div>

      <RunConfirmations
        pendingHintAction={pendingHintAction}
        hintConfirmationHeadingRef={hintConfirmationHeadingRef}
        closeHintConfirmation={closeHintConfirmation}
        confirmHint={confirmHint}
        pendingAction={pendingAction}
        confirmationHeadingRef={confirmationHeadingRef}
        closeConfirmation={closeConfirmation}
        confirmPending={confirmPendingAction}
        resyncing={resyncing}
        handleConfirmationKeyDown={handleConfirmationKeyDown}
      />
    </div>
  );
}

type LearningRunSurfaceProps = {
  /**
   * Optional shell hook. The task surface may pass its own run-exit handler
   * (the one that releases the FormalAssessmentGuard through main's route
   * resolver); when absent this surface resolves the same route itself.
   */
  readonly onExit?: (request?: { route: DesktopRouteV1; objectiveId?: string; reflectionRoundId?: string }) => void;
};

/** Pages 16/17 — one multi-format LearningRun workbench and its evidence report. */
export function LearningRunSurface({ onExit }: LearningRunSurfaceProps = {}) {
  const activeRunId = useRoomStore((state) => state.activeRunId);
  const setActiveRunId = useRoomStore((state) => state.setActiveRunId);
  const setActiveObjectiveId = useRoomStore((state) => state.setActiveObjectiveId);
  const setActiveNoteRef = useRoomStore((state) => state.setActiveNoteRef);
  const invoke = useRoomStore((state) => state.invoke);
  const [page, setPage] = useState<"assessment" | "result">("assessment");
  useHudPage(page);

  const exitRun = useCallback(async (request?: { route: DesktopRouteV1; objectiveId?: string; reflectionRoundId?: string }) => {
    if (onExit) {
      onExit(request);
      return;
    }
    if (!activeRunId || !window.ailearn) return;
    // Remove the run tree before asking main to resolve the return route: main
    // completes FormalAssessmentGuard release only after the renderer has
    // yielded a frame with the run context unmounted.
    setActiveRunId(null);
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    const requested: DesktopRouteV1 = request?.route ?? { kind: "review.queue" };
    // 解析与提交都在 `releaseRunThroughMainV1` 里，与"就地作答"那条路共用同一段。
    const route: DesktopRouteV1 = await releaseRunThroughMainV1({ runId: activeRunId, route: requested })
      // A deleted, forbidden or unresolvable server target must not be
      // replayed by the renderer. Fall back to the review queue intent.
      ?? { kind: "room.home" };
    if (route.kind === "note.detail") {
      setActiveNoteRef({ noteId: route.noteId, noteVersionId: null, mode: "preview",
        learningRoundId: request?.route.kind === "note.detail" && request.route.noteId === route.noteId ? request.reflectionRoundId : undefined });
      invoke("open-notebook");
    } else invoke(route.kind === "review.queue" ? "review" : "home");
    if (request?.objectiveId) {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      setActiveObjectiveId(request.objectiveId);
      invoke("open-objective");
    }
  }, [activeRunId, invoke, onExit, setActiveNoteRef, setActiveObjectiveId, setActiveRunId]);

  return (
    <HudPage page={page} showTitle={page !== "result"}>
      <div className="card-run card-experience">
      {activeRunId ? (
        <LearningRunBody runId={activeRunId} onExit={(request) => { void exitRun(request); }} onPageChange={setPage} />
      ) : (
        <SurfaceDataState
          kind="empty"
          message="还没有进行中的学习旅程"
          detail="从学习卡、复习队列或今日学习里开始一轮，题目会在这一屏接着走。"
          action={(
            <button type="button" className="button primary" onClick={() => invoke("home")}>
              回书桌
            </button>
          )}
        />
      )}
      </div>
    </HudPage>
  );
}

export { phaseLabels as learningRunPhaseLabels };
