// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CardGenerationSurface } from "../CardGenerationSurface";
import { useRoomStore } from "../../app/room-store";

const NOTE = "11111111-1111-4111-8111-111111111111", OLD_VERSION = "22222222-2222-4222-8222-222222222222";
const NEW_VERSION = "33333333-3333-4333-8333-333333333333", OLD_RUN = "aaaaaaaa-1111-4111-8111-111111111111", NEW_RUN = "bbbbbbbb-2222-4222-8222-222222222222";
const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 1, data });
function fixture(status: string) {
  const state = { status, cancelBarrier: Promise.resolve(), startBarrier: Promise.resolve(), noteFails: false, startFails: false };
  const snapshot = (runId: string) => ({ version: 1, runId, noteId: NOTE, noteVersionId: runId === NEW_RUN ? NEW_VERSION : OLD_VERSION,
    status: runId === NEW_RUN ? "authoring" : state.status, cardContentEpoch: 1, currentPlanVersion: 1, reviewDraftRevision: 4,
    sourceOutdated: runId === OLD_RUN, sourceRef: { noteId: NOTE, noteVersionId: runId === NEW_RUN ? NEW_VERSION : OLD_VERSION },
    progress: { authored: 0, plannedCards: 4, gatePassed: 0, gateFailed: 0 }, recovery: null,
    createdAt: "2026-10-03T06:00:00Z", updatedAt: "2026-10-03T06:00:00Z" });
  const api = {
    workspace: { getAiSettings: vi.fn(async () => ({ ok: true as const, data: { requiresConsent: true, consentVersion: "ai-consent-v1", dataPolicy: { sendToExternal: true } } })) },
    note: {
      get: vi.fn(async () => state.noteFails ? { ok: false as const, error: { code: "network_unavailable", safeMessageKey: "读取笔记失败" } } : ok({ noteId: NOTE, currentVersionId: NEW_VERSION, title: "更新后的笔记" })),
      cardGeneration: {
        getRun: vi.fn(async ({ runId }: { runId: string }) => ok(snapshot(runId))),
        getCandidates: vi.fn(async () => ok({ candidates: [], practiceQuota: { requiredCount: 0, metCount: 0 } })),
        close: vi.fn(async () => { state.status = "closed_without_activation"; return ok({ runId: OLD_RUN, status: state.status, reviewDraftRevision: 5 }); }),
        cancel: vi.fn(async () => { await state.cancelBarrier; state.status = "cancelled"; return ok({ runId: OLD_RUN, status: state.status }); }),
        start: vi.fn(async () => {
          await state.startBarrier;
          return state.startFails ? { ok: false as const, error: { code: "generation_concurrency_limit", safeMessageKey: "生成并发已达上限" } } : ok({ runId: NEW_RUN });
        }),
      },
    },
    subscriptions: { subscribe: vi.fn(async () => ok({ subscriptionId: "sub" })), onEvent: vi.fn(() => () => {}), unsubscribe: vi.fn(async () => ok(null)) },
  };
  window.astella = api as unknown as typeof window.astella;
  useRoomStore.setState({ activeCardGenerationRunId: OLD_RUN, activeNoteRef: { noteId: NOTE, noteVersionId: OLD_VERSION } });
  render(<CardGenerationSurface />);
  return { api, state };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); useRoomStore.setState({ activeCardGenerationRunId: null, activeNoteRef: null, surface: null, returnTarget: null }); });

describe("学习卡重生成接到最新保存版本", () => {
  it("外发未授权时不结束旧审核、不创建队列任务，直接指向授权设置", async () => {
    const { api } = fixture("needs_attention");
    api.workspace.getAiSettings.mockResolvedValue({ ok: true, data: { requiresConsent: true, consentVersion: "ai-consent-v1", dataPolicy: { sendToExternal: false } } });
    fireEvent.click(await screen.findByRole("button", { name: "重新生成学习卡" }));
    await waitFor(() => expect(useRoomStore.getState().settingsAttention).toBe("ai-consent"));
    expect(api.note.cardGeneration.close).not.toHaveBeenCalled();
    expect(api.note.cardGeneration.start).not.toHaveBeenCalled();
    expect(useRoomStore.getState().activeCardGenerationRunId).toBe(OLD_RUN);
  });
  it.each(["cancelled", "failed", "stale", "closed_without_activation", "no_cards_recommended", "activated", "review_ready", "needs_attention"])("%s 页面直接新建一份，而不是把人送回旧任务", async status => {
    const { api } = fixture(status);
    const button = await screen.findByRole("button", { name: "重新生成学习卡" });
    fireEvent.click(button);
    await waitFor(() => expect(api.note.cardGeneration.start).toHaveBeenCalledTimes(1));
    expect(api.note.cardGeneration.start).toHaveBeenCalledWith(expect.objectContaining({ noteId: NOTE, request: expect.objectContaining({ noteVersionId: NEW_VERSION, sourceScope: { kind: "whole_note" } }) }));
    expect(api.note.cardGeneration.close).toHaveBeenCalledTimes(["review_ready", "needs_attention"].includes(status) ? 1 : 0);
    if (["review_ready", "needs_attention"].includes(status)) {
      expect(api.note.cardGeneration.close).toHaveBeenCalledWith(expect.objectContaining({ runId: OLD_RUN, expectedReviewDraftRevision: 4 }));
      expect(api.note.cardGeneration.close.mock.invocationCallOrder[0]).toBeLessThan(api.note.cardGeneration.start.mock.invocationCallOrder[0]);
    }
    await waitFor(() => expect(useRoomStore.getState().activeCardGenerationRunId).toBe(NEW_RUN));
    expect(useRoomStore.getState().activeNoteRef?.noteVersionId).toBe(NEW_VERSION);
    await screen.findByRole("heading", { name: "正在做一套学习卡" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "重新生成学习卡" })).toBeNull());
  });

  it("停止得到服务端回执后才出现重生成，连点不重复停止或启动", async () => {
    const { api, state } = fixture("authoring");
    let stopped!: () => void, started!: () => void;
    state.cancelBarrier = new Promise<void>(resolve => { stopped = resolve; });
    state.startBarrier = new Promise<void>(resolve => { started = resolve; });
    const stop = await screen.findByRole("button", { name: "停止生成" });
    expect(screen.queryByRole("button", { name: "重新生成学习卡" })).toBeNull();
    fireEvent.click(stop); fireEvent.click(stop);
    await waitFor(() => expect(api.note.cardGeneration.cancel).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "重新生成学习卡" })).toBeNull();
    await act(async () => stopped());
    const regenerate = await screen.findByRole("button", { name: "重新生成学习卡" });
    fireEvent.click(regenerate); fireEvent.click(regenerate);
    await waitFor(() => expect(api.note.cardGeneration.start).toHaveBeenCalledTimes(1));
    await act(async () => started());
    await waitFor(() => expect(useRoomStore.getState().activeCardGenerationRunId).toBe(NEW_RUN));
  });

  it("读取最新笔记失败时不结束旧审核", async () => {
    const { api, state } = fixture("review_ready");
    const regenerate = await screen.findByRole("button", { name: "重新生成学习卡" });
    state.noteFails = true;
    fireEvent.click(regenerate);
    await screen.findByText(/这一步没成功/);
    expect(api.note.cardGeneration.close).not.toHaveBeenCalled();
    expect(api.note.cardGeneration.start).not.toHaveBeenCalled();
    expect(useRoomStore.getState().activeCardGenerationRunId).toBe(OLD_RUN);
  });

  it("结束旧审核后新任务被拒绝，页面仍可再次生成", async () => {
    const { api, state } = fixture("review_ready"); state.startFails = true;
    fireEvent.click(await screen.findByRole("button", { name: "重新生成学习卡" }));
    await screen.findByText(/这一步没成功/);
    const retry = screen.getByRole<HTMLButtonElement>("button", { name: "重新生成学习卡" });
    expect(retry.disabled).toBe(false);
    expect(state.status).toBe("closed_without_activation");
    state.startFails = false; fireEvent.click(retry);
    await waitFor(() => expect(api.note.cardGeneration.start).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(useRoomStore.getState().activeCardGenerationRunId).toBe(NEW_RUN));
  });
});
