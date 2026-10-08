// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ReadingBlock } from "../notebook-reading-block";
import { noteReadingText } from "../note-reading-text";
import { useNotebookSelection } from "../use-notebook-selection";
import { noteBlockRenderedTextV1, noteBlocksToPmNodes, pmNodesToNoteBlocks } from "@astella/shared/note-doc-schema";
import { noteAnchorMatchesV1 } from "@astella/shared/note-annotation-contracts";
import type { NoteDetailV1 } from "@astella/shared/note-projection-contracts";

afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); });

it("多处脚注编号一致、正文可跳转、定义可阅读，批注字符流仍与服务端一致", () => {
  const blocks = [{ ordinal: 0, type: "paragraph" as const, content: "首处[^A] 后续文字" }, { ordinal: 1, type: "paragraph" as const, content: "另一处[^B] 再次[^A]" }, { ordinal: 2, type: "paragraph" as const, content: "[^A]: **第一条**解释" }, { ordinal: 3, type: "paragraph" as const, content: "[^B]: 第二条解释" }];
  const documentSource = blocks.map(block => block.content).join("\n\n");
  const view = render(<article className="note-transcript">{blocks.map(block => <ReadingBlock key={block.ordinal} block={block} mark={null} documentSource={documentSource} />)}</article>);
  expect(view.getAllByRole("link", { name: /前往脚注/ }).map(link => link.textContent)).toEqual(["1", "2", "1"]);
  expect(view.getByText("第一条").tagName).toBe("STRONG"); expect(view.getByText("第二条解释")).not.toBeNull();
  for (const root of view.container.querySelectorAll<HTMLElement>("[data-note-block-content]")) { const block = blocks[Number(root.parentElement!.dataset.blockOrdinal)]!; expect(noteReadingText(root)).toBe(noteBlockRenderedTextV1(block.type, block.content)); }
});

it("独立公式排出指数与分数，行内公式也排版；TeX 源码往返不改变", () => {
  const blocks = [{ type: "paragraph" as const, content: "$$\nA = P(1 + r)^n\n$$" },
    { type: "paragraph" as const, content: "增长为 $\\frac{A}{P}$，这里是**正文**。" }];
  expect(pmNodesToNoteBlocks(noteBlocksToPmNodes(blocks))).toEqual(blocks);
  const view = render(<>{blocks.map((block, ordinal) => <ReadingBlock key={ordinal} block={{ ...block, ordinal }} mark={null} />)}</>);
  expect(view.container.querySelectorAll(".katex")).toHaveLength(2);
  expect(view.container.querySelector(".msupsub")).not.toBeNull();
  expect(view.container.querySelector(".mfrac")).not.toBeNull();
  expect(view.getAllByRole("math").map(node => node.getAttribute("aria-label"))).toEqual(["A = P(1 + r)^n", "\\frac{A}{P}"]);
  for (const root of view.container.querySelectorAll<HTMLElement>("[data-note-block-content]")) {
    const block = blocks[Number(root.parentElement!.dataset.blockOrdinal)]!;
    expect(noteReadingText(root)).toBe(noteBlockRenderedTextV1(block.type, block.content));
  }
});

it("代码、美元金额与转义美元仍是原文，无法排版的公式保留源码，模型命令不能插入链接或脚本", () => {
  const view = render(<><ReadingBlock block={{ ordinal: 0, type: "code", content: "$$ x^2 $$" }} mark={null} />
    <ReadingBlock block={{ ordinal: 1, type: "paragraph", content: "价格 $100 和 $200，转义 \\$x^2\\$。" }} mark={null} />
    <ReadingBlock block={{ ordinal: 2, type: "paragraph", content: "$$ \\broken{x} $$" }} mark={null} />
    <ReadingBlock block={{ ordinal: 3, type: "paragraph", content: "$\\href{javascript:alert(1)}{x}$" }} mark={null} /></>);
  expect(view.container.querySelector("pre")!.textContent).toBe("$$ x^2 $$");
  expect(view.container.querySelectorAll("[data-block-ordinal='1'] .katex")).toHaveLength(0);
  expect(view.container.querySelector(".note-math-error")!.textContent).toBe("$$ \\broken{x} $$");
  expect(view.container.querySelector("a")).toBeNull(); expect(view.container.querySelector("script")).toBeNull();
});

it("选中公式之后的文字，锚点按原始字符流计算，不被 KaTeX 的重复字形推偏", () => {
  const content = "利息用 $A=P(1+r)^n$ 计算，下一轮继续。";
  const blocks = [{ ordinal: 0, type: "paragraph" as const, content }];
  const body = document.createElement("div"); document.body.append(body);
  const rendered = render(<ReadingBlock block={blocks[0]!} mark={null} />, { container: body });
  const note = { noteId: "11111111-4111-4111-8111-111111111111", currentVersionId: "22222222-4222-4222-8222-222222222222", currentVersion: { blocks } } as NoteDetailV1;
  const hook = renderHook(() => useNotebookSelection({ note, blocks, bodyRef: { current: body }, active: true }));
  const last = body.querySelector("[data-note-block-content] p")!.lastChild!;
  const range = document.createRange(); range.setStart(last, 4); range.setEnd(last, 10);
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  act(() => hook.result.current.captureSelectedPassage());
  const anchor = hook.result.current.selectedPassage?.anchor;
  expect(anchor?.excerpt).toBe("下一轮继续。");
  expect(anchor && noteAnchorMatchesV1(blocks, anchor)).toBe(true);
  hook.unmount(); rendered.unmount(); body.remove();
});
