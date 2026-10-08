// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NoteMindMapV1 } from "@astella/shared/note-mind-map-contracts";
import { NoteMindMapPaper } from "../note-mind-map-paper";
vi.mock("../../../../app/room-store", () => ({ useRoomStore: Object.assign((select: (state: { workspaceScopeRevision: number }) => unknown) => select({ workspaceScopeRevision: 1 }), { getState: () => ({ workspaceScopeRevision: 1 }) }) }));
vi.mock("../notebook-fullscreen-state", () => ({ useNotebookFullscreenActive: () => false, useNotebookFullscreenState: { setState: vi.fn() } }));
const fixture: NoteMindMapV1 = {
  mindMapId: "fixture", noteId: "note", noteVersionId: "version", noteVersionNumber: 1,
  title: "整篇笔记", contentHash: "hash", generationJobId: "job", modelId: "model", promptVersion: "v1", versionState: "current", createdAt: "2026-10-08T00:00:00Z",
  coverage: { totalBlocks: 1, textBlockOrdinals: [0], imageBlocksNotRead: 0, allTextRead: true },
  content: { schemaVersion: 1, rootId: "root", nodes: [
    { id: "root", parentId: null, kind: "root", label: "整篇脉络", explanation: null, references: [] },
    { id: "group", parentId: "root", kind: "group", label: "有条件的结论", explanation: null, references: [] },
    { id: "concept", parentId: "group", kind: "concept", label: "隐藏的知识点", explanation: "先核对适用条件", references: [{ blockOrdinal: 0, quote: "原文条件" }] },
  ] },
};
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(650);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function open() {
  return render(<NoteMindMapPaper map={{ ...fixture, mindMapId: crypto.randomUUID() }} currentVersionId="version" unversioned={false} regenerating={false} onRegenerate={vi.fn()} epoch={1}/>);
}
it("大纲浮于画布，完整列出折叠节点；阅读页滚轮不进入画布，Escape 返回大纲入口", () => {
  const screen = open(), canvas = screen.getByLabelText(/脑图画布/), world = screen.container.querySelector<HTMLElement>(".note-mind-map__world")!;
  expect(screen.queryByRole("complementary")).toBeNull();
  const transform = world.style.transform;
  fireEvent.click(screen.getByRole("button", { name: "大纲" }));
  const pane = screen.getByRole("complementary", { name: "脑图大纲" });
  expect(canvas.contains(pane)).toBe(false);
  expect(within(pane).getByRole("button", { name: "隐藏的知识点" })).toBeTruthy();
  fireEvent.wheel(pane, { deltaY: 100, ctrlKey: true });
  expect(world.style.transform).toBe(transform);
  fireEvent.keyDown(pane, { key: "Escape" });
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "大纲" }));
  fireEvent.wheel(canvas, { deltaY: 100 });
  expect(world.style.transform).not.toBe(transform);
});
it("从大纲选折叠后代会展开祖先并在浮动详情显示依据，关闭后焦点回到真实节点", () => {
  const screen = open();
  expect(screen.container.querySelector('[data-node-id="concept"]')).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "大纲" }));
  fireEvent.click(within(screen.getByRole("complementary", { name: "脑图大纲" })).getByRole("button", { name: "隐藏的知识点" }));
  const node = screen.container.querySelector<HTMLButtonElement>('[data-node-id="concept"]')!;
  expect(node).toBeTruthy(); expect(document.activeElement).toBe(node);
  expect(screen.queryByRole("complementary", { name: "脑图大纲" })).toBeNull();
  expect(within(screen.getByRole("complementary", { name: "节点详情" })).getByText("先核对适用条件")).toBeTruthy();
  expect(screen.getByRole("button", { name: /查看原文 v1/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "收起脑图阅读页" }));
  expect(document.activeElement).toBe(node);
});
it("浮动信息中的重新生成是明确动作，打开工具和大纲不触发生成", () => {
  const regenerate = vi.fn(), screen = render(<NoteMindMapPaper map={{ ...fixture, mindMapId: crypto.randomUUID() }} currentVersionId="version" unversioned={false} regenerating={false} onRegenerate={regenerate} epoch={1}/>);
  fireEvent.click(screen.getByRole("button", { name: "脑图信息" }));
  expect(regenerate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "重新生成脑图" }));
  expect(regenerate).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "分支" }));
  fireEvent.click(screen.getByRole("button", { name: "展开全部" }));
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "分支" }));
  expect(screen.container.querySelector('[data-node-id="concept"]')).toBeTruthy();
});
