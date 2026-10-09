// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { noteDetailV1Schema } from "@astella/shared/note-projection-contracts";
import { noteOverviewTaskV1Schema, type NoteOverviewV1 } from "@astella/shared/note-overview-contracts";
import { useNotebookOverview } from "../use-notebook-overview";
import { useNotebookLearningView } from "../use-notebook-learning-view";

afterEach(() => { cleanup(); vi.useRealTimers(); });

function overviewFixture() {
  const noteId = "11111111-4111-4111-8111-111111111111";
  const versionId = "22222222-4222-4222-8222-222222222222";
  const createdAt = "2026-09-30T00:00:00.000Z";
  const note = noteDetailV1Schema.parse({
    version: 1, noteId, workspaceId: noteId, title: "正在读的笔记", titleSource: "manual",
    sourceId: null, currentVersionId: versionId, shareScope: "private", revision: versionId, snapshotAt: createdAt,
    currentVersion: { versionId, noteId, versionNo: 1, contentHash: "a".repeat(32), createdAt, updatedAt: createdAt, blocks: [] },
    permissions: { canRead: true, canEdit: true, canSave: true, canShare: true },
  });
  const ready = noteOverviewTaskV1Schema.parse({
    taskId: "33333333-4333-4333-8333-333333333333", noteId, noteVersionId: versionId,
    status: "ready", failureReason: null, createdAt,
    overview: {
      overviewId: "44444444-4444-4444-8444-444444444444", noteId, noteVersionId: versionId, noteVersionNumber: 1,
      body: "这是基于已存版本整理的重点。", references: [], coverage: { totalBlocks: 0, textBlocksRead: 0, imageBlocksNotRead: 0 },
      generationJobId: "55555555-4555-4555-8555-555555555555", sourceMessageId: null, conversationId: null, versionState: "current", createdAt,
    },
  });
  return { noteId, note, ready };
}

it("速看外发未授权时只打开设置，不创建任务", async () => {
  const { note } = overviewFixture();
  const startTask = vi.fn();
  Object.defineProperty(window, "astella", { configurable: true, value: {
    workspace: { getAiSettings: vi.fn(async () => ({ ok: true, data: { requiresConsent: true, consentVersion: "signed", dataPolicy: { sendToExternal: false } } })) },
    noteOverview: { latestTask: vi.fn(async () => ({ ok: true, data: { task: null } })), startTask },
  } });
  const view = renderHook(() => useNotebookOverview({ note, epochRef: { current: 1 } }));
  await act(async () => view.result.current.startNoteOverviewTask(false));
  expect(startTask).not.toHaveBeenCalled();
  expect(view.result.current.overviewTaskStarting).toBe(false);
});

it("关起学习页继续读，速看迟到完成只更新结果；主动打开才切回速看", async () => {
  vi.useFakeTimers();
  const { noteId, note, ready } = overviewFixture();
  const ok = <T,>(data: T) => ({ ok: true, data });
  const latestTask = vi.fn(async () => ok({ version: 1, task: null }));
  const getTask = vi.fn(async () => ok(ready));
  Object.defineProperty(window, "astella", { configurable: true, value: { workspace: { getAiSettings: vi.fn(async () => ({ ok: true as const, data: { requiresConsent: true, consentVersion: "ai-consent-v1", dataPolicy: { sendToExternal: true } } })) }, noteOverview: {
    latestTask, getTask, startTask: vi.fn(async () => ok({ ...ready, status: "queued", overview: null })),
  } } });
  const epochRef = { current: undefined };
  const scrollRef = createRef<HTMLDivElement>();
  const { result } = renderHook(() => {
    const overview = useNotebookOverview({ note, epochRef });
    const learning = useNotebookLearningView({ noteId, leaf: "reading", recallVisit: 0, scrollRef, inReading: true });
    return { ...overview, ...learning };
  });
  await act(async () => {});
  await act(async () => { result.current.setOverviewOpen(true); result.current.setLearningView("overview"); await result.current.startNoteOverviewTask(false); });
  expect(result.current.learningView).toBe("overview");
  act(() => { result.current.setOverviewOpen(false); result.current.setLearningView("body"); });
  expect(result.current.learningView).toBe("body");
  await act(async () => vi.advanceTimersByTimeAsync(1600));
  expect(result.current.latestNoteOverview?.body).toBe(ready.overview!.body);
  expect(result.current.learningView).toBe("body");
  expect(result.current.overviewOpen).toBe(false);
  expect(latestTask).toHaveBeenCalledOnce(); expect(getTask).toHaveBeenCalledOnce();
  act(() => { result.current.setOverviewOpen(true); result.current.setLearningView("overview"); });
  expect(result.current.learningView).toBe("overview");
  expect(result.current.latestNoteOverview?.overviewId).toBe(ready.overview!.overviewId);
});

it("选中的结果尚未读取时不回退到其他速看；解除选择后重新跟随最新生成", async () => {
  const { noteId, note, ready } = overviewFixture();
  Object.defineProperty(window, "astella", { configurable: true, value: { workspace: { getAiSettings: vi.fn(async () => ({ ok: true as const, data: { requiresConsent: true, consentVersion: "ai-consent-v1", dataPolicy: { sendToExternal: true } } })) }, noteOverview: {
    latestTask: vi.fn(async () => ({ ok: true, data: { version: 1, task: ready } })),
  } } });
  const view = renderHook(({ requestedOverview }: { requestedOverview: NoteOverviewV1 | null | undefined }) =>
    useNotebookOverview({ note, epochRef: { current: undefined }, requestedOverview }),
    { initialProps: { requestedOverview: null as NoteOverviewV1 | null | undefined } });
  await act(async () => {
    view.result.current.setOverviewRows({ noteId, items: [ready.overview!], nextCursor: null });
  });
  expect(view.result.current.taskForCurrentVersion?.status).toBe("ready");
  expect(view.result.current.latestNoteOverview).toBeNull();
  const selected = { ...ready.overview!, overviewId: "66666666-4666-4666-8666-666666666666", body: "从手记选择的旧结果" };
  view.rerender({ requestedOverview: selected });
  expect(view.result.current.latestNoteOverview?.body).toBe("从手记选择的旧结果");
  view.rerender({ requestedOverview: undefined });
  expect(view.result.current.latestNoteOverview?.overviewId).toBe(ready.overview!.overviewId);
});
