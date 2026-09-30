export interface GracefulShutdownOptions {
  clearTimer: () => void;
  closeServer: () => Promise<void>;
  /** 2026-08-11：server 关闭后、DB 关闭前的附加清理（如常驻 NOTIFY 连接） */
  afterClose?: () => void;
  /**
   * 2026-09-29（P1-10）：等待**已在执行中**的定时任务收尾。
   *
   * `clearTimer` 只能取消"还没触发的那个"定时器（`clearInterval`/`clearTimeout`
   * 对已经跑起来的回调无效），所以一条正在执行的 tick 会在 `closeDatabase()`
   * 之后继续跑——那时连接池已经关了，它再去打库就是对着死连接写。
   * 这不是理论问题：`learningRunProcessingTimer` 用的还是 `clearInterval`
   * 去取消一个 `setTimeout` 创建的句柄（功能上两者互通，但语义对不上）。
   *
   * 有界：超过 `drainTimeoutMs` 就放行，绝不把关停挂死。
   */
  drainInFlight?: () => Promise<void>;
  /** drainInFlight 的上限，默认 10s。 */
  drainTimeoutMs?: number;
  closeDatabase: () => Promise<void>;
}

export interface GracefulShutdownController {
  isShuttingDown: () => boolean;
  shutdown: (signal: NodeJS.Signals) => Promise<void>;
}

/**
 * Build one idempotent shutdown path. Repeated SIGTERM/SIGINT notifications
 * share the same promise, the maintenance timer is cleared synchronously, and
 * the database pool is closed only after Fastify has drained active requests.
 */
export function createGracefulShutdown(
  options: GracefulShutdownOptions,
): GracefulShutdownController {
  let shutdownPromise: Promise<void> | null = null;

  return {
    isShuttingDown: () => shutdownPromise !== null,
    shutdown: (_signal) => {
      if (!shutdownPromise) {
        options.clearTimer();
        shutdownPromise = (async () => {
          /**
           * 三段依次兜住，每段都**收集**错误而不是当场抛：
           * 早期版本在 drain 失败时直接 `throw`，结果 `closeDatabase()` 被跳过，
           * 连接池永远不关——而那正是关停最该保证的事。（`graceful-shutdown-drain.test.ts`
           * 的"drain 抛错不会挡住关停"这条就是为这个 bug 写的。）
           */
          const failures: unknown[] = [];

          // 2026-08-11：closeServer 有界——Fastify 的 app.close() 等待所有
          // 连接/插件，某个挂起的 keep-alive 连接会让优雅关闭无限挂起
          //（编排器最终 SIGKILL）。10s 后继续 DB 关闭流程。
          try {
            await Promise.race([
              options.closeServer(),
              new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, 10_000);
                timer.unref();
              }),
            ]);
          } catch (error) {
            failures.push(error);
          }

          options.afterClose?.();

          if (options.drainInFlight) {
            // 与 closeServer 同样有界：宁可放行也不要让关停无限挂起。
            try {
              await Promise.race([
                options.drainInFlight(),
                new Promise<void>((resolve) => {
                  const timer = setTimeout(resolve, options.drainTimeoutMs ?? 10_000);
                  timer.unref();
                }),
              ]);
            } catch (error) {
              failures.push(error);
            }
          }

          try {
            await options.closeDatabase();
          } catch (error) {
            failures.push(error);
          }

          if (failures.length === 1) throw failures[0];
          if (failures.length > 1) {
            throw new AggregateError(failures, "graceful shutdown had multiple failures");
          }
        })();
      }
      return shutdownPromise;
    },
  };
}
