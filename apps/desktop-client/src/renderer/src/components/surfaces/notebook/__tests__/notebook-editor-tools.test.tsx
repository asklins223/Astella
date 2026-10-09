// @vitest-environment jsdom
import { createRef } from "react";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NotebookEditorTools } from "../notebook-editor-tools";
import type { NoteMarkdownEditorHandle } from "../note-markdown-editor";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function tools(width: number, editable = true) {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width);
  const handle = { focus: vi.fn(), redo: vi.fn(), toggleEmphasis: vi.fn(), toggleHeading: vi.fn(), toggleStrikethrough: vi.fn(), setParagraphStyle: vi.fn(), getFormatState: () => ({ canUndo: true, canRedo: false, strike: true }) };
  const editorRef = createRef<NoteMarkdownEditorHandle>(); editorRef.current = handle as unknown as NoteMarkdownEditorHandle;
  const screen = render(<div className="notebook-workspace"><div className="notebook-volume__tools"><NotebookEditorTools editorRef={editorRef} editable={editable} canUpload onImages={() => {}} fileInputRef={createRef<HTMLInputElement>()} onLink={() => {}} /></div></div>);
  return { screen, handle };
}

it("宽工具栏把高级命令留在明确菜单，命令沿当前编辑器执行且回到正文", () => {
  const { screen, handle } = tools(900);
  expect(screen.getByRole("button", { name: "段落格式" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "删除线" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "更多格式" }));
  const menu = within(screen.getByRole("dialog", { name: "更多格式" }));
  expect(menu.getByRole("button", { name: "删除线" }).getAttribute("aria-pressed")).toBe("true");
  expect((menu.getByRole("button", { name: "重做" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(menu.getByRole("button", { name: "增加缩进" }));
  expect(handle.setParagraphStyle).toHaveBeenCalledWith({ indent: 1 });
  expect(handle.focus).toHaveBeenCalled();
  expect(screen.queryByRole("dialog", { name: "更多格式" })).toBeNull();
});

it("窄工具栏仍能找到标题、斜体、高亮和所有高级操作；键盘关闭返回正文", () => {
  const { screen, handle } = tools(600);
  expect(screen.queryByRole("button", { name: "段落格式" })).toBeNull();
  const more = screen.getByRole("button", { name: "更多格式" });
  fireEvent.keyDown(more, { key: "ArrowDown" });
  const menu = within(screen.getByRole("dialog", { name: "更多格式" }));
  for (const name of ["标题 1", "标题 6", "斜体", "文本高亮", "引用", "无序列表", "有序列表", "格式刷", "清除格式"]) expect(menu.getByRole("button", { name })).toBeTruthy();
  fireEvent.click(menu.getByRole("button", { name: "标题 2" }));
  expect(handle.toggleHeading).toHaveBeenCalledWith(2);
  fireEvent.click(more);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "更多格式" })).toBeNull();
  expect(handle.focus).toHaveBeenCalled();
});

it("只读正文不能从固定栏或更多入口修改格式", () => {
  const { screen } = tools(600, false);
  for (const name of ["撤销", "加粗", "插入", "文字字体", "更多格式"]) expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
});
