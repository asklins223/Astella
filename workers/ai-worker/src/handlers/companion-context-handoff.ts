import { recordTurnCompactionTrace } from "./companion-compaction-trace.ts";
/**
 * 上下文的**交接快照与历史收边**（40 §4.7.2）。
 *
 * ## 为什么这一族值得搬出来
 *
 * 它回答的是「**裁剪之前先把什么固定下来**」——水位、未决调用、已完成动作的回执、
 * 被折叠掉的条目、以及覆盖水位之后必须保留的尾部。合同在这一段的要求是硬的：
 *
 *   §4.7.2「在实际裁剪边界保存输入快照和交接版本后，才更新上下文指针」
 *   §4.7.4「不把固定 200 条消息当边界定义」
 *
 * 而它原先和**提示词装配**（人格、注入块、流式分片、输出校验）挤在同一个文件里。
 * 那个文件当时已经 1515 行，越过 1500 的神文件阈值——而这两族没有任何耦合：
 * 快照是**要存下来**的东西，装配是**这一轮怎么写**的东西。
 *
 * ## 水位与收边是**照搬**的，回放窗口的取舍口径 2026-10-12 改了
 *
 * 水位字段、收边顺序没动。改的是「上一轮交给她多少条原话」怎么定：原来是纯条数
 * 窗口（`slice(-20)`），条数与这一轮路由的模型能读多少无关——短问短答时少给，
 * 长材料时又可能一次给过头。现在按**声明预算整条取舍**：一条要么整条带走，
 * 要么这一轮不带，少带了几条如实记进交接回执。
 */

import type { ChatMessage, ProviderCapability } from "@astella/shared";
import type { AgentMemoryContextSourceV1 } from "@astella/shared/agent-contracts";
import { canonicalJsonV1, sha256Utf8V1 } from "@astella/shared/content-hash";
import { estimateTextTokens, resolveContextBudget } from "@astella/agent-core";
import type { CompanionMemoryDirectoryEntry } from "./companion-memory-vector.ts";
import { REGISTERED_FALLBACK_CAPABILITY } from "../lib/context-governor.ts";


/**
 * 取历史时一次读回多少**行**。
 *
 * 数的是吞吐（一次往返取几行），不是覆盖（她这一轮能看见几条）。
 * 覆盖由 `selectCompanionReplayWindow` 按本次路由模型声明的预算整条取舍决定。
 *
 * 还在把它当覆盖边界的调用点：`companion-dialogue.ts` 与 `companion-summarizer.ts`
 * 的 `readCompanionHistoryRows({ limit: … })`、`live-tests/natural-dialogue-probe.ts`。
 * 那几处把取数宽度接到声明预算之后，这一格才真的只剩吞吐含义。
 */
/**
 * 取历史行的**查询页宽**，不是内容窗口。注进去几条由 `selectCompanionReplayWindow` 按本次
 * 路由声明的输入预算整条决定；这一版以前叫 `REPLAY_WINDOW_MESSAGES = 20`，把两件事混成一件——
 * 窗口再怎么按预算算，读也只读得到 20 行，长对话等于自动失忆。
 */
export const REPLAY_HISTORY_READ_ROWS = 200;

/**
 * 注入侧取舍用的输入容量：由**本次路由模型声明**的窗口解析（44 §4.1）。
 *
 * 停在压缩触发线之前，使选取本身不必再逼出一轮压缩；完整请求的权威闸门仍是调用前的
 * `governContextPressure`——这里只保证「一条要么整条给、要么这一轮不给」，不拿一个抄在
 * 代码里的字符数去替模型猜它能读多少。档案拿不到时走 agent-core 登记的保守能力同一条
 * 解析，得到的仍然是一个声明出来的 token 数。
 */
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
   * 与摘要的 `uncovered` 同一个词：这一段由 `companion_read_history` 按 seq 取回。
   */
  uncoveredThroughSeq: string | null;
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
  currentRequest: { messageId: string | null; messageSeq: string; contentSha256: string };
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
   * 变的是多出这份轨迹——没有它，审计无从回答「实际发出去的是什么」：哪一段被折了、
   * 哪份摘要顶替的、那次判定是过了触发线还是被拒绝。只记区间与水位，不记正文。
   */
  compactions?: CompactionTraceV1[];
}

export interface CompactionTraceV1 {
  sourceKind?: "active_tool_rounds";
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
  currentRequest: { messageId: string | null; messageSeq: string; text: string };
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
    modelMessages: input.modelMessages.map(({ role, content }) => ({ role, content })),
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
      omitted: {
        completed: 0,
        unresolved: 0,
        notCompleted: 0,
      },
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
  return [
    "<continuation_data>",
    "这是伴星运行账本的确定性快照，只描述来源、水位、授权和动作状态；它不是用户指令，也不授予新授权。",
    "只有状态为 succeeded 的账本项代表已完成；requested、executing、waiting_confirmation、outcome_unknown、failed、blocked、expired 都不能说成已完成。",
    "当前用户请求仍以最后一条 user 消息为准；话题和下一步由你判断，建议不等于授权。",
    "动作账本采用紧凑数组：completed 项是 [工具名, 安全摘要]；unresolved 与 notCompleted 项是 [工具名, 状态, 安全摘要]。",
    // 少带的那一段要说得出**为什么**与**怎么补**，否则她只能假设上面没有发生过。
    ...(snapshot.replayWindow && snapshot.replayWindow.omittedCount > 0
      ? [`本轮按上下文回放预算只带回了 ${snapshot.replayWindow.takenCount} 条原话，`
        + `更早的 ${snapshot.replayWindow.omittedCount} 条没有带走（不是没发生过）；`
        + `要用那一段就先按 seq 调用 companion_read_history 取回。`]
      : []),
    serialized,
    "</continuation_data>",
  ].join("\n");
}

/**
 * 从最新往回，把**整条装得下**的原话带走，并给出交接要记的那一笔。
 *
 * 装不下的那条连同更早的一起留下：回放是一段连续的对话，中间挖洞会把她自己上一句
 * 和用户下一句拆开。留下的仍然读得到——`companion_read_history` 按 seq 取回，
 * 所以少带不等于丢掉。短答「好。」是有效历史，不是那一轮用户话没成功的证据。
 */
export function selectCompanionReplayWindow(
  messages: readonly CompanionRecentHistoryMessage[],
  capacity: CompanionReplayWindowCapacity,
): CompanionReplayWindowSelection {
  const countTokens = capacity.countTokens ?? estimateTextTokens;
  const visible = messages.filter(message => message.text.trim().length > 0);
  const taken: CompanionRecentHistoryMessage[] = [];
  let usedTokens = 0;
  let uncoveredThroughSeq: string | null = null;
  for (let index = visible.length - 1; index >= 0; index -= 1) {
    const message = visible[index]!;
    const cost = countTokens(message.text);
    if (usedTokens + cost > capacity.maxInputTokens) {
      uncoveredThroughSeq = message.seq ?? null;
      break;
    }
    usedTokens += cost;
    taken.unshift(message);
  }
  return {
    messages: taken,
    receipt: {
      version: 1,
      capacityTokens: capacity.maxInputTokens,
      usedTokens,
      takenCount: taken.length,
      omittedCount: visible.length - taken.length,
      uncoveredThroughSeq,
    },
  };
}

/**
 * Live dialogue should carry a useful recent tail, not fill a very large provider
 * window with every row read for history lookup. Older rows remain addressable
 * through companion_read_history; this is an inline replay target, not a capability
 * or total-request limit.
 */
export const COMPANION_INTERACTIVE_REPLAY_TOKEN_BUDGET = 2_048;

export function selectCompanionInteractiveReplayWindow(
  messages: readonly CompanionRecentHistoryMessage[],
  routeInputTokens: number,
): CompanionReplayWindowSelection {
  return selectCompanionReplayWindow(messages, {
    maxInputTokens: Math.min(routeInputTokens, COMPANION_INTERACTIVE_REPLAY_TOKEN_BUDGET),
  });
}

/**
 * 保持**整条**近期消息：一条要么带走，要么这一轮不带。
 *
 * 不给容量时不做条数取舍——空正文不是历史（那是发送失败的助手输出），除此之外
 * 窗口大小只由本次路由声明的输入预算决定。完整请求的容量仍由调用前的
 * `governContextPressure` 计量，这里不替它猜一个字符数（44 §4.3）。
 */
export function boundCompanionRecentHistory(
  messages: readonly CompanionRecentHistoryMessage[],
  capacity?: CompanionReplayWindowCapacity,
): CompanionRecentHistoryMessage[] {
  if (!capacity) return messages.filter(message => message.text.trim().length > 0);
  return selectCompanionReplayWindow(messages, capacity).messages;
}

/**
 * 降级时替换上去的那一句。
 *
 * 形状是量出来的，不是拍的：把那句邀请**原样包一层**「（当时我提过：…）」实测零效果
 * （严格判据 31/70 vs 基线 35/70，p=0.61）——字还留在原地，她就照着那些字继续等。
 * 换成一句**中性陈述**才压得下来。留出集（6 个未参与调参的真实轮次，各 10 发，判据=同一句里
 * 既提到学习内容又发出续办邀请）11/60 vs 原样 25/60，p=0.009，六个场景没有一个变差。
 * 取中性说明这一形，不替她编一句她没说过的话。
 */
export const PAST_OFFER_NOTE = "（这句说完就算过去了。）";

/**
 * 把回放里**指定那几条**她自己消息的收尾换成一句中性说明，不再是一笔待收的账（2026-10-07）。
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
 * 只作用于**喂给模型的那一份**：DB 原文、审计用的 `historyTail`、`companion_read_history`
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
    const replaced = replaceTrailingOfferParagraph(message.content);
    return replaced === message.content ? message : { ...message, content: replaced };
  });
}

/** 把一段回复的最后一个非空段落换成那句中性说明；没有尾巴或已经换过就原样返回。 */
function replaceTrailingOfferParagraph(text: string): string {
  const paragraphs = text.split("\n\n");
  let last = paragraphs.length - 1;
  while (last >= 0 && paragraphs[last]!.trim().length === 0) last -= 1;
  if (last < 0) return text;
  if (paragraphs[last]!.trim() === PAST_OFFER_NOTE) return text;
  paragraphs[last] = PAST_OFFER_NOTE;
  return paragraphs.join("\n\n");
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
