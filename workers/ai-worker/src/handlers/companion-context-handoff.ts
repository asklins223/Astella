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
 * ## 这一段是**照搬**的
 *
 * 水位字段、预算常量、收边顺序一个字节没改。`REPLAY_WINDOW_MESSAGES` 之所以
 * 导出（摘要器必须让开这一段）也一并保留——它跟着搬到新家，调用方 import 路径
 * 变一处即可，值没变。
 */

import type { ChatMessage } from "@astella/shared";
import type { AgentMemoryContextSourceV1 } from "@astella/shared/agent-contracts";
import { canonicalJsonV1, sha256Utf8V1 } from "@astella/shared/content-hash";
import type { CompanionMemoryDirectoryEntry } from "./companion-memory-vector.ts";


/**
 * 回放窗口：每轮作为原生多轮喂回去的最近几条。
 *
 * 导出是因为**摘要器必须让开这一段**（`companion-summarizer` 取的正是它之外的
 * 那一段）：两边各写一个 20，改一边就静默重叠，摘要会退化成"把上文再念一遍"，
 * 那时连"她到底有没有用摘要"都无法判断（方案 29 §12.1）。
 */
export const REPLAY_WINDOW_MESSAGES = 20;

const RECENT_MESSAGE_MAX_CHARS = 12_000;
const RECENT_HISTORY_BUDGET_CHARS = 24_000;
const HISTORY_ASSISTANT_MIN_CHARS = 4;

export interface CompanionRecentHistoryMessage {
  role: "user" | "assistant";
  text: string;
  /** Source message sequence; retained internally to bind summaries to the visible tail. */
  seq?: string;
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
  currentRequest: { messageId: string; messageSeq: string; contentSha256: string };
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
    expiresAt: string;
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
  currentRequest: { messageId: string; messageSeq: string; text: string };
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
  const actions = input.actionLedger.slice(0, 64).map((action) => ({
    ...action,
    safeSummary: action.safeSummary?.slice(0, 240) ?? null,
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
    proposals: input.proposals.slice(0, 32).map((proposal) => ({
      ...proposal,
      title: proposal.title.slice(0, 160),
      targetSummary: proposal.targetSummary.slice(0, 240),
      resultSafeSummary: proposal.resultSafeSummary?.slice(0, 240) ?? null,
    })),
    memoryRefs: input.memoryRefs.slice(0, 3).map((memory) => ({
      memoryId: memory.memoryId,
      kind: memory.kind,
      content: memory.content.slice(0, 80),
    })),
    memoryDirectory: (input.memoryDirectory ?? []).slice(0, 12).map((entry) => ({
      memoryId: entry.memoryId,
      kind: entry.kind.slice(0, 64),
      title: entry.title.slice(0, 56),
      appliesWhen: entry.appliesWhen?.slice(0, 64) ?? null,
      validFrom: entry.validFrom?.slice(0, 40) ?? null,
      validUntil: entry.validUntil?.slice(0, 40) ?? null,
      revision: Math.max(1, Math.trunc(entry.revision)),
      epistemicStatus: entry.epistemicStatus?.slice(0, 16) ?? null,
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
    .filter((proposal) => proposal.status === "pending" || proposal.status === "executing")
    .slice(0, 8);
  const block = {
    version: snapshot.version,
    throughMessageSeq: snapshot.watermark.throughMessageSeq,
    historyStartSeq: snapshot.watermark.historyStartSeq,
    clippedMessageCount: snapshot.watermark.clippedMessageCount,
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
      completed: snapshot.actionLedger.completed.slice(0, 16).map((action) => ({
        name: action.name,
        safeSummary: action.safeSummary?.slice(0, 100) ?? null,
      })),
      unresolved: snapshot.actionLedger.unresolved.slice(0, 16).map((action) => ({
        name: action.name,
        status: action.status,
        safeSummary: action.safeSummary?.slice(0, 120) ?? null,
      })),
      notCompleted: snapshot.actionLedger.notCompleted.slice(0, 8).map((action) => ({
        name: action.name,
        status: action.status,
        safeSummary: action.safeSummary?.slice(0, 120) ?? null,
      })),
      omitted: {
        completed: Math.max(0, snapshot.actionLedger.completed.length - 16),
        unresolved: Math.max(0, snapshot.actionLedger.unresolved.length - 16),
        notCompleted: Math.max(0, snapshot.actionLedger.notCompleted.length - 8),
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
    serialized,
    "</continuation_data>",
  ].join("\n");
}

/** Apply the exact message-count and character rules used by prompt assembly. */
export function boundCompanionRecentHistory(
  messages: readonly CompanionRecentHistoryMessage[],
): CompanionRecentHistoryMessage[] {
  const recent = messages.slice(-REPLAY_WINDOW_MESSAGES);
  const out: CompanionRecentHistoryMessage[] = [];
  let used = 0;
  /** A collapsed assistant answer also removes the preceding user prompt. */
  let dropNextUser = false;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const message = recent[i];
    const text = message.text.slice(0, RECENT_MESSAGE_MAX_CHARS);
    if (text.trim().length === 0) continue;
    if (message.role === "assistant" && text.trim().length < HISTORY_ASSISTANT_MIN_CHARS) {
      dropNextUser = true;
      continue;
    }
    if (message.role === "user" && dropNextUser) {
      dropNextUser = false;
      continue;
    }
    if (used + text.length > RECENT_HISTORY_BUDGET_CHARS) break;
    used += text.length;
    out.push({ ...message, text });
  }
  return out.reverse();
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
