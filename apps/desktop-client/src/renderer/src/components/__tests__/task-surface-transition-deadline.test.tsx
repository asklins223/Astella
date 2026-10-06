// @vitest-environment jsdom

/**
 * 任务区过渡的有界兜底（审计 F26）。
 *
 * 现场：从首页点「恢复学习旅程」之后，任务区的可访问性树只剩一个空的
 * 「当前学习任务」容器，超过 15 秒没有题目、加载态、错误态或可用退出控件，
 * 而 run 详情接口是 200（按 ⌘R 重载后同一页立刻出现）。机制是：进/退场都由 GSAP
 * 时间线的 `onComplete` 推进状态，而时间线靠 rAF 走帧——失焦/被遮挡的窗口里
 * Chromium 会把 rAF 停掉，回调永远不来，任务区就停在 `leaving`（`aria-hidden` +
 * `inert`），自己不会好。
 *
 * 这条用例把那件事模拟到底：桩掉 `gsap.timeline`，让它**永远不回调 onComplete**
 * （等同于 rAF 停掉），然后只推进墙钟——状态必须自己走到 `entered`。
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../surfaces/study/search-surface.tsx", () => ({ SearchSurface: () => <div className="content search-field"><input aria-label="搜索" /></div> }));

vi.mock("gsap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("gsap")>();
  // 一条"起得来、走不动"的时间线：链式方法都在，onComplete 永不触发。
  const stalled: Record<string, unknown> = {};
  Object.assign(stalled, {
    to: () => stalled,
    fromTo: () => stalled,
    from: () => stalled,
    set: () => stalled,
    addLabel: () => stalled,
    add: () => stalled,
    kill: () => undefined,
  });
  return {
    ...actual,
    default: {
      ...(actual as unknown as { default: Record<string, unknown> }).default,
      timeline: () => stalled,
    },
  };
});

import { TaskSurface } from "../TaskSurface.tsx";
import { useRoomStore } from "../../app/room-store.ts";

const RUN_ID = "00000000-0000-4000-8000-000000000001";

function stubGateway() {
  const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 1, data });
  (window as unknown as { astella: unknown }).astella = {
    learningRun: {
      get: vi.fn(async () => ok(null)),
      getDraft: vi.fn(async () => ok(null)),
      getResult: vi.fn(async () => ok(null)),
      getReturnContract: vi.fn(async () => ok(null)),
      recordActivityLease: vi.fn(async () => ok({ recorded: true })),
    },
    subscriptions: {
      subscribe: vi.fn(async () => ok({ subscriptionId: "sub-1" })),
      onEvent: vi.fn(() => () => undefined),
      unsubscribe: vi.fn(async () => ok({})),
    },
    activity: { getToday: vi.fn(async () => ok({ version: 1, day: "2026-09-23", events: [], anomalies: [], truncated: false, anomaliesTruncated: false })) },
    stats: { getOverviewAll: vi.fn(async () => ok({})) },
    capabilities: { get: vi.fn(async () => ok({ actionCapabilities: {}, featureAvailability: {}, nativeCapabilities: { asr: "unavailable" } })) },
  };
}

const transition = () => document.querySelector(".task-surface")?.getAttribute("data-transition");

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  stubGateway();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  useRoomStore.setState({
    activeRunId: null, activeObjectiveId: null, surface: null, returnTarget: null,
    scenePhase: "idle", motionMode: "full", reducedMotion: false,
  });
});

describe("任务区过渡（审计 F26）", () => {
  it("快速换页和退场中重新打开都跟随最新目标，焦点无需等待动效", async () => {
    vi.useFakeTimers();
    render(<TaskSurface />);
    await act(async () => { useRoomStore.setState({ surface: "search", scenePhase: "focusing" }); });
    expect(document.querySelector(".task-surface")?.getAttribute("data-surface")).toBe("search");
    await act(async () => { await vi.advanceTimersByTimeAsync(32); });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("搜索");
    expect(transition()).toBe("entering");
    await act(async () => { useRoomStore.setState({ surface: null }); });
    expect(transition()).toBe("leaving");
    await act(async () => { useRoomStore.setState({ surface: "review" }); });
    await act(async () => { useRoomStore.setState({ surface: "search" }); });
    expect(document.querySelector(".task-surface")?.getAttribute("data-surface")).toBe("search");
    expect(document.querySelector(".task-surface")?.hasAttribute("inert")).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(transition()).toBe("entered");
    expect(document.querySelector(".task-surface")?.getAttribute("data-surface")).toBe("search");
  });

  it.each([{ motionMode: "off" as const, reducedMotion: false }, { motionMode: "full" as const, reducedMotion: true }])(
    "Off 或系统减少动态下当次提交即可操作",
    async (preference) => {
      vi.useFakeTimers();
      useRoomStore.setState(preference);
      render(<TaskSurface />);
      await act(async () => { useRoomStore.setState({ surface: "search" }); });
      expect(transition()).toBe("entered");
      expect(document.querySelector(".task-surface")?.hasAttribute("inert")).toBe(false);
      await act(async () => { useRoomStore.setState({ surface: null }); });
      expect(document.querySelector(".task-surface")).toBeNull();
    },
  );
  it("时间线永不回调时，墙钟兜底仍把状态推进到 entered", async () => {
    vi.useFakeTimers();
    render(<TaskSurface />);

    act(() => {
      useRoomStore.getState().setActiveRunId(RUN_ID);
      useRoomStore.getState().invoke("validate");
    });
    // 进场时间线起来了但永远走不完：状态必须停在 entering。
    expect(transition()).toBe("entering");

    // 只推进墙钟——没有 rAF、没有时间线回调。
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });

    expect(transition()).toBe("entered");
    // 且不再是"退场态"：那才是屏上空白的原因。
    const section = document.querySelector(".task-surface");
    expect(section?.getAttribute("aria-hidden")).toBeNull();
    expect((section as HTMLElement | null)?.hasAttribute("inert")).toBe(false);
  });

  it("切到下一条任务立即挂载目标；停住的旧动画不阻塞新页面", async () => {
    vi.useFakeTimers();
    render(<TaskSurface />);

    await act(async () => {
      useRoomStore.getState().setActiveRunId(RUN_ID);
      useRoomStore.getState().invoke("validate");
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(transition()).toBe("entered");

    // 换成另一个面：目标当次提交就可用。直接改状态——`invoke` 在作答中会先过导航守卫
    // （那是 F38b 那条链），这里要测的是过渡本身。
    await act(async () => { useRoomStore.setState({ surface: "review" }); });
    expect(document.querySelector(".task-surface")?.getAttribute("data-surface")).toBe("review");
    expect(transition()).toBe("entering");
    expect(document.querySelector(".task-surface")?.hasAttribute("inert")).toBe(false);

    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });

    expect(transition()).toBe("entered");
    expect(document.querySelector(".task-surface")?.getAttribute("aria-hidden")).toBeNull();
  });
});
