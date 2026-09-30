import { describe, expect, it } from "vitest";
import { beginNoteReplySaveAttempt, isReadyNoteReplyForSave, resolveNoteReplySaveTarget } from "../note-reply-save.ts";

const anchor = {
  noteId: "11111111-1111-4111-8111-111111111111",
  anchor: {
    noteVersionId: "22222222-2222-4222-8222-222222222222",
    startBlockOrdinal: 3,
    startOffset: 4,
    endBlockOrdinal: 3,
    endOffset: 11,
    excerpt: "选中的句子",
    prefix: "前面",
    suffix: "后面",
  },
} as const;

const overview = {
  kind: "overview" as const,
  noteId: anchor.noteId,
  noteVersionId: anchor.anchor.noteVersionId,
  noteTitle: "示例笔记",
};
const recall = { ...overview, kind: "recall" as const };
const recallHint = {
  ...overview,
  kind: "recall_hint" as const,
  recallId: "33333333-3333-4333-8333-333333333333",
  question: "为什么？",
};

describe("Companion note reply persistence", () => {
  it("does not attach an already visible reply to a newly selected passage", () => {
    const target = resolveNoteReplySaveTarget(anchor, null)!;
    const attempt = beginNoteReplySaveAttempt(target, "old-assistant-message");

    expect(isReadyNoteReplyForSave(attempt, target, "ready", "old-assistant-message")).toBe(false);
    expect(isReadyNoteReplyForSave(attempt, target, "sending", "new-assistant-message")).toBe(false);
    expect(isReadyNoteReplyForSave(attempt, target, "ready", "new-assistant-message")).toBe(true);
  });

  it("does not attach a reply after the user changes note or passage", () => {
    const target = resolveNoteReplySaveTarget(anchor, null)!;
    const attempt = beginNoteReplySaveAttempt(target, null);
    const otherAnchor = { ...anchor, anchor: { ...anchor.anchor, startOffset: 5 } };

    expect(isReadyNoteReplyForSave(attempt, resolveNoteReplySaveTarget(otherAnchor, null), "ready", "new-message")).toBe(false);
    expect(isReadyNoteReplyForSave(attempt, resolveNoteReplySaveTarget(null, overview), "ready", "new-message")).toBe(false);
  });

  it("tracks note-specific expansion replies while ignoring ordinary chat", () => {
    const expansion = { ...overview, kind: "expansion" as const };
    expect(resolveNoteReplySaveTarget(null, overview)).toEqual({
      kind: "overview",
      key: `${overview.noteId}:${overview.noteVersionId}`,
    });
    expect(resolveNoteReplySaveTarget(null, expansion)).toEqual({
      kind: "expansion",
      key: `${overview.noteId}:${overview.noteVersionId}`,
    });
    expect(resolveNoteReplySaveTarget(null, null)).toBeNull();
  });

  it("keeps recall questions and hints attached to the exact note session", () => {
    expect(resolveNoteReplySaveTarget(null, recall)).toEqual({
      kind: "recall",
      key: `${overview.noteId}:${overview.noteVersionId}`,
    });
    expect(resolveNoteReplySaveTarget(null, recallHint)).toEqual({
      kind: "recall_hint",
      key: `${overview.noteId}:${overview.noteVersionId}:${recallHint.recallId}`,
    });
    const target = resolveNoteReplySaveTarget(null, recallHint)!;
    const attempt = beginNoteReplySaveAttempt(target, null);
    expect(isReadyNoteReplyForSave(attempt, target, "ready", "reply-message")).toBe(true);
    expect(isReadyNoteReplyForSave(attempt, resolveNoteReplySaveTarget(null, recall), "ready", "reply-message")).toBe(false);
  });
});
