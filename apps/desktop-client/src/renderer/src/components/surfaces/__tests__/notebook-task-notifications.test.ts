// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { prepareNotebookTaskNotification } from "../notebook/notebook-task-notifications";
const state = vi.hoisted(() => ({ scope: 1 }));
const watch = vi.hoisted(() => vi.fn());
const publish = vi.hoisted(() => vi.fn());
vi.mock("../../../app/room-store", () => ({ useRoomStore: { getState: () => ({ workspaceScopeRevision: state.scope }) } }));
vi.mock("../../companion/companion-notification-tasks", () => ({ watchCompanionTask: watch }));
vi.mock("../../companion/companion-events", () => ({ publishCompanionRecordsChanged: publish }));
beforeEach(() => { state.scope = 1; vi.clearAllMocks(); Object.defineProperty(window, "astella", {
  configurable: true, value: { noteOverview: { getTask: vi.fn() } },
}); });
const note = { noteId: "note", currentVersionId: "version", title: "光合作用" };
it("an Agent-owned task refreshes the journal without registering a duplicate child notification", () => {
  prepareNotebookTaskNotification(note, undefined)({ taskId: "job", status: "pending", agentRunId: "goal" }, "overview");
  expect(publish).toHaveBeenCalledOnce(); expect(watch).not.toHaveBeenCalled();
});
it("a late receipt from another space cannot refresh the current journal; saved legacy tasks still have a watcher", () => {
  const accept = prepareNotebookTaskNotification(note, undefined); state.scope = 2;
  accept({ taskId: "job", status: "pending", agentRunId: "goal" }, "overview");
  expect(publish).not.toHaveBeenCalled(); expect(watch).not.toHaveBeenCalled();
  prepareNotebookTaskNotification(note, undefined)({ taskId: "old", status: "pending" }, "overview");
  expect(watch).toHaveBeenCalledOnce();
});
