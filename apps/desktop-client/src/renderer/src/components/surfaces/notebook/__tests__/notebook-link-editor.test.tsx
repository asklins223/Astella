// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import { EditorView } from "@codemirror/view";
import { NoteDocumentEditor } from "../note-document-editor";
import type { NoteMarkdownEditorHandle } from "../note-markdown-editor";
import { notebookLinkHref, useNotebookLinkEditor } from "../notebook-link-editor";
import { seedBlocksUpdate } from "../../../../test-support/note-doc-fixtures";

const docs: Y.Doc[] = [];
afterEach(() => { cleanup(); docs.splice(0).forEach(doc => doc.destroy()); });

async function mount(mode: "source" | "live-preview" = "source") {
  const doc = new Y.Doc(); docs.push(doc);
  Y.applyUpdate(doc, Uint8Array.from(atob(seedBlocksUpdate("链接复测", [{ type: "paragraph", content: "前文选中文字后文" }])), c => c.charCodeAt(0)));
  const ref = createRef<NoteMarkdownEditorHandle>();
  function Harness() {
    const link = useNotebookLinkEditor(ref, "test-note", true);
    return <><NoteDocumentEditor ref={ref} mode={mode} fragment={doc.getXmlFragment("content")} initialMarkdown="" onChange={() => {}} />
      <button onClick={link.open}>链接工具</button>{link.dialog}</>;
  }
  const view = render(<Harness />);
  await waitFor(() => expect(ref.current?.getMarkdown()).toBeTruthy());
  return { ...view, ref, code: () => EditorView.findFromDOM(view.container.querySelector(".cm-content")!)! };
}

it("rejects empty, incomplete and executable destinations", () => {
  for (const value of ["", "https://", "javascript:alert(1)", "data:text/html,hello", "file:///tmp/private"]) expect(notebookLinkHref(value)).toBeNull();
  expect(notebookLinkHref(" https://example.com/qa ")).toBe("https://example.com/qa");
  expect(notebookLinkHref("mailto:qa@example.com")).toBe("mailto:qa@example.com");
});

it("cancel keeps the live source and its text selection", async () => {
  const view = await mount();
  await act(async () => view.code().dispatch({ selection: { anchor: 2, head: 6 } }));
  fireEvent.click(view.getByText("链接工具"));
  fireEvent.change(view.getByLabelText("链接地址"), { target: { value: "https://" } });
  expect((view.getByRole("button", { name: "插入链接" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(view.getByRole("button", { name: "取消" }));
  expect(view.ref.current!.getMarkdown()).toBe("前文选中文字后文\n");
  expect(view.code().state.selection.main.from).toBe(2);
  expect(view.code().state.selection.main.to).toBe(6);
  expect(document.activeElement).toBe(view.code().contentDOM);
});

it("applies a complete address to the selected source text after modal focus", async () => {
  const view = await mount();
  await act(async () => view.code().dispatch({ selection: { anchor: 2, head: 6 } }));
  fireEvent.click(view.getByText("链接工具"));
  fireEvent.change(view.getByLabelText("链接地址"), { target: { value: "https://example.com/qa" } });
  fireEvent.click(view.getByRole("button", { name: "插入链接" }));
  expect(view.ref.current!.getMarkdown()).toBe("前文[选中文字](https://example.com/qa)后文\n");
  expect(view.queryByRole("dialog")).toBeNull();
});

it("an empty selection inserts a readable link in the rich editor", async () => {
  const view = await mount("live-preview");
  await act(async () => view.ref.current!.focusPosition({ block: 0, offset: 0 }));
  fireEvent.click(view.getByText("链接工具"));
  fireEvent.change(view.getByLabelText("链接地址"), { target: { value: "https://example.com/qa" } });
  fireEvent.click(view.getByRole("button", { name: "插入链接" }));
  expect(view.container.querySelector(".ProseMirror a")?.getAttribute("href")).toBe("https://example.com/qa");
  expect(view.container.querySelector(".ProseMirror a")?.textContent).toBe("https://example.com/qa");
  expect(view.ref.current!.getMarkdown()).toContain("前文选中文字后文");
  expect(document.activeElement).toBe(view.container.querySelector(".ProseMirror"));
});
