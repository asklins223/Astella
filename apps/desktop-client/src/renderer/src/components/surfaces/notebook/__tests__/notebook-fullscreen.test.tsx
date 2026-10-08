// @vitest-environment jsdom
import { useRef, useState, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRoomStore, type NoteTargetRef } from "../../../../app/room-store";
import { NotebookDesk, type NotebookSidePage } from "../notebook-desk";
import { useNotebookFullscreenActive, useNotebookFullscreenSession, useNotebookFullscreenState } from "../notebook-fullscreen-state";
import { NotebookFullscreenRibbon } from "../notebook-fullscreen-ribbon";
import { openLibraryNoteLink } from "../note-library-links";
import { noteLinkHref } from "@astella/shared/note-markdown";
import type { NoteBodyMode } from "../note-document-mode";

function Desk({ noteId = "note", canEdit = true, view = "body", saveError = null }: { noteId?: string; canEdit?: boolean; view?: "body" | "history"; saveError?: string | null }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<NoteBodyMode>("preview");
  const [side, setSide] = useState<NotebookSidePage | null>(null);
  return <NotebookDesk noteId={noteId} noteTitle="笔记" version={1} mode={mode} canEdit={canEdit}
    pendingMode={null} onMode={setMode} articleHeader={<h2>笔记</h2>} outline={[{ block: 2, title: "第二节", level: 2 }]}
    onLocate={() => {}} onOpenDirectory={() => setSide(null)} learningView={view} onLearning={() => {}} onBody={() => {}}
    tools={mode !== "preview" ? <button type="button">加粗</button> : null}
    primaryAction={mode !== "preview" ? <button type="button">保存版本</button> : null} taskActions={null} extraActions={<button type="button">版本历史</button>}
    status="已同步" saveError={saveError} scrollRef={scrollRef} sidePage={side}
    sourceAction={<button type="button" onClick={() => setSide({ kind: "source", title: "资料袋", closeLabel: "合起资料袋", onClose: () => setSide(null), content: <p>原始材料</p> })}>资料袋</button>}>
    <textarea aria-label="工作稿" defaultValue="最后一句还在" />
  </NotebookDesk>;
}
function Visit({ children, currentNote = null }: { children: ReactNode; currentNote?: NoteTargetRef | null }) {
  useNotebookFullscreenSession(currentNote);
  const active = useNotebookFullscreenActive();
  return <div data-fullscreen={active || undefined}>{children}</div>;
}
beforeEach(() => {
  useRoomStore.setState({ surface: "notebook", motionMode: "off", reducedMotion: false, returnTarget: null, activeNoteRef: null });
  useNotebookFullscreenState.setState({ active: false });
});
afterEach(() => { cleanup(); useNotebookFullscreenState.setState({ active: false }); });

it("铺开与合回保持工作稿、选区和正文节点，工具默认收起且立即不可操作", () => {
  const screen = render(<Visit><Desk /></Visit>);
  const draft = screen.getByLabelText("工作稿") as HTMLTextAreaElement;
  const scroller = screen.getByLabelText("正在阅读");
  fireEvent.change(draft, { target: { value: "未经保存的中文最后一句" } });
  draft.setSelectionRange(3, 8);
  fireEvent.click(screen.getByRole("button", { name: "全屏笔记" }));
  expect(useNotebookFullscreenState.getState().active).toBe(true);
  expect(screen.queryByRole("group", { name: "正文视图" })).toBeNull();
  expect(screen.getByLabelText("工作稿")).toBe(draft);
  expect(screen.getByLabelText("正在阅读")).toBe(scroller);
  expect(draft.value).toBe("未经保存的中文最后一句");
  expect([draft.selectionStart, draft.selectionEnd]).toEqual([3, 8]);
  fireEvent.click(screen.getByRole("button", { name: "退出全屏笔记" }));
  expect(screen.getByRole("group", { name: "正文视图" })).toBeTruthy();
  expect(screen.getByLabelText("工作稿")).toBe(draft);
  expect(draft.value).toBe("未经保存的中文最后一句");
});

it("全屏工具可切换编辑和源码，Escape 先收工具再合回笔记", () => {
  const screen = render(<Visit><Desk /></Visit>);
  fireEvent.keyDown(document, { key: "f", ctrlKey: true, shiftKey: true });
  fireEvent.click(screen.getByRole("button", { name: "展开笔记工具" }));
  fireEvent.click(screen.getByRole("button", { name: /^编辑$/ }));
  expect(screen.getByRole("button", { name: "保存版本" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^源码$/ }));
  expect(screen.getByLabelText("Markdown 源码")).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(useNotebookFullscreenState.getState().active).toBe(true);
  expect(screen.queryByRole("button", { name: "保存版本" })).toBeNull();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(useNotebookFullscreenState.getState().active).toBe(false);
});

it("目录与资料袋先接住 Escape，合起后焦点回到折签，全屏仍在", () => {
  const screen = render(<Visit><Desk /></Visit>);
  fireEvent.click(screen.getByRole("button", { name: "全屏笔记" }));
  fireEvent.click(screen.getByRole("button", { name: "展开笔记工具" }));
  fireEvent.click(screen.getByRole("button", { name: /^目录$/ }));
  const index = screen.getByRole("complementary", { name: "笔记目录" });
  fireEvent.keyDown(within(index).getByRole("button", { name: "开篇" }), { key: "Escape" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "展开笔记工具" }));
  expect(useNotebookFullscreenState.getState().active).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "展开笔记工具" }));
  fireEvent.click(screen.getByRole("button", { name: "资料袋" }));
  const side = screen.getByRole("complementary", { name: "笔记旁页" });
  expect(document.activeElement).toBe(side);
  fireEvent.keyDown(side, { key: "Escape" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "展开笔记工具" }));
  expect(useNotebookFullscreenState.getState().active).toBe(true);
});

it("输入法组合与模态中的快捷键不抢走当前操作；只读仍可全屏阅读", () => {
  const screen = render(<Visit><Desk canEdit={false} /></Visit>);
  fireEvent.keyDown(document, { key: "f", metaKey: true, shiftKey: true, isComposing: true });
  expect(useNotebookFullscreenState.getState().active).toBe(false);
  const modal = document.createElement("dialog"); modal.setAttribute("open", ""); document.body.append(modal);
  fireEvent.keyDown(document, { key: "f", metaKey: true, shiftKey: true });
  expect(useNotebookFullscreenState.getState().active).toBe(false); modal.remove();
  fireEvent.click(screen.getByRole("button", { name: "全屏笔记" }));
  fireEvent.click(screen.getByRole("button", { name: "展开笔记工具" }));
  expect((screen.getByRole("button", { name: /^编辑$/ }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: /^源码$/ }) as HTMLButtonElement).disabled).toBe(true);
});

it("全屏错误回执不会被折叠隐藏，离开正文或笔记页面归还借用的座位", () => {
  const screen = render(<Visit><Desk saveError="改动还没同步成功" /></Visit>);
  fireEvent.click(screen.getByRole("button", { name: "全屏笔记" }));
  expect(screen.getByRole("alert").textContent).toContain("改动还没同步成功");
  fireEvent.click(screen.getByRole("button", { name: "查看保存" }));
  expect(screen.getByRole("group", { name: "正文视图" })).toBeTruthy();
  screen.rerender(<Visit><Desk view="history" /></Visit>);
  expect(useNotebookFullscreenState.getState().active).toBe(false);
  screen.rerender(<Visit><Desk /></Visit>);
  fireEvent.click(screen.getByRole("button", { name: "全屏笔记" }));
  screen.rerender(<Visit><Desk noteId="another-note" /></Visit>);
  expect(useNotebookFullscreenState.getState().active).toBe(true);
  act(() => useNotebookFullscreenState.setState({ active: true }));
  screen.unmount();
  expect(useNotebookFullscreenState.getState().active).toBe(false);
});

function Loading() {
  const active = useNotebookFullscreenActive();
  return <><p role="status">正在读取下一篇</p>{active ? <NotebookFullscreenRibbon onExit={() => useNotebookFullscreenState.setState({ active: false })} /> : null}</>;
}

it("切换笔记和正文重新挂载期间保留全屏，加载时仍能退出", () => {
  const screen = render(<Visit><Desk key="first" /></Visit>);
  fireEvent.click(screen.getByRole("button", { name: "全屏笔记" }));
  fireEvent.click(screen.getByRole("button", { name: "展开笔记工具" }));
  screen.rerender(<Visit><Loading /></Visit>);
  expect(useNotebookFullscreenState.getState().active).toBe(true);
  expect(screen.getByRole("button", { name: "退出全屏笔记" })).toBeTruthy();
  screen.rerender(<Visit><Desk key="second" noteId="second" /></Visit>);
  expect(screen.getByRole("button", { name: "展开笔记工具" })).toBeTruthy();
  expect(useNotebookFullscreenState.getState().active).toBe(true);
  screen.rerender(<Visit><Loading /></Visit>);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(useNotebookFullscreenState.getState().active).toBe(false);
});

it("离开笔记页面或切换空间结束全屏，不把上次显示模式带进下一次访问", () => {
  const screen = render(<Visit><Desk /></Visit>);
  fireEvent.click(screen.getByRole("button", { name: "全屏笔记" }));
  act(() => useRoomStore.setState({ surface: "note-library" }));
  expect(useNotebookFullscreenState.getState().active).toBe(false);
  fireEvent.keyDown(document, { key: "f", ctrlKey: true, shiftKey: true });
  expect(useNotebookFullscreenState.getState().active).toBe(false);
  act(() => useRoomStore.setState({ surface: "notebook" }));
  expect(screen.getByRole("button", { name: "全屏笔记" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "全屏笔记" }));
  act(() => useRoomStore.setState({ workspaceScopeRevision: useRoomStore.getState().workspaceScopeRevision + 1 }));
  expect(useNotebookFullscreenState.getState().active).toBe(false);
});

it("真实库内跳转沿返回链逐篇退回，全屏和原来的正文模式仍在；无效链接不改路径", async () => {
  const first = { noteId: "11111111-4111-4111-8111-111111111111", noteVersionId: null, mode: "source" as const };
  const second = "22222222-4222-4222-8222-222222222222", third = "33333333-4333-8333-8333-333333333333";
  useRoomStore.getState().invoke("open-notebook");
  const returnToLibrary = { label: "返回笔记库", run: vi.fn(() => useRoomStore.getState().invoke("open-notes")) };
  useRoomStore.setState({ activeNoteRef: first, returnTarget: returnToLibrary });
  const get = vi.fn(async ({ noteId }: { noteId: string }) => ({ ok: true, data: { noteId, currentVersionId: null } }));
  const previousApi = window.astella;
  window.astella = { note: { get } } as never;
  function CurrentNote() {
    const current = useRoomStore(state => state.activeNoteRef);
    return current ? <Desk key={current.noteId} noteId={current.noteId} /> : null;
  }
  const screen = render(<Visit><CurrentNote /></Visit>);
  try {
    fireEvent.click(screen.getByRole("button", { name: "全屏笔记" }));
    await act(() => openLibraryNoteLink(noteLinkHref(second)));
    expect(useRoomStore.getState().activeNoteRef?.noteId).toBe(second);
    expect(useNotebookFullscreenState.getState().active).toBe(true);
    await act(() => openLibraryNoteLink(noteLinkHref(third)));
    expect(useRoomStore.getState().activeNoteRef?.noteId).toBe(third);
    fireEvent.click(screen.getByRole("button", { name: "返回上一篇笔记" }));
    expect(useRoomStore.getState().activeNoteRef?.noteId).toBe(second);
    expect(useNotebookFullscreenState.getState().active).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "返回上一篇笔记" }));
    expect(useRoomStore.getState().activeNoteRef).toEqual(first);
    expect(useNotebookFullscreenState.getState().active).toBe(true);
    get.mockResolvedValueOnce({ ok: false } as never);
    await expect(openLibraryNoteLink(noteLinkHref(second))).rejects.toThrow("没有访问权限");
    expect(useRoomStore.getState().activeNoteRef).toEqual(first);
    expect(useNotebookFullscreenState.getState().active).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "返回笔记库" }));
    expect(returnToLibrary.run).toHaveBeenCalledTimes(1);
    expect(useRoomStore.getState().surface).toBe("note-library");
    expect(useNotebookFullscreenState.getState().active).toBe(false);
  } finally { window.astella = previousApi; }
});

it("通过其他入口直接换篇也提供返回，加载期间可退回，失效的旧返回不抢当前路径", () => {
  const first = { noteId: "first-direct", noteVersionId: null, mode: "live-preview" as const };
  useRoomStore.setState({ activeNoteRef: first });
  const screen = render(<Visit><Desk /></Visit>);
  fireEvent.click(screen.getByRole("button", { name: "全屏笔记" }));
  act(() => useRoomStore.getState().setActiveNoteRef({ noteId: "second-direct", noteVersionId: null, mode: "preview" }));
  const staleReturn = useRoomStore.getState().returnTarget!;
  screen.rerender(<Visit><Loading /></Visit>);
  fireEvent.click(screen.getByRole("button", { name: "返回上一篇笔记" }));
  expect(useRoomStore.getState().activeNoteRef).toEqual(first);
  expect(useNotebookFullscreenState.getState().active).toBe(true);
  act(() => staleReturn.run());
  expect(useRoomStore.getState().returnTarget).toBeNull();
});

it("从主笔记入口打开的正文也能在全屏切篇后返回，无需预先存在显式笔记路由", () => {
  const primary = { noteId: "primary-note", noteVersionId: null, mode: "preview" as const };
  const screen = render(<Visit currentNote={primary}><Desk noteId={primary.noteId} /></Visit>);
  fireEvent.click(screen.getByRole("button", { name: "全屏笔记" }));
  act(() => useRoomStore.getState().setActiveNoteRef({ noteId: "linked-note", noteVersionId: null, mode: "preview" }));
  fireEvent.click(screen.getByRole("button", { name: "返回上一篇笔记" }));
  expect(useRoomStore.getState().activeNoteRef).toEqual(primary);
  expect(useNotebookFullscreenState.getState().active).toBe(true);
});
