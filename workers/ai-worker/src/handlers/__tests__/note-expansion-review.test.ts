import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { NoteExpansionDraftV1 } from "@astella/shared/note-expansion-contracts";
import { NoteExpansionOutputError } from "../../lib/non-retryable-errors.ts";
import { applyNoteExpansionReview, noteExpansionReviewMessages, parseNoteExpansionReview } from "../note/note-expansion-review.ts";

const drafts = (): NoteExpansionDraftV1[] => [1, 2].map(index => ({ candidateId: randomUUID(), requestId: randomUUID(),
  title: `Draft ${index}`, relationship: "A concrete extension of the original note.",
  sourceReferences: [{ blockOrdinal: 7, quote: "The rectangle has width 3 and length 5." }],
  blocks: [{ type: "heading", content: "A complete explanation" }, { type: "paragraph", content: "Original draft content." }], selected: false }));
const approved = (count = 2) => ({ drafts: Array.from({ length: count }, (_, index) => ({ draftNumber: index + 1,
  decision: "approve", reason: "The explanation follows from the given conditions.", revision: null })) });

test("content review covers each draft once and preserves approved source identities", () => {
  const original = drafts(), raw = approved();
  raw.drafts.reverse();
  const reviewed = applyNoteExpansionReview(original, parseNoteExpansionReview(JSON.stringify(raw), original.length));
  assert.deepEqual(reviewed, original);
  for (const invalid of [approved(1), { drafts: [raw.drafts[0], raw.drafts[0]] },
    { drafts: [...raw.drafts, { ...raw.drafts[0], draftNumber: 3 }] }, { drafts: [{ ...raw.drafts[0], draftNumber: 3 }, raw.drafts[1]] }]) {
    assert.throws(() => parseNoteExpansionReview(JSON.stringify(invalid), 2), NoteExpansionOutputError);
  }
});

test("a content revision replaces the publication body while keeping the actual source references", () => {
  const original = drafts(), before = structuredClone(original);
  const raw = approved();
  const revision = { title: "Corrected explanation", relationship: "This conclusion follows from the original conditions.",
    blocks: [{ type: "heading", content: "Area" }, { type: "paragraph", content: "The area is 15 square units." }] };
  const review = parseNoteExpansionReview(JSON.stringify({ drafts: [
    { ...raw.drafts[0], decision: "revise", revision }, raw.drafts[1],
  ] }), 2);
  const result = applyNoteExpansionReview(original, review);
  assert.equal(result[0]!.candidateId, original[0]!.candidateId);
  assert.deepEqual(result[0]!.sourceReferences, original[0]!.sourceReferences);
  assert.deepEqual(result[0]!.blocks, revision.blocks);
  assert.deepEqual(original, before, "review must not mutate the rejected original in memory");
  assert.throws(() => parseNoteExpansionReview(JSON.stringify({ drafts: [
    { ...raw.drafts[0], decision: "revise", revision: { ...revision, sourceReferences: [] } }, raw.drafts[1],
  ] }), 2), NoteExpansionOutputError, "content review cannot replace the host-verified source references");
  const duplicates = parseNoteExpansionReview(JSON.stringify({ drafts: [1, 2].map(draftNumber => ({
    draftNumber, decision: "revise", reason: "A corrected explanation of the given rectangle.", revision,
  })) }), 2);
  assert.throws(() => applyNoteExpansionReview(original, duplicates), NoteExpansionOutputError);
});

test("a rejected or incomplete review cannot fall back to saving the original draft batch", () => {
  const raw = approved();
  const review = parseNoteExpansionReview(JSON.stringify({ drafts: [
    { ...raw.drafts[0], decision: "reject" }, raw.drafts[1],
  ] }), 2);
  assert.throws(() => applyNoteExpansionReview(drafts(), review), NoteExpansionOutputError);
  assert.throws(() => parseNoteExpansionReview(JSON.stringify({ drafts: [
    { ...raw.drafts[0], decision: "revise", revision: null }, raw.drafts[1],
  ] }), 2), NoteExpansionOutputError);
});

test("review instructions remain stable while complete source and draft content stay in data", () => {
  const left = noteExpansionReviewMessages([{ ordinal: 7, type: "paragraph", content: "First source." }], drafts());
  const right = noteExpansionReviewMessages([{ ordinal: 21, type: "paragraph", content: "A different source." }], drafts());
  assert.deepEqual(left[0], right[0]);
  assert.equal(JSON.parse(String(right[1]!.content)).sourceBlocks[0].blockOrdinal, 21);
  assert.equal(JSON.parse(String(left[1]!.content)).drafts.length, 2);
});
