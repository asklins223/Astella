// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import type { NoteExpansionDraftV1, NoteExpansionTaskV1 } from "@ailearn/shared/note-expansion-contracts";
import { NoteExpansionDrafts } from "../notebook-expansion-drafts";

const persist = vi.fn(async (_drafts: NoteExpansionDraftV1[]) => undefined);
function task(): NoteExpansionTaskV1 {
  return { taskId: "task", noteId: "note", noteVersionId: "version", focusAnchor: null, sourceMessageId: null, conversationId: null, status: "ready", confirmedCandidateIds: null, failureReason: null, createdAt: "2026-10-01T00:00:00Z",
    drafts: ["第一篇", "第二篇", "第三篇"].map((title, index) => ({ candidateId: String(index), requestId: "request", title, relationship: "从原笔记中的原句出发，继续理解这个主题。", sourceReferences: [{ blockOrdinal: index, quote: "这是原笔记中可以核对的原句。" }], blocks: [{ type: "paragraph", content: title + "的正文" }], selected: false })) };
}
function Fixture({ initial = task(), saving = false }: { initial?: NoteExpansionTaskV1; saving?: boolean }) {
  const [current, setCurrent] = useState<NoteExpansionTaskV1 | null>(initial);
  return <div className="notebook-desk__scroll"><NoteExpansionDrafts task={current!} saving={saving} setExpansionTask={setCurrent} persistNoteExpansionReview={persist} locateTeachingReference={() => undefined} /></div>;
}
afterEach(async () => { cleanup(); await new Promise(resolve => setTimeout(resolve, 0)); persist.mockClear(); });
function visibleCode(container: HTMLElement) {
  const dom = [...container.querySelectorAll<HTMLElement>(".cm-content")].find(node => !node.closest("[hidden]"));
  return dom ? EditorView.findFromDOM(dom) : null;
}

describe("拓展草稿先选册本，再在主位读和改", () => {
  it("封面与每篇草稿各记阅读位置，换篇从顶部开始，返回接回自己的位置", () => {
    const view = render(<Fixture />);
    const scroll = view.container.querySelector<HTMLDivElement>(".notebook-desk__scroll")!;
    scroll.scrollTop = 50;
    fireEvent.click(view.getAllByText("翻开看看")[0]!); expect(scroll.scrollTop).toBe(0);
    scroll.scrollTop = 250;
    fireEvent.click(view.getByRole("button", { name: "下一篇草稿" })); expect(scroll.scrollTop).toBe(0);
    scroll.scrollTop = 150;
    fireEvent.click(view.getByRole("button", { name: "上一篇草稿" })); expect(scroll.scrollTop).toBe(250);
    fireEvent.click(view.getByRole("button", { name: "所有草稿" })); expect(scroll.scrollTop).toBe(50);
  });
  it("打开草稿先读真实内容，三态编辑和逐篇返回保留各自工作稿", async () => {
    const view = render(<Fixture />);
    expect(view.getAllByText("翻开看看")).toHaveLength(3);
    expect(view.queryByRole("textbox")).toBeNull();
    fireEvent.click(view.getAllByText("翻开看看")[0]!);
    expect(view.getByText("第一篇的正文")).toBeTruthy();
    await waitFor(() => expect(view.container.querySelector(".cm-content")).not.toBeNull());
    expect(persist).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "纯编辑" }));
    await waitFor(() => expect(visibleCode(view.container)?.state.doc.toString()).toContain("第一篇的正文"));
    const first = visibleCode(view.container)!;
    await act(async () => first.dispatch({ changes: { from: 0, to: first.state.doc.length, insert: "第一篇保留 **修改**\n\n最后一句" } }));
    fireEvent.click(view.getByRole("button", { name: "下一篇草稿" }));
    fireEvent.click(view.getByRole("button", { name: "纯编辑" }));
    await waitFor(() => expect(visibleCode(view.container)?.state.doc.toString()).toContain("第二篇的正文"));
    fireEvent.change(view.getByRole("textbox", { name: "拓展草稿 2 标题" }), { target: { value: "第二篇改了标题" } });
    fireEvent.click(view.getByRole("button", { name: "上一篇草稿" }));
    await waitFor(() => expect(visibleCode(view.container)).toBe(first));
    expect(first.state.doc.toString()).toContain("第一篇保留 **修改**");
    fireEvent.click(view.getByRole("button", { name: "预览" }));
    const preview = [...view.container.querySelectorAll<HTMLElement>(".note-transcript")].find(node => !node.closest("[hidden]"))!;
    expect(within(preview).getByText("最后一句")).toBeTruthy();
    expect(within(preview).getByText("修改").tagName).toBe("STRONG");
    fireEvent.click(view.getByRole("button", { name: "所有草稿" }));
    expect(within(view.container.querySelector<HTMLElement>(".note-expansion-drafts__books")!).getByText("第二篇改了标题")).toBeTruthy();
    const boxes = view.getAllByRole("checkbox");
    fireEvent.click(boxes[1]!);
    expect(persist.mock.calls.at(-1)?.[0].map(draft => draft.selected)).toEqual([false, true, false]);
    expect(persist.mock.calls.at(-1)?.[0][0]?.blocks.map(block => block.content).join("\n")).toContain("最后一句");
  });

  it("已收下一篇后，其他草稿仍能编辑和选择；已收下的那篇保持固定", async () => {
    const initial = { ...task(), status: "ready" as const, confirmedCandidateIds: ["0"] };
    const view = render(<Fixture initial={initial} />);
    expect(view.getAllByText("已收下")).toHaveLength(2);
    fireEvent.click(view.getAllByText("翻开看看")[1]!);
    expect(view.getByText("第二篇的正文")).toBeTruthy();
    expect(view.getByRole("button", { name: "纯编辑" }).hasAttribute("disabled")).toBe(false);
    expect(view.getByRole("button", { name: "可编辑预览" }).hasAttribute("disabled")).toBe(false);
    expect(view.getByRole("checkbox").hasAttribute("disabled")).toBe(false);
    expect(persist).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("checkbox"));
    expect(persist).toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "上一篇草稿" }));
    expect(view.getByRole("button", { name: "纯编辑" }).hasAttribute("disabled")).toBe(true);
  });

  it.each(["纯编辑", "可编辑预览"])("保存期间保留%s的文档、视图和阅读位置", async (label) => {
    const view = render(<Fixture />);
    fireEvent.click(view.getAllByText("翻开看看")[0]!);
    fireEvent.click(view.getByRole("button", { name: label }));
    const selector = label === "纯编辑" ? ".cm-content" : ".ProseMirror";
    const findEditor = () => [...view.container.querySelectorAll<HTMLElement>(selector)].find(node => !node.closest("[hidden]"));
    await waitFor(() => expect(findEditor()).toBeTruthy());
    const editor = findEditor()!;
    expect(editor.textContent).toContain("第一篇的正文");
    const scroll = view.container.querySelector<HTMLDivElement>(".notebook-desk__scroll")!;
    scroll.scrollTop = 180;

    view.rerender(<Fixture saving />);
    expect(view.getByRole("button", { name: label }).getAttribute("aria-pressed")).toBe("true");
    expect(view.getByRole("button", { name: label }).hasAttribute("disabled")).toBe(true);
    expect(findEditor()).toBe(editor);
    expect(scroll.scrollTop).toBe(180);

    view.rerender(<Fixture />);
    expect(view.getByRole("button", { name: label }).getAttribute("aria-pressed")).toBe("true");
    expect(findEditor()).toBe(editor);
    expect(editor.textContent).toContain("第一篇的正文");
    expect(scroll.scrollTop).toBe(180);
  });
});
