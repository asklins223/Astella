/**
 * 分类器请求的**延迟对冲**（2026-10-17）。
 *
 * 背景：分类器是投机首步的放行闸，它不回来，已经生成好的开口就一个字都发不出去。
 * 实测（真实分类器请求，n=24）单发 p50 2740 ms / p90 3591 ms，并发副本之间延迟的
 * 相关系数 **-0.12**——抖动是**单请求随机**，不是整体变慢。于是 min-of-two 能把
 * p90 压到 2869 ms，并把偶发的 10 s 级长尾直接吃掉。
 *
 * 三条设计约束：
 * 1. **同路由、同请求逐字相同**。分类器 `temperature=0`、输出是受约束 JSON，副本
 *    不改变语义，所以对冲在这里是**零质量风险**的；跨路由（另一家模型）会把 p50
 *    拖坏（实测备用模型 p50 4863 ms > 主路由 3599 ms），不做。
 * 2. **只对分类器做**。主步对冲会把两条不同文本的流、工具副作用混在一起，
 *    不在这一层解决。
 * 3. **有界**：先发一条；过了触发延迟还没回来才发副本（默认 0 = 直接并发两份，
 *    分类器本身的 token 成本很小）。赢的那份保留，输的那份立刻 abort，
 *    两条上游调用都在审计里各留一行。
 */

export interface HedgeCallOptions {
  /** 外部取消信号（整轮预算/用户停止）。 */
  readonly signal?: AbortSignal;
  /**
   * 先发一条之后等多久再发副本。
   * `< 0` = 关闭对冲；`0` = 立即并发两份；正数 = 延迟副本。
   */
  readonly hedgeDelayMs: number;
  /** 副本真的发出去时回调一次（观测/审计用）。 */
  readonly onHedge?: () => void;
}

export interface HedgeCallResult<T> {
  readonly value: T;
  /** 这一次是否真的发了两条上游请求。 */
  readonly hedged: boolean;
}

type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/**
 * 环境变量开关（`COMPANION_TOOL_INTENT_HEDGE_MS`）：
 * - 未设置 = **关闭**。默认关闭是为了让单测/集成测试里的"分类步骤只发一次调用"
 *   这类既有契约保持原语义；生产在 compose 里显式写 `0`（见 docker-compose.yml 的
 *   worker 环境），部署即生效，不需要灰度。
 * - `on` / `0` = 立即并发两份；正数 = 延迟副本；`off` / 负数 = 关闭。
 */
export function resolveClassifierHedgeDelayMs(
  raw: string | undefined = process.env.COMPANION_TOOL_INTENT_HEDGE_MS,
): number {
  if (raw === undefined || raw.trim() === "") return -1;
  if (/^(off|false|disabled?)$/i.test(raw.trim())) return -1;
  if (/^(on|true)$/i.test(raw.trim())) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return -1;
  return Math.min(10_000, Math.floor(parsed));
}

/**
 * 跑一次"可对冲"的调用：返回先成功的那一份，输的一份 abort。
 *
 * 失败语义：
 * - 对冲还没发出去就失败了 → 直接抛原错误（与不对冲时完全一致，不多打一次）；
 * - 已经并发之后两条都失败 → 抛第二条的错误（副本是更近的现场）。
 */
export async function runHedgedCall<T>(
  call: (signal: AbortSignal) => Promise<T>,
  options: HedgeCallOptions,
): Promise<HedgeCallResult<T>> {
  const { signal, hedgeDelayMs } = options;
  signal?.throwIfAborted();
  if (hedgeDelayMs < 0) {
    return { value: await call(signal ?? new AbortController().signal), hedged: false };
  }

  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });

  let secondaryStarted = false;
  let startSecondary = (): void => undefined;
  const secondaryOutcome = new Promise<Outcome<T>>((resolve) => {
    startSecondary = () => {
      if (secondaryStarted) return;
      secondaryStarted = true;
      options.onHedge?.();
      call(controller.signal).then(
        (value) => resolve({ ok: true, value }),
        (error) => resolve({ ok: false, error }),
      );
    };
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const primaryOutcome = call(controller.signal).then(
      (value): Outcome<T> => ({ ok: true, value }),
      (error): Outcome<T> => ({ ok: false, error }),
    );
    if (hedgeDelayMs <= 0) startSecondary();
    else timer = setTimeout(startSecondary, hedgeDelayMs);

    let winner = await Promise.race([primaryOutcome, secondaryOutcome]);
    // 主请求在对冲发出去之前就失败了：保持"失败不重试"的既有语义。
    if (!winner.ok && !secondaryStarted) throw winner.error;
    // 已经并发了：等副本（它可能先成功）。
    if (!winner.ok) winner = await secondaryOutcome;
    if (!winner.ok) throw winner.error;
    return { value: winner.value, hedged: secondaryStarted };
  } finally {
    if (timer !== null) clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
    // 输掉的那一份不再需要：取消它的上游请求（它自己的 rejection 已被 outcome 接住）。
    controller.abort();
  }
}
