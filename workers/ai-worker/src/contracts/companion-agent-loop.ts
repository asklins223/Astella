import type { AgentTurnRequest, ChatMessage, CompanionAgentToolExecutionConstraints } from "@astella/shared";
import type { AgentTurnInterpretationV1, AgentVoicePreferenceWriteStatusV1 } from "@astella/shared/agent-contracts";
import type { AIProvider } from "../lib/ai-provider.ts";
import type { CompanionDialogueHandlerContext, ReadContext } from "../handlers/turn/companion-dialogue-store.ts";
import type { CompanionContextReceipts } from "../handlers/context/companion-context-receipts.ts";
import type { FoldedReplay, CompactionCooldownPorts } from "../handlers/context/companion-compaction.ts";
import type { CompactionTraceRecorder } from "../handlers/context/companion-context-handoff.ts";
type AgentMessage = AgentTurnRequest["messages"][number];

/** Inputs shared by the dialogue handler and the agent loop. */
export interface CompanionAgentLoopArgs {
  ctx: CompanionDialogueHandlerContext;
  read: ReadContext;
  provider: AIProvider;
  /**
   * 跨模型兜底 provider（方案 29 §9.6）。
   *
   * 主模型（tokenrhythm/qwen3.8-flash）的退化窗口里，同一个模型再问一遍仍会
   * 退化——实测四条连续轮次落库 `现在是`(3)/`今天`(2)/`最近`(2)/`你`(1)；
   * 唯一有效的是**换模型**。未配置时退化闸整个跳过。
   */
  fallbackProvider?: AIProvider;
  /**
   * 用户配置的活跃度（抱怨 #2「配置没生效」）。它决定退化闸的字数线：
   * "安静"档要的就是三个字的答案，按活跃档的 6 字拦等于每轮白烧一次重跑，
   * 还会用更啰嗦的档位覆盖用户自己的设定。缺省（没有账号人格覆盖）按活跃档。
   */
  activeness?: "quiet" | "moderate" | "active" | null;
  /**
   * 服务端判定的执行约束（图片外发授权与当前轮是否允许读取笔记库）。
   *
   * 同一份约束管两件事：① 受政策管的工具**不下发**（看不见才不会答应之后看不了）；
   * ② 执行前独立复核一次——工具名是模型给的，下发面拦不住一个硬要调的编造。
   * 由调用方从治理上下文取，绝不信模型在参数里自述的授权。
   */
  toolConstraints: CompanionAgentToolExecutionConstraints;
  baseMessages: ChatMessage[];
  /**
   * The delivery shape resolved for this turn (how many separate messages the
   * request asked for), so every step writes the reply in that shape from the
   * start. Delivery still splits on the model's own paragraph boundaries; this
   * only tells it that the boundaries matter.
   */
  replyShape?: { messages: number } | null;
  /**
   * The conversation model itself can see (declared `vision` on its profile).
   * When true, this turn's attached pictures are sent with the request so the
   * model looks at them instead of answering from their file names. Resolved by
   * the caller from governance, never guessed inside the loop.
   */
  turnImagesSentDirectly?: boolean;
  /** Hash/scope-verified committed deltas already shown in this same run. */
  initialVisibleText?: string;
  /** Commit complete, validated visible step text before pausing or resuming. */
  onVisibleCheckpoint?: (modelText: string) => Promise<boolean>;
  /** Source identities from this run's committed snapshot, never a fresh read. */
  historyForCompaction?: import("../handlers/context/companion-history-pressure-compaction.ts").HistoryCompactionSource;
  compactionCheckpoints?: readonly import("../handlers/context/companion-context-handoff.ts").CompactionTraceV1[];
  persistCompactionTraces?: () => Promise<void>;
  contextReceipts?: CompanionContextReceipts;
  /** 把一次请求的回放尾部折成「已被校验摘要盖住」的形态（44 §5.2）。只有组装回放
   * 的那层知道每条尾部消息的来源 seq 与当前摘要覆盖到哪；返回 null 表示无可折内容。 */
  replayFold?: (messages: readonly AgentMessage[]) => FoldedReplay | null;
  /** 压缩失败的跨轮冷却（44 §5.4）：同一份失败输入不每轮重折。 */
  compactionCooldown?: CompactionCooldownPorts;
  /**
   * 折叠轨迹收集器（44 §3.3）。
   *
   * 交接快照在 agent loop **之前**就提交了，而压缩发生在 loop 里——没有这份轨迹，
   * 审计就答不出「实际发出去的是什么」。runtime 只管折、只管记；写进快照由回合结束
   * 那一侧做（两件事的失败后果不一样）。
   */
  compactionTrace?: CompactionTraceRecorder; // 装配回执与预算读数（44 §3.3）
  expiresAt: string;
  continuationProposalId?: string;
  /**
   * 流式下发回调（每一步）：provider 的原始增量在这里交给对话 handler 做
   * 净化/校验/落库；返回 false 表示本轮已终止（校验失败或 run 已失效）。
   */
  onUtterancePublished?: (messageId: string, text: string, rawText: string) => Promise<void>;
  onProviderDelta?: (delta: string) => Promise<boolean>;
  /**
   * 思考增量出口（2026-10-13）：模型这一轮真正在想什么，逐段交给对话 handler 下发。
   *
   * 与 `onProviderDelta` 是**两条独立的通道**：这一路不净化、不校验、不落正文，
   * 因此也永远进不了朗读。写失败只让思考显示自己停下，绝不影响这一轮回复。
   */
  onReasoningDelta?: (text: string) => void;
  flushThinking?: () => Promise<void>;
  /** Structured semantic direction is resolved before the speculative first step is released. */
  onTurnInterpretation?: (interpretation: AgentTurnInterpretationV1) =>
    void | AgentVoicePreferenceWriteStatusV1 | Promise<void | AgentVoicePreferenceWriteStatusV1>;
  /**
   * handler 进入时刻（job 超时计时起点）。缺省回落到 loop 起点——测试等
   * 无 job 包装的调用方不需要它。用于把 run 预算夹在 handler abort 之内。
   */
  handlerStartedAtMs?: number;
  /**
   * L1 影子路由的 embedding 出口（治理门之后那一层；失败返回 null = 弃权）。
   * 只有 `COMPANION_RELEASE_ROUTER=shadow` 时 handler 才提供；缺省 = 不计算影子。
   */
  embedText?: (text: string) => Promise<readonly number[] | null>;
  /**
   * L1 放行路由端口（`COMPANION_RELEASE_ROUTER=enforce` 时才提供）。
   * 只影响投机首步的**放行时机**，不改变 L2 解释、工具面与后续步骤。
   */
  releaseRouter?: import("../handlers/agent/companion-release-router.ts").CompanionReleaseRouterPort;
}
