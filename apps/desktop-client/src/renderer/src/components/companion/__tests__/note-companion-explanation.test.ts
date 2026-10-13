// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NoteAnnotationV1 } from "@astella/shared/note-annotation-contracts";
import { feedSelectionToCompanion } from "../companion-feed";
import { beginNoteExplanation, completeNoteExplanation, interruptNoteExplanation, openNoteExplanation, pendingNoteExplanation, progressNoteExplanation, resetNoteExplanations, readNoteExplanation, useNoteCompanionExplanations } from "../note-companion-explanation";
import { useRoomStore } from "../../../app/room-store";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const target = { noteId: id(1), anchor: { noteVersionId: id(2), startBlockOrdinal: 0, endBlockOrdinal: 0, startOffset: 2, endOffset: 9, excerpt: "利息加入本金后", prefix: "当", suffix: "，" } };
function receipt(annotationId: string, versionState: "current" | "older" = "current"): NoteAnnotationV1 {
  return { annotationId, noteId: target.noteId, anchor: target.anchor, explanation: "利息也成为下轮计算的本金。", sourceMessageId: null, generationJobId: id(30),
    revision: 1, versionState, createdAt: "2026-10-02T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z" };
}
const item = () => useNoteCompanionExplanations.getState().items[0]!;
let list: ReturnType<typeof vi.fn>;
let write: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetNoteExplanations();
  useRoomStore.setState({ hudPage: "note-read", activeNoteRef: { noteId: target.noteId, noteVersionId: target.anchor.noteVersionId }, navigationGuard: null });
  list = vi.fn(async () => ({ ok: true, data: { version: 1, items: [], nextCursor: null } }));
  write = vi.fn();
  Object.defineProperty(window, "astella", { configurable: true, value: { noteAnnotation: { list, write } } });
});
afterEach(() => { resetNoteExplanations(); vi.restoreAllMocks(); Reflect.deleteProperty(window, "astella"); });

it("同一句或重叠选区正在解释时复用进度，不重复发送；不同版本独立", () => {
  const feed = vi.fn();
  window.addEventListener("astella:companion-feed", feed);
  const request = { text: target.anchor.excerpt, source: "selection" as const, initialPrompt: "解释这句", noteAnchor: target };
  const first = feedSelectionToCompanion(request);
  const repeated = feedSelectionToCompanion({ ...request, noteAnchor: { ...target, anchor: { ...target.anchor, startOffset: 3, endOffset: 8 } } });
  expect(repeated).toBe(first); expect(feed).toHaveBeenCalledTimes(1); expect(useNoteCompanionExplanations.getState().requestedOpenId).toBe(first);
  expect(pendingNoteExplanation({ ...target, anchor: { ...target.anchor, noteVersionId: id(9) } })).toBeUndefined();
  window.removeEventListener("astella:companion-feed", feed);
});

it.each(["stopped", "interrupted"] as const)("%s 时聊天增量不成为批注正文", phase => {
  const attempt = beginNoteExplanation(target);
  progressNoteExplanation(attempt.id);
  interruptNoteExplanation(attempt.id, phase, "停止或断流");
  progressNoteExplanation(attempt.id);
  expect(item()).toMatchObject({ phase, text: "", annotation: null });
  expect(write).not.toHaveBeenCalled();
});

it.each(["current", "older"] as const)("工具写入的 %s 回执独立成为批注，重复回执不重复广播", version => {
  const attempt = beginNoteExplanation(target);
  const saved = vi.fn(); window.addEventListener("astella:note-annotation-saved", saved);
  expect(completeNoteExplanation(attempt.id, receipt(attempt.id, version))).toBe(true);
  expect(completeNoteExplanation(attempt.id, receipt(attempt.id, version))).toBe(true);
  expect(item()).toMatchObject({ phase: "saved", text: receipt(attempt.id).explanation, annotation: { versionState: version } });
  expect(saved).toHaveBeenCalledOnce(); expect(write).not.toHaveBeenCalled();
  window.removeEventListener("astella:note-annotation-saved", saved);
});

it("断流后只重新读取工具产物，不发送聊天或再次保存", async () => {
  const attempt = beginNoteExplanation(target);
  list.mockRejectedValueOnce(new Error("连接断开"));
  await readNoteExplanation(attempt.id);
  expect(item()).toMatchObject({ phase: "save-error", text: "", annotation: null });
  expect(beginNoteExplanation(target).id).toBe(attempt.id);
  list.mockResolvedValueOnce({ ok: true, data: { version: 1, items: [receipt(attempt.id)], nextCursor: null } });
  await readNoteExplanation(attempt.id);
  expect(list).toHaveBeenCalledTimes(2); expect(write).not.toHaveBeenCalled(); expect(item().phase).toBe("saved");
});

it("没有工具产物时明确未写入，不把任何发言凑成解释", async () => {
  const attempt = beginNoteExplanation(target);
  await readNoteExplanation(attempt.id);
  expect(item()).toMatchObject({ phase: "interrupted", text: "", annotation: null });
  expect(item().error).toContain("没有写入"); expect(write).not.toHaveBeenCalled();
});

it("晚到回执仍属于原句，切换工作区后不广播旧产物", () => {
  const first = beginNoteExplanation(target);
  const next = beginNoteExplanation({ ...target, anchor: { ...target.anchor, startBlockOrdinal: 2, endBlockOrdinal: 2 } });
  completeNoteExplanation(first.id, receipt(first.id));
  expect(useNoteCompanionExplanations.getState().activeId).toBe(next.id);
  expect(useNoteCompanionExplanations.getState().items.find(value => value.id === first.id)?.phase).toBe("saved");
  resetNoteExplanations();
  const saved = vi.fn(); window.addEventListener("astella:note-annotation-saved", saved);
  expect(completeNoteExplanation(next.id, { ...receipt(next.id), anchor: next.target.anchor })).toBe(false);
  expect(saved).not.toHaveBeenCalled(); window.removeEventListener("astella:note-annotation-saved", saved);
});

it("离开笔记后点气泡选文，会返回这次解释所属的笔记并请求打开附页", () => {
  const attempt = beginNoteExplanation(target);
  useRoomStore.setState({ hudPage: "home", destination: "room", surface: null, activeNoteRef: null });
  openNoteExplanation(attempt.id);
  expect(useRoomStore.getState()).toMatchObject({ destination: "notebook", activeNoteRef: { noteId: target.noteId, noteVersionId: target.anchor.noteVersionId, mode: "preview" } });
  expect(useNoteCompanionExplanations.getState().requestedOpenId).toBe(attempt.id);
});

it("回执原句或保存身份不一致时不贴到当前笔记", () => {
  const attempt = beginNoteExplanation(target);
  expect(completeNoteExplanation(attempt.id, { ...receipt(attempt.id), anchor: { ...target.anchor, startOffset: 1 } })).toBe(false);
  expect(completeNoteExplanation(attempt.id, receipt(id(9)))).toBe(false);
  expect(item()).toMatchObject({ phase: "preparing", annotation: null });
  expect(write).not.toHaveBeenCalled();
});
