import { projectCompanionHistory, type HistorySummaryCoverage } from "./companion-history-projection.ts";
import { recordTurnCompactionTrace } from "./companion-compaction-trace.ts";
/** Durable context handoffs and summary-backed replay. Recent exchanges and
 * all uncovered history stay complete; only verified summary coverage can
 * replace older exchanges. Token pressure belongs to the full request governor. */

import type { ChatMessage, ProviderCapability, ProviderReasoningHandle } from "@astella/shared";
import type { AgentMemoryContextSourceV1 } from "@astella/shared/agent-contracts";
import { canonicalJsonV1, sha256Utf8V1 } from "@astella/shared/content-hash";
import { estimateTextTokens, resolveContextBudget } from "@astella/agent-core";
import type { CompanionMemoryDirectoryEntry } from "../memory/companion-memory-vector.ts";
import { REGISTERED_FALLBACK_CAPABILITY } from "../../lib/context-governor.ts";


/** Database page width only. Replay reads through uncovered history; this
 * value never defines a model context boundary. */
export const REPLAY_HISTORY_READ_ROWS = 200;

/** Route-declared pressure target for replay telemetry. The full request
 * governor measures policy, history, reasoning and tools together; this value
 * never authorizes dropping an uncovered message. */
export function resolveRouteInputTokens(
  capability: ProviderCapability | null | undefined,
  requestedOutputTokens?: number | null,
): number {
  const declared = capability && Number.isSafeInteger(capability.contextWindowTokens)
    && capability.contextWindowTokens > 0
    ? capability
    : null;
  const budget = resolveContextBudget({
    ...(declared ? { capability: declared } : { registeredCapability: REGISTERED_FALLBACK_CAPABILITY }),
    requestedOutputTokens: requestedOutputTokens ?? null,
  });
  return budget.triggerTokens;
}


export interface CompanionRecentHistoryMessage {
  role: "user" | "assistant";
  text: string;
  /** Source message sequence; retained internally to bind summaries to the visible tail. */
  seq?: string;
  /** Server creation instant of this utterance; not the time of a narrated event. */
  createdAt?: string | null;
  /** State of the reply to this user message, including superseded additions. */
  replyStatus?: string | null;
  /**
   * 产出这条 assistant 消息时的 provider reasoning item（0435 起随消息落库）。
   *
   * 网关在思考模式下把"以 assistant 收尾"的请求当成续写，要求交回那条的
   * `reasoning_text`；主动参与轮每一轮都是这个形状，所以历史必须把它带回来。
   * 只有 assistant 消息才有值。
   */
  reasoning?: ProviderReasoningHandle[] | null;
}

/** 回放窗口的取舍容量：本次路由模型声明的输入 token（`resolveRouteInputTokens`）。 */
export interface CompanionReplayWindowCapacity {
  maxInputTokens: number;
  /** 计量口径；缺省用 agent-core 的保守字节口径，与摘要器共用同一份。 */
  countTokens?: (text: string) => number;
}

/**
 * 交接结果里的那一笔：按声明预算带走了几条、少了几条。
 *
 * 「上一轮她其实没看到自己的那句话」以前只能靠反推 seq 差值猜，现在由选取当场算出来，
 * 落进快照与渲染出的账本块——没有这一笔，少带和没带是同一个读数。
 */
export interface CompanionReplayWindowReceiptV1 {
  version: 1;
  /** 取舍是按哪个声明容量做的；读数本身（窗口多大由模型档案声明）。 */
  capacityTokens: number;
  usedTokens: number;
  takenCount: number;
  omittedCount: number;
  /**
   * 没带走的那一段里**最新**的一条 seq（它和更早的都没带）；全带上了就是 null。
   * 与摘要的 `uncovered` 同一个词：这一段由 `companion_observe（action=history）` 按 seq 取回。
   */
  uncoveredThroughSeq: string | null;
  /**
   * 整条比本轮窗口还长、这一轮带不走的那几条（正文**不剪**，只按 seq 指回原消息）。
   *
   * 没有这一笔时，读数上"少带了几条"和"一条超长把整段挤光"是同一个形状：
   * 她从最新往回装，第一条塞不下就停，于是刚写完一篇长讲解之后那几轮，
   * 她连自己上一句和用户的前几句都看不见（实测带回 0 条、2,048 tok 全空着）。
   */
  oversizedSkipped?: CompanionOversizedReplayEntryV1[];
  /** Whole older exchanges represented by a verified summary; originals remain retrievable. */
  summaryFold?: { fromSeq: string; throughSeq: string; sourceSha256: string };
  /**
   * 整条装得下整个窗口、但装不下**本轮剩余预算**的那些：跳过它们继续往前捡。
   *
   * 回放因此不再是一段连续的尾巴，所以每一条都得点名——不点名的话，"她上一句说了什么"
   * 与"那条从没说过"在账本上又是同一个读数。
   */
  skippedToFit?: CompanionOversizedReplayEntryV1[];
}

export interface CompanionOversizedReplayEntryV1 {
  seq: string | null;
  role: "user" | "assistant";
  /** 这一条自己的 token 读数（按同一条计量口径）。 */
  tokens: number;
}

export interface CompanionReplayWindowSelection {
  messages: CompanionRecentHistoryMessage[];
  receipt: CompanionReplayWindowReceiptV1;
}

export interface CompanionContextHandoffSnapshotV1 {
  version: 1;
  runId: string;
  conversationId: string;
  watermark: {
    throughMessageSeq: string;
    throughEventSeq: string;
    historyStartSeq: string;
    clippedMessageCount: number;
  };
  currentRequest: { messageId: string | null; messageSeq: string; contentSha256: string; source?: "user" | "host_observation" };
  authorization: {
    contextGrantId: string | null;
    permissionLevel: string | null;
    permissionSnapshot: unknown;
  };
  runState: { status: string; cancelRequestedAt: string | null };
  pageSnapshotSha256: string | null;
  summaryCoverage: {
    fromSeq: string | null;
    throughSeq: string | null;
    sourceSha256: string | null;
  } | null;
  historyTail: Array<{ seq: string; role: "user" | "assistant"; text: string; contentSha256: string }>;
  /** 回放窗口这一轮实际带走/少带了几条；按条数窗口取舍的那几轮没有这一笔。 */
  replayWindow?: CompanionReplayWindowReceiptV1;
  actionLedger: {
    completed: Array<{ receiptId: string; toolCallId: string; name: string; safeSummary: string | null }>;
    unresolved: Array<{ receiptId: string; toolCallId: string; name: string; status: string; safeSummary: string | null }>;
    notCompleted: Array<{ receiptId: string; toolCallId: string; name: string; status: string; safeSummary: string | null }>;
    /** 按摘要覆盖线收边走掉的条数；调用方没算时省略这一笔。 */
    omitted?: { completed: number; unresolved: number; notCompleted: number };
  };
  proposals: Array<{
    id: string;
    status: string;
    decision: string | null;
    title: string;
    targetSummary: string;
    resultSafeSummary: string | null;
    expiresAt: string | null;
  }>;
  memoryRefs: Array<{ memoryId: string; kind: string; content: string }>;
  /** Absent only on handoff snapshots written before the active directory existed. */
  memoryDirectory?: CompanionMemoryDirectoryEntry[];
  /** Only sources actually admitted to the prompt, with their immutable version. */
  memorySourceVersions?: AgentMemoryContextSourceV1[];
  modelMessages: ChatMessage[];
  /**
   * 这一轮发生过的折叠（方案 44 §3.3／§5.3）。
   *
   * `modelMessages` 保持**折叠前**的完整上下文：恢复时多给上下文永远比少给安全。
   * Logs contain only ranges and budget metadata. This private snapshot can
   * also hold a complete compressed-message checkpoint, persisted before retry
   * and reusable only for the same run and identical full request.
   */
  compactions?: CompactionTraceV1[];
}

export interface CompactionTraceV1 {
  /** Private complete-request checkpoint; never copied into ordinary logs. */
  checkpoint?: import("./companion-compaction-checkpoint.ts").CompanionCompactionCheckpoint;
  sourceKind?: "active_tool_rounds" | "history_exchanges";
  foldedFromSeq: string;
  foldedThroughSeq: string;
  foldedMessageCount: number;
  /** 顶替它的那份摘要的来源哈希：覆盖本身也要能被核对。 */
  summarySourceSha256: string;
  /** 折叠之后回放里剩下的最早 seq；null 表示尾部被折空。 */
  remainingFromSeq: string | null;
  /** 摘要在折叠边界之外还没盖住的更早区间。 */
  uncoveredBeforeSeq: string | null;
  modelId: string | null;
  inputTokens: number | null;
  triggerTokens: number | null;
  hardInputTokens: number | null;
  reason: string | null;
  at: string;
}

export interface CompanionContextHandoffInputV1 {
  runId: string;
  conversationId: string;
  throughMessageSeq: string;
  throughEventSeq: string;
  historyStartSeq: string;
  clippedMessageCount: number;
  currentRequest: { messageId: string | null; messageSeq: string; text: string; source?: "user" | "host_observation" };
  contextGrantId: string | null;
  permissionLevel: string | null;
  permissionSnapshot: unknown;
  runStatus: string;
  cancelRequestedAt: string | null;
  pageContext: unknown;
  summaryCoverage: {
    fromSeq: string | null;
    throughSeq: string | null;
    sourceSha256: string | null;
  } | null;
  historyTail: Array<{ seq: string; role: "user" | "assistant"; text: string }>;
  /** `selectCompanionReplayWindow` 当场算出的那一笔；调用方没按声明预算取舍时省略。 */
  replayWindow?: CompanionReplayWindowReceiptV1;
  actionLedger: Array<{
    receiptId: string;
    toolCallId: string;
    name: string;
    status: string;
    safeSummary: string | null;
  }>;
  /**
   * 按摘要覆盖线收边走掉的那几类条数（`readCompanionActionLedger` 算出来的）。
   * 渲染出的账本块要把它带出去：没有这一笔，「折进摘要了」与「从没发生过」又是同一个读数。
   */
  actionLedgerOmitted?: { completed: number; unresolved: number; notCompleted: number } | null;
  proposals: CompanionContextHandoffSnapshotV1["proposals"];
  memoryRefs: CompanionContextHandoffSnapshotV1["memoryRefs"];
  memoryDirectory?: CompanionMemoryDirectoryEntry[];
  memorySourceVersions?: AgentMemoryContextSourceV1[];
  modelMessages: ChatMessage[];
}

/** Immutable, source-bound record of the exact context handed to one dialogue run. */
export function buildCompanionContextHandoffSnapshotV1(
  input: CompanionContextHandoffInputV1,
): CompanionContextHandoffSnapshotV1 {
  const historyTail = input.historyTail.map((message) => ({
    ...message,
    contentSha256: sha256Utf8V1(message.text),
  }));
  const actions = input.actionLedger.map((action) => ({
    ...action,
    safeSummary: action.safeSummary ?? null,
  }));
  return {
    version: 1,
    runId: input.runId,
    conversationId: input.conversationId,
    watermark: {
      throughMessageSeq: input.throughMessageSeq,
      throughEventSeq: input.throughEventSeq,
      historyStartSeq: input.historyStartSeq,
      clippedMessageCount: Math.max(0, Math.trunc(input.clippedMessageCount)),
    },
    currentRequest: {
      messageId: input.currentRequest.messageId,
      messageSeq: input.currentRequest.messageSeq,
      contentSha256: sha256Utf8V1(input.currentRequest.text),
      ...(input.currentRequest.source ? { source: input.currentRequest.source } : {}),
    },
    authorization: {
      contextGrantId: input.contextGrantId,
      permissionLevel: input.permissionLevel,
      permissionSnapshot: input.permissionSnapshot,
    },
    runState: { status: input.runStatus, cancelRequestedAt: input.cancelRequestedAt },
    pageSnapshotSha256: input.pageContext == null
      ? null
      : sha256Utf8V1(canonicalJsonV1(input.pageContext)),
    summaryCoverage: input.summaryCoverage,
    historyTail,
    ...(input.replayWindow ? { replayWindow: { ...input.replayWindow } } : {}),
    actionLedger: {
      completed: actions
        .filter((action) => action.status === "succeeded")
        .map(({ receiptId, toolCallId, name, safeSummary }) => ({ receiptId, toolCallId, name, safeSummary })),
      // unresolved = 已经开始或可能已经开始，结果待核对。
      unresolved: actions
        .filter((action) => ["requested", "executing", "waiting_confirmation", "outcome_unknown"].includes(action.status))
        .map(({ receiptId, toolCallId, name, status, safeSummary }) => ({ receiptId, toolCallId, name, status, safeSummary })),
      // notCompleted = 确实**没有**产生业务结果。
      //
      // not_executed 与 unavailable 在这里，和 failed/blocked/expired 是同一类：
      // 0349 把它们加进词表之后曾被漏掉（§4.7.2「未决调用的 ledger 状态」要的是
      // **全部**未决状态），漏掉的后果是上一轮「从未开始」「这一轮用不了」的
      // 调用在下一轮快照里整条消失——伴星于是以为那件事从没被要求过。
      notCompleted: actions
        .filter((action) => ["failed", "blocked", "expired", "not_executed", "unavailable"].includes(action.status))
        .map(({ receiptId, toolCallId, name, status, safeSummary }) => ({ receiptId, toolCallId, name, status, safeSummary })),
      ...(input.actionLedgerOmitted ? { omitted: { ...input.actionLedgerOmitted } } : {}),
    },
    proposals: input.proposals.map((proposal) => ({
      ...proposal,
      title: proposal.title,
      targetSummary: proposal.targetSummary,
      resultSafeSummary: proposal.resultSafeSummary ?? null,
    })),
    memoryRefs: input.memoryRefs.map((memory) => ({
      memoryId: memory.memoryId,
      kind: memory.kind,
      content: memory.content,
    })),
    // 目录整条记录：上一轮交给她的是哪几条、标题怎么说，快照必须说同一份。
    // 这里再按条数与字段宽切一次，下一轮从快照读回的 `read.memoryDirectory` 就成了
    // 半句标题；入选与条数由装配侧按声明预算整条取舍（companion-context-orchestrator）。
    memoryDirectory: (input.memoryDirectory ?? []).map((entry) => ({
      memoryId: entry.memoryId,
      kind: entry.kind,
      title: entry.title,
      appliesWhen: entry.appliesWhen ?? null,
      validFrom: entry.validFrom ?? null,
      validUntil: entry.validUntil ?? null,
      revision: Math.max(1, Math.trunc(entry.revision)),
      epistemicStatus: entry.epistemicStatus ?? null,
    })),
    ...(input.memorySourceVersions !== undefined
      ? { memorySourceVersions: input.memorySourceVersions.map(source => ({ ...source })) }
      : {}),
    // reasoning 随消息一起留在快照里：重试/续跑要原样重放发出过的请求，
    // 剥掉它等于让"以 assistant 收尾"的那一轮在重试时必然 400（0435）。
    modelMessages: input.modelMessages.map(({ role, content, reasoning, hostObservation, phase }) => ({
      role, content, ...(reasoning && reasoning.length > 0 ? { reasoning } : {}),
      ...(hostObservation ? { hostObservation: true as const } : {}),
      ...(phase ? { phase } : {}),
    })),
  };
}

/** The block carries ledger facts only; the user's request remains a user-role message. */
export function renderCompanionContextHandoff(snapshot: CompanionContextHandoffSnapshotV1): string {
  const pendingProposals = snapshot.proposals
    .filter((proposal) => proposal.status === "pending" || proposal.status === "executing");
  const block = {
    version: snapshot.version,
    throughMessageSeq: snapshot.watermark.throughMessageSeq,
    historyStartSeq: snapshot.watermark.historyStartSeq,
    clippedMessageCount: snapshot.watermark.clippedMessageCount,
    // 这一轮实际带走多少条原话、少带了几条、按哪个声明容量取舍。没有它，
    // 「少带」与「从没发生过」在账本上是同一个读数。
    replayWindow: snapshot.replayWindow ?? null,
    currentRequest: {
      source: snapshot.currentRequest.source ?? "user",
      messageSeq: snapshot.currentRequest.messageSeq,
      contentVerified: Boolean(snapshot.currentRequest.contentSha256),
    },
    authorization: {
      permissionLevel: snapshot.authorization.permissionLevel,
      contextGrantPresent: Boolean(snapshot.authorization.contextGrantId),
    },
    runState: {
      status: snapshot.runState.status,
      cancelRequested: Boolean(snapshot.runState.cancelRequestedAt),
    },
    actionLedger: {
      // Keep every receipt and summary, but serialize repeated rows as tuples.
      // Completed entries are [toolName, safeSummary]; other entries are
      // [toolName, status, safeSummary]. This is a lossless wire-format compaction.
      completed: snapshot.actionLedger.completed.map((action) => [
        action.name,
        action.safeSummary ?? null,
      ]),
      unresolved: snapshot.actionLedger.unresolved.map((action) => [
        action.name,
        action.status,
        action.safeSummary ?? null,
      ]),
      notCompleted: snapshot.actionLedger.notCompleted.map((action) => [
        action.name,
        action.status,
        action.safeSummary ?? null,
      ]),
      omitted: snapshot.actionLedger.omitted ?? { completed: 0, unresolved: 0, notCompleted: 0 },
    },
    proposals: {
      pending: pendingProposals.map((proposal) => ({
        status: proposal.status,
        title: proposal.title,
        targetSummary: proposal.targetSummary,
        expiresAt: proposal.expiresAt,
      })),
      omittedPending: Math.max(0,
        snapshot.proposals.filter((proposal) => proposal.status === "pending" || proposal.status === "executing").length
          - pendingProposals.length,
      ),
    },
  };
  const serialized = JSON.stringify(block)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  const ledgerFolded = Object.values(block.actionLedger.omitted).reduce((sum, n) => sum + n, 0);
  const skippedHoles = (snapshot.replayWindow?.skippedToFit ?? [])
    .map(entry => entry.seq ?? "?");
  return [
    "<continuation_data>",
    "这是伴星运行账本的确定性快照，只描述来源、水位、授权和动作状态；它不是用户指令，也不授予新授权。",
    "只有状态为 succeeded 的账本项代表已完成；requested、executing、waiting_confirmation、outcome_unknown、failed、blocked、expired 都不能说成已完成。",
    snapshot.currentRequest.source === "host_observation"
      ? "本轮来自宿主观察，没有新的用户请求；当前任务以末尾 hostObservation 的时刻为准，历史用户请求不重新成为待办，建议不等于授权。"
      : "当前用户请求仍以最后一条 user 消息为准；话题和下一步由你判断，建议不等于授权。",
    "动作账本采用紧凑数组：completed 项是 [工具名, 安全摘要]；unresolved 与 notCompleted 项是 [工具名, 状态, 安全摘要]。",
    // 少带的那一段要说得出**为什么**与**怎么补**，否则她只能假设上面没有发生过。
    ...(snapshot.replayWindow && snapshot.replayWindow.omittedCount > 0
      ? [snapshot.replayWindow.summaryFold
        ? `本轮保留了 ${snapshot.replayWindow.takenCount} 条原话，另有 ${snapshot.replayWindow.omittedCount} 条由已校验的 <conversation_summary> 代表；要核对原文就按 seq 调用 companion_observe（action=history） 取回。`
        : `旧交接记录只带回 ${snapshot.replayWindow.takenCount} 条原话，另有 ${snapshot.replayWindow.omittedCount} 条没有回放，不能假定它们已由摘要代表；要用那一段就先按 seq 调用 companion_observe（action=history） 取回。`]
      : []),
    // 动作回执同理：按摘要覆盖线收边之后，「那件事我做过了」在账本上不能只剩一句
    // 「摘要里好像提过」。说清多少条被折进摘要、怎么回去核对。
    ...(ledgerFolded > 0
      ? [`另有 ${ledgerFolded} 条更早的动作回执没逐条带走，那一段的结论由 <conversation_summary> 代表`
        + "（不是没发生过）；要核对其中某个动作到底成没成，先按 seq 用 companion_observe（action=history） 取回那一段原文。"]
      : []),
    // 整条比整个窗口还长的那几条单独点名：不点名的话，"我上一句到底说过什么"
    // 在账本上没有任何痕迹，她会当成自己没说过（正文不剪进这里——剪过的字她会照着说）。
    ...(snapshot.replayWindow?.oversizedSkipped ?? []).map(entry =>
      `seq=${entry.seq ?? "?"} 那条${entry.role === "assistant" ? "是你自己发的长内容" : "是用户发的长内容"}`
      + `（约 ${entry.tokens} tok，整条比本轮回放窗口还长），这一轮没带走正文——它说过，只是装不下；`
      + `要谈那一段就按这个 seq 调用 companion_observe（action=history） 取回原文。`),
    // 窗口内部的洞：一条汇总 + seq 清单在 JSON 里，**不逐条成句**。
    // 逐条点名是第一版的写法，真窗口实测：22 条带走、52 条洞，交接块从 7,152 涨到
    // 10,380 字符——把收边换成了另一种膨胀。洞本身必须说（不然她会把前后两条当成挨着
    // 说的），但说一次就够。
    ...(skippedHoles.length > 0
      ? [`回放窗口内部跳过了 ${skippedHoles.length} 条（seq 见 replayWindow.skippedToFit，`
        + `最新一条是 ${skippedHoles.at(-1)}）：那些条说过，只是这一轮的预算装不下它们；`
        + "要谈那一段就按对应 seq 用 companion_observe（action=history） 取回，别把前后两条当成挨着说的。"]
      : []),
    serialized,
    "</continuation_data>",
  ].join("\n");
}

/** Prepare the complete history projection. Capacity is telemetry here: the
 * full request governor owns pressure/overflow and compaction. A small latency
 * target must never remove an answer while replaying its question. */
export function selectCompanionReplayWindow(
  messages: readonly CompanionRecentHistoryMessage[],
  capacity: CompanionReplayWindowCapacity,
  coverage?: HistorySummaryCoverage | null,
): CompanionReplayWindowSelection {
  const visible = messages.filter(message => message.text.trim().length > 0);
  const projected = projectCompanionHistory(visible, coverage);
  const countTokens = capacity.countTokens ?? estimateTextTokens;
  return {
    messages: projected.messages,
    receipt: {
      version: 1,
      capacityTokens: capacity.maxInputTokens,
      usedTokens: projected.messages.reduce((total, message) => total + replayMessageTokens(message, countTokens), 0),
      takenCount: projected.messages.length,
      omittedCount: projected.folded.length,
      uncoveredThroughSeq: null,
      ...(projected.folded.length ? { summaryFold: {
        fromSeq: projected.folded[0]!.seq!, throughSeq: projected.folded.at(-1)!.seq!,
        sourceSha256: coverage!.sourceSha256!,
      } } : {}),
    },
  };
}

function replayMessageTokens(message: CompanionRecentHistoryMessage, countTokens: (text: string) => number): number {
  return countTokens(message.text) + (message.reasoning?.length ? countTokens(JSON.stringify(message.reasoning)) : 0);
}

export function selectCompanionInteractiveReplayWindow(
  messages: readonly CompanionRecentHistoryMessage[],
  routeInputTokens: number,
  coverage?: HistorySummaryCoverage | null,
): CompanionReplayWindowSelection {
  return selectCompanionReplayWindow(messages, { maxInputTokens: routeInputTokens }, coverage);
}

/** Preserve complete nonempty messages. This is not a token or row cutoff. */
export function boundCompanionRecentHistory(
  messages: readonly CompanionRecentHistoryMessage[],
  capacity?: CompanionReplayWindowCapacity,
): CompanionRecentHistoryMessage[] {
  if (!capacity) return messages.filter(message => message.text.trim().length > 0);
  return selectCompanionReplayWindow(messages, capacity).messages;
}

/**
 * Status annotation for past offers. The original reply is preserved.
 *
 * 形状是量出来的，不是拍的：把那句邀请**原样包一层**「（当时我提过：…）」实测零效果
 * （严格判据 31/70 vs 基线 35/70，p=0.61）——字还留在原地，她就照着那些字继续等。
 * Earlier replacement probes are historical evidence about invitation
 * persistence, not permission to delete source text. The current design appends
 * this status without removing a paragraph; native behavior needs its own check.
 */
export const PAST_OFFER_NOTE = "（这句说完就算过去了。）";

/**
 * Mark the specified assistant offers as past, preserving their entire replies.
 * Classification is fallible: it must never authorize deleting a paragraph.
 *
 * 实机：用户闲聊时她连着四轮把上一次问答拉回来（「正等你说要不要接着往下捋——结果你先来问我」）。
 * 根因不是题目上下文被注入，也不是意图分类判错（那几轮 `intent=conversation` 是对的），而是
 * **她自己结尾那句邀请在历史里永生**：用户不接、换话题，在系统里都不是事件，于是她下一轮把
 * 自己的话读回来当一笔没结清的账。主会话 29 条回复里 23 条以钩子收尾（79%），这些钩子被用户
 * 接受的次数是 **0**。
 *
 * "哪一条还挂着没被回的账"由每轮已经在跑的注意力解释给出（`pendingOfferIndexes`）——它同时
 * 看得见她的上一条和用户的这一句；这里只按索引改形态。索引来自模型而不是词表或标点：
 * 只认问号的那一版实测等于没做，因为记账的句子多是陈述句（「就等你丢个词进来」「想接着问冰箱我随时接」）。
 *
 * 只作用于**喂给模型的那一份**：DB 原文、审计用的 `historyTail`、`companion_observe（action=history）`
 * 取回的正文都保持原样。她仍然记得自己说过什么，只是那不再是一笔待收的账。
 *
 * 泛型按 `{role, content}` 这条**要发出去的形状**收：调用方那侧还带着 toolCalls、reasoning
 * 句柄这些字段，换成 `{role,text}` 的历史形状就会在改写时把它们抹掉。
 */
export function renderPendingOffersAsRecords<T extends { role: string; content: unknown }>(
  messages: readonly T[],
  offerIndexes: readonly number[],
): T[] {
  if (offerIndexes.length === 0) return messages.slice();
  const targets = new Set(offerIndexes);
  return messages.map((message, index) => {
    if (!targets.has(index) || message.role !== "assistant") return message;
    // 非字符串正文（带图的 parts）不改：这条链上的收尾邀请只会出现在纯文本回复里。
    if (typeof message.content !== "string") return message;
    const replaced = annotatePastOffer(message.content);
    return replaced === message.content ? message : { ...message, content: replaced };
  });
}

/** Append an idempotent status annotation; original content remains verbatim. */
function annotatePastOffer(text: string): string {
  if (!text.trim() || text.trimEnd().endsWith(PAST_OFFER_NOTE)) return text;
  return `${text}\n\n${PAST_OFFER_NOTE}`;
}

/**
 * 折叠轨迹收集器。
 *
 * 它就是一个可变数组 + 一个快照构造器：折叠发生时往里追加，回合结束时把整份轨迹
 * 写进**下一版**交接快照。放在这里而不是 runtime，是为了让 runtime 只管「折了」，
 * 不管「记在哪」——两件事的失败后果不一样。
 */
export interface CompactionTraceRecorder {
  /** 折了一次就记一次。 */
  record(trace: CompactionTraceV1): void;
  /**
   * 回合结束时把轨迹并进交接快照的下一版。
   *
   * 「记」与「落」放在同一个对象里，是因为围栏与「不阻塞交付」这两条规则只有一个主人：
   * 分开放时，赶流程最容易漏掉的恰好是 skip 时该返回 false 而不是抛。
   *
   * 返回 false 表示没写进去（run 已结束或快照已被别人推进）——**不是**失败，
   * 快照仍然可用，只是这一折没进轨迹。
   */
  commit(target: {
    workspaceId: string; userId: string; runId: string;
    snapshot: CompanionContextHandoffSnapshotV1; sha256: string;
  }): Promise<boolean>;
}

export function createCompactionTraceRecorder(): CompactionTraceRecorder {
  const collected: CompactionTraceV1[] = [];
  return {
    record: (trace) => { collected.push(trace); },
    commit: (target) => recordTurnCompactionTrace({
      ...target, traces: collected,
    }),
  };
}
