// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "../../../../app/room-store";
import { NotebookNoteList } from "../notebook-note-list";
import { openNotebookListNote } from "../notebook-note-navigation";
import { useNotebookFullscreenSession, useNotebookFullscreenState } from "../notebook-fullscreen-state";
import { NotebookFullscreenRibbon } from "../notebook-fullscreen-ribbon";

const ok = (data: unknown) => ({ ok: true, data, workspaceEpoch: 1 });
const item = (id: string, title: string) => ({ id, title, updatedAt: "2026-10-08T01:00:00Z" });
const previousApi = window.astella;
beforeEach(() => {
  useRoomStore.setState({ surface: "notebook", workspaceScopeRevision: 0, activeNoteRef: { noteId: "first", noteVersionId: null, mode: "source" }, returnTarget: null, motionMode: "off", reducedMotion: false });
  useNotebookFullscreenState.setState({ active: false });
});
afterEach(() => { cleanup(); window.astella = previousApi; useNotebookFullscreenState.setState({ active: false }); });

function install(list = vi.fn(async (_input: { cursor?: string }) => ok({ items: [item("first", "第一篇"), item("second", "第二篇")], total: 2, nextCursor: null })), presence = vi.fn(async () => ok({ items: [] }))) {
  window.astella = { auth: { getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceId: "workspace" }, workspaceEpoch: 1 })) }, note: { list, presenceList: presence } } as never;
  return list;
}
function Visit({ loading = false, fullscreen = false }: { loading?: boolean; fullscreen?: boolean }) {
  const current = useRoomStore(state => state.activeNoteRef);
  useNotebookFullscreenSession(current);
  return <><NotebookNoteList currentId={current?.noteId ?? null} currentTitle={null} fullscreen={fullscreen}
    onSelect={id => openNotebookListNote(id, null)} />{loading ? <NotebookFullscreenRibbon onExit={() => useNotebookFullscreenState.setState({ active: false })} /> : null}</>;
}

it("连续切篇保持列表与搜索，当前篇不重复导航，返回带回正文模式", async () => {
  const list = install();
  const screen = render(<Visit />);
  expect(screen.queryByRole("complementary", { name: "笔记列表" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "展开笔记列表" }));
  await screen.findByRole("button", { name: /第一篇.*当前/ });
  const paper = screen.getByRole("complementary", { name: "笔记列表" });
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "篇" } });
  fireEvent.click(screen.getByRole("button", { name: /第一篇.*当前/ }));
  expect(useRoomStore.getState().returnTarget).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /第二篇/ }));
  expect(useRoomStore.getState().activeNoteRef?.noteId).toBe("second");
  expect(screen.getByRole("complementary", { name: "笔记列表" })).toBe(paper);
  expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("篇");
  expect(screen.getByRole("button", { name: /第二篇.*当前/ }).getAttribute("aria-current")).toBe("page");
  expect(list).toHaveBeenCalledTimes(1);
  const target = useRoomStore.getState().returnTarget!;
  act(() => target.run());
  expect(useRoomStore.getState().activeNoteRef?.mode).toBe("source");
  act(() => target.run());
  expect(useRoomStore.getState().returnTarget).toBeNull();
});

it("全屏加载期间也能切篇，Escape 先收列表，下一次再退出全屏并恢复入口焦点", async () => {
  install();
  const screen = render(<Visit fullscreen loading />);
  expect(screen.queryByRole("complementary", { name: "笔记列表" })).toBeNull();
  act(() => useNotebookFullscreenState.setState({ active: true }));
  fireEvent.click(screen.getByRole("button", { name: "展开笔记列表" }));
  fireEvent.click(await screen.findByRole("button", { name: /第二篇/ }));
  expect(useNotebookFullscreenState.getState().active).toBe(true);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("complementary", { name: "笔记列表" })).toBeNull();
  expect(useNotebookFullscreenState.getState().active).toBe(true);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "展开笔记列表" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(useNotebookFullscreenState.getState().active).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "展开笔记列表" }));
  expect(screen.getByRole("complementary", { name: "笔记列表" })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: /第二篇.*当前/ }));
});

it("查找继续读后续分页，去重并保留相同标题的不同笔记", async () => {
  const list = install(vi.fn(async (input?: { cursor?: string }) => ok(input?.cursor
    ? { items: [item("first", "第一篇"), item("second", "后页标题"), item("third", "后页标题")], total: 3, nextCursor: null }
    : { items: [item("first", "第一篇")], total: 3, nextCursor: "page-2" })));
  const screen = render(<Visit />);
  fireEvent.click(screen.getByRole("button", { name: "展开笔记列表" }));
  await screen.findByRole("button", { name: /第一篇/ });
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "后页" } });
  await waitFor(() => expect(screen.getAllByRole("button", { name: /后页标题/ })).toHaveLength(2));
  expect(list.mock.calls[1]?.[0]).toMatchObject({ cursor: "page-2", trashed: false });
  fireEvent.click(screen.getByRole("button", { name: "清除笔记查找" }));
  expect(within(screen.getByRole("navigation", { name: "切换笔记" })).getAllByRole("button")).toHaveLength(3);
});

it("全屏的工具与正文接住新操作，浮动列表合起后不盖住工具页", async () => {
  install();
  const screen = render(<><Visit fullscreen /><article className="notebook-workspace"><button type="button" className="notebook-focus-ribbon__tools">打开手边工具</button><p>正文纸面</p></article></>);
  fireEvent.click(screen.getByRole("button", { name: "展开笔记列表" }));
  await screen.findByRole("button", { name: /第一篇/ });
  act(() => screen.getByRole("button", { name: "打开手边工具" }).focus());
  expect(screen.queryByRole("complementary", { name: "笔记列表" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "打开手边工具" }));
  fireEvent.click(screen.getByRole("button", { name: "展开笔记列表" }));
  fireEvent.pointerDown(screen.getByText("正文纸面"));
  expect(screen.queryByRole("complementary", { name: "笔记列表" })).toBeNull();
});

it("后续分页失败保留已读列表，可以从原页重试", async () => {
  const list = install(vi.fn().mockResolvedValueOnce(ok({ items: [item("first", "第一篇")], total: 2, nextCursor: "page-2" }))
    .mockRejectedValueOnce(new Error("暂时断开"))
    .mockResolvedValueOnce(ok({ items: [item("second", "第二篇")], total: 2, nextCursor: null })));
  const screen = render(<Visit />);
  fireEvent.click(screen.getByRole("button", { name: "展开笔记列表" }));
  fireEvent.click(await screen.findByRole("button", { name: /继续翻/ }));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: /第一篇/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重试读取笔记" }));
  await screen.findByRole("button", { name: /第二篇/ });
  expect(list.mock.calls[2]?.[0]).toMatchObject({ cursor: "page-2" });
});

it("刷新失败后的重试重新读首页，当前末页笔记也可见且不编造更新时间", async () => {
  const list = install(vi.fn().mockResolvedValueOnce(ok({ items: [item("first", "第一篇")], total: 2, nextCursor: "page-2" }))
    .mockRejectedValueOnce(new Error("暂时断开"))
    .mockResolvedValueOnce(ok({ items: [item("first", "刷新后的标题")], total: 2, nextCursor: "page-2" })));
  const screen = render(<NotebookNoteList currentId="second" currentTitle="当前末页笔记" fullscreen={false} onSelect={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "展开笔记列表" }));
  const current = screen.getByRole("button", { name: /当前末页笔记.*当前/ });
  expect(current.querySelector("time")).toBeNull();
  await screen.findByRole("button", { name: /第一篇/ });
  fireEvent.click(screen.getByRole("button", { name: "刷新笔记列表" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "重试读取笔记" }));
  await screen.findByRole("button", { name: /刷新后的标题/ });
  expect(list.mock.calls[2]?.[0]).not.toHaveProperty("cursor");
});

it("空间切换清除查询与旧列表，晚到的旧空间回执不能露出旧标题", async () => {
  let finish: (value: unknown) => void = () => {};
  install(vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue(ok({ items: [item("new", "新空间笔记")], total: 1, nextCursor: null })));
  const screen = render(<Visit />);
  fireEvent.click(screen.getByRole("button", { name: "展开笔记列表" }));
  await act(async () => {});
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "旧" } });
  act(() => useRoomStore.setState({ workspaceScopeRevision: 1 }));
  expect(screen.queryByRole("complementary", { name: "笔记列表" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "展开笔记列表" }));
  await screen.findByRole("button", { name: /新空间笔记/ });
  await act(async () => finish(ok({ items: [item("old", "旧空间私有标题")], total: 1, nextCursor: null })));
  expect(screen.queryByText("旧空间私有标题")).toBeNull();
  expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
});

describe("列表里「谁在这一篇」那一排", () => {
  const inSharedSpace = () => useRoomStore.setState({
    spaceIdentity: { name: "共享空间", role: "owner", isPersonal: false, userId: "me" },
    accountIdentity: { email: "me@astella.local", displayName: "我" },
  });

  it("别人在看的那一行长出印章与名字，没人在看的那一行保持原样，自己那枚不算", async () => {
    inSharedSpace();
    install(undefined, vi.fn(async () => ok({ items: [{
      noteId: "second",
      viewers: [
        { userId: "me", displayName: "我", mode: "reading", block: null },
        { userId: "peer-1", displayName: "小琳", mode: "editing", block: 2 },
        { userId: "peer-2", displayName: "", mode: "reading", block: null },
      ],
    }] })));
    const screen = render(<Visit />);
    fireEvent.click(screen.getByRole("button", { name: "展开笔记列表" }));
    const row = await screen.findByRole("button", { name: /第二篇/ });
    // 纸上那一行只放得下一句短话：先说在写的那个，剩下的如实报数；
    // 全名（包括没留下名字的那位）在 title 与 aria-label 里。
    expect(row.textContent).toContain("小琳 在写 · 还有 1 人");
    const readers = row.querySelector(".notebook-note-list__readers");
    expect(readers?.getAttribute("aria-label")).toBe("小琳 在写 · 没留下名字的人 在读");
    // 你自己开着这篇由「当前」那一位在说；那一排再画一枚就是同一天两个人数。
    expect(row.querySelectorAll(".notebook-presence__peer")).toHaveLength(2);
    expect(row.textContent).not.toMatch(/我 在读/);
    const quiet = screen.getByRole("button", { name: /第一篇/ });
    expect(quiet.querySelector(".notebook-note-list__readers")).toBeNull();
  });

  it("读不到时那一排放下，并说一句读不到（不拿空的名单说「没人」）", async () => {
    inSharedSpace();
    install(undefined, vi.fn(async () => { throw new Error("暂时断开"); }));
    const screen = render(<Visit />);
    fireEvent.click(screen.getByRole("button", { name: "展开笔记列表" }));
    await screen.findByText(/别人在不在看，这一列暂时读不到/);
    expect(document.querySelectorAll(".notebook-note-list__readers")).toHaveLength(0);
  });

  it("纸合着的时候不读，展开才读，收起就停", async () => {
    inSharedSpace();
    const presence = vi.fn(async () => ok({ items: [] }));
    install(undefined, presence);
    const screen = render(<Visit />);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(presence).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "展开笔记列表" }));
    await waitFor(() => expect(presence).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "收起笔记列表" }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    const after = presence.mock.calls.length;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    // 合上的纸不该继续打服务端。
    expect(presence.mock.calls.length).toBe(after);
  });
});
