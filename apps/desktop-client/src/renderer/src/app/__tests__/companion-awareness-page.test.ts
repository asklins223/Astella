import { describe, expect, it } from "vitest";
import { companionAwarenessPageState } from "../companion-awareness-page";

const base = { hudPage: "home" as const, activeNoteId: null, activeNoteVersionId: null,
  activeSourceId: null, activeRunId: null, pageReadableView: null };

describe("proactive page facts", () => {
  it("waits for an actual note version", () => {
    expect(companionAwarenessPageState({ ...base, hudPage: "note-read", activeNoteId: "note" }).ready).toBe(false);
    expect(companionAwarenessPageState({ ...base, hudPage: "note-read", activeNoteId: "note", activeNoteVersionId: "v1" }))
      .toEqual({ ready: true, revision: "v1" });
  });
  it("waits for source content and ignores a previous page's view", () => {
    const source = { ...base, hudPage: "source-detail" as const, activeSourceId: "source" };
    expect(companionAwarenessPageState(source).ready).toBe(false);
    expect(companionAwarenessPageState({ ...source, pageReadableView: { token: "old", view: { pageId: "result", title: "旧结果" } } }).ready).toBe(false);
  });
  it("recovery changes the source watermark without depending on renderer ownership", () => {
    const source = { ...base, hudPage: "source-detail" as const, activeSourceId: "source",
      pageReadableView: { token: "first", view: { pageId: "source_detail" as const, title: "资料", statusLine: "处理失败" } } };
    const before = companionAwarenessPageState(source);
    expect(before.ready).toBe(true);
    expect(companionAwarenessPageState({ ...source, pageReadableView: { ...source.pageReadableView, token: "reload" } }).revision).toBe(before.revision);
    expect(companionAwarenessPageState({ ...source, pageReadableView: { token: "first", view: { ...source.pageReadableView.view, statusLine: "已处理" } } }).revision).not.toBe(before.revision);
  });
  it("waits for the actual assessment or result view", () => {
    const result = { ...base, hudPage: "result" as const, activeRunId: "run" };
    expect(companionAwarenessPageState(result).ready).toBe(false);
    expect(companionAwarenessPageState({ ...result, pageReadableView: { token: "old", view: { pageId: "assessment", title: "上一阶段" } } }).ready).toBe(false);
    expect(companionAwarenessPageState({ ...result, pageReadableView: { token: "current", view: { pageId: "result", title: "结果" } } }).ready).toBe(true);
  });
});
