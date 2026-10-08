// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { EditorView } from "@codemirror/view";
import { TextSelection } from "@milkdown/kit/prose/state";
import { EditorView as ProseMirrorView } from "@milkdown/kit/prose/view";
import { NoteDocumentEditor } from "../note-document-editor";
import type { NoteMarkdownEditorHandle } from "../note-markdown-editor";
import type { NoteBodyMode } from "../note-document-mode";
import { seedBlocksUpdate } from "../../../../test-support/note-doc-fixtures";
import { noteOutline } from "../note-outline";
import { noteSourceBlocks } from "../note-source-structure";
import type { NoteAiRange } from "../../../companion/note-companion-editing";
import type { NoteImageUploadView } from "../note-image-uploads";
import * as sourceImages from "../../source/source-image";

const docs: Y.Doc[] = [];
function documentWith(...paragraphs: string[]) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Uint8Array.from(atob(seedBlocksUpdate("标题", paragraphs.map(content => ({ type: "paragraph", content })))), c => c.charCodeAt(0)));
  docs.push(doc);
  return doc;
}
async function mount(doc: Y.Doc, mode: NoteBodyMode = "source", disabled = false, aiRanges: readonly NoteAiRange[] = []) {
  const ref = createRef<NoteMarkdownEditorHandle>();
  const onChange = vi.fn();
  const props = { ref, fragment: doc.getXmlFragment("content"), initialMarkdown: "", onChange, disabled, aiRanges, imageUploads: [] as readonly NoteImageUploadView[] };
  let currentMode = mode;
  const view = render(<NoteDocumentEditor {...props} mode={currentMode} />);
  await waitFor(() => expect(ref.current?.getMarkdown()).not.toBeNull());
  await waitFor(() => expect(view.container.querySelector(".note-source-editor .cm-content")).not.toBeNull());
  return { ...view, ref, onChange, mode: (next: NoteBodyMode, readonly = disabled) => { currentMode = next; view.rerender(<NoteDocumentEditor {...props} disabled={readonly} mode={next} />); },
    lock: (ranges: readonly NoteAiRange[]) => { props.aiRanges = ranges; view.rerender(<NoteDocumentEditor {...props} mode={currentMode} />); },
    uploads: (uploads: readonly NoteImageUploadView[]) => { props.imageUploads = uploads; view.rerender(<NoteDocumentEditor {...props} mode={currentMode} />); },
    code: () => EditorView.findFromDOM(view.container.querySelector(".note-source-editor .cm-content")!)!,
  };
}
async function source(view: Awaited<ReturnType<typeof mount>>, text: string) {
  await act(async () => view.code().dispatch({ changes: { from: 0, to: view.code().state.doc.length, insert: text } }));
}
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await new Promise(resolve => setTimeout(resolve, 0));
  docs.splice(0).forEach(doc => doc.destroy());
});

describe("三种正文视图共用真实编辑器与 Y.Doc", () => {
  it("文字排版作用于选区，连续设置合并，格式刷与撤销都写入同一份正文", async () => {
    const dispatch = vi.spyOn(ProseMirrorView.prototype, "dispatch");
    const doc = documentWith("选取文字", "刷到这里"), view = await mount(doc, "live-preview");
    await act(async () => view.ref.current!.focusPosition({ block: 0, offset: 0 }));
    const pm = dispatch.mock.instances.at(-1)! as ProseMirrorView; dispatch.mockRestore();
    await act(async () => pm.dispatch(pm.state.tr.setSelection(TextSelection.create(pm.state.doc, 1, 3))));
    await act(async () => { view.ref.current!.setTextStyle!({ color: "#a44b3b" }); view.ref.current!.setTextStyle!({ font: "sans", size: 24 }); });
    expect(view.ref.current!.getMarkdown()).toContain('color:#a44b3b;font-family:sans-serif;font-size:24px');
    await act(async () => view.ref.current!.formatBrush!());
    const at = pm.state.doc.child(0).nodeSize + 1;
    await act(async () => { pm.dispatch(pm.state.tr.setSelection(TextSelection.create(pm.state.doc, at, at + 2))); fireEvent.mouseUp(pm.dom); });
    expect(view.ref.current!.getFormatState!()?.brush).toBe(false);
    expect(pm.state.doc.child(1).firstChild?.marks.find(mark => mark.type.name === "noteStyle")?.attrs.noteStyle.color).toBe("#a44b3b");
    await act(async () => view.ref.current!.undo()); expect(pm.state.doc.child(1).firstChild?.marks.find(mark => mark.type.name === "noteStyle")).toBeUndefined();
    await act(async () => view.ref.current!.redo());
    const saved = view.ref.current!.getMarkdown()!; await act(async () => view.ref.current!.applySource(saved));
    expect(view.container.querySelectorAll('.ProseMirror span[style*="color"]')).toHaveLength(2);
  });
  it("源码中的文字和段落排版切回正文后生效，并保留公式和脚注", async () => {
    const view = await mount(documentWith("起点")); await source(view, '正文 **重点** $x^2$ 参考[^n]\n\n[^n]: 注释\n');
    await act(async () => view.code().dispatch({ selection: { anchor: 5, head: 7 } }));
    await act(async () => view.ref.current!.setTextStyle!({ color: "#a44b3b" }));
    await act(async () => view.ref.current!.setParagraphStyle!({ align: "center", leading: 2 }));
    view.mode("live-preview"); await waitFor(() => expect(view.container.querySelector('.ProseMirror p[style*="text-align"]')).not.toBeNull());
    expect(view.ref.current!.getMarkdown()).toContain('$x^2$'); expect(view.ref.current!.getMarkdown()).toContain('data-note-ref="n"');
    expect(view.container.querySelector('.note-editor-math-preview')).not.toBeNull(); expect(view.container.querySelector('[data-note-ref]')).not.toBeNull();
  });
  it("粘贴混合 HTML 保留文字排版、表格和图片，脚本不会进入正文", async () => {
    const view = await mount(documentWith("起点"), "live-preview"); await act(async () => view.ref.current!.focusPosition({ block: 0, offset: 999 }));
    const event = new Event("paste", { bubbles: true, cancelable: true });
    const html = '<p style="text-align:center"><strong>粗体</strong><span style="color:rgb(164,75,59);font-size:24px">彩色</span><img src="https://example.com/image.png" alt="图" width="120"></p><table><tr><th>甲</th><th>乙</th></tr><tr><td>A</td><td>B</td></tr></table><script>bad()</script>';
    Object.defineProperty(event, "clipboardData", { value: { items: [], files: [], getData: (kind: string) => kind === "text/html" ? html : kind === "text/plain" ? "粗体彩色\n甲乙\nAB" : "", types: ["text/html", "text/plain"] } });
    await act(async () => fireEvent(view.container.querySelector('.ProseMirror')!, event));
    expect(view.container.querySelector('.ProseMirror strong')?.textContent).toBe('粗体'); expect(view.container.querySelector('.ProseMirror span[style*="color"]')?.textContent).toBe('彩色');
    expect(view.container.querySelectorAll('.ProseMirror td')).toHaveLength(2); expect(view.container.querySelector('.note-image-node img')?.getAttribute('src')).toBe('https://example.com/image.png');
    expect(view.ref.current!.getMarkdown()).not.toContain('bad()'); expect(view.ref.current!.getMarkdown()).toContain('color:#a44b3b');
  });
  it("单图按正文光标行内插入，属性浮层不进入正文", async () => {
    const view = await mount(documentWith("前文后文"), "live-preview");
    await act(async () => { view.ref.current!.focusPosition({ block: 0, offset: 2 }); view.ref.current!.insertImageMarkdown?.("![甲图](https://example.com/a.png)"); });
    expect(view.container.querySelectorAll(".ProseMirror > p")).toHaveLength(1);
    expect(view.container.querySelectorAll(".note-image-node")).toHaveLength(1);
    expect(view.ref.current!.getMarkdown()).toContain("前文"); expect(view.ref.current!.getMarkdown()).toContain("后文");
    fireEvent.load(view.container.querySelector(".note-image-node img")!);
    fireEvent.click(view.container.querySelector(".note-image-node img")!);
    expect(view.getByRole("dialog", { name: "图片属性" }).closest(".ProseMirror")).toBeNull();
    expect(view.container.querySelector(".ProseMirror")?.textContent).not.toContain("图片选项");
    expect(view.ref.current!.getMarkdown()).not.toContain("宽度（px）");
    const roomEscape = vi.fn(); document.addEventListener("keydown", roomEscape);
    try {
      fireEvent.keyDown(view.container.querySelector(".ProseMirror")!, { key: "Escape", keyCode: 27 });
      expect(view.queryByRole("dialog", { name: "图片属性" })).toBeNull();
      expect(roomEscape).not.toHaveBeenCalled();
      expect(fireEvent.keyDown(view.container.querySelector(".ProseMirror")!, { key: "Escape", keyCode: 27 })).toBe(true);
      expect(roomEscape).toHaveBeenCalledOnce();
      fireEvent.keyDown(view.getByRole("slider", { name: "调整图片宽度" }), { key: "Escape" });
      expect(roomEscape).toHaveBeenCalledTimes(2);
    } finally { document.removeEventListener("keydown", roomEscape); }
  });

  it("批量图片落在文字之间仍成为同一排，前后文保留且插入可整次撤销", async () => {
    const view = await mount(documentWith("前文后文"), "live-preview");
    await act(async () => { view.ref.current!.focusPosition({ block: 0, offset: 2 }); view.ref.current!.insertImageMarkdown?.("![甲图](https://example.com/a.png) ![乙图](https://example.com/b.png)"); });
    expect(view.container.querySelectorAll(".ProseMirror > p")).toHaveLength(3);
    expect(view.container.querySelector(".note-image-row")?.querySelectorAll(".note-image-node")).toHaveLength(2);
    expect(view.ref.current!.getMarkdown()).toContain("前文"); expect(view.ref.current!.getMarkdown()).toContain("后文");
    expect(view.ref.current!.getMarkdown()).toMatch(/width="\d+"/);
    await act(async () => view.ref.current!.undo());
    expect(view.container.querySelectorAll(".note-image-node")).toHaveLength(0);
    expect(view.ref.current!.getMarkdown()?.trim()).toBe("前文后文");
  });

  it("源码光标处批量插图也形成一排，原位回填地址不丢尺寸或前后文", async () => {
    const view = await mount(documentWith("前文后文"));
    await act(async () => view.code().dispatch({ selection: { anchor: 2 } }));
    await act(async () => view.ref.current!.insertImageMarkdown?.("![上传中…](uploading:one) ![上传中…](uploading:two)"));
    expect(view.code().state.doc.toString()).toMatch(/width="\d+"/);
    await act(async () => { view.ref.current!.replaceImageSrc("uploading:one", "https://example.com/a.png"); view.ref.current!.replaceImageSrc("uploading:two", "https://example.com/b.png"); });
    view.mode("live-preview");
    expect(view.container.querySelector(".note-image-row")?.querySelectorAll(".note-image-node")).toHaveLength(2);
    expect(view.ref.current!.getMarkdown()).toContain("前文"); expect(view.ref.current!.getMarkdown()).toContain("后文");
    expect(view.ref.current!.getMarkdown()).not.toContain("uploading:");
  });

  it("任务列表用键盘和鼠标勾选，勾选可独立撤销，锁定时不能更改", async () => {
    const view = await mount(documentWith("起点")); await source(view, "- [ ] 计划\n- [x] 已完成\n"); view.mode("live-preview");
    const boxes = view.getAllByRole("checkbox", { name: "完成这一项" }) as HTMLInputElement[];
    expect(boxes.map(box => box.checked)).toEqual([false, true]);
    fireEvent.click(boxes[0]!); expect(view.ref.current!.getMarkdown()).toMatch(/\[x\] 计划/);
    await act(async () => view.ref.current!.undo()); expect(boxes[0]!.checked).toBe(false);
    await act(async () => view.lock([{ startBlock: 0, endBlock: 0, label: "伴星正在调整" }]));
    expect(boxes[0]!.disabled).toBe(true);
  });

  it("表格最后一格 Tab 接续新行，Mod+Enter 新行，列对齐贯穿整列", async () => {
    const view = await mount(documentWith("起点")); await source(view, "| 甲 | 乙 |\n| --- | --- |\n| 一 | 二 |\n"); view.mode("live-preview");
    await act(async () => view.ref.current!.focusPosition({ block: 0, offset: 9999 }));
    const root = view.container.querySelector(".ProseMirror")!;
    fireEvent.keyDown(root, { key: "Tab" }); expect(root.querySelectorAll("tr")).toHaveLength(3);
    fireEvent.keyDown(root, { key: "Enter", ctrlKey: true }); expect(root.querySelectorAll("tr")).toHaveLength(4);
    fireEvent.click(view.getByRole("button", { name: "右对齐" }));
    expect(view.ref.current!.getMarkdown()).toMatch(/-+:/);
    expect(Array.from(root.querySelectorAll("tr")).map(row => (row.querySelector("td,th") as HTMLElement)?.style.textAlign)).toEqual(Array(4).fill("right"));
  });

  it("表格拖动改变行列次序、批量扩容保留内容、整行选区可删除并撤销", async () => {
    const dispatch = vi.spyOn(ProseMirrorView.prototype, "dispatch");
    const view = await mount(documentWith("起点")); await source(view, "| 甲 | 乙 |\n| --- | --- |\n| 一 | 二 |\n| 三 | 四 |\n"); view.mode("live-preview");
    await act(async () => view.ref.current!.focusPosition({ block: 0, offset: 9999 }));
    const pm = dispatch.mock.instances.at(-1)! as ProseMirrorView; dispatch.mockRestore();
    let first = 0; pm.state.doc.descendants((node, pos) => { if (node.isText && node.text === "一") first = pos; });
    await act(async () => pm.dispatch(pm.state.tr.setSelection(TextSelection.create(pm.state.doc, first))));
    const table = pm.dom.querySelector('table')!;
    const box = (top: number, left = 0) => ({ top, left, bottom: top + 40, right: left + 200, width: 200, height: 40, x: left, y: top, toJSON() {} });
    [...table.querySelectorAll('tr')].forEach((row, index) => vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(box(index * 50)));
    const handle = view.getByRole('button', { name: '拖动当前行' });
    Object.assign(handle, { setPointerCapture: vi.fn(), hasPointerCapture: () => false });
    await act(async () => { fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, button: 0 })); fireEvent(handle, new MouseEvent('pointermove', { bubbles: true, clientY: 70 })); fireEvent(handle, new MouseEvent('pointerup', { bubbles: true, clientY: 120 })); });
    expect([...pm.dom.querySelectorAll('tr')].map(row => row.textContent)).toEqual(['甲乙', '三四', '一二']);
    await act(async () => view.ref.current!.undo()); expect([...pm.dom.querySelectorAll('tr')].map(row => row.textContent)).toEqual(['甲乙', '一二', '三四']);
    fireEvent.change(view.getByRole('spinbutton', { name: '正文行数' }), { target: { value: '3' } });
    fireEvent.change(view.getByRole('spinbutton', { name: '列数' }), { target: { value: '3' } }); fireEvent.click(view.getByRole('button', { name: '应用表格大小' }));
    expect(pm.dom.querySelectorAll('tr')).toHaveLength(4); expect(pm.dom.querySelectorAll('th')).toHaveLength(3); expect(pm.dom.textContent).toContain('一二');
    fireEvent.click(view.getByRole('button', { name: '选中整行' })); expect(pm.state.selection.constructor.name).toBe('CellSelection');
    fireEvent.click(view.getByRole('button', { name: '删除当前行' })); expect(pm.dom.querySelectorAll('tr')).toHaveLength(3);
    await act(async () => view.ref.current!.undo()); expect(pm.dom.querySelectorAll('tr')).toHaveLength(4);
  });

  it("列表 Tab 缩进和 Shift+Tab 返回，格式边界只删除当前范围且输入法不触发", async () => {
    const dispatch = vi.spyOn(ProseMirrorView.prototype, 'dispatch');
    const view = await mount(documentWith("起点")); await source(view, '- 甲\n- 乙\n\n**一** 中间 **二**\n'); view.mode('live-preview'); await act(async () => view.ref.current!.focusPosition({ block: 0, offset: 9999 }));
    const pm = dispatch.mock.instances.at(-1)! as ProseMirrorView; dispatch.mockRestore();
    let at = 0; pm.state.doc.descendants((node, pos) => { if (node.isText && node.text === '乙') at = pos; });
    await act(async () => pm.dispatch(pm.state.tr.setSelection(TextSelection.create(pm.state.doc, at + 1))));
    fireEvent.keyDown(pm.dom, { key: 'Tab' }); expect(pm.dom.querySelector('li li')?.textContent).toContain('乙');
    fireEvent.keyDown(pm.dom, { key: 'Tab', shiftKey: true }); expect(pm.dom.querySelector('li li')).toBeNull();
    pm.state.doc.descendants((node, pos) => { if (node.isText && node.text === '二') at = pos; });
    await act(async () => pm.dispatch(pm.state.tr.setSelection(TextSelection.create(pm.state.doc, at + 1))));
    const before = view.ref.current!.getMarkdown(); fireEvent.keyDown(pm.dom, { key: 'Backspace', isComposing: true, keyCode: 229 }); expect(view.ref.current!.getMarkdown()).toBe(before);
    fireEvent.keyDown(pm.dom, { key: 'Backspace' }); expect(pm.dom.querySelectorAll('strong')).toHaveLength(1); expect(pm.dom.querySelector('strong')?.textContent).toBe('一');
    await act(async () => view.ref.current!.clearHistory!()); await act(async () => view.ref.current!.undo()); expect(pm.dom.querySelectorAll('strong')).toHaveLength(1);
  });

  it("代码块原位输入使用同一共享撤销，语言和文本跨源码保持", async () => {
    const view = await mount(documentWith("起点")); await source(view, "```javascript\nconst answer = 1;\n```\n"); view.mode("live-preview");
    await waitFor(() => expect(view.container.querySelector(".milkdown-code-block .cm-content")).not.toBeNull());
    const code = EditorView.findFromDOM(view.container.querySelector(".milkdown-code-block .cm-content")!)!;
    await new Promise(resolve => setTimeout(resolve, 550));
    await act(async () => { code.focus(); code.dispatch({ changes: { from: 15, to: 16, insert: "2" } }); });
    expect(view.ref.current!.getMarkdown()).toContain("const answer = 2;");
    fireEvent.keyDown(code.contentDOM, { key: "z", ctrlKey: true });
    await waitFor(() => expect(code.state.doc.toString()).toBe("const answer = 1;"));
    view.mode("source"); expect(view.ref.current!.getMarkdown()).toContain("```javascript");
  });

  it("公式离开光标后排版，点回公式时原位编辑，显示切换不写文档", async () => {
    const doc = documentWith("推导 $a^2+b^2$", "继续正文"); const view = await mount(doc, "live-preview");
    await act(async () => view.ref.current!.focusPosition({ block: 1, offset: 0 }));
    const before = Y.encodeStateAsUpdate(doc);
    expect(view.getByRole("math").querySelector(".katex")).not.toBeNull();
    fireEvent.mouseDown(view.getByRole("math")); expect(view.queryByRole("math")).toBeNull();
    await act(async () => view.ref.current!.focusPosition({ block: 1, offset: 0 })); expect(view.getByRole("math")).toBeTruthy();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(view.ref.current!.getMarkdown()).toContain("$a^2+b^2$");
  });

  it("相邻图片可并排、加入第三张、拆开与撤销，源码和重开保留分组和链接", async () => {
    const view = await mount(documentWith("起点"));
    await source(view, '![甲图](https://example.com/a.png)\n\n[![乙图](https://example.com/b.png)](https://example.com/detail)\n\n![丙图](https://example.com/c.png)\n\n保留正文\n');
    view.mode("live-preview");
    fireEvent.click(view.container.querySelectorAll(".note-image-node img")[0]!);
    fireEvent.click(view.getByRole("dialog", { name: "图片属性" }).querySelector("summary")!);
    fireEvent.click(view.getByRole("button", { name: "与后图放在同一段" }));
    expect(view.container.querySelector(".note-image-row")?.querySelectorAll(".note-image-node")).toHaveLength(2);
    fireEvent.click(view.getByRole("dialog", { name: "图片属性" }).querySelector("summary")!);
    fireEvent.click(view.getByRole("button", { name: "与后图放在同一段" }));
    expect(view.container.querySelector(".note-image-row")?.querySelectorAll(".note-image-node")).toHaveLength(3);
    const saved = view.ref.current!.getMarkdown()!;
    expect(saved).toContain('href="https://example.com/detail"');
    view.mode("source"); await source(view, saved + "\n尾段\n");
    view.mode("live-preview");
    expect(view.container.querySelector(".note-image-row")?.querySelectorAll(".note-image-node")).toHaveLength(3);
    fireEvent.click(view.container.querySelectorAll(".note-image-node img")[1]!);
    fireEvent.click(view.getByRole("dialog", { name: "图片属性" }).querySelector("summary")!);
    fireEvent.click(view.getByRole("button", { name: "每张图片另起一段" }));
    expect(view.container.querySelector(".note-image-row")).toBeNull();
    expect(view.container.querySelectorAll(".note-image-node")).toHaveLength(3);
    await act(async () => view.ref.current!.undo());
    expect(view.container.querySelector(".note-image-row")?.querySelectorAll(".note-image-node")).toHaveLength(3);
    expect(view.ref.current!.getMarkdown()).toContain("尾段");
  });

  it("图片说明、尺寸和链接跨源码、同步和重开保留，删除与尺寸可撤销", async () => {
    const doc = documentWith("起点"); const view = await mount(doc);
    await source(view, '[<img src="https://example.com/a.png" alt="图 [A]" title="原图" width="320" />](https://example.com/detail)\n\n尾段\n');
    view.mode("live-preview");
    let slot = view.container.querySelector<HTMLElement>(".note-image-node")!;
    const image = slot.querySelector("img")!; fireEvent.load(image); fireEvent.click(image);
    expect(slot.querySelector<HTMLElement>(".note-image-node__frame")!.style.width).toBe("320px");
    fireEvent.change(view.getByLabelText("图片说明"), { target: { value: '新说明 [A] & "B"' } });
    fireEvent.blur(view.getByLabelText("图片说明"));
    fireEvent.keyDown(view.getByRole("slider", { name: "调整图片宽度" }), { key: "ArrowRight" });
    expect(view.ref.current!.getMarkdown()).toContain('width="328"');
    expect(view.ref.current!.getMarkdown()).toContain("https://example.com/detail");
    await act(async () => view.ref.current!.undo());
    expect(view.ref.current!.getMarkdown()).toContain('width="320"');
    expect(view.ref.current!.getMarkdown()).toContain('title="原图"');
    const saved = view.ref.current!.getMarkdown()!;
    view.mode("source");
    expect(view.code().state.doc.toString()).toBe(saved);
    await source(view, saved + "\n补充\n");
    view.unmount(); const reopened = await mount(doc, "live-preview");
    slot = reopened.container.querySelector<HTMLElement>(".note-image-node")!;
    expect(slot.querySelector("img")!.alt).toBe('新说明 [A] & "B"');
    expect(slot.querySelector<HTMLElement>(".note-image-node__frame")!.style.width).toBe("320px");
    fireEvent.click(slot.querySelector("img")!);
    fireEvent.click(reopened.getByRole("dialog", { name: "图片属性" }).querySelector("summary")!);
    fireEvent.click(reopened.getByRole("button", { name: "移除图片" }));
    expect(reopened.container.querySelector(".note-image-node")).toBeNull();
    await act(async () => reopened.ref.current!.undo());
    expect(reopened.container.querySelector(".note-image-node img")?.getAttribute("alt")).toBe('新说明 [A] & "B"');
    expect(reopened.ref.current!.getMarkdown()).toContain("补充");
  });

  it("旧 HTML 图片直接显示，打开编辑不改共享内容，操作后成为可保存图片", async () => {
    const doc = new Y.Doc(); docs.push(doc);
    const paragraph = new Y.XmlElement("paragraph"), html = new Y.XmlElement("html");
    html.setAttribute("value", '<img src="https://example.com/legacy.png" width="96" alt="旧图" />');
    paragraph.insert(0, [html]); doc.getXmlFragment("content").insert(0, [paragraph]);
    const before = Y.encodeStateAsUpdate(doc), view = await mount(doc, "live-preview");
    expect(view.container.querySelector(".note-image-node img")?.getAttribute("alt")).toBe("旧图");
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    fireEvent.click(view.container.querySelector(".note-image-node img")!);
    fireEvent.click(view.getByRole("dialog", { name: "图片属性" }).querySelector("summary")!);
    fireEvent.click(view.getByRole("button", { name: "50% 宽度" }));
    expect(doc.getXmlFragment("content").toString()).toContain("<image");
    expect(view.ref.current!.getMarkdown()).toContain("旧图");
  });

  it("标题、列表与引用可切回正文，格式状态随当前视图光标更新", async () => {
    const view = await mount(documentWith("这一段"), "live-preview");
    await act(async () => { view.ref.current!.focusPosition({ block: 0, offset: 1 }); view.ref.current!.toggleHeading(3); });
    expect(view.ref.current!.getFormatState?.()?.heading).toBe(3);
    await act(async () => view.ref.current!.toggleHeading(3));
    expect(view.container.querySelector(".ProseMirror h3")).toBeNull();
    await act(async () => view.ref.current!.toggleBulletList());
    expect(view.ref.current!.getFormatState?.()?.bullet).toBe(true);
    await act(async () => view.ref.current!.toggleOrderedList());
    expect(view.container.querySelector(".ProseMirror ul")).toBeNull();
    expect(view.container.querySelector(".ProseMirror ol")).not.toBeNull();
    await act(async () => view.ref.current!.toggleOrderedList());
    expect(view.container.querySelector(".ProseMirror ol")).toBeNull();
    await act(async () => view.ref.current!.toggleBlockquote());
    await act(async () => view.ref.current!.toggleBlockquote());
    expect(view.container.querySelector(".ProseMirror blockquote")).toBeNull();
    view.mode("source"); await source(view, "### 标题\n\n**粗体**\n");
    await act(async () => view.code().dispatch({ selection: { anchor: 5 } }));
    expect(view.ref.current!.getFormatState?.()?.heading).toBe(3);
    await act(async () => view.code().dispatch({ selection: { anchor: 12 } }));
    expect(view.ref.current!.getFormatState?.()?.strong).toBe(true);
  });

  it("图片占位没有破图，失败和重试不改正文，图片加载完成后原位呈现", async () => {
    vi.spyOn(sourceImages, "loadSourceImageBlobUrl").mockResolvedValue("blob:uploaded-image");
    const doc = documentWith("前面的正文", "后面的正文");
    const view = await mount(doc, "live-preview");
    const upload: NoteImageUploadView = { id: "image-1", name: "学习截图.png", size: 1200, status: "uploading", error: null };
    await act(async () => { view.ref.current!.focusPosition({ block: 0, offset: 6 }); view.ref.current!.insertText("![上传中…](uploading:image-1)"); view.uploads([upload]); });
    const slot = view.container.querySelector<HTMLElement>(".note-image-node")!;
    const image = slot.querySelector("img")!;
    expect(slot.dataset.state).toBe("uploading");
    expect(image.hasAttribute("src")).toBe(false);
    expect(image.hidden).toBe(true);
    expect(slot.textContent).toContain("学习截图.png");
    fireEvent.click(slot);
    expect(view.queryByRole("dialog")).toBeNull();

    const before = Y.encodeStateAsUpdate(doc);
    await act(async () => view.uploads([{ ...upload, status: "failed", error: "上传未成功" }]));
    expect(slot.dataset.state).toBe("failed");
    expect(slot.textContent).toContain("上传未成功，可重试");
    await act(async () => view.uploads([{ ...upload, status: "queued" }]));
    expect(slot.textContent).toContain("图片排队中…");
    await act(async () => view.uploads([upload]));
    expect(slot.dataset.state).toBe("uploading");
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);

    const url = "/api/uploads/11111111-1111-4111-8111-111111111111/notes/33333333-3333-4333-8333-333333333333/11111111-1111-4111-8111-111111111111.png";
    await act(async () => view.ref.current!.replaceImageSrc("uploading:image-1", url));
    expect(view.container.querySelector(".note-image-node")).toBe(slot);
    expect(slot.dataset.state).toBe("loading");
    expect(sourceImages.loadSourceImageBlobUrl).toHaveBeenCalledWith(url.slice("/api/uploads/".length));
    expect(image.getAttribute("src")).toBe("blob:uploaded-image");
    expect(image.hidden).toBe(true);
    fireEvent.load(image);
    expect(slot.dataset.state).toBe("ready");
    expect(image.hidden).toBe(false);
    expect(slot.querySelector<HTMLElement>(".note-image-node__placeholder")!.hidden).toBe(true);
    expect(view.ref.current!.getMarkdown()).toContain(`![](${url})`);
    expect(view.ref.current!.getMarkdown()).toContain("后面的正文");
    expect(view.ref.current!.getMarkdown()).not.toContain("学习截图.png");
    view.mode("source"); view.mode("live-preview");
    expect(view.container.querySelector(".note-image-node")).toBe(slot);
    fireEvent.click(image);
    expect(view.getByRole("dialog", { name: "图片属性" })).toBeTruthy();
    expect(slot.classList.contains("ProseMirror-selectednode")).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "查看原图" }));
    expect(view.getByRole("dialog")).toBeTruthy();
  });

  it("取图期间删除节点，迟到的图片不会重新出现在正文", async () => {
    let complete!: (url: string | null) => void;
    vi.spyOn(sourceImages, "loadSourceImageBlobUrl").mockReturnValue(new Promise(resolve => { complete = resolve; }));
    const view = await mount(documentWith("保留正文"), "live-preview");
    await act(async () => view.ref.current!.insertText("![图示](/api/uploads/11111111-1111-4111-8111-111111111111/notes/33333333-3333-4333-8333-333333333333/22222222-2222-4222-8222-222222222222.png)"));
    expect(view.container.querySelector(".note-image-node")?.getAttribute("data-state")).toBe("loading");
    await act(async () => view.ref.current!.setMarkdown("保留正文"));
    await act(async () => complete("blob:late-image"));
    expect(view.container.querySelector(".note-image-node")).toBeNull();
    expect(view.ref.current!.getMarkdown()).toContain("保留正文");
  });

  it("移出失败图片只删除对应节点，正文和另一张占位保留，操作可以撤销", async () => {
    const view = await mount(documentWith("保留正文"), "live-preview");
    await act(async () => view.ref.current!.insertText("![上传中…](uploading:remove-me)\n\n![上传中…](uploading:keep-me)"));
    expect(view.container.querySelectorAll(".note-image-node")).toHaveLength(2);
    // Separate this author action from the earlier insertion in the undo stack.
    await new Promise(resolve => setTimeout(resolve, 520));
    await act(async () => view.ref.current!.removeImageSrc("uploading:remove-me"));
    expect(view.container.querySelectorAll(".note-image-node")).toHaveLength(1);
    expect(view.ref.current!.getMarkdown()).toContain("uploading:keep-me");
    expect(view.ref.current!.getMarkdown()).toContain("保留正文");
    expect(view.ref.current!.getMarkdown()).not.toContain("uploading:remove-me");
    view.mode("source");
    expect(view.code().state.doc.toString()).not.toContain("uploading:remove-me");
    await act(async () => view.ref.current!.undo());
    expect(view.ref.current!.getMarkdown()).toContain("uploading:remove-me");
    expect(view.container.querySelector('.note-image-node')?.getAttribute("data-state")).toBe("unavailable");
    expect(view.container.textContent).toContain("上传已中断，请重新插入");
  });

  it("原生光标刚落下时按真实 DOM 位置读取，不等待编辑器的选区观察器", async () => {
    const view = await mount(documentWith("甲乙丙丁戊己"), "live-preview");
    view.ref.current!.focusPosition({ block: 0, offset: 0 });
    const text = view.container.querySelector('.ProseMirror p')!.firstChild!;
    const range = document.createRange(); range.setStart(text, 4); range.collapse(true);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    expect(view.ref.current!.getPosition()).toEqual({ block: 0, offset: 4 });
  });

  it("AI区域在富文本和源码同时锁定，其他段落继续输入，解除后立即可编辑", async () => {
    const doc = documentWith("锁定段落", "自由段落");
    const view = await mount(doc, "source", false, [{ startBlock: 0, endBlock: 0, expectedBlocks: ["锁定段落"], label: "伴星正在改这段" }]);
    await waitFor(() => expect(view.container.querySelector('.ProseMirror .note-ai-working')?.getAttribute('contenteditable')).toBe('false'));
    expect(view.container.querySelector('.cm-line.note-ai-working')).not.toBeNull();
    const before = view.code().state.doc.toString();
    await act(async () => view.code().dispatch({ changes: { from: 1, insert: "不能写入" } }));
    expect(view.code().state.doc.toString()).toBe(before);
    await act(async () => view.code().dispatch({ changes: { from: before.trimEnd().length, insert: "可以写入" } }));
    expect(view.ref.current!.getMarkdown()).toContain("自由段落可以写入");
    await act(async () => view.lock([]));
    await act(async () => view.code().dispatch({ changes: { from: 1, insert: "已解锁" } }));
    expect(view.ref.current!.getMarkdown()).toContain("锁已解锁定段落");
    expect(view.container.querySelector('.ProseMirror .note-ai-working')).toBeNull();
  });

  it("整篇删除、源码替换和富文本工具栏不能绕过 AI 锁", async () => {
    const doc = documentWith("锁定段落", "自由段落");
    const view = await mount(doc, "live-preview", false, [{ startBlock: 0, endBlock: 0, label: "伴星正在改这段" }]);
    const before = view.ref.current!.getMarkdown();
    await act(async () => { view.ref.current!.focusPosition({ block: 0, offset: 2 }); view.ref.current!.toggleHeading(2); });
    expect(view.ref.current!.getMarkdown()).toBe(before);
    view.mode("source");
    await source(view, "整篇替换");
    expect(view.ref.current!.getMarkdown()).toBe(before);
    await act(async () => view.lock([]));
    await source(view, "整篇替换");
    expect(view.ref.current!.getMarkdown()).toContain("整篇替换");
  });

  it("源码输入的 Wiki 别名存成笔记链接，转义写法与代码保持原文", async () => {
    const doc = documentWith("开始"); const view = await mount(doc);
    await source(view, '[[微积分|先看定义]] 和 \\[\\[字面]] 与 `[[代码]]`');
    view.mode("live-preview");
    const link = view.container.querySelector('.ProseMirror a');
    expect(link?.textContent).toBe("先看定义");
    expect(link?.getAttribute("href")).toBe("astella-note-title:%E5%BE%AE%E7%A7%AF%E5%88%86");
    expect(view.container.querySelectorAll('.ProseMirror a')).toHaveLength(1);
    expect(view.container.querySelector('.ProseMirror')?.textContent).toContain("[[字面]] 与 [[代码]]");
    view.unmount(); const reopened = await mount(doc);
    expect(reopened.ref.current!.getMarkdown()).toContain('[[微积分|先看定义]]');
    expect(reopened.container.querySelector('.ProseMirror a')?.getAttribute("href")).toBe("astella-note-title:%E5%BE%AE%E7%A7%AF%E5%88%86");
  });

  it("生成的源码可再次解析，首尾改动不会吞掉表格后的正文或中间出处", async () => {
    const doc = new Y.Doc(); docs.push(doc);
    Y.applyUpdate(doc, Uint8Array.from(atob(seedBlocksUpdate("来源", [
      { type: "heading", content: "首标题" },
      { type: "paragraph", content: "有序前缀" },
      { type: "heading", content: "步骤" },
      { type: "list", content: "3. 保存 key\n4. 严格大于才右移\n5. 写入 key" },
      { type: "heading", content: "示例" },
      { type: "paragraph", content: "| 输入 | 结果 |\n| :---: | ---: |\n| `2,2,1` | **1,2,2** |" },
      { type: "paragraph", content: "相等元素保留原来的顺序。" },
      { type: "heading", content: "最后一句" },
      { type: "paragraph", content: "尾段" },
    ])), c => c.charCodeAt(0)));
    const fragment = doc.getXmlFragment("content");
    for (let index = 0; index < fragment.length; index += 1) {
      (fragment.get(index) as Y.XmlElement).setAttribute("sourceRef", { sourceId: "source-qa", segmentId: `segment-${index}` } as unknown as string);
    }
    const view = await mount(doc);
    const exported = view.ref.current!.getMarkdown()!;
    await source(view, exported.replace("首标题", "首标题已校对").replace("尾段", "尾段已校对"));
    view.mode("live-preview");
    expect(view.container.querySelectorAll(".ProseMirror table tr")).toHaveLength(2);
    expect(view.container.querySelector(".ProseMirror table + p")?.textContent).toBe("相等元素保留原来的顺序。");
    expect(fragment.length).toBe(9);
    for (let index = 1; index < 8; index += 1) {
      expect((fragment.get(index) as Y.XmlElement).getAttribute("sourceRef")).toEqual({ sourceId: "source-qa", segmentId: `segment-${index}` });
    }
  });

  it("服务端来源表格与编号在真实编辑器中有结构，编辑和重开保留表格证据", async () => {
    const doc = new Y.Doc(); docs.push(doc);
    Y.applyUpdate(doc, Uint8Array.from(atob(seedBlocksUpdate("来源", [
      { type: "list", content: "3. 保存当前元素\n4. 移动前缀" },
      { type: "paragraph", content: "| 输入 | 输出 |\n| :---: | ---: |\n| **a\\|b** | `c` |" },
    ])), c => c.charCodeAt(0)));
    const fragment = doc.getXmlFragment("content"), table = fragment.get(1) as Y.XmlElement;
    // y-prosemirror stores JSON attributes; Y.XmlElement's public type only lists strings.
    table.setAttribute("sourceRef", { sourceId: "source-1", segmentId: "segment-2" } as unknown as string);
    const view = await mount(doc, "live-preview");
    const root = view.container.querySelector(".ProseMirror")!;
    expect(root.querySelector("ol")?.getAttribute("start")).toBe("3");
    expect(root.querySelectorAll("table tr")).toHaveLength(2);
    expect(root.querySelector("table th")?.getAttribute("style")).toContain("center");
    expect(root.querySelectorAll("table th")[1]?.getAttribute("style")).toContain("right");
    expect(root.querySelector("table strong")?.textContent).toBe("a|b");
    expect((fragment.get(1) as Y.XmlElement).getAttribute("sourceRef")).toEqual({ sourceId: "source-1", segmentId: "segment-2" });
    view.mode("source");
    await source(view, view.ref.current!.getMarkdown()!.replace("c", "changed"));
    expect((fragment.get(1) as Y.XmlElement).getAttribute("sourceRef")).toEqual({ sourceId: "source-1", segmentId: "segment-2" });
    view.unmount(); const reopened = await mount(doc, "live-preview");
    expect(reopened.container.querySelector(".ProseMirror table")?.textContent).toContain("changed");
    expect(reopened.container.querySelector(".ProseMirror ol")?.getAttribute("start")).toBe("3");
  });

  it("切换只改变视图，保留两个编辑器实例、不产生文档写入", async () => {
    const doc = documentWith("甲段", "乙段");
    const view = await mount(doc);
    const rich = view.container.querySelector(".ProseMirror");
    const code = view.code();
    const updates = vi.fn(); doc.on("update", updates);
    const before = Y.encodeStateAsUpdate(doc);
    view.mode("live-preview"); view.mode("preview"); view.mode("source");
    expect(view.container.querySelector(".ProseMirror")).toBe(rich);
    expect(view.code()).toBe(code);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(updates).not.toHaveBeenCalled();
  });

  it("源码行号和换行可独立开关，查找及光标位置不改正文或重建编辑器", async () => {
    const doc = documentWith("甲段", "乙段"); const view = await mount(doc);
    const code = view.code(), before = Y.encodeStateAsUpdate(doc);
    fireEvent.click(view.getByRole("button", { name: "行号" }));
    expect(view.container.querySelector(".cm-lineNumbers")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "自动换行" }));
    expect(code.contentDOM.classList.contains("cm-lineWrapping")).toBe(false);
    act(() => code.dispatch({ selection: { anchor: code.state.doc.line(3).from + 1 } }));
    expect(view.getByText("第 3 行 · 第 2 列")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "查找 / 替换" }));
    expect(view.container.querySelector('.cm-search input[name="search"]')).not.toBeNull();
    view.mode("preview"); view.mode("source");
    expect(view.code()).toBe(code);
    expect(view.getByRole("button", { name: "自动换行" }).getAttribute("aria-pressed")).toBe("false");
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("导入的 HTML 与图片徽章在源码中没有多余转义，编辑重开后仍保留链接", async () => {
    const doc = new Y.Doc(); docs.push(doc);
    Y.applyUpdate(doc, Uint8Array.from(atob(seedBlocksUpdate("README", [
      { type: "paragraph", content: '<div align="center">' },
      { type: "paragraph", content: '<img src="https://example.com/logo.png" width="96" />' },
      { type: "paragraph", content: '[![版本](https://example.com/badge.svg)](https://example.com/release)' },
      { type: "paragraph", content: '</div>' },
    ])), c => c.charCodeAt(0)));
    const view = await mount(doc);
    const text = view.ref.current!.getMarkdown()!;
    expect(text).toContain('<div align="center">');
    expect(text).not.toContain('\\<');
    expect(text).toContain('[![版本](https://example.com/badge.svg)](https://example.com/release)');
    await source(view, text + "\n\n尾段");
    view.unmount(); const reopened = await mount(doc);
    expect(reopened.ref.current!.getMarkdown()).toContain(text);
  });

  it("源码语法、标题六级、列表、代码、图片、表格与安全 HTML 跨视图和重开保留", async () => {
    const doc = documentWith("起点"); const view = await mount(doc);
    const text = '# 一级\n\n###### 六级\n\n- [x] 完成\n- 项目\n\n> 引用\n\n```md\n# 代码里的标题\n```\n\n![图示](https://example.com/a.png)\n\n| 列甲 | 列乙 |\n| :---: | ---: |\n| 一 | 二 |\n\n<script>alert("x")</script>\n\n尾段  \n换行\n';
    await source(view, text);
    view.mode("live-preview"); view.mode("preview"); view.mode("source");
    expect(view.ref.current!.getMarkdown()).toBe(text);
    expect(view.code().state.doc.toString()).toBe(text);
    expect(view.container.querySelector("script")).toBeNull();
    expect(view.container.querySelector(".ProseMirror")?.textContent).toContain('<script>alert("x")</script>');
    expect(noteOutline(doc.getXmlFragment("content"), []).map(item => item.level)).toEqual([1, 6]);
    expect(noteSourceBlocks(text).filter(item => item.headingLevel).map(item => item.title)).toEqual(["一级", "六级"]);
    const peer = new Y.Doc(); docs.push(peer); Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    view.unmount();
    const reopened = await mount(peer);
    expect(reopened.ref.current!.getMarkdown()).toBe(text);
  });

  it("同时改首尾时，中间未修改的段落仍保留自己的来源", async () => {
    const doc = documentWith("首段", "有出处的中段", "尾段");
    const fragment = doc.getXmlFragment("content");
    const middle = fragment.get(1) as Y.XmlElement<{ sourceRef: { sourceId: string; segmentId: string } }>;
    const provenance = { sourceId: "source-qa", segmentId: "middle-segment" };
    middle.setAttribute("sourceRef", provenance);
    const view = await mount(doc);
    await source(view, "首段补充\n\n有出处的中段\n\n尾段补充\n");
    expect((fragment.get(1) as Y.XmlElement).getAttribute("sourceRef")).toEqual(provenance);
    view.unmount(); const reopened = await mount(doc);
    expect(reopened.ref.current!.getMarkdown()).toContain("首段补充");
    expect((fragment.get(1) as Y.XmlElement).getAttribute("sourceRef")).toEqual(provenance);
  });

  it("一次源代码局部输入保留其他块的 CRDT 身份与来源属性", async () => {
    const doc = documentWith("甲段", "乙段", "丙段");
    const fragment = doc.getXmlFragment("content");
    const first = fragment.get(0) as Y.XmlElement<{ sourceRef: { sourceId: string } }>, last = fragment.get(2) as Y.XmlElement;
    first.setAttribute("sourceRef", { sourceId: "11111111-1111-4111-8111-111111111111" });
    const view = await mount(doc);
    await source(view, "甲段\n\n乙段补充\n\n丙段\n");
    expect(fragment.get(0)).toBe(first); expect(fragment.get(2)).toBe(last);
    expect(first.getAttribute("sourceRef")).toEqual({ sourceId: "11111111-1111-4111-8111-111111111111" });
    expect(fragment.toString()).toContain("乙段补充");
  });

  it("两台机器离线各改一段，合并后两段都在，过时源码缓存不会覆盖对方", async () => {
    const a = documentWith("甲段", "乙段"); const b = new Y.Doc(); docs.push(b);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const left = await mount(a), right = await mount(b);
    await source(left, "甲段由甲改\n\n乙段\n");
    await source(right, "甲段\n\n乙段由乙改\n");
    const ua = Y.encodeStateAsUpdate(a), ub = Y.encodeStateAsUpdate(b);
    await act(async () => { Y.applyUpdate(a, ub, "peer"); Y.applyUpdate(b, ua, "peer"); });
    expect(a.getXmlFragment("content").toString()).toBe(b.getXmlFragment("content").toString());
    for (const view of [left, right]) {
      expect(view.ref.current!.getMarkdown()).toContain("甲段由甲改");
      expect(view.ref.current!.getMarkdown()).toContain("乙段由乙改");
      expect(view.code().state.doc.toString()).toBe(view.ref.current!.getMarkdown());
    }
  });

  it("仅改变 Markdown 空白也能撤销重做，切换视图不会清掉撤销栈", async () => {
    const doc = documentWith("原文"); const view = await mount(doc);
    const initial = view.ref.current!.getMarkdown();
    await source(view, "原文\n\n\n");
    view.mode("live-preview");
    await act(async () => view.ref.current!.undo());
    expect(view.ref.current!.getMarkdown()).toBe(initial);
    view.mode("source");
    await act(async () => view.ref.current!.redo());
    expect(view.code().state.doc.toString()).toBe("原文\n\n\n");
  });

  it("源码视图的工具栏可以撤销和重做实际文本改动", async () => {
    const doc = documentWith("原文 target"); const view = await mount(doc);
    const initial = view.ref.current!.getMarkdown();
    await source(view, "原文 TARGET\n");
    await act(async () => view.ref.current!.undo());
    expect(view.code().state.doc.toString()).toBe(initial);
    await act(async () => view.ref.current!.redo());
    expect(view.code().state.doc.toString()).toBe("原文 TARGET\n");
  });

  it("源码格式操作作用于所在段落，行内格式保留可继续输入的选区", async () => {
    const doc = documentWith("这一段正文"); const view = await mount(doc);
    await source(view, "这一段正文\n第二段正文\n");
    await act(async () => view.code().dispatch({ selection: { anchor: 3 } }));
    await act(async () => view.ref.current!.toggleHeading(2));
    expect(view.code().state.doc.toString()).toBe("## 这一段正文\n第二段正文\n");
    await act(async () => view.ref.current!.toggleHeading(2));
    expect(view.code().state.doc.toString()).toBe("这一段正文\n第二段正文\n");
    await act(async () => view.code().dispatch({ selection: { anchor: 0, head: 11 } }));
    await act(async () => view.ref.current!.toggleBulletList());
    expect(view.code().state.doc.toString()).toBe("- 这一段正文\n- 第二段正文\n");
    await act(async () => view.ref.current!.toggleOrderedList());
    expect(view.code().state.doc.toString()).toBe("1. 这一段正文\n1. 第二段正文\n");
    await act(async () => view.code().dispatch({ selection: { anchor: 3, head: 5 } }));
    await act(async () => view.ref.current!.toggleStrong());
    expect(view.code().state.sliceDoc(view.code().state.selection.main.from, view.code().state.selection.main.to)).toBe("这一");
    await act(async () => view.ref.current!.toggleStrong());
    expect(view.code().state.doc.toString()).toBe("1. 这一段正文\n1. 第二段正文\n");
  });

  it("共享撤销只撤自己的输入，保留远端输入", async () => {
    const a = documentWith("甲段", "乙段"); const b = new Y.Doc(); docs.push(b); Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const left = await mount(a), right = await mount(b);
    await source(left, "甲段本机写\n\n乙段\n");
    await source(right, "甲段\n\n乙段远端写\n");
    await act(async () => Y.applyUpdate(a, Y.encodeStateAsUpdate(b), "peer"));
    left.mode("live-preview"); await act(async () => left.ref.current!.undo());
    expect(left.ref.current!.getMarkdown()).not.toContain("本机写");
    expect(left.ref.current!.getMarkdown()).toContain("远端写");
  });

  it("只读来源拒绝编辑指令与图片粘贴，仍展示正文", async () => {
    const doc = documentWith("只读正文"); const view = await mount(doc, "source", true);
    const before = Y.encodeStateAsUpdate(doc);
    await act(async () => { view.ref.current!.insertText("不该写入"); view.ref.current!.toggleStrong(); });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { items: [{ type: "image/png", getAsFile: () => new File([""], "图.png", { type: "image/png" }) }] } });
    fireEvent(view.container.querySelector(".note-source-editor .cm-content")!, event);
    expect(view.code().state.readOnly).toBe(true);
    expect(view.ref.current!.getMarkdown()).toContain("只读正文");
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("输入法组合期间收到远端段落，最后一句按增量合入而不覆盖远端", async () => {
    const a = documentWith("甲段", "乙段"), b = new Y.Doc(); docs.push(b); Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const left = await mount(a), right = await mount(b);
    const input = left.container.querySelector(".note-source-editor .cm-content")!;
    fireEvent.compositionStart(input);
    expect(left.code().compositionStarted).toBe(true);
    await source(right, "甲段远端更新\n\n乙段\n");
    await act(async () => Y.applyUpdate(a, Y.encodeStateAsUpdate(b), "peer"));
    expect(left.code().state.doc.toString()).not.toContain("远端更新");
    const end = left.code().state.doc.toString().indexOf("乙段") + 2;
    await act(async () => left.code().dispatch({ changes: { from: end, insert: "输入法尾句" } }));
    fireEvent.compositionEnd(input);
    await waitFor(() => expect(left.code().state.doc.toString()).toContain("远端更新"));
    expect(left.ref.current!.getMarkdown()).toContain("乙段输入法尾句");
    expect(left.ref.current!.getMarkdown()).toContain("甲段远端更新");
  });
  it("扩展语法跨源码、排版、编辑和重开保留", async () => {
    const doc = documentWith("正文"); const view = await mount(doc);
    const markdown = ["---", "title: 测试", "tags: [数学]", "---", "", "# 推导", "", "[toc]", "", "==重点== H~2~O x^2^ 参考[^说明]", "", "$$", String.raw`\begin{aligned}`, String.raw`a &= b+c \\`, "  &= d", String.raw`\end{aligned}`, String.raw`\label{eq-one}`, "$$", "", "[^说明]: **粗体**说明", "", "收尾"].join("\n");
    await source(view, markdown); view.mode("live-preview");
    expect(view.container.querySelectorAll(".note-source-block").length).toBe(4);
    expect(view.container.querySelector("mark")?.textContent).toBe("重点"); expect(view.container.querySelector("sub")?.textContent).toBe("2");
    await act(async () => { view.ref.current!.focusPosition({ block: 7, offset: 2 }); view.ref.current!.toggleStrong(); });
    const saved = view.ref.current!.getMarkdown()!; expect(saved).toContain("[^说明]: **粗体**说明"); expect(saved).toContain("\\label{eq-one}"); expect(saved).toContain("tags: [数学]");
    view.unmount(); const reopened = await mount(doc, "live-preview"); expect(reopened.container.querySelector("mark")?.textContent).toBe("重点");
    expect(reopened.ref.current!.getMarkdown()).toContain("[toc]");
  });
  it("脚注离开光标后显示排版正文，点击编号回到来源并可原位编辑", async () => {
    const view = await mount(documentWith('起点')); await source(view, '参考[^说明]\n\n[^说明]: **详细说明** $x^2$\n\n尾段\n'); view.mode('live-preview');
    await act(async () => view.ref.current!.focusPosition({ block: 2, offset: 0 }));
    expect(view.container.querySelector('.note-source-block[data-kind=footnote] .note-source-block__preview strong')?.textContent).toBe('详细说明');
    const block = view.container.querySelector('.note-source-block[data-kind=footnote]') as HTMLElement; expect(block.dataset.editing).toBe('false');
    const link = view.getByRole('button', { name: '前往脚注 说明' }); expect(link.textContent).toBe('[1]'); fireEvent.click(link); expect(block.dataset.editing).toBe('true');
    await act(async () => view.ref.current!.insertText('补充')); expect(view.ref.current!.getMarkdown()).toContain('[^说明]: 补充**详细说明** $x^2$');
  });

  it("字体、字号、颜色、对齐、行距和缩进在实际选区保存并重开", async () => {
    const doc = documentWith("样式正文", "后段"); const view = await mount(doc, "live-preview");
    await act(async () => { view.ref.current!.focusPosition({ block: 0, offset: 0 }); view.ref.current!.setTextStyle!({ color: "#c05640", font: "sans", size: 24 }); view.ref.current!.insertText("彩色"); view.ref.current!.setParagraphStyle!({ align: "center", leading: 2.4, indent: 1 }); });
    const saved = view.ref.current!.getMarkdown()!; expect(saved).toContain("text-align:center"); expect(saved).toContain("line-height:2.4"); expect(saved).toContain("margin-left:2em");
    await act(async () => view.ref.current!.applySource(saved));
    const paragraph = view.container.querySelector(".ProseMirror p[style*=text-align]") as HTMLElement; expect(paragraph.style.textAlign).toBe("center");
    view.unmount(); const reopened = await mount(doc, "live-preview"); expect((reopened.container.querySelector(".ProseMirror p[style*=text-align]") as HTMLElement).style.lineHeight).toBe("2.4");
  });
  it("正文查找跨不同文字格式，全部替换可以整体撤销", async () => {
    const doc = documentWith("共同 **共同**", "共同"); const view = await mount(doc, "live-preview");
    await act(async () => { view.ref.current!.focusPosition({ block: 1, offset: 9999 }); view.ref.current!.insertText("先前输入"); view.ref.current!.openSearch!(); }); const input = view.getByRole("textbox", { name: "查找文字" }); fireEvent.change(input, { target: { value: "共同" } }); fireEvent.input(input);
    expect(view.container.querySelector(".note-search-panel output")?.textContent).toBe("1 / 3");
    fireEvent.change(view.getByRole("textbox", { name: "替换为" }), { target: { value: "改后" } }); fireEvent.click(view.getByRole("button", { name: "全部替换" }));
    expect(view.ref.current!.getMarkdown()).not.toContain("共同"); await act(async () => view.ref.current!.undo()); expect(view.ref.current!.getMarkdown()).toContain("共同"); expect(view.ref.current!.getMarkdown()).toContain("先前输入");
  });

});
