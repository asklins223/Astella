import { describe, expect, it, vi } from "vitest";
import {
  RUN_STREAM_RETRY_MS,
  createRunStreamLedger,
  ensureRunStream,
  reconcileRunStreams,
  stopRunStreams,
  type RunStreamPorts,
} from "../desktop-ipc-run-streams";

/**
 * 订阅表是这条长连接的**唯一**账本。
 *
 * 2026-10-04 实测的形状：主进程漏了连接，五个泄漏的 card-generation SSE 把服务端的
 * 每用户上限（5）占满，之后每一次订阅都被 429 顶回——生成页于是再也收不到任何事件，
 * 停在原地不动，只有手动按「刷新状态」才动一下。
 *
 * 这里量的是三条：**同一条 run 被订阅两次只开一条连接**、**退订就把连接收掉**、
 * **建不上要退避**（否则订阅表每变一次就重撞一次同一个上限）。
 */
function ports(subscribed: Set<string>, watch: RunStreamPorts["watch"], onLost = () => undefined): RunStreamPorts {
  return { watch, refresh: async () => undefined, subscribed: () => subscribed, workspaceEpoch: () => 1, onLost };
}

const settle = async (times = 4): Promise<void> => {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
};

describe("run 事件流的账本", () => {
  it("同一条 run 被订阅两次只开一条连接（句柄到手之前的第二次不会再开）", async () => {
    const ledger = createRunStreamLedger();
    const subscribed = new Set(["run-1"]);
    const opened: string[] = [];
    let release = (): void => undefined;
    const watch = vi.fn((runId: string) => {
      opened.push(runId);
      // 建连要等 `ensureConnected()`：句柄**不会**同步到手——这正是泄漏的成因。
      return new Promise<() => void>((resolve) => { release = () => resolve(() => undefined); });
    });

    reconcileRunStreams(ledger, ports(subscribed, watch));
    reconcileRunStreams(ledger, ports(subscribed, watch));
    await settle();
    release();
    await settle();

    expect(opened).toEqual(["run-1"]);
    expect(ledger.streams.size).toBe(1);
  });

  it("退订之后连接被收掉；同一篇的另一个订阅者还在时不动它", async () => {
    const ledger = createRunStreamLedger();
    const subscribed = new Set(["run-1", "run-2"]);
    const stops: Record<string, () => void> = {};
    const watch = (runId: string) => Promise.resolve(() => { stops[runId] = (): void => undefined; });
    reconcileRunStreams(ledger, ports(subscribed, watch));
    await settle();

    const stopRun1 = vi.fn();
    ledger.streams.get("run-1")!.stop = stopRun1;
    subscribed.delete("run-1");
    reconcileRunStreams(ledger, ports(subscribed, watch));
    await settle();

    expect(stopRun1).toHaveBeenCalledTimes(1);
    expect(ledger.streams.has("run-1")).toBe(false);
    expect(ledger.streams.has("run-2")).toBe(true);
  });

  it("退订发生在句柄到手之前：回执到手就当场关掉，不留孤儿", async () => {
    const ledger = createRunStreamLedger();
    const subscribed = new Set(["run-1"]);
    const stop = vi.fn();
    let release = (): void => undefined;
    const watch = () => new Promise<() => void>((resolve) => { release = () => resolve(stop); });

    reconcileRunStreams(ledger, ports(subscribed, watch));
    subscribed.clear();
    reconcileRunStreams(ledger, ports(subscribed, watch));
    await settle();
    release();
    await settle();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(ledger.streams.size).toBe(0);
  });

  it("写侧只登记不建流：没人订阅时一条连接都不占", async () => {
    const ledger = createRunStreamLedger();
    const watch = vi.fn(() => Promise.resolve(() => undefined));
    ledger.tracked.add("run-1");
    await settle();
    expect(watch).not.toHaveBeenCalled();

    // 有人订阅了才补上——补的是订阅表点名的那一条。
    const subscribed = new Set(["run-1"]);
    reconcileRunStreams(ledger, ports(subscribed, watch));
    await settle();
    expect(watch).toHaveBeenCalledWith("run-1", expect.any(Function));
  });

  it("建不上要退避：订阅表反复变动也不会一直去撞同一个上限", async () => {
    const ledger = createRunStreamLedger();
    const subscribed = new Set(["run-1"]);
    const onLost = vi.fn();
    const watch = vi.fn(() => Promise.reject(new Error("rate_limited")));

    reconcileRunStreams(ledger, ports(subscribed, watch, onLost));
    await settle();
    expect(onLost).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 5; index += 1) reconcileRunStreams(ledger, ports(subscribed, watch, onLost));
    await settle();
    expect(watch).toHaveBeenCalledTimes(1);

    // 退避过去之后重新订阅会再试一次（墙钟由 Date.now 推进，测试里直接改账本）。
    ledger.retryAfter.set("run-1", Date.now() - 1);
    reconcileRunStreams(ledger, ports(subscribed, watch, onLost));
    await settle();
    expect(watch).toHaveBeenCalledTimes(2);
    expect(RUN_STREAM_RETRY_MS).toBeGreaterThan(0);
  });

  it("建连途中换了空间：句柄到手就当场关掉，不会把上一个空间的流带过来", async () => {
    const ledger = createRunStreamLedger();
    const subscribed = new Set(["run-1"]);
    const stop = vi.fn();
    let release = (): void => undefined;
    let epoch = 1;
    const watch = () => new Promise<() => void>((resolve) => { release = () => resolve(stop); });
    const current = (): RunStreamPorts => ({
      watch, refresh: async () => undefined, subscribed: () => subscribed, workspaceEpoch: () => epoch,
    });

    reconcileRunStreams(ledger, current());
    await settle();
    epoch = 2;
    release();
    await settle();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(ledger.streams.size).toBe(0);
  });

  it("全收：一条都不留，退避墙钟也作废（换账号后不该被上一个空间的退避挡住）", async () => {
    const ledger = createRunStreamLedger();
    const subscribed = new Set(["run-1"]);
    const watch = vi.fn(() => Promise.resolve(() => undefined));
    ensureRunStream(ledger, ports(subscribed, watch), "run-1");
    await settle();
    ledger.retryAfter.set("run-2", Date.now() + RUN_STREAM_RETRY_MS);
    ledger.tracked.add("run-2");

    stopRunStreams(ledger);

    expect(ledger.streams.size).toBe(0);
    expect(ledger.retryAfter.size).toBe(0);
    // `tracked` 不清：那是"本机碰过哪些 run"的记忆，由切空间/登出那几处显式清。
  });
});