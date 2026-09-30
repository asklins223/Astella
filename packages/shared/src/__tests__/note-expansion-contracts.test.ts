import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  confirmNoteExpansionTaskV1Schema,
  createNoteExpansionTaskV1Schema,
  noteExpansionDraftV1Schema,
  noteExpansionLinkV1Schema,
  noteExpansionListQueryV1Schema,
  noteExpansionReviewV1Schema,
} from "../contracts/note-expansion-contracts.ts";

const ids = {
  noteId: "11111111-1111-4111-8111-111111111111",
  noteVersionId: "22222222-2222-4222-8222-222222222222",
  requestId: "33333333-3333-4333-8333-333333333333",
  candidateId: "44444444-4444-4444-8444-444444444444",
  sourceMessageId: "55555555-5555-4555-8555-555555555555",
  conversationId: "66666666-6666-4666-8666-666666666666",
};

const draft = {
  candidateId: ids.candidateId,
  requestId: ids.requestId,
  title: "Tool 与 Agent 的关系",
  relationship: "原文提到 Tool 是 Agent 调用外部能力的方式，可以继续了解调用过程。",
  sourceReferences: [{ blockOrdinal: 3, quote: "Agent 可以通过 Tool 调用外部能力" }],
  blocks: [
    { type: "heading", content: "调用过程" },
    { type: "paragraph", content: "Tool 帮 Agent 把请求交给外部系统，并把结果带回来。" },
  ],
  selected: false,
} as const;

describe("note expansion contracts", () => {
  it("starts a durable task without requiring a companion message", () => {
    assert.equal(createNoteExpansionTaskV1Schema.parse({
      noteVersionId: ids.noteVersionId,
      requestId: ids.requestId,
    }).requestId, ids.requestId);
    assert.equal(createNoteExpansionTaskV1Schema.safeParse({
      noteVersionId: ids.noteVersionId,
      requestId: ids.requestId,
      sourceMessageId: ids.sourceMessageId,
    }).success, false);
    assert.equal(createNoteExpansionTaskV1Schema.safeParse({
      noteVersionId: ids.noteVersionId,
      requestId: ids.requestId,
      focusAnchor: {
        noteVersionId: ids.requestId,
        startBlockOrdinal: 3,
        startOffset: 0,
        endBlockOrdinal: 3,
        endOffset: 5,
        excerpt: "Tool ",
        prefix: "",
        suffix: "Agent 可",
      },
    }).success, false);
  });

  it("keeps candidate citations and review edits bounded and separate from confirmation", () => {
    assert.equal(noteExpansionDraftV1Schema.parse(draft).selected, false);
    assert.equal(noteExpansionDraftV1Schema.safeParse({ ...draft, sourceReferences: [] }).success, false);
    assert.equal(noteExpansionDraftV1Schema.safeParse({ ...draft, blocks: [{ type: "paragraph", content: "字".repeat(20_001) }] }).success, false);
    assert.equal(noteExpansionReviewV1Schema.parse({
      drafts: [{ candidateId: ids.candidateId, title: draft.title, blocks: draft.blocks, selected: true }],
    }).drafts[0]?.selected, true);
    assert.equal(noteExpansionReviewV1Schema.safeParse({
      drafts: [
        { candidateId: ids.candidateId, title: draft.title, blocks: draft.blocks, selected: true },
        { candidateId: ids.candidateId, title: draft.title, blocks: draft.blocks, selected: false },
      ],
    }).success, false);
    assert.equal(confirmNoteExpansionTaskV1Schema.safeParse({ candidateIds: [ids.candidateId, ids.candidateId] }).success, false);
  });

  it("links either direction to exact versions and supports optional companion provenance", () => {
    const link = noteExpansionLinkV1Schema.parse({
      expansionId: ids.requestId,
      sourceNoteId: ids.noteId,
      sourceNoteVersionId: ids.noteVersionId,
      sourceNoteVersionNumber: 2,
      sourceTaskId: ids.candidateId,
      expandedNoteId: ids.sourceMessageId,
      expandedNoteVersionId: ids.conversationId,
      expandedNoteVersionNumber: 1,
      sourceMessageId: null,
      conversationId: null,
      otherNoteTitle: "Tool 设计",
      direction: "expanded_from_here",
      createdAt: "2026-09-29T01:00:00.000Z",
    });
    assert.equal(link.direction, "expanded_from_here");
    assert.equal(link.sourceMessageId, null);
    assert.equal(noteExpansionListQueryV1Schema.safeParse({ beforeExpansionId: ids.requestId }).success, false);
  });
});
