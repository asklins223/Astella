import type { AgentTurnRequest, AgentTurnResult } from "@astella/shared";

/**
 * provider 消息 = agent turn 消息的元素类型。
 *
 * 折叠作用在**请求**的回放上，所以用的是 agent turn 的那条消息契约（它比 provider
 * 的 ChatMessage 宽：多 tool 角色、多 toolCalls/reasoning）。用窄的那个类型会在
 * 工具回合上直接不兼容——而那恰恰是最需要折叠的一步。
 */
import { AIContextCompactionRequiredError } from "../lib/context-governor.ts";

type ReplayMessage = AgentTurnRequest["messages"][number];

/**
 * 方案 44 §5.2／§5.4：压力触发的压缩**执行**。
 *
 * ## 折叠为什么是无损的
 *
 * 压缩的做法是把「已经被一份经过校验的摘要盖住」的回放尾部折掉，让那段只由摘要代表。
 * 这不是丢内容：
 *   - 原始消息一直躺在 `companion_messages`（唯一真源），随时可按 seq 重新读回；
 *   - 摘要先提交、后折叠，且必须带 `sourceSha256` 才允许折；
 *   - 恢复用的交接快照保存的是折叠**之前**的形态，崩溃恢复只会拿到更多上下文，
 *     不会拿到更少。
 * 所以折叠不需要另造一套围栏——它缺的只是「摘要确实盖住了这一段」的判据，和一条回执。
 *
 * ## 为什么不剪半段
 *
 * 折的单位是**整条消息**，且以 seq 为界。工具调用与结果是一对，剪开就破坏 JSON；
 * 用户纠正与未决事项挂在具体消息上，剪开就变成「她说改主意了」而没有那句原话。
 *
 * ## 至多一次
 *
 * §5.4：一次实际请求默认最多一次压缩尝试。折完仍高于触发线时带着有效上下文继续
 * （`over_trigger_line`），不反复触发、不无限重发。
 */

export interface SummaryCoverageBound {
  fromSeq: string | null;
  throughSeq: string | null;
  /** 摘要来源哈希。缺它就意味着覆盖没经过校验，不能拿它当「这段我读过」。 */
  sourceSha256: string | null;
}

export interface CompactionFoldReceipt {
  /** 被折掉的那一段（含端点）。 */
  foldedFromSeq: string;
  foldedThroughSeq: string;
  foldedMessageCount: number;
  /** 顶替它的那份摘要的来源哈希。 */
  summarySourceSha256: string;
  /** 折叠后回放里剩下的最早 seq；null 表示尾部被折空。 */
  remainingFromSeq: string | null;
  /** 摘要在折叠边界之外还没盖住的更早区间；非空表示那段确实没被摘要代表。 */
  uncoveredBeforeSeq: string | null;
}

export interface ReplayTailEntry {
  message: ReplayMessage;
  /** 来源消息 seq。缺 seq 的那条不参与折叠——没有来源键就没法证明它被摘要盖住。 */
  seq: string | null;
}

export interface ReplayFoldInput {
  system: readonly ReplayMessage[];
  tail: readonly ReplayTailEntry[];
  /**
   * 尾部之后的全部消息（当前请求、工具调用与工具结果）。
   *
   * 它们**原样保留**，一条都不折：调用方在运行时未必能一眼认出「哪条是当前请求」，
   * 认错就会把工具结果当请求、或者反过来——所以这里不猜，直接把尾部之后的一切
   * 当作不可动。
   */
  trailing: readonly ReplayMessage[];
  coverage: SummaryCoverageBound | null;
}

export interface ReplayFoldResult {
  system: ReplayMessage[];
  tail: ReplayMessage[];
  trailing: ReplayMessage[];
}

/**
 * 折掉「已经被摘要盖住」的回放尾部。
 *
 * 三条硬约束：
 *   - **当前请求永远保留**。静默切掉问题尾巴是不可接受的（44 §4.3）。
 *   - **只认校验过的覆盖**。`sourceSha256` 缺失时一段都不折——宁可多烧窗口，
 *     也不拿一份边界没核实过的摘要去顶替原文。
 *   - **以 seq 为界、整条折**。seq 是会话内的局部序号，折的都是会话**内**的，
 *     不跨会话，因此不会与另一个会话的同号桶相撞（44 §8.3）。没有 seq 的条目
 *     一律保留：证明不了它被盖住，就不能拿摘要顶替它。
 */
export function foldReplayUnderSummaryCoverage(
  input: ReplayFoldInput,
): { replay: ReplayFoldResult; receipt: CompactionFoldReceipt | null } {
  const { system, tail, trailing, coverage } = input;
  const through = coverage?.throughSeq ?? null;
  const sourceSha256 = coverage?.sourceSha256 ?? null;
  const keep = (): { replay: ReplayFoldResult; receipt: null } => ({
    replay: { system: [...system], tail: tail.map(entry => entry.message), trailing: [...trailing] },
    receipt: null,
  });
  if (!through || !sourceSha256 || tail.length === 0) return keep();
  let boundary: bigint;
  try {
    boundary = BigInt(through);
  } catch {
    return keep();
  }

  const kept: ReplayMessage[] = [];
  const foldedSeqs: string[] = [];
  for (const entry of tail) {
    let covered = false;
    if (entry.seq) {
      try {
        covered = BigInt(entry.seq) <= boundary;
      } catch {
        covered = false;
      }
    }
    if (covered) foldedSeqs.push(entry.seq!);
    else kept.push(entry.message);
  }
  if (foldedSeqs.length === 0) return keep();

  const coverageFrom = coverage?.fromSeq ?? null;
  let uncoveredBefore: string | null = null;
  try {
    // 摘要起点之前还有一段没被任何摘要盖住：折完之后那段的代表只能是原文，
    // 而原文已经被折掉了——如实记下来，别让「有摘要」冒充「全读过」。
    if (coverageFrom && BigInt(foldedSeqs[0]!) < BigInt(coverageFrom) - 1n) uncoveredBefore = foldedSeqs[0]!;
  } catch {
    uncoveredBefore = null;
  }
  let remainingFrom: string | null = null;
  for (const entry of tail) {
    if (entry.seq && !foldedSeqs.includes(entry.seq)) { remainingFrom = entry.seq; break; }
  }

  return {
    replay: { system: [...system], tail: kept, trailing: [...trailing] },
    receipt: {
      foldedFromSeq: foldedSeqs[0]!,
      foldedThroughSeq: foldedSeqs[foldedSeqs.length - 1]!,
      foldedMessageCount: foldedSeqs.length,
      summarySourceSha256: sourceSha256,
      remainingFromSeq: remainingFrom,
      uncoveredBeforeSeq: uncoveredBefore,
    },
  };
}

/** 把折叠后的回放摊回请求的 messages：system → 尾部 → 尾部之后的一切（顺序不变）。 */
export function replayToMessages(replay: ReplayFoldResult): ReplayMessage[] {
  return [...replay.system, ...replay.tail, ...replay.trailing];
}

/**
 * 失败冷却的存取端口（44 §5.4 后半）。
 *
 * 做成端口而不是直接在这里查库：这一层要能被单测驱动，而冷却是**跨轮次**的记忆，
 * 真接的时候由工作区事务与 agent-host 承担，core 不该知道表长什么样。
 */
export interface CompactionCooldownPorts {
  /** 折之前问一次该不该折。allowed=false 时照常发，只是不再折。 */
  decide(): Promise<{ allowed: boolean; reason: string; retryAfterMs: number | null }>;
  /**
   * 折完记一笔（输入 token 用来判断有没有进展）。
   *
   * 读数是**重发之后**的：真正决定有没有进展的是折完还剩多少，而不是折之前有多少。
   * 用折前的数字记，等于每次都记「没变小」。所以不给调用方一个数字让它猜——
   * 端口自己从最近一次压力判定里取（那是重发真正发生过的读数）。
   */
  record(input: { at: Date }): Promise<void>;
}

export interface BoundedCompactionInput<T> {
  /** 原样发一次。请求被压力闸拦下时它会抛 AIContextCompactionRequiredError。 */
  send: (messages: readonly ReplayMessage[]) => Promise<T>;
  /**
   * 折一次。返回 null 表示这次没有可折的内容（例如覆盖没经过校验）。
   *
   * 同时返回折好的消息数组：调用方不必把数组藏在闭包里，回执与实际发送的形状
   * 也因此必然是同一份。
   */
  compact: () => { messages: ReplayMessage[]; receipt: CompactionFoldReceipt } | null;
  /** 本轮是否还有压缩额度。 */
  hasAttempt: () => boolean;
  /**
   * 消耗掉本轮额度。**任何一次重发之前都必须先调它**：闸的 `compactionAvailable`
   * 读的是同一个额度，不消耗就重发，闸会再拦一次；那一次抛出已经在
   * `withBoundedContextCompaction` 的 try 之外，会直接逃逸——而它不在不可重试名单里
   * （`non-retryable-errors.ts` 只认硬上限那种），于是重投再撞一次，白烧几轮。
   */
  consumeAttempt: () => void;
  /** 记下这一折（§5.5：折叠也要有回执，不是静默发生）。 */
  onCompacted?: (receipt: CompactionFoldReceipt) => void;
  /**
   * 失败冷却。缺省时等价于「永远允许」——那正是早期行为（每轮都可能重折一次），
   * 接上这一层之后才变成 44 §5.4 要的「同一失败输入不每轮重触发」。
   */
  cooldown?: CompactionCooldownPorts;
}

/**
 * 发出一次请求；被压力闸要求压缩时折一次再重发。
 *
 * 至多一次（§5.4）：发 → 折 → 重发，就这三步。重发前调用方会消耗掉压缩额度，
 * 于是闸在仍然高于触发线时选择「带着有效上下文继续」并留 `over_trigger_line` 回执，
 * 而不是把同一个请求再压一遍。
 *
 * ## 压不动不是失败（§5.4 后半）
 *
 * 「折不动」与「冷却期没过」都不该让这一轮挂掉：触发线是治理线，不是硬拒绝线。
 * 两种情况都是**消耗额度、原样重发**，由闸按 `over_trigger_line` 放行并落回执；
 * 真正的硬拒绝仍然由闸在 `P > B_hard` 时给出（`AIContextOverflowError`）。
 * 每次尝试（折过没折过都算）都记一笔冷却——不记就永远停在 `first_attempt`，
 * 「同一失败输入不每轮重触发」也就没有依据。
 */
export async function withBoundedContextCompaction<T>(
  input: BoundedCompactionInput<T>,
  initialMessages: readonly ReplayMessage[],
): Promise<T> {
  try {
    return await input.send(initialMessages);
  } catch (error) {
    if (!(error instanceof AIContextCompactionRequiredError)) throw error;
    if (!input.hasAttempt()) throw error;
    // 冷却先问一句：同一份失败输入刚折过就再折，等于每轮白烧一次而情况不变。
    const verdict = input.cooldown ? await input.cooldown.decide() : null;
    const folded = verdict && !verdict.allowed ? null : input.compact();
    if (!folded) {
      input.consumeAttempt();
      try {
        return await input.send(initialMessages);
      } finally {
        await input.cooldown?.record({ at: new Date() });
      }
    }
    input.consumeAttempt();
    input.onCompacted?.(folded.receipt);
    try {
      return await input.send(folded.messages);
    } finally {
      await input.cooldown?.record({ at: new Date() });
    }
  }
}

/**
 * 把请求的 messages 换成折过之后的形状（systemPrompt / tools 一律不动）。
 *
 * 换的是**这一次请求**，不是工作上下文本身：run 的交接快照保存的仍是折叠前的
 * 形态，崩溃恢复因此只会拿到更多上下文。
 */
export function applyCompactedMessages<TRequest extends { messages: readonly ReplayMessage[] }>(
  request: TRequest,
  messages: readonly ReplayMessage[],
): TRequest {
  return { ...request, messages: [...messages] };
}

export type { AgentTurnRequest, ReplayMessage };

export interface FoldedReplay {
  messages: ReplayMessage[];
  receipt: CompactionFoldReceipt;
}

/**
 * 造一个「发一步，被压力拦住就折一次再发」的发送器（44 §5.4）。
 *
 * 编排文件里只留调用点：折的规则、额度语义与重发顺序都在这里，三处发送路径
 * （整段取回、流式、截断重试）因此共用同一条纪律，而不是各写一遍「万一超了怎么办」。
 */
export function boundedStepSender(input: {
  fold?: (messages: readonly ReplayMessage[]) => FoldedReplay | null;
  hasAttempt: () => boolean;
  consumeAttempt: () => void;
  onCompacted: (receipt: CompactionFoldReceipt) => void;
  cooldown?: CompactionCooldownPorts;
}) {
  return <TRequest extends { messages: readonly ReplayMessage[] }>(
    request: TRequest,
    send: (request: TRequest) => Promise<AgentTurnResult>,
  ): Promise<AgentTurnResult> => withBoundedContextCompaction<AgentTurnResult>({
    send: (messages) => send(applyCompactedMessages(request, messages)),
    compact: () => input.fold?.(request.messages) ?? null,
    hasAttempt: input.hasAttempt,
    consumeAttempt: input.consumeAttempt,
    onCompacted: input.onCompacted,
    ...(input.cooldown ? { cooldown: input.cooldown } : {}),
  }, request.messages);
}
