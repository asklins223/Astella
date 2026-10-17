/**
 * worker 后台调度共用的节流闸。
 *
 * 这批调度器（提醒兑现、后台整理、向量补偿、回顾与唤醒）都由主循环每 500ms～5s 调一次，
 * 各自靠一个模块级时间戳控制周期。旧写法是「只有 SQL 成功才推进时间戳，失败就下一拍重试」，
 * 于是**持续性故障**（0359 那场 permission denied、以及任何长期坏掉的函数或策略）会被打成
 * 每 5 秒一发：18 小时不停、worker 日志 43.8 MB、postgres 日志 58.8 MB、容器 CPU 237%。
 * 抖动该马上重试，坏掉的东西不该被反复撞。
 *
 * 这一份把两件事分开：
 *   - 周期照旧由 `intervalMs` 控制，成功才推进；
 *   - 失败后第一次仍然下一拍就重试（DB 抖动的常态，保持既有语义与测试），
 *     之后按 `retryBaseMs` 指数退避，上限是一个完整周期——持续失败最多多撞一次/周期。
 */
export type TickThrottle = {
  /** 这一拍该不该真的去做。 */
  due(nowMs: number): boolean;
  /** 成功：推进周期，并清掉退避。 */
  succeed(nowMs: number): void;
  /** 失败：不推进周期，按连败次数登记下一次允许的时间点。 */
  fail(nowMs: number): void;
  reset(): void;
};

export function createTickThrottle(
  intervalMs: number,
  retryBaseMs = 15_000,
): TickThrottle {
  let lastSuccessAt = 0;
  let failureStreak = 0;
  let blockedUntil = 0;

  return {
    due(nowMs) {
      return nowMs - lastSuccessAt >= intervalMs && nowMs >= blockedUntil;
    },
    succeed(nowMs) {
      lastSuccessAt = nowMs;
      failureStreak = 0;
      blockedUntil = 0;
    },
    fail(nowMs) {
      failureStreak += 1;
      // 指数封顶在 30 次：连败一个月也不该出现，但 `2 ** streak` 溢出成 Infinity 之后
      // 与 0 相乘会得到 NaN，`now >= NaN` 恒假 —— 那会把调度器永久锁死。
      blockedUntil = failureStreak <= 1
        ? 0
        : nowMs + Math.min(
          intervalMs,
          retryBaseMs * 2 ** Math.min(failureStreak - 2, 30),
        );
    },
    reset() {
      lastSuccessAt = 0;
      failureStreak = 0;
      blockedUntil = 0;
    },
  };
}
