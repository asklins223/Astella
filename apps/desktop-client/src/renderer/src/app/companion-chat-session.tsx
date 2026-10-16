import { stopCompanionSpeech } from "./companion-voice-playback";
import { queueCompanionVoiceSegment } from "./companion-voice-segment-queue";
import type { CompanionHistoryItemV1 } from "@astella/shared/companion-memory-desktop-contracts";
import type { CompanionInitiativeDeliveryRefV1 } from "@astella/shared/companion-initiative-contracts";
import { prepareCompanionNotePaper, beginNoteAiWork, endNoteAiWork, resetNoteAiWork, noteEditRequestRanges } from "../components/companion/note-companion-editing";
import { journalProposalNeedsDecision } from "../components/companion/companion-journal-model";
import { companionEditedNoteV1Schema } from "@astella/shared/companion-note-authoring-contracts";
import { useCompanionPolls } from "./companion-chat-session-polls";
import { scheduleCompanionPoll } from "./companion-poll";
import {
  appendCompanionThinking,
  companionThinkingPending,
  companionThinkingText,
  revealCompanionThinking,
  type CompanionThinkingView,
} from "./companion-thinking-tail";
import { useCompanionPageContext } from "./companion-chat-session-page";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  CharacterCuePayloadV1,
  CompanionContentBlockV1,
  CompanionMessageV1,
  CompanionPageContextV1,
} from "@astella/shared/companion-conversation-contracts";
import type {
  CompanionAgentRouteEventV1,
  CompanionChatConversationV1,
  CompanionChatProposalGetResultV1,
} from "@astella/shared/companion-chat-desktop-contracts";
import type { DesktopRouteV1 } from "@astella/shared/desktop-ipc-contracts";
import type { MainPageContextInputV2, PageReadableV1 } from "@astella/shared/companion-bridge-contracts";
import { companionPageRouteV2, SETTINGS_SECTION_IDS_V2 } from "@astella/shared/companion-bridge-contracts";
import { useRoomStore } from "./room-store";
import { guideToAiSettings } from "./ai-action-gate";
import type { HudPageId } from "../components/hud/hud-pages";
import { createRequestMeta, gatewayErrorMessage, requireWorkspaceEpoch, unwrapGatewayResult, RendererGatewayError } from "./desktop-client";
import {
  COMPANION_CONSENT_REQUIRED_LINE,
  COMPANION_EXTERNAL_DISABLED_LINE,
  COMPANION_RUN_ERROR_AI_DATA_POLICY_DENIED,
  companionConsentGate,
  isCompanionConsentFailure,
} from "./companion-consent-gate";
import {
  subscribeCompanionFeed,
  normalizeFeedText,
  type CompanionFeedDiaryAnchor,
} from "../components/companion/companion-feed";
import type { CompanionFeedNoteAnchor, CompanionNoteIntent } from "../components/companion/companion-feed";
import { COMPANION_CONVERSATION_INVALIDATED, publishCompanionHistoryChanged } from "../components/companion/companion-events";
import { beginNoteExplanation, completeNoteExplanation, readNoteExplanation, interruptNoteExplanation, progressNoteExplanation, reportNoteExplanationStopFailure, resetNoteExplanations, useNoteCompanionExplanations } from "../components/companion/note-companion-explanation";
import {
  appendCompanionAgentNode,
  buildCompanionRunTraces,
  recordCompanionRunEvent,
  reconcileCompanionAgentNodes,
  type CompanionAgentNodes,
  type CompanionRunTrace,
} from "./companion-agent-nodes";

/**
 * 伴星会话（2026-09-18）。
 *
 * 气泡层与历史抽屉共用同一条对话：轻量气泡负责"现在这一句"，抽屉负责"之前说过
 * 什么"。所以会话状态必须只有一个来源——这个 Provider 就是它，抽屉退化成它的
 * 一个视图。发送后仍然靠轮询 messages 认领回复（SSE 事件流是后续正规化路径），
 * 但回复一到手就同时交给两条通道：消息列表（抽屉）与 liveReply（气泡）。
 */

/** SSE delivers immediately; serial fallback reads back off while the run is quiet. */
const REPLY_BACKSTOP_POLL_INTERVAL_MS = 3_000;
/**
 * 订阅建立后多久没收到本轮任何帧就认为"流沉默"，把话事权交给已经在跑的兜底轮询。
 *
 * 收到 `assistant.status` 就算流是活的（它总在 provider 调用之前写下），
 * 所以这个窗口只覆盖"订阅建立了但一帧都没来"的故障。
 *
 * 2026-09-19 ② 起它**只提速、不退订**：退订之后晚到的 `error` 帧再也送不到，
 * 失败就被伪装成"等满 120s 然后超时"，真实原因（格式判死、预算耗尽）全部丢失。
 */
const REPLY_STREAM_IDLE_MS = 10_000;
/** Check terminal state every third empty history read; idle reads settle at five seconds. */
const REPLY_RUN_STATUS_EVERY_N_TICKS = 3;
/** 停止后的统一说明（气泡与历史共用同一句，避免两处口径不一致）。 */
const COMPANION_STOPPED_LINE = "这一轮已停止。";
/**
 * "活动 run"的判据，与服务端 `turn-service.ts` 的集合保持一致：只有这些状态才会让
 * 新的一轮被 409 挡回来，也只有它们值得客户端去取 generation 做接替。
 */
const COMPANION_ACTIVE_RUN_STATUSES: readonly string[] = [
  "accepted",
  "running",
  "waiting_for_confirmation",
  "cancel_requested",
];

export type CompanionChatPhase = "idle" | "loading" | "ready" | "sending" | "error";
export type CompanionUiMode = "closed" | "conversation" | "actions" | "history";

/** 刚刚拿到、还没被气泡消费掉的助手回复。 */
export interface CompanionChatLiveReply {
  readonly messageId: string;
  readonly text: string;
  readonly hasActionBlocks: boolean;
  readonly webCitations?: readonly CompanionContentBlockV1[];
  readonly proposalIds: readonly string[];
}

export interface CompanionChatRichReply {
  readonly messageId: string;
  readonly blocks: readonly CompanionContentBlockV1[];
}

/**
 * 认领一轮回复的等待结果（SSE 与兜底轮询共用，2026-09-19 ②）。
 *
 * 与旧形状（`CompanionMessageV1 | null`）的差别：`null` 把"失败"和"超时"压成了
 * 同一件事——调用方既分不出来、也拿不到原因，于是 run 终态失败时兜底赛道只能
 * 干等到 `REPLY_POLL_TIMEOUT_MS`。分开之后，轮询一旦读到 run 已 failed/cancelled
 * 就能立刻收尾（见 `readRunTerminal`）。
 */
export type CompanionReplyWaitOutcome =
  | { kind: "reply"; message: CompanionMessageV1 }
  | { kind: "silent" }
  | { kind: "failed"; code: string | null; message: string }
  | { kind: "cancelled"; text?: string }
  | { kind: "timeout" };

/**
 * 正在流式生成中的回复草稿（SSE `assistant.delta` 累积）。
 *
 * 气泡与语音都按"渐进内容"处理：文本随生成逐字出现，语音在第一批完整句
 * 落地时就开始念，不必等整条回复生成完。
 */
export interface CompanionChatDraft {
  readonly runId: string;
  readonly text: string;
}

/**
 * 一轮被中断（失败 / 等不到终态）时"她其实已经说出来的那半句"（2026-09-19）。
 *
 * 为什么单独留一份：失败收尾会把草稿清掉（否则抽屉里永远挂着"正在说…"），
 * 而清掉的瞬间用户正看着的那句话就没了——这正是"内容没了"那类反馈的来源。
 * 留档后气泡可以继续显示它，服务端侧也有一条 `kind='error'` 的留档（见 worker）。
 */
export interface CompanionChatInterrupted {
  readonly text: string;
  readonly message: string;
}

export interface CompanionChatSendInput {
  readonly text: string;
  /** 这一轮是否允许自动朗读，并据此启用服务端语音预热。 */
  readonly voiceOutput?: boolean;
  readonly voiceArtifactId?: string | null;
  readonly noteAnchor?: CompanionFeedNoteAnchor;
  /**
   * 划选/拖拽投喂（2026-09-18）：用户在页面选中/拖入的原文，随 turn 走
   * `selection`（sharing=user_selected），worker 以 <selection_data> 注入 prompt。
   */
  readonly selection?: { readonly text: string } | null;
  /**
   * 用户这一轮自己传的图（2026-10-06 输入框传图）：上传回执给的站内地址，
   * 作为第二个内容块随 turn 上抛；服务端按 url 解析成资产并写回权威 assetId。
   */
  readonly image?: { readonly url: string; readonly label: string } | null;
}

export type CompanionProposalUiState =
  | { readonly phase: "loading" }
  | { readonly phase: "error"; readonly message: string }
  | {
      readonly phase: "ready";
      readonly proposal: CompanionChatProposalGetResultV1["proposal"];
      readonly deciding?: "confirm" | "reject";
      readonly error?: string;
    };

export interface CompanionNavChip {
  readonly id: string;
  readonly summary: string;
  /** null = 该 V2 路由在桌面端没有等价形态（today/card/conversation/settings）。 */
  readonly route: DesktopRouteV1 | null;
  /**
   * 用户预授权（permissionLevel=full）下的读类路由：应**立即执行**跳转，
   * 不再等「前往」。授权判定在服务端，客户端只服从这个标志（2026-09-19）。
   */
  readonly autoExecute?: boolean;
}

export interface CompanionChatSession {
  /**
   * 认领一次主动开口（投递里的 runId）。
   *
   * 返回**这句话有没有真的落到气泡上**：`true` = 屏幕上已经有了，`false` = 没能接住。
   * 展示回执只许在 `true` 之后发——无条件发等于把"她说了、没人看见"记成"已展示"，
   * 而投影只认 `queued`/`delivered`，那一条就再也不会被交给任何设备。
   */
  readonly receiveInitiative?: (delivery: CompanionInitiativeDeliveryRefV1) => Promise<boolean>;
  readonly phase: CompanionChatPhase;
  readonly failure: string | null;
  readonly conversationId: string | null;
  readonly messages: readonly CompanionMessageV1[];
  readonly liveReply: CompanionChatLiveReply | null;
  /** 本轮交付与查阅材料，和回复共用一处展示；完整内容留在手记。 */
  readonly richReply: CompanionChatRichReply | null;
  /**
   * 已经**替用户跳过**的落点（`JSON.stringify(DesktopRouteV1)`）。
   *
   * 预授权那一档下，同一个落点会同时以两种形态出现：nav chip 立刻执行跳转，
   * 回合结束时消息里的 nav 块又递来一张「可以接着看这里」。页都已经到了，
   * 再让用户按一次「前往」就是把自动执行说成没执行——纸签侧按这份名单不再出示。
   * 只记成功的：跳失败的落点还要靠那张纸签留一条能重试的路。
   */
  readonly autoNavigatedRoutes: ReadonlySet<string>;
  /** 流式生成中的草稿（未生成完的回复）；liveReply 落地后清空。 */
  readonly draft: CompanionChatDraft | null;
  /**
   * 她这一轮正在想什么（`assistant.thinking` 的尾部，2026-10-13）。
   *
   * 空串 = 这一刻没有思考在流（闲聊轮关了思考、或本轮根本没开思考档）。
   * 它**不是**回复的一部分：不进正文、不进朗读，完成后单独保存在 run 历史里；
   * 当前气泡只显示这一轮流式到达的尾部。
   */
  readonly thinking: string;
  /**
   * 挡住这次发送的那条还在跑的 run（2026-10-13）。
   *
   * null = 认不出是哪条（读不到、或根本没有），那时只能等服务端把孤儿 run 回收掉；
   * 认出得出来，界面上就有「停掉上一条」这颗真能按的按钮。
   */
  readonly blockedByRun: { runId: string; generation: number } | null;
  /** 停掉 `blockedByRun` 那条（服务端原子置 cancelled），之后这句可以再发一次。 */
  stopBlockedTurn(): Promise<void>;
  /**
   * 这一轮被打断时她已经说出来的部分（失败/超时）。气泡据此保留那半句，
   * 而不是让它在收尾的瞬间消失。下一次发送或新的回复会清掉它。
   */
  readonly interrupted: CompanionChatInterrupted | null;
  /**
   * 本轮"她在做什么"的节点序列（2026-09-19）。
   *
   * 来源是**服务端早就在发、桌面端此前整批丢弃**的 `assistant.status` /
   * `agent.tool` 帧（收敛逻辑见 `companion-agent-nodes.ts`）。发新消息时清空，所以它始终
   * 描述"当前这一轮"。本轮只读快照可补回漏接的工具回执；消息文字和工具过程分别展示，历史留痕读只读端点。
   */
  readonly nodes: CompanionAgentNodes;
  /** 与本轮实时节点绑定的身份，结束后保留到下一轮，避免取到旧轮统计。 */
  readonly processRunId: string | null;
  /**
   * 各轮 run 的过程留痕（新 → 旧），来自只读端点 `listRunNodes`（2026-09-19）。
   *
   * 与 `nodes` 的分工：`nodes` 是**本轮实时**的节点（SSE），`runTraces` 是**历史**留痕
   * 与真实步数摘要（`companion_turn_runs` 的 `stepCount` / `toolCallCount`——`assistant.status`
   * 一轮只发一次，客户端凭事件数不出步数，所以进度只能取这里）。抽屉按 runId
   * 把过程放在本轮正文之前；工具气泡的统计按 processRunId 精确匹配当前轮次。
   */
  readonly runTraces: readonly CompanionRunTrace[];
  /** 用户刚从业务页面划选或拖入的原文；由会话层持有，面板尚未挂载时也不会丢。 */
  readonly feedSelection: string | null;
  /** 业务页面给出的起始问题；通过 autoSendRequestId 区分草稿与用户明确触发的动作。 */
  readonly feedPrompt: string | null;
  /** 与当前提问一同带入的原文位置；回复可由用户贴回此处。 */
  readonly feedNoteAnchor: CompanionFeedNoteAnchor | null;
  /**
   * 与当前提问一同带入的日记引用（40 §6「聊聊这篇」）。
   *
   * 面板据此显示「正在聊 2026-10-01 第 2 版那篇」，用户随时能看见自己谈的是哪一篇。
   * 它**不会**自动发送——用户自己接着打字才算一次提问（§6）。
   */
  readonly feedDiaryAnchor: CompanionFeedDiaryAnchor | null;
  /** A note-level companion action started from the notebook page. */
  readonly feedNoteIntent: CompanionNoteIntent | null;
  /** A one-shot identity for a direct action; generic chat drafts do not auto-send. */
  readonly autoSendRequestId: string | null;
  readonly navChips: readonly CompanionNavChip[];
  readonly proposalStates: Readonly<Record<string, CompanionProposalUiState>>;
  /** 还等着用户点头的提案数；手记入口的角标读它（见 pendingProposalCount 注释）。 */
  readonly pendingProposalCount: number;
  readonly mode: CompanionUiMode;
  /**
   * 她对自己的称呼：来自账号级人格档案（`companion_persona_profiles.profile.name`），取不到是"伴星"。
   * 由 `CompanionPresence` 读到后推给这里，气泡、抽屉、轨道与记录署名共用这一份。
   */
  readonly companionName: string;
  setCompanionName(name: string): void;
  /** 向前还有更老的历史页（微信式上滑加载）。 */
  readonly historyHasMore: boolean;
  /** 正在向前翻页。 */
  readonly historyLoadingOlder: boolean;
  /** 翻页失败时保留当前记录并提供就地重试。 */
  readonly historyOlderError: string | null;
  /** 最近窗口或工作空间变化后，搜索池必须重新读取。 */
  readonly historyRevision: number;
  /** 向前翻一页（每页 20 条）；由历史抽屉的上滑触发。 */
  loadOlderMessages(): Promise<void>;
  /**
   * 全量拉取会话消息（搜索/日期筛选的数据底座，带会话级缓存）。
   * 只有读到会话开头才返回完整结果；失败或未就绪返回 null，调用方不得缓存 null。
   */
  fetchAllMessages(): Promise<readonly CompanionMessageV1[] | null>;
  /**
   * 最近一条助手消息的语气情绪（2026-09-18 情绪接表情）。抽屉不再自己算——
   * 消息已经住在这里，情绪也就跟着上来，气泡层与表情共用同一个来源。
   */
  /** 当前实时语义 cue；历史消息不会在重载后重新驱动角色表情。 */
  readonly assistantCue: (CharacterCuePayloadV1 & { readonly seq: number }) | null;
  /**
   * 发一轮对话；返回 false 表示这次没有发出去（输入为空、被更新的发送取代，
   * 或缺少 AI 同意被门禁拦下——内容留在输入框，签署后可以原样再发）。
   */
  send(input: CompanionChatSendInput): Promise<boolean>;
  /**
   * 停止本轮（2026-09-19）。调用方负责**先静音**（语音归气泡层持有）——这里只做
   * 服务端取消 + 状态收尾。已输出的部分由 worker 在取消 fence 处留档为
   * `kind='cancelled'` 的消息，因此返回前会重取一次消息列表。
   */
  cancel(): Promise<boolean>;
  /** 正在等取消回执（按钮显示"正在停止…"）。 */
  readonly cancelling: boolean;
  /** 停止后的就地说明；有限时长后由 UI 调 dismissStopNotice 收掉。 */
  readonly stopNotice: string | null;
  dismissStopNotice(): void;
  /** 气泡消费完这条回复（念完并消失）后调用。 */
  dismissLiveReply(): void;
  dismissRichReply(): void;
  dismissFeedSelection(): void;
  dismissFeedNoteAnchor(): void;
  dismissFeedNoteIntent(): void;
  setMode(mode: CompanionUiMode): void;
  dismissNavChip(id: string): void;
  decideProposal(proposalId: string, decision: "confirm" | "reject"): Promise<void>;
  /** 快照读不成时重试一次：与首次读取同一条路径，不另造第二份真话。 */
  retryProposal(proposalId: string): void;
  goToRoute(route: DesktopRouteV1): Promise<void>;
}

/**
 * V2 路由 → 桌面路由的诚实映射：没有等价形态的 kind 返回 null，不伪造。
 *
 * 页面类落点一律查 `COMPANION_PAGE_DESTINATIONS_V2`（服务端能发什么，这里就落什么）；
 * 只有需要实体 id 的路由才在 switch 里各写一条。曾经 `today`/`settings` 在这里没有分支，
 * 于是服务端一句"已定位到今日页面"、她一句"到了"，而客户端那颗按钮根本不会渲染出来。
 */


/**
 * 把已授权的落点真正落到渲染层视图上（2026-09-19 用户实测修复）。
 *
 * 主进程 `navigation.go` 只推进**主进程侧的历史栈**（返回/恢复用），页面切换的
 * 唯一开关是 room-store 的 `invoke`——既有做法见 TaskSurface 的
 * `navigateThroughMainResolver`：resolve/go 之后由渲染层自己换页。缺了这一步，
 * 「前往」就是一次空转：两条 IPC 都成功、无报错、页面纹丝不动。
 *
 * agent 路由能映射出的每种 DesktopRoute 都必须有落点；没有等价视图时返回
 * false，调用方如实报"跳不了"，不假装跳过了。
 */

/** 同一落点 + 同一文案 = 同一条提示（用于新 chip 让位旧 chip，防止同款堆叠）。 */

/**
 * 已经落进消息里的落点，chip 行就不要再显示一遍（方案 29 §4.8）。
 *
 * chip 行原本是 route 的唯一出口，而它游离在正文之外、不进历史顺序、事件还有 TTL。
 * nav 块进消息之后，两边同时显示就成了"同一句话下面两个一样的按钮"。
 * 这里只**过滤呈现**，不动 `navChips` 状态——`autoExecute` 的即时跳转靠状态驱动，
 * 把它一起删了会连带砍掉"预授权就直接跳"这条行为。
 * 留在 chip 行上的于是只有两类：正在跑的这一轮（消息还没落库）、
 * 以及确认动作直接给出的落点（不经过工具，消息里自然也没有）。
 */

/** 搜索只能使用完整历史；网络失败或游标不前进都不能把部分数据报成“没有找到”。 */

/**
 * 这条 409 是不是"会话里已经有活动 run"（而不是别的冲突）。
 *
 * 网关把所有 409 都归到 `conflict` 这一档，而 turn 提交在这个形状下只可能是
 * `RUN_ALREADY_ACTIVE` / `STALE_GENERATION`（幂等冲突用的是新键，撞不上）。
 */

/**
 * 聊天语境下的失败文案。网关的通用文案是给学习流程写的——"这条学习状态已经发生变化"
 * 放在对话里读起来像另一个产品出了事，用户根本不知道"再发一次"能不能行。
 */

/** SSE 认领回合的结果（`failed` 带错误码，用于区分"缺同意"这类可引导的失败）。 */
type CompanionReplyStreamOutcome =
  | { kind: "final" }
  | { kind: "unavailable" }
  | { kind: "failed"; code: string | null; message: string }
  /** 用户按了停止（`turn.cancelled` reason='user'）。**不是失败**，不提示重试。 */
  | { kind: "cancelled" }
  | { kind: "timeout" };

// 纯函数（路由落点 / 文案 / nav chip 可见性 / 两个错误映射）在 `companion-chat-routing.ts`——
// 它们一个 hook 都没有，留在 Provider 文件里只是当初图省事。
// 本文件内部也要调其中几个，所以是「导入 + 再导出」。
import { desktopRouteFromAgentRoute, companionMessageText, applyRouteToRoom, navChipSharesTarget, navChipsStillOutsideMessages, readCompleteCompanionHistory, isCompanionRunConflict, companionTurnErrorMessage, companionReplyFailureMessage } from "./companion-chat-routing";
export { desktopRouteFromAgentRoute, companionMessageText, applyRouteToRoom, navChipSharesTarget, navChipsStillOutsideMessages, readCompleteCompanionHistory, isCompanionRunConflict, companionTurnErrorMessage } from "./companion-chat-routing";

const CompanionChatContext = createContext<CompanionChatSession | null>(null);

// 页面上下文由 `companion-chat-session-page.ts` 消费（它才是 `bridgePageContext` 的用武之地）。
export { bridgePageContext } from "./companion-chat-session-bridge";
export function useCompanionChat(): CompanionChatSession {
  const value = useContext(CompanionChatContext);
  if (!value) throw new Error("useCompanionChat must be used inside CompanionChatProvider");
  return value;
}

export function useOptionalCompanionChat(): CompanionChatSession | null {
  return useContext(CompanionChatContext);
}

export function CompanionChatProvider({ children }: { readonly children: ReactNode }) {
  // 「他在哪一页、看着哪一条」——九条 store 订阅 + 页面实例 id + bridge 上下文，
  // 收在 `useCompanionPageContext` 里：那不是聊天的职责，是「谁陪着他站在这一页」。
  const {
    hudPage, activeRunId, activeNoteId, activeNoteVersionId, activeSourceId,
    activeReviewScheduleId, settingsSection, pageReadableView, workspaceScopeRevision,
    pageInstanceIdRef, brokerPageContext,
  } = useCompanionPageContext();
  const [feedNoteIntent, setFeedNoteIntent] = useState<CompanionNoteIntent | null>(null);
  /**
   * 日记引用（40 §6「聊聊这篇」）。
   *
   * 它**不会**触发自动发送：自动发送的条件是 `noteAnchor && initialPrompt`，
   * 而这里两个都没有。§6 明确要求「点击只打开对话并附上该篇的明确引用，
   * **不自动发送用户消息**」——用户自己接着说，才算一次真正的提问。
   */
  const [feedDiaryAnchor, setFeedDiaryAnchor] = useState<CompanionFeedDiaryAnchor | null>(null);
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void requireWorkspaceEpoch().then((epoch) => {
        if (cancelled) return;
        return window.astella.companion.bridge.setContext({
          meta: createRequestMeta(epoch),
          page: brokerPageContext,
        });
      }).catch(() => undefined);
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [brokerPageContext, workspaceScopeRevision]);
  useEffect(() => () => {
    void requireWorkspaceEpoch().then((epoch) => window.astella.companion.bridge.clearContext({
      meta: createRequestMeta(epoch),
    })).catch(() => undefined);
  }, []);
  /**
   * 当前页面上下文：让"她根据页面情况回复"成立。契约没有对应 pageKind 的页面
   * （设置等）传 null，不发 context。
   */
  const pageContext = useMemo<CompanionPageContextV1 | null>(() => {
    if (hudPage === "today") return { pageKind: "today", sharing: "page_registered" };
    if (hudPage === "queue") return { pageKind: "review", sharing: "page_registered" };
    if (hudPage === "graph") return { pageKind: "star_map", sharing: "page_registered" };
    if (feedNoteIntent) {
      return {
        pageKind: "note",
        sharing: "page_registered",
        noteId: feedNoteIntent.noteId,
        noteVersionId: feedNoteIntent.noteVersionId,
      };
    }
    if ((hudPage === "note-read" || hudPage === "note-edit") && activeNoteId) {
      return { pageKind: "note", sharing: "page_registered", noteId: activeNoteId, ...(activeNoteVersionId ? { noteVersionId: activeNoteVersionId } : {}) };
    }
    return null;
  }, [activeNoteId, activeNoteVersionId, feedNoteIntent, hudPage]);

  const resolveTurnContext = useCallback(async (epoch: number): Promise<CompanionPageContextV1 | null> => {
    if (hudPage !== "assessment" || !activeRunId) return pageContext;
    const context = unwrapGatewayResult(await window.astella.companion.learningRun.getContext({
      meta: createRequestMeta(epoch),
      runId: activeRunId,
    }));
    const grant = unwrapGatewayResult(await window.astella.companion.learningRun.createContextGrant({
      meta: createRequestMeta(epoch),
      runId: activeRunId,
      request: {
        version: 1,
        pageInstanceId: pageInstanceIdRef.current,
        taskId: context.taskId,
        contextRevision: context.contextRevision,
      },
    }));
    return {
      ...context,
      requestedCapability: "grounded_tutor",
      groundedTutorGrant: grant,
    };
  }, [activeRunId, feedNoteIntent, hudPage, pageContext]);
  const [phase, setPhase] = useState<CompanionChatPhase>("idle");
  const [failure, setFailure] = useState<string | null>(null);
  const [conversation, setConversation] = useState<CompanionChatConversationV1 | null>(null);
  const [messages, setMessages] = useState<CompanionMessageV1[]>([]);
  // ── 历史分页（2026-09-19 微信式历史抽屉） ────────────────────────────────
  // `messages` 仍只装"最近窗口"（refreshMessages 的结果）；更老的页挂在
  // `olderMessages`（游标 beforeSeq 向前翻，每页 20 条），展示时合并。
  // 合并去重按 id：optimistic 用户消息与 refresh 重取可能短暂同现。
  const [olderMessages, setOlderMessages] = useState<CompanionMessageV1[]>([]);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoadingOlder, setHistoryLoadingOlder] = useState(false);
  const [historyOlderError, setHistoryOlderError] = useState<string | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const historyRevisionRef = useRef(0);
  const historyOldestSeqRef = useRef<number | null>(null);
  /** 最近窗口的下界；全量搜索从这里翻，不受时间线上已翻到哪一页影响。 */
  const historyRecentOldestSeqRef = useRef<number | null>(null);
  const historyBaselineReadyRef = useRef(false);
  const recentMessagesRef = useRef<CompanionMessageV1[]>([]);
  const historyLoadingRef = useRef(false);
  const historyLoadTokenRef = useRef(0);
  const historyAllRef = useRef<{ scopeRevision: number; revision: number; items: CompanionMessageV1[] } | null>(null);
  const manuallyNavigatedKindsRef = useRef<Set<string>>(new Set());
  const autoExecutedRef = useRef<Set<string>>(new Set());
  const [autoNavigatedRoutes, setAutoNavigatedRoutes] = useState<ReadonlySet<string>>(() => new Set());
  const [liveReply, setLiveReply] = useState<CompanionChatLiveReply | null>(null);
  const liveReplyMessageIdRef = useRef<string | null>(null);
  const setCurrentLiveReply = useCallback((reply: CompanionChatLiveReply | null): void => {
    liveReplyMessageIdRef.current = reply?.messageId ?? null;
    setLiveReply(reply);
  }, []);
  const [richReply, setRichReply] = useState<CompanionChatRichReply | null>(null);
  const [draft, setDraft] = useState<CompanionChatDraft | null>(null);
  const [interrupted, setInterrupted] = useState<CompanionChatInterrupted | null>(null);
  /** 本轮节点轨道（见 CompanionChatSession.nodes 的说明）。 */
  const [nodes, setNodes] = useState<CompanionAgentNodes>([]);
  const [processRunId, setProcessRunId] = useState<string | null>(null);
  /** 历史过程留痕（见 CompanionChatSession.runTraces 的说明）。 */
  const [runTraces, setRunTraces] = useState<readonly CompanionRunTrace[]>([]);
  /**
   * 过程留痕的重取信号。停留态里轮询照跑，但"刚结束一轮"这种时刻必须立刻重取一次：
   * 取消时 worker 写的那条 `kind='cancelled'` 消息与 run 摘要都在事件之后才落库。
   */
  const [tracesRevision, setTracesRevision] = useState(0);
  /** 流式累积文本（appendFrom 断点续拼用；state 只负责触发渲染）。 */
  const draftRef = useRef("");
  const utteranceTextRef = useRef(new Map<string, string>());
  const utteranceIdsRef = useRef(new Map<string, Set<string>>());
  /** 思考尾部窗口（见 `companion-thinking-tail.ts`）；null = 这一轮还没有思考可看。 */
  const [thinkingView, setThinkingView] = useState<CompanionThinkingView | null>(null);
  const [feedSelection, setFeedSelection] = useState<string | null>(null);
  const [feedPrompt, setFeedPrompt] = useState<string | null>(null);
  const [feedNoteAnchor, setFeedNoteAnchor] = useState<CompanionFeedNoteAnchor | null>(null);
  useEffect(() => useNoteCompanionExplanations.subscribe(state => {
    // Saving can succeed later through the quote's retry button, after send() has returned.
    setFeedNoteAnchor(current => current?.explanationId
      && state.items.some(item => item.id === current.explanationId && item.phase === "saved") ? null : current);
  }), []);
  const [autoSendRequestId, setAutoSendRequestId] = useState<string | null>(null);
  const [proposalStates, setProposalStates] = useState<Record<string, CompanionProposalUiState>>({});
  const [navChips, setNavChips] = useState<CompanionNavChip[]>([]);
  const [streamCue, setStreamCue] = useState<(CharacterCuePayloadV1 & { readonly seq: number }) | null>(null);

  /**
   * 追加导航 chip（SSE 实时流、抽屉轮询与提案确认共用，2026-09-19）。
   *
   * 除按 id 去重外，同一落点 + 同一文案的旧 chip 让位给最新一条：模型连着几轮都
   * 调 companion_open_review 时，抽屉底部会堆出一列同款「已定位到复习页面」按钮
   * （用户实测截图 3 条同款）。留最新的，关掉它这组提示就一起清掉。
   */
  const pushNavChips = useCallback((incoming: readonly CompanionNavChip[]) => {
    setNavChips((current) => {
      const seen = new Set(current.map((chip) => chip.id));
      const additions: CompanionNavChip[] = [];
      for (const chip of incoming) {
        if (seen.has(chip.id)) continue;
        seen.add(chip.id);
        additions.push(chip);
      }
      if (additions.length === 0) return current;
      const superseded = new Set(
        current
          .filter((chip) => !chip.autoExecute
            && additions.some((next) => navChipSharesTarget(chip, next)))
          .map((chip) => chip.id),
      );
      if (superseded.size === 0) return [...current, ...additions];
      return [...current.filter((chip) => !superseded.has(chip.id)), ...additions];
    });
  }, []);

  const [mode, setMode] = useState<CompanionUiMode>("closed");
  /** 会话身份作废时递增：已经开着的手记要重新读一次，而不是等用户重新进出这一页。 */
  const [conversationReloadKey, setConversationReloadKey] = useState(0);
  const [companionName, setCompanionName] = useState("伴星");
  const [cancelling, setCancelling] = useState(false);
  const [stopNotice, setStopNotice] = useState<string | null>(null);
  /**
   * 挡住这次发送的那条还在跑的 run（2026-10-13）。
   *
   * 为什么要留着它：worker 崩溃或被队列落下时，那条 run 会一直占着会话，
   * 之后每一句都被服务端 409 拒回。提示语写的是"或者先点停止"，可停止那颗按钮
   * 只在**本机自己发起过**的那轮才存在——重启过应用就没了，于是用户被留在一个
   * 指向不存在控件的死路上。认出那条 run，按钮才有地方按。
   */
  const [blockedByRun, setBlockedByRunState] = useState<{ runId: string; generation: number } | null>(null);
  /** 发送链路是异步的，收尾时要读**当下**的值决定说哪句话，不能拿渲染闭包里那份。 */
  const blockedByRunRef = useRef<{ runId: string; generation: number } | null>(null);
  const setBlockedByRun = useCallback((run: { runId: string; generation: number } | null) => {
    blockedByRunRef.current = run;
    setBlockedByRunState(run);
  }, []);
  const conversationRef = useRef<CompanionChatConversationV1 | null>(null);
  const restoredReplyIdsRef = useRef(new Set<string>());
  /** 仅保留最新一次发送的结果；新的一轮会让上一轮的轮询自行退出。 */
  const sendGenerationRef = useRef(0);
  const pendingSendRef = useRef<{ generation: number; explanationId: string | null; cancelled: boolean } | null>(null);
  const replyWaitRef = useRef<{ generation: number; cancel: () => void } | null>(null);
  const followupPromptsByMessageRef = useRef(new Map<string, string[]>());
  const followupReadyMessageIdsRef = useRef(new Set<string>());
  const lateFollowupWatchersRef = useRef(new Set<() => void>());
  /**
   * 本轮在跑的 run（`runId` + `generation`）——停止请求要带 generation 做 CAS，
   * 而这两个值只在 turn 响应里出现一次，必须留到本轮结束。
   */
  const activeTurnRef = useRef<{ runId: string; generation: number; conversationId: string; explanationId?: string | null } | null>(null);
  /**
   * "提交闸门"：本轮 turn 请求在途时它是个未决的 promise，拿到回执（或失败）后放行。
   *
   * 为什么要它：生成中允许继续打字，而新的一条必须带**精确**的 `supersedesGeneration`
   * 才能接替旧轮——那个值只在旧轮的回执里。抢在回执之前发第二条，只会拿到
   * `409 RUN_ALREADY_ACTIVE`，而那条拒绝发生在写用户消息之前，历史里连这句话都没有。
   */
  const submitGateRef = useRef<Promise<void>>(Promise.resolve());
  /** 防止连点停止打出多次请求（服务端幂等，但没必要刷请求）。 */
  const cancellingRef = useRef(false);
  /** agent route 游标：null = 尚未建立基线（首次拉取只记 latestSeq 不渲染）。 */
  const routeCursorRef = useRef<number | null>(null);

  /**
   * 丢掉这一条会话在本机的全部痕迹：会话身份、消息、分页游标、本轮回复与提案。
   *
   * `ensureConversation` 只在缓存为空时才重新 ensure，所以这一份丢弃是「服务端已经不
   * 有这条会话」之后唯一能让下一次发送重新对上收件箱的地方。
   */
  const dropConversationCache = useCallback(() => {
    ++sendGenerationRef.current;
    pendingSendRef.current = null;
    activeTurnRef.current = null;
    replyWaitRef.current?.cancel();
    replyWaitRef.current = null;
    for (const cancel of lateFollowupWatchersRef.current) cancel();
    lateFollowupWatchersRef.current.clear();
    followupPromptsByMessageRef.current.clear();
    followupReadyMessageIdsRef.current.clear();
    setProcessRunId(null);
    setNodes([]);
    setRunTraces([]);
    setThinkingView(null);
    conversationRef.current = null;
    restoredReplyIdsRef.current.clear();
    routeCursorRef.current = null;
    draftRef.current = "";
    setConversation(null);
    setMessages([]);
    recentMessagesRef.current = [];
    setOlderMessages([]);
    setHistoryHasMore(false);
    setHistoryLoadingOlder(false);
    historyLoadingRef.current = false;
    historyLoadTokenRef.current += 1;
    setHistoryOlderError(null);
    historyOldestSeqRef.current = null;
    historyRecentOldestSeqRef.current = null;
    historyBaselineReadyRef.current = false;
    historyAllRef.current = null;
    historyRevisionRef.current += 1;
    setHistoryRevision(historyRevisionRef.current);
    manuallyNavigatedKindsRef.current.clear();
    autoExecutedRef.current.clear();
    setAutoNavigatedRoutes(new Set());
    setCurrentLiveReply(null);
    setRichReply(null);
    setDraft(null);
    setInterrupted(null);
    setProposalStates({});
    setNavChips([]);
    setStreamCue(null);
    setFailure(null);
    setPhase("idle");
  }, []);

  useEffect(() => {
    dropConversationCache();
    resetNoteAiWork();
    resetNoteExplanations();
    setFeedSelection(null);
    setFeedPrompt(null);
    setFeedNoteAnchor(null);
    setAutoSendRequestId(null);
    setFeedNoteIntent(null);
    setMode("closed");
    // 称呼是空间/账号级的：换空间后不许留着上一个空间里她的名字。
    setCompanionName("伴星");
  }, [dropConversationCache, setCurrentLiveReply, workspaceScopeRevision]);

  useEffect(() => () => {
    for (const cancel of lateFollowupWatchersRef.current) cancel();
    lateFollowupWatchersRef.current.clear();
  }, []);

  // 「清空连续对话记录」在服务端删掉的就是这一条会话。留着本机这份缓存，之后每一句都会
  // 带着已经不存在的 conversationId 发出去，一路撞 `NOT_FOUND`，而手记里还摆着删掉的正文。
  useEffect(() => {
    const onInvalidate = () => {
      dropConversationCache();
      setConversationReloadKey((current) => current + 1);
    };
    window.addEventListener(COMPANION_CONVERSATION_INVALIDATED, onInvalidate);
    return () => window.removeEventListener(COMPANION_CONVERSATION_INVALIDATED, onInvalidate);
  }, [dropConversationCache]);

  // 页面划选/拖拽可能发生在伴星交互层关闭时，因此引用必须住在始终挂载的
  // 会话 Provider，而不能住在按需显示的输入气泡里。
  useEffect(() => {
    const unsubscribeFeed = subscribeCompanionFeed({
      onFeed: (selection) => {
        setFeedSelection(normalizeFeedText(selection.text));
        setFeedPrompt(selection.initialPrompt ?? null);
        setFeedNoteAnchor(selection.noteAnchor ?? null);
        setFeedDiaryAnchor(selection.diaryAnchor ?? null);
        setAutoSendRequestId(selection.noteAnchor && selection.initialPrompt ? selection.requestId ?? null : null);
        setFeedNoteIntent(null);
        setLiveReply(null);
        setRichReply(null);
      },
      onNoteIntent: (intent) => {
        setFeedSelection(null);
        setFeedNoteAnchor(null);
        setFeedNoteIntent(intent);
        setAutoSendRequestId(intent.requestId ?? null);
        setFeedPrompt(intent.kind === "overview"
          ? "先读这篇笔记，用白话说清 2–3 个重点；每个重点后引用一小句原文，方便我回去看。"
          : intent.kind === "recall"
            ? "陪我回想这篇笔记，先只问我一个问题，不要告诉我答案。"
            : intent.kind === "recall_hint"
              ? `针对“${intent.question ?? "刚才的问题"}”给我一点线索，先别揭晓答案。`
              : "从这篇笔记往外多了解一些，给我几篇可选的新笔记草稿；让我挑过再保存。");
        setLiveReply(null);
        setRichReply(null);
      },
      onOpenChat: () => setMode("conversation"),
    });
    const openConversation = () => setMode("conversation");
    window.addEventListener("astella:companion-open", openConversation);
    return () => {
      unsubscribeFeed();
      window.removeEventListener("astella:companion-open", openConversation);
    };
  }, []);

  const ensureConversation = useCallback(async (): Promise<CompanionChatConversationV1> => {
    const existing = conversationRef.current;
    if (existing) return existing;
    const scopeRevision = useRoomStore.getState().workspaceScopeRevision;
    const epoch = await requireWorkspaceEpoch();
    const ensured = unwrapGatewayResult(await window.astella.companion.chat.ensureConversation({
      meta: createRequestMeta(epoch),
      request: { version: 1 },
    }));
    if (useRoomStore.getState().workspaceScopeRevision !== scopeRevision) {
      throw new Error("工作空间已切换，请在当前空间重新读取对话。");
    }
    conversationRef.current = ensured.conversation;
    setConversation(ensured.conversation);
    return ensured.conversation;
  }, []);

  const refreshMessages = useCallback(async (conversationId: string, epoch: number) => {
    const scopeRevision = useRoomStore.getState().workspaceScopeRevision;
    const result = unwrapGatewayResult(await window.astella.companion.chat.listMessages({
      meta: createRequestMeta(epoch),
      request: { version: 1, conversationId, limit: 50 },
    }));
    if (useRoomStore.getState().workspaceScopeRevision !== scopeRevision || conversationRef.current?.id !== conversationId) {
      throw new Error("工作空间已切换，请在当前空间重新读取对话。");
    }
    const changed = !historyBaselineReadyRef.current
      || JSON.stringify(result.items) !== JSON.stringify(recentMessagesRef.current);
    if (changed) {
      setMessages(result.items);
      recentMessagesRef.current = result.items;
      historyAllRef.current = null;
      historyRevisionRef.current += 1;
      setHistoryRevision(historyRevisionRef.current);
      publishCompanionHistoryChanged();
    }
    historyBaselineReadyRef.current = true;
    historyRecentOldestSeqRef.current = result.oldestSeq;
    // 分页基线只在会话首次加载时建立一次：后续 refresh（发完一轮、停止一轮）
    // 只替换"最近窗口"，不动已翻出来的老页游标。
    if (historyOldestSeqRef.current === null) {
      historyOldestSeqRef.current = result.oldestSeq;
      setHistoryHasMore(result.hasMore);
    }
    return result.items;
  }, []);

  // 临时用户消息用 MAX_SAFE_INTEGER 放在当前轮末尾。若某条终态分支没拿到刷新结果，
  // 它不能继续冒充真实历史消息并永远钉在底部。
  useEffect(() => {
    if (phase === "sending") return;
    setMessages((current) => {
      const settled = current.filter((message) => message.seq !== Number.MAX_SAFE_INTEGER);
      return settled.length === current.length ? current : settled;
    });
  }, [phase]);

  const applyLateFollowups = useCallback((conversationId: string, epoch: number, messageId: string, prompts: string[]) => {
    const ready = followupReadyMessageIdsRef.current;
    ready.add(messageId);
    while (ready.size > 40) ready.delete(ready.values().next().value as string);
    if (prompts.length === 0) return;
    const pending = followupPromptsByMessageRef.current;
    pending.set(messageId, prompts);
    while (pending.size > 20) pending.delete(pending.keys().next().value as string);
    // 纯文本回复本来没有附页；追问迟到时要自己把这一张纸立起来，
    // 否则「她给了追问、气泡上却什么都没有」。已经在说的另一条回复不抢位。
    setRichReply((current) => {
      const followups = [...current?.blocks.filter((block) => block.type !== "follow_up_suggestions") ?? [], { type: "follow_up_suggestions" as const, prompts }];
      if (!current) return { messageId, blocks: followups };
      return current.messageId === messageId ? { ...current, blocks: followups } : current;
    });
    // The hand-note history owns the durable row. Refreshing it here makes late
    // suggestions visible there even if a newer turn has already hidden the bubble.
    void refreshMessages(conversationId, epoch).catch(() => undefined);
  }, [refreshMessages]);

  /**
   * 向前翻一页历史（每页 20 条）。读取失败保留当前位置，显示重试入口。
   * 不走 `unwrapGatewayResult`，避免补白读取失败触发门禁全量重置。
   */
  const loadOlderMessages = useCallback(async (): Promise<void> => {
    if (historyLoadingRef.current) return;
    const conversation = conversationRef.current;
    const beforeSeq = historyOldestSeqRef.current;
    if (!conversation || beforeSeq == null) return;
    historyLoadingRef.current = true;
    const loadToken = ++historyLoadTokenRef.current;
    const scopeRevision = useRoomStore.getState().workspaceScopeRevision;
    setHistoryLoadingOlder(true);
    setHistoryOlderError(null);
    try {
      const epoch = await requireWorkspaceEpoch();
      const result = await window.astella.companion.chat.listMessages({
        meta: createRequestMeta(epoch),
        request: { version: 1, conversationId: conversation.id, limit: 20, beforeSeq },
      });
      if (loadToken !== historyLoadTokenRef.current
        || useRoomStore.getState().workspaceScopeRevision !== scopeRevision
        || conversationRef.current?.id !== conversation.id) return;
      if (!result.ok) {
        setHistoryOlderError(gatewayErrorMessage(result.error));
        return;
      }
      historyOldestSeqRef.current = result.data.oldestSeq;
      setHistoryHasMore(result.data.hasMore);
      setOlderMessages((current) => {
        const seen = new Set(current.map((item) => item.id));
        const older = result.data.items.filter((item) => !seen.has(item.id));
        return older.length > 0 ? [...older, ...current] : current;
      });
    } catch (error) {
      if (loadToken === historyLoadTokenRef.current && conversationRef.current?.id === conversation.id) {
        setHistoryOlderError(gatewayErrorMessage(error));
      }
    } finally {
      if (loadToken === historyLoadTokenRef.current) {
        historyLoadingRef.current = false;
        setHistoryLoadingOlder(false);
      }
    }
  }, []);

  /**
   * 全量拉取（搜索/日期筛选的数据底座，带会话级缓存）：向前翻到会话开头，
   * **再并上当前最近窗口**——搜索池必须包含最近 50 条，否则刚聊过的内容搜不到。
   * 必须读到会话开头；任何页失败都不把部分结果当作完整搜索池。
   * **未就绪（会话/最近窗口还没建立）返回 null**——调用方不得把 null 缓存成
   * 「没有消息」，否则一次过早的调用会永久污染搜索与月历（实机踩过）。
   */
  const fetchAllMessages = useCallback(async (): Promise<readonly CompanionMessageV1[] | null> => {
    const revision = historyRevisionRef.current;
    const scopeRevision = useRoomStore.getState().workspaceScopeRevision;
    const cached = historyAllRef.current;
    if (cached?.revision === revision && cached.scopeRevision === scopeRevision) return cached.items;
    const conversation = conversationRef.current;
    const baseline = historyRecentOldestSeqRef.current;
    // 会话/最近窗口未就绪 → null；空会话的下界也为 null，但准备好后应返回空结果。
    if (!conversation || !historyBaselineReadyRef.current) return null;
    const older = await readCompleteCompanionHistory(baseline, async (beforeSeq) => {
      if (historyRevisionRef.current !== revision || useRoomStore.getState().workspaceScopeRevision !== scopeRevision) return null;
      const epoch = await requireWorkspaceEpoch();
      if (historyRevisionRef.current !== revision || useRoomStore.getState().workspaceScopeRevision !== scopeRevision) return null;
      const result = await window.astella.companion.chat.listMessages({
        meta: createRequestMeta(epoch),
        request: { version: 1, conversationId: conversation.id, limit: 100, beforeSeq },
      });
      return result.ok ? result.data : null;
    });
    if (!older) return null;
    if (historyRevisionRef.current !== revision
      || conversationRef.current?.id !== conversation.id
      || useRoomStore.getState().workspaceScopeRevision !== scopeRevision) return null;
    const seen = new Set(older.map((item) => item.id));
    const full = [...older, ...recentMessagesRef.current.filter((item) => !seen.has(item.id))];
    historyAllRef.current = { revision, scopeRevision, items: full };
    return full;
  }, []);

  /**
   * 从 run 摘要里取回**当前活动那条 run**（id + generation，2026-09-19）。
   *
   * 两个用途：撞上 409 RUN_ALREADY_ACTIVE 而本地没握着那条 run 的回执时（应用重启、
   * 或那一轮是在别的入口发起的），接替它重发一次；取不到时至少让用户看见"停掉上一条"
   * 这个真能按的按钮，而不是一句指向不存在的停止的提示。
   *
   * 返回 null = 没有活动 run，或这条读失败（限流也在内）——两种情况都不该重发。
   */
  const resolveActiveRunGeneration = useCallback(async (
    conversationId: string,
    epoch: number,
  ): Promise<{ runId: string; generation: number } | null> => {
    try {
      const result = unwrapGatewayResult(await window.astella.companion.chat.listRunNodes({
        meta: createRequestMeta(epoch),
        request: { version: 1, conversationId },
      }));
      const active = result.runs.find((run) => COMPANION_ACTIVE_RUN_STATUSES.includes(run.status));
      return active ? { runId: active.runId, generation: active.generation } : null;
    } catch {
      return null;
    }
  }, []);

  // 历史抽屉打开才拉完整消息，常驻气泡不额外制造请求。
  useEffect(() => {
    if (mode !== "history") return;
    let cancelled = false;
    const generation = sendGenerationRef.current;
    // 记录读取只拥有空闲时的加载状态。已有发送、或读取途中开始的新一轮，
    // 都由发送链路收尾；晚到的记录快照不能把正在回复/真实失败改成就绪。
    const startedIdle = pendingSendRef.current === null && activeTurnRef.current === null;
    const canUpdatePhase = () => startedIdle && generation === sendGenerationRef.current
      && pendingSendRef.current === null && activeTurnRef.current === null;
    setPhase((current) => (conversationRef.current ? current : "loading"));
    void (async () => {
      try {
        const epoch = await requireWorkspaceEpoch();
        const active = await ensureConversation();
        if (cancelled) return;
        await refreshMessages(active.id, epoch);
        if (!cancelled && canUpdatePhase()) setPhase("ready");
      } catch (error) {
        if (cancelled || !canUpdatePhase()) return;
        setFailure(gatewayErrorMessage(error));
        setPhase("error");
      }
    })();
    return () => { cancelled = true; };
  }, [conversationReloadKey, ensureConversation, mode, refreshMessages]);

  // 两段低频补白轮询（agent 导航 route / 过程留痕）——它们**不是聊天主链路**，
  // 失败静默跳过。收在 `useCompanionPolls` 里：性质写在文件名上，比埋在 Provider 中段好读。
  const followReviewContinuation = [...messages, ...olderMessages].some(message => {
    if (!message.runId || message.kind !== "action") return false;
    const decidedReview = message.blocks.some(block => {
      if (block.type !== "action_ref") return false;
      const state = proposalStates[block.proposalId];
      return state?.phase === "ready" && state.proposal.payload.kind === "agent_tool_review"
        && state.proposal.status !== "pending";
    });
    const run = runTraces.find(trace => trace.summary.runId === message.runId);
    return decidedReview && (!run || ["accepted", "running", "waiting_for_confirmation", "cancel_requested"].includes(run.summary.status));
  });
  useCompanionPolls({
    conversation, mode, phase, routeCursorRef, pushNavChips, setRunTraces, tracesRevision, followReviewContinuation,
    historyRunIds: useMemo(() => [...new Set([...olderMessages, ...messages].flatMap(message => message.runId ? [message.runId] : [])
      .concat(processRunId ? [processRunId] : []))], [olderMessages, messages, processRunId]),
  });

  // A confirmed review can resume after reopening, without the original SSE
  // consumer. The durable final-message identity triggers one history refresh.
  useEffect(() => {
    if (!conversation) return;
    const known = new Set([...messages, ...olderMessages].map(message => message.id));
    const missing = runTraces.flatMap(trace => {
      const id = trace.summary.assistantMessageId;
      return id && !known.has(id) && !restoredReplyIdsRef.current.has(id) ? [id] : [];
    });
    if (!missing.length) return;
    missing.forEach(id => restoredReplyIdsRef.current.add(id));
    void requireWorkspaceEpoch().then(epoch => refreshMessages(conversation.id, epoch)).catch(() => {
      missing.forEach(id => restoredReplyIdsRef.current.delete(id));
    });
  }, [conversation, messages, olderMessages, refreshMessages, runTraces]);

  useEffect(() => {
    const snapshot = runTraces.find(trace => trace.summary.runId === processRunId);
    if (!snapshot) return;
    // 把补回的回执留在本轮节点里，后到的旧轮询或空快照不能撤销已看到的结果。
    setNodes(current => reconcileCompanionAgentNodes(current, snapshot.nodes));
  }, [nodes, processRunId, runTraces]);

  // ── 提案快照拉取 ──────────────────────────────────────────────────────
  /**
   * 取回一份提案快照（成功落 ready，失败落 error）。
   *
   * 单独成函数是为了**可重试**：读失败时该 id 会以 `{phase:"error"}` 留在表里，
   * 而下面那个 effect 的守卫是「不在表里才取」—— 于是"这个选择暂时无法读取"会挂到
   * 应用重启为止（方案 35 F1）。重试走同一条路径，不另造第二份真话。
   * 回执归属按会话 id 判：跨工作区切换后晚到的快照不许写回表里。
   */
  const loadProposalSnapshots = useCallback(async (ids: readonly string[]): Promise<void> => {
    const conversationId = conversationRef.current?.id ?? null;
    if (conversationId === null || ids.length === 0) return;
    for (const id of ids) {
      try {
        const epoch = await requireWorkspaceEpoch();
        const snapshot = unwrapGatewayResult(await window.astella.companion.chat.getProposal({
          meta: createRequestMeta(epoch),
          request: { version: 1, proposalId: id },
        }));
        if (conversationRef.current?.id !== conversationId) return;
        setProposalStates((current) => {
          const existing = current[id];
          return { ...current, [id]: { phase: "ready", proposal: snapshot.proposal,
            ...(snapshot.proposal.status === "pending" && existing?.phase === "ready" && existing.deciding
              ? { deciding: existing.deciding } : {}) } };
        });
      } catch (error) {
        if (conversationRef.current?.id !== conversationId) return;
        setProposalStates((current) => ({ ...current, [id]: { phase: "error", message: gatewayErrorMessage(error) } }));
      }
    }
  }, []);

  const retryProposal = useCallback((proposalId: string): void => {
    setProposalStates((current) => ({ ...current, [proposalId]: { phase: "loading" } }));
    void loadProposalSnapshots([proposalId]);
  }, [loadProposalSnapshots]);

  // 消息流里出现 action_ref 就取快照（拿 payloadSha256 与当前状态）。
  // 2026-10-11（审计 F4）：不再只在 `history` 打开时才扫——待确认的提案要在身边
  // 有常驻入口（手记角标）就得提前知道，所以消息一到就取快照，数量有界
  // （受已加载消息里的 action_ref 条数约束）。
  useEffect(() => {
    if (!conversation) return;
    const ids = new Set<string>();
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const block of message.blocks) {
        if (block.type === "action_ref") ids.add(block.proposalId);
      }
    }
    for (const proposalId of liveReply?.proposalIds ?? []) ids.add(proposalId);
    const missing = [...ids].filter((id) => !(id in proposalStates));
    if (missing.length === 0) return;
    setProposalStates((current) => {
      const next = { ...current };
      for (const id of missing) next[id] = { phase: "loading" };
      return next;
    });
    void loadProposalSnapshots(missing);
  // proposalStates 刻意不进依赖：effect 先写 loading、再异步写 ready；若把它放进依赖，
  // loading 会触发 cleanup，把自己刚发出的快照请求标成 cancelled，卡片便永久停在加载态。
  // 新 proposal 的触发源始终是消息、liveReply 或 mode 变化。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation, liveReply, messages, mode]);

  // A review can be decided on another device or saved after reopening the app.
  // Follow its durable state even when the original turn's SSE is no longer open.
  useEffect(() => {
    const ids = Object.values(proposalStates).flatMap(state => state.phase === "ready"
      && state.proposal.payload.kind === "agent_tool_review"
      && ["pending", "accepted", "executing"].includes(state.proposal.status) ? [state.proposal.proposalId] : []);
    if (!conversation || ids.length === 0) return;
    const timer = window.setTimeout(() => void loadProposalSnapshots(ids), 3000);
    return () => window.clearTimeout(timer);
  }, [conversation, loadProposalSnapshots, proposalStates]);

  /**
   * 读本轮 run 的终态（只读端点 `listRunNodes` 的 `runs[]` 摘要，2026-09-19 ②）。
   *
   * 为什么不能只看消息列表：run 失败时 worker 只写 `error` 事件、**不写 assistant
   * 消息**（`markCompanionRunFailed` 只更新 run 行 + 插事件）。于是"消息还没到"
   * 既可能是"还在生成"，也可能是"永远不会来"——旧实现在后一种情况下只能干等到
   * `REPLY_POLL_TIMEOUT_MS`（120s）才报"等待超时"，用户看到的就是"卡死两分钟然后
   * 报错"，而真实失败原因（`json_envelope_leak` 之类）被彻底丢掉。
   *
   * 返回 null 表示"还没到终态，继续等"。这里只认三种终态，`waiting_for_confirmation`
   * 不是终态（它在等用户裁决，仍可能产出消息）。
   */
  const readRunTerminal = useCallback(async (
    conversationId: string,
    epoch: number,
    runId: string,
  ): Promise<CompanionReplyWaitOutcome | null> => {
    const result = unwrapGatewayResult(await window.astella.companion.chat.listRunNodes({
      meta: createRequestMeta(epoch),
      request: { version: 1, conversationId },
    }));
    const run = result.runs.find((item) => item.runId === runId);
    if (!run) return null;
    if (run.status === "failed") {
      // 具体原因（error_code）不在这个摘要里，不能编；只把"这一轮确实失败了"说清楚。
      return { kind: "failed", code: null, message: companionReplyFailureMessage(null, false) };
    }
    if (run.status === "cancelled") return { kind: "cancelled" };
    if (run.status === "succeeded") return { kind: "silent" };
    return null;
  }, []);

  /**
   * 认领超时后的僵尸清理（2026-09-19 用户实测"频繁提问就卡死、功能用不了"）。
   *
   * 实机上出现过 run 永远停在 accepted、worker 日志零记录的僵尸（job 在 worker
   * 重启时丢失）。它不会自己变成终态，于是：这一轮要白等满 120s 才报超时，下一轮
   * 发送还要先撞 409 再走接替。超时即尽力取消（原子置 cancelled），把僵尸就地
   * 变成终态；失败也无所谓——下一轮发送的 supersedesGeneration 仍能接替它。
   */
  const cancelRunInBackground = useCallback((runId: string, runGeneration: number, runEpoch: number): void => {
    void window.astella.companion.chat.cancelRun({
      meta: createRequestMeta(runEpoch),
      request: { version: 1, runId, generation: runGeneration },
    }).catch(() => undefined);
  }, []);

  /**
   * 停掉**挡住发送**的那条 run（2026-10-13）。
   *
   * 与「停止这一轮」的区别：这一轮的停止要有本机握着的活动轮回执，而挡住发送的那条
   * 往往是重启前的、或在别的入口发起的、或 worker 已经不再管的僵尸。服务端取消是
   * 原子置 cancelled（幂等，重复点安全），停完这句还在输入框里，再按一次发送就行。
   */
  const stopBlockedTurn = useCallback(async (): Promise<void> => {
    const blocked = blockedByRun;
    if (!blocked) return;
    setBlockedByRun(null);
    const epoch = await requireWorkspaceEpoch().catch(() => null);
    if (epoch === null) return;
    cancelRunInBackground(blocked.runId, blocked.generation, epoch);
    setStopNotice("已让上一条停下，这句可以再发一次。");
    setFailure(null);
    setPhase("ready");
  }, [blockedByRun, cancelRunInBackground]);

  /** Cancellable serial backstop; a quiet stream must not exhaust the shared read quota. */
  const startReplyPoll = useCallback((args: {
    conversationId: string;
    epoch: number;
    runId: string;
    generation: number;
    intervalMs: number;
  }): { promise: Promise<CompanionReplyWaitOutcome>; cancel: () => void; accelerate: () => void } => {
    let cancelled = false;
    let resolve!: (outcome: CompanionReplyWaitOutcome) => void;
    const promise = new Promise<CompanionReplyWaitOutcome>(done => { resolve = done; });
    let ticks = 0;
    const poll = scheduleCompanionPoll({
      intervalMs: args.intervalMs,
      maxIdleIntervalMs: 5_000,
      poll: async () => {
        if (cancelled) return true;
        if (args.generation !== sendGenerationRef.current) {
          resolve({ kind: "timeout" });
          return true;
        }
        const items = await refreshMessages(args.conversationId, args.epoch);
        if (cancelled) return true;
        const match = items.filter((item) => item.role === "assistant" && item.runId === args.runId && item.kind !== "action").at(-1);
        ticks += 1;
        if (match || ticks % REPLY_RUN_STATUS_EVERY_N_TICKS === 0) {
          const terminal = await readRunTerminal(args.conversationId, args.epoch, args.runId);
          if (cancelled) return true;
          if (terminal) {
            resolve(match && terminal.kind === "silent" ? { kind: "reply", message: match }
              : match && terminal.kind === "cancelled" ? { kind: "cancelled", text: companionMessageText(match) } : terminal);
            return true;
          }
        }
        return false;
      },
    });
    return {
      promise,
      cancel: () => { cancelled = true; poll.cancel(); },
      accelerate: poll.requestSoon,
    };
  }, [readRunTerminal, refreshMessages]);

  /**
   * SSE 认领回复（主路径，§5.3），返回可取消的句柄。
   *
   * 订阅起点是回合响应里的 `eventCursor`（turn.accepted 的 seq）：只收本轮之后的
   * 事件，不重放整段历史。assistant.delta 按 appendFrom 断点续拼成草稿（气泡与
   * 语音据此渐进呈现），assistant.final 表示生成结束。
   *
   * 拿不到 subscriptionId → `unavailable`（调用方交给轮询）；订阅建立了但
   * `REPLY_STREAM_IDLE_MS` 内一帧都没到 → 只通知提速，**继续挂着**等终态帧。
   */
  const startReplyStream = useCallback((args: {
    conversationId: string;
    runId: string;
    eventCursor: number;
    epoch: number;
    generation: number;
    voiceOutput: boolean;
    background?: boolean;
    onFollowupsReady?: (messageId: string, prompts: string[]) => void;
    /** 订阅建立后迟迟没有任何帧：通知调用方把兜底赛道提速（**不要**退订）。 */
    onIdle?: () => void;
  }): { promise: Promise<CompanionReplyStreamOutcome>; cancel: () => void; watchFollowups: (messageId: string) => void } => {
    const subscriptions = window.astella?.subscriptions;
    if (!subscriptions) {
      return { promise: Promise.resolve({ kind: "unavailable" }), cancel: () => undefined, watchFollowups: () => undefined };
    }
    let cancel: () => void = () => undefined;
    let watchFollowups: (messageId: string) => void = () => undefined;
    const promise = new Promise<CompanionReplyStreamOutcome>((resolve) => {
      let settled = false;
      let timer = 0;
      let idleTimer = 0;
      let finalDrainTimer = 0;
      let finalSeen = false;
      let finalMessageId: string | null = null;
      let lastEventSeq = args.eventCursor;
      let detach: (() => void) | null = null;
      let subscriptionId: string | null = null;
      const watchLateFollowups = (messageId = finalMessageId): void => {
        if (!messageId || followupReadyMessageIdsRef.current.has(messageId)) return;
        const watchedMessageId = messageId;
        let cancelled = false;
        let watcherId: string | null = null;
        let detachWatcher: (() => void) | null = null;
        let watcherTimer = 0;
        const closeWatcher = (): void => {
          if (cancelled) return;
          cancelled = true;
          window.clearTimeout(watcherTimer);
          detachWatcher?.();
          detachWatcher = null;
          if (watcherId) {
            void subscriptions.unsubscribe({ meta: createRequestMeta(args.epoch), subscriptionId: watcherId }).catch(() => undefined);
            watcherId = null;
          }
          lateFollowupWatchersRef.current.delete(closeWatcher);
        };
        lateFollowupWatchersRef.current.add(closeWatcher);
        watcherTimer = window.setTimeout(closeWatcher, 15_000);
        void subscriptions.subscribe({
          meta: createRequestMeta(args.epoch),
          topic: {
            kind: "companionChat",
            conversationId: args.conversationId,
            eventCursor: lastEventSeq,
            voiceOutput: false,
          },
        }).then((response) => {
          watcherId = unwrapGatewayResult(response).subscriptionId;
          if (cancelled) {
            void subscriptions.unsubscribe({ meta: createRequestMeta(args.epoch), subscriptionId: watcherId }).catch(() => undefined);
            return;
          }
          detachWatcher = subscriptions.onEvent(watcherId, (event) => {
            const data = event.data;
            if (data.kind !== "companion_chat_event" || data.conversationId !== args.conversationId) return;
            const streamed = data.event;
            if (streamed.runId !== args.runId || streamed.eventType !== "assistant.followups.ready") return;
            const payload = streamed.payload as { messageId?: unknown; followUpPrompts?: unknown };
            if (payload.messageId !== watchedMessageId || !Array.isArray(payload.followUpPrompts)
              || !payload.followUpPrompts.every((prompt): prompt is string => typeof prompt === "string")) return;
            args.onFollowupsReady?.(watchedMessageId, payload.followUpPrompts);
            closeWatcher();
          });
          if (followupReadyMessageIdsRef.current.has(watchedMessageId)) {
            closeWatcher();
            return;
          }
          // Subscribing to an already-open conversation stream does not replay frames it
          // has already consumed. This read closes that tiny subscribe/replay race.
          void refreshMessages(args.conversationId, args.epoch).then((items) => {
            const message = items.find((item) => item.id === watchedMessageId);
            const legacyPrompts = message?.blocks.flatMap((item) => item.type === "follow_up_suggestions" ? item.prompts : []) ?? [];
            const prompts = message?.followUpPrompts?.length ? message.followUpPrompts : legacyPrompts;
            if (prompts.length > 0 && prompts.every((prompt): prompt is string => typeof prompt === "string")) {
              args.onFollowupsReady?.(watchedMessageId, prompts);
              closeWatcher();
            } else if (followupReadyMessageIdsRef.current.has(watchedMessageId)) {
              closeWatcher();
            }
          }).catch(() => undefined);
        }).catch(() => closeWatcher());
      };
      watchFollowups = (messageId) => watchLateFollowups(messageId);
      const settle = (outcome: CompanionReplyStreamOutcome): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        window.clearTimeout(idleTimer);
        window.clearTimeout(finalDrainTimer);
        if (outcome.kind === "final") watchLateFollowups();
        detach?.();
        if (subscriptionId) {
          void subscriptions.unsubscribe({
            meta: createRequestMeta(args.epoch),
            subscriptionId,
          }).catch(() => undefined);
        }
        resolve(outcome);
      };
      cancel = () => settle({ kind: "timeout" });
      void (async () => {
        try {
          const subscribed = await subscriptions.subscribe({
            meta: createRequestMeta(args.epoch),
            topic: {
              kind: "companionChat",
              conversationId: args.conversationId,
              eventCursor: args.eventCursor,
              voiceOutput: args.voiceOutput,
            },
          });
          subscriptionId = unwrapGatewayResult(subscribed).subscriptionId;
        } catch {
          settle({ kind: "unavailable" });
          return;
        }
        if (settled) {
          void subscriptions.unsubscribe({ meta: createRequestMeta(args.epoch), subscriptionId }).catch(() => undefined);
          return;
        }
        // 静默只提速、不退订（2026-09-19 ②）：退订之后晚到的 `error` 帧就再也送不到，
        // 失败会被伪装成"等满 120s 然后超时"——真实原因（格式判死、预算耗尽）彻底丢失。
        // 兜底轮询本来就并行在跑，这里让它切到快档即可；订阅继续等终态帧，先到先赢。
        idleTimer = window.setTimeout(() => {
          idleTimer = 0;
          args.onIdle?.();
        }, REPLY_STREAM_IDLE_MS);
        detach = subscriptions.onEvent(subscriptionId, (event) => {
          if (args.generation !== sendGenerationRef.current) {
            settle({ kind: "unavailable" });
            return;
          }
          const data = event.data;
          if (data.kind !== "companion_chat_event" || data.conversationId !== args.conversationId) return;
          const streamed = data.event;
          if (streamed.runId !== args.runId) return;
          if (args.background && ["assistant.status", "assistant.thinking"].includes(streamed.eventType)) return;
          lastEventSeq = Math.max(lastEventSeq, streamed.seq);
          setRunTraces(current => recordCompanionRunEvent(current, { ...streamed, runId: args.runId }));
          // 收到本轮的帧即证明流是活的：撤掉"沉默降级"计时器。
          window.clearTimeout(idleTimer);
          idleTimer = 0;
          // 节点帧（assistant.status / agent.tool）不再丢弃：折进本轮轨道。
          // 非节点帧会返回同一个数组引用，setState 直接 bail out，不产生额外渲染。
          setNodes((current) => appendCompanionAgentNode(current, {
            eventType: streamed.eventType,
            payload: streamed.payload,
          }));
          // 导航 chip 走 **SSE 实时通道**（2026-09-19 用户实测修复）：此前 chip 只靠
          // 抽屉打开时的 agent-routes 轮询补白——用户在气泡模式下聊天，route 事件根本
          // 不会被拉取，permissionLevel=full 的 autoExecute 自然一次都不触发；等打开
          // 抽屉，首次游标又跳到最新，旧事件全被吞掉。现在流里带 seq 的 agent.tool 帧
          // 直接折成 chip（抽屉轮询按同一 id 去重，两条来源不冲突），自动跳不再依赖
          // 抽屉开关。
          if (streamed.eventType === "agent.tool") {
            const work = streamed.payload.tool as { name?: string; toolCallId?: string; status?: string; proposalId?: string; noteEditTarget?: { noteId: string; startBlock: number; endBlock: number }; noteEdit?: unknown; noteAnnotation?: { requestId: string; annotation: unknown } } | undefined;
            if (work?.name === "companion_write_annotation") {
              const pending = pendingSendRef.current;
              if (pending?.generation === args.generation && pending.explanationId) {
                if (work.status === "executing") progressNoteExplanation(pending.explanationId);
                if (work.status === "succeeded" && work.noteAnnotation?.requestId === pending.explanationId)
                  completeNoteExplanation(pending.explanationId, work.noteAnnotation.annotation);
              }
            }
            if (work?.proposalId && work.status) {
              const proposalId = work.proposalId;
              const status = work.status === "succeeded" ? "succeeded" : ["failed", "blocked", "not_executed"].includes(work.status)
                ? "failed" : work.status === "executing" ? "executing" : null;
              if (status) setProposalStates(current => {
                const existing = current[proposalId];
                return existing?.phase === "ready" && !["succeeded", "rejected", "failed", "expired"].includes(existing.proposal.status)
                  ? { ...current, [proposalId]: { ...existing,
                  proposal: { ...existing.proposal, status }, deciding: undefined } } : current;
              });
              if (["succeeded", "failed", "blocked", "outcome_unknown", "not_executed"].includes(work.status))
                void loadProposalSnapshots([proposalId]);
            }
            if (work?.name === "companion_edit_note") {
              if (work.noteEditTarget && work.status === "executing") beginNoteAiWork(`turn:${args.generation}:tool:${work.toolCallId}`, work.noteEditTarget.noteId,
                [{ ...work.noteEditTarget, label: "伴星正在调整这段" }]);
              if (work.status && !["requested", "executing"].includes(work.status)) endNoteAiWork(`turn:${args.generation}:tool:${work.toolCallId}`);
              const receipt = companionEditedNoteV1Schema.safeParse(work.noteEdit);
              if (receipt.success) { endNoteAiWork(`turn:${args.generation}`); window.dispatchEvent(new CustomEvent("astella:note-ai-edited", { detail: receipt.data })); }
            }
            const tool = streamed.payload.tool as
              | { name?: unknown; safeSummary?: unknown; route?: unknown; autoExecute?: unknown }
              | undefined;
            if (
              tool
              && typeof tool.safeSummary === "string"
              && tool.safeSummary.length > 0
              && tool.route
              && typeof tool.route === "object"
            ) {
              const route = desktopRouteFromAgentRoute(tool.route as CompanionAgentRouteEventV1["route"]);
              if (route) {
                pushNavChips([{
                  id: `evt:${streamed.seq}`,
                  summary: tool.safeSummary,
                  route,
                  ...(tool.autoExecute === true ? { autoExecute: true } : {}),
                }]);
              }
            }
          }
          if (streamed.eventType === "turn.accepted" && !args.background) {
            setPhase("sending");
          }
          if (streamed.eventType === "character.cue") {
            const cue = streamed.payload.cue as Partial<CharacterCuePayloadV1> | undefined;
            if (cue?.version === 1 && typeof cue.intent === "string" && typeof cue.emotion === "string"
              && typeof cue.intensity === "number") {
              setStreamCue({
                version: 1,
                intent: cue.intent as CharacterCuePayloadV1["intent"],
                emotion: cue.emotion as CharacterCuePayloadV1["emotion"],
                intensity: Math.min(1, Math.max(0, cue.intensity)),
                ...(typeof cue.durationMs === "number" ? { durationMs: cue.durationMs } : {}),
                seq: streamed.seq,
              });
            }
            // 成功事务中 assistant.final 后面紧跟最终 character.cue。先处理 cue
            // 再收流，避免 final 一到就退订，把角色的最终表演帧丢掉。
            if (finalSeen) {
              settle({ kind: "final" });
              return;
            }
          }
          if (streamed.eventType === "action.proposed") {
            const proposal = streamed.payload.proposal as { id?: unknown } | undefined;
            if (proposal && typeof proposal.id === "string") {
              const proposalId = proposal.id;
              setProposalStates((current) => ({ ...current, [proposalId]: { phase: "loading" } }));
              void window.astella.companion.chat.getProposal({
                meta: createRequestMeta(args.epoch),
                request: { version: 1, proposalId },
              }).then((response) => {
                const snapshot = unwrapGatewayResult(response);
                setProposalStates((current) => ({ ...current, [proposalId]: { phase: "ready", proposal: snapshot.proposal } }));
              }).catch((error) => {
                setProposalStates((current) => ({ ...current, [proposalId]: { phase: "error", message: gatewayErrorMessage(error) } }));
              });
            }
          }
          if (streamed.eventType === "action.decision") {
            const payload = streamed.payload as { proposalId?: unknown; decision?: unknown; status?: unknown };
            if (typeof payload.proposalId === "string") {
              setProposalStates((current) => {
                const existing = current[payload.proposalId as string];
                if (!existing || existing.phase !== "ready") return current;
                return {
                  ...current,
                  [payload.proposalId as string]: {
                    phase: "ready",
                    proposal: {
                      ...existing.proposal,
                      status: payload.status === "rejected" ? "rejected" : "accepted",
                      decision: payload.decision === "reject" ? "reject" : "confirm",
                    },
                  },
                };
              });
            }
          }
          if (streamed.eventType === "action.expired") {
            const proposalId = streamed.payload.proposalId;
            if (typeof proposalId === "string") {
              setProposalStates((current) => {
                const existing = current[proposalId];
                if (!existing || existing.phase !== "ready") return current;
                return { ...current, [proposalId]: { phase: "ready", proposal: { ...existing.proposal, status: "expired" } } };
              });
            }
          }
          if (streamed.eventType === "proactive.delivery" || streamed.eventType === "proactive.delivery.updated") {
            window.dispatchEvent(new CustomEvent("astella:companion-activity-changed"));
          }
          if (streamed.eventType === "voice.segment.ready") {
            // 先入队再唤醒：气泡不在场时这一段也不会丢，下一次挂载补听
            // （判据与队列见 companion-voice-segment-queue.ts）。
            const queuedSegment = queueCompanionVoiceSegment({
              conversationId: args.conversationId,
              runId: streamed.runId,
              generation: streamed.generation,
              ...streamed.payload,
            });
            if (queuedSegment) {
              window.dispatchEvent(new CustomEvent("astella:companion-voice-segment-ready"));
            }
          }
          if (streamed.eventType === "assistant.thinking") {
            // 思考只更新那个尾部窗口：它不是正文，不参与草稿、显现计数与朗读。
            const payload = streamed.payload as { index?: unknown; text?: unknown };
            if (typeof payload.text !== "string" || typeof payload.index !== "number") return;
            const index = payload.index;
            const text = payload.text;
            setThinkingView((current) => appendCompanionThinking(current, args.runId, index, text));
            return;
          }
          if (streamed.eventType === "assistant.delta") {
            const payload = streamed.payload as { appendFrom?: unknown; textDelta?: unknown };
            if (typeof payload.textDelta !== "string") return;
            const appendFrom = typeof payload.appendFrom === "number" ? payload.appendFrom : draftRef.current.length;
            // 缺口（appendFrom 落在已收内容之后）不猜：交给终态消息兜底。
            if (appendFrom > draftRef.current.length) return;
            // 纯追加是最常见的形状（服务端就是按块往后长）：这一支直接拼，省掉一次
            // 全长 `slice` 拷贝与它产生的临时串。回写/补洞那一支仍走截断重拼。
            const current = draftRef.current;
            const next = appendFrom === current.length
              ? current + payload.textDelta
              : current.slice(0, appendFrom) + payload.textDelta;
            draftRef.current = next;
            setDraft({ runId: args.runId, text: [next, utteranceTextRef.current.get(args.runId) ?? ""].filter(Boolean).join("\n\n") });
            const pending = pendingSendRef.current;
            return;
          }
          if (streamed.eventType === "assistant.utterance") {
            const payload = streamed.payload as { messageId?: unknown; text?: unknown };
            if (typeof payload.messageId === "string" && typeof payload.text === "string") {
              const ids = utteranceIdsRef.current.get(args.runId) ?? new Set<string>();
              if (ids.has(payload.messageId)) return;
              ids.add(payload.messageId); utteranceIdsRef.current.set(args.runId,ids);
              const previous = utteranceTextRef.current.get(args.runId) ?? "";
              const utterances = previous ? previous + "\n\n" + payload.text : payload.text;
              utteranceTextRef.current.set(args.runId, utterances);
              while (utteranceTextRef.current.size > 20) {
                const oldest = utteranceTextRef.current.keys().next().value!;
                utteranceTextRef.current.delete(oldest); utteranceIdsRef.current.delete(oldest);
              }
              if (args.background) setLiveReply({ messageId: payload.messageId, text: utterances,
                webCitations: [], hasActionBlocks: false, proposalIds: [] });
              else setDraft({ runId: args.runId, text: [draftRef.current, utterances].filter(Boolean).join("\n\n") });
              void refreshMessages(args.conversationId, args.epoch).catch(() => undefined);
            }
            return;
          }
          if (streamed.eventType === "turn.completed") { settle({ kind: "final" }); return; }
          if (streamed.eventType === "assistant.final") {
            finalSeen = true;
            const payload = streamed.payload as { messageId?: unknown };
            finalMessageId = typeof payload.messageId === "string" ? payload.messageId : null;
            // 兼容没有尾随 cue 的旧服务：短暂排空同一批 SSE 后仍会正常收尾。
            finalDrainTimer = window.setTimeout(() => settle({ kind: "final" }), 220);
            return;
          }
          if (streamed.eventType === "assistant.followups.ready") {
            const payload = streamed.payload as { messageId?: unknown; followUpPrompts?: unknown };
            if (typeof payload.messageId === "string" && Array.isArray(payload.followUpPrompts)
              && payload.followUpPrompts.every((prompt): prompt is string => typeof prompt === "string")) {
              args.onFollowupsReady?.(payload.messageId, payload.followUpPrompts);
            }
            return;
          }
        if (streamed.eventType === "turn.cancelled") {
          // 用户按下"停止"是一条**用户选择**，不是故障：既不能报错，也不能提示
          // "再试一次"（那等于把用户的决定当成失败）。reason 分四档，只有
          // user/superseded 属于"我们自己中止"，shutdown/timeout 才交给失败路径。
          const payload = streamed.payload as { reason?: unknown };
          settle(
            payload.reason === "user" || payload.reason === "superseded"
              ? { kind: "cancelled" }
              : {
                  kind: "failed",
                  code: null,
                  message: "这一轮没能完成，可以再试一次。",
                },
          );
          return;
        }
        if (streamed.eventType === "error") {
          // 错误码要带出去：`AI_CONSENT_REQUIRED` 有自己的引导路径，
          // 其余失败才是"再试一次"。
          // 2026-09-19 ②：提示语必须与事实一致。服务端在 error payload 里带了
          // `recoverable`——预算耗尽/流式校验叫停这类失败是**不可重试**的
          // （run 已是终态，队列重投会在 claimed 处直接 no-op），此时说"可以再试一次"
          // 是骗人的，只会让用户对着同一个不动的气泡再点一次。
          const payload = streamed.payload as { code?: unknown; recoverable?: unknown };
          settle({
            kind: "failed",
            code: typeof payload.code === "string" ? payload.code : null,
            message: companionReplyFailureMessage(payload.code, payload.recoverable),
          });
        }
        });
      })();
    });
    return { promise, cancel, watchFollowups: (messageId: string) => watchFollowups(messageId) };
  }, [loadProposalSnapshots, pushNavChips, refreshMessages]);

  /**
   * 认领本轮的回复：SSE（快路径，含草稿）与兜底轮询（慢路径）并行，先到者胜。
   *
   * 两条一起跑是 2026-09-19 的实机加固：流式链路任何一环失效，事件就到不了
   * 渲染层，而回复其实已经写进库里——只跑流就会让气泡停在"想一想"直到超时。
   * 轮询是最笨但最可靠的那条路，让它兜住"流沉默"。
   */
  const claimCompanionReply = useCallback(async (args: {
    conversationId: string;
    runId: string;
    eventCursor: number;
    epoch: number;
    generation: number;
    voiceOutput: boolean;
    background?: boolean;
    onFollowupsReady?: (messageId: string, prompts: string[]) => void;
  }): Promise<CompanionReplyWaitOutcome> => {
    const backstop = startReplyPoll({
      conversationId: args.conversationId,
      epoch: args.epoch,
      runId: args.runId,
      generation: args.generation,
      intervalMs: REPLY_BACKSTOP_POLL_INTERVAL_MS,
    });
    const stream = startReplyStream({
      ...args,
      // 流沉默：兜底赛道提速，但**不**退订——退订等于丢掉晚到的 `error` 帧，
      // 那正是"失败被说成超时"的来源。
      onIdle: () => backstop.accelerate(),
      onFollowupsReady: args.onFollowupsReady,
    });
    let stopWait!: () => void;
    const stopped = new Promise<CompanionReplyWaitOutcome>(resolve => { stopWait = () => {
      stream.cancel(); backstop.cancel(); resolve({ kind: "cancelled" });
    }; });
    replyWaitRef.current = { generation: args.generation, cancel: stopWait };
    try {
      const winner = await Promise.race([
        stream.promise.then((outcome) => ({ source: "stream" as const, outcome })),
        backstop.promise.then((outcome) => ({ source: "backstop" as const, outcome })),
        stopped.then(outcome => ({ source: "backstop" as const, outcome })),
      ]);
      if (winner.source === "backstop") {
        if (winner.outcome.kind === "reply") stream.watchFollowups(winner.outcome.message.id);
        return winner.outcome;
      }
      if (winner.outcome.kind === "final") {
        // 终态事务先写消息再写 final 事件，正常情况这里一次就拿到；
        // 拿不到（读取抖动）也不能让气泡停在"想一想"——回给兜底赛道继续等。
        const items = await refreshMessages(args.conversationId, args.epoch).catch(() => null);
        const match = items?.filter((item) => item.role === "assistant" && item.runId === args.runId && item.kind !== "action").at(-1) ?? null;
        return match ? { kind: "reply", message: match } : { kind: "silent" };
      }
      if (winner.outcome.kind === "failed") {
        return { kind: "failed", code: winner.outcome.code, message: winner.outcome.message };
      }
      if (winner.outcome.kind === "cancelled") {
        // 用户停止：直接把"已中止"交回调用方，不走失败路径。
        return { kind: "cancelled" };
      }
      if (winner.outcome.kind === "unavailable") {
        // 订阅不可用（老 API / 网关拒绝）：交给轮询等完剩余时间。
        return await backstop.promise;
      }
      return { kind: "timeout" };
    } finally {
      stream.cancel();
      backstop.cancel();
      if (replyWaitRef.current?.generation === args.generation) replyWaitRef.current = null;
    }
  }, [refreshMessages, startReplyPoll, startReplyStream]);

  /**
   * 缺少工作区 AI 同意时的固定引导：她先开口（文本 + 语音共用 liveReply 同一条
   * 管线），再把设置页打到「AI 数据同意」的签署卡并让它闪一下。
   *
   * 不写 `failure`：这不是"出错了"，是一次需要用户动手的引导——红色报错和
   * 她说的话会互相打架。
   */
  const guideToConsent = useCallback((externalDisabled = false): void => {
    setLiveReply({
      messageId: `consent-guidance:${crypto.randomUUID()}`,
      text: externalDisabled ? COMPANION_EXTERNAL_DISABLED_LINE : COMPANION_CONSENT_REQUIRED_LINE,
      hasActionBlocks: false,
      proposalIds: [],
    });
    setPhase("ready");
    guideToAiSettings(externalDisabled ? "external_disabled" : "consent_required");
  }, []);

  const runSpeechText = (reply: CompanionMessageV1) => {
    const parts = recentMessagesRef.current.filter(m => m.role === "assistant" && m.runId === reply.runId && ["text", "proactive"].includes(m.kind));
    const durable = parts.length > 1 ? parts.map(companionMessageText).filter(Boolean).join("\n\n") : companionMessageText(reply);
    const published = reply.runId ? utteranceTextRef.current.get(reply.runId) : null;
    return published && published.length > durable.length ? published : durable;
  };

  const send = useCallback(async (input: CompanionChatSendInput): Promise<boolean> => {
    const text = input.text.trim();
    if (text.length === 0) return false;
    const providedAttempt = input.noteAnchor?.explanationId
      ? useNoteCompanionExplanations.getState().items.find(item => item.id === input.noteAnchor!.explanationId)
      : null;
    // A queued attempt stopped before auto-send must never restart itself.
    if (providedAttempt?.phase === "stopped") return false;
    const explanation = input.noteAnchor
      ? providedAttempt?.phase === "preparing" ? providedAttempt : beginNoteExplanation(input.noteAnchor)
      : null;
    if (explanation && explanation.phase !== "preparing") return true;
    const previousPending = pendingSendRef.current;
    replyWaitRef.current?.cancel();
    if (previousPending?.explanationId && previousPending.explanationId !== explanation?.id) {
      interruptNoteExplanation(previousPending.explanationId, "stopped", "已切换到新的提问。这次未完成的解释没有写成批注。");
    }
    const generation = (sendGenerationRef.current += 1);
    const pendingSend = { generation, explanationId: explanation?.id ?? null, cancelled: false };
    pendingSendRef.current = pendingSend;
    if (explanation) setFeedNoteAnchor({ ...explanation.target, explanationId: explanation.id });
    if (!explanation) useNoteCompanionExplanations.setState({ activeId: null });
    /**
     * 「这一轮开始了」的状态复位**不在这里做**，挪到乐观条目落地那一刻（见下面
     * `setPhase("sending")`）。放在函数开头时，中间每一条"发送前置门禁"的早退都必须
     * 自己记得把相位收回去 —— 而同意门禁那条就漏了（不是异常，catch 兜不到），
     * 于是会话永久停在"正在回复中"：麦克风禁用、气泡挂着「正在结合当前页面想一想」，
     * 看起来就是"上一条她还没说完"，而服务端什么都没有跑（方案 35 §23）。
     * 放在这里，漏收这件事在结构上就不可能发生。
     */
    let optimisticId: string | null = null;
    let optimisticConversation: { id: string; epoch: number } | null = null;
    try {
      const epoch = await requireWorkspaceEpoch();
      if (generation !== sendGenerationRef.current) return pendingSend.cancelled;
      // 同意门禁（2026-09-19）：后端要到 worker 调用 provider 前才检查同意，未签署时
      // 用户只会看到"发出去没反应"（静默失败）。这里发送前先问一次工作区 AI 设置，
      // 未签署就直接由伴星引导去签署——不建会话、不消耗一轮 job。
      const consentGate = companionConsentGate(
        unwrapGatewayResult(await window.astella.workspace.getAiSettings({ meta: createRequestMeta(epoch) })),
      );
      if (generation !== sendGenerationRef.current) return pendingSend.cancelled;
      if (consentGate !== null) {
        if (explanation) interruptNoteExplanation(explanation.id, "interrupted", "需要先在设置中允许 AI 读取内容，解释尚未开始。");
        guideToConsent(consentGate === "external_disabled");
        return false;
      }
      const active = await ensureConversation();
      optimisticConversation = { id: active.id, epoch };
      if (generation !== sendGenerationRef.current) return pendingSend.cancelled;
      // 生成中继续打字 = 接替正在跑的那一轮（服务端原子 supersede）。但那个 CAS 值只在
      // 上一轮提交的回执里出现一次，所以先等上一次提交结束再发这一条——抢在它前面发
      // 只会撞上 `409 RUN_ALREADY_ACTIVE`，而那条拒绝发生在**写用户消息之前**：
      // 历史里连这句话都不会有（"查无此轮"的成因之一）。
      await submitGateRef.current;
      if (generation !== sendGenerationRef.current) return pendingSend.cancelled;
      const previousTurn = activeTurnRef.current;
      let turnContext = explanation ? {
        pageKind: "note" as const, sharing: "page_registered" as const,
        noteId: explanation.target.noteId, noteVersionId: explanation.target.anchor.noteVersionId,
        replyPurpose: "annotation" as const,
        annotationTarget: { requestId: explanation.id, anchor: explanation.target.anchor },
      } : await resolveTurnContext(epoch);
      if (!explanation && turnContext?.pageKind === "note" && feedNoteIntent) turnContext = { ...turnContext, replyPurpose: feedNoteIntent.kind };
      if (turnContext?.pageKind === "note" && !explanation) {
        const paper = await prepareCompanionNotePaper(turnContext.noteId);
        if (paper) {
          turnContext = { ...turnContext, ...paper };
          beginNoteAiWork(`turn:${generation}`, turnContext.noteId, noteEditRequestRanges(text, paper.editing));
        }
      }
      if (generation !== sendGenerationRef.current) return pendingSend.cancelled;
      const voiceArtifactId = input.voiceArtifactId ?? null;
      const clientMessageId = crypto.randomUUID();
      optimisticId = crypto.randomUUID();
      /**
       * 预检（会话纪元、同意门禁、上一轮提交闸门、本轮上下文）全部过了，才宣布"这一轮开始"。
       * 从这里往前的任何早退都不动相位，用户看到的还是上一条的真实状态。
       */
      setPhase("sending");
      if (explanation) progressNoteExplanation(explanation.id);
      setStreamCue(null);
      setFailure(null);
      setLiveReply(null);
      setRichReply(null);
      setStopNotice(null);
      setInterrupted(null);
      // 轨道节点是"本轮"的：不清空的话，上一轮的 skill/tool 节点会让 railVisible
      // 永久为 true——上一轮的「N 次工具」摘要挂到天荒地老，连纯闲聊轮也挂着。
      setNodes([]);
      setProcessRunId(null);
      draftRef.current = "";
      setDraft(null);
      // 上一轮的思考不留到这一轮：窗口按 runId 复位，这里只是让发送那一刻就是空的。
      setThinkingView(null);
      // 上一次"被哪条 run 挡住了"的记录也一起清：这一句正在发，旧的结论不该还挂着按钮。
      setBlockedByRun(null);
      const optimistic: CompanionMessageV1 = {
        version: 1,
        id: optimisticId,
        workspaceId: active.workspaceId,
        conversationId: active.id,
        seq: Number.MAX_SAFE_INTEGER,
        role: "user",
        kind: voiceArtifactId ? "voice_transcript" : "text",
        blocks: [
          { type: "text", text },
          ...(input.image ? [{ type: "image" as const, url: input.image.url, label: input.image.label }] : []),
        ],
        ...(input.selection?.text ? { selection: { text: input.selection.text, sharing: "user_selected" as const } } : {}),
        runId: null,
        clientMessageId,
        contentSha256: "0".repeat(64),
        createdAt: new Date().toISOString(),
        editedAt: null,
      };
      setMessages((current) => [...current, optimistic]);

      // 幂等键与 clientMessageId 在重试之间**保持不变**：万一第一次其实已经创建成功
      // （只是回执丢了），重试命中的是服务端的幂等回放，不会留下第二条用户消息。
      const idempotencyKey = crypto.randomUUID();
      const turnBody = (supersedesGeneration: number | null) => ({
        version: 1 as const,
        clientMessageId,
        inputKind: voiceArtifactId ? ("voice_transcript" as const) : ("text" as const),
        blocks: [
          { type: "text" as const, text },
          ...(input.image ? [{ type: "image" as const, url: input.image.url, label: input.image.label }] : []),
        ],
        ...(voiceArtifactId ? { voiceArtifactId } : {}),
        sourceSurface: "pet" as const,
        ...(turnContext ? { context: turnContext } : {}),
        // 划选/拖拽投喂（2026-09-18）：引用原文随 turn 上抛（契约 sharing=user_selected）。
        ...(input.selection?.text ? { selection: { text: input.selection.text, sharing: "user_selected" as const } } : {}),
        // 日记引用（40 §6「聊聊这篇」）：日期 + 版本随本轮上抛，伴星据此按
        // **当前权限**现读那一篇。只带定位、不带正文——正文现读才能保证
        // 「她读到的那一版」就是「用户看到的那一版」。
        ...(feedDiaryAnchor ? { diaryReference: { date: feedDiaryAnchor.date, version: feedDiaryAnchor.version } } : {}),
        ...(supersedesGeneration !== null ? { supersedesGeneration } : {}),
      });

      const postTurn = async (supersedesGeneration: number | null) => {
        let releaseSubmit: () => void = () => undefined;
        submitGateRef.current = new Promise<void>((resolve) => { releaseSubmit = resolve; });
        try {
          const sent = unwrapGatewayResult(await window.astella.companion.chat.sendTurn({
            meta: createRequestMeta(epoch),
            request: {
              version: 1,
              conversationId: active.id,
              idempotencyKey,
              ...(input.voiceOutput === true ? { voiceOutput: true } : {}),
              turn: turnBody(supersedesGeneration),
            },
          }));
          // 记住本轮 run：停止请求要 runId + generation（generation 服务端做 CAS），
          // 而这两个值只在 turn 响应里出现这一次。**必须在放开闸门之前写**，
          // 否则紧接着的那条会把它读成 null。
          if (generation === sendGenerationRef.current) {
            activeTurnRef.current = { runId: sent.runId, generation: sent.generation, conversationId: active.id, explanationId: explanation?.id ?? null };
            setProcessRunId(sent.runId);
          } else {
            // Stop may arrive before the turn receipt: cancel its eventual run without reviving the UI.
            cancelRunInBackground(sent.runId, sent.generation, epoch);
          }
          return sent;
        } finally {
          releaseSubmit();
        }
      };

      // 主路径：SSE 事件流（从 turn.accepted 起只收本轮事件，delta 累积成草稿）
      // 与兜底轮询并行认领，先到者胜——流沉默时不会让气泡干等（见 claimCompanionReply）。
      let sent: { runId: string; generation: number; eventCursor: number };
      try {
        sent = await postTurn(
          previousTurn && previousTurn.conversationId === active.id ? previousTurn.generation : null,
        );
      } catch (error) {
        if (generation !== sendGenerationRef.current) return pendingSend.cancelled;
        if (!isCompanionRunConflict(error)) throw error;
        // 撞上活动 run 而本地不知道它的 generation（应用重启、或先前那一轮是在别的
        // 入口发起的）：从 run 摘要取回那条 run，接替它重发一次。
        const recovered = await resolveActiveRunGeneration(active.id, epoch);
        // 记下来也为了给用户一个真能按的出口：认不出那条 run 时，界面上不许再
        // 出现一句指向不存在的「停止」。
        setBlockedByRun(recovered);
        if (recovered === null || generation !== sendGenerationRef.current) throw error;
        try {
          sent = await postTurn(recovered.generation);
        } catch (retryError) {
          if (!isCompanionRunConflict(retryError)) throw retryError;
          // 接替又撞 409：最可能是那条 run 在我们读到号的这一刻刚好没了（回收器
          // 收掉它、或别的端替掉它）——带着旧号发会被服务端判 STALE_GENERATION，
          // 那也是一次 409。空手再发一次：真还有活动 run 就仍旧被挡，那时屏幕上
          // 已经有「停掉上一条」；没了就正常发出去。
          setBlockedByRun(await resolveActiveRunGeneration(active.id, epoch));
          sent = await postTurn(null);
        }
      }
      if (generation !== sendGenerationRef.current) return pendingSend.cancelled;
      // 发出去了，就没有"被挡住"这回事了。
      setBlockedByRun(null);
      const claimed = await claimCompanionReply({
        conversationId: active.id,
        runId: sent.runId,
        eventCursor: sent.eventCursor,
        epoch,
        generation,
        voiceOutput: input.voiceOutput === true,
        onFollowupsReady: (messageId, prompts) => applyLateFollowups(active.id, epoch, messageId, prompts),
      });
      if (generation !== sendGenerationRef.current) return pendingSend.cancelled;
      // 非回复终态也要把已接受的用户消息换成服务端序号，免得超时/静默结束时
      // 留下 seq=MAX_SAFE_INTEGER 的临时行或丢掉真实消息。
      if (claimed.kind !== "reply") {
        await refreshMessages(active.id, epoch).catch(() => null);
        if (generation !== sendGenerationRef.current) return pendingSend.cancelled;
      }

      // 回合已定论（回复 / 失败 / 中止 / 超时）：这个 run 不再可取消。
      activeTurnRef.current = null;
      // 她已经说出来的部分。失败收尾会清掉草稿（抽屉里不能永远挂着"正在说…"），
      // 但清掉的那一刻用户正看着的这句话不该消失——先留一份。
      const partial = draftRef.current;

      let reply: CompanionMessageV1 | null = null;
      if (claimed.kind === "reply") {
        reply = claimed.message;
      } else if (claimed.kind === "silent") {
        if (explanation) await readNoteExplanation(explanation.id);
        draftRef.current = ""; setDraft(null); setPhase("ready");
        return true;
      } else if (claimed.kind === "cancelled") {
        if (explanation) interruptNoteExplanation(explanation.id, "stopped");
        // 用户按了停止——这不是错误，不写 failure、不提示"再试一次"。
        // 取消事务把已提交增量以 kind='cancelled' 留档；它不发布 assistant.final，
        // 所以重取历史。轮询先读到这条记录时也按中止处理，不能冒充完整回复。
        const stoppedPartial = claimed.text ?? partial;
        draftRef.current = "";
        setDraft(null);
        setLiveReply(null);
        setRichReply(null);
        setInterrupted(stoppedPartial.trim() ? { text: stoppedPartial, message: explanation
          ? "已停止，未完成的内容没有写成批注。" : COMPANION_STOPPED_LINE } : null);
        setStopNotice(COMPANION_STOPPED_LINE);
        setPhase("ready");
        return true;
      } else if (claimed.kind === "failed") {
        if (explanation) interruptNoteExplanation(explanation.id, "interrupted", claimed.message);
        draftRef.current = "";
        setDraft(null);
        if (isCompanionConsentFailure(claimed.code)) {
          // 兜底：签署状态可能在发送前后变化（或发送前那次设置读取失败）。
          // 前置门禁已覆盖大多数情况，这里保证不会退回静默失败。
          guideToConsent(claimed.code === COMPANION_RUN_ERROR_AI_DATA_POLICY_DENIED || claimed.code === "ai_data_policy_denied");
          return true;
        }
        if (partial.trim().length > 0) setInterrupted({ text: partial, message: claimed.message });
        setFailure(claimed.message);
        setPhase("error");
        return true;
      } else {
        // 超时：这条 run 可能还在跑，也可能永远不会产出消息。同样把已经说出来的部分
        // 留档（气泡继续显示它），提示可以稍后在记录里看全文。超时即尽力取消，
        // 防止僵尸 run 继续挡会话（见 cancelRunInBackground 注释）。
        cancelRunInBackground(sent.runId, sent.generation, epoch);
        const message = "消息已经送达，但这次回复等待超时。可以打开对话记录稍后查看。";
        if (explanation) interruptNoteExplanation(explanation.id, "interrupted", message);
        draftRef.current = "";
        setDraft(null);
        if (partial.trim().length > 0) setInterrupted({ text: partial, message });
        setFailure(message);
        setPhase("error");
        return true;
      }

      if (reply) {
        if (explanation) void readNoteExplanation(explanation.id);
        draftRef.current = "";
        setDraft(null);
        const proposalIds = reply.blocks.flatMap((block) => block.type === "action_ref" ? [block.proposalId] : []);
        setLiveReply({
          messageId: reply.id,
          text: runSpeechText({ ...reply, blocks: reply.blocks.filter(block => block.type === "text") }),
          webCitations: reply.blocks.filter(block => block.type === "citation" && block.referenceId),
          hasActionBlocks: proposalIds.length > 0,
          proposalIds,
        });
        const richBlocks = reply.blocks.filter(block => !(block.type === "citation" && block.referenceId)).filter((block) => block.type === "image" || block.type === "quote"
          || block.type === "diagram" || block.type === "card" || block.type === "recommendation" || block.type === "nav" || block.type === "citation" || block.type === "code"
          || block.type === "follow_up_suggestions");
        const pendingFollowups = followupPromptsByMessageRef.current.get(reply.id);
        const finalRichBlocks = pendingFollowups?.length && !richBlocks.some(block => block.type === "follow_up_suggestions")
          ? [...richBlocks, { type: "follow_up_suggestions" as const, prompts: pendingFollowups }]
          : richBlocks;
        setRichReply(finalRichBlocks.length > 0 ? { messageId: reply.id, blocks: finalRichBlocks } : null);
      } else {
        cancelRunInBackground(sent.runId, sent.generation, epoch);
        const message = "消息已经送达，但这次回复等待超时。可以打开对话记录稍后查看。";
        if (explanation) interruptNoteExplanation(explanation.id, "interrupted", message);
        draftRef.current = "";
        setDraft(null);
        if (partial.trim().length > 0) setInterrupted({ text: partial, message });
        setFailure(message);
        setPhase("error");
        return true;
      }
      setPhase("ready");
      return true;
    } catch (error) {
      if (generation !== sendGenerationRef.current) return pendingSend.cancelled;
      if (optimisticId !== null) {
        if (optimisticConversation) {
          await refreshMessages(optimisticConversation.id, optimisticConversation.epoch).catch(() => null);
        }
        // 临时行不是服务端消息。刷新若能找到已接受的用户消息，会保留它的正式序号；
        // 否则移除这条幽灵行，输入框那份文本此刻已经还给用户了。
        setMessages((current) => current.filter((message) => message.id !== optimisticId));
      }
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (isCompanionConsentFailure(code)) {
        if (explanation) interruptNoteExplanation(explanation.id, "interrupted", "需要先在设置中允许 AI 读取内容，解释尚未开始。");
        guideToConsent(code === "ai_data_policy_denied" || code === COMPANION_RUN_ERROR_AI_DATA_POLICY_DENIED);
        return false;
      }
      const turnMessage = companionTurnErrorMessage(error, blockedByRunRef.current !== null);
      setFailure(turnMessage);
      if (explanation) interruptNoteExplanation(explanation.id, "interrupted", turnMessage);
      setPhase("error");
      return false;
    } finally {
      endNoteAiWork(`turn:${generation}`);
      if (pendingSendRef.current?.generation === generation) pendingSendRef.current = null;
    }
  }, [
    claimCompanionReply,
    ensureConversation,
    guideToConsent,
    refreshMessages,
    resolveActiveRunGeneration,
    resolveTurnContext,
    cancelRunInBackground,
    applyLateFollowups,
    feedNoteIntent,
  ]);

  /**
   * 停止本轮（2026-09-19）。
   *
   * 分工：**静音由调用方先做**（语音归气泡层持有，会话层不碰音频），这里只负责
   * 服务端取消 + 状态收尾。服务端是"202 首次取消 / 200 幂等"同形状，所以重复点
   * 停止是安全的；本地再挡一层只是为了不刷无谓请求。
   *
   * 收尾时重取一次消息：取消事务将已提交增量以 kind='cancelled' 留档，
   * 不发布完整回复的 final 事件，历史通过重取读回。
   */
  const cancel = useCallback(async (): Promise<boolean> => {
    const active = activeTurnRef.current;
    const pending = pendingSendRef.current;
    if (!active && !pending) return false;
    const explanationId = pending?.explanationId ?? active?.explanationId;
    // Invalidate locally before any await, including preflight and the in-flight turn request.
    // An explicit stop completes the send intent; it must not reopen a failed-send composer.
    if (pending) pending.cancelled = true;
    const stoppedGeneration = ++sendGenerationRef.current;
    replyWaitRef.current?.cancel();
    pendingSendRef.current = null;
    resetNoteAiWork();
    activeTurnRef.current = null;
    if (explanationId) interruptNoteExplanation(explanationId, "stopped");
    setFeedNoteAnchor(null);
    setFeedSelection(null);
    setFeedPrompt(null);
    setAutoSendRequestId(null);
    const partial = draftRef.current || (explanationId ? useNoteCompanionExplanations.getState().items.find(item => item.id === explanationId)?.text ?? "" : "");
    draftRef.current = "";
    setDraft(null);
    setLiveReply(null);
    setRichReply(null);
    setInterrupted(partial.trim() ? { text: partial, message: explanationId
      ? "已停止，未完成的内容没有写成批注。" : COMPANION_STOPPED_LINE } : null);
    setNodes(current => current.map(node => node.state === "running" || node.state === "waiting_confirmation"
      ? { ...node, state: "cancelled" as const } : node));
    setFailure(null);
    setStopNotice(explanationId && !partial.trim() ? "已停止，这次还没有生成解释。" : COMPANION_STOPPED_LINE);
    setPhase("ready");
    if (!active) return true; // postTurn cancels a late receipt; preflight has nothing to cancel.
    cancellingRef.current = true;
    setCancelling(true);
    try {
      const epoch = await requireWorkspaceEpoch();
      unwrapGatewayResult(await window.astella.companion.chat.cancelRun({
        meta: createRequestMeta(epoch), request: { version: 1, runId: active.runId, generation: active.generation },
      }));
      if (stoppedGeneration !== sendGenerationRef.current) return true;
      if (explanationId) reportNoteExplanationStopFailure(explanationId, null);
      await refreshMessages(active.conversationId, epoch).catch(() => null);
      setTracesRevision(value => value + 1);
      return true;
    } catch (error) {
      if (stoppedGeneration === sendGenerationRef.current) {
        const message = `停止请求暂未确认：${gatewayErrorMessage(error)}。${explanationId ? "本地已停止接收，不会把未完成内容写成批注。" : "本地已停止接收这轮回复。"}`;
        activeTurnRef.current = active;
        setFailure(message);
        setPhase("error");
        if (explanationId) reportNoteExplanationStopFailure(explanationId, message);
      }
      return false;
    } finally {
      cancellingRef.current = false;
      setCancelling(false);
    }
  }, [refreshMessages]);

  useEffect(() => {
    const onStop = (event: Event) => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id;
      if (id && (pendingSendRef.current?.explanationId === id || activeTurnRef.current?.explanationId === id)) void cancel();
      else if (id) {
        setFeedNoteAnchor(current => current?.explanationId === id ? null : current);
        setAutoSendRequestId(current => current === id ? null : current);
      }
    };
    window.addEventListener("astella:note-explanation-stop", onStop);
    return () => window.removeEventListener("astella:note-explanation-stop", onStop);
  }, [cancel]);

  const dismissStopNotice = useCallback(() => setStopNotice(null), []);

  const initiativeRunsRef = useRef(new Set<string>());
  const initiativeClaimsRef = useRef(new Set<string>());
  const initiativeInputVersionRef = useRef(0);
  const activeInitiativeRef = useRef<CompanionInitiativeDeliveryRefV1 | null>(null);
  useEffect(() => {
    const interrupt = () => {
      initiativeInputVersionRef.current += 1;
      const current = activeInitiativeRef.current;
      if (!current) return;
      activeInitiativeRef.current = null;
      ++sendGenerationRef.current; replyWaitRef.current?.cancel();
      stopCompanionSpeech(); setDraft(null); setPhase("ready"); activeTurnRef.current = null;
      void requireWorkspaceEpoch().then(epoch => window.astella.companion.chat.cancelRun({
        meta: createRequestMeta(epoch), request: { version: 1, runId: current.runId, generation: current.generation },
      })).catch(() => undefined);
    };
    window.addEventListener("astella:companion-user-input", interrupt);
    return () => window.removeEventListener("astella:companion-user-input", interrupt);
  }, []);

  /**
   * 她这一轮不在桌面的对话里时，把那句真话从共享历史里读回来。
   *
   * worker 按"观察那一刻的会话"建/选 run 的落点，而桌面的实时会话永远是 `inbox`
   * 那一条（`/companion/inbox/ensure`）。两者不一致时正文照样是真实存在的
   * （`companion_messages`，kind 可能是 `proactive` 或 `text`，`user_message_id` 为空），
   * 只是不在这个会话的最近窗口里——`refreshMessages` 看不见它，`claimCompanionReply`
   * 的事件流也不是这条会话的。以前这里直接放弃：气泡不出声，投递却被记成 `displayed`，
   * 于是这一句对谁都永久消失（dev 库实测 3 条这样"已展示"却没人见过）。
   *
   * 读的是连续历史（`/companion/history`，跨 `dialogue` + `inbox`），以投递里的
   * runId 为条件分页读取这一轮的全部已存发言。拿不到就返回 false：不发声、不回执，
   * 让它留在 `queued` 里等下一次机会。
   */
  const showInitiativeFromHistory = useCallback(async (
    delivery: CompanionInitiativeDeliveryRefV1,
    epoch: number,
    isCurrent: () => boolean,
  ): Promise<boolean> => {
    try {
      let before: string | undefined;
      let items: CompanionHistoryItemV1[] = [];
      const cursors = new Set<string>();
      do {
        const page = unwrapGatewayResult(await window.astella.companion.history.list({
          meta: createRequestMeta(epoch),
          // throughMessageId reads backwards and excludes utterances after the
          // anchor. A scoped run filter also avoids unrelated history displacing
          // this run's sentences from a fixed-size recent page.
          query: { limit: 100, runId: delivery.runId, ...(before ? { before } : {}) },
        }));
        if (!isCurrent()) return false;
        items = [...page.items, ...items];
        before = page.nextCursor ?? undefined;
        if (before && cursors.has(before)) return false;
        if (before) cursors.add(before);
      } while (before);
      const spoken = items.filter(item => item.role === "assistant" && item.runId === delivery.runId);
      if (!spoken.some(item => item.messageId === delivery.messageId)) return false;
      // 历史条目是 `CompanionHistoryItemV1`（没有 seq/id），与 `CompanionMessageV1`
      // 不是同一个形状，所以正文在这里按块取一次，不借 `companionMessageText`。
      const text = spoken
        .map(item => item.blocks.map(block => block.type === "text" ? block.text
          : block.type === "code" ? block.code : block.type === "citation" ? block.label : "").filter(Boolean).join("\n"))
        .filter(Boolean).join("\n\n").trim();
      if (!text) return false;
      setCurrentLiveReply({ messageId: delivery.messageId, text, webCitations: [], hasActionBlocks: false, proposalIds: [] });
      return true;
    } catch {
      return false;
    }
  }, [setCurrentLiveReply]);

  /**
   * 认领一次主动开口。返回**这句话有没有真的落到气泡上**：
   * - `true` = 屏幕上已经有了（这一次交出去的，或本会话早些时候已经交出去过）；
   * - `false` = 没接住（用户正在另一轮里、正文读不回来、这一轮被用户叫停……）。
   *
   * 回执（present→displayed）只许在 `true` 之后发。以前它无条件发，而这里有三条
   * 静默早退——"没露出来的气泡"也被记成 `displayed`，投影从此不再把这一句交给
   * 任何设备（`readProactiveCue` 只认 `queued`/`delivered`）。她说了、谁都没看见，
   * 账上却写着"已展示"：这正是 22 条投递里 9 条 `displayed` 而用户一次都没见过的形状。
   */
  const receiveInitiative = useCallback(async (delivery: CompanionInitiativeDeliveryRefV1): Promise<boolean> => {
    if (replyWaitRef.current || pendingSendRef.current) return false;
    // 同一轮已经交给过气泡：回执照发（投递行可能还没被认领成功），但不再重复出声。
    if (initiativeRunsRef.current.has(delivery.runId)) return true;
    // A concurrent claimant must not acknowledge a delivery still being loaded.
    if (initiativeClaimsRef.current.has(delivery.runId)) return false;
    initiativeClaimsRef.current.add(delivery.runId);
    try {
      const beforeGeneration = sendGenerationRef.current;
      const scopeRevision = useRoomStore.getState().workspaceScopeRevision;
      const inputVersion = initiativeInputVersionRef.current;
      const isCurrent = () => beforeGeneration === sendGenerationRef.current
        && inputVersion === initiativeInputVersionRef.current
        && scopeRevision === useRoomStore.getState().workspaceScopeRevision
        && !pendingSendRef.current && !replyWaitRef.current;
      const rememberShown = () => {
        initiativeRunsRef.current.add(delivery.runId);
        while (initiativeRunsRef.current.size > 40) initiativeRunsRef.current.delete(initiativeRunsRef.current.values().next().value!);
      };
      const epoch = await requireWorkspaceEpoch();
      const active = await ensureConversation();
      if (!isCurrent()) return false;
      if (active.id !== delivery.conversationId) {
        const shown = await showInitiativeFromHistory(delivery, epoch, isCurrent);
        if (shown) rememberShown();
        return shown;
      }
      const generation = ++sendGenerationRef.current;
      activeInitiativeRef.current = delivery;
      activeTurnRef.current = { runId: delivery.runId, generation: delivery.generation, conversationId: active.id, explanationId: null };
      // Optional participation never owns the user's composing/waiting state.
      // Published messages remain visible while its stream finishes in the background.
      try {
        const result = await claimCompanionReply({ conversationId: active.id, runId: delivery.runId,
          eventCursor: 0, epoch, generation, voiceOutput: true, background: true });
        if (generation !== sendGenerationRef.current) return false;
        if (result.kind === "reply") {
          setCurrentLiveReply({ messageId: result.message.id, text: runSpeechText(result.message),
            webCitations: [], hasActionBlocks: false, proposalIds: [] });
          rememberShown();
          await refreshMessages(active.id, epoch).catch(() => undefined);
          return true;
        }
        /**
         * 用户亲手叫停这一轮：不再补念（他已经在打断她了）。
         *
         * 但"露出过"要照实算：后台模式下 `assistant.utterance` 帧一到就写进气泡，
         * 用户是看着那半句才开始打字的——那一句确实到过屏幕上，就该记 `displayed`。
         * 一个字都没到（比如刚订阅上就被打断）才放开重来，不占着"已经念过"的名额。
         */
        if (result.kind === "cancelled") {
          const onScreen = utteranceIdsRef.current.has(delivery.runId);
          if (onScreen) rememberShown();
          return onScreen;
        }
        initiativeRunsRef.current.delete(delivery.runId);
        return false;
      } finally {
        if (generation === sendGenerationRef.current) { activeInitiativeRef.current = null; activeTurnRef.current = null; setPhase("ready"); setDraft(null); }
      }
    } finally { initiativeClaimsRef.current.delete(delivery.runId); }
  }, [ensureConversation, claimCompanionReply, refreshMessages, setCurrentLiveReply, showInitiativeFromHistory]);

  const dismissLiveReply = useCallback(() => setLiveReply(null), []);
  const dismissRichReply = useCallback(() => setRichReply(null), []);
  const dismissFeedSelection = useCallback(() => {
    setFeedSelection(null);
    setFeedPrompt(null);
    setAutoSendRequestId(null);
  }, []);
  const dismissFeedNoteAnchor = useCallback(() => setFeedNoteAnchor(null), []);
  const dismissFeedNoteIntent = useCallback(() => {
    setFeedNoteIntent(null);
    setAutoSendRequestId(null);
  }, []);
  const dismissNavChip = useCallback((id: string) => {
    setNavChips((current) => current.filter((chip) => chip.id !== id));
  }, []);

  const assistantCue = streamCue;

  const decideProposal = useCallback(async (proposalId: string, decision: "confirm" | "reject") => {
    const state = proposalStates[proposalId];
    if (!state || state.phase !== "ready" || state.deciding) return;
    setProposalStates((current) => ({ ...current, [proposalId]: { ...state, deciding: decision } }));
    try {
      const epoch = await requireWorkspaceEpoch();
      const result = unwrapGatewayResult(await window.astella.companion.chat.decideProposal({
        meta: createRequestMeta(epoch),
        request: {
          version: 1,
          proposalId,
          decision,
          idempotencyKey: crypto.randomUUID(),
          expectedPayloadSha256: state.proposal.payloadSha256,
        },
      }));
      setProposalStates((current) => {
        const existing = current[proposalId];
        if (!existing || existing.phase !== "ready") return current;
        return {
          ...current,
          [proposalId]: {
            ...existing,
            phase: "ready",
            proposal: { ...existing.proposal, status: result.status },
            deciding: undefined,
          },
        };
      });
      // 确认后服务端直接给出落点（decision.route）——同样走导航 chip，用户点「前往」。
      if (result.route) {
        const route = desktopRouteFromAgentRoute(result.route);
        pushNavChips([{
          id: `decision:${proposalId}`,
          summary: result.safeSummary ?? "已确认，可以前往。",
          route,
        }]);
      }
    } catch (error) {
      if (error instanceof RendererGatewayError && error.code === "conflict") {
        // 撞车意味着这件事**已经在别处处理过了**（或载荷变了），不是用户按错了。
        // 服务端是唯一真源：把快照取回来，卡自己变成终态留痕。
        // 原来这里只挂一句 `gatewayErrorMessage`，而那句子是给学习流程写的
        // 「这条学习状态已经发生变化，请先同步后再继续。」—— 一张已经作废的卡挂着一句
        // 另一个产品的报错，状态也不刷新（方案 35 F2）。
        await loadProposalSnapshots([proposalId]);
        return;
      }
      setProposalStates((current) => {
        const existing = current[proposalId];
        if (!existing || existing.phase !== "ready") return current;
        return { ...current, [proposalId]: { ...existing, deciding: undefined, error: gatewayErrorMessage(error) } };
      });
    }
  }, [loadProposalSnapshots, proposalStates, pushNavChips]);

  const goToRoute = useCallback(async (route: DesktopRouteV1) => {
    const scopeRevision = useRoomStore.getState().workspaceScopeRevision;
    const resolveResponse = await window.astella.navigation.resolve({ meta: createRequestMeta(), route });
    const resolved = unwrapGatewayResult(resolveResponse);
    if (resolved.current.scope !== "workspace") throw new Error("navigation did not resolve to the current workspace");
    if (useRoomStore.getState().workspaceScopeRevision !== scopeRevision) throw new Error("工作空间已切换，请在当前空间重新操作。");
    unwrapGatewayResult(await window.astella.navigation.go({
      meta: createRequestMeta(resolved.current.workspaceEpoch),
      route: resolved.current.route,
      entryKind: "user",
    }));
    if (useRoomStore.getState().workspaceScopeRevision !== scopeRevision) throw new Error("工作空间已切换，请在当前空间重新操作。");
    // 历史栈记完还要真正换页（applyRouteToRoom）——否则按钮点了没反应。
    const applied = await applyRouteToRoom(resolved.current.route);
    if (!applied) throw new Error("这个落点在桌面端还没有对应的页面");
    if (useRoomStore.getState().workspaceScopeRevision !== scopeRevision) throw new Error("工作空间已切换，请在当前空间重新操作。");
    // 会话内授权升级（2026-09-19 用户实测"第二次就不自动跳了"）：用户亲手点过
    // 「前往」的落点类型，本轮会话里后续同类落点直接自动跳——用户已经用行动
    // 授过权，再让他一枚一枚点同款按钮就是把确认当打卡。会话级记忆，不持久化；
    // 服务端 permissionLevel=full 的 autoExecute 仍然照走。
    manuallyNavigatedKindsRef.current.add(resolved.current.route.kind);
  }, []);

  /**
   * 思考的心跳（2026-10-13）：服务端按块下发（攒够 800 字或 350ms 才落一次库），
   * 收到就画会一跳一跳。这里每 50ms 只往前露一小步，界面才是连续铺字。
   *
   * 只在"这一轮还在路上、还有没露完的思考"时挂着；正文一露头或本轮结束就停，
   * 不给一个已经没人看的东西继续费心跳。
   */
  useEffect(() => {
    if (phase !== "sending" || !companionThinkingPending(thinkingView)) return;
    const timer = window.setInterval(() => {
      setThinkingView((current) => (current === null ? null : revealCompanionThinking(current)));
    }, 50);
    return () => window.clearInterval(timer);
  }, [phase, thinkingView]);

  // ── 预授权跳转（2026-09-19 对齐权限分级原设计） ────────────────────────
  // 服务端在 permissionLevel=full 下把读类路由结果标成 autoExecute：授权是用户
  // 事先给的，客户端直接执行，不再要求点「前往」。chip 仍保留（留痕 + 可关掉）。
  // 只执行一次：以 chip id（= 事件 seq）记账，重挂载/轮询重放都不会重复跳。
  // 连续多个预授权路由只执行最后一个（模型一回合内连开两页时，以最终落点为准）。
  useEffect(() => {
    const pending = navChips.filter(
      (chip) => chip.route
        && !autoExecutedRef.current.has(chip.id)
        && (chip.autoExecute || manuallyNavigatedKindsRef.current.has(chip.route.kind)),
    );
    if (pending.length === 0) return;
    for (const chip of pending) autoExecutedRef.current.add(chip.id);
    // 执行成功的 chip 就地消失（2026-09-19 用户反馈）：跳都跳过去了，提示还留在
    // 抽屉里就是"这条已经办完了"和"这条还在等处理"自相矛盾。失败保留（用户还能
    // 手动点）。只执行最后一个（一回合连开两页时以最终落点为准），但全部移除。
    const executedIds = new Set(pending.map((chip) => chip.id));
    const landed = pending[pending.length - 1].route!;
    void goToRoute(landed)
      .then(() => {
        setNavChips((current) => current.filter((chip) => !executedIds.has(chip.id)));
        setAutoNavigatedRoutes((current) => new Set(current).add(JSON.stringify(landed)));
      })
      .catch(() => undefined);
  }, [navChips, goToRoute]);

  // 展示层看到的是合并后的完整时间线（老页在前，最近窗口在后）。
  const mergedMessages = useMemo<CompanionMessageV1[]>(() => {
    const seen = new Set(olderMessages.map((item) => item.id));
    const newer = messages.filter((item) => !seen.has(item.id));
    return [...olderMessages, ...newer].sort((left, right) => left.seq - right.seq);
  }, [olderMessages, messages]);

  /**
   * 还等着用户点头的提案数（审计 F4）。手记入口靠它挂角标：确认纸签被关掉、
   * 重启或换空间之后，身边至少有一个地方一直知道"还有一件事等你点头"。
   * 和手记「待确认」页签共用同一条判据（journalProposalNeedsDecision），不另立一套。
   */
  const pendingProposalCount = useMemo(
    () => Object.values(proposalStates).filter((state) => journalProposalNeedsDecision(state)).length,
    [proposalStates],
  );

  const value = useMemo<CompanionChatSession>(() => ({
    phase,
    failure,
    conversationId: conversation?.id ?? null,
    receiveInitiative,
    messages: mergedMessages,
    historyHasMore,
    historyLoadingOlder,
    historyOlderError,
    historyRevision,
    loadOlderMessages,
    fetchAllMessages,
    liveReply,
    richReply,
    autoNavigatedRoutes,
    draft,
    thinking: companionThinkingText(thinkingView),
    blockedByRun,
    stopBlockedTurn,
    interrupted,
    nodes: reconcileCompanionAgentNodes(nodes, runTraces.find(trace => trace.summary.runId === processRunId)?.nodes ?? []),
    processRunId,
    runTraces,
    feedSelection,
    feedPrompt,
    feedNoteAnchor,
    feedDiaryAnchor,
    feedNoteIntent,
    autoSendRequestId,
    navChips,
    proposalStates,
    pendingProposalCount,
    mode,
    companionName,
    setCompanionName,
    assistantCue,
    send,
    cancel,
    cancelling,
    stopNotice,
    dismissStopNotice,
    dismissLiveReply,
    dismissRichReply,
    dismissFeedSelection,
    dismissFeedNoteAnchor,
    dismissFeedNoteIntent,
    setMode,
    dismissNavChip,
    decideProposal,
    retryProposal,
    goToRoute,
  }), [
    assistantCue,
    cancel,
    cancelling,
    companionName,
    conversation,
    decideProposal,
    retryProposal,
    dismissLiveReply,
    receiveInitiative,
    dismissRichReply,
    dismissFeedSelection,
    dismissFeedNoteAnchor,
    dismissFeedNoteIntent,
    dismissNavChip,
    dismissStopNotice,
    draft,
    thinkingView,
    blockedByRun,
    stopBlockedTurn,
    failure,
    feedSelection,
    feedPrompt,
    feedNoteAnchor,
    feedNoteIntent,
    autoSendRequestId,
    fetchAllMessages,
    goToRoute,
    historyHasMore,
    historyLoadingOlder,
    historyOlderError,
    historyRevision,
    interrupted,
    loadOlderMessages,
    mergedMessages,
    mode,
    liveReply,
    richReply,
    autoNavigatedRoutes,
    navChips,
    nodes,
    processRunId,
    phase,
    proposalStates,
    pendingProposalCount,
    runTraces,
    send,
    stopNotice,
  ]);

  return <CompanionChatContext.Provider value={value}>{children}</CompanionChatContext.Provider>;
}
