// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { EditorView } from "@codemirror/view";
import { NoteDocumentEditor } from "../note-document-editor";
import type { NoteMarkdownEditorHandle } from "../note-markdown-editor";
import type { NoteBodyMode } from "../note-document-mode";
import { seedBlocksUpdate } from "../../../../test-support/note-doc-fixtures";
import { noteOutline } from "../note-outline";
import { noteSourceBlocks } from "../note-source-structure";

const docs: Y.Doc[] = [];
function documentWith(...paragraphs: string[]) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Uint8Array.from(atob(seedBlocksUpdate("标题", paragraphs.map(content => ({ type: "paragraph", content })))), c => c.charCodeAt(0)));
  docs.push(doc);
  return doc;
}
async function mount(doc: Y.Doc, mode: NoteBodyMode = "source", disabled = false) {
  const ref = createRef<NoteMarkdownEditorHandle>();
  const onChange = vi.fn();
  const props = { ref, fragment: doc.getXmlFragment("content"), initialMarkdown: "", onChange, disabled };
  const view = render(<NoteDocumentEditor {...props} mode={mode} />);
  await waitFor(() => expect(ref.current?.getMarkdown()).not.toBeNull());
  await waitFor(() => expect(view.container.querySelector(".cm-content")).not.toBeNull());
  return { ...view, ref, onChange, mode: (next: NoteBodyMode, readonly = disabled) => view.rerender(<NoteDocumentEditor {...props} disabled={readonly} mode={next} />),
    code: () => EditorView.findFromDOM(view.container.querySelector(".cm-content")!)!,
  };
}
async function source(view: Awaited<ReturnType<typeof mount>>, text: string) {
  await act(async () => view.code().dispatch({ changes: { from: 0, to: view.code().state.doc.length, insert: text } }));
}
afterEach(async () => {
  cleanup();
  await new Promise(resolve => setTimeout(resolve, 0));
  docs.splice(0).forEach(doc => doc.destroy());
});

describe("三种正文视图共用真实编辑器与 Y.Doc", () => {
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

  it("源码语法、标题六级、列表、代码、图片、表格与安全 HTML 跨视图和重开保留", async () => {
    const doc = documentWith("起点"); const view = await mount(doc);
    const text = '# 一级\n\n###### 六级\n\n- [x] 完成\n- 项目\n\n> 引用\n\n```md\n# 代码里的标题\n```\n\n![图示](https://example.com/a.png)\n\n| 列甲 | 列乙 |\n| --- | --- |\n| 一 | 二 |\n\n<script>alert("x")</script>\n\n尾段  \n换行\n';
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
    fireEvent(view.container.querySelector(".cm-content")!, event);
    expect(view.code().state.readOnly).toBe(true);
    expect(view.ref.current!.getMarkdown()).toContain("只读正文");
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("输入法组合期间收到远端段落，最后一句按增量合入而不覆盖远端", async () => {
    const a = documentWith("甲段", "乙段"), b = new Y.Doc(); docs.push(b); Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const left = await mount(a), right = await mount(b);
    const input = left.container.querySelector(".cm-content")!;
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
});
