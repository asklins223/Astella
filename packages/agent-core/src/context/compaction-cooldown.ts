import type { ContextPressureReasonV1 } from "@ailearn/shared/context-budget-contracts";

/**
 * 方案 44 §5.4 后半：失败冷却与无进展状态。
 *
 * ## 为什么需要它
 *
 * 压缩是一次**有界**的尝试。它失败以后如果什么都不记，下一轮同一个请求会原样再触发
 * 一次——于是每轮都白折一次、白等一次，而情况一点没变。这正是 44 §5.4 说的
 * 「同一失败输入不能每轮重新触发」。
 *
 * ## 键为什么是这三样
 *
 * 键绑定 **(工作上下文, 来源版本, 模型路由)**：
 *   - 换会话 → 另一段历史，本来的失败对它不成立；
 *   - 来源哈希变了 → 摘要或消息已经重算，之前那次失败针对的是**旧**输入；
 *   - 换了模型 → 同一个请求在另一个窗口下可能根本装得下，不该继承上一位的冷却。
 *
 * ## 无进展是什么
 *
 * 连续两次尝试之后，请求的输入 token **没有下降**。那说明折叠这条路在当前输入上走不通
 * （通常是必要内容本身就超了硬上限），再试第三次只是重复消耗。它和「冷却期没过」是两件事：
 * 冷却是时间问题，过了就再来；无进展是这件事本身不成立，加时间也没用。
 */

/** 同一份失败输入最多尝试几次（§5.4：不无限重发）。 */
export const MAX_COMPACTION_ATTEMPTS = 3;

/** 两次尝试之间的冷却时长。 */
export const COMPACTION_COOLDOWN_MS = 60_000;

/** 连续几次无进展后判定这条路走不通。 */
export const MAX_NO_PROGRESS_ATTEMPTS = 2;

export interface CompactionCooldownState {
  /** 已经尝试过的次数。 */
  attempts: number;
  lastReason: ContextPressureReasonV1 | null;
  lastAttemptAt: Date | null;
  /** 上一次尝试之后的输入 token；用来判断有没有进展。 */
  lastInputTokens: number | null;
  /** 连续无进展的次数。 */
  noProgressStreak: number;
}

export type CompactionCooldownOutcome = "attempt" | "cooldown" | "exhausted";

export interface CompactionCooldownDecision {
  outcome: CompactionCooldownOutcome;
  /** 给日志与回执看的机器可读原因。 */
  reason:
    | "first_attempt"
    | "within_cooldown"
    | "cooldown_elapsed"
    | "no_progress"
    | "attempt_budget_spent"
    | "not_recorded";
  /** 还要等多久才允许下一次（outcome 为 cooldown 时非空）。 */
  retryAfterMs: number | null;
}

export function emptyCompactionCooldownState(): CompactionCooldownState {
  return { attempts: 0, lastReason: null, lastAttemptAt: null, lastInputTokens: null, noProgressStreak: 0 };
}

/** 判定这次该不该再折一次。纯函数：时钟由调用方给进来，不读全局时间。 */
export function decideCompactionAttempt(input: {
  state: CompactionCooldownState | null;
  now: Date;
  cooldownMs?: number;
  maxAttempts?: number;
  maxNoProgress?: number;
}): CompactionCooldownDecision {
  const cooldownMs = input.cooldownMs ?? COMPACTION_COOLDOWN_MS;
  const maxAttempts = input.maxAttempts ?? MAX_COMPACTION_ATTEMPTS;
  const maxNoProgress = input.maxNoProgress ?? MAX_NO_PROGRESS_ATTEMPTS;
  const state = input.state;
  if (!state || state.attempts === 0) {
    return { outcome: "attempt", reason: "first_attempt", retryAfterMs: null };
  }
  // 无进展是终局条件：加时间也走不通，再试只是重复消耗。
  if (state.noProgressStreak >= maxNoProgress) {
    return { outcome: "exhausted", reason: "no_progress", retryAfterMs: null };
  }
  if (state.attempts >= maxAttempts) {
    return { outcome: "exhausted", reason: "attempt_budget_spent", retryAfterMs: null };
  }
  if (state.lastAttemptAt) {
    const elapsed = input.now.getTime() - state.lastAttemptAt.getTime();
    if (elapsed < cooldownMs) {
      return {
        outcome: "cooldown",
        reason: "within_cooldown",
        retryAfterMs: cooldownMs - elapsed,
      };
    }
  }
  return { outcome: "attempt", reason: "cooldown_elapsed", retryAfterMs: null };
}

/**
 * 记一次尝试的结果，返回下一轮要存的状态。
 *
 * 「有没有进展」按**输入 token 是否下降**判：折叠本来就该让请求变小，没变小就说明
 * 这条路在当前输入上没走通（多半是必要内容本身超了硬上限，§4.3）。
 */
export function recordCompactionAttempt(input: {
  state: CompactionCooldownState | null;
  inputTokens: number;
  reason: ContextPressureReasonV1;
  at: Date;
  maxNoProgress?: number;
}): CompactionCooldownState {
  const previous = input.state ?? emptyCompactionCooldownState();
  const madeProgress = previous.lastInputTokens !== null && input.inputTokens < previous.lastInputTokens;
  const noProgressStreak = madeProgress ? 0 : previous.attempts === 0 ? 0 : previous.noProgressStreak + 1;
  return {
    attempts: previous.attempts + 1,
    lastReason: input.reason,
    lastAttemptAt: input.at,
    lastInputTokens: input.inputTokens,
    noProgressStreak: Math.min(noProgressStreak, (input.maxNoProgress ?? MAX_NO_PROGRESS_ATTEMPTS) + 1),
  };
}
