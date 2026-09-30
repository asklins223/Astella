/**
 * 优雅关停的 in-flight drain 行为测试。
 *
 * 2026-09-29（P1-10）。为什么它需要测试：`clearTimer` 取消不了**已经在执行**的
 * 定时任务（`clearInterval`/`clearTimeout` 对已跑起来的回调无效），所以一条正在
 * 执行的 tick 会在 `closeDatabase()` 之后继续跑——那时连接池已经关掉，它再去
 * 写库就是对着一堆死连接。`learningRunProcessingTimer` 那条尤其明显：它用
 * `clearInterval` 去取消一个 `setTimeout` 创建的句柄。
 *
 * 下面全部是**行为**断言（"drain 在 closeDatabase 之前完成"、"drain 失败不挡住
 * 关停"、"超时后放行"），不是去读源码文本。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGracefulShutdown } from "../server/graceful-shutdown.ts";

describe("createGracefulShutdown 的 in-flight drain", () => {
  it("drain 在 closeDatabase 之前完成", async () => {
    const order: string[] = [];
    let releaseDrain: (() => void) | undefined;
    const drainGate = new Promise<void>((resolve) => { releaseDrain = resolve; });

    const shutdown = createGracefulShutdown({
      clearTimer: () => { order.push("clearTimer"); },
      closeServer: async () => { order.push("closeServer"); },
      drainInFlight: async () => {
        order.push("drain:start");
        await drainGate;
        order.push("drain:end");
      },
      closeDatabase: async () => { order.push("closeDatabase"); },
    });

    const done = shutdown.shutdown("SIGTERM");
    // 让 drain 有机会真的开始。
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ["clearTimer", "closeServer", "drain:start"],
      "closeDatabase 不该在 drain 完成前发生");
    releaseDrain?.();
    await done;
    assert.deepEqual(order, ["clearTimer", "closeServer", "drain:start", "drain:end", "closeDatabase"]);
  });

  it("drain 抛错不会挡住关停（仍会关连接池）", async () => {
    const order: string[] = [];
    const shutdown = createGracefulShutdown({
      clearTimer: () => {},
      closeServer: async () => { order.push("closeServer"); },
      drainInFlight: async () => { throw new Error("drain 炸了"); },
      closeDatabase: async () => { order.push("closeDatabase"); },
    });

    await assert.rejects(
      () => shutdown.shutdown("SIGTERM"),
      /drain 炸了/,
    );
    assert.deepEqual(order, ["closeServer", "closeDatabase"],
      "drain 失败也必须走到 closeDatabase，否则连接池泄漏");
  });

  it("drain 挂死时被 drainTimeoutMs 放行（关停不被拖住）", async () => {
    const order: string[] = [];
    // `drainTimeoutMs` 的定时器是 unref 的（生产语义：宁可放行也不把关停挂死，
    // 事件循环空了就直接退出）。测试进程里事件循环一空，node:test 会直接判
    // "Promise resolution is still pending"，所以这里要自己撑住循环。
    const keepAlive = setInterval(() => {}, 5);
    const shutdown = createGracefulShutdown({
      clearTimer: () => {},
      closeServer: async () => { order.push("closeServer"); },
      // 永不 resolve
      drainInFlight: () => new Promise<void>(() => {}),
      drainTimeoutMs: 20,
      closeDatabase: async () => { order.push("closeDatabase"); },
    });

    try {
      await shutdown.shutdown("SIGTERM");
    } finally {
      clearInterval(keepAlive);
    }
    assert.deepEqual(order, ["closeServer", "closeDatabase"]);
  });

  it("没有配 drainInFlight 时行为不变（向后兼容）", async () => {
    const order: string[] = [];
    const shutdown = createGracefulShutdown({
      clearTimer: () => { order.push("clearTimer"); },
      closeServer: async () => { order.push("closeServer"); },
      closeDatabase: async () => { order.push("closeDatabase"); },
    });
    await shutdown.shutdown("SIGTERM");
    assert.deepEqual(order, ["clearTimer", "closeServer", "closeDatabase"]);
  });

  it("重复信号共享同一个 promise，且 drain 只跑一次", async () => {
    let drainCalls = 0;
    const shutdown = createGracefulShutdown({
      clearTimer: () => {},
      closeServer: async () => {},
      drainInFlight: async () => { drainCalls += 1; },
      closeDatabase: async () => {},
    });
    await Promise.all([shutdown.shutdown("SIGTERM"), shutdown.shutdown("SIGINT"), shutdown.shutdown("SIGTERM")]);
    assert.equal(drainCalls, 1, "重复 SIGTERM/SIGINT 共享同一 promise，drain 不该被重复触发");
  });
});
