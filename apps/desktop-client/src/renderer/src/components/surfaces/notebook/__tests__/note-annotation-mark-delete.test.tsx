// @vitest-environment jsdom
/**
 * 记号浮层里的「删掉这条」（用户裁决：正文里就能删，不必先开附页）。
 *
 * 这一族最容易出的两个错，各钉一条：
 * 1. **浮层随指针离开记号就收起** —— 于是指针移过去按「删掉」的那一刻它没了，
 *    那个按钮永远按不到。所以浮层自己要接住指针。
 * 2. **浮层里的点击顺带打开了附页** —— 删一条批注却顺带把附页推出来，用户以为
 *    是「打开」，实际已经删了。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { NoteAnnotationMark } from "../note-annotation-mark";
import { AnnotationDeleteControl } from "../annotation-delete-control";
import type { NoteAnnotationV1 } from "@ailearn/shared/note-annotation-contracts";

const ANNOTATION: NoteAnnotationV1 = {
  annotationId: "a-1",
  noteId: "n-1",
  anchor: {
    noteVersionId: "v-1", startBlockOrdinal: 0, startOffset: 0, endBlockOrdinal: 0, endOffset: 7,
    excerpt: "提取练习让大脑", prefix: "", suffix: "重新构建记忆痕迹。",
  },
  explanation: "这是白话解释。",
  sourceMessageId: null,
  generationJobId: "11111111-1111-4111-8111-111111111111",
  revision: 3,
  versionState: "current",
  createdAt: "2026-10-02T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
};

/** jsdom 没有 `(hover: hover)` 的真实判定；必须**先**装好桩再 render。 */
function stubHover() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("(hover: hover)"), media: query,
    addEventListener: () => undefined, removeEventListener: () => undefined,
  }));
}

function mount(onDelete?: React.ReactNode) {
  stubHover();
  const view = render(<NoteAnnotationMark annotation={ANNOTATION} number={1} onOpen={vi.fn()} onDelete={onDelete}>
    提取练习让大脑
  </NoteAnnotationMark>);
  return view;
}

const marker = (view: ReturnType<typeof mount>) => view.container.querySelector(".note-annotation-anchor")!;
const tooltip = () => document.querySelector(".note-annotation-preview");

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.getSelection()?.removeAllRanges();
  vi.unstubAllGlobals();
});

describe("记号浮层里的删除", () => {
  /** 反面判据：不给 onDelete 时，浮层里不该凭空多一个按钮。 */
  it("没有传入删除入口时，浮层里只有预览", () => {
    const view = mount();
    fireEvent.mouseEnter(marker(view));
    expect(tooltip()).not.toBeNull();
    expect(tooltip()?.querySelector(".note-annotation-delete")).toBeNull();
  });

  const control = <AnnotationDeleteControl annotation={ANNOTATION} hasArtifact={false} view="idle"
    onRequest={() => undefined} onCancel={() => undefined} onConfirm={() => undefined} />;

  it("传了就出现，而且落在浮层里（不在正文里插按钮）", () => {
    const view = mount(control);
    fireEvent.mouseEnter(marker(view));
    expect(tooltip()?.querySelector(".note-annotation-delete")).not.toBeNull();
    expect(tooltip()?.querySelector("button")?.textContent).toContain("删掉这条");
    // 浮层在 portal 里（document.body），正文那个 span 里不能多出按钮。
    expect(marker(view).querySelector("button")).toBeNull();
  });

  /**
   * 关键一条：指针**移进浮层**时它不能收起。
   *
   * 收起的那一刻，「删掉这条」就永远按不到——而这个 bug 看起来完全正常：
   * hover 会出现预览（那是对的），只是你够不到那颗按钮。
   *
   * 所以这里按**真实顺序**走一遍：进记号 → 进浮层 → 离记号（该留住）→ 离浮层（该收）。
   */
  it("指针移进浮层时浮层不收起（否则那个按钮永远按不到）", () => {
    const view = mount(control);
    fireEvent.mouseEnter(marker(view));
    expect(tooltip()).not.toBeNull();
    fireEvent.mouseEnter(tooltip()!);
    // 指针从记号挪到浮层上——记号的 mouseleave 先到，浮层必须接住。
    fireEvent.mouseLeave(marker(view));
    expect(tooltip(), "浮层在指针移过去时收起了，那颗按钮就永远按不到").not.toBeNull();
    // 指针离开浮层才收。
    vi.useFakeTimers();
    fireEvent.mouseLeave(tooltip()!);
    act(() => vi.advanceTimersByTime(200));
    expect(tooltip()).toBeNull();
  });

  /** 指针只是掠过记号就走（没进浮层）时，浮层照常收——不然它会一直挂在屏上。 */
  it("指针没进浮层就离开记号：浮层照常收起", () => {
    const view = mount(control);
    fireEvent.mouseEnter(marker(view));
    expect(tooltip()).not.toBeNull();
    vi.useFakeTimers();
    fireEvent.mouseLeave(marker(view));
    expect(tooltip()).not.toBeNull();
    act(() => vi.advanceTimersByTime(200));
    expect(tooltip()).toBeNull();
  });

  it("浮层里的按钮按下去不会顺带打开附页", () => {
    const onOpen = vi.fn();
    stubHover();
    const view = render(<NoteAnnotationMark annotation={ANNOTATION} onOpen={onOpen}
      onDelete={<button type="button">删掉这条</button>}>提取练习让大脑</NoteAnnotationMark>);
    fireEvent.mouseEnter(marker(view));
    const button = tooltip()?.querySelector("button");
    expect(button).not.toBeNull();
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onOpen).not.toHaveBeenCalled();
  });
});
// Dragging an annotated sentence is a selection, not an instruction to open it.
it("重新拖选有批注的原句不会打开旧批注，键盘仍能打开", () => {
  const onOpen = vi.fn();
  const view = render(<NoteAnnotationMark annotation={ANNOTATION} onOpen={onOpen}>提取练习让大脑</NoteAnnotationMark>);
  const node = marker(view), range = document.createRange();
  range.setStart(node.firstChild!, 0); range.setEnd(node.firstChild!, 4);
  window.getSelection()!.addRange(range);
  fireEvent.click(node);
  expect(onOpen).not.toHaveBeenCalled();
  fireEvent.keyDown(node, { key: "Enter" });
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(ANNOTATION);
});

it("浮层跨过记号与便笺的空隙后仍可操作", () => {
  vi.useFakeTimers();
  const view = mount(<button>删掉这条</button>);
  fireEvent.mouseEnter(marker(view));
  fireEvent.mouseLeave(marker(view));
  act(() => vi.advanceTimersByTime(80));
  fireEvent.mouseEnter(tooltip()!);
  act(() => vi.advanceTimersByTime(200));
  expect(tooltip()?.querySelector("button")).toBeTruthy();
});
