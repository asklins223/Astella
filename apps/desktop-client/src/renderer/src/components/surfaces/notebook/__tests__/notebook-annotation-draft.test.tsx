// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { noteAnnotationV1Schema, type NoteAnnotationAnchorV1 } from "@ailearn/shared/note-annotation-contracts";
import { useNotebookAnnotationDraft } from "../use-notebook-annotation-draft";

const id = (n: number) => `${String(n).padStart(8, "0")}-4111-8111-8111-${String(n).padStart(12, "0")}`;
const anchor: NoteAnnotationAnchorV1 = { noteVersionId: id(2), startBlockOrdinal: 0, endBlockOrdinal: 0,
  startOffset: 0, endOffset: 7, excerpt: "利息加入本金后", prefix: "", suffix: "，下一次也会继续产生利息。" };
const annotation = noteAnnotationV1Schema.parse({ annotationId: id(3), noteId: id(1), anchor, explanation: "利息也成为下轮计算的本金。",
  sourceMessageId: null, generationJobId: null, revision: 1, versionState: "current", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" });
afterEach(() => { cleanup(); Reflect.deleteProperty(window, "ailearn"); vi.restoreAllMocks(); });

it("手写批注保存失败保留输入；重试收到这句的真实回执才清草稿", async () => {
  const write = vi.fn().mockRejectedValueOnce(new Error("网络断开")).mockResolvedValue({ ok: true, data: annotation });
  Object.defineProperty(window, "ailearn", { configurable: true, value: { noteAnnotation: { write } } });
  const onSaved = vi.fn(), view = renderHook(() => useNotebookAnnotationDraft({ noteId: id(1), epochRef: { current: 1 }, onSaved }));
  act(() => view.result.current.start(anchor));
  act(() => view.result.current.setText(annotation.explanation));
  await act(async () => { await view.result.current.save(); });
  expect(write).toHaveBeenCalledWith(expect.objectContaining({ noteId: id(1), command: { kind: "create", anchor, explanation: annotation.explanation } }));
  expect(view.result.current.draft?.text).toBe(annotation.explanation);
  expect(view.result.current.error).toContain("批注已保留"); expect(onSaved).not.toHaveBeenCalled();
  await act(async () => { await view.result.current.save(); });
  expect(onSaved).toHaveBeenCalledWith(annotation); expect(view.result.current.draft).toBeNull();
  expect(view.result.current.saving).toBe(false);
});

it("另选一句不覆盖尚未保存的批注；回到原句恢复各自的文字", () => {
  const view = renderHook(() => useNotebookAnnotationDraft({ noteId: id(1), epochRef: { current: 1 }, onSaved: vi.fn() }));
  const second = { ...anchor, startBlockOrdinal: 1, endBlockOrdinal: 1, excerpt: "另一处原句" };
  act(() => view.result.current.start(anchor)); act(() => view.result.current.setText("第一句的想法"));
  act(() => view.result.current.start(second)); act(() => view.result.current.setText("第二句的疑问"));
  act(() => view.result.current.start(anchor)); expect(view.result.current.draft?.text).toBe("第一句的想法");
  act(() => view.result.current.start(second)); expect(view.result.current.draft?.text).toBe("第二句的疑问");
});

it("确认过程中连点不重复写入；晚到回执不能进入另一篇笔记", async () => {
  let resolve!: (value: unknown) => void;
  const write = vi.fn(() => new Promise(done => { resolve = done; }));
  Object.defineProperty(window, "ailearn", { configurable: true, value: { noteAnnotation: { write } } });
  const onSaved = vi.fn(), view = renderHook(({ noteId }) => useNotebookAnnotationDraft({ noteId, epochRef: { current: 1 }, onSaved }), { initialProps: { noteId: id(1) } });
  act(() => view.result.current.start(anchor)); act(() => view.result.current.setText("保留的批注"));
  let pending!: Promise<void>;
  act(() => { pending = view.result.current.save(); void view.result.current.save(); });
  expect(write).toHaveBeenCalledTimes(1); expect(view.result.current.saving).toBe(true);
  view.rerender({ noteId: id(5) });
  await act(async () => { resolve({ ok: true, data: annotation }); await pending; });
  expect(onSaved).not.toHaveBeenCalled(); expect(view.result.current.draft).toBeNull(); expect(view.result.current.saving).toBe(false);
});
