// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { noteAnnotationV1Schema } from "@ailearn/shared/note-annotation-contracts";
import type { NoteLearningArtifactV1 } from "@ailearn/shared/note-learning-artifact-contracts";
import { NoteAnnotationMark } from "../note-annotation-mark";
import { NoteAnnotationSidePage } from "../note-annotation-side-page";
import { ReadingBlockContent } from "../notebook-reading-block";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const date = "2026-10-02T00:00:00.000Z";
const annotation = noteAnnotationV1Schema.parse({
  annotationId: id(1), noteId: id(2), anchor: { noteVersionId: id(3), startBlockOrdinal: 1, startOffset: 0, endBlockOrdinal: 1,
    endOffset: 4, excerpt: "声音配音", prefix: "", suffix: "" },
  explanation: "这是**零样本配音**。\n\n- **速度**：更快。\n- **语言**：支持五种。\n\n<script>alert('x')</script>",
  sourceMessageId: null, generationJobId: id(4), revision: 1, versionState: "current", createdAt: date, updatedAt: date,
});
const artifact: NoteLearningArtifactV1 = { artifactId: id(5), noteId: id(2), noteVersionId: id(3), noteVersionNumber: 1,
  sourceKind: "annotation", selectionText: annotation.anchor.excerpt, selectionAnchor: annotation.anchor,
  generationJobId: id(6), sourceMessageId: null, conversationId: null, sourceContentHash: "a".repeat(64), generatorRef: "generator",
  title: "声音的参考样本", subject: "零样本配音", caution: "依据笔记原文", outline: [], versionState: "current", createdAt: date };
const props = (): ComponentProps<typeof NoteAnnotationSidePage> => ({ annotation, task: null, artifactTasks: [], artifactStarting: false,
  onAsk: vi.fn(), onCreateArtifact: vi.fn(), onOpenArtifact: vi.fn(), onRetry: vi.fn(), onSettings: vi.fn() });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("长解释按 Markdown 排版，演示入口出现在原句和解释之前，模型 HTML 只显示为文字", () => {
  const input = props();
  const view = render(<NoteAnnotationSidePage {...input} />);
  const explanation = view.container.querySelector(".note-annotation-paper__explanation")!;
  expect(within(explanation as HTMLElement).getByText("零样本配音").tagName).toBe("STRONG");
  expect(explanation.querySelectorAll("li")).toHaveLength(2);
  expect(explanation.textContent).not.toContain("**");
  expect(explanation.textContent).toContain("<script>alert('x')</script>");
  expect(explanation.querySelector("script")).toBeNull();
  const action = view.getByRole("button", { name: "做个互动演示" });
  expect(action.compareDocumentPosition(explanation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(view.container.querySelector("details.note-annotation-paper__source")?.hasAttribute("open")).toBe(false);
  fireEvent.click(action);
  expect(input.onCreateArtifact).toHaveBeenCalledWith(annotation.anchor);
});

it("已有演示按原句复用并打开同一份快照；生成中不会重复发起任务", () => {
  const input = props();
  const task = { taskId: id(6), noteId: id(2), noteVersionId: id(3), sourceKind: "annotation" as const,
    selectionAnchor: annotation.anchor, status: "ready" as const, artifact, failureReason: null, createdAt: date };
  const view = render(<NoteAnnotationSidePage {...input} artifactTasks={[task]} />);
  fireEvent.click(view.getByRole("button", { name: "打开互动演示" }));
  expect(input.onOpenArtifact).toHaveBeenCalledWith(artifact);
  expect(input.onCreateArtifact).not.toHaveBeenCalled();
  view.rerender(<NoteAnnotationSidePage {...input} artifactTasks={[{ ...task, status: "running", artifact: null }]} />);
  expect((view.getByRole("button", { name: "正在做演示…" }) as HTMLButtonElement).disabled).toBe(true);
});

it.each([110, 470])("批注短预览在纸面 y=%i 附近自动避边，不进入原句字符流；关闭后仍可打开详情", (top) => {
  const long = { ...annotation, explanation: `**零样本配音**\n\n${"这是一段很长的解释。".repeat(30)}` };
  const onOpen = vi.fn();
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(270);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(120);
  const view = render(<div className="notebook-desk__scroll"><NoteAnnotationMark annotation={long} number={1} onOpen={onOpen}>声音配音</NoteAnnotationMark></div>);
  const paper = view.container.firstElementChild!;
  const marker = view.getByRole("button", { name: "打开批注：声音配音" });
  vi.spyOn(paper, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 700, 400));
  vi.spyOn(marker, "getClientRects").mockReturnValue([new DOMRect(730, top, 60, 20)] as unknown as DOMRectList);
  fireEvent.focus(marker);
  const preview = view.getByRole("tooltip");
  expect(preview.textContent).toContain("零样本配音");
  expect(preview.textContent).not.toContain("**");
  expect(preview.querySelector("p")!.textContent!.length).toBeLessThanOrEqual(91);
  expect(parseFloat(preview.style.top)).toBeGreaterThanOrEqual(108);
  expect(parseFloat(preview.style.top) + preview.offsetHeight).toBeLessThanOrEqual(492);
  expect(parseFloat(preview.style.left) + preview.offsetWidth).toBeLessThanOrEqual(792);
  expect(preview.parentElement).toBe(document.body);
  expect(paper.textContent).toBe("声音配音");
  fireEvent.keyDown(marker, { key: "Escape" });
  expect(view.queryByRole("tooltip")).toBeNull();
  fireEvent.keyDown(marker, { key: "Enter" });
  expect(onOpen).toHaveBeenCalledWith(long);
});

it("完整批注展开后，不因正文重排或键盘聚焦再次叠加同一句的短预览", () => {
  const block = { ordinal: 1, type: "paragraph" as const, content: "声音配音" };
  const view = render(<ReadingBlockContent block={block} mark={null} annotations={[annotation]} />);
  fireEvent.focus(view.getByRole("button", { name: "打开批注：声音配音" }));
  expect(view.getByRole("tooltip")).toBeTruthy();
  view.rerender(<ReadingBlockContent block={block} mark={null} annotations={[annotation]} openAnnotationId={annotation.annotationId} />);
  const marker = view.getByRole("button", { name: "打开批注：声音配音" });
  expect(marker.getAttribute("aria-expanded")).toBe("true");
  fireEvent.focus(marker);
  fireEvent.mouseEnter(marker);
  expect(view.queryByRole("tooltip")).toBeNull();
});
