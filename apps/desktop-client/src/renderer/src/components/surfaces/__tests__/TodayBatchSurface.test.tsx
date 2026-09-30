// @vitest-environment jsdom

/**
 * 今日复习那一批的组件判据（39d W7-4 刀十五；39 §12 表「今日复习」行）。
 *
 * 四条，各带正对照：
 *  1. **逐项念出选择原因**。§12 表第二列「一批有限任务，**展示选择原因**」——「展示」
 *     是判据，屏上不能只说"今天 5 道"。正对照：服务端给的 `reasonLine` **逐字**出现。
 *  2. **`deferredCount > 0` 才有「另外还有 N 道可回访」那一行；0 的时候整行不画。**
 *     画一句「另外还有 0 道可回访」是 §12.1「没有到期需求不制造『今日任务』」的同一种
 *     毛病。
 *  3. **停着的时候照列**。停着的那一批里「有几道」仍然是那几道；空一个框等于说
 *     「今天没有任务」。
 *  4. **读不出来不画空框**——画一句「今天没有任务」是 §12.1 不许制造的那一句；给的是
 *     「读不出来」 ＋ 一个「再试一次」。
 *
 * ⚠️ 本机 `vitest` 起不来（rollup 原生模块签名／Team-ID 不匹配），所以**已写未跑**。
 */
import { afterEach, describe, it, expect, beforeEach, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { TodayBatchSurface } from "../library/TodayBatchSurface.tsx";

const BATCH = {
  items: [
    { objectiveId: "11111111-1111-4111-8111-111111111111", reason: "due_now" as const, reasonLine: "3 天前学过，今天该回访" },
    { objectiveId: "22222222-2222-4222-8222-222222222222", reason: "rotation_stale" as const, reasonLine: "60 天没有回访了，抽一道看看" },
  ],
  lockedLength: 5,
  deferredCount: 2,
  paused: false,
};

function installApi(batch: unknown = BATCH) {
  (window as unknown as { ailearn?: unknown }).ailearn = {
    review: {
      // 形状照 `unwrapGatewayResult` 真正读的那两格：`{ ok, data }`。它判错形状就抛
      // `RendererGatewayError`，于是组件走「今天这一批暂时读不出来」那条分支——
      // 这正是本文件四条用例一起红了很久的原因。
      readTodayBatch: vi.fn(async () => ({ workspaceEpoch: 1, ok: true, data: batch })),
      actOnTodayBatch: vi.fn(async () => ({
        workspaceEpoch: 1,
        result: { ok: true, value: { action: "pause", lockedLength: 5, paused: true, remaining: 2, screenLine: "这一批先停在这里，剩下 2 道还在。" } },
      })),
    },
  };
}

const PROPS = { timeZone: "Asia/Shanghai", epochRef: { current: undefined as number | undefined } };

beforeEach(() => { vi.restoreAllMocks(); });
// ⚠️ 2026-09-30 补上：本文件从来没 import `cleanup`。之前它一直是空断言（组件根本没渲染），
// 所以「上一条用例的 DOM 留在屏上」这件事看不出来——补上回信形状之后它立刻变成
// 「Found multiple elements」。**空断言会把它藏住的问题藏到有人修好它为止。**
afterEach(() => { cleanup(); });

describe("§12.1 今日复习那一批", () => {
  it("逐项念出**选择原因**（§12 表「展示选择原因」）", async () => {
    installApi();
    render(<TodayBatchSurface {...PROPS} />);
    expect(await screen.findByText("3 天前学过，今天该回访")).toBeTruthy();
    // 逐字出现：不改写。
    expect(screen.getByText("60 天没有回访了，抽一道看看")).toBeTruthy();
    // 那一档（到期／久未回访）也要标出来——屏上要能一眼看出"这道为什么在"。
    expect(screen.getByText("到期")).toBeTruthy();
    expect(screen.getByText("久未回访")).toBeTruthy();
  });

  it("正对照：`deferredCount > 0` 才有「另外还有 N 道可回访」那一行", async () => {
    installApi();
    const { unmount } = render(<TodayBatchSurface {...PROPS} />);
    expect(await screen.findByText("今天先到这里；另外还有 2 道可回访。")).toBeTruthy();
    unmount();
    installApi({ ...BATCH, deferredCount: 0 });
    render(<TodayBatchSurface {...PROPS} />);
    await waitFor(() => expect(screen.queryByText(/另外还有 0 道/)).toBeNull());
  });

  it("停着的时候**照列**（那一批里「有几道」仍然是那几道）", async () => {
    installApi({ ...BATCH, paused: true });
    render(<TodayBatchSurface {...PROPS} />);
    expect(await screen.findByText("这一批先停着，做到这儿。")).toBeTruthy();
    expect(screen.getByText("3 天前学过，今天该回访")).toBeTruthy();
  });

  it("读不出来 ⇒ **不画空框**，给的是「读不出来」 ＋ 一个「再试一次」", async () => {
    (window as unknown as { ailearn?: unknown }).ailearn = {
      review: { readTodayBatch: vi.fn(async () => { throw new Error("offline"); }) },
    };
    render(<TodayBatchSurface {...PROPS} />);
    expect(await screen.findByText("今天这一批暂时读不出来。")).toBeTruthy();
    expect(screen.getByText("再试一次")).toBeTruthy();
    expect(screen.queryByText("今天没有任务")).toBeNull();
  });
});
