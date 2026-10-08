// @vitest-environment jsdom
/**
 * 可编辑预览态的批注记号（41 §1.1「已有批注记号保留」/ §1.4「保留记号但不阻断输入」）。
 *
 * 这一格与纯编辑共用 `note-annotation-placement.ts` 的落位，所以这里只量**编辑器
 * 那一半**：记号挂在正确的块上、点得开、并且**不包住正文**（这一格的首要职责是
 * 让人改字）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import * as Y from "yjs";
import { Schema } from "prosemirror-model";
import { prosemirrorJSONToYXmlFragment } from "y-prosemirror";
import { noteDocSchemaSpec } from "@astella/shared/note-doc-schema";
import { NoteMarkdownEditor } from "../note-markdown-editor";
import type { AnnotationPlacement } from "../note-annotation-placement";

const FRAGMENT_KEY = "prosemirror";

function documentWith(markdown: string) {
  const doc = new Y.Doc();
  const schema = new Schema(noteDocSchemaSpec as never);
  prosemirrorJSONToYXmlFragment(schema, {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "提取练习让大脑重新构建记忆痕迹。" }] },
      { type: "paragraph", content: [{ type: "text", text: "第二段讲间隔效应。" }] },
      { type: "paragraph", content: [{ type: "text", text: "第三段是结尾。" }] },
    ],
  } as never, doc.getXmlFragment(FRAGMENT_KEY));
  return doc;
}

const PLACEMENT: AnnotationPlacement = {
  annotationId: "a-1",
  number: 1,
  blocks: [{ ordinal: 1, range: [0, 7] }],
};

const SECOND_PLACEMENT: AnnotationPlacement = {
  annotationId: "a-2",
  number: 2,
  blocks: [{ ordinal: 1, range: [3, 9] }],
};

const BADGE = ".note-annotation-block-badges .note-annotation-badge";

afterEach(cleanup);

describe("可编辑预览态的批注记号", () => {
  it("正控制：记号挂在**第二块**上（块下标 == 顶层节点下标），且不包住正文", async () => {
    const doc = documentWith("x");
    const { container } = render(
      <NoteMarkdownEditor
        fragment={doc.getXmlFragment(FRAGMENT_KEY)}
        initialMarkdown={"x"}
        onChange={() => undefined}
        annotationPlacements={[PLACEMENT]}
        onOpenAnnotation={() => undefined}
      />,
    );
    await waitFor(() => expect(container.querySelector(".ProseMirror")).not.toBeNull());
    await waitFor(() => expect(container.querySelector(".note-annotation-block")).not.toBeNull());

    const mark = container.querySelector(".note-annotation-block");
    const badge = container.querySelector(BADGE);
    expect(badge?.getAttribute("data-annotation-id")).toBe("a-1");
    expect(badge?.getAttribute("aria-label")).toBe("打开批注 1");
    // 落在第二段（「第二段讲间隔效应。」），不是第一段——块下标对得上是这一条的全部。
    expect(mark?.textContent).toContain("第二段讲间隔效应。");
    // 「不包住正文」：角标是 PM 的装饰挂件，正文仍是这一段自己的直接文本节点。
    expect(container.querySelector(".note-annotation-block-badges")?.classList.contains("ProseMirror-widget")).toBe(true);
    expect(mark?.contains(badge)).toBe(true);
    expect([...(mark?.childNodes ?? [])].some(node => node.textContent === "第二段讲间隔效应。")).toBe(true);
    // 段落自己不带 aria-label：那会让读屏把整段念成「这一段有批注」而丢掉正文。
    expect(mark?.getAttribute("aria-label")).toBeNull();
    expect(mark?.getAttribute("data-annotation-id")).toBeNull();
  });

  it("反面判据：没有批注时不画记号", async () => {
    const doc = documentWith("x");
    const { container } = render(
      <NoteMarkdownEditor
        fragment={doc.getXmlFragment(FRAGMENT_KEY)}
        initialMarkdown={"x"}
        onChange={() => undefined}
        annotationPlacements={[]}
      />,
    );
    await waitFor(() => expect(container.querySelector(".ProseMirror")).not.toBeNull());
    expect(container.querySelector(".note-annotation-block")).toBeNull();
  });

  it("点记号打开同一张旁页（回调拿到的是那个 annotationId）", async () => {
    const opened: string[] = [];
    const doc = documentWith("x");
    const { container } = render(
      <NoteMarkdownEditor
        fragment={doc.getXmlFragment(FRAGMENT_KEY)}
        initialMarkdown={"x"}
        onChange={() => undefined}
        annotationPlacements={[PLACEMENT]}
        onOpenAnnotation={(id) => opened.push(id)}
      />,
    );
    await waitFor(() => expect(container.querySelector(BADGE)).not.toBeNull());
    container.querySelector<HTMLElement>(BADGE)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    await waitFor(() => expect(opened).toEqual(["a-1"]));
  });

  it("一段挂着两条批注时就有两枚角标，各自开得开自己那张旁页（2026-10-08 用户报只出现一枚）", async () => {
    const opened: string[] = [];
    const doc = documentWith("x");
    const { container } = render(
      <NoteMarkdownEditor
        fragment={doc.getXmlFragment(FRAGMENT_KEY)}
        initialMarkdown={"x"}
        onChange={() => undefined}
        annotationPlacements={[PLACEMENT, SECOND_PLACEMENT]}
        onOpenAnnotation={(id) => opened.push(id)}
      />,
    );
    await waitFor(() => expect(container.querySelectorAll(BADGE)).toHaveLength(2));
    const badges = [...container.querySelectorAll<HTMLElement>(BADGE)];
    expect(badges.map(badge => [badge.dataset.annotationId, badge.dataset.number])).toEqual([["a-1", "1"], ["a-2", "2"]]);
    // 两条记号都挂在同一段的行边，不是一枚换掉另一枚。
    expect(badges[0]?.parentElement?.parentElement).toBe(container.querySelector(".note-annotation-block"));
    badges[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    await waitFor(() => expect(opened).toEqual(["a-2"]));
  });

  it("点那一段的正文只放光标，不弹旁页（2026-10-08 用户报：改字前每次都先弹出批注）", async () => {
    const opened: string[] = [];
    const doc = documentWith("x");
    const { container } = render(
      <NoteMarkdownEditor
        fragment={doc.getXmlFragment(FRAGMENT_KEY)}
        initialMarkdown={"x"}
        onChange={() => undefined}
        annotationPlacements={[PLACEMENT, SECOND_PLACEMENT]}
        onOpenAnnotation={(id) => opened.push(id)}
      />,
    );
    await waitFor(() => expect(container.querySelectorAll(BADGE)).toHaveLength(2));
    const text = [...(container.querySelector(".note-annotation-block")?.childNodes ?? [])]
      .find(node => node.nodeType === Node.TEXT_NODE) as Text | undefined;
    expect(text?.textContent).toContain("第二段讲间隔效应。");
    text?.parentElement?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(opened).toEqual([]);
  });
});
