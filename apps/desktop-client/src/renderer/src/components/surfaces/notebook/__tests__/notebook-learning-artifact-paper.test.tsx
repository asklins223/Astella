// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { noteLearningArtifactV1Schema } from "@ailearn/shared/note-learning-artifact-contracts";
import { noteBlockProjectionV1Schema } from "@ailearn/shared/note-projection-contracts";
import { NotebookLearningArtifactPaper } from "../notebook-learning-artifact-paper";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const artifact = noteLearningArtifactV1Schema.parse({
  artifactId: id(1), noteId: id(2), noteVersionId: id(3), noteVersionNumber: 2,
  generationJobId: id(4), sourceMessageId: null, conversationId: null, sourceKind: "annotation",
  selectionText: "利息加入本金后，下一次也会继续产生利息。", selectionAnchor: null,
  sourceContentHash: "a".repeat(64), generatorRef: "note_dynamic_artifact_v1@v3",
  title: "滚雪球：复利的生长", subject: "利息怎样参与下一轮增长", caution: "概念示意，数值只用来观察变化。",
  outline: [
    { index: 0, title: "利息进入本金", narration: "下一轮以更大的本金继续计算。", sectionLabel: "利息", quote: "利息加入本金后，下一次也会继续产生利息。" },
    { index: 1, title: "增长越来越明显", narration: "每一轮的新增部分也会参与之后的计算。", sectionLabel: "增长", quote: "长期积累会让增长越来越明显。" },
  ], versionState: "current", createdAt: "2026-10-02T02:38:05Z",
});
const block = noteBlockProjectionV1Schema.parse({ ordinal: 1, type: "paragraph", content: "**利息加入本金后，下一次也会继续产生利息。**" });
const props = () => ({ artifact, paperRef: null, ready: true, error: null, motion: "full" as const,
  referenceBlocks: [block], onLocateReference: vi.fn(), onRetry: vi.fn() });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("演示可以单独重新生成，生成中与失败时旧画面仍在，新结果不会自动替换当前演示", () => {
  const onRegenerate = vi.fn(), onOpenGenerated = vi.fn();
  const input = { ...props(), onRegenerate, onOpenGenerated };
  const next = { ...artifact, artifactId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "新的演示" };
  const task = { taskId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", noteId: artifact.noteId, noteVersionId: artifact.noteVersionId,
    sourceKind: "overview" as const, selectionAnchor: null, status: "running" as const, artifact: null, failureReason: null, createdAt: artifact.createdAt };
  const view = render(<NotebookLearningArtifactPaper {...input} />);
  fireEvent.click(view.getByRole("button", { name: "重新生成演示" })); expect(onRegenerate).toHaveBeenCalledOnce();
  view.rerender(<NotebookLearningArtifactPaper {...input} regenerationTask={task} />);
  expect((view.getByRole("button", { name: "重新生成演示" }) as HTMLButtonElement).disabled).toBe(true);
  expect(view.getByTitle("动态教学演示").getAttribute("src")).toContain(artifact.artifactId);
  view.rerender(<NotebookLearningArtifactPaper {...input} regenerationTask={{ ...task, status: "failed", failureReason: "unknown" }} />);
  expect(view.getByTitle("动态教学演示")).toBeTruthy(); expect(view.getByRole("button", { name: "再试一次" })).toBeTruthy();
  view.rerender(<NotebookLearningArtifactPaper {...input} regenerationTask={{ ...task, status: "ready", artifact: next }} />);
  expect(view.getByTitle("动态教学演示").getAttribute("src")).toContain(artifact.artifactId);
  expect(onOpenGenerated).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: "打开新演示" })); expect(onOpenGenerated).toHaveBeenCalledWith(next);
});

it("画面占主位，文字说明在隔离窗口外保留，原句默认合起且能准确回跳", () => {
  const input = props();
  const view = render(<NotebookLearningArtifactPaper {...input} />);
  const frame = view.getByTitle("动态教学演示");
  expect(frame.getAttribute("src")).toBe(`ailearn-app://artifact/${artifact.artifactId}#content`);
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  const explanation = view.getByRole("region", { name: "演示的文字说明" });
  expect(within(explanation).getByText("下一轮以更大的本金继续计算。")).toBeTruthy();
  expect(frame.compareDocumentPosition(explanation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect([...view.container.querySelectorAll("details")].every(details => !details.open)).toBe(true);
  const groundedSource = view.getByText("对照原句 · 利息").closest("details")!;
  fireEvent.click(within(groundedSource).getByRole("button", { name: "回到这句" }));
  expect(input.onLocateReference).toHaveBeenCalledWith(1);
  expect(view.queryByRole("heading", { name: artifact.title })).toBeNull();
});

it("画面失败时，主纸仍有完整文字说明和来源，不重复塞入第二套说明", async () => {
  vi.useFakeTimers();
  const view = render(<NotebookLearningArtifactPaper {...props()} />);
  expect(view.getByTitle("动态教学演示")).toBeTruthy();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(view.queryByTitle("动态教学演示")).toBeNull();
  expect(view.getByText("动态画面暂时无法运行，可继续阅读下方的说明。")).toBeTruthy();
  expect(view.getAllByText("下一轮以更大的本金继续计算。")).toHaveLength(1);
  expect(view.getByText("对照原句 · 利息")).toBeTruthy();
});

it("旧版本和多处相同引文只展示原文，不猜测当前回跳位置；打开失败可重试", () => {
  const input = props();
  const view = render(<NotebookLearningArtifactPaper {...input} referenceBlocks={[block, { ...block, ordinal: 2 }]} />);
  expect(view.getByText("对照原句 · 利息")).toBeTruthy();
  expect(view.queryByRole("button", { name: "回到这句" })).toBeNull();
  view.rerender(<NotebookLearningArtifactPaper {...input} artifact={{ ...artifact, versionState: "older" }} ready={false} error="读取失败" />);
  expect(view.getByRole("heading", { name: artifact.title })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "重试" }));
  expect(input.onRetry).toHaveBeenCalledTimes(1);
  expect(view.getByText("笔记 v2 · 旧版记录")).toBeTruthy();
});
