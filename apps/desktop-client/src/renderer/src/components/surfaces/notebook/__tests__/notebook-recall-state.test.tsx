// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { noteDetailV1Schema } from "@ailearn/shared/note-projection-contracts";
import { noteRecallRecordV1Schema, type NoteRecallRecordV1 } from "@ailearn/shared/note-recall-contracts";
import { useNotebookRecallState } from "../use-notebook-recall-state";

const noteId = "11111111-4111-4111-8111-111111111111";
const versionId = "22222222-4222-4222-8222-222222222222";
const date = "2026-09-30T00:00:00.000Z";
const note = noteDetailV1Schema.parse({ version: 1, noteId, workspaceId: noteId, title: "复利", titleSource: "manual", sourceId: null, currentVersionId: versionId,
  shareScope: "private", revision: versionId, snapshotAt: date,
  currentVersion: { versionId, noteId, versionNo: 1, contentHash: "a".repeat(32), createdAt: date, updatedAt: date, blocks: [] },
  permissions: { canRead: true, canEdit: true, canSave: true, canShare: true } });
const record = (tail = "333333333333", changes: Partial<NoteRecallRecordV1> = {}) => noteRecallRecordV1Schema.parse({
  recallId: `33333333-4333-4333-8333-${tail}`, noteId, noteVersionId: versionId, noteVersionNumber: 1, sectionOrdinal: 2, sectionTitle: "复利",
  question: "为什么下一轮的本金会增加？", answerTruncated: false, selfReport: null, reflection: null, state: "waiting", versionState: "current",
  sourceMessageId: null, conversationId: null, hintSourceMessageId: null, hintConversationId: null,
  createdAt: date, hintViewedAt: null, revealedAt: null, reportedAt: null, ...changes });
const ok = <T,>(data: T) => ({ ok: true, data });
const page = (items: NoteRecallRecordV1[]) => ok({ version: 1, items, nextCursor: null });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function install(input: { list?: ReturnType<typeof vi.fn>; start?: ReturnType<typeof vi.fn>; act?: ReturnType<typeof vi.fn> } = {}) {
  const api = { list: vi.fn(async () => page([])), start: vi.fn(async () => ok(record())), act: vi.fn(async () => ok(record())), ...input };
  Object.defineProperty(window, "ailearn", { configurable: true, value: { noteRecall: api } });
  return api;
}
const epochRef = { current: undefined };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("首次记录未加载时点击会等待并恢复已有问题，连点不会新建重复任务", async () => {
  const pending = deferred<ReturnType<typeof page>>();
  const api = install({ list: vi.fn(() => pending.promise) });
  const view = renderHook(() => useNotebookRecallState({ note, epochRef }));
  let first!: Promise<void>;
  act(() => { first = view.result.current.start(); void view.result.current.start(); });
  expect(view.result.current.busy).toBe("start"); expect(api.start).not.toHaveBeenCalled();
  await act(async () => { pending.resolve(page([record()])); await first; });
  expect(view.result.current.active?.recallId).toBe(record().recallId);
  expect(view.result.current.visit).toBe(1); expect(view.result.current.busy).toBeNull(); expect(api.start).not.toHaveBeenCalled();
});

it("显式换题可以先于历史读数完成；迟到列表保留新回执且不更改当前题", async () => {
  const pending = deferred<ReturnType<typeof page>>();
  const created = record("444444444444");
  install({ list: vi.fn(() => pending.promise), start: vi.fn(async () => ok(created)) });
  const view = renderHook(() => useNotebookRecallState({ note, epochRef }));
  await act(async () => { await view.result.current.start(true); });
  await act(async () => { pending.resolve(page([record()])); });
  expect(view.result.current.records.map(row => row.recallId)).toEqual([created.recallId, record().recallId]);
  expect(view.result.current.active?.recallId).toBe(created.recallId); expect(view.result.current.visit).toBe(1);
});

it("后台保存别的问题只加入历史，同一题的回执也不会新开一次访问", async () => {
  install({ list: vi.fn(async () => page([record()])) });
  const view = renderHook(() => useNotebookRecallState({ note, epochRef })); await act(async () => {});
  act(() => view.result.current.open(record(), "history"));
  const unrelated = record("555555555555");
  act(() => window.dispatchEvent(new CustomEvent("ailearn:note-recall-saved", { detail: { noteId, record: unrelated } })));
  expect(view.result.current.active?.recallId).toBe(record().recallId); expect(view.result.current.presentation).toBe("history");
  const revealed = record("333333333333", { state: "revealed", answer: "利息加入本金。", revealedAt: date });
  act(() => window.dispatchEvent(new CustomEvent("ailearn:note-recall-saved", { detail: { noteId, record: revealed } })));
  expect(view.result.current.active?.answer).toBe("利息加入本金。"); expect(view.result.current.visit).toBe(1);
});

it("离开后迟到的动作结果保存记录而不再打开；切换版本的旧结果不污染新状态", async () => {
  const action = deferred<ReturnType<typeof ok<NoteRecallRecordV1>>>();
  install({ act: vi.fn(() => action.promise) });
  const view = renderHook(({ current }) => useNotebookRecallState({ note: current, epochRef }), { initialProps: { current: note } }); await act(async () => {});
  act(() => view.result.current.open(record()));
  let request!: Promise<void>;
  act(() => { request = view.result.current.act({ kind: "reveal" }); view.result.current.close(); });
  await act(async () => { action.resolve(ok(record("333333333333", { state: "revealed", answer: "真实依据。", revealedAt: date }))); await request; });
  expect(view.result.current.active).toBeNull(); expect(view.result.current.records[0]?.answer).toBe("真实依据。");
  const newStart = deferred<ReturnType<typeof ok<NoteRecallRecordV1>>>();
  install({ start: vi.fn(() => newStart.promise) });
  act(() => { request = view.result.current.start(true); });
  view.rerender({ current: { ...note, currentVersionId: "66666666-4666-4666-8666-666666666666" } });
  await act(async () => { newStart.resolve(ok(record())); await request; });
  expect(view.result.current.active).toBeNull(); expect(view.result.current.records).toEqual([]); expect(view.result.current.busy).toBeNull();
});

it("历史读取失败不偷偷创建题目；重试成功后恢复已有题，缺少动作接口给出真实失败", async () => {
  const api = install({ list: vi.fn().mockRejectedValueOnce(new Error("网络断开")).mockRejectedValueOnce(new Error("仍未连上")).mockResolvedValue(page([record()])) });
  const view = renderHook(() => useNotebookRecallState({ note, epochRef })); await act(async () => {});
  expect(view.result.current.error).toBeTruthy();
  await act(async () => { await view.result.current.start(); });
  expect(view.result.current.active).toBeNull(); expect(api.start).not.toHaveBeenCalled();
  await act(async () => { await view.result.current.start(); });
  expect(view.result.current.active?.recallId).toBe(record().recallId); expect(api.start).not.toHaveBeenCalled();
  Object.defineProperty(window, "ailearn", { configurable: true, value: {} });
  await act(async () => { await view.result.current.act({ kind: "reveal" }); });
  expect(view.result.current.error).toContain("可以重试"); expect(view.result.current.active?.answer).toBeUndefined();
});

it("往返正文和换题保留各自的关键词，只有已报告的真实回执归档本地输入", async () => {
  const api = install({ list: vi.fn(async () => page([record()])) });
  const view = renderHook(() => useNotebookRecallState({ note, epochRef })); await act(async () => {});
  act(() => { view.result.current.open(record()); view.result.current.setReflection("本金、上一轮利息"); });
  act(() => { view.result.current.close(); view.result.current.open(record("444444444444")); view.result.current.setReflection("第二题关键词"); });
  act(() => view.result.current.open(record()));
  expect(view.result.current.reflection).toBe("本金、上一轮利息");
  const revealed = record("333333333333", { state: "revealed", answer: "利息加入本金。", revealedAt: date });
  act(() => window.dispatchEvent(new CustomEvent("ailearn:note-recall-saved", { detail: { noteId, record: revealed } })));
  expect(view.result.current.reflection).toBe("本金、上一轮利息");
  api.act.mockRejectedValueOnce(new Error("断线"));
  await act(async () => { await view.result.current.act({ kind: "self_report", value: "remembered", reflection: view.result.current.reflection }); });
  act(() => { view.result.current.close(); view.result.current.open(record()); });
  expect(view.result.current.reflection).toBe("本金、上一轮利息");
  const reported = record("333333333333", { state: "reported", selfReport: "remembered", reflection: "已存的关键词", reportedAt: date });
  act(() => window.dispatchEvent(new CustomEvent("ailearn:note-recall-saved", { detail: { noteId, record: reported } })));
  act(() => { view.result.current.close(); view.result.current.open(record()); });
  expect(view.result.current.active?.state).toBe("reported"); expect(view.result.current.reflection).toBe("已存的关键词");
  act(() => view.result.current.open(record("444444444444")));
  expect(view.result.current.reflection).toBe("第二题关键词");
});
