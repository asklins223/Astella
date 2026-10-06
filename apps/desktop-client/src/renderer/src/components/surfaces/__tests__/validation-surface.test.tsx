// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopRouteV1 } from "@astella/shared/desktop-ipc-contracts";
import { useRoomStore } from "../../../app/room-store";
import { ValidationSurface } from "../run/validation-surface";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const OBJECTIVE_ID = "22222222-2222-4222-8222-222222222222";
const NOTE_ID = "33333333-3333-4333-8333-333333333333";
const ROUND_ID = "44444444-4444-4444-8444-444444444444";

vi.mock("../run/learning-run-surface", () => ({
  LearningRunSurface: ({ onExit }: { onExit?: (request: { route: DesktopRouteV1; objectiveId?: string; reflectionRoundId?: string }) => void }) => {
    const runId = useRoomStore((state) => state.activeRunId);
    return runId ? <div data-testid="sensitive-player">
      <button onClick={() => onExit?.({ route: { kind: "room.home" }, objectiveId: OBJECTIVE_ID })}>回到这张学习卡</button>
      <button onClick={() => onExit?.({ route: { kind: "note.detail", noteId: NOTE_ID }, reflectionRoundId: ROUND_ID })}>回到这一轮</button>
    </div> : null;
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function ok<T>(data: T) { return { ok: true as const, workspaceEpoch: 7, data }; }
function navigation(route: DesktopRouteV1) {
  return ok({ current: { scope: "workspace" as const, workspaceEpoch: 7, route } });
}
function gateway() {
  const api = {
    learningRun: { getReturnContract: vi.fn(async () => ok({ status: "no_projection_change", returnTargetV2: { kind: "card", objectiveId: OBJECTIVE_ID } })) },
    navigation: {
      resolve: vi.fn(async ({ route }: { route: DesktopRouteV1 }) => {
        expect(screen.queryByTestId("sensitive-player")).toBeNull();
        return navigation(route);
      }),
      go: vi.fn(async ({ route }: { route: DesktopRouteV1 }) => navigation(route)),
    },
  };
  window.astella = api as unknown as typeof window.astella;
  return api;
}

beforeEach(() => {
  useRoomStore.setState({ activeRunId: RUN_ID, activeObjectiveId: null, activeNoteRef: null,
    destination: "validation", viewPreset: "validation", surface: "validation", navigationGuard: null });
});
afterEach(() => { cleanup(); useRoomStore.getState().resetWorkspaceScope(); vi.restoreAllMocks(); });

describe("学习卡作答后的返回", () => {
  it("侧栏先按真实卡片返回目标释放 Player，再打开用户点击的笔记库", async () => {
    const api = gateway();
    render(<ValidationSurface />);
    act(() => useRoomStore.getState().invoke("open-notes"));
    await waitFor(() => expect(useRoomStore.getState().surface).toBe("note-library"));
    expect(api.learningRun.getReturnContract).toHaveBeenCalledWith(expect.objectContaining({ runId: RUN_ID }));
    expect(api.navigation.resolve).toHaveBeenCalledWith(expect.objectContaining({ route: { kind: "room.home" }, learningRunId: RUN_ID }));
    expect(api.navigation.go).toHaveBeenCalledWith(expect.objectContaining({ route: { kind: "room.home" }, learningRunId: RUN_ID }));
    expect(useRoomStore.getState().navigationGuard).toBeNull();
  });

  it("结果直接回到同一张卡，期间没有首页或复习队列的中间帧", async () => {
    const api = gateway();
    const surfaces: Array<string | null> = [];
    const unsubscribe = useRoomStore.subscribe((state) => surfaces.push(state.surface));
    render(<ValidationSurface />);
    fireEvent.click(screen.getByRole("button", { name: "回到这张学习卡" }));
    await waitFor(() => expect(useRoomStore.getState().surface).toBe("objective-detail"));
    expect(useRoomStore.getState().activeObjectiveId).toBe(OBJECTIVE_ID);
    expect(surfaces).not.toContain(null);
    expect(surfaces).not.toContain("review");
    expect(api.navigation.go).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("返回等待期间连续点击采用最后目标，只进行一次主进程释放", async () => {
    const api = gateway();
    const pendingGo = deferred<ReturnType<typeof navigation>>();
    api.navigation.go.mockImplementation(() => pendingGo.promise);
    render(<ValidationSurface />);
    act(() => useRoomStore.getState().invoke("open-objectives"));
    await waitFor(() => expect(api.navigation.go).toHaveBeenCalledTimes(1));
    act(() => {
      useRoomStore.getState().invoke("open-notes");
      useRoomStore.getState().invoke("graph");
    });
    await act(async () => pendingGo.resolve(navigation({ kind: "room.home" })));
    expect(useRoomStore.getState().surface).toBe("graph");
    expect(api.navigation.resolve).toHaveBeenCalledTimes(1);
    expect(api.navigation.go).toHaveBeenCalledTimes(1);
  });

  it("主进程返回完成之前换了工作区，旧目标不再落到新工作区", async () => {
    const api = gateway();
    const pendingGo = deferred<ReturnType<typeof navigation>>();
    api.navigation.go.mockImplementation(() => pendingGo.promise);
    render(<ValidationSurface />);
    fireEvent.click(screen.getByRole("button", { name: "回到这张学习卡" }));
    await waitFor(() => expect(api.navigation.go).toHaveBeenCalledTimes(1));
    act(() => useRoomStore.getState().resetWorkspaceScope());
    await act(async () => pendingGo.resolve(navigation({ kind: "room.home" })));
    expect(useRoomStore.getState().surface).toBeNull();
    expect(useRoomStore.getState().activeObjectiveId).toBeNull();
  });

  it("读取返回目标失败时仍经过主进程确认的房间兜底", async () => {
    const api = gateway();
    api.learningRun.getReturnContract.mockRejectedValue(new Error("target unavailable"));
    render(<ValidationSurface />);
    act(() => useRoomStore.getState().invoke("open-notes"));
    await waitFor(() => expect(useRoomStore.getState().surface).toBe("note-library"));
    expect(api.navigation.resolve).toHaveBeenCalledWith(expect.objectContaining({ route: { kind: "room.home" } }));
    expect(api.navigation.resolve.mock.calls[0][0]).not.toHaveProperty("learningRunId");
  });

  it("主进程无法确认释放时，不重放卡片或侧栏目标", async () => {
    const api = gateway();
    api.navigation.resolve.mockRejectedValue(new Error("navigation unavailable"));
    render(<ValidationSurface />);
    fireEvent.click(screen.getByRole("button", { name: "回到这张学习卡" }));
    await waitFor(() => expect(useRoomStore.getState().surface).toBeNull());
    expect(useRoomStore.getState().activeObjectiveId).toBeNull();
    expect(api.navigation.go).not.toHaveBeenCalled();
  });

  it("笔记学习仍回到原来的笔记与回想轮次", async () => {
    gateway();
    render(<ValidationSurface />);
    fireEvent.click(screen.getByRole("button", { name: "回到这一轮" }));
    await waitFor(() => expect(useRoomStore.getState().surface).toBe("notebook"));
    expect(useRoomStore.getState().activeNoteRef).toEqual({ noteId: NOTE_ID, noteVersionId: null, mode: "preview", learningRoundId: ROUND_ID });
  });
});
