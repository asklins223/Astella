// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NoteTargetRef } from "../../../../app/room-store";
import { useNotebookGoalResult } from "../use-notebook-goal-result";

const state = vi.hoisted(() => ({ scope: 1 }));
vi.mock("../../../../app/room-store", () => ({ useRoomStore: Object.assign(
  (select: (value: { workspaceScopeRevision: number }) => unknown) => select({ workspaceScopeRevision: state.scope }),
  { getState: () => ({ workspaceScopeRevision: state.scope }) },
) }));
vi.mock("../../../../app/desktop-client", () => ({ createRequestMeta: () => ({}),
  unwrapGatewayResult: (value: unknown) => value, gatewayErrorMessage: (error: Error) => error.message }));

const getOverview = vi.fn(), getArtifact = vi.fn(), startTask = vi.fn();
const target: NonNullable<NoteTargetRef["learningResult"]> = { kind: "note_overview", artifactId: "saved", taskId: "job" };
const receipt = (id = "saved") => ({ taskId: "job", noteId: "note", overview: { overviewId: id, body: "已保存的内容" } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
beforeEach(() => {
  state.scope = 1; vi.clearAllMocks();
  getOverview.mockResolvedValue(receipt());
  Object.defineProperty(window, "astella", { configurable: true, value: {
    noteOverview: { getTask: getOverview, startTask }, noteLearningArtifact: { getTask: getArtifact, startTask },
  } });
});
afterEach(cleanup);

it("waits for the selected receipt and rejects another artifact; retry only re-reads the same task", async () => {
  const pending = deferred<unknown>();
  getOverview.mockReturnValueOnce(pending.promise);
  const view = renderHook(() => useNotebookGoalResult("note", target, { current: 4 }));
  expect(view.result.current.loading).toBe(true);
  expect(view.result.current.result).toBeNull();
  await act(async () => pending.resolve(receipt("different")));
  expect(view.result.current.loading).toBe(false);
  expect(view.result.current.error).toContain("这份速看暂时没有读到");
  expect(view.result.current.result).toBeNull();
  act(() => view.result.current.retry());
  await waitFor(() => expect(view.result.current.result?.kind).toBe("note_overview"));
  expect(getOverview.mock.calls.map(([input]) => input.taskId)).toEqual(["job", "job"]);
  expect(startTask).not.toHaveBeenCalled();
});

it("discards a previous space's delayed receipt and error", async () => {
  const previous = deferred<unknown>();
  getOverview.mockReturnValueOnce(previous.promise);
  const view = renderHook(() => useNotebookGoalResult("note", target, { current: 4 }));
  state.scope = 2; view.rerender();
  await waitFor(() => expect(view.result.current.result?.kind).toBe("note_overview"));
  await act(async () => previous.resolve(receipt("different")));
  expect(view.result.current.error).toBeNull();
  expect(view.result.current.result?.kind === "note_overview" && view.result.current.result.overview.overviewId).toBe("saved");
});

it("clears the selected receipt immediately when ordinary note navigation releases it", async () => {
  const view = renderHook(({ requested }: { requested: NoteTargetRef["learningResult"] }) =>
    useNotebookGoalResult("note", requested, { current: 4 }), { initialProps: { requested: target as NoteTargetRef["learningResult"] } });
  await waitFor(() => expect(view.result.current.result).not.toBeNull());
  view.rerender({ requested: undefined });
  expect(view.result.current.result).toBeNull();
  expect(view.result.current.loading).toBe(false);
  expect(view.result.current.error).toBeNull();
});

it("opens an exact saved interactive artifact using its task instead of the first gallery page", async () => {
  getArtifact.mockResolvedValue({ taskId: "artifact-job", noteId: "note", artifact: { artifactId: "old-artifact" } });
  const view = renderHook(() => useNotebookGoalResult("note", { kind: "note_dynamic_artifact", taskId: "artifact-job", artifactId: "old-artifact" }, { current: 4 }));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  expect(view.result.current.result?.kind === "note_dynamic_artifact" && view.result.current.result.artifact.artifactId).toBe("old-artifact");
  expect(getOverview).not.toHaveBeenCalled();
  expect(startTask).not.toHaveBeenCalled();
});
