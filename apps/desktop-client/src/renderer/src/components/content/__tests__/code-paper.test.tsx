// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { NoteDocumentEditor } from "../../surfaces/notebook/note-document-editor";
import type { NoteMarkdownEditorHandle } from "../../surfaces/notebook/note-markdown-editor";
import { ReadingBlock } from "../../surfaces/notebook/notebook-reading-block";
import { noteReadingText } from "../../surfaces/notebook/note-reading-text";
import { seedBlocksUpdate } from "../../../test-support/note-doc-fixtures";
import { renderCompanionMarkdown } from "../../companion/companion-markdown";
import { CompanionCodeBlock } from "../../companion/companion-rich-content";
import { highlightCodeBlock } from "../code-tokens";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const code = (content: string) => render(<ReadingBlock block={{ type: "code", ordinal: 0, content }} mark={null} />);

it("js 围栏在读侧按 token 上色，纸沿上说清是哪门语言", async () => {
  const view = code("```js\nconst total = 42; // 计数\n```");
  await waitFor(() => expect(view.getByText("JavaScript")).toBeTruthy());
  expect(view.container.querySelector(".code-keyword")?.textContent).toBe("const");
  expect(view.container.querySelector(".code-comment")?.textContent).toContain("计数");
  expect(view.container.querySelector(".code-number")?.textContent).toBe("42");
  // 上色只是往同一串字上挂 class，切片拼回去必须还是那段源码。
  expect(view.container.querySelector(".code-body")?.textContent).toBe("const total = 42; // 计数");
});

it("认不出的语言照原文画，标签照抄围栏里写的那几个字", async () => {
  const view = code("```notalanguage\n@@@\n```");
  await waitFor(() => expect(view.getByText("notalanguage")).toBeTruthy());
  expect(view.container.querySelector(".code-body span")).toBeNull();
  expect(view.container.querySelector(".code-body")?.textContent).toBe("@@@");
});

it("切片改变不了批注的字符区间：跨 token 的高亮仍是那串字", async () => {
  const view = render(<ReadingBlock block={{ type: "code", ordinal: 0, content: "```js\nconst total = 42;\n```" }} mark={[0, 12]} />);
  await waitFor(() => expect(view.container.querySelector(".code-keyword")).not.toBeNull());
  const marked = Array.from(view.container.querySelectorAll(".mark")).map((node) => node.textContent ?? "");
  expect(marked.join("")).toBe("const total ");
});

it("复制走主进程，成功后纸沿上说已复制", async () => {
  const writeText = vi.fn(async () => ({ ok: true, data: { written: true } }));
  window.astella = { clipboard: { writeText } } as never;
  const view = code("```js\nconst a = 1;\n```");
  await waitFor(() => expect(view.container.querySelector(".code-keyword")).not.toBeNull());
  fireEvent.click(view.getByRole("button", { name: "复制这段代码" }));
  expect(writeText).toHaveBeenCalledWith(expect.objectContaining({ request: { text: "const a = 1;" } }));
  await waitFor(() => expect(view.getByRole("button", { name: "复制这段代码" }).textContent).toBe("已复制"));
});

it("纸沿那几个字不进正文的字符流：批注与选中数到的还是那串代码", async () => {
  const view = code("```js\nconst a = 1;\n```");
  await waitFor(() => expect(view.getByText("JavaScript")).toBeTruthy());
  expect(noteReadingText(view.container.querySelector("[data-note-block-content]")!)).toBe("const a = 1;");
});

it("三视图发出同一批类：编辑态的代码块与源码态的围栏都走这套 token", async () => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Uint8Array.from(atob(seedBlocksUpdate("标题", [{ type: "paragraph", content: "```javascript\nconst answer = 1;\n```" }])), c => c.charCodeAt(0)));
  const ref = createRef<NoteMarkdownEditorHandle>();
  const props = { ref, fragment: doc.getXmlFragment("content"), initialMarkdown: "", onChange: () => {}, imageUploads: [] as const };
  const view = render(<NoteDocumentEditor {...props} mode="live-preview" />);
  await waitFor(() => expect(ref.current?.getMarkdown()).not.toBeNull());
  await waitFor(() => expect(view.container.querySelector(".milkdown-code-block .cm-content .code-keyword")).not.toBeNull(), { timeout: 8_000 });
  await act(async () => view.rerender(<NoteDocumentEditor {...props} mode="source" />));
  await waitFor(() => expect(view.container.querySelector(".note-source-editor .cm-content .code-keyword")).not.toBeNull(), { timeout: 8_000 });
  doc.destroy();
});

it("伴星回复里的代码与笔记读的是同一张纸：聊天围栏和交付纸都上色", async () => {
  const chat = render(<div>{renderCompanionMarkdown("先看这句。\n\n```python\ndef 复利(本金, 年数):\n    return 本金 * 年数\n```")}</div>);
  await waitFor(() => expect(chat.getByText("Python")).toBeTruthy());
  expect(chat.container.querySelector(".code-keyword")?.textContent).toBe("def");
  expect(chat.container.querySelector(".code-call")?.textContent).toBe("复利");
  expect(chat.container.querySelector(".code-body")?.textContent).toBe("def 复利(本金, 年数):\n    return 本金 * 年数");

  const sheet = render(<CompanionCodeBlock block={{ type: "code", language: "sql", code: "select 名称 from 笔记" } as never} />);
  await waitFor(() => expect(sheet.container.querySelector(".code-keyword")?.textContent).toBe("select"));
  // 交付纸自己那套语言与复制留在原处，接进来的只有颜色。
  expect(sheet.getByText("sql")).toBeTruthy();
  expect(sheet.getByRole("button", { name: "复制代码" })).toBeTruthy();
});

it("语言表与编辑器共用一份：官方名进标签，解析不了的交回原文", async () => {
  const python = await highlightCodeBlock("def 名称():\n    return 1\n", "py");
  expect(python.label).toBe("Python");
  expect(python.lines?.flat().some((slice) => slice.classes.includes("code-keyword"))).toBe(true);
  expect(await highlightCodeBlock("no fence here", undefined)).toEqual({ source: "no fence here", label: "纯文本", lines: null });
});

it("她一个字一个字写进来时，画的是当前那串字，不是上一帧的切片", async () => {
  const view = render(<div>{renderCompanionMarkdown("```js\nconst a = 1;")}</div>);
  await waitFor(() => expect(view.container.querySelector(".code-keyword")).not.toBeNull());
  view.rerender(<div>{renderCompanionMarkdown("```js\nconst a = 12;")}</div>);
  // 新的解析还没回来：宁可这一帧不上色，也不能拿旧切片盖住新字或闪一下空白。
  expect(view.container.querySelector(".code-body")?.textContent).toBe("const a = 12;");
  await waitFor(() => expect(view.container.querySelector(".code-keyword")).not.toBeNull());
  expect(view.container.querySelector(".code-body")?.textContent).toBe("const a = 12;");
});
