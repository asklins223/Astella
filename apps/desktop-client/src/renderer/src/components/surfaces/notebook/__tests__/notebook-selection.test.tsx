// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { noteDetailV1Schema } from "@astella/shared/note-projection-contracts";
import { noteAnnotationAnchorV1Schema, noteAnchorMatchesV1, noteAnnotationV1Schema } from "@astella/shared/note-annotation-contracts";
import { renderNoteInline } from "../note-reading-inline";
import { useNotebookSelection } from "../use-notebook-selection";
import { NotebookSelectionActions } from "../notebook-selection-actions";
import { ReadingBlock, ReadingBlockContent } from "../notebook-reading-block";
import { readNoteAnchorTextV1 } from "@astella/shared/note-annotation-contracts";
import { noteBlockRenderedTextV1 } from "@astella/shared/note-doc-schema";

const id = (n: number) => `${String(n).padStart(8, "0")}-4111-8111-8111-${String(n).padStart(12, "0")}`;
const date = "2026-10-01T00:00:00.000Z";
const content = "利息加入**本金**后，下一次也会继续产生利息。";
const blocks = [{ ordinal: 0, type: "paragraph" as const, content }, { ordinal: 1, type: "paragraph" as const, content: "下一段的内容。" }];
const note = noteDetailV1Schema.parse({ version: 1, noteId: id(1), workspaceId: id(8), title: "复利", titleSource: "manual", sourceId: null,
  currentVersionId: id(2), shareScope: "private", revision: id(2), snapshotAt: date,
  currentVersion: { versionId: id(2), noteId: id(1), versionNo: 1, contentHash: "a".repeat(32), createdAt: date, updatedAt: date, blocks },
  permissions: { canRead: true, canEdit: true, canSave: true, canShare: true } });
afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); vi.restoreAllMocks(); });

it("渲染态跨段锚点保留起止段落与显示字符偏移，正文与富文本使用同一份原句", () => {
  const body = render(<div>{blocks.map(block => <p data-block-ordinal={block.ordinal} key={block.ordinal}>{renderNoteInline(block.content)}</p>)}</div>);
  const element = body.container.firstElementChild as HTMLDivElement;
  const view = renderHook(() => useNotebookSelection({ note, blocks, bodyRef: { current: element }, active: true }));
  const range = document.createRange(), strong = element.querySelector("strong")!.firstChild!;
  range.setStart(strong, 0); range.setEnd(strong, 2);
  act(() => { window.getSelection()!.addRange(range); view.result.current.captureSelectedPassage(); });
  expect(view.result.current.selectedPassage).toMatchObject({ text: "本金", anchor: { startOffset: 4, endOffset: 6, prefix: "利息加入", suffix: "后，下一次也会继续产生利息。" } });
  range.setEnd(element.lastElementChild!.firstChild!, 3);
  act(() => { window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range); view.result.current.captureSelectedPassage(); });
  expect(view.result.current.selectedPassage?.text).toContain("下一段");
  expect(view.result.current.selectedPassage?.anchor).toMatchObject({ startBlockOrdinal: 0, endBlockOrdinal: 1,
    startOffset: 4, endOffset: 3, excerpt: "本金后，下一次也会继续产生利息。\n\n下一段", prefix: "利息加入", suffix: "的内容。" });
  act(() => { window.getSelection()!.removeAllRanges(); view.result.current.captureSelectedPassage(); });
  expect(view.result.current.selectedPassage).toBeNull();
});

it.each(["end", "start"] as const)("段落边界的 %s 空端点不进入批注锚点，过桥后仍匹配原句", (boundary) => {
  const body = render(<div>{blocks.map(block => <p data-block-ordinal={block.ordinal} key={block.ordinal}>{renderNoteInline(block.content)}</p>)}</div>);
  const element = body.container.firstElementChild as HTMLDivElement;
  const view = renderHook(() => useNotebookSelection({ note, blocks, bodyRef: { current: element }, active: true }));
  const range = document.createRange();
  const first = element.firstElementChild!, last = element.lastElementChild!;
  if (boundary === "end") {
    range.setStart(first.firstChild!, 0);
    range.setEnd(last.firstChild!, 0);
  } else {
    range.setStart(first.lastChild!, first.lastChild!.textContent!.length);
    range.setEnd(last.firstChild!, 3);
  }
  act(() => { window.getSelection()!.addRange(range); view.result.current.captureSelectedPassage(); });
  const passage = view.result.current.selectedPassage;
  expect(passage?.anchor).toMatchObject(boundary === "end"
    ? { startBlockOrdinal: 0, endBlockOrdinal: 0, startOffset: 0, endOffset: noteBlockRenderedTextV1("paragraph", content).length }
    : { startBlockOrdinal: 1, endBlockOrdinal: 1, startOffset: 0, endOffset: 3 });
  const parsed = noteAnnotationAnchorV1Schema.parse(passage!.anchor);
  expect(passage!.text).toBe(parsed.excerpt);
  expect(noteAnchorMatchesV1(blocks, parsed)).toBe(true);
});

it("选区浮签提供真正可点击的解释、手写、伴星动作，并限制在可视纸面内", () => {
  const paper = document.createElement("div"); document.body.append(paper);
  paper.tabIndex = 0;
  vi.spyOn(paper, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 80, 700, 500));
  paper.style.transform = "scale(1.5)";
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(390);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(80);
  const range = document.createRange();
  Object.defineProperty(range, "getClientRects", { value: () => [new DOMRect(700, 540, 90, 30)] });
  Object.defineProperty(range, "getBoundingClientRect", { value: () => new DOMRect(700, 540, 90, 30) });
  const onWrite = vi.fn(), onAskCompanion = vi.fn(), onExplain = vi.fn(), onDismiss = vi.fn();
  const view = render(<NotebookSelectionActions range={range} scrollRef={{ current: paper }} hasAnchor busy={false} dirty={false}
    onWrite={onWrite} onExplain={onExplain} onAskCompanion={onAskCompanion} onDismiss={onDismiss} />);
  const slip = view.getByRole("group", { name: "已选原文" });
  expect(slip.style.visibility).not.toBe("hidden"); expect(parseFloat(slip.style.top)).toBeLessThan(580);
  expect(parseFloat(slip.style.left) + slip.offsetWidth).toBeLessThanOrEqual(792);
  expect(parseFloat(slip.style.top) + slip.offsetHeight).toBeLessThanOrEqual(572);
  fireEvent.click(within(slip).getByRole("button", { name: "写批注" })); expect(onWrite).toHaveBeenCalledTimes(1);
  fireEvent.click(within(slip).getByRole("button", { name: "发给伴星" })); expect(onAskCompanion).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(paper);
  fireEvent.click(within(slip).getByRole("button", { name: "原句解读" })); expect(onExplain).toHaveBeenCalledTimes(1);
  expect(slip.parentElement).toBe(document.body);
  fireEvent.keyDown(slip, { key: "Escape" }); expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(paper);
  paper.remove();
});

it("跨段批注直接覆盖两段原句，不添加摘录占位；代码和表格也使用全块字符偏移", () => {
  const bounds = { startBlockOrdinal: 0, endBlockOrdinal: 1, startOffset: 4, endOffset: 3 };
  const anchor = { noteVersionId: id(2), ...bounds, ...readNoteAnchorTextV1(blocks, bounds)! };
  const annotation = noteAnnotationV1Schema.parse({ annotationId: id(3), noteId: id(1), anchor,
    explanation: "两段共同说明复利。", sourceMessageId: null, generationJobId: null, revision: 1, versionState: "current", createdAt: date, updatedAt: date });
  const open = vi.fn();
  const view = render(<div>{blocks.map(block => <ReadingBlock key={block.ordinal} block={note.currentVersion.blocks[block.ordinal]!}
    mark={null} annotations={[annotation]} onOpenAnnotation={open} />)}</div>);
  const markers = view.getAllByRole("button", { name: `打开批注：${anchor.excerpt.replace(/\s+/g, " ")}` });
  expect(markers.map(marker => marker.textContent).join("")).toBe(anchor.excerpt.replace(/\n/g, ""));
  fireEvent.click(markers.at(-1)!); expect(open).toHaveBeenCalledWith(annotation);
  expect(view.container.querySelector(".note-annotation-tabs")).toBeNull();
  view.unmount();
  for (const [type, content] of [["code", "**raw**\ntext"], ["paragraph", "| A | **B** |\n| -- | -- |\n| C | D |"]] as const) {
    const block = { ...note.currentVersion.blocks[0]!, type, content };
    const plain = noteBlockRenderedTextV1(type, content);
    const local = { ...annotation, anchor: { ...anchor, startBlockOrdinal: 0, endBlockOrdinal: 0, startOffset: 1, endOffset: plain.length - 1 } };
    const rendered = render(<ReadingBlockContent block={block} mark={null} annotations={[local]} onOpenAnnotation={open} />);
    expect(rendered.container.textContent).toBe(plain);
    expect(rendered.getAllByRole("button").map(marker => marker.textContent).join("")).toBe(plain.slice(1, -1));
    rendered.unmount();
  }
});

it("批注标记覆盖真实原句并可打开，编号与预览不污染下一次选区字符", () => {
  const annotation = noteAnnotationV1Schema.parse({ annotationId: id(3), noteId: id(1),
    anchor: { noteVersionId: id(2), startBlockOrdinal: 0, endBlockOrdinal: 0, startOffset: 4, endOffset: 6, excerpt: "本金", prefix: "利息加入", suffix: "后，下一次也会继续产生利息。" },
    explanation: "会参与下轮计算。", sourceMessageId: null, generationJobId: null, revision: 1, versionState: "current", createdAt: date, updatedAt: date });
  const onOpenAnnotation = vi.fn();
  const view = render(<p>{renderNoteInline(content, { annotations: [annotation], onOpenAnnotation })}</p>);
  const marker = view.getByRole("button", { name: "打开批注：本金" });
  expect(marker.textContent).toBe("本金");
  expect(view.getByRole("button", { name: "批注 1 · 自己的批注：本金" }).getAttribute("data-number")).toBe("1");
  expect(view.container.textContent).toBe("利息加入本金后，下一次也会继续产生利息。");
  fireEvent.click(marker); expect(onOpenAnnotation).toHaveBeenCalledWith(annotation);
});
