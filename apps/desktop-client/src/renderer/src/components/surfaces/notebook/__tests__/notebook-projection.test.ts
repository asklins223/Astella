import { afterEach, expect, it, vi } from "vitest";
import type { AstellaDesktopApiM2 } from "@astella/shared/desktop-ipc-contracts";
import { readNotebookProjection } from "../shell/notebook-projection.ts";

afterEach(() => vi.useRealTimers());
it("reads a selected note and its source in two network rounds", async () => {
  vi.useFakeTimers();
  const calls: string[] = [];
  const delay = <T,>(name: string, data: T) => vi.fn(async () => {
    calls.push(name);
    await new Promise(resolve => setTimeout(resolve, 200));
    return { ok: true as const, data };
  });
  const api = {
    contract: { enabledRoutes: ["note.detail"] },
    room: { getProjection: delay("room", { primaryFocus: { state: "empty" } }) },
    capabilities: { get: delay("capabilities", {}) },
    note: { get: delay("note", { noteId: "selected", sourceId: "source" }) },
    source: { get: delay("source", { sourceId: "source" }) },
  } as unknown as AstellaDesktopApiM2;
  const reading = readNotebookProjection({ api, workspaceEpoch: 7, noteId: "selected" });
  expect(calls).toEqual(["note"]);
  await vi.advanceTimersByTimeAsync(200);
  expect(calls).toEqual(["note", "source"]);
  await vi.advanceTimersByTimeAsync(200);
  expect((await reading).note.noteId).toBe("selected");
});

it("opens a saved note when retired home or unrelated capability endpoints are unavailable", async () => {
  const unrelated = vi.fn(async () => { throw new Error("retired endpoint"); });
  const api = { room: { getProjection: unrelated }, capabilities: { get: unrelated },
    note: { get: vi.fn(async () => ({ ok: true, data: { noteId: "saved", sourceId: "gone-source" } })) },
    source: { get: vi.fn(async () => { throw new Error("source unavailable"); }) },
  } as unknown as AstellaDesktopApiM2;
  const result = await readNotebookProjection({ api, workspaceEpoch: 7, noteId: "saved" });
  expect(result.note.noteId).toBe("saved");
  expect(result.source).toBeNull(); expect(result.sourceFailure).toBeTruthy();
  expect(unrelated).not.toHaveBeenCalled();
});
