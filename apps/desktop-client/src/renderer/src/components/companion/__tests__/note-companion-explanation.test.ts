// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NoteAnnotationV1 } from "@ailearn/shared/note-annotation-contracts";
import { feedSelectionToCompanion } from "../companion-feed";
import { beginNoteExplanation, completeNoteExplanation, interruptNoteExplanation, openNoteExplanation, pendingNoteExplanation, progressNoteExplanation, resetNoteExplanations, saveNoteExplanation, useNoteCompanionExplanations } from "../note-companion-explanation";
import { useRoomStore } from "../../../app/room-store";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const target = { noteId: id(1), anchor: { noteVersionId: id(2), startBlockOrdinal: 0, endBlockOrdinal: 0, startOffset: 2, endOffset: 9, excerpt: "利息加入本金后", prefix: "当", suffix: "，" } };
function receipt(versionState: "current" | "older" = "current"): NoteAnnotationV1 {
  return { annotationId: id(4), noteId: target.noteId, anchor: target.anchor, explanation: "利息也成为下轮计算的本金。", sourceMessageId: id(3), generationJobId: null,
    revision: 1, versionState, createdAt: "2026-10-02T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z" };
}
const item = () => useNoteCompanionExplanations.getState().items[0]!;
let write: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetNoteExplanations();
  useRoomStore.setState({ hudPage: "note-read", activeNoteRef: { noteId: target.noteId, noteVersionId: target.anchor.noteVersionId }, navigationGuard: null });
  write = vi.fn(async () => ({ ok: true, data: receipt() }));
  Object.defineProperty(window, "ailearn", { configurable: true, value: { noteAnnotation: { write } } });
});
afterEach(() => { resetNoteExplanations(); vi.restoreAllMocks(); Reflect.deleteProperty(window, "ailearn"); });

it("同一句或重叠选区正在解释时复用进度，不重复发送；不同版本独立", () => {
  const feed = vi.fn();
  window.addEventListener("ailearn:companion-feed", feed);
  const request = { text: target.anchor.excerpt, source: "selection" as const, initialPrompt: "解释这句", noteAnchor: target };
  const first = feedSelectionToCompanion(request);
  const repeated = feedSelectionToCompanion({ ...request, noteAnchor: { ...target, anchor: { ...target.anchor, startOffset: 3, endOffset: 8 } } });
  expect(repeated).toBe(first); expect(feed).toHaveBeenCalledTimes(1); expect(useNoteCompanionExplanations.getState().requestedOpenId).toBe(first);
  expect(pendingNoteExplanation({ ...target, anchor: { ...target.anchor, noteVersionId: id(9) } })).toBeUndefined();
  window.removeEventListener("ailearn:companion-feed", feed);
});

it.each(["stopped", "interrupted"] as const)("%s 的半段解释保留可读内容，晚到 final 和增量都不能写成正式批注", async phase => {
  const attempt = beginNoteExplanation(target);
  progressNoteExplanation(attempt.id, "未完成的解释");
  interruptNoteExplanation(attempt.id, phase, "停止或断流");
  progressNoteExplanation(attempt.id, "迟到的增量");
  await completeNoteExplanation(attempt.id, id(3), "迟到的完整回复");
  await saveNoteExplanation(attempt.id);
  expect(item()).toMatchObject({ phase, text: "未完成的解释", annotation: null }); expect(write).not.toHaveBeenCalled();
});

it.each(["current", "older"] as const)("完整回复收到 %s 版本的真实回执后才成为批注，连续完成只写一次", async version => {
  write.mockResolvedValue({ ok: true, data: receipt(version) });
  const attempt = beginNoteExplanation(target);
  await Promise.all([completeNoteExplanation(attempt.id, id(3), receipt().explanation), completeNoteExplanation(attempt.id, id(3), receipt().explanation)]);
  expect(item()).toMatchObject({ phase: "saved", annotation: { versionState: version } }); expect(write).toHaveBeenCalledTimes(1);
});

it("保存失败保留完整回复，只重试保存，重试期间不创建第二轮解释", async () => {
  write.mockRejectedValueOnce(new Error("连接断开"));
  const attempt = beginNoteExplanation(target);
  await completeNoteExplanation(attempt.id, id(3), receipt().explanation);
  expect(item()).toMatchObject({ phase: "save-error", text: receipt().explanation, messageId: id(3) });
  expect(beginNoteExplanation(target).id).toBe(attempt.id);
  await Promise.all([saveNoteExplanation(attempt.id), saveNoteExplanation(attempt.id)]);
  expect(write).toHaveBeenCalledTimes(2); expect(write.mock.calls[0]![0].command).toEqual(write.mock.calls[1]![0].command); expect(item().phase).toBe("saved");
});

it("晚到保存仍属于原句，不改变新选区；工作区切换后不广播旧回执", async () => {
  let resolve!: (value: unknown) => void;
  write.mockImplementation(() => new Promise(done => { resolve = done; }));
  const first = beginNoteExplanation(target);
  const pending = completeNoteExplanation(first.id, id(3), receipt().explanation);
  const next = beginNoteExplanation({ ...target, anchor: { ...target.anchor, startBlockOrdinal: 2, endBlockOrdinal: 2 } });
  resolve({ ok: true, data: receipt() }); await pending;
  expect(useNoteCompanionExplanations.getState().activeId).toBe(next.id);
  expect(useNoteCompanionExplanations.getState().items.find(value => value.id === first.id)?.phase).toBe("saved");
  const saved = vi.fn(); window.addEventListener("ailearn:note-annotation-saved", saved);
  const pendingNext = completeNoteExplanation(next.id, id(5), "下一句解释");
  resetNoteExplanations(); resolve({ ok: true, data: { ...receipt(), anchor: next.target.anchor, sourceMessageId: id(5) } }); await pendingNext;
  expect(saved).not.toHaveBeenCalled(); window.removeEventListener("ailearn:note-annotation-saved", saved);
});

it("离开笔记后点气泡选文，会返回这次解释所属的笔记并请求打开附页", () => {
  const attempt = beginNoteExplanation(target);
  useRoomStore.setState({ hudPage: "home", destination: "room", surface: null, activeNoteRef: null });
  openNoteExplanation(attempt.id);
  expect(useRoomStore.getState()).toMatchObject({ destination: "notebook", activeNoteRef: { noteId: target.noteId, noteVersionId: target.anchor.noteVersionId, mode: "preview" } });
  expect(useNoteCompanionExplanations.getState().requestedOpenId).toBe(attempt.id);
});

it("回执原句范围不一致时不声称保存成功，也不把它贴到当前笔记", async () => {
  write.mockResolvedValue({ ok: true, data: { ...receipt(), anchor: { ...target.anchor, startOffset: 1 } } });
  const saved = vi.fn(); window.addEventListener("ailearn:note-annotation-saved", saved);
  const attempt = beginNoteExplanation(target);
  await completeNoteExplanation(attempt.id, id(3), receipt().explanation);
  expect(item()).toMatchObject({ phase: "save-error", annotation: null });
  expect(saved).not.toHaveBeenCalled(); window.removeEventListener("ailearn:note-annotation-saved", saved);
});
