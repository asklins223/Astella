// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useNoteImageUploads } from "../note-image-uploads";
import type { NoteMarkdownEditorHandle } from "../note-markdown-editor";

vi.mock("../../../../app/read-file-base64", () => ({ readFileAsBase64: async () => "aW1hZ2U=" }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("切换笔记后旧上传结果不会写入新正文，新笔记仍可以正常上传", async () => {
  let finishOld!: (value: unknown) => void;
  const success = { ok: true, data: { version: 1, url: "https://example.com/image.png", byteLength: 5, mimeType: "image/png", width: 10, height: 10 } };
  const uploadImage = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; })).mockResolvedValue(success);
  window.astella = { note: { uploadImage } } as never;
  let markdown = "原笔记";
  const replaceImageSrc = vi.fn((from: string, to: string) => { markdown = markdown.replace(from, to); });
  const editorRef = { current: { getMarkdown: () => markdown, insertImageMarkdown: (text: string) => { markdown += text; }, replaceImageSrc } as unknown as NoteMarkdownEditorHandle };
  const onContentChange = vi.fn();
  const view = renderHook(({ noteId }) => useNoteImageUploads({ noteId, editorRef, onContentChange, getContent: () => markdown, disabled: false }), { initialProps: { noteId: "old-note" } });
  const file = new File(["image"], "图片.png", { type: "image/png" });
  act(() => view.result.current.queueFile(file));
  await waitFor(() => expect(uploadImage).toHaveBeenCalledTimes(1));
  markdown = "新笔记"; view.rerender({ noteId: "new-note" }); onContentChange.mockClear();
  await act(async () => { finishOld(success); });
  expect(replaceImageSrc).not.toHaveBeenCalled(); expect(onContentChange).not.toHaveBeenCalled();
  expect(markdown).toBe("新笔记"); expect(view.result.current.uploads).toHaveLength(0);
  act(() => view.result.current.queueFile(file));
  await waitFor(() => expect(view.result.current.uploads[0]?.status).toBe("succeeded"));
  expect(uploadImage.mock.calls[1]?.[0]).toMatchObject({ noteId: "new-note" });
  expect(markdown).toContain("https://example.com/image.png");
});
