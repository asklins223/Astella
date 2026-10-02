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
import { noteDocSchemaSpec } from "@ailearn/shared/note-doc-schema";
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
    expect(mark?.getAttribute("data-annotation-id")).toBe("a-1");
    expect(mark?.getAttribute("aria-label")).toBe("这一段有批注");
    // 落在第二段（「第二段讲间隔效应。」），不是第一段——块下标对得上是这一条的全部。
    expect(mark?.textContent).toContain("第二段讲间隔效应。");
    // 「不包住正文」：记号不改变正文的可编辑内容，只挂在块上。
    expect(mark?.querySelector("[contenteditable='false']")).toBeNull();
    expect(mark?.getAttribute("contenteditable")).not.toBe("false");
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
    await waitFor(() => expect(container.querySelector(".note-annotation-block")).not.toBeNull());
    const mark = container.querySelector<HTMLElement>(".note-annotation-block");
    mark?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
    await waitFor(() => expect(opened).toEqual(["a-1"]));
  });
});
