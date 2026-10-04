// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCompanionProactiveCue } from "../use-companion-proactive-cue";
import { useCompanionCueLifecycle } from "../use-companion-cue-lifecycle";

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("念头气泡在投影刷新后的生命周期", () => {
  it("开发窗口的 StrictMode 重放仍只揭示一次，计时器不会被首次清理永久取消", () => {
    vi.useFakeTimers();
    const reveal = vi.fn();
    const stop = vi.fn();
    renderHook(() => useCompanionCueLifecycle({
      cue: { key: "ordinary:42" }, paused: false, scopeRevision: 1,
      start: () => {
        const timer = setTimeout(reveal, 3_200);
        return () => { clearTimeout(timer); stop(); };
      },
    }), { reactStrictMode: true });
    expect(stop).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(3_200));
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("相同投递的刷新不清气泡，新的投递或工作区清空才切换", () => {
    vi.useFakeTimers();
    const clear = vi.fn();
    const reveal = vi.fn();
    const cue = {
      text: "刚才那个例子还想聊聊吗？", revision: 42,
      origin: "thought" as const, expiresAt: "2026-10-03T21:00:00Z",
    };
    const { rerender } = renderHook(({ projection, scopeRevision, paused }) => {
      const active = useCompanionProactiveCue(projection?.proactiveCue ?? null);
      useCompanionCueLifecycle({ cue: active, scopeRevision, paused, start: (target) => {
        const timer = setTimeout(clear, 30_000);
        reveal(target.text);
        return () => { clearTimeout(timer); clear(); };
      } });
    }, { initialProps: { projection: { proactiveCue: cue } as { proactiveCue: typeof cue } | null, scopeRevision: 1, paused: false } });

    act(() => vi.advanceTimersByTime(1_000));
    rerender({ projection: { proactiveCue: { ...cue } }, scopeRevision: 1, paused: false });
    // The server removes displayed deliveries from proactiveCue after the receipt.
    rerender({ projection: null, scopeRevision: 1, paused: false });
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(clear).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(29_000));
    expect(clear).toHaveBeenCalledTimes(1);

    rerender({ projection: { proactiveCue: { ...cue, revision: 43 } }, scopeRevision: 1, paused: false });
    expect(reveal).toHaveBeenCalledTimes(2);
    rerender({ projection: null, scopeRevision: 2, paused: false });
    expect(clear).toHaveBeenCalledTimes(3);
    rerender({ projection: { proactiveCue: { ...cue, revision: 44 } }, scopeRevision: 2, paused: false });
    rerender({ projection: null, scopeRevision: 2, paused: true });
    expect(clear).toHaveBeenCalledTimes(4);
  });
});
