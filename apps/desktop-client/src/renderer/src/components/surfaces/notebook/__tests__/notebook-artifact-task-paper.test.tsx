// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { NoteLearningArtifactV1 } from "@astella/shared/note-learning-artifact-contracts";
import { NotebookArtifactTaskPaper, type ArtifactTaskV1 } from "../notebook-artifact-task-paper";

afterEach(cleanup);
const artifact: NoteLearningArtifactV1 = {
  artifactId: "artifact", noteId: "note", noteVersionId: "version", noteVersionNumber: 2,
  sourceKind: "overview", selectionText: null, selectionAnchor: null,
  generationJobId: null, sourceMessageId: null, conversationId: null,
  sourceContentHash: "content-hash", generatorRef: "generator", title: "复利如何累积", subject: "复利",
  caution: "根据已有原文整理", outline: [], versionState: "current", createdAt: "2026-10-01T00:00:00Z",
};

it("完成回执只显示打开入口，明确点击后才打开对应演示；失败任务保留重试", () => {
  const onOpen = vi.fn(), onStart = vi.fn();
  const ready: ArtifactTaskV1 = { taskId: "task", status: "ready", failureReason: null, artifact };
  const view = render(<NotebookArtifactTaskPaper tasks={[ready]} error={null} onOpen={onOpen} onStart={onStart} onOpenSettings={() => undefined} />);
  expect(onOpen).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: "打开演示：复利如何累积" }));
  expect(onOpen).toHaveBeenCalledWith(artifact);
  const failed: ArtifactTaskV1 = { ...ready, status: "failed", artifact: null, failureReason: "unknown" };
  view.rerender(<NotebookArtifactTaskPaper tasks={[failed]} error={null} onOpen={onOpen} onStart={onStart} onOpenSettings={() => undefined} />);
  expect(view.getByText("这个演示没做成")).toBeTruthy();
  expect(view.queryByRole("button", { name: /打开演示/ })).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "再试一次" }));
  expect(onStart).toHaveBeenCalledWith(failed);
});
