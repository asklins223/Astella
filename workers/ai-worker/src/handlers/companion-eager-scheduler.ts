/**
 * 提前派发的**排队与收口**（40b §4.1-1 / R7）。
 *
 * ## 这一层把什么和不什么分开了
 *
 * 真正要连库的那一步是 `dispatch(slot)` ——落账本、跑工具、回收执���。它是
 * **注入**进来的，所以本文件不碰数据库，因而**可以测**。
 *
 * 剩下的是排队语义，而它恰恰是容易出错的那部分：
 *
 *  - 收到一格就**开跑，但不 await**：await 会把流按停（R7 就没了）；
 *  - 同一格只跑一次（provider 偶尔重放片）；
 *  - 遇到确认门 / 序号缺口就**停在那里等**，不赌缺口里是空的；
 *  - 收口时把在途的一并等完，并按 §4.1-1 配对结果（已执行保留、
 *    未开始 `not_executed`、不确定 `outcome_unknown`）。
 *
 * ## 为什么"不 await"是这个类的核心约定
 *
 * 它跑在 SSE 读取循环调用的那个回调里。那里 await 一下，模型的下一个字就
 * 永远吐不出来——而 R7 的**全部**收益就是"生成继续、工具并行"。这个错误
 * 不报错，只表现为伴星变卡。
 */

import {
  eagerDispatchDecisions,
  interruptedEagerCallStatus,
  type EagerDispatchOptions,
  type StreamToolCallSlot,
} from "./companion-eager-dispatch.ts";

/** 队列**内部**记的阶段。 */
export type EagerPhase = "pending" | "executed" | "not_started" | "outcome_unknown";

/**
 * 收口后交给上层的**回执词汇**（§4.5.7）。
 *
 * 注意它与内部阶段**不是同一组词**：`executed`/`not_started` 是内部记账用的，
 * 对外一律翻成 `succeeded`/`not_executed`。之前这里直接 `as EagerPhase` 蒙混，
 * 结果类型说会出 "executed"、实际吐的是 "succeeded"——调用方按类型写就错。
 */
export type EagerReceipt = "succeeded" | "not_executed" | "outcome_unknown";

export interface EagerOutcome {
  index: number;
  id: string;
  name: string;
  phase: EagerReceipt;
  /** 工具自己的结果；`executed` 之外的那几档没有意义。 */
  result?: unknown;
}

export interface EagerDispatchSchedulerOptions {
  /** 跑一次调用（落账本 + 执行）。**注入进来**，所以本文件不连库。 */
  dispatch: (slot: StreamToolCallSlot) => Promise<unknown>;
  /** 判据用：哪些工具需要用户确认（构成屏障）、哪些是只读白名单。 */
  decision?: EagerDispatchOptions;
  /** 派发真跑了没有 —— 接日志用。 */
  onStarted?: (slot: StreamToolCallSlot) => void;
  /** 派发抛了。这里默认吞掉：失败由 outcome_unknown 表达，不许炸掉整轮。 */
  onError?: (slot: StreamToolCallSlot, error: unknown) => void;
}

/**
 * 一个提前派发队列。
 *
 * 生命周期：`offer(...)` 每来一格叫一次（**不要** await 里面的东西），
 * `close()` 在流结束时调一次，把在途等完并配对结果。
 */
export class EagerDispatchScheduler {
  private readonly slots = new Map<number, StreamToolCallSlot>();
  private readonly phase = new Map<number, EagerPhase>();
  private readonly results = new Map<number, unknown>();
  private readonly inFlight = new Map<number, Promise<void>>();
  private readonly started = new Set<number>();
  private maxIndexSeen = -1;
  private closed = false;

  constructor(private readonly options: EagerDispatchSchedulerOptions) {}

  /**
   * provider 报告"这一格够完整了"。
   *
   * **同步返回**：内部把执行挂成游离 promise，不 await。这是这一层的约定。
   */
  offer(slot: StreamToolCallSlot): void {
    if (this.closed) return;
    this.slots.set(slot.index, slot);
    if (slot.index > this.maxIndexSeen) this.maxIndexSeen = slot.index;
    this.pump();
  }

  /** provider 侧自己 flush 出来的最后一格，与 offer 同形。 */
  offerAll(slots: readonly StreamToolCallSlot[]): void {
    for (const slot of slots) this.offer(slot);
  }

  /**
   * 把当前能派的那几格开跑。
   *
   * 判据交给 `eagerDispatchDecisions`（那五个：顺序、缺口、确认门、参数完整、
   * 只读白名单）——这里只负责"开跑"这个动作本身。
   */
  private pump(streamFinished = false): void {
    const decision = this.options.decision;
    if (!decision) return;
    for (const entry of eagerDispatchDecisions(this.snapshotSlots(), {
      ...decision,
      // 收口那次要把 streamFinished 传上去：最后一个槽子只有到那时才有结论。
      ...(streamFinished ? { streamFinished: true } : {}),
    } satisfies EagerDispatchOptions)) {
      if (entry.ready && !this.started.has(entry.index)) {
        this.start(entry.index);
      }
    }
  }

  private start(index: number): void {
    const slot = this.slots.get(index);
    if (!slot) return;
    this.started.add(index);
    this.phase.set(index, "pending");
    this.options.onStarted?.(slot);
    // 关键：不 await。`void` 是刻意的——这里 await 就是把流按停。
    const promise = this.options.dispatch(slot)
      .then((result) => {
        this.results.set(index, result);
        this.phase.set(index, "executed");
      })
      .catch((error: unknown) => {
        // 跑了但没拿到确定结果：不是"没发生"，所以是 unknown 而不是 not_executed。
        this.phase.set(index, "outcome_unknown");
        this.options.onError?.(slot, error);
      })
      .finally(() => { this.inFlight.delete(index); });
    this.inFlight.set(index, promise);
  }

  private snapshotSlots(): StreamToolCallSlot[] {
    return [...this.slots.values()].sort((a, b) => a.index - b.index);
  }

  /** 流结束：等完在途，按 §4.1-1 配对。**这个是要 await 的**（此时流已经停了）。 */
  async close(streamInterrupted: boolean): Promise<EagerOutcome[]> {
    this.closed = true;
    // 收口时把最后那几格也算一遍：顺序判据靠"后面有更高的 index"，
    // 而最后一个只能到这里才有结论。`streamFinished` 让判据放行最后一格。
    this.pump(true);
    for (const slot of this.snapshotSlots()) {
      if (!this.started.has(slot.index)) {
        this.phase.set(slot.index, "not_started");
      }
    }
    await Promise.allSettled([...this.inFlight.values()]);
    return this.snapshotSlots().map((slot) => {
      const phase = this.phase.get(slot.index) ?? "not_started";
      return {
        index: slot.index,
        id: slot.id,
        name: slot.name,
        phase: interruptedEagerCallStatus(phase, streamInterrupted),
        ...(this.results.has(slot.index) ? { result: this.results.get(slot.index) } : {}),
      };
    });
  }

  /** 已经开跑了几格（测试与日志用）。 */
  startedIndices(): number[] {
    return [...this.started].sort((a, b) => a - b);
  }

  /** 在途几格。 */
  pendingCount(): number {
    return this.inFlight.size;
  }
}
