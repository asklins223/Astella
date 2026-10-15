/**
 * 「陪着的时候」那道门的判据（2026-10-14 改）。
 *
 * 原来要求**前台连续 3 分钟零鼠标零键盘**才算安静。真实使用里几乎不会满足：
 * 两天里只报上来 1 次，她那扇门等于没开。问题不在时长，在"什么算活动"——
 * 手放着不动、在读同一页的时候，鼠标飘一下就把计时清零了，而那恰恰是她想找人说两句的时刻。
 *
 * 现在的判据是**停止输入 + 页面稳定**：按下、敲击、滚动、触摸、翻页才算打断（宿主在
 * `use-companion-awareness` 里把裸的鼠标移动排除在外），满 90 秒就算安静。
 *
 * 这个 90 秒是**客户端能观察到的最早时刻**，不是"该不该开口"的判据。账号档位的门槛
 * （`COMPANION_QUIET_PRESENCE_MIN_MS`：安静 10 分／适中 3 分／活跃 90 秒）在服务端，
 * 因为客户端不该先知道账号状态。为了让档位真的等得到，一段持续的安静会**按 90 秒一格
 * 继续上报**（见下面的 tracker），而不是只报一次：只报一次的话，适中档要 3 分钟，
 * 客户端却在第 90 秒就把这一集标成"报过了"，于是"安静了 5 分钟"永远等不到自己的门槛。
 */
export const COMPANION_QUIET_PRESENCE_AFTER_MS = 90_000;

/**
 * Tracks one quiet episode without using wall-clock time. Background time never
 * earns an opportunity, and any real input starts a fresh episode.
 *
 * 一集之内按 90 秒一格继续上报，直到用户真的动了（`markActivity` 重置）。
 * 每次上报用新的观察身份，服务端按账号档位决定哪一格算时机。
 */
export function createCompanionQuietPresenceTracker(initialActivityAt: number) {
  let lastActivityAt = initialActivityAt;
  /** 上一次成功上报时的安静时长；null 表示这一集还没报过。 */
  let reportedQuietForMs: number | null = null;

  return {
    markActivity(at: number): void {
      if (!Number.isFinite(at)) return;
      lastActivityAt = at;
      reportedQuietForMs = null;
    },
    quietForMs(now: number, foreground: boolean): number | null {
      if (!foreground || !Number.isFinite(now)) return null;
      // Monotonic clocks have fractional milliseconds; the awareness wire contract requires integers.
      // Round down so precision conversion never earns an opportunity before its threshold.
      const elapsed = Math.max(0, Math.floor(now - lastActivityAt));
      if (elapsed < COMPANION_QUIET_PRESENCE_AFTER_MS) return null;
      // 同一集里两格之间也要隔满一格，否则 15 秒一次的 tick 会把同一段安静反复上报。
      if (reportedQuietForMs !== null && elapsed - reportedQuietForMs < COMPANION_QUIET_PRESENCE_AFTER_MS) return null;
      return elapsed;
    },
    markReported(quietForMs: number): void {
      reportedQuietForMs = Number.isFinite(quietForMs) ? quietForMs : null;
    },
  };
}
