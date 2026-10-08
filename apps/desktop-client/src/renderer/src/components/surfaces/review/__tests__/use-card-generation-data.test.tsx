// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CardGenerationRunSnapshotV1 } from "@astella/shared/card-generation-desktop-contracts";
import { useRoomStore } from "../../../../app/room-store";
import { useCardGenerationData } from "../use-card-generation-data";

const RUN = "11111111-1111-4111-8111-111111111111";
function snapshot(status: CardGenerationRunSnapshotV1["status"]): CardGenerationRunSnapshotV1 {
  return { version: 1, runId: RUN, status, noteId: "note", noteVersionId: "version",
    sourceRef: { noteId: "note", noteVersionId: "version" }, cardContentEpoch: 1, currentPlanVersion: 1,
    reviewDraftRevision: 1, sourceOutdated: false, recovery: null,
    progress: { plannedCards: 3, authored: 3, gatePassed: 0, gateFailed: 0 },
    createdAt: "2026-10-08T01:00:00Z", updatedAt: "2026-10-08T01:00:00Z" };
}
const ok = <T,>(data: T) => ({ ok: true, workspaceEpoch: 1, data });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
let onEvent: () => void;
const getRun = vi.fn(), getCandidates = vi.fn(), subscribe = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  useRoomStore.setState({ activeCardGenerationRunId: RUN, workspaceScopeRevision: 1 });
  getCandidates.mockResolvedValue(ok({ candidates: [], practiceQuota: null }));
  subscribe.mockResolvedValue(ok({ subscriptionId: "subscription" }));
  Object.defineProperty(window, "astella", { configurable: true, value: {
    note: { get: vi.fn(async () => ok({ title: "测试笔记" })), cardGeneration: { getRun, getCandidates } },
    subscriptions: { subscribe, unsubscribe: vi.fn(async () => ok({})),
      onEvent: (_id: string, callback: () => void) => { onEvent = callback; return () => {}; } },
  } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); useRoomStore.setState({ activeCardGenerationRunId: null }); });

it("slow snapshots still land while SSE and two-second polls keep requesting updates", async () => {
  const first = deferred<ReturnType<typeof ok<CardGenerationRunSnapshotV1>>>();
  const candidates = deferred<ReturnType<typeof ok<{ candidates: []; practiceQuota: null }>>>();
  getRun.mockReturnValueOnce(first.promise).mockResolvedValue(ok(snapshot("review_ready")));
  getCandidates.mockReturnValueOnce(candidates.promise).mockResolvedValue(ok({ candidates: [], practiceQuota: null }));
  const { result } = renderHook(useCardGenerationData);
  await act(async () => {});
  await act(async () => { onEvent(); onEvent(); await vi.advanceTimersByTimeAsync(2000); });
  expect(getRun).toHaveBeenCalledTimes(1);
  await act(async () => { first.resolve(ok(snapshot("checking"))); });
  expect(result.current.run?.status).toBe("checking");
  await act(async () => { onEvent(); await vi.advanceTimersByTimeAsync(2000); });
  expect(getRun).toHaveBeenCalledTimes(1);
  await act(async () => { candidates.resolve(ok({ candidates: [], practiceQuota: null })); });
  expect(result.current.run?.status).toBe("review_ready");
  expect(getRun).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(getRun).toHaveBeenCalledTimes(2);
});

it("retries an initial read failure automatically even when subscribing also fails", async () => {
  getRun.mockRejectedValueOnce(new Error("连接中断")).mockResolvedValue(ok(snapshot("checking")));
  subscribe.mockRejectedValue(new Error("事件流不可用"));
  const { result } = renderHook(useCardGenerationData);
  await act(async () => {});
  expect(result.current.failure).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(result.current.run?.status).toBe("checking");
  expect(result.current.failure).toBeNull();
  expect(getRun).toHaveBeenCalledTimes(2);
});

it("keeps the latest stage and retries a failed candidate read after reaching review", async () => {
  getRun.mockResolvedValue(ok(snapshot("review_ready")));
  getCandidates.mockRejectedValueOnce(new Error("候选读取中断"))
    .mockResolvedValue(ok({ candidates: [], practiceQuota: null }));
  const { result } = renderHook(useCardGenerationData);
  await act(async () => {});
  expect(result.current.run?.status).toBe("review_ready");
  expect(result.current.failure).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(result.current.failure).toBeNull();
  expect(getCandidates).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(getRun).toHaveBeenCalledTimes(2);
});

it("does not apply a previous batch's slow response after switching tasks", async () => {
  const first = deferred<ReturnType<typeof ok<CardGenerationRunSnapshotV1>>>();
  const nextRunId = "22222222-2222-4222-8222-222222222222";
  getRun.mockReturnValueOnce(first.promise).mockResolvedValue(ok({ ...snapshot("review_ready"), runId: nextRunId }));
  const { result } = renderHook(useCardGenerationData);
  await act(async () => { useRoomStore.setState({ activeCardGenerationRunId: nextRunId }); });
  expect(result.current.run?.runId).toBe(nextRunId);
  await act(async () => { first.resolve(ok(snapshot("checking"))); });
  expect(result.current.run?.runId).toBe(nextRunId);
});
