import { afterEach, expect, it, vi } from "vitest";
import type { AstellaDesktopApiM2 } from "@astella/shared/desktop-ipc-contracts";
import { readNotebookProjection } from "../notebook-projection";

afterEach(() => vi.useRealTimers());
it("reads a selected note and its independent state in two network rounds", async () => {
  vi.useFakeTimers();
  const calls: string[] = [];
  const delay = <T,>(name: string, data: T) => vi.fn(async () => {
    calls.push(name);
    await new Promise(resolve => setTimeout(resolve, 200));
    return { ok: true as const, data };
  });
  const api = {
    contract: { enabledRoutes: ["note.cardGeneration"] },
    room: { getProjection: delay("room", { primaryFocus: { state: "empty" }, activeGenerationSummary: { state: "data", data: [] } }) },
    capabilities: { get: delay("capabilities", {}) },
    note: { get: delay("note", { noteId: "selected", sourceId: "source" }), cardGeneration: { latestRun: delay("latest", null) } },
    source: { get: delay("source", { sourceId: "source" }) },
    objective: { list: delay("objective", { items: [] }) },
    review: { listNoteSubscriptions: delay("subscriptions", { items: [] }) },
    noteLearningRound: { open: delay("round", null), history: delay("history", { items: [] }), route: vi.fn() },
  } as unknown as AstellaDesktopApiM2;
  const reading = readNotebookProjection({ api, workspaceEpoch: 7, noteId: "selected", readLegacyRoute: false, legacyRouteRequestedFor: null });
  expect(calls).toEqual(["room", "capabilities", "note"]);
  await vi.advanceTimersByTimeAsync(200);
  expect(calls).toEqual(["room", "capabilities", "note", "source", "latest", "objective", "subscriptions", "round", "history"]);
  await vi.advanceTimersByTimeAsync(200);
  expect((await reading).note.noteId).toBe("selected");
  expect(api.noteLearningRound.route).not.toHaveBeenCalled();
});
