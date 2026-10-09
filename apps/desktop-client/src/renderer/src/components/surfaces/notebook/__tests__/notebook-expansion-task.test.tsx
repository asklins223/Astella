// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { noteDetailV1Schema } from "@astella/shared/note-projection-contracts";
import { noteExpansionTaskV1Schema, noteExpansionLinkV1Schema, type NoteExpansionTaskV1 } from "@astella/shared/note-expansion-contracts";
import { useNotebookExpansionTask } from "../use-notebook-expansion-task";

const id = (n: number) => `${String(n).padStart(8, "0")}-4111-8111-8111-${String(n).padStart(12, "0")}`;
const date = "2026-10-01T00:00:00.000Z";
const note = noteDetailV1Schema.parse({ version: 1, noteId: id(1), workspaceId: id(8), title: "复利", titleSource: "manual", sourceId: null, currentVersionId: id(2),
  shareScope: "private", revision: id(2), snapshotAt: date,
  currentVersion: { versionId: id(2), noteId: id(1), versionNo: 1, contentHash: "a".repeat(32), createdAt: date, updatedAt: date, blocks: [] },
  permissions: { canRead: true, canEdit: true, canSave: true, canShare: true } });
const task = (changes: Partial<NoteExpansionTaskV1> = {}) => noteExpansionTaskV1Schema.parse({ taskId: id(3), noteId: id(1), noteVersionId: id(2),
  focusAnchor: null, sourceMessageId: null, conversationId: null, status: "ready", confirmedCandidateIds: null, failureReason: null, createdAt: date,
  drafts: [4, 5].map(n => ({ candidateId: id(n), requestId: id(n + 20), title: `草稿 ${n}`, relationship: "从原笔记本金与利息的关系继续学习。",
    sourceReferences: [{ blockOrdinal: 0, quote: "上一轮的利息会计入下一轮本金。" }], blocks: [{ type: "paragraph", content: "原来的草稿正文。" }], selected: false })), ...changes });
const link = noteExpansionLinkV1Schema.parse({ expansionId: id(9), sourceNoteId: id(1), sourceNoteVersionId: id(2), sourceNoteVersionNumber: 1,
  sourceTaskId: id(3), expandedNoteId: id(10), expandedNoteVersionId: id(11), expandedNoteVersionNumber: 1, sourceMessageId: null, conversationId: null,
  otherNoteTitle: "新标题", direction: "expanded_from_here", createdAt: date });
const ok = <T,>(data: T) => ({ ok: true, data });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function install() {
  const api = { latestTask: vi.fn(async () => ok({ version: 1, task: task() as NoteExpansionTaskV1 | null })),
    getTask: vi.fn(async (_request: { noteId: string; taskId: string }) => ok(task())),
    startTask: vi.fn(async (_request: { noteId: string; request: { noteVersionId: string; requestId: string } }) => ok(task({ taskId: id(12) }))),
    review: vi.fn(async (request: { review: { drafts: NoteExpansionTaskV1["drafts"] } }) => ok(task({ drafts: task().drafts.map(draft => ({ ...draft, ...request.review.drafts.find(item => item.candidateId === draft.candidateId) })) }))),
    confirm: vi.fn(async (_request: { taskId: string; request: { candidateIds: string[] } }) => ok([link])) };
  Object.defineProperty(window, "astella", { configurable: true, value: { workspace: { getAiSettings: vi.fn(async () => ({ ok: true as const, data: { requiresConsent: true, consentVersion: "ai-consent-v1", dataPolicy: { sendToExternal: true } } })) }, noteExpansion: api } });
  return api;
}
const input = () => ({ note, dirty: false, epochRef: { current: undefined }, onConfirmed: vi.fn() });
afterEach(() => { cleanup(); Reflect.deleteProperty(window, "astella"); vi.restoreAllMocks(); });

it("手记打开指定旧版草稿，修改和收下仍绑定原批次，不读取或生成新版", async () => {
  const api = install(), props = { ...input(), requestedTask: { taskId: id(3), noteVersionId: id(20) } };
  const old = task({ noteVersionId: id(20) });
  api.getTask.mockResolvedValue(ok(old));
  api.review.mockImplementation(async request => ok({ ...old, drafts: old.drafts.map(draft => ({ ...draft, ...request.review.drafts.find(item => item.candidateId === draft.candidateId) })) }));
  const oldLink = { ...link, sourceNoteVersionId: id(20) };
  api.confirm.mockResolvedValue(ok([oldLink]));
  const view = renderHook(() => useNotebookExpansionTask(props)); await act(async () => {});
  expect(view.result.current.expansionTask?.noteVersionId).toBe(id(20));
  expect(api.latestTask).not.toHaveBeenCalled(); expect(api.startTask).not.toHaveBeenCalled();
  await act(async () => window.dispatchEvent(new CustomEvent("astella:note-expansion-task-started", { detail: { noteId: note.noteId, taskId: id(12) } })));
  expect(api.getTask).toHaveBeenCalledTimes(1);
  act(() => view.result.current.setExpansionTask(current => ({ ...current!, drafts: current!.drafts.map((draft, index) => index ? draft : { ...draft, selected: true }) })));
  await act(async () => view.result.current.confirmNoteExpansionDrafts());
  expect(api.confirm.mock.calls[0]?.[0]).toMatchObject({ taskId: id(3), request: { candidateIds: [id(4)] } });
  expect(props.onConfirmed).toHaveBeenCalledWith([oldLink]);
  expect(view.result.current.expansionTaskError).toBeNull();
});

it("指定旧版草稿回执不符时显示读取错误，重试仍只读取同一批次", async () => {
  const api = install(), props = { ...input(), requestedTask: { taskId: id(3), noteVersionId: id(20) } };
  const view = renderHook(() => useNotebookExpansionTask(props)); await act(async () => {});
  expect(view.result.current.expansionTask).toBeNull();
  expect(view.result.current.expansionTaskError).toContain("已有草稿没读到");
  api.getTask.mockResolvedValue(ok(task({ noteVersionId: id(20) })));
  await act(async () => view.result.current.loadLatestNoteExpansionTask());
  expect(view.result.current.expansionTask?.noteVersionId).toBe(id(20));
  expect(api.getTask.mock.calls).toHaveLength(2);
  expect(api.latestTask).not.toHaveBeenCalled(); expect(api.startTask).not.toHaveBeenCalled();
});

it("旧版草稿重新生成绑定当前笔记版本，接收成功后才切到新批次", async () => {
  const api = install(), onStarted = vi.fn();
  const props = { ...input(), onStarted, requestedTask: { taskId: id(3), noteVersionId: id(20) } };
  const old = task({ noteVersionId: id(20) });
  const next = task({ taskId: id(12), status: "queued", drafts: [] });
  api.getTask.mockImplementation(async request => ok(request.taskId === old.taskId ? old : next));
  const pending = deferred<ReturnType<typeof ok<NoteExpansionTaskV1>>>();
  api.startTask.mockImplementationOnce(() => pending.promise);
  const view = renderHook(current => useNotebookExpansionTask(current), { initialProps: props });
  await act(async () => {});
  let request!: Promise<void>;
  act(() => { request = view.result.current.startNoteExpansionTask(); });
  await act(async () => {});
  expect(api.startTask.mock.calls[0]?.[0]).toMatchObject({ noteId: note.noteId, request: { noteVersionId: note.currentVersionId } });
  expect(view.result.current.expansionTask?.taskId).toBe(old.taskId);
  expect(onStarted).not.toHaveBeenCalled();
  await act(async () => { pending.resolve(ok(next)); await request; });
  expect(onStarted).toHaveBeenCalledWith(next);
  view.rerender({ ...props, requestedTask: { taskId: next.taskId, noteVersionId: next.noteVersionId } });
  await act(async () => {});
  expect(view.result.current.expansionTask?.taskId).toBe(next.taskId);
  expect(view.result.current.expansionTaskError).toBeNull();
  expect(api.latestTask).not.toHaveBeenCalled();
  expect(api.startTask).toHaveBeenCalledTimes(1);
});

it("旧版重新生成失败或收到旧版本回执，仍保留原批次并可重试", async () => {
  const api = install(), onStarted = vi.fn();
  const old = task({ noteVersionId: id(20) });
  api.getTask.mockResolvedValue(ok(old));
  const view = renderHook(() => useNotebookExpansionTask({ ...input(), onStarted,
    requestedTask: { taskId: old.taskId, noteVersionId: old.noteVersionId } }));
  await act(async () => {});
  api.startTask.mockRejectedValueOnce(new Error("断线"));
  await act(async () => view.result.current.startNoteExpansionTask());
  expect(view.result.current.expansionTask?.taskId).toBe(old.taskId);
  expect(view.result.current.expansionTaskError).toBeTruthy();
  api.startTask.mockResolvedValueOnce(ok({ ...old, taskId: id(12) }));
  await act(async () => view.result.current.startNoteExpansionTask());
  expect(view.result.current.expansionTask?.taskId).toBe(old.taskId);
  expect(view.result.current.expansionTaskError).toBeTruthy();
  expect(view.result.current.expansionTaskStarting).toBe(false);
  expect(api.startTask).toHaveBeenCalledTimes(2);
  expect(onStarted).not.toHaveBeenCalled();
  expect(view.result.current.expansionTaskErrorAction).toBe("start");
  await act(async () => view.result.current.retryNoteExpansionTask());
  expect(api.startTask).toHaveBeenCalledTimes(3);
  expect(onStarted).toHaveBeenCalledWith(task({ taskId: id(12) }));
  expect(api.review).not.toHaveBeenCalled();
});

it("离开旧批次后晚到的新任务回执不接管当前页面", async () => {
  const api = install(), onStarted = vi.fn();
  const props = { ...input(), onStarted, requestedTask: { taskId: id(3), noteVersionId: id(20) } };
  const old = task({ noteVersionId: id(20) });
  api.getTask.mockResolvedValue(ok(old));
  const pending = deferred<ReturnType<typeof ok<NoteExpansionTaskV1>>>();
  api.startTask.mockImplementationOnce(() => pending.promise);
  const view = renderHook(current => useNotebookExpansionTask(current), { initialProps: props });
  await act(async () => {});
  let request!: Promise<void>;
  act(() => { request = view.result.current.startNoteExpansionTask(); });
  const other = task({ taskId: id(13), noteId: id(14), noteVersionId: id(21) });
  api.getTask.mockResolvedValue(ok(other));
  view.rerender({ ...props, note: { ...note, noteId: other.noteId }, requestedTask: { taskId: other.taskId, noteVersionId: other.noteVersionId } });
  await act(async () => {});
  await act(async () => { pending.resolve(ok(task({ taskId: id(12) }))); await request; });
  expect(view.result.current.expansionTask?.taskId).toBe(other.taskId);
  expect(onStarted).not.toHaveBeenCalled();
});

it("重新生成使用新请求编号，旧草稿可从批次记录重新打开；未保存修改阻止切批次和生成", async () => {
  const api = install();
  const listTasks = vi.fn(async () => ok({ version: 1, items: [task()], nextCursor: null }));
  Object.assign(api, { listTasks });
  const view = renderHook(() => useNotebookExpansionTask(input())); await act(async () => {});
  act(() => view.result.current.setExpansionTask(current => ({ ...current!, drafts: current!.drafts.map((draft, index) => index ? draft : { ...draft, title: "保留下来的修改" }) })));
  await act(async () => { await view.result.current.startNoteExpansionTask(); await view.result.current.openNoteExpansionTask(id(12)); });
  expect(api.startTask).not.toHaveBeenCalled(); expect(api.getTask).not.toHaveBeenCalled();
  await act(async () => view.result.current.persistNoteExpansionReview(view.result.current.expansionTask!.drafts));
  const saved = view.result.current.expansionTask!;
  await act(async () => view.result.current.startNoteExpansionTask());
  expect(api.startTask).toHaveBeenCalledTimes(1);
  expect(view.result.current.expansionTask?.taskId).toBe(id(12));
  expect(view.result.current.expansionTaskHistory.find(item => item.taskId === id(3))?.drafts[0]?.title).toBe("保留下来的修改");
  api.getTask.mockResolvedValueOnce(ok(saved));
  await act(async () => view.result.current.openNoteExpansionTask(id(3)));
  expect(view.result.current.expansionTask?.drafts[0]?.title).toBe("保留下来的修改");
  expect(view.result.current.expansionTaskHistory.some(item => item.taskId === id(12))).toBe(true);
});

it("入口等待已有草稿查询并恢复上一批，连点不会新建任务", async () => {
  const api = install(), pending = deferred<Awaited<ReturnType<typeof api.latestTask>>>();
  api.latestTask.mockImplementation(() => pending.promise);
  const view = renderHook(() => useNotebookExpansionTask(input()));
  let opened!: ReturnType<typeof view.result.current.loadLatestNoteExpansionTask>;
  act(() => { opened = view.result.current.loadLatestNoteExpansionTask(); void view.result.current.loadLatestNoteExpansionTask(); });
  expect(view.result.current.expansionTaskLoading).toBe(true); expect(api.startTask).not.toHaveBeenCalled();
  await act(async () => { pending.resolve(ok({ version: 1, task: task() })); await opened; });
  expect(view.result.current.expansionTask?.taskId).toBe(id(3)); expect(api.startTask).not.toHaveBeenCalled();
});

it("任务进度读取越过已有草稿查询时，查询结束仍清掉加载状态并允许再次读取", async () => {
  const api = install(), queued = task({ status: "queued", drafts: [] });
  api.latestTask.mockResolvedValueOnce(ok({ version: 1, task: queued }));
  const view = renderHook(() => useNotebookExpansionTask(input()));
  await act(async () => {});
  expect(view.result.current.expansionTask?.status).toBe("queued");
  expect(view.result.current.expansionTaskLoading).toBe(false);
  const pending = deferred<Awaited<ReturnType<typeof api.latestTask>>>();
  api.latestTask.mockImplementationOnce(() => pending.promise);
  let lookup!: ReturnType<typeof view.result.current.loadLatestNoteExpansionTask>;
  act(() => { lookup = view.result.current.loadLatestNoteExpansionTask(); });
  expect(view.result.current.expansionTaskLoading).toBe(true);
  await act(async () => { window.dispatchEvent(new CustomEvent("astella:note-expansion-task-started", { detail: { noteId: note.noteId, taskId: queued.taskId } })); });
  expect(api.getTask).toHaveBeenCalledTimes(1);
  expect(view.result.current.expansionTask?.status).toBe("ready");
  await act(async () => { pending.resolve(ok({ version: 1, task: queued })); await lookup; });
  expect(view.result.current.expansionTask?.status).toBe("ready");
  expect(view.result.current.expansionTaskLoading).toBe(false);
  await act(async () => { await view.result.current.loadLatestNoteExpansionTask(); });
  expect(api.latestTask).toHaveBeenCalledTimes(3);
});

it("查询失败不把缺席当成无草稿；读取空记录不生成，明确开始才生成", async () => {
  const api = install(); api.latestTask.mockRejectedValueOnce(new Error("断线"));
  const view = renderHook(() => useNotebookExpansionTask(input())); await act(async () => {});
  api.latestTask.mockRejectedValueOnce(new Error("仍未连上"));
  await act(async () => { await view.result.current.loadLatestNoteExpansionTask(); });
  expect(api.startTask).not.toHaveBeenCalled(); expect(view.result.current.expansionTaskError).toContain("没读到");
  await act(async () => { await view.result.current.loadLatestNoteExpansionTask(); });
  expect(view.result.current.expansionTask?.taskId).toBe(id(3)); expect(api.startTask).not.toHaveBeenCalled();
  view.unmount(); api.latestTask.mockResolvedValue(ok({ version: 1, task: null }));
  const empty = renderHook(() => useNotebookExpansionTask(input())); await act(async () => {});
  await act(async () => { await empty.result.current.loadLatestNoteExpansionTask(); });
  expect(api.startTask).not.toHaveBeenCalled();
  await act(async () => { await empty.result.current.startNoteExpansionTask(); });
  expect(api.startTask).toHaveBeenCalledTimes(1); expect(empty.result.current.expansionTask?.taskId).toBe(id(12));
});

it("保存失败保留正文、标题和选择；明确重试后保存同一份内容", async () => {
  const api = install(); const view = renderHook(() => useNotebookExpansionTask(input())); await act(async () => {});
  act(() => view.result.current.setExpansionTask(current => ({ ...current!, drafts: current!.drafts.map((draft, index) => index ? draft : { ...draft, title: "新标题", selected: true, blocks: [{ type: "paragraph", content: "未保存的新正文。" }] }) })));
  api.review.mockRejectedValueOnce(new Error("网络断开"));
  await act(async () => { await view.result.current.persistNoteExpansionReview(view.result.current.expansionTask!.drafts); });
  expect(api.getTask).not.toHaveBeenCalled(); expect(view.result.current.expansionTask!.drafts[0]).toMatchObject({ title: "新标题", selected: true, blocks: [{ content: "未保存的新正文。" }] });
  expect(view.result.current.expansionTaskError).toContain("草稿已保留"); expect(view.result.current.expansionReviewDirty).toBe(true);
  await act(async () => { await view.result.current.persistNoteExpansionReview(view.result.current.expansionTask!.drafts); });
  expect(api.review.mock.calls.at(-1)?.[0].review.drafts[0]?.title).toBe("新标题"); expect(view.result.current.expansionReviewDirty).toBe(false);
});

it("晚到的保存不能盖掉新的编辑，也不能进入另一篇笔记", async () => {
  const api = install(), pending = deferred<ReturnType<typeof ok<NoteExpansionTaskV1>>>();
  const view = renderHook(props => useNotebookExpansionTask(props), { initialProps: input() }); await act(async () => {});
  act(() => view.result.current.setExpansionTask(current => ({ ...current!, drafts: current!.drafts.map((draft, index) => index ? draft : { ...draft, title: "请求前的编辑" }) })));
  api.review.mockImplementationOnce(() => pending.promise);
  let request!: Promise<void>;
  act(() => { request = view.result.current.persistNoteExpansionReview(view.result.current.expansionTask!.drafts); });
  act(() => view.result.current.setExpansionTask(current => ({ ...current!, drafts: current!.drafts.map((draft, index) => index ? draft : { ...draft, title: "请求后的编辑" }) })));
  await act(async () => { pending.resolve(ok(task())); await request; });
  expect(view.result.current.expansionTask!.drafts[0]?.title).toBe("请求后的编辑"); expect(view.result.current.expansionReviewDirty).toBe(true);
  const second = deferred<ReturnType<typeof ok<NoteExpansionTaskV1>>>(); api.review.mockImplementationOnce(() => second.promise);
  act(() => { request = view.result.current.persistNoteExpansionReview(view.result.current.expansionTask!.drafts); });
  api.latestTask.mockResolvedValue(ok({ version: 1, task: task({ taskId: id(13), noteId: id(14) }) }));
  view.rerender({ ...input(), note: { ...note, noteId: id(14) } }); await act(async () => {});
  await act(async () => { second.resolve(ok(task())); await request; });
  expect(view.result.current.expansionTask?.taskId).toBe(id(13)); expect(view.result.current.expansionTask?.noteId).toBe(id(14)); expect(view.result.current.expansionReviewSaving).toBe(false);
});

it("只翻阅或切视图不写入草稿；有修改才保存，保存后再离开不重复写入", async () => {
  const api = install(); const view = renderHook(() => useNotebookExpansionTask(input())); await act(async () => {});
  await act(async () => { await view.result.current.persistNoteExpansionReview(view.result.current.expansionTask!.drafts); });
  expect(view.result.current.expansionTask?.status).toBe("ready");
  expect(api.review).not.toHaveBeenCalled();
  expect(view.result.current.expansionReviewSaving).toBe(false);

  act(() => view.result.current.setExpansionTask(current => ({ ...current!, drafts: current!.drafts.map((draft, index) => index ? draft : { ...draft, title: "真正修改过的标题" }) })));
  await act(async () => { await view.result.current.persistNoteExpansionReview(view.result.current.expansionTask!.drafts); });
  expect(api.review).toHaveBeenCalledTimes(1);
  expect(api.review.mock.calls[0]?.[0].review.drafts[0]?.title).toBe("真正修改过的标题");
  expect(view.result.current.expansionReviewDirty).toBe(false);
  await act(async () => { await view.result.current.persistNoteExpansionReview(view.result.current.expansionTask!.drafts); });
  expect(api.review).toHaveBeenCalledTimes(1);
});

it("确认先保存眼前的修改，再只收下勾选篇目，真实回执才落印", async () => {
  const api = install(), props = input(); const pending = deferred<ReturnType<typeof ok<NoteExpansionTaskV1>>>();
  const view = renderHook(() => useNotebookExpansionTask(props)); await act(async () => {});
  act(() => view.result.current.setExpansionTask(current => ({ ...current!, drafts: current!.drafts.map((draft, index) => index ? draft : { ...draft, title: "新标题", selected: true }) })));
  api.review.mockImplementationOnce(() => pending.promise);
  let request!: Promise<void>; act(() => { request = view.result.current.confirmNoteExpansionDrafts(); });
  expect(api.review.mock.calls[0]?.[0].review.drafts[0]).toMatchObject({ title: "新标题", selected: true });
  expect(api.confirm).not.toHaveBeenCalled(); expect(view.result.current.expansionTask?.status).toBe("ready");
  await act(async () => { pending.resolve(ok(task({ drafts: view.result.current.expansionTask!.drafts }))); await request; });
  expect(api.confirm.mock.calls[0]?.[0]).toMatchObject({ taskId: id(3), request: { candidateIds: [id(4)] } });
  expect(view.result.current.expansionTask).toMatchObject({ status: "ready", confirmedCandidateIds: [id(4)] }); expect(props.onConfirmed).toHaveBeenCalledWith([link]);
});

it("分次收下保留前次回执，第二次只提交尚未收下的选择", async () => {
  const api = install(), props = input();
  const confirmed: string[] = [];
  api.review.mockImplementation(async request => ok(task({ confirmedCandidateIds: [...confirmed],
    drafts: task().drafts.map(draft => ({ ...draft, ...request.review.drafts.find(item => item.candidateId === draft.candidateId) })) })));
  api.confirm.mockImplementation(async request => {
    confirmed.push(...request.request.candidateIds);
    return ok([{ ...link, expansionId: id(confirmed.length + 30), expandedNoteId: id(confirmed.length + 40) }]);
  });
  const view = renderHook(() => useNotebookExpansionTask(props)); await act(async () => {});
  act(() => view.result.current.setExpansionTask(current => ({ ...current!, drafts: current!.drafts.map((draft, index) => ({ ...draft, selected: index === 0 })) })));
  await act(async () => { await view.result.current.confirmNoteExpansionDrafts(); });
  expect(view.result.current.expansionTask).toMatchObject({ status: "ready", confirmedCandidateIds: [id(4)] });
  act(() => view.result.current.setExpansionTask(current => ({ ...current!, drafts: current!.drafts.map((draft, index) => index ? { ...draft, title: "第二篇独立编辑", selected: true } : draft) })));
  await act(async () => { await view.result.current.confirmNoteExpansionDrafts(); });
  expect(api.confirm.mock.calls.map(([request]) => request.request.candidateIds)).toEqual([[id(4)], [id(5)]]);
  expect(view.result.current.expansionTask).toMatchObject({ status: "confirmed", confirmedCandidateIds: [id(4), id(5)] });
  expect(view.result.current.expansionTask!.drafts[1]!.title).toBe("第二篇独立编辑");
  expect(props.onConfirmed).toHaveBeenCalledTimes(2);
});

it("确认前保存失败或期间新编辑，均保留本地且不发确认", async () => {
  const api = install(); const view = renderHook(() => useNotebookExpansionTask(input())); await act(async () => {});
  act(() => view.result.current.setExpansionTask(current => ({ ...current!, drafts: current!.drafts.map((draft, index) => ({ ...draft, selected: index === 0 })) })));
  api.review.mockRejectedValueOnce(new Error("断线"));
  await act(async () => { await view.result.current.confirmNoteExpansionDrafts(); });
  expect(api.confirm).not.toHaveBeenCalled(); expect(view.result.current.expansionTask?.status).toBe("ready");
  const pending = deferred<ReturnType<typeof ok<NoteExpansionTaskV1>>>(); api.review.mockImplementationOnce(() => pending.promise);
  let request!: Promise<void>; act(() => { request = view.result.current.confirmNoteExpansionDrafts(); });
  act(() => view.result.current.setExpansionTask(current => ({ ...current!, drafts: current!.drafts.map((draft, index) => index ? draft : { ...draft, title: "最后的输入" }) })));
  await act(async () => { pending.resolve(ok(task())); await request; });
  expect(api.confirm).not.toHaveBeenCalled(); expect(view.result.current.expansionTask!.drafts[0]?.title).toBe("最后的输入");
});

it("确认晚到与错批次回执不能贴到当前笔记；新草稿也不被后台任务替换", async () => {
  const api = install(), props = input(); const view = renderHook(current => useNotebookExpansionTask(current), { initialProps: props }); await act(async () => {});
  act(() => window.dispatchEvent(new CustomEvent("astella:note-expansion-task-started", { detail: { noteId: id(1), taskId: id(12) } })));
  expect(api.getTask).not.toHaveBeenCalled(); expect(view.result.current.expansionTask?.taskId).toBe(id(3));
  act(() => view.result.current.setExpansionTask(current => ({ ...current!, drafts: current!.drafts.map((draft, index) => ({ ...draft, selected: index === 0 })) })));
  const pending = deferred<ReturnType<typeof ok<typeof link[]>>>(); api.confirm.mockImplementationOnce(() => pending.promise);
  let request!: Promise<void>; act(() => { request = view.result.current.confirmNoteExpansionDrafts(); }); await act(async () => {});
  expect(api.confirm).toHaveBeenCalledTimes(1);
  api.latestTask.mockResolvedValue(ok({ version: 1, task: task({ taskId: id(13), noteId: id(14) }) }));
  view.rerender({ ...props, note: { ...note, noteId: id(14) } }); await act(async () => {});
  await act(async () => { pending.resolve(ok([link])); await request; });
  expect(view.result.current.expansionTask?.taskId).toBe(id(13)); expect(view.result.current.expansionTask?.status).toBe("ready"); expect(props.onConfirmed).not.toHaveBeenCalled();
});
