// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { NoteReflectionShelf } from "./note-reflection-shelf";
import { appendReflectionToDocument, PendingReflectionAppendError, reflectionDocumentLines, stageReflectionAppend } from "./note-reflection-document";
import type { ReflectionSourceV1 } from "@ailearn/shared/note-learning-reflection-contracts";

const source: ReflectionSourceV1 = { ref: { kind: "teaching", id: "11111111-1111-4111-8111-111111111111" },
  roundId: "22222222-2222-4222-8222-222222222222", question: "为什么先提取再校对？", text: "先合上书回忆。\n\n再查看材料。", createdAt: "2026-09-27T00:00:00Z" };
const reflection = { reflectionId: "33333333-3333-4333-8333-333333333333", noteId: "44444444-4444-4444-8444-444444444444", source, annotation: "原批注", revision: 1, createdAt: source.createdAt };
const props = { noteId: reflection.noteId, roundId: source.roundId, refreshKey: "1", canAppend: false, shared: true, workspaceEpoch: 1, openSources: true, onInspectBody: vi.fn() };
function gateway(items = [] as typeof reflection[]) {
  const list = vi.fn(async () => ({ ok: true, data: { version: 1, items, sources: [source], nextCursor: null } }));
  const write = vi.fn(async (_input: unknown) => ({ ok: true, data: reflection }));
  Object.defineProperty(window, "ailearn", { configurable: true, value: { noteReflection: { list, write } } });
  return { list, write };
}
afterEach(() => { cleanup(); Object.defineProperty(window, "ailearn", { configurable: true, value: undefined }); });

describe("voluntary understanding writeback", () => {
  it("read-only member can save a private annotation, with no body option or automatic mutation", async () => {
    const api = gateway(); const append = vi.fn();
    render(<NoteReflectionShelf {...props} onAppend={append} />);
    await screen.findByRole("button", { name: /AI 整理建议 · 1.*先合上书回忆/ });
    expect(api.write).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /AI 整理建议 · 1.*先合上书回忆/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "我先试着回忆" } });
    expect(screen.queryByRole("radio", { name: /公共正文/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "留为私有备注" }));
    await screen.findByText("已留在本人私有备注里。正文没有改变。");
    expect(api.write.mock.calls[0][0]).toMatchObject({ noteId: props.noteId, command: { kind: "create", source: source.ref, annotation: "我先试着回忆" } });
    expect(append).not.toHaveBeenCalled();
  });
  it("explicit body choice previews attribution and retries a failed save without discarding the draft", async () => {
    gateway(); const append = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<NoteReflectionShelf {...props} canAppend onAppend={append} />);
    fireEvent.click(await screen.findByRole("button", { name: /AI 整理建议 · 1.*先合上书回忆/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "个人理解" } });
    fireEvent.click(screen.getByRole("radio", { name: /公共正文/ }));
    expect(screen.getByText("AI 整理建议（本人选择保留）")).toBeTruthy();
    expect(append).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "添到正文并保存" }));
    await screen.findByRole("button", { name: "重试保存正文" });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("个人理解");
    fireEvent.click(screen.getByRole("button", { name: "重试保存正文" }));
    await screen.findByText(/已添到正文末尾并保存为新版本/);
    expect(append.mock.calls).toEqual([[source, "个人理解"], [source, "个人理解"]]);
  });
  it("a failed body checkpoint can take the reader back to the note body, and reports a changed pending draft", async () => {
    gateway(); const inspect = vi.fn();
    const append = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new PendingReflectionAppendError("先保存原批注"));
    render(<NoteReflectionShelf {...props} canAppend onAppend={append} onInspectBody={inspect} />);
    fireEvent.click(await screen.findByRole("button", { name: /AI 整理建议 · 1.*先合上书回忆/ }));
    fireEvent.click(screen.getByRole("radio", { name: /公共正文/ }));
    fireEvent.click(screen.getByRole("button", { name: "添到正文并保存" }));
    fireEvent.click(await screen.findByRole("button", { name: "回正文检查" }));
    expect(inspect).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /AI 整理建议 · 1.*先合上书回忆/ }));
    fireEvent.click(screen.getByRole("radio", { name: /公共正文/ }));
    fireEvent.click(screen.getByRole("button", { name: "添到正文并保存" }));
    await screen.findByText("先保存原批注");
  });
  it("keeps original source read-only and keeps the draft while explicitly reading a newer annotation revision", async () => {
    const api = gateway([reflection]);
    api.write.mockResolvedValueOnce({ ok: false, error: { code: "reflection_stale_revision", retry: "user_action", safeMessageKey: "conflict" } } as never);
    render(<NoteReflectionShelf {...props} onAppend={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "修改批注" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "我的新批注" } });
    fireEvent.click(screen.getByRole("button", { name: "保存批注" }));
    await screen.findByRole("alert");
    api.list.mockResolvedValueOnce({ ok: true, data: { version: 1, items: [{ ...reflection, revision: 2, annotation: "另一处保存" }], sources: [], nextCursor: null } });
    fireEvent.click(screen.getByRole("button", { name: "读取最新批注" }));
    await screen.findByText(/最新保存的批注：另一处保存/);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("我的新批注");
    fireEvent.click(screen.getByRole("button", { name: "保存批注" }));
    await waitFor(() => expect(api.write).toHaveBeenCalledTimes(2));
    expect(api.write.mock.calls[1][0]).toMatchObject({ command: { kind: "update", expectedRevision: 2, annotation: "我的新批注" } });
    expect(source.text).toBe("先合上书回忆。\n\n再查看材料。");
  });
  it("permission withdrawal clears previously displayed bookmarks and source content", async () => {
    const api = gateway([reflection]); const { rerender } = render(<NoteReflectionShelf {...props} onAppend={vi.fn()} />);
    await screen.findByRole("button", { name: "修改批注" });
    api.list.mockResolvedValueOnce({ ok: false, error: { code: "not_found", retry: "user_action", safeMessageKey: "not_found" } } as never);
    await act(async () => { rerender(<NoteReflectionShelf {...props} refreshKey="2" onAppend={vi.fn()} />); });
    await screen.findByRole("alert"); expect(screen.queryByRole("button", { name: "修改批注" })).toBeNull();
    expect(screen.queryByRole("button", { name: /AI 整理建议 · 1.*先合上书回忆/ })).toBeNull();
  });
  it("switching history rounds clears the previously selected source", async () => {
    gateway(); const append = vi.fn();
    const { rerender } = render(<NoteReflectionShelf {...props} onAppend={append} />);
    fireEvent.click(await screen.findByRole("button", { name: /AI 整理建议 · 1.*先合上书回忆/ }));
    expect(screen.getByRole("textbox")).toBeTruthy();
    rerender(<NoteReflectionShelf {...props} roundId="55555555-5555-4555-8555-555555555555" onAppend={append} />);
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  });
});

it("body writeback appends attributed nodes and preserves concurrent edits in the original paragraph", () => {
  const doc = new Y.Doc(), fragment = doc.getXmlFragment("content");
  const paragraph = new Y.XmlElement("paragraph"), text = new Y.XmlText("原始正文"); paragraph.insert(0, [text]); fragment.insert(0, [paragraph]);
  const peer = new Y.Doc(); Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
  appendReflectionToDocument(fragment, source, "我的批注");
  const peerText = (peer.getXmlFragment("content").get(0) as Y.XmlElement).get(0) as Y.XmlText; peerText.insert(peerText.length, "，对端补充");
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
  expect(text.toString()).toBe("原始正文，对端补充");
  expect(fragment.length).toBe(5);
  expect(fragment.toString()).toContain("AI 整理建议（本人选择保留）");
  expect(reflectionDocumentLines({ ...source, ref: { ...source.ref, kind: "answer" } }, "")[0]).toBe("本人原话（学习作答）");
});

it("an unconfirmed body append retries its exact draft and rejects a changed preview", () => {
  const doc = new Y.Doc(), fragment = doc.getXmlFragment("content"), pending = new Map<string, string>();
  stageReflectionAppend(fragment, reflection.noteId, source, "最初批注", pending);
  const length = fragment.length;
  stageReflectionAppend(fragment, reflection.noteId, source, "最初批注", pending);
  expect(fragment.length).toBe(length);
  expect(() => stageReflectionAppend(fragment, reflection.noteId, source, "改过的批注", pending)).toThrow(/上一次正文还没保存/);
  expect(fragment.length).toBe(length);
  pending.clear(); // A successful manual checkpoint releases the next voluntary append.
  stageReflectionAppend(fragment, reflection.noteId, source, "改过的批注", pending);
  expect(fragment.length).toBeGreaterThan(length);
});
