// @vitest-environment jsdom
/**
 * 纯编辑态的批注记号（41 §1.4 / §7.1「三态与批注」）。
 *
 * 这里量三件事，最后一件最要紧：
 * 1. 有批注的行**画出记号**；
 * 2. 点记号打开**同一张**旁页；
 * 3. **源码一个字符都没多**——41 §1.4 的硬要求：「不把批注文字或装饰标记写进
 *    Markdown」。第 3 条是这一族里最容易犯的错，而且症状很隐蔽：屏幕看着对，
 *    保存之后正文里多出 `<!-- 批注 -->`。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { NoteSourceEditor, type NoteSourceEditorHandle } from "../note-source-editor";
import type { NoteMarkdownEditorHandle } from "../note-markdown-editor";
import type { AnnotationPlacement } from "../note-annotation-placement";

const SOURCE = [
  "# 提取练习",
  "",
  "提取练习让大脑重新构建记忆痕迹。",
  "",
  "第二段讲间隔效应。",
].join("\n");

/** 只有 `getMarkdown` / `subscribe` / `applySource` 会被用到；其余是 handle 的形状。 */
function stubEditor(initial: string) {
  let current = initial;
  const listeners = new Set<() => void>();
  const handle: NoteMarkdownEditorHandle = {
    getMarkdown: () => current,
    setMarkdown: (value) => { current = value; },
    focus: vi.fn(),
    insertText: vi.fn(),
    replaceImageSrc: vi.fn(),
    removeImageSrc: vi.fn(),
    toggleStrong: vi.fn(),
    toggleEmphasis: vi.fn(),
    toggleInlineCode: vi.fn(),
    toggleHeading: vi.fn(),
    toggleBlockquote: vi.fn(),
    toggleBulletList: vi.fn(),
    toggleOrderedList: vi.fn(),
    toggleLink: vi.fn(),
    insertCodeBlock: vi.fn(),
    insertHr: vi.fn(),
    applySource: (value) => { current = value; return true; },
    undo: vi.fn(),
    redo: vi.fn(),
    getPosition: () => ({ block: 0, offset: 0 }),
    focusPosition: vi.fn(),
    isComposing: () => false,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return { handle, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    publish: (value: string) => { current = value; for (const listener of listeners) listener(); } };
}

function mount(source: string, placements: readonly AnnotationPlacement[], onOpen?: (id: string) => void) {
  const editor = stubEditor(source);
  const handleRef = createRef<NoteSourceEditorHandle | null>() as { current: NoteSourceEditorHandle | null };
  const view = render(<NoteSourceEditor
    editor={editor.handle}
    handleRef={handleRef as never}
    disabled={false}
    onChange={() => undefined}
    annotationPlacements={placements}
    onOpenAnnotation={onOpen}
  />);
  return { ...view, editor };
}

const PLACEMENT: AnnotationPlacement = {
  annotationId: "a-1",
  number: 1,
  // 块 1 = 正文第一段（「提取练习让大脑重新构建记忆痕迹。」）
  blocks: [{ ordinal: 1, range: [0, 7] }],
};

afterEach(cleanup);

describe("纯编辑态的批注记号", () => {
  it("正控制：有批注的块那一行画出记号，且带得上编号与无障碍名", () => {
    const { container } = mount(SOURCE, [PLACEMENT]);
    const mark = container.querySelector(".note-annotation-source");
    expect(mark).not.toBeNull();
    expect(mark?.getAttribute("data-annotation-id")).toBe("a-1");
    expect(mark?.getAttribute("data-annotation-number")).toBe("1");
    expect(mark?.getAttribute("aria-label")).toBe("这一段有批注");
    expect(mark?.getAttribute("role")).toBe("button");
    // 记号落在**正文那一段**上，不是文件头那一行。
    expect(mark?.textContent).toContain("提取练习让大脑重新构建记忆痕迹。");
  });

  /**
   * 反面判据：没有批注时**一个记号都不画**。
   *
   * 只断言「有批注时画了」是半个空断言——一个永远画记号的实现也能过。配上这一条，
   * 记号才真的跟着集合走。
   */
  it("没有批注时不出记号；批次下标落在不存在的块上也不画", () => {
    const { container } = mount(SOURCE, []);
    expect(container.querySelector(".note-annotation-source")).toBeNull();

    // 块下标越界（正文只有 3 块）——不画，而不是画在最后一行冒充。
    const outOfRange: AnnotationPlacement = { ...PLACEMENT, blocks: [{ ordinal: 99, range: null }] };
    const second = mount(SOURCE, [outOfRange]);
    expect(second.container.querySelector(".note-annotation-source")).toBeNull();
    second.unmount();
  });

  it("源码一个字符都没多：记号是装饰，不是正文", () => {
    const { container, editor } = mount(SOURCE, [PLACEMENT]);
    expect(container.querySelector(".note-annotation-source")).not.toBeNull();
    // 屏上画了记号之后，编辑器里那份 Markdown 必须逐字不变。
    expect(editor.handle.getMarkdown()).toBe(SOURCE);
    // 也不许把批注内容写进 DOM 的文本里。
    expect(container.textContent).not.toContain("<!--");
  });

  it("点记号打开同一张旁页（回调拿到的是那个 annotationId）", () => {
    const opened: string[] = [];
    const { container } = mount(SOURCE, [PLACEMENT], (id) => opened.push(id));
    const mark = container.querySelector<HTMLElement>(".note-annotation-source");
    expect(mark).not.toBeNull();
    mark?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(opened).toEqual(["a-1"]);
  });

  it("多个记号各自带着自己的 id 与编号", () => {
    const { container } = mount(SOURCE, [
      { annotationId: "a-1", number: 1, blocks: [{ ordinal: 0, range: null }] },
      { annotationId: "a-2", number: 2, blocks: [{ ordinal: 2, range: null }] },
    ]);
    const marks = [...container.querySelectorAll(".note-annotation-source")];
    expect(marks).toHaveLength(2);
    expect(marks.map((m) => m.getAttribute("data-annotation-id"))).toEqual(["a-1", "a-2"]);
  });

  it("批注集合未变而正文暂时清空再恢复时，不生成空装饰或留着旧位置", () => {
    const { container, editor } = mount(SOURCE, [PLACEMENT]);
    act(() => editor.publish(""));
    expect(container.querySelector(".note-annotation-source")).toBeNull();
    act(() => editor.publish(SOURCE));
    expect(container.querySelector(".note-annotation-source")?.textContent).toContain("提取练习让大脑重新构建记忆痕迹。");
  });
});
