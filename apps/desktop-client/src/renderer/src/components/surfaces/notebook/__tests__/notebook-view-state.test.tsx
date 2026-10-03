// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNotebookBodyMode } from "../use-notebook-body-mode";
import { useNotebookLearningEntry } from "../use-notebook-learning-entry";
import type { NoteMarkdownEditorHandle } from "../note-markdown-editor";

afterEach(cleanup);
describe("正文视图与学习任务的边界", () => {
  it.each(["overview", "recall", "expansion", "artifact"] as const)("已有 %s 仍可明确重新生成；保存失败不会启动，使用已存版保留重生成意图", async kind => {
    const start = vi.fn(), save = vi.fn(async () => false);
    const { result } = renderHook(() => useNotebookLearningEntry({ noteId: "n", hasUnversionedChanges: true,
      save, start, open: vi.fn(), lookup: async () => "existing" }));
    await act(async () => result.current.request(kind));
    expect(start).not.toHaveBeenCalled();
    act(() => result.current.prepare(kind, true));
    expect(result.current.choice).toBe(kind); expect(result.current.regenerating).toBe(true);
    await act(async () => result.current.saveAndStart());
    expect(start).not.toHaveBeenCalled();
    act(() => result.current.startSaved());
    expect(start).toHaveBeenCalledExactlyOnceWith(kind, true);
  });
  it.each(["overview", "recall", "expansion"] as const)("打开 %s 只浏览，点页面准备动作才生成一次", async kind => {
    const start = vi.fn(), open = vi.fn();
    const { result } = renderHook(() => useNotebookLearningEntry({ noteId: "n", hasUnversionedChanges: false,
      save: async () => true, start, open, lookup: async () => "missing" }));
    await act(async () => result.current.request(kind));
    expect(open).toHaveBeenCalledWith(kind); expect(result.current.choice).toBeNull(); expect(start).not.toHaveBeenCalled();
    act(() => result.current.dismiss()); expect(result.current.choice).toBeNull(); expect(start).not.toHaveBeenCalled();
    await act(async () => result.current.request(kind)); act(() => result.current.prepare(kind));
    expect(start).toHaveBeenCalledExactlyOnceWith(kind);
  });
  it("已有结果或读取失败都不会创建生成任务", async () => {
    const start = vi.fn(), lookup = vi.fn(async () => "existing" as "existing" | "error");
    const { result } = renderHook(() => useNotebookLearningEntry({ noteId: "n", hasUnversionedChanges: false,
      save: async () => true, start, open: vi.fn(), lookup }));
    await act(async () => result.current.request("overview"));
    expect(result.current.choice).toBeNull(); expect(start).not.toHaveBeenCalled();
    lookup.mockResolvedValueOnce("error"); await act(async () => result.current.request("expansion"));
    expect(result.current.choice).toBeNull(); expect(result.current.error).toContain("已有内容暂时没读到"); expect(start).not.toHaveBeenCalled();
  });
  it("输入法最后一帧结束才切换，位置按段落转移，切换不启动任务", async () => {
    let composing = true;
    const focusPosition = vi.fn();
    const ref = { current: { isComposing: () => composing, getPosition: () => ({ block: 8, offset: 5 }), focusPosition } as unknown as NoteMarkdownEditorHandle };
    const onChange = vi.fn();
    const { result } = renderHook(() => useNotebookBodyMode({ noteId: "n", initialMode: "live-preview", canEdit: true,
      editorRef: ref, scrollRef: createRef<HTMLDivElement>(), onChange }));
    expect(result.current.mode).toBe("live-preview");
    act(() => result.current.changeMode("source"));
    expect(result.current.mode).toBe("live-preview"); expect(result.current.pendingMode).toBe("source"); expect(onChange).not.toHaveBeenCalled();
    act(() => document.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(result.current.mode).toBe("live-preview");
    composing = false;
    await waitFor(() => expect(result.current.mode).toBe("source"));
    await waitFor(() => expect(focusPosition).toHaveBeenCalledWith({ block: 8, offset: 5 }));
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("只读不能进入编辑视图，权限撤销后回到预览", () => {
    const input = { noteId: "n", initialMode: "source" as const, canEdit: false,
      editorRef: createRef<NoteMarkdownEditorHandle>(), scrollRef: createRef<HTMLDivElement>(), onChange: vi.fn() };
    const { result, rerender } = renderHook((props) => useNotebookBodyMode(props), { initialProps: input });
    expect(result.current.mode).toBe("preview");
    act(() => result.current.changeMode("source")); expect(result.current.mode).toBe("preview");
    rerender({ ...input, canEdit: true }); act(() => result.current.changeMode("source")); expect(result.current.mode).toBe("source");
    rerender(input); expect(result.current.mode).toBe("preview");
  });

  it("有新正文时先选版本；保存失败不调用模型，明确使用已存版才调用", async () => {
    const start = vi.fn(); const save = vi.fn(async () => false);
    const { result } = renderHook(() => useNotebookLearningEntry({ noteId: "n", hasUnversionedChanges: true, save, start, open: vi.fn(), lookup: async () => "missing" }));
    await act(async () => result.current.request("overview")); expect(result.current.choice).toBeNull();
    act(() => result.current.prepare("overview")); expect(result.current.choice).toBe("overview"); expect(start).not.toHaveBeenCalled();
    await act(async () => result.current.saveAndStart()); expect(start).not.toHaveBeenCalled(); expect(result.current.error).toContain("版本还没存好");
    act(() => result.current.startSaved()); expect(start).toHaveBeenCalledWith("overview");
  });

  it("保存后的任务使用刚提交的版本指针，切走笔记不启动旧任务", async () => {
    let finish!: (value: boolean) => void;
    const startOld = vi.fn(), startNew = vi.fn();
    const save = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const input = { noteId: "n", hasUnversionedChanges: true, save, start: startOld, open: vi.fn(), lookup: async () => "missing" as const };
    const { result, rerender } = renderHook((props) => useNotebookLearningEntry(props), { initialProps: input });
    await act(async () => result.current.request("recall")); act(() => result.current.prepare("recall"));
    let pending!: Promise<void>; act(() => { pending = result.current.saveAndStart(); });
    rerender({ ...input, start: startNew });
    await act(async () => { finish(true); await pending; });
    expect(startOld).not.toHaveBeenCalled(); expect(startNew).toHaveBeenCalledWith("recall");
    await act(async () => result.current.request("expansion")); act(() => result.current.prepare("expansion")); act(() => { pending = result.current.saveAndStart(); });
    rerender({ ...input, noteId: "other", start: startNew });
    await act(async () => { finish(true); await pending; });
    expect(result.current.saving).toBe(false); expect(startNew).toHaveBeenCalledTimes(1);
  });
});
