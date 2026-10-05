// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentRunV1 } from "@ailearn/shared/agent-contracts";
import { useAgentGoals } from "../use-agent-goals";
import { publishCompanionRecordsChanged } from "../companion-events";

const state = vi.hoisted(() => ({ scope: 1 }));
const notify = vi.hoisted(() => vi.fn());
vi.mock("../../../app/room-store", () => ({ useRoomStore: Object.assign(
  (select: (value: { workspaceScopeRevision: number }) => unknown) => select({ workspaceScopeRevision: state.scope }),
  { getState: () => ({ workspaceScopeRevision: state.scope }) },
) }));
vi.mock("../../../app/desktop-client", () => ({ createRequestMeta: () => ({}),
  unwrapGatewayResult: (value: unknown) => value, gatewayErrorMessage: (error: Error) => error.message }));
vi.mock("../companion-notifications", () => ({ notifyCompanion: notify }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const run = (status: AgentRunV1["status"] = "running", revision = 1): AgentRunV1 => ({
  version: 1, runId: "goal", identityId: "identity", revision, status, goal: "整理这篇笔记", conversationId: null,
  inputs: [], operations: [], artifacts: [], summary: null, error: null, modelCalls: 1, maxModelCalls: 16,
  createdAt: "2026-10-04T01:00:00Z", updatedAt: "2026-10-04T01:00:00Z",
});
const listRuns = vi.fn(), controlRun = vi.fn(), reviseRun = vi.fn(), getRun = vi.fn();
beforeEach(() => {
  state.scope = 1; vi.clearAllMocks();
  listRuns.mockResolvedValue({ version: 1, items: [run()], nextCursor: null });
  Object.defineProperty(window, "ailearn", { configurable: true, value: { agent: { listRuns, controlRun, reviseRun, getRun } } });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("a notebook acceptance refreshes the unified journal and one completion produces one notification", async () => {
  listRuns.mockResolvedValue({ version: 1, items: [], nextCursor: null });
  const view = renderHook(() => useAgentGoals("idle", vi.fn()));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  listRuns.mockResolvedValue({ version: 1, items: [run("waiting")], nextCursor: null });
  act(() => publishCompanionRecordsChanged());
  await waitFor(() => expect(view.result.current.items[0]?.status).toBe("waiting"));
  expect(notify).not.toHaveBeenCalled();
  listRuns.mockResolvedValue({ version: 1, items: [run("completed")], nextCursor: null });
  await act(async () => { await view.result.current.refresh(); await view.result.current.refresh(); });
  expect(notify).toHaveBeenCalledTimes(1);
});

it("loads a linked older task directly and preserves a newer local revision over a late read", async () => {
  const older = { ...run("completed"), runId: "older", revision: 2 };
  const late = deferred<AgentRunV1>();
  getRun.mockReturnValueOnce(late.promise);
  const view = renderHook(() => useAgentGoals("idle", vi.fn()));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  let reading!: Promise<void>;
  act(() => { reading = view.result.current.ensure("older"); });
  expect(getRun).toHaveBeenCalledWith({ meta: {}, runId: "older" });
  const updated = { ...older, status: "paused" as const, revision: 3 };
  controlRun.mockResolvedValueOnce(updated);
  await act(async () => { await view.result.current.change(older, "pause"); });
  await act(async () => { late.resolve(older); await reading; });
  expect(view.result.current.items.find(item => item.runId === "older")).toEqual(updated);
});

it("discards a direct linked-task read after changing spaces", async () => {
  const late = deferred<AgentRunV1>();
  getRun.mockReturnValueOnce(late.promise);
  const view = renderHook(() => useAgentGoals("idle", vi.fn()));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  let reading!: Promise<void>;
  act(() => { reading = view.result.current.ensure("private-old"); });
  state.scope = 2; view.rerender();
  await act(async () => { late.resolve({ ...run("completed"), runId: "private-old" }); await reading; });
  expect(view.result.current.items.some(item => item.runId === "private-old")).toBe(false);
});

it("discards a response from the previous space even when it arrives after the current list", async () => {
  const old = deferred<unknown>();
  listRuns.mockImplementation(() => state.scope === 1 ? old.promise : Promise.resolve({ version: 1, items: [] }));
  const view = renderHook(() => useAgentGoals("idle", vi.fn()));
  state.scope = 2; view.rerender();
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  await act(async () => old.resolve({ version: 1, items: [run("completed")] }));
  expect(view.result.current.items).toEqual([]);
  expect(view.result.current.scope).toBe(2); expect(notify).not.toHaveBeenCalled();
});

it("an old mutation cannot replace the new space or release its pending mutation", async () => {
  const old = deferred<AgentRunV1>(), current = deferred<AgentRunV1>();
  controlRun.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const view = renderHook(() => useAgentGoals("idle", vi.fn()));
  await waitFor(() => expect(view.result.current.items).toHaveLength(1));
  let oldChange!: Promise<boolean>;
  act(() => { oldChange = view.result.current.change(run(), "pause"); });
  state.scope = 2; view.rerender();
  await waitFor(() => expect(view.result.current.pending).toBeNull());
  let currentChange!: Promise<boolean>;
  act(() => { currentChange = view.result.current.change(run(), "pause"); });
  await act(async () => { old.resolve(run("cancelled")); await oldChange; });
  expect(view.result.current.pending).toBe("goal");
  expect(view.result.current.items[0].status).toBe("running");
  await act(async () => { current.resolve(run("paused")); await currentChange; });
  expect(view.result.current.pending).toBeNull(); expect(view.result.current.items[0].status).toBe("paused");
});

it("refreshes a conflicting revision and lets the user retry against the actual receipt", async () => {
  const view = renderHook(() => useAgentGoals("idle", vi.fn()));
  await waitFor(() => expect(view.result.current.items).toHaveLength(1));
  controlRun.mockRejectedValueOnce(new Error("要求已变化"));
  listRuns.mockResolvedValue({ version: 1, items: [run("running", 2)] });
  await act(async () => { expect(await view.result.current.change(run(), "pause")).toBe(false); });
  expect(view.result.current.items[0].revision).toBe(2);
  expect(view.result.current.error).toContain("核对最新状态");
  controlRun.mockResolvedValue(run("paused", 2));
  await act(async () => { await view.result.current.change(view.result.current.items[0], "pause"); });
  expect(controlRun.mock.calls[1][0].request).toEqual({ expectedRevision: 2, action: "pause" });
});

it("still collects a paused child's receipt without opening a surface or repeating notifications", async () => {
  vi.useFakeTimers();
  const paused = run("paused");
  paused.operations = [{ operationId: "operation", runId: "goal", revision: 1,
    scope: { workspaceId: "space", userId: "user" }, capability: "note_overview_generate", execution: { kind: "job", id: "job" },
    status: "running", lastEventSeq: 0, result: null, error: null }];
  listRuns.mockResolvedValue({ version: 1, items: [paused] });
  const onReady = vi.fn(); const view = renderHook(() => useAgentGoals("idle", onReady));
  await act(async () => { await Promise.resolve(); });
  listRuns.mockResolvedValue({ version: 1, items: [{ ...paused, operations: [] }] });
  const calls = listRuns.mock.calls.length;
  await act(async () => { vi.advanceTimersByTime(2_000); await Promise.resolve(); });
  expect(listRuns.mock.calls.length).toBeGreaterThan(calls);
  expect(view.result.current.items[0].status).toBe("paused"); expect(onReady).not.toHaveBeenCalled();
  listRuns.mockResolvedValue({ version: 1, items: [run("completed")] });
  await act(async () => { await view.result.current.refresh(); await view.result.current.refresh(); });
  expect(notify).toHaveBeenCalledTimes(1); expect(onReady).not.toHaveBeenCalled();
});

it("keeps loaded older tasks across refreshes and retries a failed page without losing its bookmark", async () => {
  const first = { ...run("completed"), runId: "first" }, older = { ...run("completed"), runId: "older" };
  listRuns.mockImplementation(({ query }) => query?.cursor
    ? Promise.resolve({ version: 1, items: [older], nextCursor: null })
    : Promise.resolve({ version: 1, items: [first], nextCursor: "page-2" }));
  const view = renderHook(() => useAgentGoals("idle", vi.fn()));
  await waitFor(() => expect(view.result.current.nextCursor).toBe("page-2"));
  listRuns.mockRejectedValueOnce(new Error("暂时无法翻页"));
  await act(async () => { await view.result.current.loadMore(); });
  expect(view.result.current.moreError).toBe("暂时无法翻页");
  expect(view.result.current.nextCursor).toBe("page-2");
  await act(async () => { await view.result.current.loadMore(); });
  expect(view.result.current.items.map(item => item.runId)).toEqual(["first", "older"]);
  expect(view.result.current.nextCursor).toBeNull();
  await act(async () => { await view.result.current.refresh(); });
  expect(view.result.current.items.map(item => item.runId)).toEqual(["first", "older"]);
  expect(view.result.current.nextCursor).toBeNull();
});

it("does not let an older pagination response overwrite a locally controlled task", async () => {
  const olderPage = deferred<unknown>();
  listRuns.mockImplementation(({ query }) => query?.cursor ? olderPage.promise
    : Promise.resolve({ version: 1, items: [run("completed")], nextCursor: "page-2" }));
  const view = renderHook(() => useAgentGoals("idle", vi.fn()));
  await waitFor(() => expect(view.result.current.nextCursor).toBe("page-2"));
  let loading!: Promise<void>;
  act(() => { loading = view.result.current.loadMore(); });
  const paused = { ...run("paused"), runId: "older" };
  controlRun.mockResolvedValueOnce(paused);
  await act(async () => { await view.result.current.change(paused, "pause"); });
  await act(async () => { olderPage.resolve({ version: 1, items: [{ ...paused, status: "running" }], nextCursor: null }); await loading; });
  expect(view.result.current.items.find(item => item.runId === "older")?.status).toBe("paused");
});

it("discards an older page after switching spaces without releasing the new space's pending page", async () => {
  const old = deferred<unknown>(), current = deferred<unknown>();
  listRuns.mockImplementation(({ query }) => query?.cursor ? (state.scope === 1 ? old.promise : current.promise)
    : Promise.resolve({ version: 1, items: [run("completed")], nextCursor: "page-2" }));
  const view = renderHook(() => useAgentGoals("idle", vi.fn()));
  await waitFor(() => expect(view.result.current.nextCursor).toBe("page-2"));
  let oldPage!: Promise<void>;
  act(() => { oldPage = view.result.current.loadMore(); });
  state.scope = 2; view.rerender();
  await waitFor(() => expect(view.result.current.nextCursor).toBe("page-2"));
  let newPage!: Promise<void>;
  act(() => { newPage = view.result.current.loadMore(); });
  await act(async () => { old.resolve({ version: 1, items: [{ ...run("completed"), runId: "private-old" }], nextCursor: null }); await oldPage; });
  expect(view.result.current.moreLoading).toBe(true);
  expect(view.result.current.items.some(item => item.runId === "private-old")).toBe(false);
  await act(async () => { current.resolve({ version: 1, items: [], nextCursor: null }); await newPage; });
  expect(view.result.current.moreLoading).toBe(false);
});
