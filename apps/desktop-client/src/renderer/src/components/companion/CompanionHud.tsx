// 样式表改由 `styles.ts` 统一按顺序注入（2026-09-29）——见该文件顶部的分层说明。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject, type PointerEvent as ReactPointerEvent, type UIEvent as ReactUIEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, History, Loader2, MessageCircle, Mic, Plus, Quote, RotateCcw, Send, Settings2, Sparkles, Square, X, type LucideIcon } from "lucide-react";
import type { CompanionAccountPatch, CompanionAccountStateV1 } from "@ailearn/shared/companion-shell-contracts";
import { WINDOW_LIVE2D_MODEL_REGISTRY, type WindowLive2DModelId } from "./window-live2d-contract";
import type { CompanionAgentPermissionLevel } from "@ailearn/shared/companion-agent-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../app/desktop-client";
import { useRoomStore } from "../../app/room-store";
import { useCompanionChat } from "../../app/companion-chat-session";
import { beginCompanionSpeechLine, stopCompanionSpeech, subscribeCompanionSpeech, type CompanionServerVoiceSegment, type CompanionSpeechSession } from "../../app/companion-voice-playback";
import { COMPANION_REVEAL_TICK_MS, createCompanionRevealDriver, type CompanionRevealDriver } from "../../app/companion-reveal-driver";
import { subscribeHomeV2VoiceLevel } from "../../app/companion-voice-level";
import { nodeLabel } from "../../app/companion-agent-nodes";
import type { CompanionAgentNode, CompanionAgentNodeState } from "../../app/companion-agent-nodes";
import { CompanionAgentRail, type CompanionAgentRailProgress, type CompanionAgentRailTurnState } from "./companion-agent-rail";
import { COMPANION_AGENT_PERMISSION_OPTIONS, COMPANION_INTERVENTION_OPTIONS, COMPANION_PRESENCE_OPTIONS, companionInterventionHint, quietHoursPatch, quietHoursWithBoundary, type QuietHoursBoundary } from "./companion-account-presence";
import { companionBubbleHoldMs, companionBubblePreviewText, companionBubbleText } from "./companion-bubble-reveal";
import { openVoiceModelSettings as openVoiceModelSettingsAction } from "./open-voice-model-settings";
import { createCompanionBubbleFollow, type CompanionBubbleFollow } from "./companion-bubble-follow";
import { plainCompanionBubbleText } from "./companion-markdown";
import { beginNoteReplySaveAttempt, isReadyNoteReplyForSave, resolveNoteReplySaveTarget } from "./note-reply-save";
import { CompanionHistoryDrawer } from "./CompanionHistoryDrawer";
import { visibleTurnFailure } from "./companion-hud-state";
import { shouldSendCompanionOnEnter } from "./companion-composer-key";
import { useCompanionInteraction } from "./use-companion-interaction";
import { useCompanionFloatingPlacement } from "./use-companion-floating-placement";
import { useCompanionPaperPlacement } from "./use-companion-paper-placement";
import { CompanionGoalBubble } from "./CompanionGoalBubble";
import { useAgentGoals } from "./use-agent-goals";
import { COMPANION_GOAL_JOURNAL_OPEN } from "./companion-events";
import { CompanionReplyPapers, CompanionStatusPaper } from "./CompanionReplyPapers";
import { CompanionNoteExplanationContext } from "./CompanionNoteExplanationContext";
import { useNoteCompanionExplanations } from "./note-companion-explanation";
import { prepareNotebookTaskNotification } from "../surfaces/notebook/notebook-task-notifications";

export interface CompanionHudAction {
  readonly id: string;
  readonly title: string;
  readonly purpose: string;
  readonly icon: LucideIcon;
}

export interface CompanionHudSettings {
  readonly scale: number;
  readonly scaleMin: number;
  readonly scaleMax: number;
  readonly pageMuted: boolean;
  readonly taskActive: boolean;
  readonly focusUntilTaskEnd: boolean;
  readonly onScale: (value: number) => void;
  readonly onTogglePageMuted: () => void;
  readonly onToggleFocus: () => void;
  readonly onHide: () => void;
  readonly onResetPosition: () => void;
}

export interface CompanionHudProps {
  readonly motionMode: "full" | "lite" | "off";
  readonly voiceEnabled: boolean;
  readonly actions: readonly CompanionHudAction[];
  readonly settings: CompanionHudSettings;
  readonly onRunAction: (id: string) => void;
  /**
   * 每个工具节点**每发生一次状态迁移**触发一次（方案 §5 第 9 项「看向手边」+
   * 2026-09-20 接入的结果表情）。会话层在 HUD 里，角色层在它的兄弟节点上，
   * 所以这条信号必须上提一层；由 `CompanionPresence` 转成角色的一次动作/道具。
   */
  readonly onAgentToolState?: (state: CompanionAgentNodeState) => void;
  readonly floatingBlocked?: boolean;
  readonly onTaskBubbleOpenChange?: (open: boolean) => void;
}

type MoreView = "menu" | "actions";

type CompanionVoiceSegmentReadyDetail = Readonly<{
  version: 2;
  conversationId: string;
  runId: string;
  generation: number;
  segmentId: string;
  ordinal: number;
  displayText: string;
  displayStart: number;
  displayEnd: number;
  synthesisTextSha256: string;
  cue: CompanionServerVoiceSegment["cue"];
}>;
type BubbleStage = "visible" | "leaving";

/**
 * 本轮正在念的台词：气泡只需要"这是谁、能不能出声、怎么停"三件事——
 * 露多少字由 `companion-reveal-driver` 按播放进度算，不在这里切段。
 */
interface ActiveCompanionSpeech {
  readonly planId: string;
  readonly mode: "voice" | "silent";
  stop(): void;
}

const BUBBLE_EXIT_MS = 280;
const CARD_ONLY_LINE = "我把这件事整理成了一条可执行建议，已经收进对话记录里。";
/** 出声结束后呼吸环从当前振幅回落到静息的时长（方案 §4）。 */
const COMPANION_BREATH_RETURN_MS = 300;
/** 停止后的就地说明在气泡里停留多久；之后由用户的下一次发送或这里收掉。 */
const STOP_NOTICE_HOLD_MS = 6_000;

export function companionHudReplyText(reply: { readonly text: string; readonly hasActionBlocks: boolean }): string {
  if (reply.text.trim().length > 0) return reply.text;
  return reply.hasActionBlocks ? CARD_ONLY_LINE : "";
}

function playButtonBounce(event: ReactPointerEvent<HTMLButtonElement>) {
  const button = event.currentTarget;
  button.getAnimations().forEach((animation) => animation.cancel());
  if (button.closest("[data-motion]")?.getAttribute("data-motion") === "off") return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    button.animate([{ opacity: 0.76 }, { opacity: 1 }], { duration: 140, easing: "ease-out" });
    return;
  }
  button.animate([
    { transform: "scale(1)" },
    { transform: "scale(.90)", offset: 0.24 },
    { transform: "scale(1.05)", offset: 0.7 },
    { transform: "scale(1)" },
  ], { duration: 220, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
}

export function CompanionHud({
  motionMode,
  voiceEnabled,
  actions,
  settings,
  onRunAction,
  onAgentToolState,
  floatingBlocked = false,
  onTaskBubbleOpenChange,
}: CompanionHudProps) {
  const chat = useCompanionChat();
  const [moreView, setMoreView] = useState<MoreView>("menu");
  /** Settings use their own scrollable paper beside the actual model. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [goalBubbleOpen, setGoalBubbleOpen] = useState(false);
  useEffect(() => { onTaskBubbleOpenChange?.(goalBubbleOpen); return () => onTaskBubbleOpenChange?.(false); }, [goalBubbleOpen, onTaskBubbleOpenChange]);
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  const [goalHistoryTarget, setGoalHistoryTarget] = useState<{ runId: string; visit: number } | null>(null);
  const interaction = useCompanionInteraction(chat, voiceEnabled, floatingBlocked || settingsOpen || goalBubbleOpen || chat.mode === "history");
  const goals = useAgentGoals(chat.phase, id => {
    interaction.closeVoice(); setSettingsOpen(false); chat.setMode("closed"); setSelectedGoalId(id); setGoalBubbleOpen(true);
  });
  useEffect(() => { setGoalBubbleOpen(false); setSelectedGoalId(null); setGoalHistoryTarget(null); }, [goals.scope]);
  useEffect(() => { if (chat.mode !== "closed") setGoalBubbleOpen(false); if (chat.mode !== "history") setGoalHistoryTarget(null); }, [chat.mode]);
  useEffect(() => {
    const open = (event: Event) => {
      const target = (event as CustomEvent<{ runId: string; scope: number }>).detail;
      if (!target || target.scope !== useRoomStore.getState().workspaceScopeRevision || typeof target.runId !== "string") return;
      interaction.closeVoice(); setSettingsOpen(false); setGoalBubbleOpen(false);
      void goals.refresh(); setGoalHistoryTarget({ runId: target.runId, visit: Date.now() }); chat.setMode("history");
    };
    window.addEventListener(COMPANION_GOAL_JOURNAL_OPEN, open);
    return () => window.removeEventListener(COMPANION_GOAL_JOURNAL_OPEN, open);
  }, [goals.scope, goals.refresh, chat.setMode, interaction.closeVoice]);
  const { input, setInput, voice } = interaction;
  /** 回合结束后只发布一次的稳定摘要（方案 §3 无障碍）：流式文本不再是持续 live region。 */
  const [turnSummary, setTurnSummary] = useState("");
  const [proposalNotice, setProposalNotice] = useState("");
  const [revealedChars, setRevealedChars] = useState(0);
  const [bubbleStage, setBubbleStage] = useState<BubbleStage>("visible");
  const [preparingSend, setPreparingSend] = useState(false);
  const [bubbleExpanded, setBubbleExpanded] = useState(false);
  const [bodyClipped, setBodyClipped] = useState(false);
  const preparingSendIdRef = useRef(0);
  const conversationIdRef = useRef(chat.conversationId);
  conversationIdRef.current = chat.conversationId;
  /**
   * 这一轮**她不出声**时说的那一句（方案 35 E6）。以前 `text_only` / `failed` 两个
   * 降级读数在渲染层没有任何消费方（一律和"用户自己停了"走同一支 `noteAudioStopped()`），
   * 于是界面安静得和"她本来就没有声音"一模一样——用户分不清是没开声音、还是她不想说。
   * 它不自动消失：不出声是这一轮的属性，气泡在它就该在。
   */
  const [speechNotice, setSpeechNotice] = useState<string | null>(null);
  const noteExplanations = useNoteCompanionExplanations();
  const activeNoteExplanation = noteExplanations.items.find(item => item.id === noteExplanations.activeId);
  const [recallSaveState, setRecallSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [recallSaveMessage, setRecallSaveMessage] = useState<string | null>(null);
  const recallSaveKeyRef = useRef<string | null>(null);
  const recallSaveTargetRef = useRef<string | null>(null);
  const recallQuestionRequestRef = useRef<{ key: string; requestId: string } | null>(null);
  const [expansionReplyMessageId, setExpansionReplyMessageId] = useState<string | null>(null);
  const [expansionTaskState, setExpansionTaskState] = useState<"idle" | "starting" | "started" | "error">("idle");
  const [expansionTaskMessage, setExpansionTaskMessage] = useState<string | null>(null);
  const expansionTaskRequestRef = useRef<{ key: string; requestId: string } | null>(null);
  const noteReplySaveAttemptRef = useRef<ReturnType<typeof beginNoteReplySaveAttempt> | null>(null);
  const micRef = useRef<HTMLButtonElement>(null);
  const moreControlRef = useRef<HTMLButtonElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const autoSendRequestRef = useRef<string | null>(null);
  /**
   * 显现驱动器（2026-09-19 字幕式朗读）：文本**到了多少**与**该露多少**是两件事，
   * 后者只由音频进度或阅读钟推进（见 `companion-reveal-driver`）。旧实现把前者当后者用
   * （草稿一到就设成草稿长度、终态一到又补满全文），于是"随朗读逐字出现"形同失效。
   */
  const revealDriverRef = useRef<CompanionRevealDriver | null>(null);

  useEffect(() => {
    if (chat.feedNoteIntent && chat.feedPrompt) {
      setInput(chat.feedPrompt);
      return;
    }
    if (chat.feedSelection && chat.feedPrompt) setInput((current) => current.trim() ? current : chat.feedPrompt!);
  }, [chat.feedPrompt, chat.feedNoteIntent, chat.feedSelection]);

  const saveReplyAsNoteRecallQuestion = useCallback(async () => {
    const intent = chat.feedNoteIntent;
    const reply = chat.liveReply;
    const conversationId = chat.conversationId;
    if (!intent || intent.kind !== "recall" || !reply || !conversationId) return;
    const api = typeof window === "undefined" ? undefined : window.ailearn;
    if (!api?.noteRecall) {
      setRecallSaveState("error");
      setRecallSaveMessage("回想问题还在伴星对话里，但暂时没能留进笔记记录。可以重试保存。");
      return;
    }
    const key = `${intent.noteId}:${intent.noteVersionId}:${reply.messageId}`;
    const request = recallQuestionRequestRef.current?.key === key
      ? recallQuestionRequestRef.current
      : { key, requestId: crypto.randomUUID() };
    recallQuestionRequestRef.current = request;
    setRecallSaveState("saving");
    setRecallSaveMessage(null);
    try {
      const record = unwrapGatewayResult(await api.noteRecall.start({
        meta: createRequestMeta(),
        noteId: intent.noteId,
        request: {
          requestId: request.requestId,
          noteVersionId: intent.noteVersionId,
          sourceMessageId: reply.messageId,
          conversationId,
        },
      }));
      window.dispatchEvent(new CustomEvent("ailearn:note-recall-saved", {
        detail: { noteId: intent.noteId, record },
      }));
      setRecallSaveState("saved");
      setRecallSaveMessage(record.versionState === "current"
        ? "这道问题已留在笔记里，之后还能接着回想。"
        : "问题按当时的旧版保存了；笔记后来改过，记录仍会留着。");
    } catch (error) {
      setRecallSaveState("error");
      setRecallSaveMessage(`问题没有贴回笔记：${gatewayErrorMessage(error)}`);
    }
  }, [chat]);

  const saveReplyAsNoteRecallHint = useCallback(async () => {
    const intent = chat.feedNoteIntent;
    const reply = chat.liveReply;
    const conversationId = chat.conversationId;
    if (!intent || intent.kind !== "recall_hint" || !intent.recallId || !reply || !conversationId) return;
    const api = typeof window === "undefined" ? undefined : window.ailearn;
    if (!api?.noteRecall) {
      setRecallSaveState("error");
      setRecallSaveMessage("线索还在伴星对话里，但暂时没能留进这次回想记录。可以重试保存。");
      return;
    }
    setRecallSaveState("saving");
    setRecallSaveMessage(null);
    try {
      const record = unwrapGatewayResult(await api.noteRecall.act({
        meta: createRequestMeta(),
        noteId: intent.noteId,
        recallId: intent.recallId,
        action: { kind: "hint", sourceMessageId: reply.messageId, conversationId },
      }));
      window.dispatchEvent(new CustomEvent("ailearn:note-recall-saved", {
        detail: { noteId: intent.noteId, record },
      }));
      setRecallSaveState("saved");
      setRecallSaveMessage("这条线索已留在这次回想里。");
    } catch (error) {
      setRecallSaveState("error");
      setRecallSaveMessage(`线索没有保存：${gatewayErrorMessage(error)}`);
    }
  }, [chat]);

  useEffect(() => {
    const target = resolveNoteReplySaveTarget(null, chat.feedNoteIntent);
    if (target?.kind !== "recall" && target?.kind !== "recall_hint") {
      recallSaveTargetRef.current = null;
      return;
    }
    if (recallSaveTargetRef.current === target.key) return;
    recallSaveTargetRef.current = target.key;
    recallSaveKeyRef.current = null;
    recallQuestionRequestRef.current = null;
    setRecallSaveState("idle");
    setRecallSaveMessage(null);
  }, [chat.feedNoteIntent]);

  useEffect(() => {
    const intent = chat.feedNoteIntent;
    const reply = chat.liveReply;
    const attempt = noteReplySaveAttemptRef.current;
    const activeTarget = resolveNoteReplySaveTarget(chat.feedNoteAnchor, intent);
    if (intent?.kind !== "recall" || !reply || attempt?.target.kind !== "recall"
      || !isReadyNoteReplyForSave(attempt, activeTarget, chat.phase, reply.messageId)) return;
    noteReplySaveAttemptRef.current = null;
    const key = `${intent.noteId}:${intent.noteVersionId}:${reply.messageId}`;
    if (recallSaveKeyRef.current === key) return;
    recallSaveKeyRef.current = key;
    setRecallSaveState("idle");
    setRecallSaveMessage(null);
    void saveReplyAsNoteRecallQuestion();
  }, [chat.feedNoteIntent, chat.feedNoteAnchor, chat.liveReply, chat.phase, saveReplyAsNoteRecallQuestion]);

  useEffect(() => {
    const intent = chat.feedNoteIntent;
    const reply = chat.liveReply;
    const attempt = noteReplySaveAttemptRef.current;
    const activeTarget = resolveNoteReplySaveTarget(chat.feedNoteAnchor, intent);
    if (intent?.kind !== "recall_hint" || !reply || attempt?.target.kind !== "recall_hint"
      || !isReadyNoteReplyForSave(attempt, activeTarget, chat.phase, reply.messageId)) return;
    noteReplySaveAttemptRef.current = null;
    const key = `${intent.noteId}:${intent.noteVersionId}:${intent.recallId}:${reply.messageId}`;
    if (recallSaveKeyRef.current === key) return;
    recallSaveKeyRef.current = key;
    setRecallSaveState("idle");
    setRecallSaveMessage(null);
    void saveReplyAsNoteRecallHint();
  }, [chat.feedNoteIntent, chat.feedNoteAnchor, chat.liveReply, chat.phase, saveReplyAsNoteRecallHint]);

  useEffect(() => {
    if ((chat.feedNoteIntent?.kind !== "recall" && chat.feedNoteIntent?.kind !== "recall_hint") || chat.liveReply) return;
    recallSaveKeyRef.current = null;
    setRecallSaveState("idle");
    setRecallSaveMessage(null);
  }, [chat.feedNoteIntent, chat.liveReply]);

  useEffect(() => {
    if (chat.feedNoteIntent?.kind !== "expansion") {
      setExpansionReplyMessageId(null);
      setExpansionTaskState("idle");
      setExpansionTaskMessage(null);
      expansionTaskRequestRef.current = null;
      return;
    }
    setExpansionReplyMessageId(null);
    setExpansionTaskState("idle");
    setExpansionTaskMessage(null);
    expansionTaskRequestRef.current = null;
  }, [chat.feedNoteIntent?.kind, chat.feedNoteIntent?.noteId, chat.feedNoteIntent?.noteVersionId]);

  useEffect(() => {
    const intent = chat.feedNoteIntent;
    const reply = chat.liveReply;
    const attempt = noteReplySaveAttemptRef.current;
    const activeTarget = resolveNoteReplySaveTarget(chat.feedNoteAnchor, intent);
    if (intent?.kind !== "expansion" || !reply || attempt?.target.kind !== "expansion"
      || !isReadyNoteReplyForSave(attempt, activeTarget, chat.phase, reply.messageId)) return;
    noteReplySaveAttemptRef.current = null;
    setExpansionReplyMessageId(reply.messageId);
  }, [chat.feedNoteIntent, chat.feedNoteAnchor, chat.liveReply, chat.phase]);

  useEffect(() => {
    const attempt = noteReplySaveAttemptRef.current;
    if (!attempt) return;
    const currentTarget = resolveNoteReplySaveTarget(chat.feedNoteAnchor, chat.feedNoteIntent);
    if (currentTarget?.kind !== attempt.target.kind || currentTarget.key !== attempt.target.key) {
      noteReplySaveAttemptRef.current = null;
    }
  }, [chat.feedNoteAnchor, chat.feedNoteIntent]);

  const startExpansionTask = async () => {
    const intent = chat.feedNoteIntent;
    const reply = chat.liveReply;
    const conversationId = chat.conversationId;
    if (!intent || intent.kind !== "expansion" || !reply || reply.messageId !== expansionReplyMessageId
      || !conversationId || expansionTaskState === "starting" || expansionTaskState === "started") return;
    const api = typeof window === "undefined" ? undefined : window.ailearn;
    if (!api?.noteExpansion) {
      setExpansionTaskState("error");
      setExpansionTaskMessage("后台整理暂时不可用。伴星回复仍保存在对话记录里，你可以回到笔记页重试。");
      return;
    }
    const key = `${intent.noteId}:${intent.noteVersionId}:${reply.messageId}`;
    const requestId = expansionTaskRequestRef.current?.key === key
      ? expansionTaskRequestRef.current.requestId
      : crypto.randomUUID();
    expansionTaskRequestRef.current = { key, requestId };
    setExpansionTaskState("starting");
    setExpansionTaskMessage(null);
    const meta = createRequestMeta();
    const notifyTask = prepareNotebookTaskNotification({ noteId: intent.noteId, currentVersionId: intent.noteVersionId, title: intent.noteTitle }, meta.workspaceEpoch);
    try {
      const task = unwrapGatewayResult(await api.noteExpansion.startTask({
        meta,
        noteId: intent.noteId,
        request: {
          noteVersionId: intent.noteVersionId,
          requestId,
          sourceMessageId: reply.messageId,
          conversationId,
        },
      }));
      notifyTask(task, "expansion");
      window.dispatchEvent(new CustomEvent("ailearn:note-expansion-task-started", {
        detail: { noteId: intent.noteId, taskId: task.taskId },
      }));
      setExpansionTaskState("started");
      setExpansionTaskMessage(task.status === "ready" || task.status === "confirmed"
        ? "这批草稿已回到笔记页，可以逐篇检查后再收下。"
        : task.status === "failed"
          ? "这次整理没有完成。回到笔记页可以查看原因并重试。"
          : "已经开始整理。进度和可编辑草稿会留在这篇笔记里；这段对话也会保存在伴星手记中。" );
    } catch (error) {
      setExpansionTaskState("error");
      setExpansionTaskMessage(`没有开始整理：${gatewayErrorMessage(error)}。可以重试，伴星回复仍在手记里。`);
    }
  };
  const ensureRevealDriver = useCallback((): CompanionRevealDriver => {
    if (revealDriverRef.current === null) {
      revealDriverRef.current = createCompanionRevealDriver({
        onReveal: (value) => setRevealedChars(value),
      });
    }
    return revealDriverRef.current;
  }, []);
  /** 当前草稿属于哪一轮；换轮时把语音会话停掉（否则两轮的语音会叠在一起）。 */
  const draftRunIdRef = useRef<string | null>(null);
  /**
   * 本轮"边生成边念"的语音会话（2026-09-19 ⑥ 朗读时机）。
   *
   * 文本一到就按**完整句**排进合成队列（`beginCompanionSpeechLine` 的 `feed` 只放
   * 已经写完的句子，没写完的尾巴留在缓冲里），所以既能"文本还在长、她已经开口"，
   * 又不会念出半截话——后者正是 §3.1 当初改成"只念最终"的理由，现在用增量切句
   * 同时满足两边。
   */
  const speechSessionRef = useRef<CompanionSpeechSession | null>(null);
  /** 草稿转成最终回复后仍在播放的会话；显现心跳必须继续读取它的音频位置。 */
  const speechPositionSessionRef = useRef<CompanionSpeechSession | null>(null);
  const pendingVoiceSegmentsRef = useRef<CompanionVoiceSegmentReadyDetail[]>([]);
  const seenVoiceSegmentIdsRef = useRef(new Set<string>());
  const [voiceSegmentRevision, setVoiceSegmentRevision] = useState(0);
  /**
   * 气泡元素的镜像 ref：停留计时的暂停判定（悬停/聚焦）在 effect 闭包里即时读它，
   * 不把 bubbleEl 挂进那批 effect 的依赖。
   */
  const bubbleElRef = useRef<HTMLDivElement | null>(null);
  /**
   * 本轮关心的播放计划 id。播放进度是模块级广播，换轮时旧计划的 `stopped` 也会到——
   * 不过滤的话它会把新的一轮误判成"音频停了"，文字就会抢在声音前面。
   */
  const activeSpeechPlanRef = useRef<string | null>(null);
  /**
   * 呼吸角标的元素。振幅**写在角标自己身上**而不是气泡根上：只有它读这个变量，
   * 写在父元素会让整棵子树的样式重算（方案 §4 的实现要点）。
   */
  const presenceRef = useRef<HTMLSpanElement>(null);
  /** 气泡元素（用回调 ref：它是条件渲染的，状态里存元素比存 ref 更好依赖）。 */
  const [bubbleEl, setBubbleEl] = useState<HTMLDivElement | null>(null);
  bubbleElRef.current = bubbleEl;
  /** 气泡**正文**的滚动容器：长回复在它里面自己滚，跟随（见下面的 effect）也挂在它身上。 */
  const bubbleBodyRef = useRef<HTMLParagraphElement | null>(null);
  /**
   * 跟随的状态机（判据与规则都在 `companion-bubble-follow.ts`，有单测）：长回复装满后
   * 新字要钉在视野里，但用户自己往上读时要让位，他回到底部或换一轮再跟着走。
   */
  const followRef = useRef<CompanionBubbleFollow | null>(null);
  if (followRef.current === null) followRef.current = createCompanionBubbleFollow();
  const bubbleFollow = followRef.current;
  /** 本轮语音此刻是否正在出声：出声时气泡停留计时暂停（方案 §3）。 */
  const speakingRef = useRef(false);
  const replyActivityUntilRef = useRef(0);
  const replyObscuredRef = useRef(false);
  replyObscuredRef.current = floatingBlocked || settingsOpen || goalBubbleOpen || chat.mode === "history";
  const noteReplyActivity = () => {
    replyActivityUntilRef.current = performance.now() + 2_500;
    interaction.outputActivity();
  };
  /** HUD 根：两笔实测值写在它身上；气泡不在时也要能写，所以不能从气泡反查父节点。 */
  const hudRef = useRef<HTMLDivElement>(null);
  const floatingRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  /**
   * 呼吸角标的三态（方案 §4）：静息走 keyframes；出声时逐帧跟随真实振幅（与她嘴型
   * 同一个数）；出声结束后先 `returning` 300ms 回落，再交回 keyframes——直接切回
   * keyframes 会让半径从当前振幅瞬间弹到 1，那一下很显眼。
   */
  const [breath, setBreath] = useState<"rest" | "speaking" | "returning">("rest");
  /**
   * 停止时定格下来的那段文字。停止会清掉草稿，而定格要在草稿消失之后继续显示——
   * 所以必须在它消失前把最后一份文本存下来（方案 §5 第 8 项、§6 展示）。
   */
  const [frozenText, setFrozenText] = useState("");
  const lastOutputRef = useRef("");


  useEffect(() => voice.subscribeLevel((level) => {
    micRef.current?.style.setProperty("--voice-level", level.toFixed(3));
  }), [voice.subscribeLevel]);

  useEffect(() => {
    const onVoiceSegment = (event: Event) => {
      const detail = (event as CustomEvent<Partial<CompanionVoiceSegmentReadyDetail>>).detail;
      // V2 合同逐字段校验（主进程已做 shared schema 校验，这里只挡明显残帧）：
      // displayStart/displayEnd 是干净正文里的字符区间，任一缺失就整个丢弃——
      // 渲染层绝不猜"这段对应正文的哪里"。
      if (!detail || detail.version !== 2 || typeof detail.runId !== "string"
        || typeof detail.segmentId !== "string" || typeof detail.ordinal !== "number"
        || typeof detail.displayText !== "string" || detail.displayText.length === 0
        || typeof detail.displayStart !== "number" || typeof detail.displayEnd !== "number"
        || typeof detail.conversationId !== "string" || typeof detail.generation !== "number") return;
      if (seenVoiceSegmentIdsRef.current.has(detail.segmentId)) return;
      seenVoiceSegmentIdsRef.current.add(detail.segmentId);
      pendingVoiceSegmentsRef.current.push(detail as CompanionVoiceSegmentReadyDetail);
      setVoiceSegmentRevision((value) => value + 1);
    };
    window.addEventListener("ailearn:companion-voice-segment-ready", onVoiceSegment);
    return () => {
      window.removeEventListener("ailearn:companion-voice-segment-ready", onVoiceSegment);
    };
  }, []);

  // ── 呼吸角标接真实输出振幅（方案 §4） ─────────────────────────────────
  // 订阅的是**输出**振幅（`subscribeHomeV2VoiceLevel`：HomeV2AudioController 的真
  // AnalyserNode 每帧峰值），不是麦克风那条输入电平。好处是角标与她嘴型的起伏来自
  // 同一个数，天然对得上，不需要再标定。逐帧写 CSS 变量、不进 React state。
  useEffect(() => subscribeHomeV2VoiceLevel((level) => {
    presenceRef.current?.style.setProperty("--voice-level", level.toFixed(3));
  }), []);

  // 出声/停声由播放相位驱动：只有真的在出声才让角标跟着振幅走。
  useEffect(() => {
    let returnTimer = 0;
    return subscribeCompanionSpeech((progress) => {
      window.clearTimeout(returnTimer);
      if (progress.phase === "speaking") {
        setBreath("speaking");
        return;
      }
      // finished / stopped / failed：先从当前振幅回落，再交回静息呼吸。
      setBreath("returning");
      returnTimer = window.setTimeout(() => setBreath("rest"), COMPANION_BREATH_RETURN_MS);
    });
  }, []);

  useEffect(() => {
    if (chat.mode === "actions") setMoreView("menu");
  }, [chat.mode]);

  // ── 流式草稿：喂给语音会话，显现交给驱动器 ─────────────────────────────
  //
  // 历史：§3.1 曾把朗读时机从"草稿一到就开念"改成"`assistant.final` 到达后整句一次"，
  // 理由是**她在念一句还没定稿的话**——合成按草稿切段排队，后到的文本接着往下念，
  // 语气收尾接在半截话上。代价就是实机症状 ④："文本一整块出现之后语音才开始，
  // 体验割裂"。
  //
  // 但那个顾虑的前提（"草稿切段会把半截话排进队列"）已经不成立：`beginCompanionSpeechLine`
  // 的 `feed` 走的是 `splitForSpeechIncremental`，**只把已经写完的句子**排进队列，
  // 没写完的尾巴留在缓冲里等下一拍或 `finish`。所以现在两边都能要：文本还在长，
  // 她已经开口；开口念的仍然是完整句。
  //
  // 2026-09-19 字幕式：这一拍**不再**把显现设成草稿长度。文本到货量只登记给驱动器，
  // 露多少字由音频/阅读钟决定——"文本先铺满、语音再开念"的观感就是从这里消失的。
  useEffect(() => {
    const draft = chat.draft;
    const reveal = ensureRevealDriver();
    if (!draft) return;
    if (draftRunIdRef.current !== draft.runId) {
      draftRunIdRef.current = draft.runId;
      setBubbleExpanded(false);
      // 换轮：上一轮没念完的立刻停掉，否则两轮的语音会叠在一起。先摘掉计划 id，
      // 免得旧计划的 `stopped` 广播把新的一轮误判成"音频停了"。
      activeSpeechPlanRef.current = null;
      speechSessionRef.current?.stop();
      speechSessionRef.current = null;
      speechPositionSessionRef.current = null;
      pendingVoiceSegmentsRef.current = pendingVoiceSegmentsRef.current.filter((segment) => segment.runId === draft.runId);
      seenVoiceSegmentIdsRef.current.clear();
      for (const segment of pendingVoiceSegmentsRef.current) seenVoiceSegmentIdsRef.current.add(segment.segmentId);
    }
    reveal.noteArrived(draft.text.length);
    setBubbleStage("visible");

    if (!voiceEnabled) {
      reveal.noteSession("unavailable");
      return;
    }
    // 正文朗读只走服务端签发的片段引用（strictSegments）：渲染层不再本地切段、
    // 不再做字符串前缀匹配——语气标签剥离后的真实字符区间只有服务端知道，本地
    // 匹配就是猜（2026-09-19 之前的 180ms 文字回退由此整个删除）。服务端片段迟迟
    // 不到时，播放层的首段 1.6s / 段间 1.2s 截止会把本轮平滑降级为纯文字。
    // 不设长度门槛（2026-09-20 用户实测"短内容不发音"）：要不要发声由 worker 的
    // 分段器决定——它对任何剩余文本在 final 时都会成段，「哈哈」这类短回复照样
    // 有段可念；整轮没有段时由播放层直接收尾，显现交回阅读钟。
    if (speechSessionRef.current === null) {
      speechSessionRef.current = beginCompanionSpeechLine({ strictSegments: true });
      activeSpeechPlanRef.current = speechSessionRef.current.planId;
      speechPositionSessionRef.current = speechSessionRef.current;
    }
    const session = speechSessionRef.current;
    reveal.noteSession(session ? session.mode : "unavailable");
    if (!session) return;
    // 只喂本轮的段；feedSegment 内部按 segmentId 幂等，SSE 重连重放不会念两遍。
    const remainingSegments: CompanionVoiceSegmentReadyDetail[] = [];
    for (const segment of pendingVoiceSegmentsRef.current.sort((a, b) => a.ordinal - b.ordinal)) {
      if (segment.runId !== draft.runId) {
        remainingSegments.push(segment);
        continue;
      }
      session.feedSegment({
        ref: {
          version: 2,
          conversationId: segment.conversationId,
          runId: segment.runId,
          generation: segment.generation,
          ordinal: segment.ordinal,
          segmentId: segment.segmentId,
        },
        displayText: segment.displayText,
        displayStart: segment.displayStart,
        displayEnd: segment.displayEnd,
        cue: segment.cue,
      });
    }
    pendingVoiceSegmentsRef.current = remainingSegments;
  }, [chat.draft, ensureRevealDriver, voiceEnabled, voiceSegmentRevision]);

  useEffect(() => {
    const reply = chat.liveReply;
    const reveal = ensureRevealDriver();
    if (!reply) {
      // 流式草稿正显示着、或"说到一半被打断"的留档还在，都不复位——复位只在
      // 真的一无所有时发生。
      if (chat.draft) return;
      const partial = chat.interrupted?.text ?? "";
      if (partial.trim().length > 0) {
        // 失败/超时：文本不会再长了，剩下的字交给驱动器按阅读节奏露完。
        // **不** noteTurnFinal：这条留档要留在视野里（用户要看清她说到哪儿了），
        // 由下一次发送或新的回复来收掉。
        reveal.noteArrived(partial.length);
        reveal.noteSession("unavailable");
        setBubbleStage("visible");
        // 稳定摘要只发这一次（方案 §3 无障碍）：流式期间不逐字播报。
        setTurnSummary(chat.failure ? `${partial.trim()} ${chat.failure}` : partial.trim());
        return;
      }
      // 这一轮再也没有终态回复了（失败/被丢弃）：正在念的也要停掉，
      // 否则用户会听到一句"库里的记录里已经没有的话"。
      activeSpeechPlanRef.current = null;
      speechSessionRef.current?.stop();
      speechSessionRef.current = null;
      speechPositionSessionRef.current = null;
      pendingVoiceSegmentsRef.current = [];
      seenVoiceSegmentIdsRef.current.clear();
      reveal.reset();
      setBubbleStage("visible");
      draftRunIdRef.current = null;
      return;
    }
    const text = companionHudReplyText(reply);
    const total = text.trim().length;
    // 朗读收尾：正文只能通过服务端签发的片段引用播放（strictSegments），自由文本
    // TTS 的终态兜底链路已删除。流式阶段开过口的会话在这里收尾；没开过口的
    // （整段到达、未走流式草稿）在这里补开一个——服务端片段通常在 assistant.final
    // 前后到达，此刻把缓冲里的段喂进去还来得及播。
    let session = speechSessionRef.current;
    speechSessionRef.current = null;
    if (!session && voiceEnabled) {
      session = beginCompanionSpeechLine({ strictSegments: true });
    }
    let handle: ActiveCompanionSpeech | null = null;
    if (session) {
      if (!voiceEnabled) {
        // 语音被关掉：会话收干净，别挂在后台继续合成。
        activeSpeechPlanRef.current = null;
        speechPositionSessionRef.current = null;
        session.stop();
      } else {
        // 把缓冲里还没喂的服务端段补进会话（走流式时已喂过，segmentId 幂等），
        // 然后封队：迟到的片段不再入队（"本轮不再次突然恢复朗读"）。
        for (const segment of pendingVoiceSegmentsRef.current.sort((a, b) => a.ordinal - b.ordinal)) {
          const runId = draftRunIdRef.current;
          if (runId !== null && segment.runId !== runId) continue;
          session.feedSegment({
            ref: {
              version: 2,
              conversationId: segment.conversationId,
              runId: segment.runId,
              generation: segment.generation,
              ordinal: segment.ordinal,
              segmentId: segment.segmentId,
            },
            displayText: segment.displayText,
            displayStart: segment.displayStart,
            displayEnd: segment.displayEnd,
            cue: segment.cue,
          });
        }
        pendingVoiceSegmentsRef.current = [];
        // final 只封住入队，不会立刻播完；显现心跳仍需持有这一会话的音频时钟。
        speechPositionSessionRef.current = session;
        session.finish();
        handle = { planId: session.planId, mode: session.mode, stop: () => session.stop() };
      }
    }
    activeSpeechPlanRef.current = handle?.planId ?? null;
    let stopped = false;
    let holdTimer = 0;
    let exitTimer = 0;
    /**
     * 全文显示后的停留按文字长度取 2.4–6s；真实朗读、不可见状态和最近 2.5s
     * 的操作暂停计时。静止悬停、焦点与旁边的确认框不会让回复常驻。
     */
    const HOLD_TICK_MS = 120;
    let remainingHoldMs = companionBubbleHoldMs(total);
    const holdPaused = (): boolean => {
      if (document.hidden || replyObscuredRef.current || performance.now() < replyActivityUntilRef.current) return true;
      if (speakingRef.current) return true;
      // **还没露完就不许收走**（2026-09-22 用户报"显示的时机只有那一会儿"）。
      // 停留计时原来只看"朗读中"，而文字是跟着音频位置走的：她一句话说完、下一段
      // 还没开口的那几秒里 `speaking` 是假，计时照走——气泡在正文只露了半句时就消失。
      const driver = revealDriverRef.current;
      if (driver && driver.revealed < driver.arrived) return true;
      return false;
    };
    holdTimer = window.setInterval(() => {
      if (stopped) return;
      if (!holdPaused()) remainingHoldMs -= HOLD_TICK_MS;
      if (remainingHoldMs > 0) return;
      window.clearInterval(holdTimer);
      holdTimer = 0;
      setBubbleStage("leaving");
      exitTimer = window.setTimeout(() => {
        if (!stopped) chat.dismissLiveReply();
      }, BUBBLE_EXIT_MS);
    }, HOLD_TICK_MS);

    // 这一轮到此不会再长了：把到货量交给驱动器，但**不**补满显现。
    // 露多少字由音频进度（或它没动静时的阅读钟）决定，收尾只由 onComplete 触发——
    // 旧实现在这里 `setRevealedChars(total)` 再"文本已到齐就 dismiss"，
    // 于是静音时气泡 1.24 秒后必然消失（症状②-A）。
    reveal.noteArrived(total);
    reveal.noteSession(handle ? handle.mode : "unavailable");
    reveal.noteTurnFinal();
    // 稳定摘要（方案 §3 无障碍）：回合终态只发布一次全文，读屏不再跟着逐字流
    // 反复朗读碎片。setState 同值时 React 直接跳过，天然去重。
    setTurnSummary(total > 0 ? text : (chat.failure ?? "这一轮没有返回内容。"));
    setBubbleStage("visible");
    if (total <= 0) {
      window.clearInterval(holdTimer);
      holdTimer = 0;
      setBubbleStage("leaving");
      exitTimer = window.setTimeout(() => {
        if (!stopped) chat.dismissLiveReply();
      }, BUBBLE_EXIT_MS);
    }

    return () => {
      stopped = true;
      window.clearInterval(holdTimer);
      window.clearTimeout(exitTimer);
      handle?.stop();
      if (speechPositionSessionRef.current?.planId === handle?.planId) {
        speechPositionSessionRef.current = null;
      }
    };
  }, [chat.dismissLiveReply, chat.draft, chat.interrupted, ensureRevealDriver, chat.liveReply, voiceEnabled]);

  /**
   * 播放进度 → 显现驱动器（2026-09-19 字幕式朗读）。
   *
   * 订阅只建一次、跨"草稿期 → 终态期"：音频在草稿阶段就已经开口，进度必须当场喂给
   * 驱动器，否则第一句念完了字还没跟上。只认本轮那个计划 id——换轮时旧计划的
   * `stopped` 广播会把新的一轮误判成"音频停了"。
   */
  useEffect(() => subscribeCompanionSpeech((progress) => {
    // 先记"本轮是否正在出声"：停留计时要在朗读期间暂停（方案 §3）。
    speakingRef.current = progress.phase === "speaking" && progress.planId === activeSpeechPlanRef.current;
    const driver = revealDriverRef.current;
    if (!driver || progress.planId !== activeSpeechPlanRef.current) return;
    // `speaking` 的进度**不再**喂给驱动器：那是 80ms 一次的采样值，用它驱动字幕就是
    // 让字幕跟着"上一次采样 + 时间外推"走（第二个时钟，必然漂移）。位置改由下面那个
    // 心跳从音频时钟现算（§14.11 ⑤）。
    if (progress.phase === "speaking") {
      // 位置见下面那个 tick；真的在出声了，就没有什么要解释的。
      setSpeechNotice(null);
    } else if (progress.phase === "finished" && progress.visibleChars > 0) {
      driver.noteAudioFinished();
    } else if (progress.phase === "text_only" || progress.phase === "failed") {
      driver.noteAudioStopped();
      // 原因那句话**不是这里写的**：播放层在降级那一刻就把人话放进 `progress.failure`
      // （"语音合成超时，已继续显示文字"，或网关错误对应的那句人话）。以前三条 emit
      // 全在填这个字段、渲染层没有一个人读 —— 数据一直有，缺的只是把它念出来（E6）。
      // 这里不留自造的兜底文案：宁可少一句，也不要第二套"为什么没念"的说法。
      setSpeechNotice(progress.failure ?? null);
    } else {
      // 整轮一个字都没念过（服务端语音关着 / 没有任何片段），或用户自己停了：
      // 不能按"音频播完"处理——那会瞬间推满全文。交回阅读钟，让文字仍按阅读节奏露出。
      driver.noteAudioStopped();
    }
  }), []);

  /**
   * 阅读钟的心跳：没有音频在说话时按阅读节奏推进显现（谁在主导由驱动器判断）。
   * 只在"这一轮还活着"时跑，气泡收起后不留常驻定时器。
   *
   * `chat.interrupted` 也算"活着"：失败/超时后留在气泡里的那半句同样要靠钟走完，
   * 否则它会停在被打断的那一刻。
   */
  const turnLive = Boolean(chat.draft || chat.liveReply || chat.interrupted);
  useEffect(() => {
    if (!turnLive) return;
    const timer = window.setInterval(() => {
      const driver = revealDriverRef.current;
      if (!driver) return;
      // 每一拍都从**音频时钟**现算一次位置（没有在播时为 null）。
      // 这是"字幕跟着声音走"的唯一时间来源；驱动器自己不再外推。
      const position = speechPositionSessionRef.current?.currentVisibleChars() ?? null;
      if (position !== null) driver.noteAudioPosition(position);
      driver.tick();
    }, COMPANION_REVEAL_TICK_MS);
    return () => window.clearInterval(timer);
  }, [turnLive]);

  /** 输入框自己长高：不要原生右下角拖拽手柄，也不让用户手动拉。 */
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(112, Math.max(40, el.scrollHeight))}px`;
  }, [input, chat.mode]);
  // Input sizing precedes placement, so its first visible frame uses the final geometry.
  const { side, controlsSide } = useCompanionFloatingPlacement(hudRef, floatingRef, headRef, !floatingBlocked && !settingsOpen && !goalBubbleOpen && chat.mode !== "history");

  /**
   * 停止后气泡要定格住"她已经说出来的那几句"，可停止流程会把草稿清掉——所以在草稿
   * 还在的时候把最后一份文本留一份副本。没有它，用户按下停止的瞬间那句话就从视野里
   * 消失了（虽然服务端已经把它留进历史）。
   */
  useEffect(() => {
    const text = chat.liveReply ? companionHudReplyText(chat.liveReply) : (chat.draft?.text ?? "");
    if (text.trim().length > 0) lastOutputRef.current = text;
  }, [chat.draft, chat.liveReply]);

  useEffect(() => {
    if (!chat.stopNotice) return;
    const stoppedText = activeNoteExplanation?.phase === "stopped"
      ? plainCompanionBubbleText(activeNoteExplanation.text) : lastOutputRef.current;
    setFrozenText(stoppedText);
    // 稳定摘要（方案 §3 无障碍）：停止也是回合终态，发一次"已停止"收尾。
    setTurnSummary(stoppedText.trim().length > 0
      ? `${stoppedText.trim()}（已停止）`
      : "已停止这一轮。");
    // 停止说明是"就地提示"，不是常驻状态；下一次发送也会把它清掉。
    const timer = window.setTimeout(() => chat.dismissStopNotice(), STOP_NOTICE_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [chat.dismissStopNotice, chat.stopNotice, activeNoteExplanation?.id, activeNoteExplanation?.phase, activeNoteExplanation?.text]);

  const sendText = useCallback(async (textOverride?: string, fromVoice = false) => {
    const text = (textOverride ?? input).trim();
    if (!text) return;
    if (!fromVoice) setInput("");
    const sourceConversationId = chat.conversationId;
    if (chat.mode === "conversation") chat.setMode("closed");
    const sendId = ++preparingSendIdRef.current;
    const target = resolveNoteReplySaveTarget(chat.feedNoteAnchor, chat.feedNoteIntent);
    noteReplySaveAttemptRef.current = target && target.kind !== "annotation"
      ? beginNoteReplySaveAttempt(target, chat.liveReply?.messageId ?? null)
      : null;
    // 接替旧回复时已有过程气泡；不要用预检文案把仍在运行的那一轮盖住。
    setPreparingSend(chat.phase !== "sending");
    setBubbleExpanded(false);
    try {
      const selection = chat.feedSelection ?? chat.feedNoteAnchor?.anchor.excerpt;
      const sent = await chat.send({
        text,
        ...(chat.feedNoteAnchor ? { noteAnchor: chat.feedNoteAnchor } : {}),
        ...(selection ? { selection: { text: selection } } : {}),
      });
      if (sent) chat.dismissFeedSelection();
      else if (sendId === preparingSendIdRef.current) {
        noteReplySaveAttemptRef.current = null;
        if (!fromVoice && (sourceConversationId === null || sourceConversationId === conversationIdRef.current)) setInput((current) => current || text);
      }
      return sent;
    } catch (error) {
      noteReplySaveAttemptRef.current = null;
      if (!fromVoice && (sourceConversationId === null || sourceConversationId === conversationIdRef.current)) setInput((current) => current || text);
      throw error;
    } finally {
      if (sendId === preparingSendIdRef.current) setPreparingSend(false);
    }
  }, [chat, input]);

  useEffect(() => {
    const requestId = chat.autoSendRequestId;
    const text = chat.feedPrompt?.trim();
    if (!requestId || !text || autoSendRequestRef.current === requestId) return;
    autoSendRequestRef.current = requestId;
    void sendText(text).catch(() => undefined);
  }, [chat.autoSendRequestId, chat.feedPrompt, sendText]);

  useEffect(() => {
    if (chat.phase === "sending") setPreparingSend(false);
  }, [chat.phase]);

  /** 停止：**先在本地静音**（方案 §6 第 2 点），再走服务端取消——用户要的是"现在闭嘴"。 */
  const stopTurn = useCallback(() => {
    stopCompanionSpeech();
    ++preparingSendIdRef.current;
    setPreparingSend(false);
    noteReplySaveAttemptRef.current = null;
    void chat.cancel();
  }, [chat]);

  // `plainCompanionBubbleText` 是十来趟正则扫全文。它以前裸在渲染体里：伴星每到一个
  // token、阅读钟每走一拍都重跑一遍，而输入文字其实只在块到达时才变。按原文 memo 之后，
  // 逐字显现（下面的 `companionBubbleText`）不再触发任何一次剥离。
  const replyText = useMemo(
    () => (chat.liveReply ? plainCompanionBubbleText(companionHudReplyText(chat.liveReply)) : ""),
    [chat.liveReply],
  );
  const draftText = useMemo(
    () => plainCompanionBubbleText(chat.draft?.text ?? ""),
    [chat.draft?.text],
  );
  const phase = replyText || draftText ? "replying"
        : chat.phase === "sending" ? "thinking"
          : "idle";

  /**
   * 气泡的**单节点槽位**（方案 §3.2）：永远只有"当前这一件"，过去的节点不在气泡里
   * 留痕（留痕在头顶轨道与抽屉）。切换即替换、不同时在场。
   *
   * 优先级按"谁更接近此刻"排：她已经说出来的字 > 停止定格 > 正在做的那个过程节点 >
   * 阶段提示 > 系统提示。过程节点的文案直接取协议 `safeLabel`，不自造描述。
   */
  const currentNode = chat.nodes.length > 0 ? chat.nodes[chat.nodes.length - 1] : null;
  const activeNode: CompanionAgentNode | null = currentNode?.state === "running" ? currentNode : null;
  const shownReply = replyText || draftText;
  const replySlotText = preparingSend && chat.phase !== "sending" ? ""
    : shownReply ? bubbleExpanded
      ? shownReply.slice(0, Math.max(0, revealedChars))
      : companionBubblePreviewText(shownReply, revealedChars)
    // 草稿也按显现计数切片（2026-09-19）：文本到货量不等于该露多少，
    // 露多少由音频/阅读钟决定——"整块文字先出完再念"就是这里漏出来的。
      : "";
  /**
   * 说到一半被打断（失败/超时）：那半句继续留在气泡里，按同一套显现节奏露完。
   * 说明句单独一行挂在下面（`.companion-hud__output-note`），不挤进正文。
   */
  const interruptedText = useMemo(
    () => plainCompanionBubbleText(chat.interrupted?.text ?? ""),
    [chat.interrupted?.text],
  );
  const interruptedSlotText = interruptedText ? companionBubbleText(interruptedText, revealedChars) : "";
  const interruptedNote = interruptedSlotText && chat.failure ? chat.failure : null;
  /** 朗读降级说明随回复收起；拾音提示只属于独立语音气泡。 */
  const outputNotice = speechNotice;
  const slot: { readonly tone: "reply" | "process" | "stopped" | "note"; readonly text: string } | null =
    preparingSend && chat.phase !== "sending" ? { tone: "process", text: "正在准备这轮对话…" }
      : replySlotText ? { tone: "reply", text: replySlotText }
      : chat.stopNotice ? { tone: "stopped", text: frozenText || chat.stopNotice }
        : interruptedSlotText && interaction.errorVisible ? { tone: "stopped", text: interruptedSlotText }
          : chat.phase === "error" && chat.failure && interaction.errorVisible ? { tone: "note", text: chat.feedNoteAnchor ? "这段解释还没生成，原文没有改动。" : chat.failure }
            : chat.phase === "sending" && activeNode ? { tone: "process", text: nodeLabel(activeNode) }
              : phase === "thinking" ? { tone: "process", text: "我先结合当前页面想一想。" }
                    : speechNotice && interaction.errorVisible ? { tone: "note", text: speechNotice }
                      : null;
  const outputText = slot?.text ?? "";
  const outputTone = slot?.tone ?? "reply";
  const stopping = chat.cancelling;
  const turnFailure = visibleTurnFailure(chat);

  /** 把最新一行钉回视野（用户已经自己往上读过时，状态机给的答案是"什么都不做"）。 */
  const pinBubbleToLatest = useCallback(() => {
    const el = bubbleBodyRef.current;
    if (!el) return;
    const next = bubbleFollow.pinnedScrollTop({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
    if (next === null) return;
    el.scrollTop = next;
  }, [bubbleFollow]);

  const measureBodyClipped = useCallback(() => {
    const el = bubbleBodyRef.current;
    if (el) setBodyClipped(el.scrollHeight > el.clientHeight + 1);
  }, []);

  /**
   * 正文元素的回调 ref：新气泡（= 新一轮）挂载即把跟随复位到"贴底"。上一轮用户自己
   * 往上读到的位置不该跟到下一轮——那时正文已经换了一段话。
   */
  const setBubbleBodyEl = useCallback((el: HTMLParagraphElement | null) => {
    bubbleBodyRef.current = el;
    if (el) bubbleFollow.reset();
  }, [bubbleFollow]);

  /**
   * 用户动了滚动条就把"跟随"交回给他：只要他不是停在底部，后面推进的新字就不再抢他的
   * 位置。他自己滚回底部，跟随自动恢复（规则见 `companion-bubble-follow.ts`）。
   */
  const handleBubbleScroll = useCallback((event: ReactUIEvent<HTMLParagraphElement>) => {
    const el = event.currentTarget;
    bubbleFollow.noteScroll({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
  }, [bubbleFollow]);

  /**
   * 跟随最新一行（2026-09-20 用户截图：长消息在气泡里不跟最新位置，像卡住）。
   *
   * 显现钟每 60ms 推一个字，气泡装满之后新字从底部冒出来；不跟底，用户看到的永远是
   * 开头那几行，最新的字长在视野之外。这里用 layout effect 而不是 passive：贴底要赶在
   * 这一帧画出来之前完成，否则每推进一行都会先闪一下"字被切在底边"。
   */
  useLayoutEffect(() => {
    pinBubbleToLatest();
  }, [outputText, pinBubbleToLatest]);

  useLayoutEffect(() => {
    measureBodyClipped();
  }, [outputText, bubbleExpanded, measureBodyClipped]);

  useLayoutEffect(() => {
    const el = bubbleBodyRef.current;
    if (!el) return;
    const observer = new ResizeObserver(measureBodyClipped);
    observer.observe(el);
    return () => observer.disconnect();
  }, [bubbleEl, measureBodyClipped]);

  useLayoutEffect(() => {
    const el = bubbleBodyRef.current;
    if (!el) return;
    if (bubbleExpanded) {
      el.scrollTop = 0;
      bubbleFollow.noteScroll({ scrollTop: 0, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
    } else {
      bubbleFollow.reset();
      pinBubbleToLatest();
    }
  }, [bubbleExpanded, bubbleFollow, pinBubbleToLatest]);

  /**
   * 容器尺寸变化同样要回底：窗口缩放会重算 `--companion-bubble-max-h`、失败说明行会占走
   * 正文的高度——容器变矮时，"底部"已经不是屏幕上那一行。ResizeObserver 在挂载时自带
   * 一次回调，所以首屏那一贴也由它兜住（此时 layout effect 可能还没拿到最终高度）。
   */
  useLayoutEffect(() => {
    const el = bubbleBodyRef.current;
    if (!el) return;
    const observer = new ResizeObserver(pinBubbleToLatest);
    observer.observe(el);
    return () => observer.disconnect();
  }, [bubbleEl, pinBubbleToLatest]);

  // ── 头顶步骤轨道（方案 §1） ──────────────────────────────────────────
  // 步数只能取服务端记录的 run 摘要（`assistant.status` 一轮只发一次，客户端数不出步数）。
  // 只认「当前活跃的那个 run」：摘要按 1.6s 轮询到，还没到就只显示工具次数，不猜步数。
  const activeTrace = chat.runTraces.find((trace) => trace.summary.status === "running"
    || trace.summary.status === "accepted"
    || trace.summary.status === "waiting_for_confirmation"
    || trace.summary.status === "cancel_requested") ?? null;
  /**
   * 停止之后这一轮就不在"活跃"里了，可方案 §6 要的收尾文案是
   * 「已停止 · 思考 2 步 · 调用 1 次工具」——步数只有服务端记的 run 摘要里有，客户端
   * 数不出来。
   *
   * 判据取 **run 的终态**（`companion-cancel.ts` 把用户停掉的那一轮先落
   * `cancel_requested`、worker 收完再落 `cancelled`），不取气泡那条 6s 后就撤掉的提示：
   * `stopNotice` 一过期，摘要就退回「0/4 步 · 1/12 次工具」，读起来像一轮没跑过的新任务，
   * "这一轮被停掉"在轨道上消失——而轨道收起来之后仍在，那里才是该留痕的地方。
   * `stopNotice` 只在"点了停止、摘要还没送来"这段空窗里兜底。
   *
   * 另外必须认这两个状态而不是只认活跃态：常驻气泡态下轨道轮询是关的（只在历史抽屉里或
   * 生成中轮询），停完之后摘要会**停在** `cancel_requested` 不再往前走，所以只认
   * `cancelled` 会在最常见的路径上失手。
   */
  const latestTrace = chat.runTraces[0] ?? null;
  const stoppedTrace = latestTrace && (latestTrace.summary.status === "cancel_requested"
    || latestTrace.summary.status === "cancelled") ? latestTrace : null;
  const progressTrace = activeTrace ?? stoppedTrace;
  const railProgress: CompanionAgentRailProgress | null = progressTrace ? {
    stepCount: progressTrace.summary.stepCount,
    maxSteps: progressTrace.summary.maxSteps,
    toolCallCount: progressTrace.summary.toolCallCount,
    maxToolCalls: progressTrace.summary.maxToolCalls,
  } : null;
  const railTurnState: CompanionAgentRailTurnState = chat.phase === "sending" ? "running"
    : stoppedTrace || chat.stopNotice ? "stopped"
      : chat.phase === "error" ? "failed"
        : "done";
  /**
   * 只在**这一轮真的调用过工具**时挂轨道——每句话都挂一条 UI 是噪音（方案 §1）。
   *
   * 判据以前是"节点里有 skill，或摘要 mode=hybrid"。技能层删掉之后 hybrid 恒真，
   * 那个字段就不再表达任何事实了；工具节点是剩下的唯一确证，而且它比 mode 更硬：
   * 它说的是"这轮确实查/做了东西"，不是"系统打算允许她查"。
   *
   * 完成后独立计时，位于回复上方；完整过程仍留在同一条会话记录中。
   */
  const railVisible = interaction.toolVisible;

  /**
   * 工具节点的每一次状态迁移各通知角色层一次（`requested → executing` 算同一步的
   * 开始，只报一次；`succeeded / failed / waiting_confirmation` 各是它的结果）。
   * 按节点 `key` 记账上一次已报的状态，所以重渲、轮询回包都不会重复触发。
   */
  const announcedToolRef = useRef<Map<string, CompanionAgentNodeState>>(new Map());
  useEffect(() => {
    if (!onAgentToolState) return;
    if (chat.nodes.length === 0) {
      announcedToolRef.current.clear();
      return;
    }
    for (const node of chat.nodes) {
      if (node.kind !== "tool") continue;
      if (announcedToolRef.current.get(node.key) === node.state) continue;
      announcedToolRef.current.set(node.key, node.state);
      onAgentToolState(node.state);
    }
  }, [chat.nodes, onAgentToolState]);

  const toggleVoice = interaction.toggleVoice;

  // 优先展示刚落地回复里的选择；气泡文字消失后，尚未决定的真实 proposal 仍留在伴星旁。
  // 这样用户不需要在一秒多的回复停留时间里抢着点，也不会为了作决定被迫打开历史。
  const proposalEntries = Object.entries(chat.proposalStates);
  const liveProposalId = [...(chat.liveReply?.proposalIds ?? [])].reverse().find((proposalId) => {
    const state = chat.proposalStates[proposalId];
    return !state || state.phase !== "ready" || state.proposal.status === "pending";
  });
  const pendingProposalId = liveProposalId ?? [...proposalEntries].reverse().find(([, state]) => (
    state.phase === "loading" || (state.phase === "ready" && state.proposal.status === "pending")
  ))?.[0] ?? null;

  /**
   * 选择卡的无障碍播报（方案 §3）：出现与状态变化各发一句**简短**提示，靠
   * `lastProposalNoticeRef` 去重——`proposalStates` 每次快照刷新都是新对象，
   * 不去重的话读屏会反复念同一句。
   */
  const lastProposalNoticeRef = useRef("");
  useEffect(() => {
    const state = pendingProposalId ? chat.proposalStates[pendingProposalId] : undefined;
    let next = "";
    if (pendingProposalId && (!state || state.phase !== "ready" || state.proposal.status === "pending")) {
      next = `${chat.companionName} 有一项动作在等你确认；可以稍后决定，也可以直接继续聊。`;
    } else if (state?.phase === "ready" && state.proposal.status !== "pending") {
      next = state.proposal.status === "accepted" ? "动作建议已确认。"
        : state.proposal.status === "rejected" ? "动作建议已拒绝。"
          : state.proposal.status === "expired" ? "动作建议已过期。"
            : "动作建议已处理。";
    }
    if (!next || next === lastProposalNoticeRef.current) return;
    lastProposalNoticeRef.current = next;
    setProposalNotice(next);
  }, [pendingProposalId, chat.proposalStates]);

  // 语音模型在设置 → 伴星 → 声音与显示。与边缘设置里那条走同一个通道：设分区 → 开设置页。
  const openVoiceModelSettings = useCallback(() => {
    openVoiceModelSettingsAction();
    interaction.closeVoice();
  }, [interaction]);

  return (
    <div ref={hudRef} className="companion-hud" data-mode={chat.mode} data-motion={motionMode} data-side={side} data-controls-side={controlsSide}>
      {createPortal(
        <div ref={floatingRef} className="companion-hud--floating hud-surface" data-companion-owned="true" data-motion={motionMode} data-mode={chat.mode} data-side={side} data-blocked={floatingBlocked || settingsOpen || goalBubbleOpen || chat.mode === "history" || undefined}>
          <div ref={headRef} className="companion-hud__head" aria-label="伴星的轻量交互">
            {railVisible ? (
              <CompanionAgentRail
                nodes={chat.nodes}
                progress={railProgress}
                turnState={railTurnState}
                companionName={chat.companionName}
                onActivity={interaction.toolActivity}
              />
            ) : null}
            {outputText ? (
              <div
                ref={setBubbleEl}
                className="companion-hud__output"
                data-stage={bubbleStage}
                data-tone={outputTone}
                data-slot={slot?.tone ?? "reply"}
                data-expanded={bubbleExpanded || undefined}
                data-breath={breath}
                onPointerMove={noteReplyActivity}
                onKeyDown={noteReplyActivity}
                onWheel={noteReplyActivity}
                onFocus={noteReplyActivity}
              >
                <header className="companion-hud__reply-heading"><strong><Sparkles size={15} />{outputTone === "reply" ? chat.companionName : outputTone === "process" ? "正在处理" : "这轮对话"}</strong>{chat.liveReply ? <button type="button" onClick={chat.dismissLiveReply} aria-label="收起伴星回复"><X size={16} /></button> : null}</header>
                {activeNoteExplanation ? <CompanionNoteExplanationContext item={activeNoteExplanation} /> : null}
                <span className="companion-hud__presence-dot" ref={presenceRef} aria-hidden="true" />
                {/* 长回复的正文在它自己里面滚，新字钉在视野里（见上面的跟随 effect）。 */}
                <p className="companion-hud__output-body" ref={setBubbleBodyEl} onScroll={handleBubbleScroll}>{outputText}</p>
                {/* 视觉流式文本**不是**持续 live region（方案 §3 无障碍）：逐字更新会让读屏
              反复朗读碎片；回合终态的稳定摘要在下方 `companion-hud__sr-status` 发布。 */}
                {/* 被打断的原因就在这里说清楚——以前它只出现在输入面板里，
              用户收起面板就既看不见原因、也不知道那半句还在不在（症状①-D）。 */}
                {interruptedNote ? <p className="companion-hud__output-note" role="status">{interruptedNote}</p> : null}
                {outputNotice && slot?.text !== outputNotice ? (
                  <p className="companion-hud__output-note" role="status">{outputNotice}</p>
                ) : null}
                {/* 收起态只给两行预览；用户明确点击后才显示全文。显现与语音独立。 */}
                {slot?.tone === "reply" && (bodyClipped || bubbleExpanded) ? (
                  <button
                    type="button"
                    className="text-action companion-hud__output-reveal"
                    onClick={() => {
                      if (!bubbleExpanded) revealDriverRef.current?.finish();
                      setBubbleExpanded((value) => !value);
                    }}
                  >
                    {bubbleExpanded ? "收起回复" : "展开完整回复"}
                  </button>
                ) : null}
                {outputTone === "note" && !activeNoteExplanation && chat.feedNoteAnchor && chat.phase === "error" ? <button type="button" className="text-action companion-hud__output-retry" onClick={() => { void sendText(chat.feedPrompt ?? "请用通俗易懂的话解释这段，并举一个短例子。").catch(() => undefined); }}>重试这段解释</button> : null}
                {outputTone === "reply" || outputTone === "stopped" ? <footer className="companion-hud__reply-foot"><span>{chat.phase === "sending" ? "正在回复…" : "读完后收起"}</span><button type="button" className="text-action" onClick={() => chat.setMode("history")}>手记<ChevronLeft size={14} /></button></footer> : null}
                {/* 停止（方案 §6）：生成中用户视线在气泡上，不该强迫他把鼠标移到旁边的按钮列。 */}
                {chat.phase === "sending" || preparingSend ? (
                  <button
                    type="button"
                    className="text-action companion-hud__output-stop"
                    disabled={stopping}
                    onClick={stopTurn}
                    title="停止这一轮"
                    aria-label="停止这一轮"
                  >
                    {stopping ? <Loader2 className="companion-hud__spin" size={13} aria-hidden="true" /> : <Square size={11} fill="currentColor" aria-hidden="true" />}
                    <span>{stopping ? "正在停止…" : "停止"}</span>
                  </button>
                ) : null}
              </div>
            ) : null}
            {chat.mode === "conversation" ? (
              <section className="companion-hud__panel companion-hud__composer" aria-label={`给 ${chat.companionName} 的消息气泡`} onPointerMove={interaction.inputActivity} onKeyDown={interaction.inputActivity} onWheel={interaction.inputActivity} onFocus={interaction.inputActivity}>
                <header>
                  <strong>{chat.feedNoteIntent ? `请 ${chat.companionName} ${chat.feedNoteIntent.kind === "overview" ? "帮你速看" : chat.feedNoteIntent.kind === "recall" ? "陪你回想" : chat.feedNoteIntent.kind === "recall_hint" ? "给你一点线索" : "陪你往外学"}` : chat.feedSelection ? `带着这段内容问 ${chat.companionName}` : `说给${chat.companionName}`}</strong>
                  <button type="button" onClick={() => chat.setMode("closed")} aria-label="收起消息气泡"><X size={16} /></button>
                </header>

                {chat.feedSelection ? (
                  <blockquote>
                    <Quote size={15} aria-hidden="true" />
                    <span>{chat.feedSelection}</span>
                    <button type="button" className="companion-hud__quote-remove" onClick={chat.dismissFeedSelection} aria-label="移除引用"><X size={14} /></button>
                  </blockquote>
                ) : null}



                <form
                  data-sending={chat.phase === "sending" || undefined}
                  onSubmit={(event) => { event.preventDefault(); void sendText(); }}
                >
                  <textarea
                    ref={composerRef}
                    autoFocus
                    rows={1}
                    value={input}
                    onChange={(event) => setInput(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (shouldSendCompanionOnEnter(event)) {
                        event.preventDefault();
                        void sendText();
                      }
                    }}
                    placeholder={chat.feedSelection
                      ? "关于这段内容，想问她什么？"
                      : "想聊哪一句？就在这里说…"}
                    aria-label={`给 ${chat.companionName} 的消息`}
                    // 生成中也允许继续打字：发送这条路服务端本来就支持 supersede（新消息接替
                    // 正在跑的那一轮），把输入框锁死只会让用户以为"她没停我不能说话"。
                    disabled={voice.phase === "transcribing"}
                  />
                  <div className="companion-hud__compose-tools">
                  <button type="button" className="companion-hud__compose-action" onClick={() => chat.setMode("actions")} aria-label="当前页面快捷操作" title="当前页面快捷操作"><Plus size={20} /></button>
                  <span>Enter 发送</span>
                  {/*
              方案 §2：生成期间「停止」常驻原位（不再把发送按钮整个换掉——位置不跳，
              鼠标不用追）；输入框非空时旁边同时出现「发送并接替」。按钮与键盘 Enter
              走同一条 `sendText → chat.send`，服务端 supersedesGeneration 接替旧轮，
              从此不会再有"Enter 能发、按钮不能发"的两套真话。
            */}
                  {chat.phase === "sending" ? (
                    <button
                      type="button"
                      className="companion-hud__composer-stop"
                      disabled={stopping}
                      onClick={stopTurn}
                      title="停止当前回复"
                      aria-label="停止当前回复"
                    >
                      {stopping
                        ? <Loader2 className="companion-hud__spin" size={17} aria-hidden="true" />
                        : <Square size={15} fill="currentColor" aria-hidden="true" />}
                    </button>
                  ) : null}
                  <button
                    type="submit"
                    disabled={!input.trim() || voice.phase === "transcribing"}
                    title={chat.phase === "sending" ? "发送并接替当前回复" : "发送"}
                    aria-label={chat.phase === "sending" ? "发送并接替当前回复" : "发送"}
                  ><Send size={17} /></button>
                  </div>
                </form>
                {/* 只在"当前状态就是出错"时显示。会话层里 failure 只有伴随 phase='error'
              才代表本轮失败；抽屉读成功会把 phase 推回 ready 而 failure 留着，
              那属于上一轮的陈旧报错，不该永远挂在这张气泡上。 */}
                {turnFailure ? <p className="companion-hud__note companion-hud__note--error" role="status">{turnFailure}</p> : null}
              </section>
            ) : null}
            {interaction.voiceOpen ? (
              <section className="companion-hud__panel companion-hud__voice" aria-label="语音气泡" onPointerMove={interaction.voiceActivity} onKeyDown={interaction.voiceActivity} onWheel={interaction.voiceActivity} onFocus={interaction.voiceActivity}>
                <header><strong><Mic size={17} />{voice.phase === "listening" ? "我在听，说完停一下" : voice.phase === "transcribing" ? "正在辨认你说的话…" : "听听你想说的"}</strong><button type="button" onClick={interaction.closeVoice} aria-label="关闭语音气泡"><X size={16} /></button></header>
                {voice.phase === "listening" ? <div className="companion-hud__voice-wave" aria-label="正在录音"><i /><i /><i /><i /><i /><i /><i /></div> : null}
                {voice.phase === "transcribing" ? <p role="status"><Loader2 className="companion-hud__spin" size={18} />识别完成后，你可以修改再发送。</p> : null}
                {interaction.voiceDraft ? <textarea aria-label="识别后的语音文字" value={interaction.voiceDraft.text} onChange={event => interaction.setVoiceDraftText(event.target.value)} placeholder="识别后的文字…" /> : null}
                {voice.note && !voice.modelMissing ? <p className="companion-hud__output-note" role="status">{voice.note}</p> : null}
                {/**
                 * 没装模型时，「开始录音」按钮是不该有的：它按下去只会被挡住。
                 * 换成一句有出处的说明和一个真能走通的下一步。
                 */}
                {voice.modelMissing ? <p className="companion-hud__voice-missing" role="status">
                  语音识别模型是可选的附加功能，装在这台设备上，录音不会离开它。
                  <button type="button" className="button" onClick={openVoiceModelSettings}>去设置里下载</button>
                </p> : null}
                <footer>
                  <button type="button" className="text-action" onClick={interaction.closeVoice}>这次不发</button>
                  {voice.phase === "listening" ? <button type="button" className="button primary" onClick={voice.toggle}><Square size={13} />结束录音</button> : voice.phase === "idle" && interaction.voiceDraft ? <button type="button" className="button primary" disabled={!interaction.voiceDraft.text.trim() || chat.phase === "sending"} onClick={() => {
                    const draft = interaction.voiceDraft; if (!draft) return;
                    interaction.closeVoice();
                    void sendText(draft.text, true).then(sent => { if (sent) interaction.consumeVoiceDraft(draft); }).catch(() => undefined);
                  }}><Send size={16} />发送</button> : voice.phase === "idle" && !voice.modelMissing ? <button type="button" className="button primary" onClick={voice.toggle}><Mic size={16} />开始录音</button> : null}
                </footer>
              </section>
            ) : null}
            {chat.mode === "actions" ? (
              <section className="companion-hud__panel companion-hud__more" aria-label="伴星更多功能" onPointerMove={interaction.menuActivity} onWheel={interaction.menuActivity} onKeyDown={interaction.menuActivity} onFocus={interaction.menuActivity}>
                <header>
                  {moreView !== "menu" ? <button type="button" onClick={() => setMoreView("menu")} aria-label="返回更多功能"><ChevronLeft size={17} /></button> : <span />}
                  <strong>{moreView === "menu" ? "更多" : "当前页快捷操作"}</strong>
                  <button type="button" onClick={() => chat.setMode("closed")} aria-label="关闭更多功能"><X size={16} /></button>
                </header>

                {moreView === "menu" ? (
                  <div className="companion-hud__menu-index">
                    {actions.length > 0 ? (
                      <button type="button" onClick={() => setMoreView("actions")}>
                        <Sparkles size={18} /><span><strong>当前页快捷操作</strong><small>只显示和这里有关的真实入口</small></span>
                      </button>
                    ) : null}
                    <button type="button" onClick={() => chat.setMode("history")}>
                      <History size={18} /><span><strong>我们的对话手记</strong><small>回看连续对话和动作建议</small></span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        // 边缘面板接管密集设置：贴身「更多」菜单同时收起，不出现两层面板。
                        setMoreView("menu");
                        chat.setMode("closed");
                        setSettingsOpen(true);
                      }}
                    >
                      <Settings2 size={18} /><span><strong>此页陪伴</strong><small>此页陪伴与全部伴星设置</small></span>
                    </button>
                  </div>
                ) : (
                  <div className="companion-hud__action-list">
                    {actions.map((action) => {
                      const Icon = action.icon;
                      return (
                        <button key={action.id} type="button" onClick={() => onRunAction(action.id)}>
                          <Icon size={17} /><span><strong>{action.title}</strong><small>{action.purpose}</small></span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
            ) : null}
          </div>
          <CompanionReplyPapers key={chat.conversationId ?? "unbound"} chat={chat} paused={floatingBlocked || settingsOpen || goalBubbleOpen || chat.mode === "history"} extra={chat.feedNoteIntent ? <CompanionStatusPaper identity={`note:${chat.feedNoteIntent.noteTitle}:${recallSaveState}:${expansionTaskState}`} paused={floatingBlocked || chat.phase === "sending" || recallSaveState === "saving" || expansionTaskState === "starting"}>{chat.feedNoteIntent ? (
            <div className={`companion-hud__note-overview${chat.feedNoteIntent.kind === "expansion" ? " companion-hud__note-overview--expansion" : ""}`} aria-live="polite">
              <span>《{chat.feedNoteIntent.noteTitle}》· 按打开时的版本整理</span>
              {(chat.feedNoteIntent.kind === "recall" || chat.feedNoteIntent.kind === "recall_hint") && chat.liveReply && recallSaveState === "error" ? (
                <button
                  type="button"
                  onClick={() => void (chat.feedNoteIntent?.kind === "recall" ? saveReplyAsNoteRecallQuestion() : saveReplyAsNoteRecallHint())}
                >
                  重试保存
                </button>
              ) : null}
              <button type="button" disabled={recallSaveState === "saving"} onClick={chat.dismissFeedNoteIntent} aria-label={chat.feedNoteIntent.kind === "overview" ? "收起速看" : chat.feedNoteIntent.kind === "recall" ? "收起回想" : chat.feedNoteIntent.kind === "recall_hint" ? "收起线索" : "收起拓展建议"}>收起</button>
              {(chat.feedNoteIntent.kind === "recall" || chat.feedNoteIntent.kind === "recall_hint") && (recallSaveState === "saving" || recallSaveMessage)
                ? <small data-state={recallSaveState}>{recallSaveState === "saving" ? "正在把这次回想留在笔记里…" : recallSaveMessage}</small>
                : null}
            </div>
          ) : null}
            {chat.feedNoteIntent?.kind === "expansion" && chat.liveReply?.messageId === expansionReplyMessageId ? (
              <div className="companion-hud__note-expansion-action" aria-live="polite">
                <button type="button" disabled={expansionTaskState === "starting" || expansionTaskState === "started"} onClick={() => void startExpansionTask()}>
                  {expansionTaskState === "starting" ? "正在开始整理…" : expansionTaskState === "started" ? "已经开始整理" : expansionTaskState === "error" ? "重试整理" : "把这些方向整理成草稿"}
                </button>
                <small data-state={expansionTaskState} role={expansionTaskState === "error" ? "alert" : expansionTaskState === "started" ? "status" : undefined}>
                  {expansionTaskMessage ?? "伴星的回复留在对话里；草稿会从笔记原文单独整理，完成后你再逐篇挑选。"}
                </small>
              </div>
            ) : null}
          </CompanionStatusPaper> : null} />
        </div>, document.body)}
      {chat.mode !== "history" ? <nav className="companion-hud__controls" aria-label={`${chat.companionName} 身边的交互`}>
        <button type="button" data-active={chat.mode === "conversation" || undefined} onPointerDown={playButtonBounce} onClick={() => { interaction.closeVoice(); setSettingsOpen(false); chat.setMode(chat.mode === "conversation" ? "closed" : "conversation"); }} title="气泡轻聊" aria-label="气泡轻聊"><MessageCircle size={18} aria-hidden="true" /></button>
        {voiceEnabled ? <button ref={micRef} type="button" data-active={interaction.voiceOpen || undefined} data-voice-phase={voice.phase} data-unsupported={!voice.supported || undefined} onPointerDown={playButtonBounce} onClick={() => { setSettingsOpen(false); toggleVoice(); }} disabled={chat.phase === "sending"} title="语音输入" aria-label="语音输入">{voice.phase === "transcribing" ? <Loader2 className="companion-hud__spin" size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}</button> : null}
        <button type="button" onPointerDown={playButtonBounce} onClick={() => { interaction.closeVoice(); setSettingsOpen(false); chat.setMode("history"); }} title="对话手记" aria-label="对话手记"><History size={18} aria-hidden="true" /></button>
        <button ref={moreControlRef} type="button" data-active={chat.mode === "actions" || settingsOpen || undefined} onPointerDown={playButtonBounce} onClick={() => { interaction.closeVoice(); chat.setMode(chat.mode === "actions" ? "closed" : "actions"); }} title="设置与快捷操作" aria-label="设置与快捷操作"><Settings2 size={18} aria-hidden="true" /></button>
      </nav> : null}
      <CompanionGoalBubble anchorRef={hudRef} motionMode={motionMode} blocked={floatingBlocked || settingsOpen || chat.mode === "history"}
        open={goalBubbleOpen} selectedId={selectedGoalId} goals={goals} onSelect={setSelectedGoalId}
        onOpen={() => { interaction.closeVoice(); setSettingsOpen(false); chat.setMode("closed"); setGoalBubbleOpen(true); }}
        onClose={() => setGoalBubbleOpen(false)} onDetails={runId => { setGoalBubbleOpen(false); setGoalHistoryTarget({ runId, visit: Date.now() }); chat.setMode("history"); }}
        onChat={() => { setGoalBubbleOpen(false); interaction.closeVoice(); setSettingsOpen(false); chat.setMode("conversation"); }} />
      {settingsOpen ? createPortal(
        <CompanionEdgeSettings
          anchorRef={hudRef}
          settings={settings}
          motionMode={motionMode}
          onClose={() => {
            setSettingsOpen(false);
            window.requestAnimationFrame(() => moreControlRef.current?.focus({ preventScroll: true }));
          }}
        />,
        document.body,
      ) : null}
      <div className="companion-hud__sr-status" role="status">{turnSummary}</div>
      <div className="companion-hud__sr-status" role="status">{proposalNotice}</div>
      <CompanionHistoryDrawer
        goals={goals}
        goalTarget={goalHistoryTarget}
        open={chat.mode === "history"}
        motionMode={motionMode}
        voice={voice}
        voiceEnabled={voiceEnabled}
        input={input}
        onInputChange={setInput}
        onSend={() => sendText()}
        onVoiceToggle={toggleVoice}
        anchorRef={hudRef}
        side={side}
        onBack={() => {
          chat.setMode("conversation");
          window.requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true }));
        }}
        onClose={() => {
          chat.setMode("closed");
          window.requestAnimationFrame(() => moreControlRef.current?.focus({ preventScroll: true }));
        }}
      />
    </div>
  );
}

/** A nonmodal paper beside the model, with internal scrolling and focus return. */
function CompanionEdgeSettings({ settings, motionMode, anchorRef, onClose }: {
  readonly settings: CompanionHudSettings;
  readonly motionMode: "full" | "lite" | "off";
  readonly anchorRef: RefObject<HTMLDivElement | null>;
  readonly onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const side = useCompanionPaperPlacement(anchorRef, panelRef, true, "left", 340);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    // capture：面板外的交互先于页面自身 handler 收到这次 pointerdown，避免
    // 「点外部打开另一个浮层」时两层同时对同一次点击反应。
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (panelRef.current && target instanceof Node && !panelRef.current.contains(target)) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [onClose]);
  return (
    <aside ref={panelRef} className="companion-hud__edge-panel" data-companion-owned="true" data-side={side} data-motion={motionMode} role="dialog" aria-label="伴星设置">
      <header>
        <strong>此页陪伴</strong>
        <button ref={closeRef} type="button" onClick={onClose} aria-label="关闭伴星设置"><X size={16} /></button>
      </header>
      <div className="companion-hud__edge-body">
        <CompanionQuickSettings
          settings={settings}
          onOpenCenter={() => { const room = useRoomStore.getState(); room.setCompanionCenterTarget({ tab: "overview" }); room.invoke("open-companion-center"); onClose(); }}
          onOpenVoiceSettings={() => {
            // 与伴星引导去签署 AI 同意走同一条通道（`companion-chat-session.tsx` 的
            // guideToConsent）：设分区 → 开设置页。面板自己关掉，不留在设置页上面。
            const room = useRoomStore.getState();
            room.setSettingsSection("companion");
            room.invoke("open-settings");
            onClose();
          }}
        />
      </div>
    </aside>
  );
}

function CompanionQuickSettings({ settings, onOpenVoiceSettings, onOpenCenter }: {
  readonly settings: CompanionHudSettings;
  readonly onOpenVoiceSettings: () => void;
  readonly onOpenCenter: () => void;
}) {
  const scaleSpan = Math.max(0.0001, settings.scaleMax - settings.scaleMin);
  const fillPercent = Math.min(100, Math.max(0, Math.round(((settings.scale - settings.scaleMin) / scaleSpan) * 100)));
  return <div className="companion-hud__settings">
    <section className="companion-hud__setting-group"><h4 className="companion-hud__setting-title">此刻怎么陪着你</h4>
      <label className="companion-hud__scale"><span>大小 <output>{Math.round(settings.scale * 100)}%</output></span><input type="range" min={settings.scaleMin} max={settings.scaleMax} step="0.01" value={settings.scale} style={{ "--fill": `${fillPercent}%` } as CSSProperties} aria-label="快捷调整伴星大小" onChange={event => settings.onScale(Number(event.currentTarget.value))} /></label>
      <div className="companion-hud__setting-buttons">
        <button type="button" aria-pressed={settings.pageMuted} data-quiet={settings.pageMuted || undefined} onClick={settings.onTogglePageMuted}>{settings.pageMuted ? "恢复本页提示" : "在此页保持安静"}</button>
        {settings.taskActive ? <button type="button" aria-pressed={settings.focusUntilTaskEnd} onClick={settings.onToggleFocus}>{settings.focusUntilTaskEnd ? "结束专注静音" : "专注到任务结束"}</button> : null}
        <button type="button" onClick={settings.onResetPosition}><RotateCcw size={13} />重置位置</button>
        <button type="button" onClick={settings.onHide}>暂时隐藏伴星</button>
      </div>
    </section>
    <section className="companion-hud__setting-group"><h4 className="companion-hud__setting-title">继续了解</h4>
      <div className="companion-hud__setting-buttons"><button type="button" onClick={onOpenCenter}>伴星中心</button><button type="button" onClick={onOpenVoiceSettings}>全部伴星设置</button></div>
      <p className="companion-hud__permission-note">对话与人格在伴星中心，打扰规则、声音与数据在设置。</p>
    </section>
  </div>;
}
