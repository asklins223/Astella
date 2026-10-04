// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearCompanionTaskWatches, watchCompanionTask } from "../companion-notification-tasks";
import { useCompanionNotifications } from "../companion-notifications";
import { useRoomStore } from "../../../app/room-store";
beforeEach(() => { vi.useFakeTimers(); useRoomStore.setState({ workspaceScopeRevision: 3 }); useCompanionNotifications.setState({ items: [] }); });
afterEach(() => { clearCompanionTaskWatches(); vi.useRealTimers(); });
it("hands off a view's task and notifies once when the saved result becomes ready", async () => {
  const read = vi.fn().mockResolvedValueOnce({ status: "running" }).mockResolvedValue({ status: "ready" });
  const watch = { id: "task", scope: 3, title: "速看", read, open: vi.fn() }; watchCompanionTask(watch); watchCompanionTask(watch);
  await vi.advanceTimersByTimeAsync(4_800); expect(read).toHaveBeenCalledTimes(2); expect(useCompanionNotifications.getState().items).toHaveLength(1);
  watchCompanionTask(watch); await vi.advanceTimersByTimeAsync(20_000); expect(read).toHaveBeenCalledTimes(2);
});
it("ignores an old workspace's late task result and does not leak its action", async () => {
  let resolve!: (value: { status: string }) => void;
  watchCompanionTask({ id: "task", scope: 3, title: "速看", read: () => new Promise(done => { resolve = done; }), open: vi.fn() });
  await vi.advanceTimersByTimeAsync(2_400); useRoomStore.setState({ workspaceScopeRevision: 4 }); clearCompanionTaskWatches(4);
  resolve({ status: "ready" }); await Promise.resolve(); expect(useCompanionNotifications.getState().items).toEqual([]);
});
it("retries network failures without calling them a failed AI task", async () => {
  const read = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValue({ status: "failed" });
  watchCompanionTask({ id: "task", scope: 3, title: "速看", read, open: vi.fn() });
  await vi.advanceTimersByTimeAsync(2_400); expect(useCompanionNotifications.getState().items).toEqual([]);
  await vi.advanceTimersByTimeAsync(4_800); expect(useCompanionNotifications.getState().items[0].audio?.clip).toBe("task-failed");
});
