/**
 * 有界的后台任务队列（2026-09-29，P2-5）。
 *
 * ## 为什么它不在路由文件里
 *
 * 此前这段"有界在途 + 有界排队 + 溢出即丢"的逻辑**内联**在
 * `modules/learning-runs/run-routes.ts` 里，附带三个模块级可变状态量。
 *
 * 它是一段**通用**的并发控制，与"学习运行"这个业务没有任何关系——
 * 放在路由里意味着：换一处 fire-and-forget 就要把这段连同它的状态一起抄一遍，
 * 而抄的时候很容易只抄走 `if (inFlight >= MAX)` 那一行、漏掉 `finally` 里
 * 减计数的那行——**计数器只增不减，队列从此永久满**。
 *
 * ## 契约（三条，不要在调用方加第四种行为）
 *
 * 1. **溢出即丢**，不排队等待。队列本身是背压机制：满了就是"这次不做"。
 * 2. **永不因任务失败而卡住**。`then`/`finally` 双分支都推进计数，
 *    任务 reject 不会让在途数停在上限。
 * 3. **计数是"当前在途"，不是"已提交"**。所以一个同步抛错的 task
 *    也会被正确记为已完成。
 *
 * 调用方要负责"丢了要紧吗"——那取决于业务，而不是这里。
 */

/** 一个可以 `then` 的函数引用；`then` 钩子让队列能识别出原生 Promise。 */
type Task = () => Promise<unknown>;

export type BoundedQueueOptions = {
  /** 同时在途的上限。 */
  maxInFlight: number;
  /** 排队等待的上限。超出即**丢弃新来的**。 */
  maxQueued: number;
  /** 被丢弃时回调（用于埋点/日志；不要在这里抛）。 */
  onDrop?: (reason: "queue_full") => void;
  /** 任务失败时回调（不要在这里抛）。 */
  onError?: (err: unknown) => void;
};

export type BoundedQueueStats = {
  /** 正在执行的条数。 */
  inFlight: number;
  /** 排队等待的条数。 */
  queued: number;
  /** 累计被丢弃（队列满）次数。 */
  dropped: number;
  /** 累计入队并被执行的次数。 */
  started: number;
};

export class BoundedAsyncQueue {
  #maxInFlight: number;
  #maxQueued: number;
  #onDrop: ((reason: "queue_full") => void) | undefined;
  #onError: ((err: unknown) => void) | undefined;
  #inFlight = 0;
  #queue: Task[] = [];
  #dropped = 0;
  #started = 0;

  constructor(options: BoundedQueueOptions) {
    // 下限 1：maxInFlight=0 会让整个队列永远推不动
    this.#maxInFlight = Math.max(1, Math.floor(options.maxInFlight));
    this.#maxQueued = Math.max(0, Math.floor(options.maxQueued));
    this.#onDrop = options.onDrop;
    this.#onError = options.onError;
  }

  /** 提交一个任务。**不返回 Promise**——调用方不该等它。 */
  submit(task: Task): void {
    if (this.#inFlight >= this.#maxInFlight) {
      if (this.#queue.length >= this.#maxQueued) {
        this.#dropped += 1;
        this.#onDrop?.("queue_full");
        return;
      }
      this.#queue.push(task);
      return;
    }
    this.#run(task);
  }

  #run(task: Task): void {
    this.#inFlight += 1;
    this.#started += 1;
    let settled: Promise<unknown>;
    try {
      settled = Promise.resolve(task());
    } catch (err) {
      // 同步抛错也算"这一条结束了"——否则计数器只增不减，队列永久满。
      this.#settle(err);
      return;
    }
    settled.then(
      () => { this.#settle(undefined); },
      (err: unknown) => { this.#settle(err); },
    );
  }

  #settle(err: unknown): void {
    this.#inFlight -= 1;
    if (err !== undefined) {
      try {
        this.#onError?.(err);
      } catch {
        // 回调自己抛了也不能让计数停住——那正是本类要防的死锁
      }
    }
    this.#drain();
  }

  #drain(): void {
    while (this.#inFlight < this.#maxInFlight && this.#queue.length > 0) {
      const next = this.#queue.shift()!;
      this.#run(next);
    }
  }

  stats(): BoundedQueueStats {
    return {
      inFlight: this.#inFlight,
      queued: this.#queue.length,
      dropped: this.#dropped,
      started: this.#started,
    };
  }
}
