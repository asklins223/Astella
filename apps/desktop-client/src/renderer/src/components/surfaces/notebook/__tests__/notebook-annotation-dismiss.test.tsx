// @vitest-environment jsdom
import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NoteAnnotationV1 } from "@astella/shared/note-annotation-contracts";
import { useRoomStore } from "../../../../app/room-store";
import { NotebookDesk } from "../notebook-desk";
import { NoteAnnotationMark } from "../note-annotation-mark";
import type { NoteBodyMode } from "../note-document-mode";
import { useNotebookSidePage } from "../use-notebook-side-page";

const annotation: NoteAnnotationV1 = { annotationId: "first", noteId: "note", explanation: "自己的批注", sourceMessageId: null,
  generationJobId: null, revision: 1, versionState: "current", createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z",
  anchor: { noteVersionId: "version", startBlockOrdinal: 0, endBlockOrdinal: 0, startOffset: 0, endOffset: 5, excerpt: "批注的原句", prefix: "", suffix: "" } };

function Desk({ mode = "preview" }: { mode?: NoteBodyMode }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const side = useNotebookSidePage("note");
  const [actions, setActions] = useState(0);
  const open = (id: string) => side.setOpenAnnotationId(current => current === id ? null : id);
  return <NotebookDesk noteId="note" noteTitle="长笔记" version={1} mode={mode} canEdit pendingMode={null}
    onMode={() => {}} articleHeader={<h2>长笔记</h2>} outline={[]} onLocate={() => {}} onOpenDirectory={() => {}}
    learningView="body" onLearning={() => {}} onBody={() => {}} tools={null} primaryAction={null} taskActions={null}
    extraActions={null} status={null} sourceAction={null} scrollRef={scrollRef}
    sidePage={side.openAnnotationId ? { kind: "annotation", title: side.openAnnotationId, closeLabel: "收起批注", onClose: side.closeSidePage,
      content: <><button onClick={() => setActions(n => n + 1)}>抽屉内操作</button><p>操作次数 {actions}</p></> } : null}>
    <p><NoteAnnotationMark annotation={annotation} open={side.openAnnotationId === "first"} onOpen={() => open("first")}>批注的原句</NoteAnnotationMark></p>
    <p>正文其他段落</p>
    <span role="button" tabIndex={0} data-annotation-id="second" onClick={() => open("second")}>另一处编辑器批注记号</span>
    <textarea aria-label="正文编辑位置" defaultValue="未保存的正文" />
  </NotebookDesk>;
}

function width(value: number) {
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) {}
    observe() { this.callback([{ contentRect: { width: value } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
    disconnect() {}
  });
}
function openFirst(view: ReturnType<typeof render>) {
  const mark = view.getByRole("button", { name: "打开批注：批注的原句" });
  act(() => mark.focus());
  fireEvent.click(mark);
  expect(view.getByRole("complementary", { name: "笔记旁页" })).toBeTruthy();
  return mark;
}
beforeEach(() => { useRoomStore.setState({ motionMode: "off", reducedMotion: false }); width(1400); });
afterEach(() => {
  cleanup(); window.getSelection()?.removeAllRanges(); vi.unstubAllGlobals();
  useRoomStore.setState({ motionMode: "full", reducedMotion: false });
});

it.each(["preview", "live-preview", "source"] as const)("%s 下点击其他段落或正文留白收起批注，焦点不回到旧记号重新弹出预览", mode => {
  const view = render(<Desk mode={mode} />);
  const scroll = view.container.querySelector<HTMLElement>(".notebook-desk__scroll")!;
  scroll.scrollTop = 320;
  for (const target of [view.getByText("正文其他段落"), scroll]) {
    openFirst(view);
    fireEvent.click(target);
    expect(view.queryByRole("complementary", { name: "笔记旁页" })).toBeNull();
    expect(view.queryByRole("tooltip")).toBeNull();
    expect(document.activeElement).toBe(scroll);
    expect(scroll.scrollTop).toBe(320);
  }
});

it("抽屉内点击保持展开；另一个编辑器记号切换批注，不被正文关闭动作吞掉；同句仍可再次点击收起", () => {
  const view = render(<Desk />);
  const mark = openFirst(view);
  const side = view.getByRole("complementary", { name: "笔记旁页" });
  fireEvent.click(within(side).getByRole("button", { name: "抽屉内操作" }));
  expect(within(side).getByText("操作次数 1")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "另一处编辑器批注记号" }));
  expect(within(side).getByRole("heading", { name: "second" })).toBeTruthy();
  fireEvent.click(mark);
  expect(within(side).getByRole("heading", { name: "first" })).toBeTruthy();
  fireEvent.click(mark);
  expect(view.queryByRole("complementary", { name: "笔记旁页" })).toBeNull();
});

it("拖选原文或源码不会误当正文点击关闭，随后单击仍能收起", () => {
  const view = render(<Desk mode="source" />);
  openFirst(view);
  const paragraph = view.getByText("正文其他段落");
  fireEvent(paragraph, new MouseEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 100 }));
  fireEvent.click(paragraph, { clientX: 180, clientY: 100, detail: 1 });
  expect(view.getByRole("complementary", { name: "笔记旁页" })).toBeTruthy();
  const range = document.createRange(); range.setStart(paragraph.firstChild!, 0); range.setEnd(paragraph.firstChild!, 4);
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  expect(window.getSelection()!.isCollapsed).toBe(false);
  expect(window.getSelection()!.getRangeAt(0).intersectsNode(view.container.querySelector(".notebook-desk__scroll")!)).toBe(true);
  fireEvent.click(paragraph);
  expect(view.getByRole("complementary", { name: "笔记旁页" })).toBeTruthy();
  window.getSelection()!.removeAllRanges();
  fireEvent.click(paragraph);
  expect(view.queryByRole("complementary", { name: "笔记旁页" })).toBeNull();
});

it("点击正文编辑位置收起时保留正在编辑的焦点、选区和内容", () => {
  const view = render(<Desk mode="live-preview" />);
  openFirst(view);
  const editor = view.getByLabelText("正文编辑位置") as HTMLTextAreaElement;
  act(() => editor.focus()); editor.setSelectionRange(2, 4);
  fireEvent.click(editor);
  expect(view.queryByRole("complementary", { name: "笔记旁页" })).toBeNull();
  expect(document.activeElement).toBe(editor);
  expect([editor.selectionStart, editor.selectionEnd]).toEqual([2, 4]);
  expect(editor.value).toBe("未保存的正文");
});

it("紧凑窗口点击原文上的遮罩收起批注并回到正文，不重新弹出旧批注预览", () => {
  width(700);
  const view = render(<Desk />);
  openFirst(view);
  fireEvent.click(view.getByRole("button", { name: "合起旁页，回到正文" }));
  expect(view.queryByRole("complementary", { name: "笔记旁页" })).toBeNull();
  expect(view.queryByRole("tooltip")).toBeNull();
  expect(document.activeElement).toBe(view.getByLabelText("正在阅读"));
});
